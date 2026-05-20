/**
 * Smoke tests for src/lib/gatus.ts
 *
 * Covers:
 *   - formatUptime, formatResponse  (pure)
 *   - gatusEndpointDetailUrl         (pure)
 *   - PUBLIC_ENDPOINT_URLS           (sanity check on registry shape)
 *   - getGatusSummary                (uses fetch — mocked)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatUptime,
  formatResponse,
  gatusEndpointDetailUrl,
  getGatusSummary,
  PUBLIC_ENDPOINT_URLS,
} from './gatus'

describe('formatUptime', () => {
  it('returns "0%" for non-finite or non-positive', () => {
    expect(formatUptime(0)).toBe('0%')
    expect(formatUptime(NaN)).toBe('0%')
    expect(formatUptime(-1)).toBe('0%')
  })

  it('returns "100%" exactly for ratios at or above 0.99995', () => {
    expect(formatUptime(1)).toBe('100%')
    expect(formatUptime(0.99996)).toBe('100%')
  })

  it('renders 2-decimal percentages below 100%', () => {
    expect(formatUptime(0.5)).toBe('50.00%')
    expect(formatUptime(0.99583)).toBe('99.58%')
  })
})

describe('formatResponse', () => {
  it('returns "N/A" for non-positive', () => {
    expect(formatResponse(0)).toBe('N/A')
    expect(formatResponse(-50)).toBe('N/A')
    expect(formatResponse(NaN)).toBe('N/A')
  })

  it('renders ms below 1000ms', () => {
    expect(formatResponse(133)).toBe('133ms')
    expect(formatResponse(1)).toBe('1ms')
  })

  it('renders seconds for >= 1000ms', () => {
    expect(formatResponse(1500)).toBe('1.50s')
    expect(formatResponse(1820)).toBe('1.82s')
  })
})

describe('gatusEndpointDetailUrl', () => {
  it('builds standard /endpoints/<key> URL', () => {
    expect(gatusEndpointDetailUrl('https://status.codeseys.io', 'core_app')).toBe(
      'https://status.codeseys.io/endpoints/core_app',
    )
  })

  it('strips trailing slash from source URL', () => {
    expect(gatusEndpointDetailUrl('https://status.codeseys.io/', 'a_b')).toBe(
      'https://status.codeseys.io/endpoints/a_b',
    )
  })

  it('URL-encodes endpoint keys with special characters', () => {
    // Real-world Gatus keys are simple, but be defensive.
    expect(gatusEndpointDetailUrl('https://example.com', 'g_a/b')).toBe(
      'https://example.com/endpoints/g_a%2Fb',
    )
  })
})

describe('PUBLIC_ENDPOINT_URLS', () => {
  it('values are absolute https URLs', () => {
    for (const [key, url] of Object.entries(PUBLIC_ENDPOINT_URLS)) {
      expect(url, `key=${key}`).toMatch(/^https?:\/\//)
    }
  })
})

describe('getGatusSummary', () => {
  // Use real keys that exist in PUBLIC_ENDPOINT_URLS so we can verify the
  // publicUrl annotation flows through end-to-end.
  const PUBLIC_KEY = '_homepage-public'
  const PUBLIC_URL = 'https://codeseys.io'
  const INTERNAL_KEY = 'infrastructure_cluster-dns'

  const sampleResponse = [
    {
      name: 'Codeseys',
      key: PUBLIC_KEY,
      group: '',
      results: [
        { duration: 50_000_000, success: true, status: 200, timestamp: '2025-06-01T00:00:00Z' },
        { duration: 60_000_000, success: true, status: 200, timestamp: '2025-06-01T00:01:00Z' },
        { duration: 80_000_000, success: false, status: 502, timestamp: '2025-06-01T00:02:00Z' },
      ],
    },
    {
      name: 'Cluster DNS',
      key: INTERNAL_KEY,
      group: 'Infrastructure',
      results: [
        // No `status` field — TCP/DNS-style probe.
        { duration: 5_000_000, success: true, timestamp: '2025-06-01T00:02:00Z' },
      ],
    },
  ]

  let originalFetch: typeof globalThis.fetch
  let originalCaches: typeof globalThis.caches | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalCaches = (globalThis as { caches?: typeof globalThis.caches }).caches
    // Disable Worker cache during tests so each call hits the mocked fetch.
    delete (globalThis as { caches?: typeof globalThis.caches }).caches
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalCaches) {
      (globalThis as { caches?: typeof globalThis.caches }).caches = originalCaches
    }
    vi.restoreAllMocks()
  })

  it('parses Gatus response into a typed summary', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const summary = await getGatusSummary({ STATUS_GATUS_URL: 'https://status.codeseys.io' })
    expect(summary).not.toBeNull()
    expect(summary!.endpoints).toHaveLength(2)
    expect(summary!.aggregate.total).toBe(2)
    // public-surface_codeseys-io most-recent result was a 502 → not up.
    // infra_dns most-recent was success.
    expect(summary!.aggregate.up).toBe(1)
    expect(summary!.aggregate.down).toBe(1)

    const codeseysEndpoint = summary!.endpoints.find(
      (e) => e.key === PUBLIC_KEY,
    )
    expect(codeseysEndpoint).toBeDefined()
    // detailUrl always populated.
    expect(codeseysEndpoint!.detailUrl).toBe(
      `https://status.codeseys.io/endpoints/${encodeURIComponent(PUBLIC_KEY)}`,
    )
    // publicUrl populated because key matches PUBLIC_ENDPOINT_URLS.
    expect(codeseysEndpoint!.publicUrl).toBe(PUBLIC_URL)

    // Internal endpoint: detailUrl yes, publicUrl undefined.
    const dnsEndpoint = summary!.endpoints.find((e) => e.key === INTERNAL_KEY)!
    expect(dnsEndpoint.detailUrl).toBe(
      `https://status.codeseys.io/endpoints/${encodeURIComponent(INTERNAL_KEY)}`,
    )
    expect(dnsEndpoint.publicUrl).toBeUndefined()
    // No HTTP status field → current.status undefined.
    expect(dnsEndpoint.current.status).toBeUndefined()
  })

  it('converts duration nanoseconds to milliseconds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sampleResponse), { status: 200 }),
    )
    const summary = await getGatusSummary()
    const codeseys = summary!.endpoints.find((e) => e.key === PUBLIC_KEY)!
    // Last result was 80_000_000 ns → 80 ms.
    expect(codeseys.current.durationMs).toBe(80)
  })

  it('pads recentHistory to 30 buckets when fewer probes exist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sampleResponse), { status: 200 }),
    )
    const summary = await getGatusSummary()
    for (const ep of summary!.endpoints) {
      expect(ep.recentHistory).toHaveLength(30)
    }
    // Front-padding null, then real booleans at the end.
    const codeseys = summary!.endpoints.find((e) => e.key === PUBLIC_KEY)!
    expect(codeseys.recentHistory.slice(0, 27).every((v) => v === null)).toBe(true)
    expect(codeseys.recentHistory.slice(27)).toEqual([true, true, false])
  })

  it('returns null on upstream non-OK', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('no available server', { status: 503 }))
    // Silence the expected error log so test output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await getGatusSummary()
    expect(summary).toBeNull()
  })

  it('returns null on fetch rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('econnrefused'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const summary = await getGatusSummary()
    expect(summary).toBeNull()
  })

  it('uses STATUS_GATUS_URL when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    )
    globalThis.fetch = fetchMock

    await getGatusSummary({ STATUS_GATUS_URL: 'https://status.example.com' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://status.example.com/api/v1/endpoints/statuses',
      expect.any(Object),
    )
  })

  it('falls back to default Gatus URL when env is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    )
    globalThis.fetch = fetchMock

    await getGatusSummary()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://status.codeseys.io/api/v1/endpoints/statuses',
      expect.any(Object),
    )
  })

  it('returns aggregate of zeros for empty endpoint list', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    const summary = await getGatusSummary()
    expect(summary).not.toBeNull()
    expect(summary!.aggregate).toEqual({
      total: 0,
      up: 0,
      down: 0,
      uptimeRatio: 0,
      avgResponseMs: 0,
    })
    expect(summary!.lastSeen).toBeNull()
  })
})
