import type { Coordinate } from './meeting-point'
import { spotCrimeMapUrl } from './site-study-property-evidence'

export type Listing = {
  address: string
  coordinate: Coordinate
  price: number | null
  status: string
  beds?: number
  sqft?: number
  sourceUrl?: string
}

export type ExternalListingLink = {
  id:
    | 'source'
    | 'zillow'
    | 'redfin'
    | 'homes'
    | 'realtor'
    | 'google-maps'
    | 'spotcrime'
  label: string
  href: string
  primary?: boolean
}

const coordinatePattern = /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/

export function listingExternalLinks(listing: Listing): ExternalListingLink[] {
  const [lng, lat] = listing.coordinate
  const rawAddress = listing.address.trim()
  const isCoordOnly = !rawAddress || coordinatePattern.test(rawAddress)
  const searchAddress = isCoordOnly
    ? `${lat.toFixed(6)}, ${lng.toFixed(6)}`
    : rawAddress
  const slug = searchAddress
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const encodedQuery = encodeURIComponent(searchAddress)
  const links: ExternalListingLink[] = []

  if (listing.sourceUrl && /^https?:\/\//i.test(listing.sourceUrl)) {
    links.push({
      id: 'source',
      label: 'Source listing',
      href: listing.sourceUrl,
      primary: true,
    })
  }

  links.push(
    {
      id: 'zillow',
      label: 'Zillow',
      href: `https://www.zillow.com/homes/${encodeURIComponent(slug || searchAddress)}_rb/`,
    },
    {
      id: 'redfin',
      label: 'Redfin',
      href: `https://www.redfin.com/search?q=${encodedQuery}`,
    },
    {
      id: 'homes',
      label: 'Homes.com',
      href: `https://www.homes.com/homes-for-sale/?q=${encodedQuery}`,
    },
    {
      id: 'realtor',
      label: 'Realtor.com',
      href: `https://www.realtor.com/realestateandhomes-search/${encodeURIComponent(slug || searchAddress)}`,
    },
    {
      id: 'google-maps',
      label: 'Google Maps',
      href: `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`,
    },
    {
      id: 'spotcrime',
      label: 'SpotCrime',
      href: spotCrimeMapUrl(lat, lng, isCoordOnly ? undefined : rawAddress),
    },
  )

  return links
}

export const liveListingKinds = ['for_sale', 'for_rent'] as const
export type LiveListingKind = (typeof liveListingKinds)[number]
export type LiveListingSnapshot = {
  listings: Listing[]
  checkedAt: string
  unavailable: LiveListingKind[]
}

export type ListingFilters = {
  kind: 'all' | 'for sale' | 'for rent'
  maxPrice: string
  minBeds: string
  minSqft: string
}

export function matchesListingFilters(
  listing: Listing,
  filters: ListingFilters,
) {
  return (
    (filters.kind === 'all' || listing.status.toLowerCase() === filters.kind) &&
    (!filters.maxPrice ||
      (listing.price !== null && listing.price <= Number(filters.maxPrice))) &&
    (!filters.minBeds ||
      (listing.beds !== undefined &&
        listing.beds >= Number(filters.minBeds))) &&
    (!filters.minSqft ||
      (listing.sqft !== undefined && listing.sqft >= Number(filters.minSqft)))
  )
}

// Accept quoted commas, escaped quotes, and embedded newlines in CSV exports.
export function parseListings(csv: string): Listing[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const source = csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted && char === '"' && source[i + 1] === '"') {
      field += '"'
      i++
    } else if (char === '"' && (quoted || field === '')) {
      quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field.trim())
      field = ''
      if (char === '\n') {
        if (row.some(Boolean)) rows.push(row)
        row = []
      }
    } else field += char
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted field.')
  row.push(field.trim())
  if (row.some(Boolean)) rows.push(row)

  const headers = rows.shift()?.map((value) => value.toLowerCase()) ?? []
  const find = (...names: string[]) =>
    names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1
  const latIndex = find('latitude', 'lat')
  const lonIndex = find('longitude', 'lon', 'lng')
  if (latIndex < 0 || lonIndex < 0)
    throw new Error('Include latitude and longitude columns in the CSV.')
  if (rows.length > 2000)
    throw new Error('Choose a CSV with up to 2,000 listings.')
  const nameIndex = find(
    'formatted_address',
    'address',
    'street',
    'addressline1',
  )
  const priceIndexes = ['sold_price', 'list_price', 'price', 'rent'].map(
    (name) => headers.indexOf(name),
  )
  const statusIndex = find('status', 'mls_status', 'listing_type')
  const bedsIndex = find('beds', 'bedrooms')
  const sqftIndex = find('sqft', 'square_footage', 'squarefootage')

  const listings: Listing[] = []
  for (const values of rows) {
    const latitude = Number(values[latIndex])
    const longitude = Number(values[lonIndex])
    if (
      !values[latIndex] ||
      !values[lonIndex] ||
      !(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)
    )
      continue
    const price =
      priceIndexes
        .map((index) => Number(values[index]?.replace(/[$,]/g, '')))
        .find((value) => Number.isFinite(value) && value > 0) ?? null
    const listing: Listing = {
      address:
        values[nameIndex] || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      coordinate: [longitude, latitude],
      price,
      status: (values[statusIndex] ?? '').replaceAll('_', ' '),
    }
    const beds = Number(values[bedsIndex])
    const sqft = Number(values[sqftIndex]?.replaceAll(',', ''))
    if (values[bedsIndex] && Number.isFinite(beds) && beds >= 0)
      listing.beds = beds
    if (Number.isFinite(sqft) && sqft > 0) listing.sqft = sqft
    listings.push(listing)
  }
  if (listings.length === 0)
    throw new Error('The CSV has no rows with valid latitude and longitude.')
  return listings
}
