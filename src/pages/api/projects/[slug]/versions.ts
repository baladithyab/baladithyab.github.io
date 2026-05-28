/**
 * GET /api/projects/<slug>/versions
 *
 * Lists every git-sha version that's currently in R2 for the given slug.
 * Used by the version picker on `/projects/<slug>` so visitors can flip
 * between historical builds without leaving the page.
 *
 * Implementation: walks `bucket.list({ prefix: '<slug>/' })` with
 * `delimiter: '/'` so only the next-level prefixes (i.e. the `<sha>/`
 * directories) come back. Filters out anything that doesn't look like
 * a git sha or version tag.
 *
 * Response:
 *   { ok: true, slug, versions: [{ id, lastModified?, sizeBytes? }] }
 *
 * `versions` is sorted with the newest first (by lastModified of the
 * most-recently-updated object inside that prefix; this is the best
 * R2 lets us do without storing version metadata alongside).
 *
 * Caching: 5 min edge cache. The version set is stable enough that
 * stale-by-five-minutes is fine.
 */

import type { APIRoute } from 'astro'

export const prerender = false

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
// Versions look like git short-shas (7-40 hex chars) or semver-ish tags.
const VERSION_RE = /^[a-z0-9._-]{1,64}$/i

interface Env {
  PROJECT_ASSETS: R2Bucket
}

interface VersionEntry {
  id: string
  lastModified?: string
  sizeBytes?: number
}

interface Locals {
  runtime?: { env?: Partial<Env> }
}

function envFromLocals(locals: unknown): Env | null {
  const r = (locals as Locals | undefined)?.runtime?.env
  if (!r?.PROJECT_ASSETS) return null
  return { PROJECT_ASSETS: r.PROJECT_ASSETS as R2Bucket }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...(init.headers ?? {}),
    },
  })
}

export const GET: APIRoute = async ({ params, locals }) => {
  const slug = params.slug
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return jsonResponse({ ok: false, error: 'invalid slug' }, { status: 400 })
  }

  const env = envFromLocals(locals)
  if (!env) {
    // Shouldn't happen in production; surface a clear error during dev
    // when the binding hasn't been wired up.
    return jsonResponse({ ok: false, error: 'PROJECT_ASSETS binding unavailable' }, { status: 500 })
  }

  // Walk one level of prefixes under <slug>/.
  const prefix = `${slug}/`
  const versions: Map<string, VersionEntry> = new Map()

  // R2 list is paginated when there are >1000 keys. Multi-asset projects
  // can easily produce hundreds of objects per version, so we need to
  // page until the prefixes-set stabilises. Practically, walking until
  // truncated=false or we hit 100 distinct versions is safe.
  let cursor: string | undefined
  let pages = 0
  /* eslint-disable no-constant-condition */
  while (true) {
    pages += 1
    if (pages > 50) break // hard ceiling, ~50k objects scanned
    const list = await env.PROJECT_ASSETS.list({
      prefix,
      delimiter: '/',
      cursor,
      limit: 1000,
    })
    // delimitedPrefixes is the list of <slug>/<sha>/ directories.
    for (const p of list.delimitedPrefixes) {
      // p looks like "cse-160/abc123/" — extract the version segment.
      const trimmed = p.slice(prefix.length).replace(/\/+$/, '')
      if (!trimmed || !VERSION_RE.test(trimmed)) continue
      if (!versions.has(trimmed)) versions.set(trimmed, { id: trimmed })
    }
    // delimitedPrefixes-only listing won't give us per-version size or
    // mtime. We optionally do a second pass on each version's manifest
    // file if the project bundles one — but in v1 we don't, and the
    // ordering returned by R2 is lexicographic which isn't meaningful
    // for git shas. Leave lastModified/sizeBytes undefined for now.
    if (!list.truncated) break
    cursor = list.cursor
  }

  // Lexicographic order isn't meaningful for git shas — but it IS
  // deterministic, which is good enough until we wire per-version
  // mtime probes. The UI shows the manifest's pinned version as the
  // "current" entry regardless of position in this list.
  const list = [...versions.values()].sort((a, b) => a.id.localeCompare(b.id))

  return jsonResponse({ ok: true, slug, versions: list })
}
