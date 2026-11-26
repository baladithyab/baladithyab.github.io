import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import {
  geohash,
  handleEventsRequest,
  handleTrafficRequest,
  MAX_AREA_KM2,
  MAX_EVENT_PAGES,
  parseBounds,
  snapBounds,
  trafficCacheControl,
  type EventsPayload,
  type LiveBounds,
  type LiveEnv,
  type TrafficPayload,
} from './meeting-live-server'
import { areaFromPeople } from './meeting-area'
import { boundsSizeKm, MAX_LIVE_AREA_KM2 } from './meeting-network'
import { regionBounds } from './meeting-network-loader'
import { distanceBetween, type Coordinate } from './meeting-point'

const KEY = 'test-secret-key-7f3a9c'
const env: LiveEnv = { TOMTOM_API_KEY: KEY, TICKETMASTER_API_KEY: KEY }
const now = Date.parse('2026-11-16T10:00:00Z')
const fetchMock = vi.fn<typeof fetch>()
let warn: MockInstance<typeof console.warn>

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function get(
  path: string,
  headers: HeadersInit = { 'Sec-Fetch-Site': 'same-origin' },
) {
  return new Request(`https://codeseys.io${path}`, { headers })
}

function upstream(call = 0): URL {
  const url = fetchMock.mock.calls[call]?.[0]
  if (!(url instanceof URL))
    throw new Error(`Expected upstream request ${call}`)
  return url
}

function fakeEdgeCache() {
  const store = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response)
    }),
  }
  vi.stubGlobal('caches', { default: cache })
  return cache
}

// TomTom Incident Details v5, "Response example with available fields".
// The documented JSON is missing two commas and quotes `null`; corrected here.
const tomtomGeometry: Coordinate[] = [
  [4.8905266414, 52.3725919469],
  [4.8905306647, 52.372535656],
  [4.8905360291, 52.3724806443],
  [4.8905387113, 52.3724028603],
  [4.8905440757, 52.3723505607],
  [4.8905467579, 52.3722754886],
  [4.8905574868, 52.3721722195],
  [4.8905762622, 52.3719066767],
  [4.8905963788, 52.371663905],
  [4.8905936966, 52.371524454],
  [4.8905749211, 52.3714278871],
  [4.8905440757, 52.3713393544],
  [4.8905065248, 52.3712669418],
  [4.8904555628, 52.3711703743],
  [4.8904166708, 52.3711100387],
  [4.8903268168, 52.3709759593],
  [4.8901725898, 52.370765372],
  [4.8900062928, 52.370581651],
  [4.8899472842, 52.3705320104],
]
const tomtomSample = {
  incidents: [
    {
      type: 'Feature',
      properties: {
        id: '4819f7d0a15db3d9b0c3cd9203be7ba5',
        iconCategory: 8,
        magnitudeOfDelay: 4,
        startTime: '2021-02-02T15:37:00Z',
        endTime: '2021-04-30T22:00:00Z',
        from: 'Paleisstraat',
        to: 'Rosmarijnsteeg',
        length: 238.553,
        delay: 0,
        roadNumbers: [],
        timeValidity: 'present',
        events: [{ code: 401, description: 'Closed', iconCategory: 8 }],
        aci: null,
        tmc: null,
        probabilityOfOccurrence: 'certain',
        numberOfReports: null,
        lastReportTime: null,
      },
      geometry: { type: 'LineString', coordinates: tomtomGeometry },
    },
  ],
}
// The documented default-fields example: no `id`, so it cannot be tracked.
const tomtomDefaultFieldsSample = {
  incidents: [
    {
      type: 'Feature',
      properties: { iconCategory: 8 },
      geometry: { type: 'LineString', coordinates: tomtomGeometry },
    },
  ],
}
// The documented example request's bounding box (Amsterdam).
const amsterdam =
  '4.8854592519716675,52.36934334773164,4.897883244144765,52.37496348620152'
const amsterdamBounds: LiveBounds = [
  4.8854592519716675, 52.36934334773164, 4.897883244144765, 52.37496348620152,
]
const amsterdamSnapped: LiveBounds = [4.885, 52.369, 4.898, 52.375]

function incident(
  id: string,
  properties: Record<string, unknown>,
  coordinates: unknown = [
    [4.89, 52.37],
    [4.891, 52.371],
  ],
) {
  return {
    type: 'Feature',
    properties: {
      id,
      iconCategory: 6,
      magnitudeOfDelay: 2,
      events: [],
      ...properties,
    },
    geometry: { type: 'LineString', coordinates },
  }
}

async function traffic(
  body: unknown,
  init: ResponseInit = {},
  path = `/api/meeting/traffic?bounds=${amsterdam}`,
) {
  fetchMock.mockResolvedValueOnce(Response.json(body, init))
  return handleTrafficRequest(get(path), env, now)
}

