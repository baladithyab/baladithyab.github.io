/**
 * Server side of the meeting-point live layers. The site Worker proxies two
 * keyed providers so their API keys never reach the browser:
 *
 * - TomTom Traffic API, Incident Details v5:
 *   https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-incidents/incident-details/
 * - Ticketmaster Discovery API v2, Event Search:
 *   https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/#search-events-v2
 *
 * Everything here is runtime-agnostic (global `fetch`, optional
 * `caches.default`), so the API routes only pass in the request and env.
 */
import { boundsSizeKm } from './meeting-network'
import {
  distanceBetween,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

export type LiveBounds = MeetingNetwork['bounds']
export type EventWindow = 'day' | 'week'
export type IncidentKind =
  'jam' | 'closure' | 'roadworks' | 'accident' | 'other'

export type TrafficIncident = {
  id: string
  kind: IncidentKind
  /** 0 (negligible) to 1 (road closed). */
  severity: number
  delaySeconds: number | null
  description: string
  coordinates: Coordinate[]
}

export type LiveEvent = {
  id: string
  name: string
  start: string | null
  category: string
  venue: string
  coordinate: Coordinate
  url: string | null
}

export type TrafficPayload = {
  provider: 'tomtom'
  fetched: string
  incidents: TrafficIncident[]
}

export type EventsPayload = {
  provider: 'ticketmaster'
  fetched: string
  window: EventWindow
  events: LiveEvent[]
}

export type LiveErrorBody =
  | { error: 'invalid_request'; message: string }
  | { error: 'forbidden' }
  | { error: 'not_configured' }
  | { error: 'rate_limited' }
  /** `status` is the provider's HTTP status, or null when it never answered. */
  | { error: 'upstream'; status: number | null }

export type LiveEnv = {
  TOMTOM_API_KEY?: string
  TICKETMASTER_API_KEY?: string
}

// Measured after snapping to the events grid (0.01°, whose box also holds the
// traffic grid's), every area the lab loads fits: city squares of up to 12 km,
// the bundled SF preset (14.07 × 12.01 km) and people rectangles of up to
// MAX_LIVE_AREA_KM2 (4,000 km²; at most about 90 km long, or 128 km where the
// 85° clamp shortens the other side). Snapping adds at most about 1.1 km on
// each side, under 8% of 4,000 km². TomTom refuses boxes over 10,000 km².
export const MAX_AREA_KM2 = 4_400
export const MAX_SIDE_KM = 150
export const MAX_INCIDENTS = 300
export const MAX_EVENTS = 200
/** Event Search pages read per area: its circle can fill a page with venues outside the box. */
export const MAX_EVENT_PAGES = 3
/** Upper bound on TomTom's own cache lifetime that we pass on to the browser. */
export const TRAFFIC_MAX_AGE = 120
export const EVENTS_MAX_AGE = 30 * 60

const TOMTOM_URL = 'https://api.tomtom.com/traffic/services/5/incidentDetails'
const TICKETMASTER_URL = 'https://app.ticketmaster.com/discovery/v2/events.json'
// The documented field selector, minus TMC/ACI data the lab does not use.
const TOMTOM_FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},from,to,delay}}}'
const UPSTREAM_TIMEOUT = 8_000
/** Shared server budget across paginated Ticketmaster calls, inside the 20 s client timeout. */
const EVENTS_ROUTE_TIMEOUT = 15_000
const MAX_UPSTREAM_BYTES = 6 * 1024 * 1024
const CACHE_VERSION = '2'
const WINDOW_HOURS: Record<EventWindow, number> = { day: 24, week: 7 * 24 }
// Decimal places of the outward snap. Traffic asks TomTom for 0.001° (about
// 110 m) around the area; events share one cached search per 0.01° (about
// 1.1 km), so small pans and zooms reuse it. Responses hold only the area.
const TRAFFIC_SNAP_DECIMALS = 3
const EVENTS_SNAP_DECIMALS = 2

