import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boundsSizeKm, buildMeetingNetwork } from './meeting-network'
import {
  loadMeetingNetwork,
  regionBounds,
  type NetworkRequest,
} from './meeting-network-loader'
import type { MeetingNetwork } from './meeting-point'

type Bounds = MeetingNetwork['bounds']

const provider = 'https://roads.example/overpass'
const startTime = Date.UTC(2026, 10, 12)
const sevenDays = 7 * 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
const fetchMock = vi.fn<typeof fetch>()
const progress = vi.fn<(message: string) => void>()
const streams: ReadableStreamDefaultController<Uint8Array>[] = []

// Materialize stored bodies so each match is independently readable, like the
// Cache API, without leaving unread Response.clone() tee branches behind.
const entries = new Map<string, { body: string; headers: Headers }>()
const requestUrl = (request: Parameters<Cache['put']>[0]) =>
  typeof request === 'string'
    ? request
    : request instanceof URL
      ? request.href
      : request.url
const cache = {
  async match(request) {
    const entry = entries.get(requestUrl(request))
    return entry
      ? new Response(entry.body, { headers: entry.headers })
      : undefined
  },
  async put(request, response) {
    entries.set(requestUrl(request), {
      body: await response.text(),
      headers: new Headers(response.headers),
    })
  },
  async delete(request) {
    return entries.delete(requestUrl(request))
  },
  async keys() {
    return Array.from(entries.keys(), (url) => new Request(url))
  },
} satisfies Pick<Cache, 'match' | 'put' | 'delete' | 'keys'>

beforeEach(() => {
  entries.clear()
  fetchMock.mockReset()
  fetchMock.mockRejectedValue(new Error('Unexpected fetch in loader test.'))
  progress.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('caches', { open: async () => cache })
  vi.stubEnv('PUBLIC_MEETING_OVERPASS_URL', provider)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(startTime)
})

afterEach(() => {
  try {
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    // Also terminate an unread/locked test stream if a regression skips cleanup.
    for (const controller of streams) {
      try {
        controller.error(new Error('Loader test stream cleanup.'))
      } catch {
        // Already closed.
      }
    }
    streams.length = 0
    entries.clear()
    fetchMock.mockReset()
    progress.mockReset()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

type LiveRequest = Extract<NetworkRequest, { kind: 'live' }>

function liveRequest(longitude = 0, sizeKm: 4 | 8 | 12 = 4): LiveRequest {
  return {
    kind: 'live',
    name: `Test area ${longitude}`,
    bounds: regionBounds([longitude, 0], sizeKm),
  }
}

/** A `widthKm` × `heightKm` area on the equator, west edge at `longitude`. */
function wideRequest(widthKm: number, heightKm: number, longitude = 0) {
  return {
    kind: 'live',
    name: `Wide area ${widthKm} × ${heightKm} km`,
    bounds: [longitude, 0, longitude + widthKm / 111.195, heightKm / 111.195],
  } satisfies LiveRequest
}

function roads(request: LiveRequest, street = 'Main Street') {
  const [west, south, east, north] = request.bounds
  const lon = (west + east) / 2
  const lat = (south + north) / 2
  return {
    elements: [
      { type: 'node', id: 1, lon: lon - 0.001, lat },
      { type: 'node', id: 2, lon, lat },
      { type: 'node', id: 3, lon: lon + 0.001, lat },
      {
        type: 'way',
        id: 101,
        nodes: [1, 2],
        tags: { highway: 'residential', name: street },
      },
      {
        type: 'way',
        id: 102,
        nodes: [2, 3],
        tags: { highway: 'residential', name: 'Cross Street' },
      },
    ],
  }
}

function respond(request: LiveRequest, street = 'Main Street') {
  fetchMock.mockResolvedValueOnce(Response.json(roads(request, street)))
}

function expectRoads(
  network: MeetingNetwork,
  request: LiveRequest,
  street = 'Main Street',
) {
  const [west, south, east, north] = request.bounds
  const lon = (west + east) / 2
  const lat = (south + north) / 2
  expect(network).toMatchObject({
    version: 1,
    name: request.name,
    bounds: request.bounds,
    attribution: '© OpenStreetMap contributors',
    source: 'https://www.openstreetmap.org/copyright',
    nodes: [
      [lon - 0.001, lat],
      [lon, lat],
      [lon + 0.001, lat],
    ],
    edges: [
      [0, 1, 111],
      [1, 2, 111],
    ],
    places: [{ node: 1, name: `Cross Street & ${street}` }],
  })
}

/** A body whose chunks are made only when the loader reads them. */
function lazyResponse(chunks: Iterator<Uint8Array>, status = 200) {
  const cancel = vi.fn()
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      const next = chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
  )
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streams.push(controller)
      },
      pull,
      cancel,
    },
    // Observe only reads requested by the loader, not stream prefetching.
    { highWaterMark: 0 },
  )
  return { response: new Response(body, { status }), pull, cancel }
}

