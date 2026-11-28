import { describe, expect, it, vi } from 'vitest'
import {
  handleLiveListingsRequest,
  type HomeHarvestEnv,
} from './site-study-live-listings'

const url = 'https://codeseys.io/api/lab/real-estate-due-diligence/listings'
const request = () =>
  new Request(url, { headers: { 'Sec-Fetch-Site': 'same-origin' } })
const example = {
  id: 'one',
  address: 'Example property',
  latitude: 37.34,
  longitude: -121.89,
  list_price: 1800,
  beds: 0,
  sqft: 600,
  url: 'https://www.realtor.com/example',
}

function provider(makeResponse?: (kind: string | null) => Response) {
  const fetch = vi.fn(async (input: Request) => {
    const kind = new URL(input.url).searchParams.get('kind')
    return makeResponse?.(kind) ?? Response.json({ kind, listings: [example] })
  })
  return { fetch }
}

function edgeCache() {
  const records = new Map<string, Response>()
  const match = vi.fn(async (key: Request) => records.get(key.url)?.clone())
  const put = vi.fn(async (key: Request, value: Response) => {
    records.set(key.url, value.clone())
  })
  return { cache: { match, put } as unknown as Cache, match, put }
}

describe('HomeHarvest listings endpoint', () => {
  it('loads sale and rental samples and reuses both without another provider request', async () => {
    const HOMEHARVEST = provider()
    const { cache, put } = edgeCache()
    const first = await handleLiveListingsRequest(
      request(),
      { HOMEHARVEST },
      cache,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      listings: [
        {
          address: 'Example property',
          coordinate: [-121.89, 37.34],
          status: 'for sale',
          beds: 0,
          sourceUrl: example.url,
        },
        { status: 'for rent', price: 1800, sqft: 600 },
      ],
      unavailable: [],
    })
    expect(
      put.mock.calls.every(
        ([, value]) =>
          value.headers.get('Cache-Control') === 'public, max-age=900',
      ),
    ).toBe(true)
    await handleLiveListingsRequest(request(), { HOMEHARVEST }, cache)
    expect(HOMEHARVEST.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps successful rentals available and retries only the failed sale sample', async () => {
    const HOMEHARVEST = provider((kind) =>
      kind === 'for_sale'
        ? Response.json({ error: 'upstream' }, { status: 502 })
        : Response.json({
            kind,
            listings: [
              example,
              example,
              { ...example, id: 'two', url: 'javascript:alert(1)' },
            ],
          }),
    )
    const { cache, put } = edgeCache()
    const response = await handleLiveListingsRequest(
      request(),
      { HOMEHARVEST },
      cache,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const result = (await response.json()) as {
      listings: { sourceUrl?: string }[]
      unavailable: string[]
    }
    expect(result.unavailable).toEqual(['for_sale'])
    expect(result.listings).toHaveLength(2)
    expect(result.listings[1].sourceUrl).toBeUndefined()
    expect(put).toHaveBeenCalledTimes(1)
    await handleLiveListingsRequest(request(), { HOMEHARVEST }, cache)
    expect(HOMEHARVEST.fetch).toHaveBeenCalledTimes(3)
  })

  it('refuses cross-site, unconfigured, and rate-limited requests without calling the provider', async () => {
    const HOMEHARVEST = provider()
    const env: HomeHarvestEnv = {
      HOMEHARVEST,
      HOMEHARVEST_REFRESH: { limit: vi.fn(async () => ({ success: false })) },
    }
    const outside = new Request(url, {
      headers: { Origin: 'https://elsewhere.example' },
    })
    expect(
      (await handleLiveListingsRequest(outside, env, undefined)).status,
    ).toBe(403)
    expect(
      (await handleLiveListingsRequest(request(), {}, undefined)).status,
    ).toBe(503)
    expect(
      (await handleLiveListingsRequest(request(), env, undefined)).status,
    ).toBe(429)
    expect(HOMEHARVEST.fetch).not.toHaveBeenCalled()
  })

  it('reports an invalid provider response as unavailable', async () => {
    const HOMEHARVEST = provider(() => Response.json({ listings: [] }))
    const { cache, put } = edgeCache()
    expect(
      (await handleLiveListingsRequest(request(), { HOMEHARVEST }, cache))
        .status,
    ).toBe(502)
    expect(put).not.toHaveBeenCalled()
  })
})
