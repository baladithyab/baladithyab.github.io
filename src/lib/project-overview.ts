/**
 * Project overview fetcher: pulls the README (or whatever path the
 * manifest declares) from a public GitHub repo and renders it as HTML.
 *
 * Why this exists separate from the discovery script:
 * - Discovery runs at build; READMEs change more often than deploys.
 *   Fetching at request time keeps the overview fresh without a deploy
 *   on every README edit.
 * - Cloudflare's edge cache absorbs the per-request cost — a `Cache-Control`
 *   header on this fetch lets the same edge serve hundreds of identical
 *   responses without re-hitting GitHub.
 *
 * Design choices:
 * - We fetch the **raw** content from `raw.githubusercontent.com` rather
 *   than the API. No auth required for public repos, no rate-limit
 *   anxiety, fewer moving parts.
 * - We render with `marked` because it's a) tiny, b) sync, c) Worker-safe
 *   (no Node-only deps). For our portfolio narrative use case we don't
 *   need a full MDX runtime — README markdown plus syntax highlighting.
 * - We optionally strip the first H1 because the page already shows the
 *   project title (avoids visual duplication). The manifest's
 *   `overview.skipFirstHeading` controls this.
 * - Failure is non-fatal: the page renders an "overview unavailable"
 *   notice with a link to the repo. A broken README never breaks the
 *   project page.
 */
import { marked } from 'marked'

export type FetchOverviewArgs = {
  /** `<owner>/<name>`, e.g. `baladithyab/UCSC-CSE-160-W21`. */
  source: string
  /** Branch ref to fetch from. */
  ref: string
  /** Path inside the repo, e.g. `README.md`. */
  path: string
  /** Drop the first H1 if present. */
  skipFirstHeading: boolean
}

export type FetchOverviewResult =
  | { ok: true; html: string; rawLen: number }
  | { ok: false; error: string }

/** Cache TTL for the edge response (5 min). */
const EDGE_CACHE_TTL = 300

/**
 * Strip the first H1 from a markdown document if present.
 * Tolerant to leading whitespace and trailing slug-anchors.
 */
export function stripFirstH1(md: string): string {
  // Match a leading `# Heading` line (with optional newline before).
  const re = /^\s*#\s+[^\n]+\n+/
  return md.replace(re, '')
}

/**
 * Configure marked to be Worker-safe (no async, no fs).
 * Done once at module load; safe to call multiple times.
 */
let configured = false
function configureMarked() {
  if (configured) return
  marked.setOptions({
    gfm: true,
    breaks: false,
    // No HTML sanitisation here — we trust READMEs from our own repos.
    // If we ever expand to render third-party READMEs, swap in DOMPurify.
  })
  configured = true
}

/**
 * Fetch and render an overview document. Always returns; errors come
 * back as `{ ok: false, error }`. The caller renders an inline notice
 * for the failure case.
 */
export async function fetchRenderedOverview(args: FetchOverviewArgs): Promise<FetchOverviewResult> {
  configureMarked()
  const { source, ref, path, skipFirstHeading } = args

  // Validate — defensive against manifest typos that could cause SSRF.
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { ok: false, error: `invalid source format: ${source}` }
  }
  if (path.includes('..') || path.startsWith('/')) {
    return { ok: false, error: `invalid path: ${path}` }
  }

  const rawUrl = `https://raw.githubusercontent.com/${source}/${ref}/${path}`

  let resp: Response
  try {
    resp = await fetch(rawUrl, {
      headers: { Accept: 'text/plain, text/markdown' },
      cf: {
        cacheTtl: EDGE_CACHE_TTL,
        cacheEverything: true,
      },
    } as RequestInit)
  } catch (err) {
    return {
      ok: false,
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status} fetching ${path}` }
  }
  const md = await resp.text()
  if (md.length === 0) {
    return { ok: false, error: `${path} is empty` }
  }
  // Cap the rendered size to keep one project's bloated README from
  // blowing up our SSR response.
  const MAX_BYTES = 256 * 1024
  if (md.length > MAX_BYTES) {
    return { ok: false, error: `${path} exceeds ${MAX_BYTES} bytes` }
  }

  const sourceMarkdown = skipFirstHeading ? stripFirstH1(md) : md
  let html: string
  try {
    html = await Promise.resolve(marked.parse(sourceMarkdown))
  } catch (err) {
    return {
      ok: false,
      error: `markdown render failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { ok: true, html, rawLen: md.length }
}
