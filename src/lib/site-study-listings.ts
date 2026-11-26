import type { Coordinate } from './meeting-point'

export type Listing = {
  address: string
  coordinate: Coordinate
  price: number | null
  status: string
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
    listings.push({
      address:
        values[nameIndex] || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      coordinate: [longitude, latitude],
      price,
      status: (values[statusIndex] ?? '').replaceAll('_', ' '),
    })
  }
  if (listings.length === 0)
    throw new Error('The CSV has no rows with valid latitude and longitude.')
  return listings
}
