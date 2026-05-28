/**
 * Project-embed asset upload helpers.
 *
 * Server-side validation + R2 binding interaction for the
 * `/api/embed-upload` endpoint. Lives in `src/lib/` so it can be unit-tested
 * without spinning up an Astro request.
 *
 * Auth model (current):
 *   PRIMARY: GitHub Actions OIDC. Workflows mint a short-lived ID token and
 *   present it as `Authorization: Bearer <id_token>`. The Worker verifies
 *   signature against GitHub's JWKS and authorizes on `repository_owner`.
 *   Zero per-repo config needed for any future embed repo.
 *
 *   FALLBACK: a static shared bearer (`PROJECT_EMBED_UPLOAD_TOKEN` Worker
 *   secret). Kept around for manual uploads / local dev / one-shot scripts.
 *   When OIDC is available, prefer it; static bearer is a safety net.
 *
 * The bucket itself never needs S3-compatible API keys — the Worker holds
 * the R2 binding and is the sole writer.
 */
import { authorizeForEmbedUpload, verifyGithubOidc } from './github-oidc'

export type EmbedUploadEnv = {
  PROJECT_ASSETS?: R2Bucket
  PROJECT_EMBED_UPLOAD_TOKEN?: string
}

// Slug pattern matches the project-manifest schema: lowercase alnum + hyphens.
// Length-bounded to keep keys reasonable.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// Version is normally a short git SHA (7-12 hex chars), but we also allow
// 'staging' / 'preview' / explicit semver-like tags so manual uploads work.
export const VERSION_RE = /^[a-zA-Z0-9._-]{1,40}$/

// Path inside the artifact tree. Disallows `..` segments, leading `/`,
// backslashes, control chars, and anything > 256 chars.
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 256) return false
  if (p.startsWith('/') || p.startsWith('./')) return false
  if (p.includes('\\')) return false
  if (p.includes('..')) return false
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Constant-time bearer comparison so we don't leak secrets through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export type AuthResult =
  | { ok: true; via: 'oidc' | 'bearer'; details?: Record<string, unknown> }
  | { ok: false; status: 401 | 403 | 503; message: string }

export function checkBearer(
  authHeader: string | null,
  expectedToken: string | undefined
): AuthResult {
  if (!expectedToken) {
    return {
      ok: false,
      status: 503,
      message: 'PROJECT_EMBED_UPLOAD_TOKEN is not configured on the Worker',
    }
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing Bearer token' }
  }
  const presented = authHeader.slice('Bearer '.length).trim()
  if (!timingSafeEqual(presented, expectedToken)) {
    return { ok: false, status: 401, message: 'Invalid Bearer token' }
  }
  return { ok: true, via: 'bearer' }
}

/**
 * Heuristic: a GitHub Actions OIDC ID token is a JWS-Compact-form RS256
 * JWT — three base64url segments separated by dots, ~1.5KB long. A static
 * bearer is whatever string the user generated (we use 47-char base64url
 * tokens that don't contain dots).
 *
 * If we see ≥2 dots, try OIDC first; otherwise treat it as a static bearer.
 */
function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3
}

/**
 * Authenticate an upload request. Prefers GitHub Actions OIDC; falls back
 * to the static `PROJECT_EMBED_UPLOAD_TOKEN` shared bearer.
 */
export async function authenticateUpload(
  authHeader: string | null,
  env: EmbedUploadEnv
): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing Bearer token' }
  }
  const presented = authHeader.slice('Bearer '.length).trim()

  // OIDC path: looks like a JWT, try GitHub OIDC verification + authorization.
  if (looksLikeJwt(presented)) {
    const verified = await verifyGithubOidc(presented)
    if (!verified.ok) {
      // Don't fall back to bearer for token-shaped strings — if it parses
      // as a JWT but verification failed, that's a real auth failure.
      return verified
    }
    const authz = authorizeForEmbedUpload(verified.claims)
    if (!authz.ok) {
      return authz
    }
    return {
      ok: true,
      via: 'oidc',
      details: {
        repository: verified.claims.repository,
        ref: verified.claims.ref,
        sha: verified.claims.sha,
        actor: verified.claims.actor,
        workflow: verified.claims.workflow,
        run_id: verified.claims.run_id,
      },
    }
  }

  // Static bearer fallback.
  return checkBearer(authHeader, env.PROJECT_EMBED_UPLOAD_TOKEN)
}

/** Build the R2 object key from manifest-derived components. */
export function buildKey(slug: string, version: string, path: string): string {
  return `${slug}/${version}/${path}`
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  glsl: 'text/plain; charset=utf-8',
  vert: 'text/plain; charset=utf-8',
  frag: 'text/plain; charset=utf-8',
}

/** Best-effort content-type from filename; falls back to octet-stream. */
export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  const ext = path.slice(dot + 1).toLowerCase()
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream'
}
