/**
 * Gatus client — fetches monitoring data from a self-hosted Gatus instance.
 *
 * Default endpoint is the operator's `https://status.codeseys.io`. Override
 * with the `STATUS_GATUS_URL` Worker secret/var if pointing at a different
 * Gatus deployment.
 *
 * Cached for 60s in `caches.default` so the Worker doesn't hammer Gatus on
 * every page load.
 */

export interface GatusEnv {
  STATUS_GATUS_URL?: string
}

const DEFAULT_GATUS_URL = 'https://status.codeseys.io'
const CACHE_TTL_SECONDS = 60

interface GatusConditionResult {
  condition: string
  success: boolean
}

interface GatusResultEntry {
  status?: number          // HTTP probes only — TCP/DNS/ICMP probes omit
  hostname?: string
  duration: number          // nanoseconds
  conditionResults?: GatusConditionResult[]
  success: boolean
  timestamp: string         // ISO 8601
}

interface GatusEndpointStatus {
  name: string
  key: string
  results: GatusResultEntry[]
  /** Optional group label (Gatus supports nesting endpoints under groups) */
  group?: string
}

export interface GatusEndpoint {
  /** Display name as shown in the Gatus dashboard */
  name: string
  /** Unique stable key — used by `/api/v1/endpoints/{key}/...` URLs */
  key: string
  /** Optional group label */
  group?: string
  /** Most recent observation */
  current: {
    success: boolean
    /** HTTP status (HTTP probes) — undefined for TCP/DNS/ICMP/PING */
    status?: number
    /** Round-trip time in milliseconds */
    durationMs: number
    /** ISO timestamp of the last probe */
    timestamp: string
  }
  /** Uptime ratio derived from the most recent N probes (0..1) */
  recentUptime: number
  /** How many probes contributed to the recentUptime ratio */
  recentSamples: number
  /** Last 30 probe outcomes (true = healthy), oldest → newest. Padded with `null` if fewer recorded. */
  recentHistory: Array<boolean | null>
  /**
   * Direct deep-link to this endpoint's detail page on the Gatus dashboard.
   * Always present — even for "internal" endpoints we don't want to leak the
   * upstream URL of, the detail page on Gatus is fine to link to.
   */
  detailUrl: string
  /**
   * Optional public URL for the upstream service this endpoint probes. Only
   * populated for endpoints that have an entry in `PUBLIC_ENDPOINT_URLS` —
   * Gatus deliberately doesn't expose probe URLs over its public API to keep
   * internal hostnames private, so opt-in here is the right default.
   */
  publicUrl?: string
}

export interface GatusSummary {
  /** Source URL (lets the page link back to the live Gatus dashboard) */
  sourceUrl: string
  /** All monitored endpoints, in the order Gatus returned them */
  endpoints: GatusEndpoint[]
  /** Aggregate over all endpoints — convenient for the overview card */
  aggregate: {
    total: number
    up: number
    down: number
    /** Mean uptime ratio across endpoints (0..1) */
    uptimeRatio: number
    /** Mean response time in ms across endpoints with HTTP latencies */
    avgResponseMs: number
  }
  /** Wall-clock timestamp of the most recent Gatus result we saw */
  lastSeen: string | null
}

const HISTORY_BUCKETS = 30

function nsToMs(ns: number): number {
  return ns / 1_000_000
}

/**
 * Public-URL registry — explicit opt-in mapping from Gatus endpoint key to
 * the user-facing URL of the underlying service.
 *
 * **Why this exists:** Gatus's public API does NOT expose the probe target URL
 * (security choice in their `Status` struct). To let visitors click an
 * endpoint and land on the actual app, we maintain this small registry of
 * keys we've explicitly decided are safe to surface publicly.
 *
 * **Adding entries:** the key must match the Gatus endpoint key exactly.
 * Inspect the full list at `https://status.codeseys.io/api/v1/endpoints/statuses`
 * — each entry's `"key"` field is the canonical identifier. Format is
 * `<group>_<name>` lowercased with spaces and parens preserved as Gatus emits
 * them. Endpoints without a group get a leading underscore (e.g. `_argocd`).
 *
 * Internal/private endpoints (databases, admin panels, internal services)
 * should be omitted — they'll still get a Gatus deep-link as a fallback.
 *
 * Operator: edit this map to surface direct-app links for each public
 * service. Any unmapped endpoint will only get the Gatus detail-page link.
 */
export const PUBLIC_ENDPOINT_URLS: Record<string, string> = {
  // --- External (publicly accessible) ---
  'external_argocd-(public)': 'https://argocd.codeseys.io',
  'external_authentik-sso-(public)': 'https://auth.codeseys.io',
  'external_config-portal-(public)': 'https://config.codeseys.io',
  'external_glance-(public)': 'https://glance.codeseys.io',
  'external_grafana-(public)': 'https://grafana.codeseys.io',
  'external_headlamp-(public)': 'https://headlamp.codeseys.io',
  'external_home-assistant-(public)': 'https://home.codeseys.io',
  'external_homepage-(public)': 'https://homepage.codeseys.io',
  'external_status-page-(public)': 'https://status.codeseys.io',
  'external_tdarr-(public)': 'https://tdarr.codeseys.io',
  // node-info and plex-tcp left out — node-info is informational and Plex's
  // TCP probe doesn't have a clean web URL to surface.

  // --- Personal apps (the underscore-prefixed group) — these are the
  // operator's local self-hosted apps. Several of them have public URLs.
  '_homepage-public': 'https://codeseys.io',
  '_gatus': 'https://status.codeseys.io',

  // The remaining underscore-prefixed entries (argocd, bazarr, jellyfin,
  // sonarr, etc.) are the operator's *arr stack — not publicly exposed,
  // so they only get Gatus detail-page links. Add entries here if/when
  // any get a public URL.
}

