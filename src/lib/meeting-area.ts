import { boundsSizeKm, MAX_LIVE_AREA_KM2 } from './meeting-network'
import {
  distanceBetween,
  nearestNode,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

// Same scale as `boundsSizeKm` and `regionBounds`.
const KM_PER_DEGREE = 111.195
const MIN_MARGIN_KM = 0.75
const MAX_MARGIN_KM = 1.5
const MIN_SIDE_KM = 4
const SNAP_LIMIT_METRES = 200

/** Most people one area can start from; the area needs at least two. */
export const MAX_PEOPLE = 8

/**
 * A study area derived from people's locations. `invalid.index` is the first
 * point that is non-finite, beyond 180° east or west, or beyond 85° north or
 * south. `spanKm` is the longer side of the people's own bounding box; the
 * other sizes are those of the loaded bounds, measured like `boundsSizeKm`.
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

/** Centre of the points' bounding box, or null when there are none. */
export function boxCenter(points: readonly Coordinate[]): Coordinate | null {
  if (!points.length) return null
  const [west, south, east, north] = box(points)
  return [(west + east) / 2, (south + north) / 2]
}

/**
 * The rectangle to load around everyone: their bounding box with a margin of
 * 0.75 to 1.5 km (a fifth of the spread) on each side, then grown about its
 * centre to at least 4 km a side and to at least half its longer side, so a
 * walk between people on one long street still fits. Clamped to 85° north and
 * south and to 180° east and west. Away from those clamps, every point lies
 * inside with at least the margin on each side, east-west distances being
 * measured along the middle latitude. Refused above `MAX_LIVE_AREA_KM2`.
 */
export function areaFromPeople(points: readonly Coordinate[]): PeopleArea {
  if (points.length < 2) return { kind: 'too-few', count: points.length }
  const index = points.findIndex((point) => !validPoint(point))
  if (index !== -1) return { kind: 'invalid', index }
  const [west, south, east, north] = box(points)
  const middle = (south + north) / 2
  const kmPerLongitude = Math.cos((middle * Math.PI) / 180) * KM_PER_DEGREE
  const spreadWidth = (east - west) * kmPerLongitude
  const spreadHeight = (north - south) * KM_PER_DEGREE
  const spanKm = Math.max(spreadWidth, spreadHeight)
  const margin = Math.min(MAX_MARGIN_KM, Math.max(MIN_MARGIN_KM, 0.2 * spanKm))
  // No side under 4 km or under half the longer side.
  const shortest = Math.max(MIN_SIDE_KM, (spanKm + 2 * margin) / 2)
  const halfLongitude =
    Math.max(spreadWidth + 2 * margin, shortest) / 2 / kmPerLongitude
  const halfLatitude =
    Math.max(spreadHeight + 2 * margin, shortest) / 2 / KM_PER_DEGREE
  const center = (west + east) / 2
  const bounds: MeetingNetwork['bounds'] = [
    Math.max(-180, center - halfLongitude),
    Math.max(-85, middle - halfLatitude),
    Math.min(180, center + halfLongitude),
    Math.min(85, middle + halfLatitude),
  ]
  const { widthKm, heightKm, areaKm2 } = boundsSizeKm(bounds)
  if (areaKm2 > MAX_LIVE_AREA_KM2) return { kind: 'too-large', spanKm, areaKm2 }
  return { kind: 'area', bounds, widthKm, heightKm, spanKm }
}

/**
 * The node a person starts from: the nearest node, but only when the person is
 * inside the loaded bounds and within 200 m of a connected path.
 */
export function placePerson(
  network: MeetingNetwork,
  coordinate: Coordinate,
): number | null {
  const [west, south, east, north] = network.bounds
  const [longitude, latitude] = coordinate
  // Written as inclusions so that NaN coordinates are never placed.
  if (
    !(
      longitude >= west &&
      longitude <= east &&
      latitude >= south &&
      latitude <= north
    )
  )
    return null
  const node = nearestNode(network, coordinate)
  return distanceBetween(coordinate, network.nodes[node]) <= SNAP_LIMIT_METRES
    ? node
    : null
}
