import {
  minutes,
  originBounds,
  project,
  unproject,
  type CensusGrid,
  type Point,
  type StudyResult,
} from './site-study'
import type { Coordinate } from './meeting-point'
import type { Listing } from './site-study-listings'

export type MapRoads = {
  date: string
  coordinates: Int32Array
  segments: Uint32Array
}

const light = {
  land: '#edf1e9',
  coast: '#a5b9bf',
  roads: ['#c5cfcb', '#a2b4b4', '#879faa', '#668593'],
  contours: ['#08614e', '#12796f', '#396d88'],
  fills: [
    'rgba(41,149,114,0.26)',
    'rgba(40,146,134,0.19)',
    'rgba(64,130,160,0.15)',
  ],
  boundary: '#52696f',
  label: '#243c45',
  halo: '#f5f8f4',
  property: '#b85c16',
  propertyStroke: '#fff4e8',
  propertySelected: '#d9381e',
  propertySelectedHalo: 'rgba(217, 56, 30, 0.24)',
  propertySelectedRing: '#ffffff',
  pin: '#f5f8f4',
  pinStroke: '#08614e',
  pinCenter: '#08614e',
}
const dark = {
  land: '#142733',
  coast: '#2e4d57',
  roads: ['#304854', '#45606a', '#587983', '#71949c'],
  contours: ['#b1fae2', '#72e3cb', '#4da6af'],
  fills: [
    'rgba(120,229,194,0.27)',
    'rgba(50,173,150,0.15)',
    'rgba(37,116,130,0.18)',
  ],
  boundary: '#9bb0b9',
  label: '#e0e9e9',
  halo: '#10222c',
  property: '#ffc984',
  propertyStroke: '#372619',
  propertySelected: '#ff7b3b',
  propertySelectedHalo: 'rgba(255, 123, 59, 0.34)',
  propertySelectedRing: '#0b1821',
  pin: '#10222c',
  pinStroke: '#d8fff4',
  pinCenter: '#b1fae2',
}
const labels: [string, Coordinate][] = [
  ['Sunnyvale', [-122.036, 37.383]],
  ['Santa Clara', [-121.975, 37.367]],
  ['Milpitas', [-121.901, 37.453]],
  ['Cupertino', [-122.034, 37.295]],
  ['Los Gatos', [-121.989, 37.229]],
  ['Campbell', [-121.953, 37.276]],
  ['San José', [-121.86, 37.351]],
  ['Alum Rock', [-121.809, 37.393]],
  ['South San José', [-121.83, 37.238]],
]

function viewport(width: number, height: number, wide: boolean) {
  const centre = project(wide ? [-121.935, 37.36] : [-121.922, 37.345])
  const scale = wide
    ? Math.min(width / 75_000, height / 65_000)
    : Math.min(width / 29_500, height / 34_000)
  const west = centre[0] - width / (2 * scale)
  const north = centre[1] + height / (2 * scale)
  return {
    scale,
    x: (x: number) => (x - west) * scale,
    y: (y: number) => (north - y) * scale,
    coordinate: (x: number, y: number) =>
      unproject([west + x / scale, north - y / scale]),
  }
}

export function mapCoordinate(
  width: number,
  height: number,
  x: number,
  y: number,
  wide: boolean,
) {
  return viewport(width, height, wide).coordinate(x, y)
}

export function mapPixel(
  width: number,
  height: number,
  [x, y]: Point,
  wide: boolean,
): Point {
  const view = viewport(width, height, wide)
  return [view.x(x), view.y(y)]
}

function canvasContext(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const ratio = Math.min(devicePixelRatio || 1, 2)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')!
  ctx.scale(ratio, ratio)
  return ctx
}

export function drawBase(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  roads: MapRoads,
  census: CensusGrid,
  wide: boolean,
  isDark: boolean,
) {
  const ctx = canvasContext(canvas, width, height)
  const { x, y } = viewport(width, height, wide)
  const palette = isDark ? dark : light
  ctx.fillStyle = palette.land
  ctx.beginPath()
  for (const ring of census.outline) {
    ctx.moveTo(x(ring[0][0]), y(ring[0][1]))
    for (const [px, py] of ring.slice(1)) ctx.lineTo(x(px), y(py))
    ctx.closePath()
  }
  ctx.fill('evenodd')
  ctx.strokeStyle = palette.coast
  ctx.stroke()

  const paths = Array.from({ length: 4 }, () => new Path2D())
  const { coordinates, segments } = roads
  for (let i = 0; i < segments.length; i += 3) {
    const a = segments[i] * 2
    const b = segments[i + 1] * 2
    const rank = segments[i + 2]
    const x1 = x(coordinates[a])
    const y1 = y(coordinates[a + 1])
    const x2 = x(coordinates[b])
    const y2 = y(coordinates[b + 1])
    if (
      Math.max(x1, x2) < 0 ||
      Math.min(x1, x2) > width ||
      Math.max(y1, y2) < 0 ||
      Math.min(y1, y2) > height
    )
      continue
    paths[rank].moveTo(x1, y1)
    paths[rank].lineTo(x2, y2)
  }
  paths.forEach((path, rank) => {
    ctx.strokeStyle = palette.roads[rank]
    ctx.lineWidth = [0.55, 0.8, 1.05, 1.25][rank]
    ctx.stroke(path)
  })
}

