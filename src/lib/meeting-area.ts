import { boundsSizeKm, MAX_LIVE_AREA_KM2 } from './meeting-network'
import {
  distanceBetween,
  nearestNode,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

// Same scale as `boundsSizeKm` and `regionBounds`.
const KM_PER_DEGREE = 111.195
// Metres per degree, as `distanceBetween` measures them.
const METRES_PER_DEGREE = 111195
const MIN_MARGIN_KM = 0.75
const MAX_MARGIN_KM = 1.5
const MIN_SIDE_KM = 4
const SNAP_LIMIT_METRES = 200
// Loaded bounds are rounded outward to this many parts per degree (0.01°).
const BOUNDS_STEPS_PER_DEGREE = 100

/** Most people one area can start from; the area needs at least two. */
export const MAX_PEOPLE = 8

/**
 * A study area derived from people's locations. `invalid.index` is the first
 * point that is non-finite, beyond 180° east or west, or beyond 85° north or
 * south. `spanKm` is the longer side of the people's own bounding box, its
 * east-west side measured the short way round, across the 180° meridian when
 * that is shorter; the other sizes are those of the loaded bounds, measured
 * like `boundsSizeKm`. `antimeridian` is a group that would otherwise fit but
 * straddles the 180° meridian, which one set of bounds cannot cover.
 */
export type PeopleArea =
  | {
      kind: 'area'
      bounds: MeetingNetwork['bounds']
      widthKm: number
      heightKm: number
      spanKm: number
    }
  | { kind: 'too-few'; count: number }
  | { kind: 'invalid'; index: number }
  | { kind: 'too-large'; spanKm: number; areaKm2: number }
  | { kind: 'antimeridian'; spanKm: number }

function validPoint(point: unknown): point is Coordinate {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    typeof point[0] === 'number' &&
    typeof point[1] === 'number' &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 85
  )
}

function box(points: readonly Coordinate[]): MeetingNetwork['bounds'] {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const [longitude, latitude] of points) {
    west = Math.min(west, longitude)
    east = Math.max(east, longitude)
    south = Math.min(south, latitude)
    north = Math.max(north, latitude)
  }
  return [west, south, east, north]
}

/**
 * The shortest stretch of longitude holding every point: its western edge and
 * its width in degrees. Only a spread of more than 180° can be held more
 * tightly the other way round; then `crosses` is true and the stretch runs
 * east from `west` across the 180° meridian.
 */
function longitudeArc(points: readonly Coordinate[]): {
  west: number
  width: number
  crosses: boolean
} {
  const [west, , east] = box(points)
  const arc = { west, width: east - west, crosses: false }
  if (east - west <= 180) return arc
  const longitudes = points
    .map(([longitude]) => longitude)
    .sort((a, b) => a - b)
  // The gap the bounding box leaves out runs across the 180° meridian.
  let largestGap = 360 - (east - west)
  for (let i = 1; i < longitudes.length; i++) {
    const gap = longitudes[i] - longitudes[i - 1]
    if (gap > largestGap) {
      largestGap = gap
      arc.west = longitudes[i]
      arc.width = 360 - gap
      arc.crosses = true
    }
  }
  return arc
}

/**
 * Centre of the points' bounding box, or null when there are none. Points
 * closer together across the 180° meridian than around the world the other
 * way get the centre of that shorter stretch, between -180° and 180°.
 */
export function boxCenter(points: readonly Coordinate[]): Coordinate | null {
  if (!points.length) return null
  const [west, south, east, north] = box(points)
  const arc = longitudeArc(points)
  if (!arc.crosses) return [(west + east) / 2, (south + north) / 2]
  const longitude = arc.west + arc.width / 2
  return [longitude > 180 ? longitude - 360 : longitude, (south + north) / 2]
}

/**
 * Sides in km of the area around a spread of `spreadWidth` × `spreadHeight`
 * km: a margin of a fifth of the longer spread (0.75 to 1.5 km) on each side,
 * then at least 4 km and at least half the longer side.
 */
function areaSides(spreadWidth: number, spreadHeight: number) {
  const spanKm = Math.max(spreadWidth, spreadHeight)
  const margin = Math.min(MAX_MARGIN_KM, Math.max(MIN_MARGIN_KM, 0.2 * spanKm))
  const shortest = Math.max(MIN_SIDE_KM, (spanKm + 2 * margin) / 2)
  return {
    spanKm,
    widthKm: Math.max(spreadWidth + 2 * margin, shortest),
    heightKm: Math.max(spreadHeight + 2 * margin, shortest),
  }
}

