/**
 * PUT /api/embed-upload?slug=<slug>&version=<sha>&path=<rel/path>
 *
 * Uploads a single file into the project-embed assets bucket via the R2
 * binding. Auth: shared bearer token (`PROJECT_EMBED_UPLOAD_TOKEN` Worker
 * secret). Used by `baladithyab/web-embed-workflows` reusable workflows.
 *
 * Stored at:
 *   r2://${PROJECT_ASSETS}/<slug>/<version>/<path>
 *
 * Served at:
 *   https://assets-r2.codeseys.io/<slug>/<version>/<path>
 *
 * GET on this same route returns a tiny status payload so callers can
 * health-check before pushing artifacts.
 */
import type { APIRoute } from 'astro'
import { getRuntimeEnv } from '@/lib/runtime-env'
import {
  type EmbedUploadEnv,
  buildKey,
  checkBearer,
  contentTypeForPath,
  isSafeRelativePath,
  SLUG_RE,
  VERSION_RE,
} from '@/lib/embed-upload'

// Cloudflare Workers request body cap is 100 MiB; keep some headroom and
// cap the per-file artifact size at 90 MiB. Larger artifacts should split
// into multiple files or fall back to the (still-supported) S3-compatible
// path described in docs/PROJECT_EMBEDS.md.
const MAX_BYTES = 90 * 1024 * 1024

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

export const GET: APIRoute = () =>
  jsonResponse(
    {
      ok: true,
      service: 'project-embed-upload',
      docs: 'https://github.com/baladithyab/baladithyab.github.io/blob/main/docs/PROJECT_EMBEDS.md',
      hint: 'PUT here with ?slug=&version=&path= and Authorization: Bearer <token>',
    },
    200
  )

export const PUT: APIRoute = async ({ request }) => {
  const env = getRuntimeEnv<EmbedUploadEnv>()

  // Auth.
  const auth = checkBearer(request.headers.get('Authorization'), env.PROJECT_EMBED_UPLOAD_TOKEN)
  if (!auth.ok) {
    return jsonResponse({ error: auth.message }, auth.status)
  }

  // Binding present?
  if (!env.PROJECT_ASSETS) {
    return jsonResponse(
      {
        error: 'PROJECT_ASSETS R2 binding is not configured on the Worker',
        hint: 'Check wrangler.jsonc r2_buckets entry and that R2 is enabled on the account.',
      },
      503
    )
  }

  // Parse and validate query params.
  const url = new URL(request.url)
  const slug = url.searchParams.get('slug') ?? ''
  const version = url.searchParams.get('version') ?? ''
  const path = url.searchParams.get('path') ?? ''
  if (!SLUG_RE.test(slug)) {
    return jsonResponse({ error: 'invalid slug', got: slug }, 400)
  }
  if (!VERSION_RE.test(version)) {
    return jsonResponse({ error: 'invalid version', got: version }, 400)
  }
  if (!isSafeRelativePath(path)) {
    return jsonResponse({ error: 'invalid path', got: path }, 400)
  }

  // Size guardrail. We try the Content-Length header first, but a missing
  // header doesn't block the upload — R2.put() will surface its own size
  // limits if the streamed body exceeds them.
  const declaredLen = request.headers.get('Content-Length')
  if (declaredLen !== null) {
    const n = Number(declaredLen)
    if (!Number.isFinite(n) || n < 0) {
      return jsonResponse({ error: 'invalid Content-Length' }, 400)
    }
    if (n > MAX_BYTES) {
      return jsonResponse(
        {
          error: 'artifact too large for binding-proxy upload',
          declaredBytes: n,
          maxBytes: MAX_BYTES,
          hint: 'Split into smaller files or use the S3-compatible path.',
        },
        413
      )
    }
  }

  if (!request.body) {
    return jsonResponse({ error: 'empty body' }, 400)
  }

  const key = buildKey(slug, version, path)

  // Content-type policy: prefer the extension-derived type for known
  // extensions (HTML / WASM / CSS / etc. should always be served with
  // their canonical type, regardless of what the uploader claims). Fall
  // back to the request's Content-Type header for unknown extensions.
  // This keeps the system robust to clients (curl/CI) that send a
  // generic application/octet-stream or application/x-www-form-urlencoded.
  const derivedType = contentTypeForPath(path)
  const headerType = request.headers.get('Content-Type')
  const httpMetadata: R2HTTPMetadata = {
    contentType:
      derivedType !== 'application/octet-stream'
        ? derivedType
        : (headerType ?? derivedType),
  }
  const cacheControl = request.headers.get('X-Cache-Control')
  if (cacheControl) httpMetadata.cacheControl = cacheControl

  try {
    const result = await env.PROJECT_ASSETS.put(key, request.body, { httpMetadata })
    return jsonResponse(
      {
        ok: true,
        key,
        publicUrl: `https://assets-r2.codeseys.io/${key}`,
        etag: result?.httpEtag ?? null,
        size: result?.size ?? null,
      },
      200
    )
  } catch (err) {
    return jsonResponse(
      {
        error: 'R2 put failed',
        details: err instanceof Error ? err.message : String(err),
      },
      500
    )
  }
}

// Disallow other methods explicitly so attackers don't get cute.
const reject: APIRoute = () =>
  jsonResponse({ error: 'method not allowed' }, 405, { Allow: 'GET, PUT' })

export const POST = reject
export const DELETE = reject
export const PATCH = reject
