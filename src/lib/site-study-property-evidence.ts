import { isSameSiteRequest } from './meeting-live-server'
import { studyBounds } from './site-study'

export const parcelSource =
  'https://maps.santaclaracounty.gov/server/rest/services/property/SCCProperty/MapServer/0'
export const floodSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/439'
export const zoningSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/401'
export const generalPlanSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/404'
export const heightLimitSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer/84'
export const majorDevelopmentsSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/455'
export const activePermitsSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/8'
export const expiredPermitsSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/9'
export const codeComplaintsSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/1'
export const historicSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/406'
export const seismicSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer/81'
export const wildfireSource =
  'https://geo.sanjoseca.gov/server/rest/services/FIR/FIR_AllReferenceLayers/MapServer/4'
export const damInundationSource =
  'https://geo.sanjoseca.gov/server/rest/services/OEM/OEM_WaterHazards/MapServer/9'
export const calEnviroSource =
  'https://geo.sanjoseca.gov/server/rest/services/HSG/HSG_HousingMapLayers/MapServer/17'
export const corteseSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_LandDesignations/MapServer/31'
export const policeBeatSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_PermitsAndComplaints/MapServer/13'
export const crashesSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/553'
export const sjpdCkanPackageSource =
  'https://data.sanjoseca.gov/api/3/action/package_show?id=police-calls-for-service-quarterly'
export const sjpdCkanSqlBase =
  'https://data.sanjoseca.gov/api/3/action/datastore_search_sql'
export const neighborhoodSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/549'
export const schoolDistrictSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/343'
export const nearbySchoolsSource =
  'https://maps.santaclaracounty.gov/server/rest/services/opendata/SCCGISHUB/MapServer/19'
export const transitCorridorSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_LandDesignations/MapServer/32'
export const parksSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/188'
export const roadNoiseSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/367'
export const airportNoiseSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_Geocortex_Public_PRD/MapServer/1'
export const freewayBufferSource =
  'https://geo.sanjoseca.gov/server/rest/services/PLN/PLN_LandDesignations/MapServer/30'
export const tractMarketSource =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/545'

export const propertyEvidenceSeconds = 24 * 60 * 60

export type Parcel = {
  apn: string
  jurisdiction: string | null
  taxRateArea?: number | null
  situsAddress?: string | null
  streetQuery?: string | null
  lotSqft?: number | null
}
export type FloodZone = {
  zone: string
  description: string | null
  specialFloodHazardArea: boolean | null
}
export type Observation<T> = {
  checkedAt: string
  matches: T[]
  truncated: boolean
}

export type ZoningObservation = {
  checkedAt: string
  zoning: string | null
  pdUse: string | null
  zoningNotes: string | null
  generalPlan: string | null
  heightLimit: string | null
  heightCodeSection: string | null
  nearbyDevelopments: {
    name: string
    type: string | null
    status: string | null
    height: string | null
  }[]
}

export type PermitSummary = {
  folder: string
  work: string | null
  sub: string | null
  value: number | null
  issued: string | null
}

export type PermitsObservation = {
  checkedAt: string
  activePermits: PermitSummary[]
  expiredPermits: PermitSummary[]
  openComplaints: {
    caseNumber: string
    violationType: string | null
    status: string | null
    disposition: string | null
  }[]
  historicResources: {
    name: string
    style: string | null
    year: string | null
    millsAct: string | null
  }[]
}

export type HazardsObservation = {
  checkedAt: string
  seismicZones: string[]
  wildfireZone: string | null
  damInundation: boolean
  calEnviroPercentile: number | null
  pollutionPercentile: number | null
  groundwaterPercentile: number | null
  corteseSitesNearby: {
    name: string
    program: string | null
    status: string | null
  }[]
}

export type SafetyObservation = {
  checkedAt: string
  spotCrimeUrl: string
  policeBeat: {
    beat: string
    level: string | null
    rate: number | null
    notes: string | null
  } | null
  crashes5YrCount: number | null
  severeCrashes5YrCount: number | null
  sjpdStreetQuery: string | null
  sjpdRecentCalls: {
    date: string | null
    type: string
    priority: string | null
    address: string | null
    disposition: string | null
  }[]
  sjpdDatasetNote: string | null
}

