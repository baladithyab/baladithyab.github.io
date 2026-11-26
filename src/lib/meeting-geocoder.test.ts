import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { searchMeetingPlaces } from './meeting-geocoder'
import type { Coordinate, MeetingNetwork } from './meeting-point'

const bounds: MeetingNetwork['bounds'] = [-122.52, 37.7, -122.35, 37.83]
const fetchMock = vi.fn<typeof fetch>()
let search: typeof searchMeetingPlaces

beforeEach(async () => {
  vi.resetModules()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('PUBLIC_MEETING_GEOCODER_URL', 'https://search.example/api/')
  // Reload the module to exercise its private memory-cache lifecycle in isolation.
  search = (await import('./meeting-geocoder')).searchMeetingPlaces
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const feature = (
  properties: object,
  coordinates: unknown = [-122.3937, 37.7955],
) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties,
})

function respond(features: unknown[]) {
  fetchMock.mockResolvedValueOnce(Response.json({ features }))
}

const signal = () => new AbortController().signal
const requested = (call: number) => {
  const url = fetchMock.mock.calls[call]?.[0]
  if (!(url instanceof URL)) throw new Error(`Expected request ${call}`)
  return url
}

describe('Photon meeting-place boundary', () => {
  it('retains the house number when a provider names an address after its street', async () => {
    respond([
      feature({
        name: 'Ferry Building',
        street: 'Ferry Building',
        housenumber: '1',
        city: 'San Francisco',
        state: 'California',
        country: 'United States',
      }),
    ])
    const places = await search({
      query: 'Ferry Building',
      mode: 'place',
      bounds,
      signal: signal(),
    })
    // When the provider uses the street itself as name, the house number must not disappear.
    expect(places[0]).toMatchObject({
      name: '1 Ferry Building',
      coordinate: [-122.3937, 37.7955],
    })
    expect(places[0]?.context).toContain('San Francisco')
  })

  it('filters malformed and out-of-area provider features, deduplicating valid results', async () => {
    const valid = feature({ name: 'Ferry Building', osm_type: 'W', osm_id: 1 })
    respond([
      null,
      { properties: { name: 'Missing geometry' } },
      feature({ name: 'Not coordinates' }, ['-122.4', 37.8]),
      feature({ name: 'Outside area' }, [-73.9, 40.7]),
      feature({ name: 'Invalid latitude' }, [0, 91]),
      feature({}, [-122.4, 37.8]),
      valid,
      valid,
    ])
    const places = await search({
      query: 'Ferry',
      mode: 'place',
      bounds,
      signal: signal(),
    })
    expect(places).toHaveLength(1)
    expect(places[0]?.coordinate).toEqual([-122.3937, 37.7955])
  })

  it('never expands an unbounded or malformed place search into a worldwide request', async () => {
    await expect(
      search({ query: 'Main Street', mode: 'place', signal: signal() }),
    ).rejects.toThrow(Error)
    await expect(
      search({
        query: 'Main Street',
        mode: 'place',
        bounds: [10, 0, -10, 1],
        signal: signal(),
      }),
    ).rejects.toThrow(Error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not send short queries or already-aborted requests', async () => {
    expect(
      await search({ query: ' a ', mode: 'city', signal: signal() }),
    ).toEqual([])
    const abort = new AbortController()
    abort.abort()
    await expect(
      search({ query: 'Berkeley', mode: 'city', signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('distinguishes a real empty response from invalid provider data or HTTP failure without retrying', async () => {
    respond([])
    expect(
      await search({ query: 'Empty city', mode: 'city', signal: signal() }),
    ).toEqual([])
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'bad data' }))
    await expect(
      search({ query: 'Invalid city', mode: 'city', signal: signal() }),
    ).rejects.toThrow(Error)
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }))
    await expect(
      search({ query: 'Busy city', mode: 'city', signal: signal() }),
    ).rejects.toThrow(Error)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('caches successful requests only, isolates bounds, and protects cached coordinates from consumers', async () => {
    respond([feature({ name: 'Ferry Building' })])
    const first = await search({
      query: 'Ferry',
      mode: 'place',
      bounds,
      signal: signal(),
    })
    const place = first[0]
    if (!place) throw new Error('Expected a validated place')
    place.coordinate[0] = 0
    place.name = 'Changed by consumer'
    expect(
      (
        await search({
          query: 'Ferry',
          mode: 'place',
          bounds,
          signal: signal(),
        })
      )[0],
    ).toMatchObject({
      name: 'Ferry Building',
      coordinate: [-122.3937, 37.7955],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    respond([])
    await search({
      query: 'Ferry',
      mode: 'place',
      bounds: [-122.51, 37.71, -122.36, 37.82],
      signal: signal(),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not accept or cache a late response after cancellation even when fetch ignores abort', async () => {
    const response = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(response.promise)
    const abort = new AbortController()
    const pending = search({
      query: 'Berkeley',
      mode: 'city',
      signal: abort.signal,
    })
    abort.abort()
    response.resolve(
      Response.json({ features: [feature({ name: 'Berkeley' })] }),
    )
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    respond([])
    await search({ query: 'Berkeley', mode: 'city', signal: signal() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps city and in-area requests exactly as they were, ignoring a location bias', async () => {
    const exact: MeetingNetwork['bounds'] = [-122.5, 37.75, -122.25, 37.875]
    const near: Coordinate = [2.35, 48.85]
    for (let i = 0; i < 4; i++) respond([])
    await search({ query: 'Berkeley', mode: 'city', signal: signal() })
    await search({ query: 'Oakland', mode: 'city', near, signal: signal() })
    await search({
      query: 'Ferry Building',
      mode: 'place',
      bounds: exact,
      signal: signal(),
    })
    await search({
      query: 'Coit Tower',
      mode: 'place',
      bounds: exact,
      near,
      signal: signal(),
    })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://search.example/api/?q=Berkeley&limit=8&lang=en&layer=city&layer=locality',
      'https://search.example/api/?q=Oakland&limit=8&lang=en&layer=city&layer=locality',
      'https://search.example/api/?q=Ferry+Building&limit=8&lang=en&bbox=-122.5%2C37.75%2C-122.25%2C37.875&lon=-122.375&lat=37.8125',
      'https://search.example/api/?q=Coit+Tower&limit=8&lang=en&bbox=-122.5%2C37.75%2C-122.25%2C37.875&lon=-122.375&lat=37.8125',
    ])
  })

  it('sends an area a device location shaped only as a 0.02° box with no midpoint, keeping results inside the exact area', async () => {
    const exact: MeetingNetwork['bounds'] = [-122.513, 37.705, -122.351, 37.829]
    respond([
      feature({ name: 'Inside', osm_type: 'N', osm_id: 1 }, [-122.4, 37.78]),
      feature(
        { name: 'West of the area', osm_type: 'N', osm_id: 2 },
        [-122.515, 37.78],
      ),
      feature(
        { name: 'North of the area', osm_type: 'N', osm_id: 3 },
        [-122.4, 37.835],
      ),
    ])
    const places = await search({
      query: 'Main Street',
      mode: 'place',
      bounds: exact,
      coarseQuery: true,
      signal: signal(),
    })
    const url = requested(0)
    expect(url.searchParams.get('bbox')).toBe('-122.52,37.7,-122.34,37.84')
    expect(url.searchParams.has('lon')).toBe(false)
    expect(url.searchParams.has('lat')).toBe(false)
    expect(places.map((place) => place.name)).toEqual(['Inside'])
  })

  it('keeps coarse results apart by exact area, and finds none when every place is just outside it', async () => {
    const first: MeetingNetwork['bounds'] = [-122.513, 37.705, -122.351, 37.829]
    const second: MeetingNetwork['bounds'] = [
      -122.512, 37.706, -122.352, 37.828,
    ]
    // Inside the first area, just west of the second; both share one coarse box.
    const edge = feature({ name: 'Edge Cafe' }, [-122.5125, 37.78])
    const coarse = (area: MeetingNetwork['bounds']) =>
      search({
        query: 'Edge Cafe',
        mode: 'place',
        bounds: area,
        coarseQuery: true,
        signal: signal(),
      })
    respond([edge])
    respond([edge])
    expect((await coarse(first)).map((place) => place.name)).toEqual([
      'Edge Cafe',
    ])
    expect(await coarse(second)).toEqual([])
    expect(requested(1).href).toBe(requested(0).href)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Each area answers again from its own memory.
    expect((await coarse(first)).map((place) => place.name)).toEqual([
      'Edge Cafe',
    ])
    expect(await coarse(second)).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // An exact search of the same area is its own request, with its midpoint.
    respond([edge])
    await search({
      query: 'Edge Cafe',
      mode: 'place',
      bounds: first,
      signal: signal(),
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requested(2).searchParams.get('bbox')).toBe(first.join(','))
    expect(requested(2).searchParams.has('lon')).toBe(true)
  })

  it('searches people’s places worldwide with no area or layer, biased only when asked', async () => {
    respond([feature({ name: 'Ferry Building' })])
    await search({ query: 'Ferry', mode: 'place', bounds, signal: signal() })
    respond([feature({ name: 'Brooklyn Bridge' }, [-73.9969, 40.7061])])
    const unbiased = await search({
      query: 'Brooklyn Bridge',
      mode: 'anywhere',
      bounds,
      signal: signal(),
    })
    respond([feature({ name: 'Tokyo Tower' }, [139.7454, 35.6586])])
    const biased = await search({
      query: 'Tokyo Tower',
      mode: 'anywhere',
      near: [-122.42, 37.77],
      signal: signal(),
    })
    // A previous or passed area never filters worldwide results, nor does the bias.
    expect(unbiased.map((place) => place.coordinate)).toEqual([
      [-73.9969, 40.7061],
    ])
    expect(biased.map((place) => place.coordinate)).toEqual([
      [139.7454, 35.6586],
    ])
    for (const call of [1, 2]) {
      const url = requested(call)
      expect(url.searchParams.has('bbox')).toBe(false)
      expect(url.searchParams.has('layer')).toBe(false)
    }
    expect(requested(1).searchParams.has('lat')).toBe(false)
    expect(requested(1).searchParams.has('lon')).toBe(false)
    expect(requested(2).searchParams.get('lat')).toBe('37.77')
    expect(requested(2).searchParams.get('lon')).toBe('-122.42')
  })

  it('keeps worldwide results apart from city results and from other biases in memory', async () => {
    for (let i = 0; i < 3; i++) respond([feature({ name: 'Springfield' })])
    await search({ query: 'Springfield', mode: 'city', signal: signal() })
    await search({ query: 'Springfield', mode: 'anywhere', signal: signal() })
    await search({
      query: 'Springfield',
      mode: 'anywhere',
      near: [-89.65, 39.8],
      signal: signal(),
    })
    await search({
      query: 'Springfield',
      mode: 'anywhere',
      near: [-89.65, 39.8],
      signal: signal(),
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects an unusable location bias without sending the search', async () => {
    for (const near of [
      [Number.NaN, 37.77],
      [-122.42, 95],
      [200, 37.77],
    ] satisfies Coordinate[]) {
      await expect(
        search({
          query: 'Main Street',
          mode: 'anywhere',
          near,
          signal: signal(),
        }),
      ).rejects.toThrow(Error)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
