/**
 * Browser client for the live layers (`/api/meeting/traffic` and
 * `/api/meeting/events`) and their conversion into influence sources.
 * Only the study area's bounds leave the page; never starting locations.
 */
import type { InfluenceSource } from './meeting-influence'
import type {
  EventWindow,
  IncidentKind,
  LiveEvent,
  TrafficIncident,
} from './meeting-live-server'
import {
  distanceBetween,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

export type LiveErrorReason = 'rate_limited' | 'provider' | 'network' | 'site'

export type LiveResult<T> =
  | { kind: 'ready'; items: T[]; fetched: string }
  /** The site has no key for this provider. */
  | { kind: 'unconfigured' }
  | { kind: 'error'; reason: LiveErrorReason; message: string }

/** Metres between traffic samples along an incident. */
export const TRAFFIC_SPACING = 200
export const TRAFFIC_RADIUS = 250
export const MAX_TRAFFIC_SOURCES = 400
export const EVENT_RADIUS = 400

const CLIENT_TIMEOUT = 20_000
const incidentKinds: readonly IncidentKind[] = [
  'jam',
  'closure',
  'roadworks',
  'accident',
  'other',
]
/** How strongly each kind should push walkers away, before severity. */
const KIND_WEIGHT: Record<IncidentKind, number> = {
  closure: 1,
  accident: 0.85,
  roadworks: 0.8,
  jam: 0.7,
  other: 0.5,
}

function parseCoordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [longitude, latitude] = value
  return typeof longitude === 'number' &&
    typeof latitude === 'number' &&
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    Math.abs(longitude) <= 180 &&
    Math.abs(latitude) <= 90
    ? [longitude, latitude]
    : null
}

function parseTime(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null
}

function parseIncident(value: unknown): TrafficIncident | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('kind' in value) ||
    !('severity' in value) ||
    !('delaySeconds' in value) ||
    !('description' in value) ||
    !('coordinates' in value)
  )
    return null
  const { id, severity, delaySeconds, description } = value
  const kind = incidentKinds.find((item) => item === value.kind)
  if (
    typeof id !== 'string' ||
    !id ||
    !kind ||
    typeof severity !== 'number' ||
    !(severity >= 0 && severity <= 1) ||
    (delaySeconds !== null &&
      (typeof delaySeconds !== 'number' ||
        !Number.isFinite(delaySeconds) ||
        delaySeconds < 0)) ||
    typeof description !== 'string' ||
    !Array.isArray(value.coordinates) ||
    !value.coordinates.length
  )
    return null
  const coordinates: Coordinate[] = []
  for (const point of value.coordinates) {
    const coordinate = parseCoordinate(point)
    if (!coordinate) return null
    coordinates.push(coordinate)
  }
  return { id, kind, severity, delaySeconds, description, coordinates }
}

function parseEvent(value: unknown): LiveEvent | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('name' in value) ||
    !('start' in value) ||
    !('category' in value) ||
    !('venue' in value) ||
    !('coordinate' in value) ||
    !('url' in value)
  )
    return null
  const { id, name, category, venue, url } = value
  const start = value.start === null ? null : parseTime(value.start)
  const coordinate = parseCoordinate(value.coordinate)
  if (
    typeof id !== 'string' ||
    !id ||
    typeof name !== 'string' ||
    !name ||
    (value.start !== null && start === null) ||
    typeof category !== 'string' ||
    typeof venue !== 'string' ||
    !venue ||
    !coordinate ||
    (url !== null && (typeof url !== 'string' || !/^https?:\/\//i.test(url)))
  )
    return null
  return { id, name, start, category, venue, coordinate, url }
}

/** Our routes' payload: provider tag, fetch time, and a list of valid items. */
function parsePayload<T>(
  payload: unknown,
  provider: string,
  list: string,
  parseItem: (value: unknown) => T | null,
): { items: T[]; fetched: string } | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('provider' in payload) ||
    payload.provider !== provider ||
    !('fetched' in payload) ||
    !(list in payload)
  )
    return null
  const fetched = parseTime(payload.fetched)
  const values: unknown = Reflect.get(payload, list)
  if (!fetched || !Array.isArray(values)) return null
  const items: T[] = []
  for (const value of values) {
    const item = parseItem(value)
    if (item) items.push(item)
  }
  return { items, fetched }
}

async function requestLayer<T>(
  url: string,
  provider: string,
  parse: (payload: unknown) => { items: T[]; fetched: string } | null,
  signal: AbortSignal,
): Promise<LiveResult<T>> {
  signal.throwIfAborted()
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(CLIENT_TIMEOUT)]),
    })
  } catch {
    signal.throwIfAborted()
    return {
      kind: 'error',
      reason: 'network',
      message: 'Couldn’t reach this site. Check your connection, then retry.',
    }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  signal.throwIfAborted()
  const error =
    typeof payload === 'object' && payload !== null && 'error' in payload
      ? payload.error
      : undefined
  if (response.status === 200) {
    const parsed = parse(payload)
    if (parsed) return { kind: 'ready', ...parsed }
  } else if (response.status === 503 && error === 'not_configured') {
    return { kind: 'unconfigured' }
  } else if (response.status === 429) {
    return {
      kind: 'error',
      reason: 'rate_limited',
      message: `${provider} is getting too many requests. Wait a minute, then retry.`,
    }
  } else if (response.status === 502 && error === 'upstream') {
    return {
      kind: 'error',
      reason: 'provider',
      message: `${provider} isn’t responding properly right now. Retry in a moment.`,
    }
  } else if (
    response.status === 400 &&
    typeof payload === 'object' &&
    payload !== null &&
    'message' in payload &&
    typeof payload.message === 'string' &&
    payload.message.trim()
  ) {
    return { kind: 'error', reason: 'site', message: payload.message.trim() }
  }
  return {
    kind: 'error',
    reason: 'site',
    message: `This site couldn’t load ${provider} data. Retry later.`,
  }
}