export type ContextObservation = {
  checkedAt: string
  neighborhood: string | null
  schoolDistrict: string | null
  nearbySchools: {
    name: string
    grades: string | null
  }[]
  highQualityTransit: boolean
  nearbyParks: string[]
  roadNoiseDba: string | null
  airportNoiseCnel: number | null
  nearFreeway500Ft: boolean
  tractMedianHomeValue: number | null
  tractMedianIncome: number | null
}

export type PropertyEvidence = {
  parcel: Observation<Parcel> | null
  flood: Observation<FloodZone> | null
  zoning?: ZoningObservation | null
  permits?: PermitsObservation | null
  hazards?: HazardsObservation | null
  safety?: SafetyObservation | null
  context?: ContextObservation | null
}

export type PropertyEvidenceEnv = {
  PROPERTY_EVIDENCE_REFRESH?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
}

export function spotCrimeMapUrl(
  lat: number,
  lng: number,
  address?: string | null,
) {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lng.toFixed(6),
    address: address ?? '',
  })
  return `https://spotcrime.com/map?${params.toString()}`
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finiteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function formatEpoch(value: unknown) {
  const ms = finiteNumber(value)
  if (ms === null || ms <= 0) return text(value)
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null
}

function parcelMapper(lat: number) {
  const cosLat = Math.cos((lat * Math.PI) / 180)
  return (attributes: Record<string, unknown>): Parcel | null => {
    const apn = text(attributes.APN)
    if (!apn) return null
    const house = text(attributes.SITUS_HOUSE_NUMBER)
    const dir = text(attributes.SITUS_STREET_DIRECTION)
    const stName = text(attributes.SITUS_STREET_NAME)
    const stType = text(attributes.SITUS_STREET_TYPE)
    const city = text(attributes.SITUS_CITY_NAME)
    const zip = text(attributes.SITUS_ZIP_CODE)
    const streetParts = [dir, stName, stType].filter(Boolean).join(' ')
    const situsAddress =
      house || streetParts
        ? [
            [house, streetParts].filter(Boolean).join(' '),
            city,
            zip ? `CA ${zip}` : null,
          ]
            .filter(Boolean)
            .join(', ')
        : null
    const streetQuery = [stName, stType].filter(Boolean).join(' ') || null
    const rawMercatorArea = finiteNumber(attributes.Shape_Area)
    const lotSqft =
      rawMercatorArea !== null && rawMercatorArea > 0
        ? Math.round(rawMercatorArea * cosLat * cosLat * 10.7639104)
        : null
    return {
      apn,
      jurisdiction: text(attributes.JURISDICTION),
      ...(finiteNumber(attributes.TAX_RATE_AREA) !== null
        ? { taxRateArea: finiteNumber(attributes.TAX_RATE_AREA) }
        : {}),
      ...(situsAddress ? { situsAddress } : {}),
      ...(streetQuery ? { streetQuery } : {}),
      ...(lotSqft !== null ? { lotSqft } : {}),
    }
  }
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
    return hit ? ((await hit.json()) as T) : null
  } catch {
    return null
  }
}

async function writeCache(
  cache: Cache | undefined,
  key: Request,
  payload: unknown,
  maxAge = propertyEvidenceSeconds,
) {
  try {
    await cache?.put(
      key,
      Response.json(payload, {
        headers: {
          'Cache-Control': `public, max-age=${maxAge}`,
        },
      }),
    )
  } catch {
    // Keep the fresh result if the edge cache is unavailable.
  }
}

async function queryArcGis(
  layer: string,
  params: Record<string, string>,
  fetcher: typeof fetch,
  timeoutMs = 5000,
): Promise<{
  features: { attributes?: Record<string, unknown> }[]
  exceededTransferLimit?: boolean
} | null> {
  const url = new URL(`${layer}/query`)
  url.search = new URLSearchParams({
    returnGeometry: 'false',
    f: 'json',
    ...params,
  }).toString()
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    if (!response.ok) return null
    const value = (await response.json()) as {
      error?: unknown
      features?: { attributes?: Record<string, unknown> }[]
      exceededTransferLimit?: boolean
    }
    if (!value || value.error || !Array.isArray(value.features)) return null
    return {
      features: value.features,
      exceededTransferLimit: value.exceededTransferLimit,
    }
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
  const value = await queryArcGis(
    layer,
    {
      geometry,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields,
      resultRecordCount: '5',
    },
    fetcher,
    7000,
  )
  if (!value) return null
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
  const observation: Observation<T> = {
    checkedAt: new Date().toISOString(),
    matches,
    truncated:
      value.exceededTransferLimit === true || value.features.length > 5,
  }
  await writeCache(cache, key, observation)
  return observation
}