function busy(status: number, headers?: HeadersInit) {
  return new Response('Overpass is at capacity.', {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  })
}

// Real macrotask turns (setImmediate is not faked) let the loader reach its
// next timer without moving the fake clock.
async function until(condition: () => boolean) {
  for (let turn = 0; turn < 200 && !condition(); turn++)
    await new Promise((resolve) => setImmediate(resolve))
  expect(condition()).toBe(true)
}

/** Lets fake time pass in small steps until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  for (let turn = 0; turn < 20_000 && !settled; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
    if (!settled) await vi.advanceTimersByTimeAsync(250)
  }
  return promise
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await settle(promise).then(
    () => new Error('Expected the load to fail.'),
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

// The load ceiling is one timer; a second one is a pending retry wait.
const retryWaiting = () => vi.getTimerCount() === 2

type Element = Record<string, unknown> & { id: number }
type World = { ways: Element[]; nodes: Element[] }

/** A street grid inside `area`: 3 streets east-west and 7 avenues north-south sharing crossing nodes. */
function world(area: Bounds): World {
  const [west, south, east, north] = area
  const lon = (k: number) => west + (east - west) * (0.05 + (0.9 * k) / 8)
  const lat = (j: number) => south + (north - south) * (0.05 + (0.9 * j) / 4)
  const id = (k: number, j: number) => 1000 + k * 10 + j
  const nodes: Element[] = []
  for (let k = 0; k <= 8; k++)
    for (let j = 0; j <= 4; j++)
      nodes.push({ type: 'node', id: id(k, j), lon: lon(k), lat: lat(j) })
  const ways: Element[] = []
  for (let j = 1; j <= 3; j++)
    ways.push({
      type: 'way',
      id: j,
      nodes: Array.from({ length: 9 }, (_, k) => id(k, j)),
      tags: { highway: 'residential', name: `Street ${j}` },
    })
  for (let k = 1; k <= 7; k++)
    ways.push({
      type: 'way',
      id: 10 + k,
      nodes: Array.from({ length: 5 }, (_, j) => id(k, j)),
      tags: { highway: 'residential', name: `Avenue ${k}` },
    })
  return { ways, nodes }
}

/** What Overpass returns for `bbox`: ways with a node inside, each with all its nodes. */
function overpassAnswer(data: World, bbox: Bounds) {
  const [west, south, east, north] = bbox
  const byId = new Map(data.nodes.map((node) => [node.id, node]))
  const ways = data.ways.filter((way) =>
    (way.nodes as number[]).some((id) => {
      const node = byId.get(id) as { lon: number; lat: number }
      return (
        node.lon >= west &&
        node.lon <= east &&
        node.lat >= south &&
        node.lat <= north
      )
    }),
  )
  const used = new Set(ways.flatMap((way) => way.nodes as number[]))
  return {
    version: 0.6,
    elements: [...ways, ...data.nodes.filter((node) => used.has(node.id))],
  }
}

function askedBounds(init: RequestInit | undefined): Bounds {
  const query =
    init?.body instanceof URLSearchParams ? init.body.get('data') : null
  const match = /\(([^,()]+),([^,()]+),([^,()]+),([^,()]+)\);out body/.exec(
    query ?? '',
  )
  if (!match) throw new Error(`Unexpected Overpass query: ${query}`)
  return [
    Number(match[2]),
    Number(match[1]),
    Number(match[4]),
    Number(match[3]),
  ]
}

/**
 * Answers each Overpass request from `data` unless `special` returns a
 * response for it. Records every request's bounds and time, and whether one
 * started while an earlier body was still unread.
 */
