import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { searchMeetingPlaces } from './meeting-geocoder'
import type { MeetingNetwork } from './meeting-point'

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
})
