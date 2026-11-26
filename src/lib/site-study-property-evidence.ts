import { isSameSiteRequest } from './meeting-live-server'
import { studyBounds } from './site-study'

export const parcelSource =
  'https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer/0'
export const floodSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/439'
export const propertyEvidenceSeconds = 24 * 60 * 60

type Parcel = { apn: string; jurisdiction: string | null }
type FloodZone = {
  zone: string
  description: string | null
  specialFloodHazardArea: boolean | null
}
type Observation<T> = {
  checkedAt: string
  matches: T[]
  truncated: boolean
}
export type PropertyEvidence = {
  parcel: Observation<Parcel> | null
  flood: Observation<FloodZone> | null
}

export type PropertyEvidenceEnv = {
  PROPERTY_EVIDENCE_REFRESH?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parcel(attributes: Record<string, unknown>): Parcel | null {
  const apn = text(attributes.APN)
  return apn ? { apn, jurisdiction: text(attributes.JURISDICTION) } : null
}

function flood(attributes: Record<string, unknown>): FloodZone | null {
  const zone = text(attributes.FLDZONE)
  if (!zone) return null
  const flag = attributes.SFHATF
  return {
    zone,
    description: text(attributes.ZONESUBTY),
    specialFloodHazardArea: flag === 'T' ? true : flag === 'F' ? false : null,
  }
}

function boundedCoordinate(value: string | null, min: number, max: number) {
  if (!value || !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(value)) return null
  const number = Number(value)
  return number >= min && number <= max ? number : null
}

async function readCache<T>(cache: Cache | undefined, key: Request) {
  try {
    const hit = await cache?.match(key)
    return hit ? ((await hit.json()) as Observation<T>) : null
  } catch {
    return null
  }
}

async function lookup<T>(
  geometry: string,
  layer: string,
  outFields: string,
  map: (attributes: Record<string, unknown>) => T | null,
  key: Request,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<Observation<T> | null> {
  const url = new URL(`${layer}/query`)
  url.search = new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    resultRecordCount: '5',
    f: 'json',
  }).toString()
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(7000),
      redirect: 'manual',
    })
    if (!response.ok) return null
    const value = (await response.json()) as {
      error?: unknown
      features?: { attributes?: Record<string, unknown> }[]
      exceededTransferLimit?: boolean
    }
    if (!value || value.error || !Array.isArray(value.features)) return null
    const matches: T[] = []
    const seen = new Set<string>()
    for (const feature of value.features.slice(0, 5)) {
      const match = feature?.attributes && map(feature.attributes)
      if (!match) return null
      const identifier = JSON.stringify(match)
      if (seen.has(identifier)) continue
      seen.add(identifier)
      matches.push(match)
    }
    const observation = {
      checkedAt: new Date().toISOString(),
      matches,
      truncated:
        value.exceededTransferLimit === true || value.features.length > 5,
    }
    try {
      await cache?.put(
        key,
        Response.json(observation, {
          headers: {
            'Cache-Control': `public, max-age=${propertyEvidenceSeconds}`,
          },
        }),
      )
    } catch {
      // Keep the fresh result if the edge cache is unavailable.
    }
    return observation
  } catch {
    return null
  }
}

function respond(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  })
}

export async function handlePropertyEvidenceRequest(
  request: Request,
  env: PropertyEvidenceEnv,
  cache: Cache | undefined,
  fetcher: typeof fetch = fetch,
) {
  if (!isSameSiteRequest(request)) return respond({ error: 'forbidden' }, 403)
  const url = new URL(request.url)
  const [west, south, east, north] = studyBounds
  const lng = boundedCoordinate(url.searchParams.get('lng'), west, east)
  const lat = boundedCoordinate(url.searchParams.get('lat'), south, north)
  if (lng === null || lat === null)
    return respond({ error: 'outside_coverage' }, 400)

  const geometry = `${lng},${lat}`
  const path = `/_internal/property-evidence/v1/${geometry}/`
  const parcelKey = new Request(new URL(`${path}parcel`, url))
  const floodKey = new Request(new URL(`${path}flood`, url))
  const [cachedParcel, cachedFlood] = await Promise.all([
    readCache<Parcel>(cache, parcelKey),
    readCache<FloodZone>(cache, floodKey),
  ])
  if (cachedParcel && cachedFlood)
    return respond({ parcel: cachedParcel, flood: cachedFlood })

  const limit = env.PROPERTY_EVIDENCE_REFRESH
  if (!limit) return respond({ error: 'not_configured' }, 503)
  const { success } = await limit
    .limit({ key: 'san-jose-property-evidence' })
    .catch(() => ({ success: false }))
  if (!success) {
    return cachedParcel || cachedFlood
      ? respond({ parcel: cachedParcel, flood: cachedFlood })
      : respond({ error: 'rate_limited' }, 429)
  }

  const [parcelResult, floodResult] = await Promise.all([
    cachedParcel ??
      lookup(
        geometry,
        parcelSource,
        'APN,JURISDICTION',
        parcel,
        parcelKey,
        cache,
        fetcher,
      ),
    cachedFlood ??
      lookup(
        geometry,
        floodSource,
        'FLDZONE,ZONESUBTY,SFHATF',
        flood,
        floodKey,
        cache,
        fetcher,
      ),
  ])
  return respond({
    parcel: parcelResult,
    flood: floodResult,
  } satisfies PropertyEvidence)
}
