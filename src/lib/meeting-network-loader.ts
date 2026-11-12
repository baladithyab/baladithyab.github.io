import type { Coordinate, MeetingNetwork } from './meeting-point'
import { parseNetwork } from './meeting-point'
import {
  buildMeetingNetwork,
  buildOverpassQuery,
  MAX_NETWORK_BYTES,
  MAX_SOURCE_NODES,
  MAX_WAY_REFERENCES,
  NETWORK_SCHEMA,
} from './meeting-network'

export type StudySize = 4 | 8 | 12
export type NetworkRequest =
  | { kind: 'preset'; dataUrl: string }
  | { kind: 'live'; name: string; coordinate: Coordinate; sizeKm: StudySize }
export type NetworkReply =
  | { kind: 'progress'; message: string }
  | {
      kind: 'ready'
      network: MeetingNetwork
      delivery: 'bundled' | 'downloaded' | 'cached'
    }
  | { kind: 'error'; message: string }
type Delivery = Extract<NetworkReply, { kind: 'ready' }>['delivery']
type NetworkResult = { network: MeetingNetwork; delivery: Delivery }

const CACHE_NAME = `meeting-point-live-v${NETWORK_SCHEMA}`
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const CACHE_ENTRIES = 3
const CLIENT_TIMEOUT = 90_000
const STORED_AT = 'x-meeting-network-stored-at'
const tooLarge =
  'This walking network is too large (24 MiB download limit). Choose a smaller study area and load again.'

/** Approximate, up-to-size square coverage, not an administrative city boundary. */
export function regionBounds(
  coordinate: Coordinate,
  sizeKm: StudySize,
): MeetingNetwork['bounds'] {
  if (
    !Array.isArray(coordinate) ||
    coordinate.length !== 2 ||
    !coordinate.every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) ||
    Math.abs(coordinate[0]) > 180 ||
    Math.abs(coordinate[1]) > 85
  )
    throw new Error(
      'Choose a valid city location between 85° south and 85° north.',
    )
  if (sizeKm !== 4 && sizeKm !== 8 && sizeKm !== 12)
    throw new Error('Choose a study size of 4, 8, or 12 km.')
  const [longitude, latitude] = coordinate
  const halfLatitude = (sizeKm * 1000) / (2 * 111195)
  const halfLongitude = halfLatitude / Math.cos((latitude * Math.PI) / 180)
  return [
    Math.max(-180, longitude - halfLongitude),
    Math.max(-85, latitude - halfLatitude),
    Math.min(180, longitude + halfLongitude),
    Math.min(85, latitude + halfLatitude),
  ]
}

function providerUrl(): string {
  const configured: unknown = import.meta.env.PUBLIC_MEETING_OVERPASS_URL
  const endpoint =
    typeof configured === 'string' && configured.trim()
      ? configured.trim()
      : 'https://overpass-api.de/api/interpreter'
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('The configured Overpass provider URL is invalid.')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      'The configured Overpass provider must be an HTTP(S) URL without credentials or a fragment.',
    )
  }
  return url.href
}

function parseRequest(value: unknown): NetworkRequest {
  if (!value || typeof value !== 'object' || !('kind' in value))
    throw new Error('Invalid walking-network request.')
  if (value.kind === 'preset') {
    if (
      !('dataUrl' in value) ||
      typeof value.dataUrl !== 'string' ||
      !value.dataUrl.trim()
    )
      throw new Error('Missing bundled walking-network URL.')
    return { kind: 'preset', dataUrl: value.dataUrl }
  }
  if (value.kind === 'live') {
    if (
      !('name' in value) ||
      typeof value.name !== 'string' ||
      !value.name.trim() ||
      value.name.length > 200 ||
      !('coordinate' in value) ||
      !Array.isArray(value.coordinate) ||
      value.coordinate.length !== 2 ||
      typeof value.coordinate[0] !== 'number' ||
      typeof value.coordinate[1] !== 'number' ||
      !('sizeKm' in value) ||
      (value.sizeKm !== 4 && value.sizeKm !== 8 && value.sizeKm !== 12)
    )
      throw new Error(
        'Choose a city and a valid study size before loading its walking network.',
      )
    const coordinate: Coordinate = [value.coordinate[0], value.coordinate[1]]
    regionBounds(coordinate, value.sizeKm)
    return {
      kind: 'live',
      name: value.name.trim(),
      coordinate,
      sizeKm: value.sizeKm,
    }
  }
  throw new Error('Unknown walking-network request.')
}