// TomTom iconCategory values, as documented for IncidentProperties.
const CATEGORY_KIND: Partial<Record<number, IncidentKind>> = {
  1: 'accident',
  6: 'jam',
  7: 'closure',
  8: 'closure',
  9: 'roadworks',
}
const CATEGORY_NAME: Partial<Record<number, string>> = {
  0: 'Unknown incident',
  1: 'Accident',
  2: 'Fog',
  3: 'Dangerous conditions',
  4: 'Rain',
  5: 'Ice',
  6: 'Traffic jam',
  7: 'Lane closed',
  8: 'Road closed',
  9: 'Road works',
  10: 'Wind',
  11: 'Flooding',
  14: 'Broken-down vehicle',
}
const ROAD_CLOSED = 8
// magnitudeOfDelay: 0 unknown, 1 minor, 2 moderate, 3 major,
// 4 undefined (closures and other indefinite delays).
const MAGNITUDE_SEVERITY = [0.3, 0.4, 0.6, 0.85, 0.75]

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }
type Endpoint = 'traffic' | 'events'
type Failure = {
  status: number | null
  reason:
    | 'network'
    | 'timeout'
    | 'http'
    | 'too_large'
    | 'invalid_json'
    | 'invalid_shape'
}

/** `value[name]` when `value` is an object holding that key, else undefined. */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined
}

/** Trimmed single-line provider text, cut to `limit` characters. */
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > limit
    ? `${trimmed.slice(0, limit - 1).trimEnd()}…`
    : trimmed
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function inside(
  [longitude, latitude]: Coordinate,
  [west, south, east, north]: LiveBounds,
): boolean {
  return (
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  )
}

/**
 * Parses `west,south,east,north` between 85° south and 85° north. The area,
 * snapped outward to the coarser 0.01° events grid, may cover at most
 * `MAX_AREA_KM2` and `MAX_SIDE_KM` on a side, so both routes accept the same
 * areas and cannot serve as a general proxy.
 */
export function parseBounds(value: string | null): Parsed<LiveBounds> {
  if (value === null || !value.trim())
    return {
      ok: false,
      message: 'Add the area as bounds=west,south,east,north.',
    }
  if (value.length > 200)
    return { ok: false, message: 'The area bounds are too long.' }
  const parts = value.split(',')
  if (parts.length !== 4)
    return {
      ok: false,
      message: 'The area needs four numbers: west, south, east, north.',
    }
  const numbers = parts.map((part) =>
    /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(part)
      ? Number(part)
      : NaN,
  )
  if (!numbers.every(Number.isFinite))
    return { ok: false, message: 'Every area bound must be a finite number.' }
  const [west, south, east, north] = numbers
  if (Math.abs(west) > 180 || Math.abs(east) > 180)
    return { ok: false, message: 'Longitudes must be between -180 and 180.' }
  if (Math.abs(south) > 85 || Math.abs(north) > 85)
    return { ok: false, message: 'Latitudes must be between -85 and 85.' }
  if (west >= east || south >= north)
    return {
      ok: false,
      message: 'West must be less than east, and south less than north.',
    }
  const { widthKm, heightKm, areaKm2 } = boundsSizeKm(
    snapBounds([west, south, east, north], EVENTS_SNAP_DECIMALS),
  )
  if (widthKm > MAX_SIDE_KM || heightKm > MAX_SIDE_KM || areaKm2 > MAX_AREA_KM2)
    return {
      ok: false,
      message: `Choose an area of at most ${MAX_AREA_KM2.toLocaleString('en')} km² and ${MAX_SIDE_KM} km on a side.`,
    }
  return { ok: true, value: [west, south, east, north] }
}

/**
 * Rounds outward to `decimals` places, 0.001° unless told otherwise, so
 * nearby requests share one provider query and cache entry.
 */
export function snapBounds(
  [west, south, east, north]: LiveBounds,
  decimals = TRAFFIC_SNAP_DECIMALS,
): LiveBounds {
  const scale = 10 ** decimals
  // The epsilon keeps values already on the grid from moving a whole step.
  const down = (value: number) => Math.floor(value * scale + 1e-6) / scale
  const up = (value: number) => Math.ceil(value * scale - 1e-6) / scale
  return [
    Math.max(-180, down(west)),
    Math.max(-85, down(south)),
    Math.min(180, up(east)),
    Math.min(85, up(north)),
  ]
}

