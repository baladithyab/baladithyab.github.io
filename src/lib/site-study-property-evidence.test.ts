import { describe, expect, it, vi } from 'vitest'
import {
  handlePropertyEvidenceRequest,
  spotCrimeMapUrl,
} from './site-study-property-evidence'

const endpoint =
  'https://codeseys.io/api/lab/real-estate-due-diligence/evidence'
const request = (query = 'lng=-121.8863&lat=37.3388') =>
  new Request(`${endpoint}?${query}`, {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
  })

const parcel = {
  attributes: {
    APN: '46757084',
    JURISDICTION: 'SAN JOSE',
    TAX_RATE_AREA: 17108,
    SITUS_HOUSE_NUMBER: '27',
    SITUS_STREET_DIRECTION: 'N',
    SITUS_STREET_NAME: '6TH',
    SITUS_STREET_TYPE: 'ST',
    SITUS_CITY_NAME: 'SAN JOSE',
    SITUS_ZIP_CODE: '95112',
    Shape_Area: 7002.076,
  },
}
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
      const href = url.href
      if (href.includes('SCCProperty/MapServer/0')) {
        return Response.json({
          features: [parcel, parcel],
          exceededTransferLimit: true,
        })
      }
      if (href.includes('OPN_OpenDataService/MapServer/439')) {
        return failedFlood
          ? Response.json({ error: { code: 503 } })
          : Response.json({ features: [flood] })
      }
      if (href.includes('OPN_OpenDataService/MapServer/401')) {
        return Response.json({
          features: [{ attributes: { ZONING: 'DC', PDUSE: null, NOTES: 'Downtown' } }],
        })
      }
      if (href.includes('OPN_OpenDataService/MapServer/404')) {
        return Response.json({
          features: [{ attributes: { GPDESIGNATION: 'Downtown', GPABBREVIATION: 'DT' } }],
        })
      }
      if (href.includes('PLN_Geocortex_Public_PRD/MapServer/84')) {
        return Response.json({
          features: [{ attributes: { HEIGHTLIMIT: 'Determined by FAA', CODESECTION: '20.85.020(A)' } }],
        })
      }
      if (href.includes('PLN_Geocortex_Public_PRD/MapServer/81')) {
        return Response.json({
          features: [{ attributes: { HAZARDTYPE: 'Liquefaction', QUADRANGLE: 'San Jose West' } }],
        })
      }
      if (href.includes('FIR_AllReferenceLayers/MapServer/4')) {
        return Response.json({
          features: [{ attributes: { FIREHAZARDSEVERITYZONE: 'NonWildland' } }],
        })
      }
      if (href.includes('OEM_WaterHazards/MapServer/9')) {
        return Response.json({ features: [{ attributes: { OBJECTID: 1 } }] })
      }
      if (href.includes('HSG_HousingMapLayers/MapServer/17')) {
        return Response.json({
          features: [{ attributes: { CISCOREPCTL: 70.7, POLLUTIONBURDENPCTL: 59.1, GROUNDWATERTHREATSPCTL: 97.8 } }],
        })
      }
      if (href.includes('PLN_PermitsAndComplaints/MapServer/13')) {
        return Response.json({
          features: [{ attributes: { NAME: 'K1', CRIMERATE: 257, CRIMELEVEL: 'Low Crime', NOTES: '2022 beat' } }],
        })
      }
      if (href.includes('package_show')) {
        return Response.json({
          success: true,
          result: {
            resources: [
              { id: 'res-q4', name: 'Police Calls 2026 Q4', datastore_active: true, last_modified: '2026-11-27' },
            ],
          },
        })
      }
      if (href.includes('datastore_search_sql')) {
        return Response.json({
          success: true,
          result: {
            records: [
              {
                OFFENSE_DATE: '2026-11-25',
                CALL_TYPE: 'DISTURBANCE',
                PRIORITY: '3',
                ADDRESS: 'N 6TH ST & E EMPIRE ST',
                FINAL_DISPO: 'No report required',
              },
            ],
          },
        })
      }
      if (href.includes('OPN_OpenDataService/MapServer/545')) {
        return Response.json({
          features: [{ attributes: { MEDHOMEVAL: 1044900, INCMEDIANINCOME: 54588 } }],
        })
      }
      return Response.json({ features: [] })
    },
  )
  return { put, cache, limit, env, fetcher }
}

describe('property evidence endpoint', () => {
  it('returns multi-domain public observations and reuses canonical coordinates from edge cache', async () => {
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
        matches: [
          {
            apn: '46757084',
            jurisdiction: 'SAN JOSE',
            taxRateArea: 17108,
            situsAddress: '27 N 6TH ST, SAN JOSE, CA 95112',
            streetQuery: '6TH ST',
          },
        ],
        truncated: true,
      },
      flood: { matches: [{ zone: 'D', specialFloodHazardArea: false }] },
      zoning: {
        zoning: 'DC',
        generalPlan: 'Downtown',
        heightLimit: 'Determined by FAA',
      },
      hazards: {
        seismicZones: ['Liquefaction'],
        wildfireZone: 'NonWildland',
        damInundation: true,
        calEnviroPercentile: 70.7,
      },
      safety: {
        spotCrimeUrl: spotCrimeMapUrl(37.3388, -121.8863, '27 N 6TH ST, SAN JOSE, CA 95112'),
        policeBeat: { beat: 'K1', level: 'Low Crime', rate: 257 },
        sjpdStreetQuery: '6TH ST',
        sjpdRecentCalls: [{ type: 'DISTURBANCE' }],
      },
      context: {
        tractMedianHomeValue: 1044900,
        tractMedianIncome: 54588,
      },
    })
    // Corrected lot area should be ~47,630 sq ft (not inflated Mercator 75,370 sq ft).
    expect(evidence.parcel.matches[0].lotSqft).toBeGreaterThan(45_000)
    expect(evidence.parcel.matches[0].lotSqft).toBeLessThan(50_000)
    expect(put.mock.calls.length).toBeGreaterThanOrEqual(7)

    const initialCalls = fetcher.mock.calls.length
    const reused = await handlePropertyEvidenceRequest(
      request('lat=37.338800&lng=-121.886300'),
      env,
      cache,
      fetcher,
    )
    expect(await reused.json()).toEqual(evidence)
    expect(fetcher).toHaveBeenCalledTimes(initialCalls)
    expect(limit).toHaveBeenCalledTimes(1)
  })

  it('keeps available evidence when one upstream fails and retries only the failed source', async () => {
    const { cache, env, fetcher } = setup(true)
    const first = await handlePropertyEvidenceRequest(
      request(),
      env,
      cache,
      fetcher,
    )
    expect(first.headers.get('Cache-Control')).toBe('no-store')
    expect(await first.json()).toMatchObject({
      parcel: { matches: [{ apn: '46757084' }] },
      flood: null,
      zoning: { zoning: 'DC' },
    })
    const callsAfterFirst = fetcher.mock.calls.length
    const second = await handlePropertyEvidenceRequest(
      request(),
      env,
      cache,
      fetcher,
    )
    expect(await second.json()).toMatchObject({
      parcel: { matches: [{ apn: '46757084' }] },
      flood: null,
    })
    // Only the failed flood source is retried on the second call.
    expect(fetcher).toHaveBeenCalledTimes(callsAfterFirst + 1)
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
