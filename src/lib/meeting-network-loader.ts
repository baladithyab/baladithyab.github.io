import type { Coordinate, MeetingNetwork } from './meeting-point'
import { parseNetwork } from './meeting-point'
import {
  boundsSizeKm,
  buildOverpassQuery,
  checkSourceNodes,
  INCOMPLETE_RESPONSE,
  MAX_LIVE_AREA_KM2,
  MAX_WAY_REFERENCES,
  MeetingNetworkBuilder,
  NETWORK_SCHEMA,
  overpassBudget,
  readOverpassEnvelope,
  validateBounds,
} from './meeting-network'
import { OverpassElementReader } from './meeting-overpass-stream'

export type StudySize = 4 | 8 | 12
export type NetworkRequest =
  | { kind: 'preset'; dataUrl: string }
  | { kind: 'live'; name: string; bounds: MeetingNetwork['bounds'] }
export type NetworkDelivery = 'bundled' | 'downloaded' | 'cached'
type NetworkResult = { network: MeetingNetwork; delivery: NetworkDelivery }
type Bounds = MeetingNetwork['bounds']

const CACHE_NAME = `meeting-point-live-v${NETWORK_SCHEMA}`
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const CACHE_ENTRIES = 3
const STORED_AT = 'x-meeting-network-stored-at'
/** Safety ceiling for one whole load, however many requests it takes. */
const LOAD_CEILING = 20 * 60_000
/** Response headers must arrive within the query's own server timeout plus this. */
const HEADER_GRACE = 30_000
/** The bundled network is a static file: its headers come quickly or not at all. */
const PRESET_HEADER_TIMEOUT = 30_000
const STALL_TIMEOUT = 45_000
/** The public server gives each user about two slots; requests go one at a time with a gap. */
const REQUEST_GAP = 2_000
const MAX_ATTEMPTS = 4
/** Every request of one load, retries and split parts included. */
const MAX_REQUESTS = 40
const RETRY_BASE_DELAY = 2_000
const RETRY_STATUSES = new Set([502, 503, 504])
/** Largest area one request asks for; larger areas load as a grid of parts. */
const PART_KM2 = 800
/** A part at least this large is split when it answers HTTP 504 a second time. */
const SPLIT_ON_504_KM2 = 100
/** A part smaller than this is never split; its failure fails the load. */
const MIN_SPLIT_KM2 = 25
const unreachable =
  'The walking-road provider could not be reached. Check your connection or provider CORS availability, then try again later.'

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

/** `columns` × `rows` cells of equal degree size; neighbours share identical edge values. */
function grid(bounds: Bounds, columns: number, rows: number): Bounds[] {
  const [west, south, east, north] = bounds
  const edge = (from: number, to: number, i: number, count: number) =>
    i === count ? to : from + ((to - from) * i) / count
  const cells: Bounds[] = []
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      cells.push([
        edge(west, east, column, columns),
        edge(south, north, row, rows),
        edge(west, east, column + 1, columns),
        edge(south, north, row + 1, rows),
      ])
  return cells
}

/** Adds a column or a row along the longer cell side until every cell is at most `PART_KM2`. */
function planParts(bounds: Bounds): Bounds[] {
  let columns = 1
  let rows = 1
  for (;;) {
    const cells = grid(bounds, columns, rows)
    // Rows nearer the equator are slightly wider, so check the largest cell.
    const largest = cells
      .map(boundsSizeKm)
      .reduce((a, b) => (b.areaKm2 > a.areaKm2 ? b : a))
    if (largest.areaKm2 <= PART_KM2) return cells
    if (largest.widthKm >= largest.heightKm) columns++
    else rows++
  }
}

/** A `Retry-After` of 1-30 seconds (delay-seconds or HTTP-date), in ms; 0 when absent or out of range. */
function retryAfterDelay(response: Response): number {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return 0
  let seconds: number
  if (/^\d{1,2}$/.test(value)) {
    seconds = Number(value)
  } else {
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return 0
    seconds = Math.ceil((date - Date.now()) / 1000)
  }
  return seconds >= 1 && seconds <= 30 ? seconds * 1000 : 0
}