export function parseWindow(value: string | null): Parsed<EventWindow> {
  if (value === 'day' || value === 'week') return { ok: true, value }
  return {
    ok: false,
    message: 'Choose window=day (next 24 hours) or window=week (next 7 days).',
  }
}

/** Refuses calls from other sites: the routes exist only for this site's lab. */
export function isSameSiteRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return false
  const origin = request.headers.get('origin')
  return origin === null || origin === new URL(request.url).origin
}

const geohashAlphabet = '0123456789bcdefghjkmnpqrstuvwxyz'

/** Standard base-32 geohash, as Ticketmaster's `geoPoint` filter expects. */
export function geohash(
  [longitude, latitude]: Coordinate,
  precision = 9,
): string {
  const range = { west: -180, east: 180, south: -90, north: 90 }
  let hash = ''
  let bits = 0
  let value = 0
  let longitudeBit = true
  while (hash.length < precision) {
    value <<= 1
    if (longitudeBit) {
      const middle = (range.west + range.east) / 2
      if (longitude >= middle) {
        value |= 1
        range.west = middle
      } else range.east = middle
    } else {
      const middle = (range.south + range.north) / 2
      if (latitude >= middle) {
        value |= 1
        range.south = middle
      } else range.north = middle
    }
    longitudeBit = !longitudeBit
    if (++bits === 5) {
      hash += geohashAlphabet[value]
      bits = 0
      value = 0
    }
  }
  return hash
}

function parseCoordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const [longitude, latitude] = value
  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  )
    return null
  return [longitude, latitude]
}

type ClippedSegment = {
  start: Coordinate
  end: Coordinate
  /** The segment starts outside the box (`t0 > 0`). */
  enters: boolean
  /** The segment ends outside the box (`t1 < 1`). */
  leaves: boolean
}

/** Liang-Barsky clip of one segment against the box. */
function clipSegment(
  a: Coordinate,
  b: Coordinate,
  [west, south, east, north]: LiveBounds,
): ClippedSegment | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a[0] - west],
    [dx, east - a[0]],
    [-dy, a[1] - south],
    [dy, north - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  // Clamped so rounding never leaves a boundary point just outside the box.
  const at = (t: number): Coordinate => [
    Math.min(east, Math.max(west, a[0] + t * dx)),
    Math.min(north, Math.max(south, a[1] + t * dy)),
  ]
  return {
    start: t0 === 0 ? a : at(t0),
    end: t1 === 1 ? b : at(t1),
    enters: t0 > 0,
    leaves: t1 < 1,
  }
}

/** The parts of a line inside the bounds, each a continuous run. */
function clipLine(points: Coordinate[], bounds: LiveBounds): Coordinate[][] {
  const parts: Coordinate[][] = []
  let current: Coordinate[] | null = null
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1], points[i], bounds)
    if (!clipped) {
      if (current) parts.push(current)
      current = null
      continue
    }
    if (!current || clipped.enters) {
      if (current) parts.push(current)
      current = [clipped.start]
    }
    current.push(clipped.end)
    if (clipped.leaves) {
      parts.push(current)
      current = null
    }
  }
  if (current) parts.push(current)
  return parts.map((part) =>
    part.filter(
      (point, index) =>
        index === 0 ||
        point[0] !== part[index - 1][0] ||
        point[1] !== part[index - 1][1],
    ),
  )
}

/** Clipped parts of a GeoJSON Point or LineString; null when malformed. */
function incidentGeometry(
  geometry: unknown,
  bounds: LiveBounds,
): Coordinate[][] | null {
  const type = field(geometry, 'type')
  const coordinates = field(geometry, 'coordinates')
  if (type === 'Point') {
    const point = parseCoordinate(coordinates)
    if (!point) return null
    return inside(point, bounds) ? [[point]] : []
  }
  if (type !== 'LineString' || !Array.isArray(coordinates)) return null
  const points: Coordinate[] = []
  for (const value of coordinates) {
    const point = parseCoordinate(value)
    if (!point) return null
    points.push(point)
  }
  return points.length < 2 ? null : clipLine(points, bounds)
}

