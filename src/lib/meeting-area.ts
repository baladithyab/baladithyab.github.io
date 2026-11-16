import type { StudySize } from './meeting-network-loader'
import {
  distanceBetween,
  nearestNode,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

// Same scale as `regionBounds`, so a derived square always contains its people.
const KM_PER_DEGREE = 111.195
const SIZES = [4, 8, 12] as const satisfies readonly StudySize[]
const MIN_MARGIN_KM = 0.75
const MAX_MARGIN_KM = 1.5
const SNAP_LIMIT_METRES = 200

/** Most people one area can start from; the area needs at least two. */
export const MAX_PEOPLE = 8

/** Widest spread of people that still fits the largest study square. */
export const MAX_PEOPLE_SPAN_KM = SIZES[SIZES.length - 1] - 2 * MAX_MARGIN_KM

/**
 * A study area derived from people's locations. `invalid.index` is the first
 * point that is non-finite, beyond 180° east or west, or beyond 85° north or
 * south.
 */
export type PeopleArea =
  | { kind: 'area'; center: Coordinate; sizeKm: StudySize; spanKm: number }
  | { kind: 'too-few'; count: number }
  | { kind: 'invalid'; index: number }
  | { kind: 'too-far'; spanKm: number }

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
 * The smallest 4, 8 or 12 km study square around everyone, with a margin of
 * 0.75 to 1.5 km on each side. On success every point lies inside
 * `regionBounds(center, sizeKm)`.
 */
export function areaFromPeople(points: readonly Coordinate[]): PeopleArea {
  if (points.length < 2) return { kind: 'too-few', count: points.length }
  const index = points.findIndex((point) => !validPoint(point))
  if (index !== -1) return { kind: 'invalid', index }
  const [west, south, east, north] = box(points)
  const middle = (south + north) / 2
  const spanKm = Math.max(
    (east - west) * Math.cos((middle * Math.PI) / 180) * KM_PER_DEGREE,
    (north - south) * KM_PER_DEGREE,
  )
  const margin = Math.min(MAX_MARGIN_KM, Math.max(MIN_MARGIN_KM, 0.2 * spanKm))
  const required = spanKm + 2 * margin
  const sizeKm = SIZES.find((size) => size >= required)
  if (sizeKm === undefined) return { kind: 'too-far', spanKm }
  return { kind: 'area', center: [(west + east) / 2, middle], sizeKm, spanKm }
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