/** Current incidents in the area, from TomTom via this site. */
export function fetchTraffic(
  bounds: MeetingNetwork['bounds'],
  signal: AbortSignal,
): Promise<LiveResult<TrafficIncident>> {
  const query = new URLSearchParams({ bounds: bounds.join(',') })
  return requestLayer(
    `/api/meeting/traffic?${query}`,
    'TomTom',
    (payload) => parsePayload(payload, 'tomtom', 'incidents', parseIncident),
    signal,
  )
}

/** Upcoming events in the area, from Ticketmaster via this site. */
export function fetchEvents(
  bounds: MeetingNetwork['bounds'],
  window: EventWindow,
  signal: AbortSignal,
): Promise<LiveResult<LiveEvent>> {
  const query = new URLSearchParams({ bounds: bounds.join(','), window })
  return requestLayer(
    `/api/meeting/events?${query}`,
    'Ticketmaster',
    (payload) =>
      typeof payload === 'object' &&
      payload !== null &&
      'window' in payload &&
      payload.window === window
        ? parsePayload(payload, 'ticketmaster', 'events', parseEvent)
        : null,
    signal,
  )
}

/**
 * Evenly spaced points along a path, no more than `spacing` metres apart,
 * ends included. A path shorter than `spacing` is one point at its middle,
 * so a short incident counts once.
 */
function* samplePath(
  points: Coordinate[],
  spacing: number,
): Generator<Coordinate> {
  const lengths = points
    .slice(1)
    .map((point, index) => distanceBetween(points[index], point))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (!(total > 0)) {
    yield points[0]
    return
  }
  // Zero steps: the single middle sample.
  const steps = total < spacing ? 0 : Math.ceil(total / spacing)
  let segment = 0
  let travelled = 0
  for (let step = 0; step <= steps; step++) {
    const target = steps === 0 ? total / 2 : (total * step) / steps
    while (
      segment < lengths.length - 1 &&
      travelled + lengths[segment] < target
    ) {
      travelled += lengths[segment]
      segment++
    }
    const t =
      lengths[segment] > 0
        ? Math.min(1, (target - travelled) / lengths[segment])
        : 0
    const [a, b] = [points[segment], points[segment + 1]]
    yield [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
}

/**
 * Avoid-sources sampled about every 200 m along each incident, weighted by
 * severity and kind (closures strongest). Incidents are sampled strongest
 * first (ties by id) and sampling stops at 400 sources, so the weakest are
 * left out without sampling them.
 */
export function trafficSources(
  incidents: TrafficIncident[],
): InfluenceSource[] {
  const ranked = incidents
    .map((incident) => ({
      incident,
      strength: Math.min(
        1,
        Math.max(0, incident.severity) * KIND_WEIGHT[incident.kind],
      ),
    }))
    .filter(
      ({ incident, strength }) =>
        strength > 0 && incident.coordinates.length > 0,
    )
    .sort(
      (a, b) =>
        b.strength - a.strength ||
        (a.incident.id < b.incident.id
          ? -1
          : a.incident.id > b.incident.id
            ? 1
            : 0),
    )
  const sources: InfluenceSource[] = []
  for (const { incident, strength } of ranked) {
    let index = 0
    for (const coordinate of samplePath(
      incident.coordinates,
      TRAFFIC_SPACING,
    )) {
      sources.push({
        id: `traffic:${incident.id}:${index++}`,
        kind: 'traffic',
        label: incident.description,
        coordinate,
        radius: TRAFFIC_RADIUS,
        weight: -strength,
      })
      if (sources.length === MAX_TRAFFIC_SOURCES) return sources
    }
  }
  return sources
}

/** The venue a coordinate belongs to: events this close share one source. */
export function venueKey(coordinate: Coordinate): string {
  return `${coordinate[0].toFixed(5)},${coordinate[1].toFixed(5)}`
}

/**
 * One source per venue. Its strength grows with the number of events there,
 * reaching full strength at three; `polarity` 1 attracts, -1 repels.
 */
export function eventSources(
  events: LiveEvent[],
  polarity: 1 | -1,
): InfluenceSource[] {
  const venues = new Map<
    string,
    { coordinate: Coordinate; venue: string; names: string[]; count: number }
  >()
  for (const event of events) {
    const key = venueKey(event.coordinate)
    const group = venues.get(key)
    if (!group) {
      venues.set(key, {
        coordinate: event.coordinate,
        venue: event.venue,
        names: [event.name],
        count: 1,
      })
      continue
    }
    group.count++
    if (!group.names.includes(event.name)) group.names.push(event.name)
  }
  return [...venues]
    .map(([key, group]): InfluenceSource => {
      const shown = group.names.slice(0, 3).join(', ')
      const more = group.names.length - 3
      return {
        id: `event:${key}`,
        kind: 'event',
        label: `${group.venue}: ${shown}${more > 0 ? ` and ${more} more` : ''}`,
        coordinate: group.coordinate,
        radius: EVENT_RADIUS,
        weight: polarity * Math.min(1, 0.5 + 0.25 * (group.count - 1)),
      }
    })
    .sort(
      (a, b) =>
        Math.abs(b.weight) - Math.abs(a.weight) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
}