function incidentDescription(properties: unknown, category: number): string {
  const events = field(properties, 'events')
  const descriptions: string[] = []
  if (Array.isArray(events))
    for (const event of events) {
      const description = text(field(event, 'description'), 160)
      if (description && !descriptions.includes(description))
        descriptions.push(description)
    }
  const summary =
    descriptions.join('; ') || CATEGORY_NAME[category] || 'Unknown incident'
  const from = text(field(properties, 'from'), 100)
  const to = text(field(properties, 'to'), 100)
  const place = from && to && from !== to ? `${from} to ${to}` : from || to
  return text(place ? `${summary}: ${place}` : summary, 300)
}

/** One TomTom incident clipped to the bounds: zero, one or several parts. */
function parseIncident(value: unknown, bounds: LiveBounds): TrafficIncident[] {
  const properties = field(value, 'properties')
  const id = field(properties, 'id')
  const category = field(properties, 'iconCategory')
  const magnitude = field(properties, 'magnitudeOfDelay')
  const events = field(properties, 'events')
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    id.length > 128 ||
    typeof category !== 'number' ||
    !Number.isInteger(category) ||
    category < 0 ||
    typeof magnitude !== 'number' ||
    !Number.isInteger(magnitude) ||
    magnitude < 0 ||
    magnitude >= MAGNITUDE_SEVERITY.length ||
    (events !== undefined && events !== null && !Array.isArray(events))
  )
    return []
  const parts = incidentGeometry(field(value, 'geometry'), bounds)
  if (!parts) return []
  const delay = field(properties, 'delay')
  const incident = {
    kind: CATEGORY_KIND[category] ?? 'other',
    severity: category === ROAD_CLOSED ? 1 : MAGNITUDE_SEVERITY[magnitude],
    // TomTom does not compute delay for road closures; its 0 there means
    // "not applicable", not "no delay".
    delaySeconds:
      category !== ROAD_CLOSED &&
      typeof delay === 'number' &&
      Number.isInteger(delay) &&
      delay >= 0
        ? delay
        : null,
    description: incidentDescription(properties, category),
  } satisfies Omit<TrafficIncident, 'id' | 'coordinates'>
  return parts.map((coordinates, index) => ({
    id: index === 0 ? id.trim() : `${id.trim()}~${index}`,
    ...incident,
    coordinates,
  }))
}

/**
 * Normalises an Incident Details body, most severe first. `null` when the
 * root is not the documented shape; malformed incidents are dropped.
 */
export function normalizeTraffic(
  payload: unknown,
  bounds: LiveBounds,
): TrafficIncident[] | null {
  const items = field(payload, 'incidents')
  if (!Array.isArray(items)) return null
  const seen = new Set<string>()
  const incidents: TrafficIncident[] = []
  for (const item of items)
    for (const incident of parseIncident(item, bounds)) {
      if (seen.has(incident.id)) continue
      seen.add(incident.id)
      incidents.push(incident)
    }
  return incidents
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        (b.delaySeconds ?? -1) - (a.delaySeconds ?? -1) ||
        compare(a.id, b.id),
    )
    .slice(0, MAX_INCIDENTS)
}

/** Ticketmaster sends venue coordinates as decimal strings. */
function parseDegrees(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)
        ? Number(value)
        : NaN
  return Number.isFinite(number) ? number : null
}

function parseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null
  } catch {
    return null
  }
}

function eventCategory(classifications: unknown): string {
  if (!Array.isArray(classifications)) return ''
  const primary =
    classifications.find((item) => field(item, 'primary') === true) ??
    classifications[0]
  for (const level of ['segment', 'genre']) {
    const name = text(field(field(primary, level), 'name'), 60)
    // Ticketmaster labels missing classification levels "Undefined".
    if (name && name !== 'Undefined') return name
  }
  return ''
}