function pointParams(
  geometry: string,
  outFields: string,
  distanceMeters?: number,
  recordCount = 5,
) {
  const base: Record<string, string> = {
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    resultRecordCount: String(recordCount),
  }
  if (distanceMeters && distanceMeters > 0) {
    base.distance = String(distanceMeters)
    base.units = 'esriSRUnit_Meter'
  }
  return base
}

async function fetchZoning(
  geometry: string,
  key: Request,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<ZoningObservation | null> {
  const [zoneRes, gpRes, heightRes, devRes] = await Promise.all([
    queryArcGis(
      zoningSource,
      pointParams(geometry, 'ZONING,PDUSE,NOTES', undefined, 3),
      fetcher,
    ),
    queryArcGis(
      generalPlanSource,
      pointParams(geometry, 'GPDESIGNATION,GPABBREVIATION', undefined, 3),
      fetcher,
    ),
    queryArcGis(
      heightLimitSource,
      pointParams(geometry, 'HEIGHTLIMIT,CODESECTION', undefined, 3),
      fetcher,
    ),
    queryArcGis(
      majorDevelopmentsSource,
      pointParams(
        geometry,
        'PROJECTNAME,PROJECTTYPE,PROJECTSTATUS,BUILDINGHEIGHT',
        400,
        5,
      ),
      fetcher,
    ),
  ])
  if (!zoneRes && !gpRes && !heightRes && !devRes) return null
  const z = zoneRes?.features[0]?.attributes
  const gp = gpRes?.features[0]?.attributes
  const h = heightRes?.features[0]?.attributes
  const nearbyDevelopments = (devRes?.features ?? [])
    .map((f) => f.attributes)
    .filter((a): a is Record<string, unknown> => Boolean(a && text(a.PROJECTNAME)))
    .map((a) => ({
      name: text(a.PROJECTNAME)!,
      type: text(a.PROJECTTYPE),
      status: text(a.PROJECTSTATUS),
      height: text(a.BUILDINGHEIGHT),
    }))
    .slice(0, 4)

  const obs: ZoningObservation = {
    checkedAt: new Date().toISOString(),
    zoning: z ? text(z.ZONING) : null,
    pdUse: z ? text(z.PDUSE) : null,
    zoningNotes: z ? text(z.NOTES) : null,
    generalPlan: gp ? text(gp.GPDESIGNATION) : null,
    heightLimit: h ? text(h.HEIGHTLIMIT) : null,
    heightCodeSection: h ? text(h.CODESECTION) : null,
    nearbyDevelopments,
  }
  await writeCache(cache, key, obs)
  return obs
}

function mapPermit(a: Record<string, unknown>): PermitSummary | null {
  const folder = text(a.FOLDERNUM)
  if (!folder) return null
  return {
    folder,
    work: text(a.WORKDESC),
    sub: text(a.SUBDESC),
    value: finiteNumber(a.PERMITVALUE),
    issued: formatEpoch(a.ISSUEDATE),
  }
}

async function fetchPermits(
  geometry: string,
  apn: string | null,
  key: Request,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<PermitsObservation | null> {
  const safeApn = apn && /^[A-Za-z0-9-]+$/.test(apn) ? apn : null
  const permitParams = (outFields: string) =>
    safeApn
      ? { where: `APN='${safeApn}'`, outFields, resultRecordCount: '5' }
      : pointParams(geometry, outFields, 35, 5)
  const fields = 'FOLDERNUM,WORKDESC,SUBDESC,PERMITVALUE,ISSUEDATE'
  const [activeRes, expiredRes, complaintsRes, historicRes] = await Promise.all([
    queryArcGis(activePermitsSource, permitParams(fields), fetcher),
    queryArcGis(expiredPermitsSource, permitParams(fields), fetcher),
    queryArcGis(
      codeComplaintsSource,
      pointParams(
        geometry,
        'CASENUMBER,VIOLATIONTYPE,CASESTATUS,DISPOSITION',
        120,
        5,
      ),
      fetcher,
    ),
    queryArcGis(
      historicSource,
      pointParams(
        geometry,
        'RESOURCENAME,ARCHITECTURALSTYLE,TRUEYR,ESTIMATEDYR,MILLSACT',
        35,
        3,
      ),
      fetcher,
    ),
  ])
  if (!activeRes && !expiredRes && !complaintsRes && !historicRes) return null

  const activePermits = (activeRes?.features ?? [])
    .map((f) => (f.attributes ? mapPermit(f.attributes) : null))
    .filter((p): p is PermitSummary => p !== null)
    .slice(0, 5)
  const expiredPermits = (expiredRes?.features ?? [])
    .map((f) => (f.attributes ? mapPermit(f.attributes) : null))
    .filter((p): p is PermitSummary => p !== null)
    .slice(0, 5)
  const openComplaints = (complaintsRes?.features ?? [])
    .map((f) => f.attributes)
    .filter((a): a is Record<string, unknown> => Boolean(a && text(a.CASENUMBER)))
    .map((a) => ({
      caseNumber: text(a.CASENUMBER)!,
      violationType: text(a.VIOLATIONTYPE),
      status: text(a.CASESTATUS),
      disposition: text(a.DISPOSITION),
    }))
    .slice(0, 5)
  const historicResources = (historicRes?.features ?? [])
    .map((f) => f.attributes)
    .filter((a): a is Record<string, unknown> =>
      Boolean(a && text(a.RESOURCENAME)),
    )
    .map((a) => ({
      name: text(a.RESOURCENAME)!,
      style: text(a.ARCHITECTURALSTYLE),
      year: text(a.TRUEYR) ?? text(a.ESTIMATEDYR),
      millsAct: text(a.MILLSACT),
    }))
    .slice(0, 3)

  const obs: PermitsObservation = {
    checkedAt: new Date().toISOString(),
    activePermits,
    expiredPermits,
    openComplaints,
    historicResources,
  }
  await writeCache(cache, key, obs)
  return obs
}

async function fetchHazards(
  geometry: string,
  key: Request,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<HazardsObservation | null> {
  const [seismicRes, fireRes, damRes, enviroRes, corteseRes] = await Promise.all(
    [
      queryArcGis(
        seismicSource,
        pointParams(geometry, 'HAZARDTYPE,QUADRANGLE', undefined, 5),
        fetcher,
      ),
      queryArcGis(
        wildfireSource,
        pointParams(geometry, 'FIREHAZARDSEVERITYZONE', undefined, 3),
        fetcher,
      ),
      queryArcGis(
        damInundationSource,
        pointParams(geometry, 'OBJECTID', undefined, 2),
        fetcher,
      ),
      queryArcGis(
        calEnviroSource,
        pointParams(
          geometry,
          'CISCOREPCTL,POLLUTIONBURDENPCTL,GROUNDWATERTHREATSPCTL',
          undefined,
          2,
        ),
        fetcher,
      ),
      queryArcGis(
        corteseSource,
        pointParams(geometry, 'SITEFACILITYNAME,PROGRAMTYPE,STATUS', 400, 5),
        fetcher,
      ),
    ],
  )
  if (!seismicRes && !fireRes && !damRes && !enviroRes && !corteseRes)
    return null

  const seismicZones = [
    ...new Set(
      (seismicRes?.features ?? [])
        .map((f) => text(f.attributes?.HAZARDTYPE))
        .filter((s): s is string => Boolean(s)),
    ),
  ]
  const wildfireZone =
    text(fireRes?.features[0]?.attributes?.FIREHAZARDSEVERITYZONE) ?? null
  const damInundation = (damRes?.features?.length ?? 0) > 0
  const envAttr = enviroRes?.features[0]?.attributes
  const corteseSitesNearby = (corteseRes?.features ?? [])
    .map((f) => f.attributes)
    .filter((a): a is Record<string, unknown> =>
      Boolean(a && text(a.SITEFACILITYNAME)),
    )
    .map((a) => ({
      name: text(a.SITEFACILITYNAME)!,
      program: text(a.PROGRAMTYPE),
      status: text(a.STATUS),
    }))
    .slice(0, 4)

  const obs: HazardsObservation = {
    checkedAt: new Date().toISOString(),
    seismicZones,
    wildfireZone,
    damInundation,
    calEnviroPercentile: envAttr ? finiteNumber(envAttr.CISCOREPCTL) : null,
    pollutionPercentile: envAttr
      ? finiteNumber(envAttr.POLLUTIONBURDENPCTL)
      : null,
    groundwaterPercentile: envAttr
      ? finiteNumber(envAttr.GROUNDWATERTHREATSPCTL)
      : null,
    corteseSitesNearby,
  }
  await writeCache(cache, key, obs)
  return obs
}

async function resolveSjpdQuarterlyResource(
  baseUrl: URL,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<{ id: string; name: string } | null> {
  const key = new Request(
    new URL('/_internal/property-evidence/v2/sjpd-quarterly-resource', baseUrl),
  )
  const cached = await readCache<{ id: string; name: string }>(cache, key)
  if (cached?.id) return cached
  try {
    const response = await fetcher(sjpdCkanPackageSource, {
      signal: AbortSignal.timeout(4500),
      redirect: 'manual',
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      success?: boolean
      result?: {
        resources?: {
          id?: string
          name?: string
          datastore_active?: boolean
          last_modified?: string
        }[]
      }
    }
    const active = (payload.result?.resources ?? [])
      .filter((r) => r.id && r.datastore_active)
      .sort((a, b) =>
        String(b.last_modified ?? '').localeCompare(String(a.last_modified ?? '')),
      )[0]
    if (!active?.id) return null
    const resolved = {
      id: active.id,
      name: active.name ?? 'SJPD Quarterly Calls',
    }
    await writeCache(cache, key, resolved)
    return resolved
  } catch {
    return null
  }
}

async function fetchSafety(
  geometry: string,
  lat: number,
  lng: number,
  situsAddress: string | null,
  streetQuery: string | null,
  baseUrl: URL,
  key: Request,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<SafetyObservation | null> {
  const [beatRes, crashRes, resource] = await Promise.all([
    queryArcGis(
      policeBeatSource,
      pointParams(geometry, 'NAME,CRIMERATE,CRIMELEVEL,NOTES', undefined, 2),
      fetcher,
    ),
    queryArcGis(
      crashesSource,
      pointParams(geometry, 'KSIINJURIES', 250, 100),
      fetcher,
    ),
    streetQuery
      ? resolveSjpdQuarterlyResource(baseUrl, cache, fetcher)
      : Promise.resolve(null),
  ])

  let sjpdRecentCalls: SafetyObservation['sjpdRecentCalls'] = []
  let sjpdDatasetNote: string | null = null
  const safeStreet = streetQuery
    ?.replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .toUpperCase()
  if (resource && safeStreet && safeStreet.length >= 3) {
    try {
      const sql = `SELECT "OFFENSE_DATE","CALL_TYPE","PRIORITY","ADDRESS","FINAL_DISPO" FROM "${resource.id}" WHERE ("ADDRESS" ILIKE '% ${safeStreet}%' OR "ADDRESS" ILIKE '${safeStreet}%') ORDER BY "OFFENSE_DATE" DESC, "OFFENSE_TIME" DESC LIMIT 8`
      const url = new URL(sjpdCkanSqlBase)
      url.search = new URLSearchParams({ sql }).toString()
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(4500),
        redirect: 'manual',
      })
      if (response.ok) {
        const json = (await response.json()) as {
          success?: boolean
          result?: { records?: Record<string, unknown>[] }
        }
        if (json.success && Array.isArray(json.result?.records)) {
          sjpdDatasetNote = resource.name
          sjpdRecentCalls = json.result.records
            .map((r) => ({
              date: text(r.OFFENSE_DATE),
              type: text(r.CALL_TYPE) ?? 'Incident',
              priority: text(r.PRIORITY),
              address: text(r.ADDRESS),
              disposition: text(r.FINAL_DISPO),
            }))
            .slice(0, 8)
        }
      }
    } catch {
      // Fall back cleanly to beat + crash + SpotCrime link.
    }
  }

  if (!beatRes && !crashRes && sjpdDatasetNote === null) return null

  const beatAttr = beatRes?.features[0]?.attributes
  const beatName = beatAttr ? text(beatAttr.NAME) : null
  const policeBeat = beatName
    ? {
        beat: beatName,
        level: text(beatAttr?.CRIMELEVEL),
        rate: finiteNumber(beatAttr?.CRIMERATE),
        notes: text(beatAttr?.NOTES),
      }
    : null

  const crashFeatures = crashRes?.features ?? null
  const crashes5YrCount = crashFeatures ? crashFeatures.length : null
  const severeCrashes5YrCount = crashFeatures
    ? crashFeatures.filter(
        (f) => (finiteNumber(f.attributes?.KSIINJURIES) ?? 0) > 0,
      ).length
    : null

  const obs: SafetyObservation = {
    checkedAt: new Date().toISOString(),
    spotCrimeUrl: spotCrimeMapUrl(lat, lng, situsAddress),
    policeBeat,
    crashes5YrCount,
    severeCrashes5YrCount,
    sjpdStreetQuery: safeStreet ?? null,
    sjpdRecentCalls,
    sjpdDatasetNote,
  }
  await writeCache(cache, key, obs)
  return obs
}

async function fetchContext(
  geometry: string,
  key: Request,
  cache: Cache | undefined,
  fetcher: typeof fetch,
): Promise<ContextObservation | null> {
  const [
    hoodRes,
    districtRes,
    schoolsRes,
    transitRes,
    parksRes,
    roadNoiseRes,
    airportRes,
    freewayRes,
    tractRes,
  ] = await Promise.all([
    queryArcGis(
      neighborhoodSource,
      pointParams(geometry, 'NAME', undefined, 2),
      fetcher,
    ),
    queryArcGis(
      schoolDistrictSource,
      pointParams(geometry, 'SCHOOLDISTRICTNAME', undefined, 2),
      fetcher,
    ),
    queryArcGis(
      nearbySchoolsSource,
      pointParams(geometry, 'School,GSserved,StatusType', 1200, 6),
      fetcher,
    ),
    queryArcGis(
      transitCorridorSource,
      pointParams(geometry, 'OBJECTID', undefined, 1),
      fetcher,
    ),
    queryArcGis(
      parksSource,
      pointParams(geometry, 'NAME', 600, 5),
      fetcher,
    ),
    queryArcGis(
      roadNoiseSource,
      pointParams(geometry, 'DBARANGE,NAME', undefined, 2),
      fetcher,
    ),
    queryArcGis(
      airportNoiseSource,
      pointParams(geometry, 'DBS,AIRPORT', undefined, 2),
      fetcher,
    ),
    queryArcGis(
      freewayBufferSource,
      pointParams(geometry, 'OBJECTID', undefined, 1),
      fetcher,
    ),
    queryArcGis(
      tractMarketSource,
      pointParams(geometry, 'MEDHOMEVAL,INCMEDIANINCOME', undefined, 2),
      fetcher,
    ),
  ])

  if (
    !hoodRes &&
    !districtRes &&
    !schoolsRes &&
    !transitRes &&
    !parksRes &&
    !roadNoiseRes &&
    !airportRes &&
    !freewayRes &&
    !tractRes
  ) {
    return null
  }

  const nearbySchools = (schoolsRes?.features ?? [])
    .map((f) => f.attributes)
    .filter(
      (a): a is Record<string, unknown> =>
        Boolean(a) && Boolean(text(a!.School)) && text(a!.StatusType) !== 'Closed',
    )
    .map((a) => ({
      name: text(a.School)!,
      grades: text(a.GSserved),
    }))
    .slice(0, 4)
  const nearbyParks = [
    ...new Set(
      (parksRes?.features ?? [])
        .map((f) => text(f.attributes?.NAME))
        .filter((s): s is string => Boolean(s)),
    ),
  ].slice(0, 4)

  const tractAttr = tractRes?.features[0]?.attributes
  const obs: ContextObservation = {
    checkedAt: new Date().toISOString(),
    neighborhood: text(hoodRes?.features[0]?.attributes?.NAME) ?? null,
    schoolDistrict:
      text(districtRes?.features[0]?.attributes?.SCHOOLDISTRICTNAME) ?? null,
    nearbySchools,
    highQualityTransit: (transitRes?.features?.length ?? 0) > 0,
    nearbyParks,
    roadNoiseDba: text(roadNoiseRes?.features[0]?.attributes?.DBARANGE) ?? null,
    airportNoiseCnel: finiteNumber(airportRes?.features[0]?.attributes?.DBS),
    nearFreeway500Ft: (freewayRes?.features?.length ?? 0) > 0,
    tractMedianHomeValue: tractAttr ? finiteNumber(tractAttr.MEDHOMEVAL) : null,
    tractMedianIncome: tractAttr
      ? finiteNumber(tractAttr.INCMEDIANINCOME)
      : null,
  }
  await writeCache(cache, key, obs)
  return obs
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
  const path = `/_internal/property-evidence/v2/${geometry}/`
  const parcelKey = new Request(new URL(`${path}parcel`, url))
  const floodKey = new Request(new URL(`${path}flood`, url))
  const zoningKey = new Request(new URL(`${path}zoning`, url))
  const permitsKey = new Request(new URL(`${path}permits`, url))
  const hazardsKey = new Request(new URL(`${path}hazards`, url))
  const safetyKey = new Request(new URL(`${path}safety`, url))
  const contextKey = new Request(new URL(`${path}context`, url))

  const [
    cachedParcel,
    cachedFlood,
    cachedZoning,
    cachedPermits,
    cachedHazards,
    cachedSafety,
    cachedContext,
  ] = await Promise.all([
    readCache<Observation<Parcel>>(cache, parcelKey),
    readCache<Observation<FloodZone>>(cache, floodKey),
    readCache<ZoningObservation>(cache, zoningKey),
    readCache<PermitsObservation>(cache, permitsKey),
    readCache<HazardsObservation>(cache, hazardsKey),
    readCache<SafetyObservation>(cache, safetyKey),
    readCache<ContextObservation>(cache, contextKey),
  ])

  if (
    cachedParcel &&
    cachedFlood &&
    cachedZoning &&
    cachedPermits &&
    cachedHazards &&
    cachedSafety &&
    cachedContext
  ) {
    return respond({
      parcel: cachedParcel,
      flood: cachedFlood,
      zoning: cachedZoning,
      permits: cachedPermits,
      hazards: cachedHazards,
      safety: cachedSafety,
      context: cachedContext,
    } satisfies PropertyEvidence)
  }

  const limit = env.PROPERTY_EVIDENCE_REFRESH
  if (!limit) return respond({ error: 'not_configured' }, 503)
  const { success } = await limit
    .limit({ key: 'san-jose-property-evidence' })
    .catch(() => ({ success: false }))
  if (!success) {
    const anyCached =
      cachedParcel ||
      cachedFlood ||
      cachedZoning ||
      cachedPermits ||
      cachedHazards ||
      cachedSafety ||
      cachedContext
    return anyCached
      ? respond({
          parcel: cachedParcel,
          flood: cachedFlood,
          zoning: cachedZoning,
          permits: cachedPermits,
          hazards: cachedHazards,
          safety: cachedSafety,
          context: cachedContext,
        } satisfies PropertyEvidence)
      : respond({ error: 'rate_limited' }, 429)
  }

  // Stage 1: Resolve parcel first in parallel with coordinate-only domains.
  const [parcelResult, floodResult, zoningResult, hazardsResult, contextResult] =
    await Promise.all([
      cachedParcel ??
        lookup(
          geometry,
          parcelSource,
          'APN,JURISDICTION,TAX_RATE_AREA,SITUS_HOUSE_NUMBER,SITUS_STREET_DIRECTION,SITUS_STREET_NAME,SITUS_STREET_TYPE,SITUS_CITY_NAME,SITUS_ZIP_CODE,Shape_Area',
          parcelMapper(lat),
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
      cachedZoning ?? fetchZoning(geometry, zoningKey, cache, fetcher),
      cachedHazards ?? fetchHazards(geometry, hazardsKey, cache, fetcher),
      cachedContext ?? fetchContext(geometry, contextKey, cache, fetcher),
    ])

  // Stage 2: Permits (by resolved APN or point) + Safety (SJPD calls on resolved street + beat + crashes).
  const firstParcel = parcelResult?.matches[0]
  const [permitsResult, safetyResult] = await Promise.all([
    cachedPermits ??
      fetchPermits(
        geometry,
        firstParcel?.apn ?? null,
        permitsKey,
        cache,
        fetcher,
      ),
    cachedSafety ??
      fetchSafety(
        geometry,
        lat,
        lng,
        firstParcel?.situsAddress ?? null,
        firstParcel?.streetQuery ?? null,
        url,
        safetyKey,
        cache,
        fetcher,
      ),
  ])

  return respond({
    parcel: parcelResult,
    flood: floodResult,
    zoning: zoningResult,
    permits: permitsResult,
    hazards: hazardsResult,
    safety: safetyResult,
    context: contextResult,
  } satisfies PropertyEvidence)
}
