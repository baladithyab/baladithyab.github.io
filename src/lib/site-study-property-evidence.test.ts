import { describe, expect, it, vi } from 'vitest'
import { handlePropertyEvidenceRequest } from './site-study-property-evidence'

const endpoint =
  'https://codeseys.io/api/lab/real-estate-due-diligence/evidence'
const request = (query = 'lng=-121.8863&lat=37.3388') =>
  new Request(`${endpoint}?${query}`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  })

const parcel = { attributes: { APN: '46757084', JURISDICTION: 'SAN JOSE' } }
const flood = { attributes: { FLDZONE: 'D', ZONESUBTY: ' ', SFHATF: 'F' } }

function setup(failedFlood = false) {
  const entries = new Map<string, Response>()
  const put = vi.fn(async (key: Request, value: Response) => {
    entries.set(key.url, value.clone())
  })
  const cache = {
    match: async (key: Request) => entries.get(key.url)?.clone(),
    put,
  } as unknown as Cache
  const limit = vi.fn(async () => ({ success: true }))
  const env = { PROPERTY_EVIDENCE_REFRESH: { limit } }
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(init?.redirect).toBe('manual')
      expect(url.searchParams.get('geometry')).toBe('-121.8863,37.3388')
      expect(url.searchParams.get('returnGeometry')).toBe('false')
      if (url.hostname === 'maps.santaclaracounty.gov') {
        return Response.json({
          features: [parcel, parcel],
          exceededTransferLimit: true,
        })
      }
      expect(url.hostname).toBe('geo.sanjoseca.gov')
      return failedFlood
        ? Response.json({ error: { code: 503 } })
        : Response.json({ features: [flood] })
    },
  )
  return { put, cache, limit, env, fetcher }
}

describe('property evidence endpoint', () => {
  it('returns sourced observations and reuses canonical coordinates without a refresh', async () => {
    const { put, cache, limit, env, fetcher } = setup()
    const response = await handlePropertyEvidenceRequest(
      request(),
      env,
      cache,
      fetcher,
    )
    const evidence = await response.json()
    expect(evidence).toMatchObject({
      parcel: {
        matches: [{ apn: '46757084', jurisdiction: 'SAN JOSE' }],
        truncated: true,
      },
      flood: { matches: [{ zone: 'D', specialFloodHazardArea: false }] },
    })
    expect(
      put.mock.calls.map(([, value]) => value.headers.get('Cache-Control')),
    ).toEqual(['public, max-age=86400', 'public, max-age=86400'])
    const reused = await handlePropertyEvidenceRequest(
      request('lat=37.338800&lng=-121.886300'),
      env,
      cache,
      fetcher,
    )
    expect(await reused.json()).toEqual(evidence)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(limit).toHaveBeenCalledTimes(1)
  })

  it('keeps available evidence when one upstream fails and retries only the failed source', async () => {
    const { put, cache, env, fetcher } = setup(true)
    for (let i = 0; i < 2; i++) {
      const response = await handlePropertyEvidenceRequest(
        request(),
        env,
        cache,
        fetcher,
      )
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.json()).toMatchObject({
        parcel: { matches: [{ apn: '46757084' }] },
        flood: null,
      })
    }
    expect(put).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('distinguishes no polygon from a lookup failure', async () => {
    const { cache, env } = setup()
    const response = await handlePropertyEvidenceRequest(
      request(),
      env,
      cache,
      async () => Response.json({ features: [] }),
    )
    expect(await response.json()).toMatchObject({
      parcel: { matches: [] },
      flood: { matches: [] },
    })
  })

  it('rejects foreign origins, invalid coordinates and throttled requests before fetching', async () => {
    const { cache, limit, env, fetcher } = setup()
    const crossSite = new Request(endpoint, {
      headers: { Origin: 'https://elsewhere.example' },
    })
    expect(
      (await handlePropertyEvidenceRequest(crossSite, env, cache, fetcher))
        .status,
    ).toBe(403)
    expect(
      (
        await handlePropertyEvidenceRequest(
          request('lng=0&lat=0'),
          env,
          cache,
          fetcher,
        )
      ).status,
    ).toBe(400)
    limit.mockResolvedValue({ success: false })
    expect(
      (await handlePropertyEvidenceRequest(request(), env, cache, fetcher))
        .status,
    ).toBe(429)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