function parseEvent(value: unknown, bounds: LiveBounds): LiveEvent | null {
  const id = field(value, 'id')
  const name = text(field(value, 'name'), 200)
  if (typeof id !== 'string' || !id.trim() || id.length > 128 || !name)
    return null
  const dates = field(value, 'dates')
  const status = field(field(dates, 'status'), 'code')
  if (status === 'canceled' || status === 'cancelled' || status === 'postponed')
    return null
  const venues = field(field(value, '_embedded'), 'venues')
  const venue = Array.isArray(venues) ? venues[0] : undefined
  const venueName = text(field(venue, 'name'), 120)
  const location = field(venue, 'location')
  const longitude = parseDegrees(field(location, 'longitude'))
  const latitude = parseDegrees(field(location, 'latitude'))
  if (!venueName || longitude === null || latitude === null) return null
  const coordinate: Coordinate = [longitude, latitude]
  if (!inside(coordinate, bounds)) return null
  const start = field(field(dates, 'start'), 'dateTime')
  const startTime = typeof start === 'string' ? Date.parse(start) : NaN
  return {
    id: id.trim(),
    name,
    start: Number.isFinite(startTime)
      ? new Date(startTime).toISOString()
      : null,
    category: eventCategory(field(value, 'classifications')),
    venue: venueName,
    coordinate,
    url: parseUrl(field(value, 'url')),
  }
}

/**
 * The raw events of one Event Search page. `null` when the root is not the
 * documented shape.
 */
function eventItems(payload: unknown): unknown[] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const embedded = field(payload, '_embedded')
  const page = field(payload, 'page')
  // Searches without results carry only `page` and `_links`.
  const items =
    embedded === undefined
      ? typeof page === 'object' && page !== null
        ? []
        : null
      : field(embedded, 'events')
  return Array.isArray(items) ? items : null
}

/** One of our own normalised events, as read back from the edge cache. */
function isLiveEvent(value: unknown): value is LiveEvent {
  const start = field(value, 'start')
  const coordinate = field(value, 'coordinate')
  const url = field(value, 'url')
  return (
    typeof field(value, 'id') === 'string' &&
    typeof field(value, 'name') === 'string' &&
    (start === null || typeof start === 'string') &&
    typeof field(value, 'category') === 'string' &&
    typeof field(value, 'venue') === 'string' &&
    Array.isArray(coordinate) &&
    coordinate.length === 2 &&
    parseCoordinate(coordinate) !== null &&
    (url === null || typeof url === 'string')
  )
}

function respond(
  body: TrafficPayload | EventsPayload | LiveErrorBody,
  status: number,
  cacheControl = 'no-store',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * TomTom's terms (§11.4) allow caching results only in clients, only when
 * the result carries cache headers, and never past their max-age. So the
 * browser may keep traffic for what is left of TomTom's max-age, at most two
 * minutes. The time already spent in caches is the larger of `Age` and the
 * time since `Date`; a `Date` in the future adds nothing.
 */
export function trafficCacheControl(
  upstreamCacheControl: string | null,
  ageHeader: string | null,
  dateHeader: string | null,
  now: number,
  elapsedSeconds = 0,
): string {
  if (
    !upstreamCacheControl ||
    /(^|[\s,])(no-store|no-cache)([\s,=]|$)/i.test(upstreamCacheControl)
  )
    return 'no-store'
  const match = /(?:^|[\s,])max-age\s*=\s*"?(\d+)"?/i.exec(upstreamCacheControl)
  if (!match) return 'no-store'
  const delay =
    Number.isFinite(elapsedSeconds) && elapsedSeconds > 0
      ? Math.ceil(elapsedSeconds)
      : 0
  const age =
    ageHeader !== null && /^\s*\d+\s*$/.test(ageHeader)
      ? Number(ageHeader) + delay
      : 0
  const date = dateHeader === null ? NaN : Date.parse(dateHeader)
  const apparentAge =
    Number.isFinite(date) && date < now ? Math.floor((now - date) / 1000) : 0
  const remaining = Number(match[1]) - Math.max(age, apparentAge)
  return remaining > 0
    ? `private, max-age=${Math.min(TRAFFIC_MAX_AGE, remaining)}`
    : 'no-store'
}

async function readLimitedJson(
  response: Response,
): Promise<{ ok: true; value: unknown } | Failure> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { status: response.status, reason: 'too_large' }
  }
  if (!response.body) return { status: response.status, reason: 'invalid_json' }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > MAX_UPSTREAM_BYTES) {
      await reader.cancel().catch(() => undefined)
      return { status: response.status, reason: 'too_large' }
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  body += decoder.decode()
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { status: response.status, reason: 'invalid_json' }
  }
}