// Ticketmaster Discovery v2 Event Search, documented `size=1` response
// (repeated image renditions trimmed to one).
const ticketmasterSearchSample = {
  _links: {
    self: {
      href: '/discovery/v2/events.json?size=1{&page,sort}',
      templated: true,
    },
    next: {
      href: '/discovery/v2/events.json?page=1&size=1{&sort}',
      templated: true,
    },
  },
  _embedded: {
    events: [
      {
        name: 'WGC Cadillac Championship - Sunday Ticket',
        type: 'event',
        id: 'vvG1VZKS5pr1qy',
        test: false,
        url: 'http://ticketmaster.com/event/0E0050681F51BA4C',
        locale: 'en-us',
        images: [
          {
            ratio: '16_9',
            url: 'http://s1.ticketm.net/dam/a/196/6095e742-64d1-4b15-aeac-c9733c52d196_66341_RETINA_LANDSCAPE_16_9.jpg',
            width: 1136,
            height: 639,
            fallback: false,
          },
        ],
        sales: {
          public: {
            startDateTime: '2015-10-02T11:00:00Z',
            startTBD: false,
            endDateTime: '2016-03-06T23:00:00Z',
          },
        },
        dates: {
          start: {
            localDate: '2016-03-06',
            dateTBD: false,
            dateTBA: false,
            timeTBA: true,
            noSpecificTime: false,
          },
          timezone: 'America/New_York',
          status: { code: 'offsale' },
        },
        classifications: [
          {
            primary: true,
            segment: { id: 'KZFzniwnSyZfZ7v7nE', name: 'Sports' },
            genre: { id: 'KnvZfZ7vAdt', name: 'Golf' },
            subGenre: { id: 'KZazBEonSMnZfZ7vFI7', name: 'PGA Tour' },
          },
        ],
        promoter: { id: '682' },
        _links: {
          self: { href: '/discovery/v2/events/vvG1VZKS5pr1qy?locale=en-us' },
          attractions: [
            { href: '/discovery/v2/attractions/K8vZ917uc57?locale=en-us' },
          ],
          venues: [{ href: '/discovery/v2/venues/KovZpZAaEldA?locale=en-us' }],
        },
        _embedded: {
          venues: [
            {
              name: 'Trump National Doral',
              type: 'venue',
              id: 'KovZpZAaEldA',
              test: false,
              locale: 'en-us',
              postalCode: '33178',
              timezone: 'America/New_York',
              city: { name: 'Miami' },
              state: { name: 'Florida', stateCode: 'FL' },
              country: { name: 'United States Of America', countryCode: 'US' },
              address: { line1: '4400 NW 87th Avenue' },
              location: { longitude: '-80.33854298', latitude: '25.81260379' },
              markets: [{ id: '15' }],
              _links: {
                self: {
                  href: '/discovery/v2/venues/KovZpZAaEldA?locale=en-us',
                },
              },
            },
          ],
          attractions: [
            {
              name: 'Cadillac Championship',
              type: 'attraction',
              id: 'K8vZ917uc57',
              test: false,
              locale: 'en-us',
            },
          ],
        },
      },
    ],
  },
  page: { size: 1, totalElements: 87958, totalPages: 87958, number: 0 },
}
const miami = '-80.38,25.77,-80.3,25.85'

// Documented Get Event Details response (same event shape), trimmed to the
// fields Event Search shares.
const radiohead = {
  _embedded: {
    venues: [
      {
        name: 'Madison Square Garden',
        type: 'venue',
        id: 'KovZpZA7AAEA',
        url: 'http://ticketmaster.com/venue/483329',
        location: { longitude: '-73.99160060', latitude: '40.74970620' },
      },
    ],
  },
  classifications: [
    {
      primary: true,
      segment: { id: 'KZFzniwnSyZfZ7v7nJ', name: 'Music' },
      genre: { id: 'KnvZfZ7vAeA', name: 'Rock' },
    },
  ],
  dates: {
    start: {
      localDate: '2016-07-27',
      localTime: '19:30:00',
      dateTime: '2016-07-27T23:30:00Z',
      dateTBD: false,
      dateTBA: false,
      timeTBA: false,
      noSpecificTime: false,
    },
    timezone: 'America/New_York',
    status: { code: 'onsale' },
  },
  id: 'G5diZfkn0B-bh',
  locale: 'en-us',
  name: 'Radiohead',
  type: 'event',
  url: 'http://ticketmaster.com/event/3B00506AA4EA161B',
}
const newYork = '-74.03,40.71,-73.95,40.79'

function event(
  id: string,
  start: string | undefined,
  location: unknown = { longitude: '-73.99', latitude: '40.75' },
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    name: `Show ${id}`,
    url: `https://www.ticketmaster.com/event/${id}`,
    dates: { start: start ? { dateTime: start } : { localDate: '2026-11-16' } },
    _embedded: { venues: [{ name: 'Venue', location }] },
    ...extra,
  }
}

async function events(
  body: unknown,
  init: ResponseInit = {},
  path = `/api/meeting/events?bounds=${newYork}&window=week`,
) {
  fetchMock.mockResolvedValueOnce(Response.json(body, init))
  return handleEventsRequest(get(path), env, now)
}

async function ids(response: Response) {
  return ((await response.json()) as EventsPayload).events.map(
    (item) => item.id,
  )
}

// West of the narrow test area (-74.025), inside its 0.01° snapped box.
const marginVenue = { longitude: '-74.027', latitude: '40.75' }

/** `count` events at a venue inside the search circle but west of New York's box. */
function outsideEvents(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) =>
    event(`${prefix}-${i}`, '2026-11-17T20:00:00Z', {
      longitude: '-74.06',
      latitude: '40.75',
    }),
  )
}

/** `widthKm` × `heightKm` around `center`, measured like `boundsSizeKm`. */
function rectangle(
  [longitude, latitude]: Coordinate,
  widthKm: number,
  heightKm: number,
): LiveBounds {
  const halfLatitude = heightKm / 2 / 111.195
  const halfLongitude =
    widthKm / 2 / (111.195 * Math.cos((latitude * Math.PI) / 180))
  return [
    longitude - halfLongitude,
    latitude - halfLatitude,
    longitude + halfLongitude,
    latitude + halfLatitude,
  ]
}