/** Resolves after `delay`, or rejects with the abort reason as soon as `signal` aborts. */
function pause(delay: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  if (signal.aborted) {
    reject(signal.reason)
    return promise
  }
  const stop = () => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', stop)
    resolve()
  }, delay)
  signal.addEventListener('abort', stop, { once: true })
  return promise
}

/** Settles like `promise`, or rejects with the abort reason as soon as `signal` aborts. */
function unlessAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const { promise: stopped, reject } = Promise.withResolvers<never>()
  const stop = () => reject(signal.reason)
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
  return Promise.race([promise, stopped]).finally(() =>
    signal.removeEventListener('abort', stop),
  )
}

/** Runs one request under its own controller, which aborting the whole load also stops. */
async function underRequest<T>(
  load: AbortSignal,
  run: (request: AbortController) => Promise<T>,
): Promise<T> {
  const request = new AbortController()
  const forward = () => request.abort(load.reason)
  if (load.aborted) forward()
  else load.addEventListener('abort', forward, { once: true })
  try {
    return await run(request)
  } finally {
    load.removeEventListener('abort', forward)
    request.abort()
  }
}

async function send(
  url: string,
  init: RequestInit,
  request: AbortController,
): Promise<Response> {
  try {
    return await unlessAborted(
      fetch(url, { ...init, signal: request.signal }),
      request.signal,
    )
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason
    throw error instanceof TypeError ? new Error(unreachable) : error
  }
}

/**
 * Feeds the body to `onChunk` as it arrives. Aborts `request` when 45 s pass
 * without a byte; reports decoded bytes at most every 250 ms and at the end.
 */
async function readBody(
  response: Response,
  request: AbortController,
  onChunk: (chunk: Uint8Array) => void,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  if (!response.body)
    throw new Error(
      'The road provider returned an empty response. Try again later.',
    )
  const reader = response.body.getReader()
  const stalled = () =>
    request.abort(
      new Error(
        `The road download stalled: no data arrived for ${STALL_TIMEOUT / 1000} seconds. Check your connection and load again.`,
      ),
    )
  let timer = setTimeout(stalled, STALL_TIMEOUT)
  let bytes = 0
  let reportedAt = performance.now()
  try {
    while (true) {
      const chunk = await unlessAborted(reader.read(), request.signal).catch(
        (error: unknown) => {
          if (request.signal.aborted) throw request.signal.reason
          throw error instanceof TypeError ? new Error(unreachable) : error
        },
      )
      clearTimeout(timer)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      onChunk(chunk.value)
      if (onBytes) {
        const now = performance.now()
        if (now - reportedAt >= 250) {
          onBytes(bytes)
          reportedAt = now
        }
      }
      timer = setTimeout(stalled, STALL_TIMEOUT)
    }
    onBytes?.(bytes)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
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
      value.name.length > 200
    )
      throw new Error('Name the study area before loading its walking network.')
    let bounds: Bounds
    try {
      bounds = validateBounds('bounds' in value ? value.bounds : undefined)
    } catch {
      throw new Error(
        'Choose a valid study area before loading its walking network.',
      )
    }
    if (bounds[1] < -85 || bounds[3] > 85)
      throw new Error('Choose a study area between 85° south and 85° north.')
    const { widthKm, heightKm, areaKm2 } = boundsSizeKm(bounds)
    if (areaKm2 > MAX_LIVE_AREA_KM2)
      throw new Error(
        `This study area is about ${Math.round(widthKm)} × ${Math.round(heightKm)} km (${Math.round(areaKm2)} km²); the lab loads at most ${MAX_LIVE_AREA_KM2} km². Choose locations closer together or a smaller city size.`,
      )
    return { kind: 'live', name: value.name.trim(), bounds }
  }
  throw new Error('Unknown walking-network request.')
}