type Upstream = {
  ok: true
  value: unknown
  cacheControl: string | null
  age: string | null
  date: string | null
}

/**
 * Calls a fixed provider URL. Failures are reduced to a status and a reason
 * code, because provider bodies and runtime error messages can echo the key.
 */
async function callUpstream(
  url: URL,
  timeoutMs = UPSTREAM_TIMEOUT,
): Promise<Upstream | Failure> {
  if (timeoutMs <= 0) return { status: null, reason: 'timeout' }
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
  } catch {
    return { status: null, reason: signal.aborted ? 'timeout' : 'network' }
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    return { status: response.status, reason: 'http' }
  }
  try {
    const body = await readLimitedJson(response)
    return 'ok' in body
      ? {
          ...body,
          cacheControl: response.headers.get('cache-control'),
          age: response.headers.get('age'),
          date: response.headers.get('date'),
        }
      : body
  } catch {
    return {
      status: response.status,
      reason: signal.aborted ? 'timeout' : 'network',
    }
  }
}

/** `page` is the Event Search page that failed, when there are several. */
function upstreamFailure(
  endpoint: Endpoint,
  bounds: LiveBounds,
  failure: Failure,
  page?: number,
): Response {
  // One structured line per failure for Workers observability. Never log the
  // URL or provider body: both can hold the key.
  console.warn({
    message: 'meeting live layer upstream failure',
    endpoint,
    provider: endpoint === 'traffic' ? 'tomtom' : 'ticketmaster',
    status: failure.status,
    reason: failure.reason,
    bounds: bounds.join(','),
    ...(page === undefined ? {} : { page }),
  })
  return failure.status === 429
    ? respond({ error: 'rate_limited' }, 429)
    : respond({ error: 'upstream', status: failure.status }, 502)
}

function isCache(value: unknown): value is Cache {
  return (
    typeof field(value, 'match') === 'function' &&
    typeof field(value, 'put') === 'function'
  )
}

/** Cloudflare's shared edge cache; absent in local dev and tests. */
export function edgeCache(): Cache | undefined {
  if (typeof caches === 'undefined') return undefined
  const cache = field(caches, 'default')
  return isCache(cache) ? cache : undefined
}

type CheckedBounds = {
  /** As requested: responses hold nothing outside them. */
  exact: LiveBounds
  /** Snapped outward: the provider query and the cache key. */
  snapped: LiveBounds
}

/**
 * Same-site caller and valid bounds, as requested and snapped outward to
 * `decimals` places; otherwise the error response.
 */
function checkedBounds(
  request: Request,
  decimals: number,
): CheckedBounds | Response {
  if (!isSameSiteRequest(request)) return respond({ error: 'forbidden' }, 403)
  const bounds = parseBounds(new URL(request.url).searchParams.get('bounds'))
  if (!bounds.ok)
    return respond({ error: 'invalid_request', message: bounds.message }, 400)
  return { exact: bounds.value, snapped: snapBounds(bounds.value, decimals) }
}