async function readJson(
  response: Response,
  abort: AbortController,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_NETWORK_BYTES) {
    abort.abort()
    throw new Error(tooLarge)
  }
  if (!response.body)
    throw new Error(
      'The road provider returned an empty response. Try again later.',
    )
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_NETWORK_BYTES) {
        abort.abort()
        await reader.cancel().catch(() => undefined)
        throw new Error(tooLarge)
      }
      parts.push(decoder.decode(chunk.value, { stream: true }))
    }
    parts.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(parts.join(''))
  } catch {
    throw new Error(
      'The road provider returned invalid or incomplete JSON. Choose a smaller study area or try again later.',
    )
  }
}

function checkedNetwork(value: unknown): MeetingNetwork {
  const network = parseNetwork(value)
  if (
    network.nodes.length > MAX_SOURCE_NODES ||
    network.edges.length > MAX_WAY_REFERENCES ||
    !network.edges.length
  ) {
    throw new Error('Invalid or oversized normalized walking network.')
  }
  const [west, south, east, north] = network.bounds
  if (
    !network.nodes.every(
      ([lon, lat]) =>
        lon >= west && lon <= east && lat >= south && lat <= north,
    )
  ) {
    throw new Error(
      'The walking network contains road coordinates outside its study area.',
    )
  }
  return network
}

function cacheKey(
  provider: string,
  bounds: MeetingNetwork['bounds'],
  sizeKm: StudySize,
): Request {
  // Synthetic URL is a Cache API key only; no request is sent to this host.
  const url = new URL('https://meeting-point-cache.invalid/network')
  url.searchParams.set('schema', String(NETWORK_SCHEMA))
  url.searchParams.set('provider', provider)
  url.searchParams.set('bounds', JSON.stringify(bounds))
  url.searchParams.set('sizeKm', String(sizeKm))
  return new Request(url)
}

async function openCache(): Promise<Cache | undefined> {
  try {
    if (typeof caches === 'undefined') return undefined
    return await caches.open(CACHE_NAME)
  } catch {
    return undefined
  }
}

async function cachedNetwork(
  cache: Cache,
  key: Request,
  bounds: MeetingNetwork['bounds'],
): Promise<MeetingNetwork | undefined> {
  try {
    const response = await cache.match(key)
    if (!response) return undefined
    const storedAt = Number(response.headers.get(STORED_AT))
    const age = Date.now() - storedAt
    if (
      !Number.isFinite(storedAt) ||
      storedAt <= 0 ||
      age < 0 ||
      age >= CACHE_TTL
    ) {
      await cache.delete(key)
      return undefined
    }
    const abort = new AbortController()
    const network = checkedNetwork(await readJson(response, abort))
    if (!network.bounds.every((part, i) => part === bounds[i]))
      throw new Error('Cached region geometry differs.')
    return network
  } catch {
    // Corrupt/unsupported entries are misses, never successful cached delivery.
    await cache.delete(key).catch(() => false)
    return undefined
  }
}

async function trimCache(cache: Cache): Promise<void> {
  const entries: { request: Request; storedAt: number }[] = []
  const now = Date.now()
  for (const request of await cache.keys()) {
    const response = await cache.match(request)
    const storedAt = Number(response?.headers.get(STORED_AT))
    if (
      !Number.isFinite(storedAt) ||
      storedAt <= 0 ||
      now - storedAt >= CACHE_TTL ||
      storedAt > now
    ) {
      await cache.delete(request)
    } else entries.push({ request, storedAt })
  }
  entries.sort((a, b) => b.storedAt - a.storedAt)
  for (const entry of entries.slice(CACHE_ENTRIES))
    await cache.delete(entry.request)
}