describe('live layer bounds', () => {
  it('accepts every city square at any supported latitude', () => {
    for (const latitude of [-84, 0, 37.77, 60, 84])
      for (const size of [4, 8, 12] as const)
        expect(
          parseBounds(regionBounds([10, latitude], size).join(',')),
        ).toMatchObject({ ok: true })
  })

  it('accepts the 702 km² area fitted to three East Bay addresses', async () => {
    const bounds: LiveBounds = [-122.01085, 37.51399, -121.69563, 37.74126]
    expect(parseBounds(bounds.join(','))).toEqual({ ok: true, value: bounds })
    fetchMock.mockResolvedValueOnce(Response.json({ incidents: [] }))
    const response = await handleTrafficRequest(
      get(`/api/meeting/traffic?bounds=${bounds.join(',')}`),
      env,
      now,
    )
    expect(response.status).toBe(200)
    expect(upstream().searchParams.get('bbox')).toBe(
      '-122.011,37.513,-121.695,37.742',
    )
  })

  it('accepts the largest people area after snapping, square or long', () => {
    const side = Math.sqrt(MAX_LIVE_AREA_KM2)
    for (const latitude of [-60.0004, 0.0004, 37.7703, 60.0004, 84.0004])
      for (const [widthKm, heightKm] of [
        [side, side],
        [side * Math.SQRT2, side / Math.SQRT2],
        [side / Math.SQRT2, side * Math.SQRT2],
      ]) {
        const bounds = rectangle([10.0004, latitude], widthKm, heightKm)
        expect(boundsSizeKm(bounds).areaKm2).toBeCloseTo(MAX_LIVE_AREA_KM2, 6)
        // Snapping outward to the 0.01° events grid makes the area the
        // routes check a little larger, but still under the ceiling.
        const snappedArea = boundsSizeKm(snapBounds(bounds, 2)).areaKm2
        expect(snappedArea).toBeGreaterThan(MAX_LIVE_AREA_KM2)
        expect(snappedArea).toBeLessThanOrEqual(MAX_AREA_KM2)
        expect(parseBounds(bounds.join(','))).toMatchObject({ ok: true })
      }
  })

  it('accepts the longest people area, where the 85° clamp shortens it', () => {
    // About 128 × 31 km: the clamp cuts the northern half of its height.
    const area = areaFromPeople([
      [10, 85],
      [22.4, 85],
    ])
    if (area.kind !== 'area')
      throw new Error(`Expected an area, got ${area.kind}`)
    expect(area.widthKm).toBeGreaterThan(120)
    expect(parseBounds(area.bounds.join(','))).toMatchObject({ ok: true })
  })

  it('refuses an area clearly larger than the lab loads', () => {
    for (const latitude of [0, 37.77, 60, 84]) {
      // 4,900 km², and the 10,000 km² TomTom allows at most.
      for (const side of [70, 100])
        expect(
          parseBounds(rectangle([10, latitude], side, side).join(',')),
        ).toMatchObject({ ok: false })
      // Under the area ceiling, but longer than any area the lab loads.
      expect(
        parseBounds(rectangle([10, latitude], 200, 5).join(',')),
      ).toMatchObject({ ok: false })
      expect(
        parseBounds(rectangle([10, latitude], 5, 200).join(',')),
      ).toMatchObject({ ok: false })
    }
  })

  it.each([
    ['reversed longitudes', '-122.3,37.7,-122.4,37.8'],
    ['reversed latitudes', '-122.4,37.8,-122.3,37.7'],
    ['an empty box', '-122.4,37.7,-122.4,37.8'],
    ['not a number', '-122.4,abc,-122.3,37.8'],
    ['an infinite bound', '-122.4,37.7,Infinity,37.8'],
    ['an empty bound', '-122.4,,-122.3,37.8'],
    ['three bounds', '-122.4,37.7,-122.3'],
    ['five bounds', '-122.4,37.7,-122.3,37.8,1'],
    ['hexadecimal', '0x10,37.7,17,37.8'],
    ['latitude beyond 85°', '10,85.01,10.01,85.02'],
    ['longitude beyond 180°', '180.01,10,180.02,10.01'],
    ['an area 200 km wide', '0,0,1.8,0.04'],
    ['an area 200 km tall', '0,0,0.04,1.8'],
    ['an area of about 6,000 km²', '0,0,0.7,0.7'],
  ])('rejects %s', (_, value) => {
    expect(parseBounds(value)).toMatchObject({ ok: false })
  })

  it('rejects a missing parameter', () => {
    expect(parseBounds(null)).toMatchObject({ ok: false })
  })

  it('measures east-west extent in kilometres, not degrees', () => {
    // 0.8° × 0.5° is about 44 × 56 km (2,450 km²) at 60° north,
    // but 89 × 56 km (4,950 km²) at the equator.
    expect(parseBounds('10,60,10.8,60.5')).toMatchObject({ ok: true })
    expect(parseBounds('10,-0.25,10.8,0.25')).toMatchObject({ ok: false })
  })

  it('accepts the bundled San Francisco preset, 14.07 × 12.01 km', async () => {
    // `bounds` in public/lab/meeting-point/sf.json, already on the 0.001° grid.
    const preset: LiveBounds = [-122.515, 37.704, -122.355, 37.812]
    expect(parseBounds(preset.join(','))).toEqual({ ok: true, value: preset })
    expect(snapBounds(preset)).toEqual(preset)
    fetchMock.mockResolvedValueOnce(Response.json({ incidents: [] }))
    const response = await handleTrafficRequest(
      get(`/api/meeting/traffic?bounds=${preset.join(',')}`),
      env,
      now,
    )
    expect(response.status).toBe(200)
    expect(upstream().searchParams.get('bbox')).toBe(preset.join(','))
  })

  it('snaps outward to three decimal places', () => {
    const raw: LiveBounds = [-122.4567, 37.7012, -122.3001, 37.8049]
    const snapped = snapBounds(raw)
    expect(snapped).toEqual([-122.457, 37.701, -122.3, 37.805])
    expect(snapped[0]).toBeLessThanOrEqual(raw[0])
    expect(snapped[1]).toBeLessThanOrEqual(raw[1])
    expect(snapped[2]).toBeGreaterThanOrEqual(raw[2])
    expect(snapped[3]).toBeGreaterThanOrEqual(raw[3])
    expect(snapBounds(snapped)).toEqual(snapped)
    expect(snapBounds([4.885, 52.369, 4.898, 52.375])).toEqual([
      4.885, 52.369, 4.898, 52.375,
    ])
  })

  it('snaps outward to two decimal places for events', () => {
    const raw: LiveBounds = [-122.4567, 37.7012, -122.3001, 37.8049]
    expect(snapBounds(raw, 2)).toEqual([-122.46, 37.7, -122.3, 37.81])
    const onGrid: LiveBounds = [-74.03, 40.71, -73.95, 40.79]
    expect(snapBounds(onGrid, 2)).toEqual(onGrid)
  })

  it('serves a 4,000 km² square on both routes, each snapped to its grid', async () => {
    const side = Math.sqrt(MAX_LIVE_AREA_KM2)
    const bounds = rectangle([-121.8504, 37.6304], side, side)
    const query = bounds.join(',')
    fetchMock.mockResolvedValueOnce(Response.json({ page: {} }))
    const listing = await handleEventsRequest(
      get(`/api/meeting/events?bounds=${query}&window=day`),
      env,
      now,
    )
    expect(listing.status).toBe(200)
    const [west, south, east, north] = snapBounds(bounds, 2)
    expect(upstream(0).searchParams.get('geoPoint')).toBe(
      geohash([(west + east) / 2, (south + north) / 2]),
    )
    fetchMock.mockResolvedValueOnce(Response.json({ incidents: [] }))
    const incidents = await handleTrafficRequest(
      get(`/api/meeting/traffic?bounds=${query}`),
      env,
      now,
    )
    expect(incidents.status).toBe(200)
    expect(upstream(1).searchParams.get('bbox')).toBe(
      snapBounds(bounds).join(','),
    )
  })
})

