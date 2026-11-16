import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EVENT_RADIUS,
  MAX_TRAFFIC_SOURCES,
  TRAFFIC_RADIUS,
  TRAFFIC_SPACING,
  eventSources,
  fetchEvents,
  fetchTraffic,
  trafficSources,
} from './meeting-live'
import type { LiveEvent, TrafficIncident } from './meeting-live-server'
import {
  distanceBetween,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

const bounds: MeetingNetwork['bounds'] = [-122.45, 37.75, -122.38, 37.8]
const fetched = '2026-11-16T10:00:00.000Z'
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const signal = () => new AbortController().signal

function incident(
  id: string,
  overrides: Partial<TrafficIncident> = {},
): TrafficIncident {
  return {
    id,
    kind: 'jam',
    severity: 0.6,
    delaySeconds: 120,
    description: 'Stationary traffic: Market St to 5th St',
    coordinates: [
      [-122.42, 37.77],
      [-122.41, 37.77],
    ],
    ...overrides,
  }
}

function liveEvent(
  id: string,
  venue: string,
  coordinate: Coordinate,
  name = `Show ${id}`,
): LiveEvent {
  return {
    id,
    name,
    start: '2026-11-16T20:00:00.000Z',
    category: 'Music',
    venue,
    coordinate,
    url: `https://www.ticketmaster.com/event/${id}`,
  }
}

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(Response.json(body, { status }))
}