function serve(
  data: World,
  special?: (bbox: Bounds, call: number) => Response | undefined,
) {
  const asked: { bounds: Bounds; at: number }[] = []
  let open = false
  let overlapped = false
  fetchMock.mockImplementation(async (_input, init) => {
    if (open) overlapped = true
    const bounds = askedBounds(init)
    asked.push({ bounds, at: Date.now() })
    const answer = special?.(bounds, asked.length)
    if (answer) return answer
    open = true
    const bytes = encoder.encode(JSON.stringify(overpassAnswer(data, bounds)))
    const sent = [bytes][Symbol.iterator]()
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const next = sent.next()
            if (next.done) {
              open = false
              controller.close()
            } else controller.enqueue(next.value)
          },
        },
        { highWaterMark: 0 },
      ),
    )
  })
  return { asked, overlapped: () => overlapped }
}

/** Order-independent form of a network: the same graph compares equal. */
function graph(network: MeetingNetwork) {
  const point = (node: number) => network.nodes[node].join(',')
  return {
    nodes: network.nodes.map(([lon, lat]) => `${lon},${lat}`).sort(),
    edges: network.edges
      .map(
        ([a, b, metres]) =>
          `${[point(a), point(b)].sort().join('|')}|${metres}`,
      )
      .sort(),
    places: network.places
      .map(({ node, name }) => `${point(node)}|${name}`)
      .sort(),
  }
}

function expectWorld(network: MeetingNetwork, request: LiveRequest) {
  const data = world(request.bounds)
  const expected = buildMeetingNetwork(
    { elements: [...data.ways, ...data.nodes] },
    { name: request.name, bounds: request.bounds },
  )
  expect(network.bounds).toEqual(request.bounds)
  expect(graph(network)).toEqual(graph(expected))
}

/** Cells lie inside `area`, never overlap, and together cover it. */
function expectTiling(cells: Bounds[], area: Bounds) {
  const [west, south, east, north] = area
  let covered = 0
  for (const [i, [w, s, e, n]] of cells.entries()) {
    expect(w).toBeGreaterThanOrEqual(west)
    expect(s).toBeGreaterThanOrEqual(south)
    expect(e).toBeLessThanOrEqual(east)
    expect(n).toBeLessThanOrEqual(north)
    covered += (e - w) * (n - s)
    for (const [w2, s2, e2, n2] of cells.slice(i + 1)) {
      const overlap =
        Math.max(0, Math.min(e, e2) - Math.max(w, w2)) *
        Math.max(0, Math.min(n, n2) - Math.max(s, s2))
      expect(overlap).toBe(0)
    }
  }
  expect(covered).toBeCloseTo((east - west) * (north - south), 12)
}

const timedOut = (data: unknown[]) =>
  Response.json({
    version: 0.6,
    elements: data,
    remark:
      'runtime error: Query timed out in "query" at line 1 after 61 seconds.',
  })