export function drawOverlay(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  census: CensusGrid,
  result: StudyResult | undefined,
  points: Point[],
  active: number,
  listings: Listing[],
  wide: boolean,
  isDark: boolean,
  selectedListing?: Listing,
) {
  const ctx = canvasContext(canvas, width, height)
  const { x, y, scale } = viewport(width, height, wide)
  const palette = isDark ? dark : light
  if (result) {
    const { cellSize, columns, rows } = census
    const size = cellSize * scale
    for (let band = minutes.length - 1; band >= 0; band--) {
      ctx.fillStyle = palette.fills[band]
      ctx.strokeStyle = palette.contours[band]
      ctx.globalAlpha = active === band ? 1 : 0.62
      ctx.lineWidth = active === band ? 1.4 : 0.8
      const limit = minutes[band] * 60
      const outline = new Path2D()
      const fill = new Path2D()
      for (let i = 0; i < result.times.length; i++) {
        if (result.times[i] > limit) continue
        const col = i % columns
        const row = Math.floor(i / columns)
        const left = x(col * cellSize)
        const top = y((row + 1) * cellSize)
        if (left + size < 0 || left > width || top + size < 0 || top > height)
          continue
        if (band === 0 || result.times[i] > minutes[band - 1] * 60)
          fill.rect(left, top, size, size)
        if (col === 0 || result.times[i - 1] > limit) {
          outline.moveTo(left, top)
          outline.lineTo(left, top + size)
        }
        if (col === columns - 1 || result.times[i + 1] > limit) {
          outline.moveTo(left + size, top)
          outline.lineTo(left + size, top + size)
        }
        if (row === rows - 1 || result.times[i + columns] > limit) {
          outline.moveTo(left, top)
          outline.lineTo(left + size, top)
        }
        if (row === 0 || result.times[i - columns] > limit) {
          outline.moveTo(left, top + size)
          outline.lineTo(left + size, top + size)
        }
      }
      ctx.fill(fill)
      ctx.stroke(outline)
    }
  }
  ctx.globalAlpha = 1
  const [west, south, east, north] = originBounds
  const [left, bottom] = project([west, south])
  const [right, top] = project([east, north])
  ctx.setLineDash([4, 5])
  ctx.strokeStyle = palette.boundary
  ctx.lineWidth = 0.85
  ctx.strokeRect(x(left), y(top), x(right) - x(left), y(bottom) - y(top))
  ctx.setLineDash([])

  ctx.font = '600 11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = palette.label
  ctx.strokeStyle = palette.halo
  ctx.lineWidth = 3.5
  ctx.lineJoin = 'round'
  for (const [name, coordinate] of labels) {
    if (
      wide &&
      !['Sunnyvale', 'Milpitas', 'San José', 'Los Gatos'].includes(name)
    )
      continue
    if (width < 480 && ['Santa Clara', 'Campbell', 'Alum Rock'].includes(name))
      continue
    const [px, py] = project(coordinate)
    ctx.strokeText(name, x(px), y(py))
    ctx.fillText(name, x(px), y(py))
  }

  ctx.fillStyle = palette.property
  ctx.strokeStyle = palette.propertyStroke
  ctx.lineWidth = 1.35
  for (const listing of listings) {
    if (listing === selectedListing) continue
    const [px, py] = project(listing.coordinate)
    ctx.beginPath()
    ctx.arc(x(px), y(py), 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  ctx.font = '700 11px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  points.forEach(([px, py], index) => {
    const cx = x(px)
    const cy = y(py)
    ctx.beginPath()
    ctx.arc(cx, cy, 11, 0, Math.PI * 2)
    ctx.fillStyle = palette.pin
    ctx.fill()
    ctx.strokeStyle = palette.pinStroke
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = palette.pinCenter
    ctx.fillText(String(index + 1), cx, cy)
  })

  if (selectedListing) {
    const [px, py] = project(selectedListing.coordinate)
    const cx = x(px)
    const cy = y(py)
    ctx.beginPath()
    ctx.arc(cx, cy, 15, 0, Math.PI * 2)
    ctx.fillStyle = palette.propertySelectedHalo
    ctx.fill()

    ctx.beginPath()
    ctx.arc(cx, cy, 10.5, 0, Math.PI * 2)
    ctx.strokeStyle = palette.propertySelected
    ctx.globalAlpha = 0.72
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.globalAlpha = 1

    ctx.beginPath()
    ctx.arc(cx, cy, 7.2, 0, Math.PI * 2)
    ctx.fillStyle = palette.propertySelected
    ctx.fill()
    ctx.strokeStyle = palette.propertySelectedRing
    ctx.lineWidth = 2.5
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 2.3, 0, Math.PI * 2)
    ctx.fillStyle = palette.propertySelectedRing
    ctx.fill()
  }
}
