/**
 * POST /api/tripspace/search
 *
 * Runs one flight, "anywhere" or hotel search for the Tripspace lab against
 * Skiplagged's public MCP endpoint. The endpoint refuses browser origins, so
 * the page cannot call it directly.
 *
 * Body: a `SearchRequest` (see `src/lib/tripspace/search.ts`).
 * Response: a `SearchResponse`; failures are `{ ok: false, reason, message }`
 * with a matching status code.
 *
 * Guards, because the route is public:
 * - requests from another site's page are refused (`Origin` must match);
 * - the body is parsed strictly and capped at 2 KB;
 * - identical searches are answered from the edge cache for 10 minutes;
 * - provider calls are rate limited per client and in total
 *   (`TRIPSPACE_SEARCH_PER_CLIENT`, `TRIPSPACE_SEARCH_TOTAL` in wrangler.jsonc).
 *   Without those bindings the route refuses every search.
 */
import type { APIRoute } from 'astro'

import { getRuntimeEnv } from '@/lib/runtime-env'
import { searchKey, searchRequestSchema, type SearchFailure, type SearchResponse } from '@/lib/tripspace/search'
import { SearchError, searchSkiplagged } from '@/lib/tripspace/skiplagged'

export const prerender = false

const MAX_BODY_BYTES = 2048
const CACHE_SECONDS = 600

interface Env {
  TRIPSPACE_SEARCH_PER_CLIENT?: RateLimit
  TRIPSPACE_SEARCH_TOTAL?: RateLimit
}

const STATUS: Record<SearchFailure, number> = {
  invalid: 400,
  rate_limited: 429,
  unavailable: 502,
  bad_response: 502,
  timeout: 504,
  no_results: 404,
}

function reply(body: SearchResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function failure(reason: SearchFailure, message: string, retryAfterS: number | null = null): Response {
  return reply({ ok: false, reason, message, retryAfterS }, STATUS[reason])
}

export const POST: APIRoute = async ({ request, url }) => {
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== url.origin) {
    return new Response(null, { status: 403 })
  }

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return failure('invalid', 'The search is too large.')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('invalid', 'The search is not JSON.')
  }
  const parsed = searchRequestSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return failure('invalid', `The search is invalid${issue ? `: ${issue.path.join('.') || 'body'} needs ${issue.message}` : '.'}`)
  }
  const search = parsed.data

  // `caches.default` is the Workers edge cache; the DOM typing of `caches` does not know it.
  const edge: unknown = typeof caches !== 'undefined' && 'default' in caches ? caches.default : null
  const cache = edge instanceof Cache ? edge : null
  const cacheKey = new Request(new URL(`/api/tripspace/search/cache/${encodeURIComponent(searchKey(search))}`, url))
  const hit = await cache?.match(cacheKey)
  if (hit) {
    return new Response(hit.body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  const env = getRuntimeEnv<Env>()
  if (!env.TRIPSPACE_SEARCH_PER_CLIENT || !env.TRIPSPACE_SEARCH_TOTAL) {
    return failure('unavailable', 'Search is not configured on this deployment.')
  }
  const client = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const [perClient, total] = await Promise.all([
    env.TRIPSPACE_SEARCH_PER_CLIENT.limit({ key: client }),
    env.TRIPSPACE_SEARCH_TOTAL.limit({ key: 'all' }),
  ])
  if (!perClient.success || !total.success) {
    return failure('rate_limited', 'Too many searches in the last minute. Try again shortly.', 60)
  }

  try {
    const { offers, searchUrl } = await searchSkiplagged(search, request.signal)
    const body: SearchResponse = { ok: true, provider: 'skiplagged', offers, searchUrl, fetchedAt: Date.now() }
    // An empty answer is often the provider having a bad minute; do not pin it for ten.
    if (offers.length > 0) {
      await cache?.put(
        cacheKey,
        new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
        }),
      )
    }
    return reply(body)
  } catch (error) {
    if (error instanceof SearchError) return failure(error.reason, error.message, error.retryAfterS)
    throw error
  }
}