/** `GET /api/meeting/traffic?bounds=west,south,east,north` */
export async function handleTrafficRequest(
  request: Request,
  env: LiveEnv,
  now = Date.now(),
): Promise<Response> {
  const bounds = checkedBounds(request, TRAFFIC_SNAP_DECIMALS)
  if (bounds instanceof Response) return bounds
  const { exact, snapped } = bounds
  const key = env.TOMTOM_API_KEY?.trim()
  if (!key) return respond({ error: 'not_configured' }, 503)

  const url = new URL(TOMTOM_URL)
  url.searchParams.set('key', key)
  url.searchParams.set('bbox', snapped.join(','))
  url.searchParams.set('fields', TOMTOM_FIELDS)
  url.searchParams.set('language', 'en-GB')
  url.searchParams.set('timeValidityFilter', 'present')
  const started = Date.now()
  const upstream = await callUpstream(url)
  if (!('ok' in upstream)) return upstreamFailure('traffic', snapped, upstream)
  // TomTom answers for the snapped box; only the area itself goes back.
  const incidents = normalizeTraffic(upstream.value, exact)
  if (!incidents)
    return upstreamFailure('traffic', snapped, {
      status: 200,
      reason: 'invalid_shape',
    })
  // Never in the shared edge cache: see trafficCacheControl. Its age is
  // measured when the answer arrived, including time spent reading the body.
  const elapsedMs = Date.now() - started
  return respond(
    { provider: 'tomtom', fetched: new Date(now).toISOString(), incidents },
    200,
    trafficCacheControl(
      upstream.cacheControl,
      upstream.age,
      upstream.date,
      now + elapsedMs,
      elapsedMs / 1000,
    ),
  )
}

/** Ticketmaster's documented date-time form, without milliseconds. */
function ticketmasterTime(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Event Search for the snapped area, soonest first. The search covers a
 * circle around the box, so a page can fill with venues outside it: later
 * pages are read, up to `MAX_EVENT_PAGES`, until `MAX_EVENTS` events in the
 * box are found or the results end. One failed page fails the search.
 */
async function searchEvents(
  snapped: LiveBounds,
  exact: LiveBounds,
  span: EventWindow,
  key: string,
  now: number,
): Promise<LiveEvent[] | Response> {
  const [west, south, east, north] = snapped
  const center: Coordinate = [(west + east) / 2, (south + north) / 2]
  // Event Search filters by point and radius, not a box: the radius reaches
  // the corners, and venues outside the bounds are dropped afterwards. The
  // corners nearer the equator are the farther ones, south or north.
  const radiusKm = Math.max(
    1,
    Math.ceil(
      Math.max(
        distanceBetween(center, [west, south]),
        distanceBetween(center, [west, north]),
      ) / 1000,
    ),
  )
  const url = new URL(TICKETMASTER_URL)
  url.searchParams.set('apikey', key)
  url.searchParams.set('geoPoint', geohash(center))
  url.searchParams.set('radius', String(radiusKm))
  url.searchParams.set('unit', 'km')
  url.searchParams.set('startDateTime', ticketmasterTime(now))
  url.searchParams.set(
    'endDateTime',
    ticketmasterTime(now + WINDOW_HOURS[span] * 3_600_000),
  )
  url.searchParams.set('sort', 'date,asc')
  url.searchParams.set('size', String(MAX_EVENTS))
  url.searchParams.set('locale', '*')
  const found = new Map<string, LiveEvent>()
  let inExact = 0
  const deadline = Date.now() + EVENTS_ROUTE_TIMEOUT
  // Pages stay inside the documented deep-paging limit (size * page < 1000)
  // and a shared route deadline inside the browser's 20 s timeout.
  for (
    let page = 0;
    page < MAX_EVENT_PAGES && MAX_EVENTS * page < 1000;
    page++
  ) {
    const remainingMs = Math.min(UPSTREAM_TIMEOUT, deadline - Date.now())
    const pageUrl = new URL(url)
    pageUrl.searchParams.set('page', String(page))
    const upstream = await callUpstream(pageUrl, remainingMs)
    if (!('ok' in upstream))
      return upstreamFailure('events', snapped, upstream, page)
    const items = eventItems(upstream.value)
    if (!items)
      return upstreamFailure(
        'events',
        snapped,
        { status: 200, reason: 'invalid_shape' },
        page,
      )
    for (const item of items) {
      const event = parseEvent(item, snapped)
      if (event && !found.has(event.id)) {
        found.set(event.id, event)
        if (inside(event.coordinate, exact)) inExact++
      }
    }
    const totalPages = field(field(upstream.value, 'page'), 'totalPages')
    // A short page is the last one, and so is a page without a page count.
    if (
      inExact >= MAX_EVENTS ||
      items.length < MAX_EVENTS ||
      typeof totalPages !== 'number' ||
      page + 1 >= totalPages
    )
      break
  }
  const startOf = (event: LiveEvent) =>
    event.start === null ? Infinity : Date.parse(event.start)
  return [...found.values()].sort(
    (a, b) =>
      startOf(a) - startOf(b) || compare(a.name, b.name) || compare(a.id, b.id),
  )
}

/**
 * A cached search for `span` and the seconds the browser may still keep it,
 * so a listing is never served more than `EVENTS_MAX_AGE` after the search.
 * Null when the entry is unreadable or no longer fresh.
 */
async function cachedEvents(
  response: Response,
  span: EventWindow,
  now: number,
): Promise<{ payload: EventsPayload; maxAge: number } | null> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  const fetched = field(body, 'fetched')
  const events = field(body, 'events')
  if (
    field(body, 'provider') !== 'ticketmaster' ||
    field(body, 'window') !== span ||
    typeof fetched !== 'string' ||
    !Array.isArray(events) ||
    !events.every(isLiveEvent)
  )
    return null
  const fetchedTime = Date.parse(fetched)
  if (!Number.isFinite(fetchedTime)) return null
  const maxAge =
    EVENTS_MAX_AGE - Math.max(0, Math.floor((now - fetchedTime) / 1000))
  return maxAge > 0
    ? {
        payload: { provider: 'ticketmaster', fetched, window: span, events },
        maxAge,
      }
    : null
}