describe('live layer client', () => {
  it('returns validated incidents and the fetch time', async () => {
    reply(200, {
      provider: 'tomtom',
      fetched,
      incidents: [
        incident('a'),
        { ...incident('bad-kind'), kind: 'meteor' },
        { ...incident('bad-severity'), severity: 3 },
        { ...incident('bad-point'), coordinates: [[-122.42, 'north']] },
        incident('b', { kind: 'closure', severity: 1, delaySeconds: null }),
      ],
    })
    const result = await fetchTraffic(bounds, signal())
    expect(result).toEqual({
      kind: 'ready',
      fetched,
      items: [
        incident('a'),
        incident('b', { kind: 'closure', severity: 1, delaySeconds: null }),
      ],
    })
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://site.test')
    expect(url.searchParams.get('bounds')).toBe(bounds.join(','))
  })

  it('returns events only for the window it asked for', async () => {
    const venue = liveEvent('e1', 'Chase Center', [-122.3874, 37.768])
    reply(200, { provider: 'ticketmaster', fetched, window: 'week', events: [venue] })
    expect(await fetchEvents(bounds, 'week', signal())).toEqual({
      kind: 'ready',
      fetched,
      items: [venue],
    })
    reply(200, { provider: 'ticketmaster', fetched, window: 'week', events: [venue] })
    expect(await fetchEvents(bounds, 'day', signal())).toMatchObject({
      kind: 'error',
      reason: 'site',
    })
  })

  it.each([
    [503, { error: 'not_configured' }, { kind: 'unconfigured' }],
    [429, { error: 'rate_limited' }, { kind: 'error', reason: 'rate_limited' }],
    [502, { error: 'upstream', status: 500 }, { kind: 'error', reason: 'provider' }],
    [502, { error: 'upstream', status: null }, { kind: 'error', reason: 'provider' }],
    [503, { error: 'overloaded' }, { kind: 'error', reason: 'site' }],
    [403, { error: 'forbidden' }, { kind: 'error', reason: 'site' }],
    [200, { provider: 'ticketmaster', fetched, incidents: [] }, { kind: 'error', reason: 'site' }],
    [200, { provider: 'tomtom', fetched: 'yesterday', incidents: [] }, { kind: 'error', reason: 'site' }],
  ])('maps status %i %j for both layers', async (status, body, expected) => {
    reply(status, body)
    expect(await fetchTraffic(bounds, signal())).toMatchObject(expected)
    reply(status, body)
    const events = await fetchEvents(bounds, 'day', signal())
    if (status !== 200) expect(events).toMatchObject(expected)
  })

  it('shows the server’s explanation for a rejected area', async () => {
    reply(400, { error: 'invalid_request', message: 'Choose a smaller area.' })
    expect(await fetchTraffic(bounds, signal())).toEqual({
      kind: 'error',
      reason: 'site',
      message: 'Choose a smaller area.',
    })
  })

  it('reports connection failures separately from provider trouble', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const offline = await fetchTraffic(bounds, signal())
    reply(429, { error: 'rate_limited' })
    const busy = await fetchTraffic(bounds, signal())
    reply(502, { error: 'upstream', status: 500 })
    const broken = await fetchTraffic(bounds, signal())
    expect(offline).toMatchObject({ kind: 'error', reason: 'network' })
    const messages = [offline, busy, broken].map((result) =>
      result.kind === 'error' ? result.message : '',
    )
    expect(messages.every(Boolean)).toBe(true)
    expect(new Set(messages).size).toBe(3)
  })

  it('rejects instead of reporting an error when the caller aborts', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementationOnce((_, init) => {
      const { promise, reject } = Promise.withResolvers<Response>()
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      )
      return promise
    })
    const pending = fetchTraffic(bounds, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('traffic sources', () => {
  it('samples each incident about every 200 m as avoid-sources', () => {
    const line = incident('long', {
      coordinates: [
        [-122.42, 37.77],
        [-122.41, 37.77],
        [-122.41, 37.775],
      ],
    })
    const sources = trafficSources([line])
    const points = sources.map((source) => source.coordinate)
    const length =
      distanceBetween([-122.42, 37.77], [-122.41, 37.77]) +
      distanceBetween([-122.41, 37.77], [-122.41, 37.775])
    expect(points[0]).toEqual([-122.42, 37.77])
    expect(points.at(-1)?.[0]).toBeCloseTo(-122.41, 9)
    expect(points.at(-1)?.[1]).toBeCloseTo(37.775, 9)
    expect(points).toHaveLength(Math.ceil(length / TRAFFIC_SPACING) + 1)
    for (let i = 1; i < points.length; i++)
      expect(distanceBetween(points[i - 1], points[i])).toBeLessThanOrEqual(
        TRAFFIC_SPACING + 1e-6,
      )
    for (const source of sources) {
      expect(source.kind).toBe('traffic')
      expect(source.radius).toBe(TRAFFIC_RADIUS)
      expect(source.weight).toBeLessThan(0)
      expect(source.weight).toBeGreaterThanOrEqual(-1)
    }
  })

  it('turns a point incident into one source at that point', () => {
    const sources = trafficSources([
      incident('crash', { kind: 'accident', coordinates: [[-122.4, 37.78]] }),
    ])
    expect(sources).toHaveLength(1)
    expect(sources[0].coordinate).toEqual([-122.4, 37.78])
  })

  it('weights closures strongest and more severe incidents more', () => {
    const weight = (item: TrafficIncident) => trafficSources([item])[0].weight
    const point: Coordinate[] = [[-122.4, 37.78]]
    const kinds = ['closure', 'accident', 'roadworks', 'jam', 'other'] as const
    const atSeverity = kinds.map((kind) =>
      weight(incident(kind, { kind, severity: 0.8, coordinates: point })),
    )
    expect(atSeverity[0]).toBe(Math.min(...atSeverity))
    expect(weight(incident('closed', { kind: 'closure', severity: 1, coordinates: point }))).toBe(-1)
    expect(weight(incident('major', { severity: 0.85, coordinates: point }))).toBeLessThan(
      weight(incident('minor', { severity: 0.4, coordinates: point })),
    )
    expect(trafficSources([incident('none', { severity: 0 })])).toEqual([])
  })

  it('keeps only the most severe sources when there are too many', () => {
    // 50 incidents of ~2 km each make far more than 400 samples.
    const incidents = Array.from({ length: 50 }, (_, i) =>
      incident(`i${i}`, {
        severity: ((i * 37) % 50) / 50 + 0.01,
        coordinates: [
          [-122.44, 37.76 + i * 0.0005],
          [-122.417, 37.76 + i * 0.0005],
        ],
      }),
    )
    const sources = trafficSources(incidents)
    expect(sources).toHaveLength(MAX_TRAFFIC_SOURCES)
    const kept = new Set(sources.map((source) => source.id.split(':')[1]))
    const severity = new Map(incidents.map((item) => [item.id, item.severity]))
    const weakestKept = Math.min(...[...kept].map((id) => severity.get(id) ?? 0))
    for (const item of incidents)
      if (!kept.has(item.id)) expect(item.severity).toBeLessThanOrEqual(weakestKept)
    const weights = sources.map((source) => source.weight)
    expect(weights).toEqual([...weights].sort((a, b) => a - b))
  })

  it('gives the same unique ids for the same incidents', () => {
    const incidents = [
      incident('a'),
      incident('b', { kind: 'roadworks', severity: 0.4 }),
    ]
    const first = trafficSources(incidents).map((source) => source.id)
    expect(trafficSources(structuredClone(incidents)).map((source) => source.id)).toEqual(first)
    expect(new Set(first).size).toBe(first.length)
  })
})

describe('event sources', () => {
  const arena: Coordinate = [-122.3874, 37.768]
  const park: Coordinate = [-122.4194, 37.7749]
  const hall: Coordinate = [-122.4206, 37.7786]
  const stadium: Coordinate = [-122.3893, 37.7786]
  const events = [
    liveEvent('a1', 'Chase Center', arena, 'Warriors vs Lakers'),
    liveEvent('a2', 'Chase Center', arena, 'Valkyries vs Sky'),
    liveEvent('a3', 'Chase Center', arena, 'Concert'),
    liveEvent('p1', 'Civic Center Plaza', park, 'Night market'),
    liveEvent('h1', 'Davies Symphony Hall', hall, 'Symphony'),
    liveEvent('h2', 'Davies Symphony Hall', hall, 'Symphony'),
    ...Array.from({ length: 5 }, (_, i) =>
      liveEvent(`s${i}`, 'Oracle Park', stadium, `Game ${i}`),
    ),
  ]

  it('makes one source per venue, stronger with more events, up to 1', () => {
    const sources = eventSources(events, 1)
    expect(sources).toHaveLength(4)
    const strength = (venue: string) =>
      sources.find((source) => source.label.startsWith(venue))?.weight ?? NaN
    expect(strength('Civic Center Plaza')).toBeGreaterThan(0)
    expect(strength('Civic Center Plaza')).toBeLessThan(strength('Davies Symphony Hall'))
    expect(strength('Davies Symphony Hall')).toBeLessThan(strength('Chase Center'))
    expect(strength('Chase Center')).toBe(1)
    expect(strength('Oracle Park')).toBe(1)
    for (const source of sources) {
      expect(source.kind).toBe('event')
      expect(source.radius).toBe(EVENT_RADIUS)
    }
  })

  it('repels with the same strength when steering away', () => {
    const attract = eventSources(events, 1)
    const repel = eventSources(events, -1)
    expect(repel.map((source) => source.weight)).toEqual(
      attract.map((source) => -source.weight),
    )
    expect(repel.every((source) => source.weight < 0)).toBe(true)
  })

  it('labels a venue with its events', () => {
    const label = eventSources(events, 1).find((source) =>
      source.label.startsWith('Chase Center'),
    )?.label
    expect(label).toContain('Warriors vs Lakers')
    expect(label).toContain('Valkyries vs Sky')
    const hallLabel = eventSources(events, 1).find((source) =>
      source.label.startsWith('Davies'),
    )?.label
    expect(hallLabel?.match(/Symphony/g)).toHaveLength(2) // venue and one show
  })

  it('keeps ids stable for the same events in any order', () => {
    const ids = eventSources(events, 1).map((source) => source.id)
    expect(new Set(ids).size).toBe(ids.length)
    const reversed = eventSources([...events].reverse(), 1).map((source) => source.id)
    expect([...reversed].sort()).toEqual([...ids].sort())
    expect(eventSources(events, -1).map((source) => source.id)).toEqual(ids)
  })
})
