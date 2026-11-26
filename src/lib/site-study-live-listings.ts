import { isSameSiteRequest } from './meeting-live-server'
import {
  liveListingKinds,
  type Listing,
  type LiveListingKind,
  type LiveListingSnapshot,
} from './site-study-listings'

type Sample = { listings: Listing[]; checkedAt: string }
export type HomeHarvestEnv = {
  HOMEHARVEST?: { fetch(request: Request): Promise<Response> }
  HOMEHARVEST_REFRESH?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
}
type Refresh = { sample: Sample } | { failure: 'upstream' | 'rate_limited' }

const cacheSeconds = 900

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSample(value: unknown, kind: LiveListingKind): Sample {
  if (!record(value) || value.kind !== kind || !Array.isArray(value.listings)) {
    throw new Error('Unexpected listing response')
  }
  const seen = new Set<string>()
  const listings: Listing[] = []
  for (const row of value.listings.slice(0, 40)) {
    if (!record(row)) continue
    const { id, address, latitude, longitude, list_price, beds, sqft, url } =
      row
    if (
      typeof id !== 'string' ||
      !id ||
      seen.has(id) ||
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180
    )
      continue
    seen.add(id)
    const listing: Listing = {
      address:
        typeof address === 'string' && address.trim()
          ? address.trim()
          : `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      coordinate: [longitude, latitude],
      price:
        typeof list_price === 'number' &&
        Number.isFinite(list_price) &&
        list_price > 0
          ? list_price
          : null,
      status: kind === 'for_sale' ? 'for sale' : 'for rent',
    }
    if (typeof beds === 'number' && Number.isFinite(beds) && beds >= 0)
      listing.beds = beds
    if (typeof sqft === 'number' && Number.isFinite(sqft) && sqft > 0)
      listing.sqft = sqft
    if (typeof url === 'string') {
      try {
        const source = new URL(url)
        if (
          source.protocol === 'https:' &&
          (source.hostname === 'realtor.com' ||
            source.hostname === 'www.realtor.com')
        ) {
          listing.sourceUrl = source.href
        }
      } catch {
        // The listing remains usable without a provider link.
      }
    }
    listings.push(listing)
  }
  return { listings, checkedAt: new Date().toISOString() }
}

function respond(body: unknown, status: number, cacheControl = 'no-store') {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': cacheControl, 'X-Robots-Tag': 'noindex' },
  })
}

async function refresh(
  request: Request,
  provider: NonNullable<HomeHarvestEnv['HOMEHARVEST']>,
  limit: HomeHarvestEnv['HOMEHARVEST_REFRESH'],
  cache: Cache | undefined,
  kind: LiveListingKind,
): Promise<Refresh> {
  const key = new Request(
    new URL(`/_internal/homeharvest/v1/san-jose/${kind}`, request.url),
  )
  try {
    const cached = await cache?.match(key)
    if (cached) return { sample: (await cached.json()) as Sample }
  } catch {
    // A cache outage should not make the provider unavailable.
  }
  try {
    if (limit && !(await limit.limit({ key: 'san-jose-refresh' })).success) {
      return { failure: 'rate_limited' }
    }
    const upstream = await provider.fetch(
      new Request(`https://homeharvest.internal/listings?kind=${kind}`, {
        signal: AbortSignal.timeout(18_000),
      }),
    )
    if (!upstream.ok) return { failure: 'upstream' }
    const sample = readSample(await upstream.json(), kind)
    try {
      await cache?.put(
        key,
        Response.json(sample, {
          headers: { 'Cache-Control': `public, max-age=${cacheSeconds}` },
        }),
      )
    } catch {
      // The fresh answer is still valid for this request.
    }
    return { sample }
  } catch {
    return { failure: 'upstream' }
  }
}

export async function handleLiveListingsRequest(
  request: Request,
  env: HomeHarvestEnv,
  cache: Cache | undefined,
) {
  if (!isSameSiteRequest(request)) return respond({ error: 'forbidden' }, 403)
  const { HOMEHARVEST: provider, HOMEHARVEST_REFRESH: limit } = env
  if (!provider) return respond({ error: 'not_configured' }, 503)

  const results = await Promise.all(
    liveListingKinds.map((kind) =>
      refresh(request, provider, limit, cache, kind),
    ),
  )
  const available = results.flatMap((result) =>
    'sample' in result ? [result.sample] : [],
  )
  if (!available.length) {
    const limited = results.every(
      (result) => 'failure' in result && result.failure === 'rate_limited',
    )
    return respond(
      { error: limited ? 'rate_limited' : 'unavailable' },
      limited ? 429 : 502,
    )
  }
  const payload: LiveListingSnapshot = {
    listings: available.flatMap((sample) => sample.listings),
    checkedAt: available.map((sample) => sample.checkedAt).sort()[0],
    unavailable: liveListingKinds.filter(
      (_, index) => 'failure' in results[index],
    ),
  }
  return respond(
    payload,
    200,
    payload.unavailable.length ? 'no-store' : 'private, max-age=60',
  )
}