/**
 * Build a deep-link to a specific endpoint's detail page on the Gatus
 * dashboard. Form: `https://status.codeseys.io/endpoints/<key>` — verified
 * against the upstream Gatus SPA route in `Details.vue`.
 */
export function gatusEndpointDetailUrl(sourceUrl: string, key: string): string {
  return `${sourceUrl.replace(/\/$/, '')}/endpoints/${encodeURIComponent(key)}`
}

function buildEndpoint(raw: GatusEndpointStatus, sourceUrl: string): GatusEndpoint {
  const results = raw.results ?? []
  const latest = results[results.length - 1]

  // Recent history: take the last HISTORY_BUCKETS results, oldest → newest.
  // Pad the front with `null` if Gatus has fewer historical entries than buckets,
  // so the bar chart renders consistent width.
  const sliceCount = Math.min(HISTORY_BUCKETS, results.length)
  const recent = results.slice(-sliceCount)
  const padding: Array<boolean | null> = Array(HISTORY_BUCKETS - sliceCount).fill(null)
  const recentHistory = [...padding, ...recent.map((r) => r.success)]

  const succeeded = recent.reduce((acc, r) => acc + (r.success ? 1 : 0), 0)
  const recentUptime = recent.length === 0 ? 0 : succeeded / recent.length

  return {
    name: raw.name,
    key: raw.key,
    group: raw.group,
    current: {
      success: latest?.success ?? false,
      status: latest?.status,
      durationMs: latest ? nsToMs(latest.duration) : 0,
      timestamp: latest?.timestamp ?? new Date(0).toISOString(),
    },
    recentUptime,
    recentSamples: recent.length,
    recentHistory,
    detailUrl: gatusEndpointDetailUrl(sourceUrl, raw.key),
    publicUrl: PUBLIC_ENDPOINT_URLS[raw.key],
  }
}

function aggregate(endpoints: GatusEndpoint[]): GatusSummary['aggregate'] {
  const total = endpoints.length
  if (total === 0) {
    return { total: 0, up: 0, down: 0, uptimeRatio: 0, avgResponseMs: 0 }
  }
  const up = endpoints.reduce((acc, ep) => acc + (ep.current.success ? 1 : 0), 0)
  const down = total - up
  const uptimeRatio = endpoints.reduce((acc, ep) => acc + ep.recentUptime, 0) / total

  // Average response time only across endpoints we got a duration for (skip 0/missing)
  const withLatency = endpoints.filter((ep) => ep.current.durationMs > 0)
  const avgResponseMs = withLatency.length
    ? withLatency.reduce((acc, ep) => acc + ep.current.durationMs, 0) / withLatency.length
    : 0

  return { total, up, down, uptimeRatio, avgResponseMs }
}

function latestTimestamp(endpoints: GatusEndpoint[]): string | null {
  if (endpoints.length === 0) return null
  return endpoints
    .map((ep) => ep.current.timestamp)
    .filter((ts) => ts && ts !== new Date(0).toISOString())
    .sort()
    .pop() ?? null
}

/**
 * Fetch the live Gatus snapshot. Returns `null` if Gatus is unreachable so
 * the page can render a graceful "data unavailable" state without blowing up.
 *
 * Internally caches the parsed `GatusSummary` for 60s in `caches.default`, so
 * a burst of page loads only triggers one upstream Gatus call per minute.
 */
export async function getGatusSummary(runtimeEnv?: GatusEnv): Promise<GatusSummary | null> {
  const sourceUrl = (runtimeEnv?.STATUS_GATUS_URL ?? DEFAULT_GATUS_URL).replace(/\/$/, '')
  const cacheKey = new Request(`https://codeseys.io/__cache/gatus/${encodeURIComponent(sourceUrl)}`)

  try {
    if (typeof caches !== 'undefined' && 'default' in caches) {
      const cache = (caches as any).default
      const cached = await cache.match(cacheKey)
      if (cached) {
        return cached.json() as Promise<GatusSummary>
      }
    }

    const upstream = await fetch(`${sourceUrl}/api/v1/endpoints/statuses`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'codeseys-website-status',
      },
    })

    if (!upstream.ok) {
      console.error('Gatus upstream non-OK:', upstream.status, upstream.statusText)
      return null
    }

    const raw = (await upstream.json()) as GatusEndpointStatus[]
    const endpoints = raw.map((r) => buildEndpoint(r, sourceUrl))
    const summary: GatusSummary = {
      sourceUrl,
      endpoints,
      aggregate: aggregate(endpoints),
      lastSeen: latestTimestamp(endpoints),
    }

    if (typeof caches !== 'undefined' && 'default' in caches) {
      const cache = (caches as any).default
      const cacheRes = new Response(JSON.stringify(summary), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      })
      await cache.put(cacheKey, cacheRes.clone())
    }

    return summary
  } catch (err) {
    console.error('Error fetching Gatus summary:', err)
    return null
  }
}

/** Format an uptime ratio (0..1) as a rounded percentage string. */
export function formatUptime(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const pct = ratio * 100
  // Show the precision Gatus shows: 2 decimal places below 100%, "100%" exactly otherwise.
  if (pct >= 99.995) return '100%'
  return `${pct.toFixed(2)}%`
}

/** Format duration ms as a friendly string. */
export function formatResponse(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'N/A'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}