describe('live walking-network requests', () => {
  it.each([
    ['an area over the live limit', wideRequest(70, 70)],
    [
      'an area beyond 85° north',
      { kind: 'live', name: 'North', bounds: [0, 84.99, 0.5, 85.01] },
    ],
    [
      'inverted bounds',
      { kind: 'live', name: 'Inverted', bounds: [0.1, 0, 0, 0.1] },
    ],
    ['missing bounds', { kind: 'live', name: 'Nowhere' }],
  ])('refuses %s without contacting the provider', async (_case, request) => {
    await expect(
      loadMeetingNetwork(request as LiveRequest, progress),
    ).rejects.toThrow(Error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('streams a response larger than 24 MiB into a network', async () => {
    const request = liveRequest()
    const padding = new Uint8Array(1024 * 1024).fill(0x20)
    let unused = 10_000
    let bytes = 0
    const chunks = (function* () {
      const elements = roads(request).elements.map((e) => JSON.stringify(e))
      yield encoder.encode(`{"version":0.6,"elements":[${elements.join(',')}`)
      for (let i = 0; i < 26; i++) {
        let text = ''
        for (let k = 0; k < 500; k++)
          text += `,{"type":"node","id":${unused++},"lat":0.01,"lon":0.01}`
        yield encoder.encode(text)
        yield padding
      }
      yield encoder.encode(']}')
    })()
    const counted = {
      next() {
        const next = chunks.next()
        if (!next.done) bytes += next.value.byteLength
        return next
      },
    } as Iterator<Uint8Array>
    fetchMock.mockResolvedValueOnce(lazyResponse(counted).response)

    const result = await loadMeetingNetwork(request, progress)

    expect(bytes).toBeGreaterThan(26 * 1024 * 1024)
    expect(result.delivery).toBe('downloaded')
    expectRoads(result.network, request)
    expect(entries.size).toBe(1)
  })

  it('stops reading, releases the body and stores nothing when the data is malformed', async () => {
    const request = liveRequest()
    const { response, pull, cancel } = lazyResponse(
      [
        encoder.encode('{"elements":[{"type":"node","id":1,"lat":0,"lon":0},'),
        encoder.encode('{"type":"node","id":1,"lat":0,"lon":0}'),
        encoder.encode(',{"type":"node","id":2,"lat":0,"lon":0}]}'),
      ][Symbol.iterator](),
    )
    fetchMock.mockResolvedValueOnce(response)

    await expect(loadMeetingNetwork(request, progress)).rejects.toThrow(Error)

    expect(pull).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(entries.size).toBe(0)
  })

  it.each([429, 500, 404])(
    'rejects HTTP %i after a single attempt without caching',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }))

      await expect(loadMeetingNetwork(liveRequest(), progress)).rejects.toThrow(
        `HTTP ${status}`,
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(entries.size).toBe(0)
    },
  )

  it('does not retry when the provider cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(loadMeetingNetwork(liveRequest(), progress)).rejects.toThrow(
      Error,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('loading large areas in parts', () => {
  it('requests an area over 800 km² as parts that tile it, one at a time, and joins them into one network', async () => {
    const request = wideRequest(40, 30)
    const server = serve(world(request.bounds))

    const result = await settle(loadMeetingNetwork(request, progress))

    const cells = server.asked.map(({ bounds }) => bounds)
    expect(cells.length).toBeGreaterThan(1)
    expectTiling(cells, request.bounds)
    for (const cell of cells)
      expect(boundsSizeKm(cell).areaKm2).toBeLessThanOrEqual(800)
    expect(server.overlapped()).toBe(false)
    for (let i = 1; i < server.asked.length; i++)
      expect(
        server.asked[i].at - server.asked[i - 1].at,
      ).toBeGreaterThanOrEqual(2000)
    expect(result.delivery).toBe('downloaded')
    expectWorld(result.network, request)
  })

  it('caches a network joined from several parts and serves it as cached', async () => {
    const request = wideRequest(40, 30)
    const server = serve(world(request.bounds))
    const first = await settle(loadMeetingNetwork(request, progress))
    const requests = server.asked.length
    expect(entries.size).toBe(1)

    const again = await loadMeetingNetwork(request, progress)

    expect(again.delivery).toBe('cached')
    // Cached entries pass the network schema check, which keeps no licence field.
    expect(first.network).toMatchObject(again.network)
    expect(server.asked).toHaveLength(requests)
  })

  it('replaces a part the server could not finish in time with its four quarters, keeping nothing from the unfinished answer', async () => {
    const request = liveRequest(0, 8)
    const ghost = [
      {
        type: 'way',
        id: 999,
        nodes: [1002, 9999],
        tags: { highway: 'residential', name: 'Ghost Street' },
      },
      { type: 'node', id: 9999, lon: 0.001, lat: 0.001 },
    ]
    const server = serve(world(request.bounds), (_bbox, call) =>
      call === 1 ? timedOut(ghost) : undefined,
    )

    const result = await settle(loadMeetingNetwork(request, progress))

    expect(server.asked).toHaveLength(5)
    expect(server.asked[0].bounds).toEqual(request.bounds)
    expectTiling(
      server.asked.slice(1).map(({ bounds }) => bounds),
      request.bounds,
    )
    expectWorld(result.network, request)
    expect(
      result.network.places.some(({ name }) => name.includes('Ghost')),
    ).toBe(false)
  })

  it('fails without splitting when a part under 25 km² or an unrelated server error leaves the answer unfinished', async () => {
    const small = liveRequest()
    serve(world(small.bounds), () => timedOut([]))
    await failure(loadMeetingNetwork(small, progress))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockReset()
    const large = liveRequest(0, 8)
    serve(world(large.bounds), () =>
      Response.json({ elements: [], remark: 'runtime error: unknown query' }),
    )
    await failure(loadMeetingNetwork(large, progress))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(entries.size).toBe(0)
  })

  it('splits a part of at least 100 km² after one retry of HTTP 504', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const request = liveRequest(0, 12)
    const server = serve(world(request.bounds), (_bbox, call) =>
      call <= 2 ? busy(504) : undefined,
    )

    const result = await settle(loadMeetingNetwork(request, progress))

    expect(server.asked).toHaveLength(6)
    expect(server.asked[0].bounds).toEqual(request.bounds)
    expect(server.asked[1].bounds).toEqual(request.bounds)
    expectTiling(
      server.asked.slice(2).map(({ bounds }) => bounds),
      request.bounds,
    )
    expectWorld(result.network, request)
  })

  it('retries a first HTTP 504 after a 502 and keeps its Retry-After for the split parts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const request = liveRequest(0, 12)
    const server = serve(world(request.bounds), (_bbox, call) =>
      call === 1
        ? busy(502)
        : call <= 3
          ? busy(504, { 'retry-after': '20' })
          : undefined,
    )

    const result = await settle(loadMeetingNetwork(request, progress))

    expect(server.asked).toHaveLength(7)
    for (const { bounds } of server.asked.slice(0, 3))
      expect(bounds).toEqual(request.bounds)
    const at = server.asked.map((asked) => asked.at)
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(2000)
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(20_000)
    // The first quarter also waits out the Retry-After of the 504 that split it.
    expect(at[3] - at[2]).toBeGreaterThanOrEqual(20_000)
    for (let i = 4; i < at.length; i++)
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(2000)
    expectTiling(
      server.asked.slice(3).map(({ bounds }) => bounds),
      request.bounds,
    )
    expectWorld(result.network, request)
  })

  it('keeps retrying HTTP 504 on a part under 100 km² and never splits it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const request = liveRequest(0, 8)
    const server = serve(world(request.bounds), () => busy(504))

    const error = await failure(loadMeetingNetwork(request, progress))

    expect(error.message).toContain('HTTP 504')
    expect(server.asked).toHaveLength(4)
    for (const { bounds } of server.asked)
      expect(bounds).toEqual(request.bounds)
  })

  it('gives up after a bounded number of requests when parts keep needing splits', async () => {
    const request = wideRequest(60, 60)
    serve(world(request.bounds), (bbox) =>
      boundsSizeKm(bbox).areaKm2 >= 100 ? timedOut([]) : undefined,
    )

    await failure(loadMeetingNetwork(request, progress))

    expect(fetchMock).toHaveBeenCalledTimes(40)
    expect(entries.size).toBe(0)
  })
})

