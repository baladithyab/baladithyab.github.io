import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadMeetingNetwork,
  regionBounds,
  type NetworkRequest,
} from './meeting-network-loader'
import type { MeetingNetwork } from './meeting-point'

const provider = 'https://roads.example/overpass'
const startTime = Date.UTC(2026, 10, 12)
const sevenDays = 7 * 24 * 60 * 60 * 1000
// Assert the advertised contract independently of the implementation constants.
const downloadLimit = 24 * 1024 * 1024
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
    for (const controller of streams)
      controller.error(new Error('Loader test stream cleanup.'))
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

function liveRequest(longitude = 0): LiveRequest {
  return {
    kind: 'live',
    name: `Test area ${longitude}`,
    coordinate: [longitude, 0],
    sizeKm: 4,
  }
}

function roads(request: LiveRequest, street = 'Main Street') {
  const [lon, lat] = request.coordinate
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
  const [lon, lat] = request.coordinate
  expect(network).toMatchObject({
    version: 1,
    name: request.name,
    bounds: regionBounds(request.coordinate, request.sizeKm),
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

function streamedResponse(chunks: Uint8Array[], headers: HeadersInit) {
  let next = 0
  const cancel = vi.fn()
  const pull = vi.fn(
    (controller: ReadableStreamDefaultController<Uint8Array>) => {
      const chunk = chunks[next++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
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
  return { response: new Response(body, { headers }), pull, cancel }
}

describe('walking-network download boundaries', () => {
  it('cancels a decoded stream over 24 MiB even when Content-Length is small', async () => {
    const request = liveRequest()
    const payload = new TextEncoder().encode(JSON.stringify(roads(request)))
    const padding = new Uint8Array(1024 * 1024).fill(0x20)
    // Valid JSON with leading whitespace: removing the cap would accept it.
    const { response, pull, cancel } = streamedResponse(
      [...Array.from({ length: 24 }, () => padding), payload],
      { 'content-length': String(payload.byteLength) },
    )
    fetchMock.mockResolvedValueOnce(response)

    await expect(loadMeetingNetwork(request, progress)).rejects.toThrow(Error)

    expect(pull).toHaveBeenCalledTimes(25)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(entries.size).toBe(0)
  })

  it('rejects an oversized Content-Length before reading any body bytes', async () => {
    const request = liveRequest()
    const { response, pull } = streamedResponse(
      [new TextEncoder().encode(JSON.stringify(roads(request)))],
      { 'content-length': String(downloadLimit + 1) },
    )
    fetchMock.mockResolvedValueOnce(response)

    await expect(loadMeetingNetwork(request, progress)).rejects.toThrow(Error)

    expect(pull).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(entries.size).toBe(0)
  })

  it.each([429, 503])(
    'rejects HTTP %i without retrying or caching',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }))

      await expect(loadMeetingNetwork(liveRequest(), progress)).rejects.toThrow(
        Error,
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(entries.size).toBe(0)
    },
  )
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
    const requests = [0, 1, 2, 3].map(liveRequest)
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