function checkedNetwork(value: unknown): MeetingNetwork {
  const network = parseNetwork(value)
  checkSourceNodes(network.nodes.length)
  if (network.edges.length > MAX_WAY_REFERENCES || !network.edges.length) {
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

function cacheKey(provider: string, bounds: Bounds): Request {
  // Synthetic URL is a Cache API key only; no request is sent to this host.
  const url = new URL('https://meeting-point-cache.invalid/network')
  url.searchParams.set('schema', String(NETWORK_SCHEMA))
  url.searchParams.set('provider', provider)
  url.searchParams.set('bounds', JSON.stringify(bounds))
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

/** The fresh, valid entry stored under `request`; expired or corrupt entries are deleted. */
async function storedEntry(
  cache: Cache,
  request: Request,
  bounds: Bounds,
): Promise<
  { network: MeetingNetwork; text: string; storedAt: number } | undefined
> {
  try {
    const response = await cache.match(request)
    if (!response) return undefined
    const storedAt = Number(response.headers.get(STORED_AT))
    const age = Date.now() - storedAt
    if (
      !Number.isFinite(storedAt) ||
      storedAt <= 0 ||
      age < 0 ||
      age >= CACHE_TTL
    ) {
      await cache.delete(request)
      return undefined
    }
    const text = await response.text()
    const network = checkedNetwork(JSON.parse(text))
    if (!network.bounds.every((part, i) => part === bounds[i]))
      throw new Error('Cached region geometry differs.')
    return { network, text, storedAt }
  } catch {
    // Corrupt/unsupported entries are misses, never successful cached delivery.
    await cache.delete(request).catch(() => false)
    return undefined
  }
}

/**
 * The network cached for `key`. Older keys of the same schema also carried the
 * study size (`sizeKm`); an entry under such a key for the same provider and
 * exact bounds is moved to `key`, keeping the time it was first stored.
 */
async function cachedNetwork(
  cache: Cache,
  key: Request,
  bounds: Bounds,
): Promise<MeetingNetwork | undefined> {
  const current = await storedEntry(cache, key, bounds)
  if (current) return current.network
  const wanted = new URL(key.url)
  let requests: readonly Request[]
  try {
    requests = await cache.keys()
  } catch {
    return undefined
  }
  for (const request of requests) {
    const stored = new URL(request.url)
    if (
      stored.href === wanted.href ||
      stored.origin !== wanted.origin ||
      stored.pathname !== wanted.pathname ||
      !['schema', 'provider', 'bounds'].every(
        (name) =>
          stored.searchParams.get(name) === wanted.searchParams.get(name),
      )
    )
      continue
    const entry = await storedEntry(cache, request, bounds)
    if (!entry) continue
    try {
      await cache.put(
        key,
        new Response(entry.text, {
          headers: {
            'content-type': 'application/json',
            [STORED_AT]: String(entry.storedAt),
          },
        }),
      )
      await cache.delete(request)
    } catch {
      // A failed move leaves the old entry to expire; this load still uses it.
    }
    return entry.network
  }
  return undefined
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

const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)

/** How one Overpass request ended when it did not fail the load. */
type Answer =
  | { kind: 'busy'; status: number; retryAfter: number }
  | { kind: 'unfinished'; remark: string }
  | { kind: 'delivered' }

/** Retrieval and normalization run in the retained meeting-point worker. */
export async function loadMeetingNetwork(
  request: NetworkRequest,
  onProgress: (message: string) => void,
): Promise<NetworkResult> {
  const parsed = parseRequest(request)
  const abort = new AbortController()
  const ceilingError = new Error(
    'Loading this walking network was stopped after 20 minutes. Wait a few minutes and load again, or choose locations closer together.',
  )
  const ceilingAt = Date.now() + LOAD_CEILING
  const { promise: ceilingReached, reject } = Promise.withResolvers<never>()
  const ceiling = setTimeout(() => {
    reject(ceilingError)
    abort.abort(ceilingError)
  }, LOAD_CEILING)

  const loadPreset = (dataUrl: string) =>
    underRequest(abort.signal, async (preset) => {
      onProgress('Loading the bundled San Francisco walking network…')
      const silent = setTimeout(
        () =>
          preset.abort(
            new Error(
              'Loading the bundled walking network timed out waiting for the server. Reload the page and try again.',
            ),
          ),
        PRESET_HEADER_TIMEOUT,
      )
      let response: Response
      try {
        response = await send(dataUrl, {}, preset)
      } finally {
        clearTimeout(silent)
      }
      if (!response.ok)
        throw new Error(
          `The bundled walking network could not be loaded (HTTP ${response.status}). Try again.`,
        )
      const decoder = new TextDecoder()
      const pieces: string[] = []
      await readBody(
        response,
        preset,
        (chunk) => pieces.push(decoder.decode(chunk, { stream: true })),
        (bytes) => onProgress(`Reading road data: ${mib(bytes)} MiB decoded…`),
      )
      pieces.push(decoder.decode())
      let value: unknown
      try {
        value = JSON.parse(pieces.join(''))
      } catch {
        throw new Error(
          'The bundled walking network is invalid or incomplete. Reload the page and try again.',
        )
      }
      return checkedNetwork(value)
    })

  const loadLive = async (name: string, bounds: Bounds) => {
    const provider = providerUrl()
    const key = cacheKey(provider, bounds)
    onProgress('Checking the seven-day walking-network cache…')
    const cache = await openCache()
    if (cache) {
      const network = await cachedNetwork(cache, key, bounds)
      if (network)
        return {
          network: { ...network, name },
          delivery: 'cached' as const,
        }
    }

    const builder = new MeetingNetworkBuilder()
    /** One request for `part`; its elements reach `builder` only if the server finished. */
    const ask = (part: Bounds, label: string) =>
      underRequest(abort.signal, async (overpass): Promise<Answer> => {
        const wait = overpassBudget(part).timeoutSeconds * 1000 + HEADER_GRACE
        const silent = setTimeout(
          () =>
            overpass.abort(
              new Error(
                `Overpass did not start answering within ${wait / 1000} seconds. Wait a few minutes and load again, or choose locations closer together.`,
              ),
            ),
          wait,
        )
        let response: Response
        try {
          response = await send(
            provider,
            {
              method: 'POST',
              body: new URLSearchParams({ data: buildOverpassQuery(part) }),
            },
            overpass,
          )
        } finally {
          clearTimeout(silent)
        }
        if (RETRY_STATUSES.has(response.status)) {
          await response.body?.cancel().catch(() => undefined)
          return {
            kind: 'busy',
            status: response.status,
            retryAfter: retryAfterDelay(response),
          }
        }
        // Overpass bans clients that keep retrying after 429, so never retry it.
        if (response.status === 429)
          throw new Error(
            'Overpass is rate-limiting requests (HTTP 429). Wait at least 30 seconds before loading again, or use the San Francisco preset.',
          )
        if (!response.ok)
          throw new Error(
            `The walking-road provider failed (HTTP ${response.status}). Try again later.`,
          )
        onProgress(`Downloading OpenStreetMap road data${label}…`)
        builder.beginPart()
        try {
          const reader = new OverpassElementReader((element) =>
            builder.add(element),
          )
          await readBody(
            response,
            overpass,
            (chunk) => reader.write(chunk),
            (bytes) =>
              onProgress(
                `Reading road data${label}: ${mib(bytes)} MiB decoded…`,
              ),
          )
          const envelope = readOverpassEnvelope(reader.end())
          if (envelope.remark !== undefined) {
            builder.abandonPart()
            return { kind: 'unfinished', remark: envelope.remark }
          }
          builder.endPart()
          return { kind: 'delivered' }
        } catch (error) {
          builder.abandonPart()
          throw error
        }
      })

    const queue = planParts(bounds)
    let finished = 0
    let requests = 0
    /** A `Retry-After` holds back every later request of the load, not only retries. */
    let notBefore = 0
    while (queue.length) {
      const part = queue[0]
      const total = finished + queue.length
      const partName = total > 1 ? `part ${finished + 1} of ${total}` : ''
      const label = partName ? ` (${partName})` : ''
      const { widthKm, heightKm, areaKm2 } = boundsSizeKm(part)
      let split = false
      let timeouts504 = 0
      for (let attempt = 1; ; attempt++) {
        if (requests === MAX_REQUESTS)
          throw new Error(
            `Overpass could not deliver this area within ${MAX_REQUESTS} requests. Wait a few minutes and load again, or choose locations closer together.`,
          )
        const gap = attempt === 1 && requests > 0 ? REQUEST_GAP : 0
        const wait = Math.max(gap, notBefore - Date.now())
        if (wait > gap)
          onProgress(
            `Overpass asked for a pause; sending the next request in ${Math.ceil(wait / 1000)} s…`,
          )
        if (wait > 0) await pause(wait, abort.signal)
        requests++
        onProgress(
          `Requesting public walking roads for about ${Math.round(widthKm)} × ${Math.round(heightKm)} km${label}${attempt > 1 ? ` (attempt ${attempt} of ${MAX_ATTEMPTS})` : ''}…`,
        )
        const answer = await ask(part, label)
        if (answer.kind === 'delivered') break
        if (answer.kind === 'unfinished') {
          // Running out of time or memory is about size: smaller parts fit.
          if (
            !/timed out|out of memory/i.test(answer.remark) ||
            areaKm2 < MIN_SPLIT_KM2
          )
            throw new Error(INCOMPLETE_RESPONSE)
          split = true
          break
        }
        if (answer.retryAfter > 0)
          notBefore = Math.max(notBefore, Date.now() + answer.retryAfter)
        // 504 means the request did not fit the resources free right now.
        if (answer.status === 504) timeouts504++
        if (
          answer.status === 504 &&
          areaKm2 >= SPLIT_ON_504_KM2 &&
          timeouts504 >= 2
        ) {
          split = true
          break
        }
        if (attempt === MAX_ATTEMPTS)
          throw new Error(
            `Overpass could not answer after ${MAX_ATTEMPTS} tries (last answer: HTTP ${answer.status}). Wait a minute and load again, choose a smaller area, or use the San Francisco preset.`,
          )
        // Exponential backoff with jitter, as the Overpass operators request.
        const delay = Math.max(
          RETRY_BASE_DELAY * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4),
          answer.retryAfter,
        )
        onProgress(
          `Overpass ${answer.status === 504 ? 'did not answer in time' : 'is at capacity'} (HTTP ${answer.status}). Retrying in ${Math.round(delay / 1000)} s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})…`,
        )
        await pause(delay, abort.signal)
      }
      queue.shift()
      if (split) {
        onProgress(
          `Overpass could not finish ${partName || 'this area'} in one request; loading it as four smaller parts…`,
        )
        queue.unshift(...grid(part, 2, 2))
      } else finished++
    }
    onProgress('Connecting public paths and named street intersections…')
    const network = builder.build({
      name,
      bounds,
      fetched: new Date().toISOString().slice(0, 10),
    })
    if (cache) await storeNetwork(cache, key, network)
    return { network, delivery: 'downloaded' as const }
  }

  try {
    const result = await Promise.race([
      parsed.kind === 'preset'
        ? loadPreset(parsed.dataUrl).then((network) => ({
            network,
            delivery: 'bundled' as const,
          }))
        : loadLive(parsed.name, parsed.bounds),
      ceilingReached,
    ])
    // Normalization is synchronous; reject if it overran the ceiling.
    if (Date.now() >= ceilingAt) throw ceilingError
    return result
  } finally {
    clearTimeout(ceiling)
    abort.abort()
  }
}
