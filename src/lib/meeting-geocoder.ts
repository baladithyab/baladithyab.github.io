import type { Coordinate, MeetingNetwork } from './meeting-point'

export type MeetingPlace = {
  id: string
  name: string
  context: string
  coordinate: Coordinate
}

type SearchRequest = {
  query: string
  mode: 'city' | 'place'
  bounds?: MeetingNetwork['bounds']
  signal: AbortSignal
}

const resultLimit = 8
const cacheLimit = 64
const cacheLifetime = 5 * 60 * 1000
const cache = new Map<string, { expires: number; places: MeetingPlace[] }>()

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function distinct(parts: string[]): string[] {
  const seen = new Set<string>()
  return parts.filter((part) => {
    const key = part.toLocaleLowerCase()
    if (!part || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validBounds(bounds: MeetingNetwork['bounds']): boolean {
  const [west, south, east, north] = bounds
  return (
    bounds.every(Number.isFinite) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
  )
}

function parsePlace(
  feature: unknown,
  bounds: MeetingNetwork['bounds'] | undefined,
): MeetingPlace | null {
  if (
    typeof feature !== 'object' ||
    feature === null ||
    !('geometry' in feature) ||
    typeof feature.geometry !== 'object' ||
    feature.geometry === null ||
    !('type' in feature.geometry) ||
    feature.geometry.type !== 'Point' ||
    !('coordinates' in feature.geometry) ||
    !Array.isArray(feature.geometry.coordinates) ||
    !('properties' in feature) ||
    typeof feature.properties !== 'object' ||
    feature.properties === null
  )
    return null
  const [longitude, latitude] = feature.geometry.coordinates
  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  )
    return null
  if (
    bounds &&
    (longitude < bounds[0] ||
      longitude > bounds[2] ||
      latitude < bounds[1] ||
      latitude > bounds[3])
  )
    return null

  const properties = feature.properties
  const street = text('street' in properties ? properties.street : undefined)
  const house = text(
    'housenumber' in properties ? properties.housenumber : undefined,
  )
  const address = street ? [house, street].filter(Boolean).join(' ') : ''
  const providerName = text('name' in properties ? properties.name : undefined)
  const city =
    text('city' in properties ? properties.city : undefined) ||
    text('locality' in properties ? properties.locality : undefined)
  const name =
    providerName &&
    providerName.toLocaleLowerCase() !== street.toLocaleLowerCase()
      ? providerName
      : address || providerName || city
  if (!name) return null
  const context = distinct([
    name,
    address,
    text('district' in properties ? properties.district : undefined),
    city,
    text('county' in properties ? properties.county : undefined),
    text('state' in properties ? properties.state : undefined),
    text('country' in properties ? properties.country : undefined),
  ])
    .slice(1)
    .join(', ')
  const osmId = 'osm_id' in properties ? properties.osm_id : undefined
  const osmType = text(
    'osm_type' in properties ? properties.osm_type : undefined,
  )
  const sourceId =
    typeof osmId === 'number' && Number.isSafeInteger(osmId) && osmId > 0
      ? `${osmType}:${osmId}`
      : typeof osmId === 'string' && /^\d+$/.test(osmId)
        ? `${osmType}:${osmId}`
        : name
  return {
    id: `photon:${sourceId}:${longitude},${latitude}`,
    name,
    context,
    coordinate: [longitude, latitude],
  }
}

function copyPlaces(places: MeetingPlace[]): MeetingPlace[] {
  return places.map((place) => ({
    ...place,
    coordinate: [place.coordinate[0], place.coordinate[1]],
  }))
}

/** Public Photon autocomplete. Only successful, validated results enter memory. */
export async function searchMeetingPlaces({
  query,
  mode,
  bounds,
  signal,
}: SearchRequest): Promise<MeetingPlace[]> {
  signal.throwIfAborted()
  const normalizedQuery = query.trim()
  if (normalizedQuery.length < 3) return []
  if (normalizedQuery.length > 200)
    throw new Error('Keep the search under 200 characters.')
  if (mode === 'place' && (!bounds || !validBounds(bounds))) {
    throw new Error('Load a walking network before searching this area.')
  }
  const endpoint: unknown = import.meta.env.PUBLIC_MEETING_GEOCODER_URL
  let url: URL
  try {
    url = new URL(
      typeof endpoint === 'string' && endpoint.trim()
        ? endpoint.trim()
        : 'https://photon.komoot.io/api/',
    )
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('protocol')
  } catch {
    throw new Error('The configured address search endpoint is invalid.')
  }
  url.searchParams.set('q', normalizedQuery)
  url.searchParams.set('limit', String(resultLimit))
  url.searchParams.set('lang', 'en')
  // Reserved parameters must not leak between city and bounded place searches.
  for (const parameter of ['layer', 'bbox', 'lat', 'lon'])
    url.searchParams.delete(parameter)
  if (mode === 'city') {
    url.searchParams.append('layer', 'city')
    url.searchParams.append('layer', 'locality')
  } else if (bounds) {
    url.searchParams.set('bbox', bounds.join(','))
    url.searchParams.set('lon', String((bounds[0] + bounds[2]) / 2))
    url.searchParams.set('lat', String((bounds[1] + bounds[3]) / 2))
  }
  const key = url.href
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) {
    cache.delete(key)
    cache.set(key, cached)
    return copyPlaces(cached.places)
  }
  cache.delete(key)
  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new Error(
      'Address search could not connect. Check your connection and edit to try again.',
      { cause: error },
    )
  }
  signal.throwIfAborted()
  if (!response.ok) {
    throw new Error(
      response.status === 429
        ? 'Address search is busy. Wait a moment, then edit to try again.'
        : 'Address search is unavailable. Edit to try again later.',
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    signal.throwIfAborted()
    throw new Error('Address search returned an unreadable response.', {
      cause: error,
    })
  }
  signal.throwIfAborted()
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('features' in payload) ||
    !Array.isArray(payload.features)
  ) {
    throw new Error('Address search returned an invalid response.')
  }
  const places: MeetingPlace[] = []
  const seen = new Set<string>()
  // Ignore untrusted surplus results as well as invalid or out-of-area features.
  for (const feature of payload.features.slice(0, 100)) {
    const place = parsePlace(feature, mode === 'place' ? bounds : undefined)
    if (!place || seen.has(place.id)) continue
    seen.add(place.id)
    places.push(place)
    if (places.length === resultLimit) break
  }
  if (payload.features.length > 0 && places.length === 0) {
    throw new Error('Address search returned no valid results for this area.')
  }
  cache.set(key, {
    expires: Date.now() + cacheLifetime,
    places: copyPlaces(places),
  })
  while (cache.size > cacheLimit) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  return places
}