describe('per-request deadlines', () => {
  it.each([
    ['a 4 km square', liveRequest(), 90_000],
    [
      'the 702 km² three-person area',
      {
        kind: 'live',
        name: 'Area around 3 people',
        bounds: [-122.01085, 37.51399, -121.69563, 37.74126],
      } satisfies LiveRequest,
      210_000,
    ],
  ])(
    'stops waiting for headers on %s after the server timeout plus 30 s',
    async (_case, request, wait) => {
      fetchMock.mockImplementation((_input, init) => {
        const { promise, reject } = Promise.withResolvers<Response>()
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        )
        return promise
      })
      let outcome: unknown
      loadMeetingNetwork(request, progress).catch((error: unknown) => {
        outcome = error
      })
      await until(() => fetchMock.mock.calls.length === 1)

      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await until(() => outcome !== undefined)

      expect(outcome).toBeInstanceOf(Error)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    },
  )

  it('stops waiting for the bundled network headers after 30 seconds', async () => {
    fetchMock.mockImplementation((_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>()
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      return promise
    })
    let outcome: unknown
    loadMeetingNetwork(
      { kind: 'preset', dataUrl: '/lab/meeting-point/sf.json' },
      progress,
    ).catch((error: unknown) => {
      outcome = error
    })
    await until(() => fetchMock.mock.calls.length === 1)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await until(() => outcome !== undefined)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain(
      'bundled walking network timed out',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('stops a body that sends nothing for 45 seconds', async () => {
    let sent = false
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streams.push(controller)
        },
        pull(controller) {
          if (!sent) controller.enqueue(encoder.encode('{"elements":['))
          sent = true
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    fetchMock.mockResolvedValueOnce(new Response(body))
    let outcome: unknown
    loadMeetingNetwork(liveRequest(), progress).catch((error: unknown) => {
      outcome = error
    })
    await until(() => sent)

    await vi.advanceTimersByTimeAsync(44_999)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await until(() => outcome !== undefined)

    expect(outcome).toBeInstanceOf(Error)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(entries.size).toBe(0)
  })

  it('stops a body that keeps trickling at the 20-minute load ceiling', async () => {
    let stopTrickle = () => {}
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          streams.push(controller)
          controller.enqueue(encoder.encode('{"elements":['))
        },
        pull(controller) {
          const { promise, resolve } = Promise.withResolvers<void>()
          const timer = setTimeout(() => {
            controller.enqueue(encoder.encode(' '))
            resolve()
          }, 40_000)
          stopTrickle = () => clearTimeout(timer)
          return promise
        },
        cancel() {
          stopTrickle()
        },
      },
      { highWaterMark: 0 },
    )
    fetchMock.mockResolvedValueOnce(new Response(body))
    const started = Date.now()

    await failure(loadMeetingNetwork(liveRequest(), progress))

    expect(Date.now() - started).toBeGreaterThanOrEqual(20 * 60_000)
    expect(Date.now() - started).toBeLessThan(20 * 60_000 + 1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('retrying a provider at capacity', () => {
  it.each([
    [0.5, 2000],
    [0, 1600],
  ])(
    'retries HTTP 502 once the jittered backoff has elapsed (random %f)',
    async (random, delay) => {
      vi.spyOn(Math, 'random').mockReturnValue(random)
      const request = liveRequest()
      const failed = lazyResponse(
        [encoder.encode('# 502 Gateway Timeout')][Symbol.iterator](),
        502,
      )
      fetchMock.mockResolvedValueOnce(failed.response)
      respond(request)

      const loading = loadMeetingNetwork(request, progress)
      await until(retryWaiting)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(failed.cancel).toHaveBeenCalledTimes(1)
      expect(
        progress.mock.calls.some(([message]) => message.includes('HTTP 502')),
      ).toBe(true)

      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      const result = await loading

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.delivery).toBe('downloaded')
      expectRoads(result.network, request)
    },
  )

  it('caches a network obtained on a retry like a first-attempt download', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const request = liveRequest()
    fetchMock.mockResolvedValueOnce(busy(503))
    respond(request)

    const loading = loadMeetingNetwork(request, progress)
    await until(retryWaiting)
    await vi.advanceTimersByTimeAsync(2000)
    expect((await loading).delivery).toBe('downloaded')
    expect(entries.size).toBe(1)

    const again = await loadMeetingNetwork(request, progress)
    expect(again.delivery).toBe('cached')
    expectRoads(again.network, request)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits at least a Retry-After of 10 seconds before the second attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const request = liveRequest()
    fetchMock.mockResolvedValueOnce(busy(502, { 'retry-after': '10' }))
    respond(request)

    const loading = loadMeetingNetwork(request, progress)
    await until(retryWaiting)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect((await loading).delivery).toBe('downloaded')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honours an HTTP-date Retry-After header within 30 seconds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const request = liveRequest()
    const tenSecondsLater = new Date(Date.now() + 10_000).toUTCString()
    fetchMock.mockResolvedValueOnce(
      busy(502, { 'retry-after': tenSecondsLater }),
    )
    respond(request)

    const loading = loadMeetingNetwork(request, progress)
    await until(retryWaiting)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect((await loading).delivery).toBe('downloaded')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after four busy answers and names the last status', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    for (const status of [502, 503, 504, 502])
      fetchMock.mockResolvedValueOnce(busy(status))

    const loading = loadMeetingNetwork(liveRequest(), progress)
    const settled = loading.then(
      () => new Error('Expected the load to fail.'),
      (error: unknown) => error,
    )
    for (const delay of [2000, 4000, 8000]) {
      await until(retryWaiting)
      await vi.advanceTimersByTimeAsync(delay)
    }
    const error = await settled

    expect(error).toBeInstanceOf(Error)
    const { message } = error as Error
    expect(message).toContain('HTTP 502')
    expect(message).not.toMatch(/HTTP 50[34]/)
    expect(message).toMatch(/\b4\b/)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(entries.size).toBe(0)
  })
})

describe('persistent walking-network cache', () => {
  it('uses fresh cached data but redownloads at the seven-day expiry boundary', async () => {
    const request = liveRequest()
    respond(request)
    const first = await loadMeetingNetwork(request, progress)
    expect(first.delivery).toBe('downloaded')
    expectRoads(first.network, request)

    vi.setSystemTime(startTime + sevenDays - 1)
    const fresh = await loadMeetingNetwork(request, progress)
    expect(fresh.delivery).toBe('cached')
    expectRoads(fresh.network, request)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(startTime + sevenDays)
    respond(request, 'Replacement Street')
    const expired = await loadMeetingNetwork(request, progress)
    expect(expired.delivery).toBe('downloaded')
    expectRoads(expired.network, request, 'Replacement Street')
    expect(entries.size).toBe(1)

    const refreshed = await loadMeetingNetwork(request, progress)
    expect(refreshed.delivery).toBe('cached')
    expectRoads(refreshed.network, request, 'Replacement Street')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps only the three newest stored areas when a fourth is downloaded', async () => {
    const requests = [0, 1, 2, 3].map((longitude) => liveRequest(longitude))
    for (const [index, request] of requests.entries()) {
      vi.setSystemTime(startTime + index * 1000)
      respond(request)
      const result = await loadMeetingNetwork(request, progress)
      expect(result.delivery).toBe('downloaded')
      expectRoads(result.network, request)
      expect(entries.size).toBe(Math.min(index + 1, 3))
    }

    for (const request of requests.slice(1)) {
      const retained = await loadMeetingNetwork(request, progress)
      expect(retained.delivery).toBe('cached')
      expectRoads(retained.network, request)
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)

    const oldest = requests[0]
    respond(oldest)
    const evicted = await loadMeetingNetwork(oldest, progress)
    expect(evicted.delivery).toBe('downloaded')
    expectRoads(evicted.network, oldest)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(entries.size).toBe(3)
  })

  it('keys the cache by the requested area', async () => {
    const square = liveRequest()
    respond(square)
    await loadMeetingNetwork(square, progress)
    const [west, south, east, north] = square.bounds
    const wider: LiveRequest = {
      ...square,
      bounds: [west - 0.001, south, east, north],
    }
    respond(wider)

    const result = await loadMeetingNetwork(wider, progress)

    expect(result.delivery).toBe('downloaded')
    expect(result.network.bounds).toEqual(wider.bounds)
    expect(entries.size).toBe(2)
  })

  it('serves an entry stored under the older key with a study size and moves it to the area key, keeping its time', async () => {
    const request = liveRequest()
    respond(request)
    await loadMeetingNetwork(request, progress)
    const stored = entries.entries().next().value
    if (!stored) throw new Error('Expected the downloaded network in cache.')
    const [key, entry] = stored
    entries.clear()
    const legacy = new URL(key)
    legacy.searchParams.set('sizeKm', '4')
    const storedAt = startTime - 60_000
    entries.set(legacy.href, {
      body: entry.body,
      headers: new Headers({
        'content-type': 'application/json',
        'x-meeting-network-stored-at': String(storedAt),
      }),
    })

    const migrated = await loadMeetingNetwork(request, progress)

    expect(migrated.delivery).toBe('cached')
    expectRoads(migrated.network, request)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect([...entries.keys()]).toEqual([key])
    expect(entries.get(key)?.headers.get('x-meeting-network-stored-at')).toBe(
      String(storedAt),
    )

    // The seven days still count from when the entry was first stored.
    vi.setSystemTime(storedAt + sevenDays)
    respond(request, 'Replacement Street')
    const expired = await loadMeetingNetwork(request, progress)
    expect(expired.delivery).toBe('downloaded')
    expectRoads(expired.network, request, 'Replacement Street')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['invalid JSON', 'invalid graph'])(
    'redownloads and replaces a fresh cache entry containing %s',
    async (corruption) => {
      const request = liveRequest()
      respond(request)
      const first = await loadMeetingNetwork(request, progress)
      expect(first.delivery).toBe('downloaded')
      expectRoads(first.network, request)
      const stored = entries.entries().next().value
      if (!stored) throw new Error('Expected the downloaded network in cache.')
      const [key, entry] = stored
      const body =
        corruption === 'invalid JSON'
          ? '{'
          : JSON.stringify({
              ...first.network,
              edges: [[0, first.network.nodes.length, 111]],
            })
      await cache.put(key, new Response(body, { headers: entry.headers }))

      respond(request, 'Replacement Street')
      const recovered = await loadMeetingNetwork(request, progress)
      expect(recovered.delivery).toBe('downloaded')
      expectRoads(recovered.network, request, 'Replacement Street')
      expect(entries.size).toBe(1)

      const repaired = await loadMeetingNetwork(request, progress)
      expect(repaired.delivery).toBe('cached')
      expectRoads(repaired.network, request, 'Replacement Street')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )
})