async function storeNetwork(
  cache: Cache,
  key: Request,
  network: MeetingNetwork,
): Promise<void> {
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(network), {
        headers: {
          'content-type': 'application/json',
          [STORED_AT]: String(Date.now()),
        },
      }),
    )
    await trimCache(cache)
  } catch {
    // Storage quota/privacy failures cannot turn a real download into an error.
  }
}

/** Called by meeting-network.worker.ts; retrieval and normalization stay off the UI thread. */
export async function loadMeetingNetwork(
  request: NetworkRequest,
  onProgress: (message: string) => void,
): Promise<NetworkResult> {
  const parsed = parseRequest(request)
  const abort = new AbortController()
  const timeoutMessage =
    'Walking-network loading timed out after 90 seconds. Choose a smaller study area or try again later.'
  const deadlineAt = Date.now() + CLIENT_TIMEOUT
  const { promise: deadline, reject } = Promise.withResolvers<never>()
  const timeout = setTimeout(() => {
    reject(new Error(timeoutMessage))
    abort.abort()
  }, CLIENT_TIMEOUT)
  const load = async (): Promise<NetworkResult> => {
    if (parsed.kind === 'preset') {
      onProgress('Loading the bundled San Francisco walking network…')
      const response = await fetch(parsed.dataUrl, { signal: abort.signal })
      if (!response.ok)
        throw new Error(
          `The bundled walking network could not be loaded (HTTP ${response.status}). Try again.`,
        )
      return {
        network: checkedNetwork(await readJson(response, abort)),
        delivery: 'bundled',
      }
    }
    const bounds = regionBounds(parsed.coordinate, parsed.sizeKm)
    const provider = providerUrl()
    const key = cacheKey(provider, bounds, parsed.sizeKm)
    onProgress('Checking the seven-day walking-network cache…')
    const cache = await openCache()
    if (cache) {
      // Enforce expiry/entry limits on reads as well as writes.
      await trimCache(cache).catch(() => undefined)
      const network = await cachedNetwork(cache, key, bounds)
      if (network)
        return {
          network: { ...network, name: parsed.name },
          delivery: 'cached',
        }
    }
    if (abort.signal.aborted) throw new Error(timeoutMessage)
    onProgress(
      `Requesting public walking roads for up to ${parsed.sizeKm} × ${parsed.sizeKm} km…`,
    )
    const response = await fetch(provider, {
      method: 'POST',
      body: new URLSearchParams({ data: buildOverpassQuery(bounds) }),
      signal: abort.signal,
    })
    if (response.status === 429)
      throw new Error(
        'Overpass is rate-limiting requests (HTTP 429). Wait before loading again, or use the San Francisco preset.',
      )
    if (response.status === 503 || response.status === 504)
      throw new Error(
        `Overpass is busy or its query timed out (HTTP ${response.status}). Choose a smaller study area or try again later.`,
      )
    if (!response.ok)
      throw new Error(
        `The walking-road provider failed (HTTP ${response.status}). Try again later.`,
      )
    onProgress('Downloading bounded OpenStreetMap road data…')
    const raw = await readJson(response, abort)
    onProgress('Connecting public paths and named street intersections…')
    const network = buildMeetingNetwork(raw, {
      name: parsed.name,
      bounds,
      fetched: new Date().toISOString().slice(0, 10),
    })
    if (cache) await storeNetwork(cache, key, network)
    return { network, delivery: 'downloaded' }
  }
  try {
    const result = await Promise.race([load(), deadline])
    // JSON parsing/normalization are synchronous; reject if they overran the timer.
    if (Date.now() >= deadlineAt) throw new Error(timeoutMessage)
    return result
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(
        'The walking-road provider could not be reached. Check your connection or provider CORS availability, then try again later.',
      )
    throw error
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
}