/**
 * The rectangle to load around everyone: their bounding box with a margin of
 * 0.75 to 1.5 km (a fifth of the spread) on each side, then grown about its
 * centre to at least 4 km a side and to at least half its longer side, so a
 * walk between people on one long street still fits. Clamped to 85° north and
 * south and to 180° east and west, then rounded outward to 0.01°, so the
 * bounds never reveal anyone's exact coordinates and the same group always
 * gets the same bounds. Away from those clamps, every point lies inside with
 * at least the margin on each side, east-west distances being measured along
 * the middle latitude. Refused above `MAX_LIVE_AREA_KM2`, measured after
 * rounding, and when the people straddle the 180° meridian.
 */
export function areaFromPeople(points: readonly Coordinate[]): PeopleArea {
  if (points.length < 2) return { kind: 'too-few', count: points.length }
  const index = points.findIndex((point) => !validPoint(point))
  if (index !== -1) return { kind: 'invalid', index }
  const [west, south, east, north] = box(points)
  const middle = (south + north) / 2
  const kmPerLongitude = Math.cos((middle * Math.PI) / 180) * KM_PER_DEGREE
  const spreadHeight = (north - south) * KM_PER_DEGREE
  const arc = longitudeArc(points)
  if (arc.crosses) {
    // Sized as if one map could hold them, to tell a wrong address from a
    // group that is merely on both sides of the meridian.
    const { spanKm, widthKm, heightKm } = areaSides(
      arc.width * kmPerLongitude,
      spreadHeight,
    )
    const areaKm2 = widthKm * heightKm
    return areaKm2 > MAX_LIVE_AREA_KM2
      ? { kind: 'too-large', spanKm, areaKm2 }
      : { kind: 'antimeridian', spanKm }
  }
  const sides = areaSides((east - west) * kmPerLongitude, spreadHeight)
  const { spanKm } = sides
  const halfLongitude = sides.widthKm / 2 / kmPerLongitude
  const halfLatitude = sides.heightKm / 2 / KM_PER_DEGREE
  const center = (west + east) / 2
  const steps = BOUNDS_STEPS_PER_DEGREE
  const bounds: MeetingNetwork['bounds'] = [
    Math.max(-180, Math.floor((center - halfLongitude) * steps) / steps),
    Math.max(-85, Math.floor((middle - halfLatitude) * steps) / steps),
    Math.min(180, Math.ceil((center + halfLongitude) * steps) / steps),
    Math.min(85, Math.ceil((middle + halfLatitude) * steps) / steps),
  ]
  const { widthKm, heightKm, areaKm2 } = boundsSizeKm(bounds)
  if (areaKm2 > MAX_LIVE_AREA_KM2) return { kind: 'too-large', spanKm, areaKm2 }
  return { kind: 'area', bounds, widthKm, heightKm, spanKm }
}

/**
 * The end of the road segment passing closest to `coordinate`, when that
 * segment passes within 200 m: the segment's end nearer to `coordinate`, its
 * first end on a tie. Distances use a flat projection along each segment's
 * middle latitude, as `distanceBetween` does.
 */
function nearestSegmentEnd(
  network: MeetingNetwork,
  coordinate: Coordinate,
): number | null {
  const [longitude, latitude] = coordinate
  let best = Infinity
  let from = -1
  let to = -1
  for (const [a, b] of network.edges) {
    const [aLongitude, aLatitude] = network.nodes[a]
    const [bLongitude, bLatitude] = network.nodes[b]
    const scale = Math.cos(((aLatitude + bLatitude) * Math.PI) / 360)
    const dx = (bLongitude - aLongitude) * scale
    const dy = bLatitude - aLatitude
    const px = (longitude - aLongitude) * scale
    const py = latitude - aLatitude
    const length = dx * dx + dy * dy
    const along =
      length > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0
    const ex = px - along * dx
    const ey = py - along * dy
    const squared = ex * ex + ey * ey
    if (squared < best) {
      best = squared
      from = a
      to = b
    }
  }
  if (from < 0 || Math.sqrt(best) * METRES_PER_DEGREE > SNAP_LIMIT_METRES)
    return null
  return distanceBetween(coordinate, network.nodes[to]) <
    distanceBetween(coordinate, network.nodes[from])
    ? to
    : from
}

/**
 * The node a person starts from, only when the person is inside the loaded
 * bounds and within 200 m of a connected path: the nearest node when it is
 * that close, otherwise the nearer end of the closest road segment, so a
 * person halfway along a long straight road is still placed.
 */
export function placePerson(
  network: MeetingNetwork,
  coordinate: Coordinate,
): number | null {
  const [west, south, east, north] = network.bounds
  const [longitude, latitude] = coordinate
  // Written as inclusions so that NaN coordinates are never placed.
  if (!(
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  ))
    return null
  const node = nearestNode(network, coordinate)
  return distanceBetween(coordinate, network.nodes[node]) <= SNAP_LIMIT_METRES
    ? node
    : nearestSegmentEnd(network, coordinate)
}