/** `GET /api/meeting/events?bounds=west,south,east,north&window=day|week` */
export async function handleEventsRequest(
  request: Request,
  env: LiveEnv,
  now = Date.now(),
): Promise<Response> {
  const bounds = checkedBounds(request, EVENTS_SNAP_DECIMALS)
  if (bounds instanceof Response) return bounds
  const { exact, snapped } = bounds
  const span = parseWindow(new URL(request.url).searchParams.get('window'))
  if (!span.ok)
    return respond({ error: 'invalid_request', message: span.message }, 400)
  const key = env.TICKETMASTER_API_KEY?.trim()
  if (!key) return respond({ error: 'not_configured' }, 503)

  // One search per snapped area and window serves every area inside it.
  const cache = edgeCache()
  const cacheKey = new URL('/api/meeting/events', request.url)
  cacheKey.searchParams.set('bounds', snapped.join(','))
  cacheKey.searchParams.set('window', span.value)
  cacheKey.searchParams.set('v', CACHE_VERSION)
  const cached = await cache
    ?.match(new Request(cacheKey))
    .catch(() => undefined)
  let fresh = cached ? await cachedEvents(cached, span.value, now) : null
  if (!fresh) {
    const events = await searchEvents(snapped, exact, span.value, key, now)
    if (events instanceof Response) return events
    const payload: EventsPayload = {
      provider: 'ticketmaster',
      fetched: new Date(now).toISOString(),
      window: span.value,
      events,
    }
    await cache
      ?.put(
        new Request(cacheKey),
        respond(payload, 200, `public, max-age=${EVENTS_MAX_AGE}`),
      )
      .catch(() => undefined)
    fresh = { payload, maxAge: EVENTS_MAX_AGE }
  }
  // Cached for the snapped box; only the requested area goes back.
  const { payload, maxAge } = fresh
  return respond(
    {
      ...payload,
      events: payload.events
        .filter((event) => inside(event.coordinate, exact))
        .slice(0, MAX_EVENTS),
    },
    200,
    `public, max-age=${maxAge}`,
  )
}