describe('same-site guard', () => {
  it.each([
    ['another site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['a sibling subdomain', { 'Sec-Fetch-Site': 'same-site' }],
    ['a typed address', { 'Sec-Fetch-Site': 'none' }],
    ['a foreign origin', { Origin: 'https://evil.example' }],
    [
      'a foreign origin on a same-origin fetch',
      {
        'Sec-Fetch-Site': 'same-origin',
        Origin: 'https://codeseys.io.evil.example',
      },
    ],
  ])('refuses %s without calling a provider', async (_, headers) => {
    for (const response of [
      await handleTrafficRequest(
        get(`/api/meeting/traffic?bounds=${amsterdam}`, headers),
        env,
        now,
      ),
      await handleEventsRequest(
        get(`/api/meeting/events?bounds=${newYork}&window=day`, headers),
        env,
        now,
      ),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows this site’s own requests, with or without fetch metadata', async () => {
    const allowed: HeadersInit[] = [
      {},
      { Origin: 'https://codeseys.io', 'Sec-Fetch-Site': 'same-origin' },
    ]
    for (const headers of allowed) {
      fetchMock.mockResolvedValueOnce(Response.json({ incidents: [] }))
      const response = await handleTrafficRequest(
        get(`/api/meeting/traffic?bounds=${amsterdam}`, headers),
        env,
        now,
      )
      expect(response.status).toBe(200)
    }
  })
})

describe('traffic route', () => {
  it('normalises TomTom’s documented incident to the contract', async () => {
    const response = await traffic(tomtomSample)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      provider: 'tomtom',
      fetched: '2026-11-16T10:00:00.000Z',
      incidents: [
        {
          id: '4819f7d0a15db3d9b0c3cd9203be7ba5',
          kind: 'closure',
          severity: 1,
          delaySeconds: null,
          description: 'Closed: Paleisstraat to Rosmarijnsteeg',
          coordinates: tomtomGeometry,
        },
      ],
    } satisfies TrafficPayload)
    const url = upstream()
    expect(url.origin + url.pathname).toBe(
      'https://api.tomtom.com/traffic/services/5/incidentDetails',
    )
    expect(url.searchParams.get('bbox')).toBe(amsterdamSnapped.join(','))
    expect(url.searchParams.get('timeValidityFilter')).toBe('present')
    expect(url.searchParams.get('fields')).toContain(
      'properties{id,iconCategory,magnitudeOfDelay,events{description',
    )
  })

  it('drops incidents TomTom returns without an id', async () => {
    const response = await traffic(tomtomDefaultFieldsSample)
    expect(response.status).toBe(200)
    expect(((await response.json()) as TrafficPayload).incidents).toEqual([])
  })

  it('maps kinds, severity and delay, most severe first', async () => {
    const response = await traffic({
      incidents: [
        incident('roadworks', {
          iconCategory: 9,
          magnitudeOfDelay: 1,
          delay: 30,
        }),
        incident('jam', { iconCategory: 6, magnitudeOfDelay: 3, delay: 420 }),
        incident('flood', {
          iconCategory: 11,
          magnitudeOfDelay: 0,
          events: [{ description: 'Flooding' }],
        }),
        incident('crash', { iconCategory: 1, magnitudeOfDelay: 2, delay: 120 }),
        incident('closed', { iconCategory: 8, magnitudeOfDelay: 4, delay: 0 }),
      ],
    })
    const { incidents } = (await response.json()) as TrafficPayload
    expect(
      incidents.map(({ id, kind, delaySeconds }) => [id, kind, delaySeconds]),
    ).toEqual([
      ['closed', 'closure', null],
      ['jam', 'jam', 420],
      ['crash', 'accident', 120],
      ['roadworks', 'roadworks', 30],
      ['flood', 'other', null],
    ])
    const severities = incidents.map((item) => item.severity)
    expect(severities).toEqual([...severities].sort((a, b) => b - a))
    expect(severities.every((value) => value >= 0 && value <= 1)).toBe(true)
    expect(incidents[0].severity).toBe(1)
    expect(incidents.find((item) => item.id === 'flood')?.description).toBe(
      'Flooding',
    )
  })

  it('keeps only the 300 most severe incidents', async () => {
    const items = [
      ...Array.from({ length: 320 }, (_, i) =>
        incident(`minor-${i}`, { magnitudeOfDelay: 1 }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        incident(`closed-${i}`, { iconCategory: 8, magnitudeOfDelay: 4 }),
      ),
    ]
    const { incidents } = (await (
      await traffic({ incidents: items })
    ).json()) as TrafficPayload
    expect(incidents).toHaveLength(300)
    expect(incidents.filter((item) => item.kind === 'closure')).toHaveLength(40)
  })

  it('keeps only geometry inside the area', async () => {
    const [west, south, east, north] = amsterdamBounds
    const response = await traffic({
      incidents: [
        // Starts inside and runs east out of the area.
        incident('leaving', {}, [
          [4.89, 52.37],
          [4.95, 52.37],
        ]),
        // Crosses the area twice: two separate parts.
        incident('twice', {}, [
          [4.88, 52.37],
          [4.89, 52.37],
          [4.89, 52.38],
          [4.895, 52.38],
          [4.895, 52.372],
        ]),
        incident('outside', {}, [
          [5, 53],
          [5.1, 53.1],
        ]),
        {
          type: 'Feature',
          properties: { id: 'point-out', iconCategory: 1, magnitudeOfDelay: 2 },
          geometry: { type: 'Point', coordinates: [4.8, 52.3] },
        },
        {
          type: 'Feature',
          properties: { id: 'point-in', iconCategory: 1, magnitudeOfDelay: 2 },
          geometry: { type: 'Point', coordinates: [4.89, 52.37] },
        },
      ],
    })
    const { incidents } = (await response.json()) as TrafficPayload
    const byId = new Map(incidents.map((item) => [item.id, item.coordinates]))
    expect([...byId.keys()].sort()).toEqual([
      'leaving',
      'point-in',
      'twice',
      'twice~1',
    ])
    for (const coordinates of byId.values())
      for (const [longitude, latitude] of coordinates) {
        expect(longitude).toBeGreaterThanOrEqual(west)
        expect(longitude).toBeLessThanOrEqual(east)
        expect(latitude).toBeGreaterThanOrEqual(south)
        expect(latitude).toBeLessThanOrEqual(north)
      }
    const expectPath = (
      actual: Coordinate[] | undefined,
      expected: Coordinate[],
    ) => {
      expect(actual).toHaveLength(expected.length)
      expected.forEach(([longitude, latitude], index) => {
        expect(actual?.[index][0]).toBeCloseTo(longitude, 9)
        expect(actual?.[index][1]).toBeCloseTo(latitude, 9)
      })
    }
    expectPath(byId.get('leaving'), [
      [4.89, 52.37],
      [east, 52.37],
    ])
    expectPath(byId.get('twice'), [
      [west, 52.37],
      [4.89, 52.37],
      [4.89, north],
    ])
    expectPath(byId.get('twice~1'), [
      [4.895, north],
      [4.895, 52.372],
    ])
  })

  it('clips to the requested area, not the snapped box TomTom is asked for', async () => {
    const response = await traffic({
      incidents: [
        // West of the area, inside the snapped box's 0.001° margin.
        incident('margin-line', {}, [
          [4.8851, 52.37],
          [4.8853, 52.374],
        ]),
        // East of the area, likewise.
        {
          type: 'Feature',
          properties: {
            id: 'margin-point',
            iconCategory: 1,
            magnitudeOfDelay: 2,
          },
          geometry: { type: 'Point', coordinates: [4.8979, 52.3705] },
        },
        incident('inside', {}),
      ],
    })
    expect(upstream().searchParams.get('bbox')).toBe(amsterdamSnapped.join(','))
    const { incidents } = (await response.json()) as TrafficPayload
    expect(incidents.map((item) => item.id)).toEqual(['inside'])
  })

  it('drops malformed incidents without failing the rest', async () => {
    const response = await traffic({
      incidents: [
        null,
        'incident',
        { type: 'Feature' },
        incident('', {}),
        incident('no-category', { iconCategory: undefined }),
        incident('fractional', { iconCategory: 6.5 }),
        incident('bad-magnitude', { magnitudeOfDelay: 9 }),
        incident('string-points', {}, [
          ['4.89', '52.37'],
          ['4.891', '52.371'],
        ]),
        incident('nan', {}, [
          [Number.NaN, 52.37],
          [4.891, 52.371],
        ]),
        incident('one-point', {}, [[4.89, 52.37]]),
        incident('wrong-events', { events: 'Closed' }),
        {
          type: 'Feature',
          properties: { id: 'polygon', iconCategory: 6, magnitudeOfDelay: 2 },
          geometry: { type: 'Polygon', coordinates: [] },
        },
        incident('good', { delay: -5 }),
      ],
    })
    expect(response.status).toBe(200)
    const { incidents } = (await response.json()) as TrafficPayload
    expect(incidents.map((item) => item.id)).toEqual(['good'])
    expect(incidents[0].delaySeconds).toBeNull()
  })

  it.each([
    ['an unexpected root', { features: [] }],
    ['an array root', [tomtomSample]],
  ])('reports %s as an upstream failure', async (_, body) => {
    const response = await traffic(body)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream', status: 200 })
  })

  it('reports unreadable and oversized bodies as upstream failures', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"incidents": [', { status: 200 }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(7 * 1024 * 1024) },
      }),
    )
    for (let i = 0; i < 2; i++) {
      const response = await handleTrafficRequest(
        get(`/api/meeting/traffic?bounds=${amsterdam}`),
        env,
        now,
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'upstream', status: 200 })
    }
  })

  it.each([
    [null, 'no-store'],
    ['no-cache', 'no-store'],
    ['max-age=0', 'no-store'],
    ['max-age=60', 'private, max-age=60'],
    ['public, max-age=600', 'private, max-age=120'],
  ])(
    'passes TomTom’s Cache-Control %s on as %s, never to the edge cache',
    async (upstreamHeader, expected) => {
      const cache = fakeEdgeCache()
      const response = await traffic(
        tomtomSample,
        upstreamHeader ? { headers: { 'Cache-Control': upstreamHeader } } : {},
      )
      expect(response.headers.get('Cache-Control')).toBe(expected)
      expect(cache.match).not.toHaveBeenCalled()
      expect(cache.put).not.toHaveBeenCalled()
    },
  )

  it('takes the time TomTom’s answer already spent in caches off its max-age', async () => {
    const cases: [HeadersInit, string][] = [
      [{ 'Cache-Control': 'max-age=90', Age: '87' }, 'private, max-age=3'],
      [{ 'Cache-Control': 'max-age=90', Age: '95' }, 'no-store'],
      [
        {
          'Cache-Control': 'max-age=60',
          Date: new Date(now - 45_000).toUTCString(),
        },
        'private, max-age=15',
      ],
    ]
    for (const [headers, expected] of cases) {
      const response = await traffic(tomtomSample, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe(expected)
    }
  })

  it('maps provider throttling and failures to our statuses', async () => {
    const cases: [ResponseInit['status'], number, unknown][] = [
      [429, 429, { error: 'rate_limited' }],
      [500, 502, { error: 'upstream', status: 500 }],
      [503, 502, { error: 'upstream', status: 503 }],
      [403, 502, { error: 'upstream', status: 403 }],
    ]
    for (const [status, ours, body] of cases) {
      const response = await traffic(
        { detailedError: { code: 'X', message: 'failure' } },
        { status },
      )
      expect(response.status).toBe(ours)
      expect(await response.json()).toEqual(body)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const offline = await handleTrafficRequest(
      get(`/api/meeting/traffic?bounds=${amsterdam}`),
      env,
      now,
    )
    expect(offline.status).toBe(502)
    expect(await offline.json()).toEqual({ error: 'upstream', status: null })
  })

  it('logs one structured line per failure, with snapped bounds', async () => {
    await traffic({}, { status: 500 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({
      endpoint: 'traffic',
      provider: 'tomtom',
      status: 500,
      bounds: amsterdamSnapped.join(','),
    })
  })

  it.each([[undefined], [''], ['   ']])(
    'reports a missing key (%j) as not configured without calling TomTom',
    async (key) => {
      const response = await handleTrafficRequest(
        get(`/api/meeting/traffic?bounds=${amsterdam}`),
        { TOMTOM_API_KEY: key },
        now,
      )
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'not_configured' })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('rejects malformed bounds with a readable message', async () => {
    const response = await handleTrafficRequest(
      get('/api/meeting/traffic?bounds=1,2,3'),
      env,
      now,
    )
    expect(response.status).toBe(400)
    const body: unknown = await response.json()
    expect(body).toMatchObject({
      error: 'invalid_request',
      message: expect.any(String),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('events route', () => {
  it('normalises Ticketmaster’s documented event search to the contract', async () => {
    const response = await events(
      ticketmasterSearchSample,
      {},
      `/api/meeting/events?bounds=${miami}&window=day`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      provider: 'ticketmaster',
      fetched: '2026-11-16T10:00:00.000Z',
      window: 'day',
      events: [
        {
          id: 'vvG1VZKS5pr1qy',
          name: 'WGC Cadillac Championship - Sunday Ticket',
          start: null,
          category: 'Sports',
          venue: 'Trump National Doral',
          coordinate: [-80.33854298, 25.81260379],
          url: 'http://ticketmaster.com/event/0E0050681F51BA4C',
        },
      ],
    } satisfies EventsPayload)
  })

  it('reads the documented start time and category', async () => {
    const response = await events({
      _embedded: { events: [radiohead] },
      page: {},
    })
    expect(((await response.json()) as EventsPayload).events).toEqual([
      {
        id: 'G5diZfkn0B-bh',
        name: 'Radiohead',
        start: '2016-07-27T23:30:00.000Z',
        category: 'Music',
        venue: 'Madison Square Garden',
        coordinate: [-73.9916006, 40.7497062],
        url: 'http://ticketmaster.com/event/3B00506AA4EA161B',
      },
    ])
  })

  it('asks for the next day or week of events around the whole area', async () => {
    await events(
      { page: { totalElements: 0 } },
      {},
      `/api/meeting/events?bounds=${newYork}&window=day`,
    )
    await events(
      { page: { totalElements: 0 } },
      {},
      `/api/meeting/events?bounds=${newYork}&window=week`,
    )
    const [day, week] = [upstream(0), upstream(1)]
    expect(day.origin + day.pathname).toBe(
      'https://app.ticketmaster.com/discovery/v2/events.json',
    )
    const start = day.searchParams.get('startDateTime') ?? ''
    expect(start).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(Date.parse(start)).toBe(now)
    expect(Date.parse(day.searchParams.get('endDateTime') ?? '') - now).toBe(
      24 * 3_600_000,
    )
    expect(Date.parse(week.searchParams.get('endDateTime') ?? '') - now).toBe(
      7 * 24 * 3_600_000,
    )
    expect(day.searchParams.get('sort')).toBe('date,asc')
    const size = Number(day.searchParams.get('size'))
    const page = Number(day.searchParams.get('page'))
    expect(size * page).toBeLessThan(1000)
    expect(day.searchParams.get('unit')).toBe('km')
    // The radius must reach every corner of the area.
    const [west, south, east, north] = snapBounds(
      [-74.03, 40.71, -73.95, 40.79],
      2,
    )
    const center: Coordinate = [(west + east) / 2, (south + north) / 2]
    expect(day.searchParams.get('geoPoint')).toBe(geohash(center))
    const radius = Number(day.searchParams.get('radius')) * 1000
    for (const corner of [
      [west, south],
      [west, north],
      [east, south],
      [east, north],
    ] satisfies Coordinate[])
      expect(distanceBetween(center, corner)).toBeLessThanOrEqual(radius)
  })

  it('reaches every corner of the largest areas the lab loads, north or south', async () => {
    const side = Math.sqrt(MAX_LIVE_AREA_KM2)
    let call = 0
    for (const center of [
      [-121.85, 37.63],
      [151.2, -60],
    ] satisfies Coordinate[])
      for (const [widthKm, heightKm] of [
        [side, side],
        [side * Math.SQRT2, side / Math.SQRT2],
      ]) {
        const bounds = rectangle(center, widthKm, heightKm)
        await events(
          { page: { totalElements: 0 } },
          {},
          `/api/meeting/events?bounds=${bounds.join(',')}&window=week`,
        )
        const [west, south, east, north] = snapBounds(bounds, 2)
        const middle: Coordinate = [(west + east) / 2, (south + north) / 2]
        const radius =
          Number(upstream(call++).searchParams.get('radius')) * 1000
        for (const corner of [
          [west, south],
          [west, north],
          [east, south],
          [east, north],
        ] satisfies Coordinate[])
          expect(distanceBetween(middle, corner)).toBeLessThanOrEqual(radius)
        // Whole kilometres, at most one beyond the farthest corner (about 45 to 51 km here).
        expect(radius).toBeLessThan(52_000)
      }
  })

  it('drops events without venue coordinates, outside the area, or called off', async () => {
    const response = await events({
      _embedded: {
        events: [
          event('keep', '2026-11-17T20:00:00Z'),
          event('no-venue', '2026-11-17T20:00:00Z', undefined, {
            _embedded: {},
          }),
          event('no-location', '2026-11-17T20:00:00Z', null),
          event('bad-location', '2026-11-17T20:00:00Z', {
            longitude: 'west',
            latitude: '40.75',
          }),
          event('far-away', '2026-11-17T20:00:00Z', {
            longitude: '-80.33',
            latitude: '25.81',
          }),
          event('cancelled', '2026-11-17T20:00:00Z', undefined, {
            dates: { status: { code: 'canceled' } },
          }),
          event('', '2026-11-17T20:00:00Z'),
          { ...event('no-name', '2026-11-17T20:00:00Z'), name: '  ' },
          {
            ...event('script-url', '2026-11-17T21:00:00Z'),
            url: 'javascript:alert(1)',
          },
          null,
        ],
      },
      page: {},
    })
    const body = (await response.json()) as EventsPayload
    expect(body.events.map((item) => [item.id, item.url])).toEqual([
      ['keep', 'https://www.ticketmaster.com/event/keep'],
      ['script-url', null],
    ])
  })

  it('keeps the 200 soonest events, undated last', async () => {
    const items = Array.from({ length: 250 }, (_, i) =>
      event(
        `e${i}`,
        i % 50 === 0
          ? undefined
          : new Date(now + (250 - i) * 60_000).toISOString(),
      ),
    )
    const { events: kept } = (await (
      await events({ _embedded: { events: items }, page: {} })
    ).json()) as EventsPayload
    expect(kept).toHaveLength(200)
    const starts = kept.map((item) =>
      item.start ? Date.parse(item.start) : Infinity,
    )
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(kept.every((item) => item.start !== null)).toBe(true)
    expect(kept[0].id).toBe('e249')
  })

  it('treats a search without results as an empty list', async () => {
    const response = await events({
      _links: { self: { href: '/discovery/v2/events.json' } },
      page: { size: 200, totalElements: 0, totalPages: 0, number: 0 },
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as EventsPayload).events).toEqual([])
  })

  it.each([
    ['events that are not a list', { _embedded: { events: 'none' } }],
    ['an unrecognised object', { results: [] }],
    ['a bare list', []],
  ])('reports %s as an upstream failure', async (_, body) => {
    const response = await events(body)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream', status: 200 })
  })

  it('rejects an unknown window', async () => {
    const response = await handleEventsRequest(
      get(`/api/meeting/events?bounds=${newYork}&window=month`),
      env,
      now,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches successes for 30 minutes per snapped area and window, never errors', async () => {
    const cache = fakeEdgeCache()
    const first = await events({ _embedded: { events: [radiohead] }, page: {} })
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=1800')
    expect(cache.put).toHaveBeenCalledTimes(1)
    // A nearby request inside the same 0.01° grid reuses the entry, and the
    // browser may keep it only for what is left of the 30 minutes.
    const again = await handleEventsRequest(
      get(
        '/api/meeting/events?bounds=-74.0299,40.7101,-73.9501,40.7899&window=week',
      ),
      env,
      now + 60_000,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(again.headers.get('Cache-Control')).toBe('public, max-age=1740')
    expect(await again.json()).toEqual(await first.clone().json())

    await events(
      {},
      { status: 429 },
      `/api/meeting/events?bounds=${newYork}&window=day`,
    )
    expect(cache.put).toHaveBeenCalledTimes(1)
    await events(
      { page: {} },
      {},
      `/api/meeting/events?bounds=${newYork}&window=day`,
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(cache.put).toHaveBeenCalledTimes(2)

    // An entry 30 minutes old is searched again.
    fetchMock.mockResolvedValueOnce(Response.json({ page: {} }))
    await handleEventsRequest(
      get(`/api/meeting/events?bounds=${newYork}&window=week`),
      env,
      now + 1_800_000,
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('returns only events inside the requested area, not the snapped box', async () => {
    // Snaps to -74.03,40.71,-73.95,40.79; the margin event is west of it.
    const narrow = '-74.025,40.715,-73.955,40.785'
    const response = await events(
      {
        _embedded: {
          events: [
            event('inside', '2026-11-17T20:00:00Z'),
            event('margin', '2026-11-17T21:00:00Z', marginVenue),
          ],
        },
        page: {},
      },
      {},
      `/api/meeting/events?bounds=${narrow}&window=week`,
    )
    expect(await ids(response)).toEqual(['inside'])
    expect(upstream().searchParams.get('geoPoint')).toBe(
      geohash([-73.99, 40.75]),
    )
  })

  it('filters a cached search to each requested area in its snapped box', async () => {
    const cache = fakeEdgeCache()
    // Both snap to -74.03,40.71,-73.95,40.79; only the wide one holds the margin.
    const wide = '-74.029,40.715,-73.955,40.785'
    const narrow = '-74.025,40.715,-73.955,40.785'
    const first = await events(
      {
        _embedded: {
          events: [
            event('inside', '2026-11-17T20:00:00Z'),
            event('margin', '2026-11-17T21:00:00Z', marginVenue),
          ],
        },
        page: {},
      },
      {},
      `/api/meeting/events?bounds=${wide}&window=week`,
    )
    expect(await ids(first)).toEqual(['inside', 'margin'])
    const hit = await handleEventsRequest(
      get(`/api/meeting/events?bounds=${narrow}&window=week`),
      env,
      now,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)
    expect(await ids(hit)).toEqual(['inside'])
  })

  it('reads the next page when the first fills with venues outside the area', async () => {
    const cache = fakeEdgeCache()
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { events: outsideEvents('far', 200) },
        page: { size: 200, totalElements: 201, totalPages: 2, number: 0 },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: { events: [event('near', '2026-11-18T20:00:00Z')] },
        page: { size: 200, totalElements: 201, totalPages: 2, number: 1 },
      }),
    )
    const response = await handleEventsRequest(
      get(`/api/meeting/events?bounds=${newYork}&window=week`),
      env,
      now,
    )
    expect(response.status).toBe(200)
    expect(await ids(response)).toEqual(['near'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      [upstream(0), upstream(1)].map((url) => url.searchParams.get('page')),
    ).toEqual(['0', '1'])
    expect(upstream(1).searchParams.get('geoPoint')).toBe(
      upstream(0).searchParams.get('geoPoint'),
    )
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  it('reads at most three pages and keeps each event once, soonest first', async () => {
    const pages = [
      [event('a', '2026-11-17T20:00:00Z'), ...outsideEvents('far0', 199)],
      [
        event('a', '2026-11-17T20:00:00Z'),
        event('b', '2026-11-19T20:00:00Z'),
        ...outsideEvents('far1', 198),
      ],
      [event('c', '2026-11-18T20:00:00Z'), ...outsideEvents('far2', 199)],
    ]
    pages.forEach((items, number) =>
      fetchMock.mockResolvedValueOnce(
        Response.json({
          _embedded: { events: items },
          page: { size: 200, totalPages: 5, number },
        }),
      ),
    )
    const response = await events({
      _embedded: { events: outsideEvents('never', 200) },
      page: { totalPages: 5, number: 3 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(MAX_EVENT_PAGES)
    expect(
      fetchMock.mock.calls.map((_, call) =>
        upstream(call).searchParams.get('page'),
      ),
    ).toEqual(['0', '1', '2'])
    expect(await ids(response)).toEqual(['a', 'c', 'b'])
  })

  it('stops once a page holds 200 events in the area', async () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      event(`e${i}`, '2026-11-17T20:00:00Z'),
    )
    const response = await events({
      _embedded: { events: items },
      page: { size: 200, totalPages: 3, number: 0 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(((await response.json()) as EventsPayload).events).toHaveLength(200)
  })

  it('fails cleanly, uncached and logged once, when a later page fails', async () => {
    const cache = fakeEdgeCache()
    fetchMock.mockResolvedValueOnce(
      Response.json({
        _embedded: {
          events: [
            event('near', '2026-11-17T20:00:00Z'),
            ...outsideEvents('far', 199),
          ],
        },
        page: { size: 200, totalPages: 2, number: 0 },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { fault: { faultstring: `Server error for ${KEY}` } },
        { status: 500 },
      ),
    )
    const response = await handleEventsRequest(
      get(`/api/meeting/events?bounds=${newYork}&window=week`),
      env,
      now,
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream', status: 500 })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(cache.put).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({
      endpoint: 'events',
      provider: 'ticketmaster',
      status: 500,
      reason: 'http',
      page: 1,
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY)
  })

  it('maps provider throttling and failures to our statuses', async () => {
    expect((await events({}, { status: 429 })).status).toBe(429)
    const failed = await events({}, { status: 500 })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: 'upstream', status: 500 })
  })

  it('reports a missing key as not configured without calling Ticketmaster', async () => {
    const response = await handleEventsRequest(
      get(`/api/meeting/events?bounds=${newYork}&window=day`),
      { TOMTOM_API_KEY: KEY },
      now,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('API keys', () => {
  it('never appear in responses or logs', async () => {
    // Ticketmaster's documented quota response echoes the key.
    const quota = {
      fault: {
        faultstring: `Rate limit quota violation. Quota limit exceeded. Identifier : ${KEY}`,
        detail: { errorcode: 'policies.ratelimit.QuotaViolation' },
      },
    }
    const bodies: string[] = []
    const run = async (handler: typeof handleTrafficRequest, path: string) => {
      const response = await handler(get(path), env, now)
      bodies.push(await response.text(), JSON.stringify([...response.headers]))
    }
    for (const [handler, path] of [
      [handleTrafficRequest, `/api/meeting/traffic?bounds=${amsterdam}`],
      [handleEventsRequest, `/api/meeting/events?bounds=${newYork}&window=day`],
    ] as const) {
      fetchMock.mockResolvedValueOnce(Response.json(quota, { status: 429 }))
      await run(handler, path)
      fetchMock.mockResolvedValueOnce(Response.json(quota, { status: 401 }))
      await run(handler, path)
      fetchMock.mockResolvedValueOnce(
        new Response(`not json ${KEY}`, { status: 200 }),
      )
      await run(handler, path)
      // Runtime fetch errors can quote the request URL, key included.
      fetchMock.mockImplementationOnce(async (input) => {
        throw new Error(`failed to fetch ${String(input)}`)
      })
      await run(handler, path)
      fetchMock.mockResolvedValueOnce(
        Response.json({ incidents: [], page: {} }),
      )
      await run(handler, path)
    }
    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(upstream(0).searchParams.get('key')).toBe(KEY)
    expect(upstream(5).searchParams.get('apikey')).toBe(KEY)
    for (const body of bodies) expect(body).not.toContain(KEY)
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY)
  })
})

describe('traffic cache lifetime', () => {
  const at = (offset: number) => new Date(now + offset).toUTCString()

  it.each([
    ['max-age=90', '87', null, 'private, max-age=3'],
    ['max-age=90', '95', null, 'no-store'],
    ['max-age=90', '90', null, 'no-store'],
    ['max-age=60', null, at(-45_000), 'private, max-age=15'],
    ['max-age=60', '10', at(-45_000), 'private, max-age=15'],
    ['max-age=60', '50', at(-5_000), 'private, max-age=10'],
    ['max-age=60', null, at(30_000), 'private, max-age=60'],
    ['max-age=60', '-5', 'not a date', 'private, max-age=60'],
    ['max-age=60', '1.5', null, 'private, max-age=60'],
    ['public, max-age=600', '100', null, 'private, max-age=120'],
    ['no-cache', '0', null, 'no-store'],
    ['private', '0', null, 'no-store'],
    [null, '0', null, 'no-store'],
  ])(
    'Cache-Control %s, Age %s, Date %s: %s',
    (cacheControl, age, date, expected) => {
      expect(trafficCacheControl(cacheControl, age, date, now)).toBe(expected)
    },
  )
})

describe('geohash', () => {
  it('matches the reference encoding', () => {
    expect(geohash([10.40744, 57.64911], 11)).toBe('u4pruydqqvj')
    expect(geohash([-122.4194, 37.7749], 5)).toBe('9q8yy')
  })
})
