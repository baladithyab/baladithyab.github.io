import { describe, expect, it } from 'vitest'
import {
  areaFromPeople,
  MAX_PEOPLE_SPAN_KM,
  placePerson,
  type PeopleArea,
} from './meeting-area'
import { regionBounds } from './meeting-network-loader'
import type { Coordinate, MeetingNetwork } from './meeting-point'

const KM_PER_DEGREE = 111.195

/** Two people `km` apart due north-south, starting at `origin`. */
const northSouth = (km: number, origin: Coordinate = [-122.42, 37.77]) =>
  [origin, [origin[0], origin[1] + km / KM_PER_DEGREE]] satisfies Coordinate[]

function expectArea(result: PeopleArea) {
  if (result.kind !== 'area')
    throw new Error(`Expected an area, got ${JSON.stringify(result)}`)
  return result
}

function expectInside(points: Coordinate[]) {
  const area = expectArea(areaFromPeople(points))
  const [west, south, east, north] = regionBounds(area.center, area.sizeKm)
  for (const [longitude, latitude] of points) {
    expect(longitude).toBeGreaterThanOrEqual(west)
    expect(longitude).toBeLessThanOrEqual(east)
    expect(latitude).toBeGreaterThanOrEqual(south)
    expect(latitude).toBeLessThanOrEqual(north)
  }
  return area
}

describe('areaFromPeople', () => {
  it('loads the smallest square for two people a few streets apart', () => {
    const area = expectInside([
      [-122.4194, 37.7749],
      [-122.4094, 37.7799],
    ])
    expect(area.sizeKm).toBe(4)
    expect(area.spanKm).toBeCloseTo(0.88, 1)
    expect(area.center[0]).toBeCloseTo(-122.4144, 6)
    expect(area.center[1]).toBeCloseTo(37.7774, 6)
  })

  it('grows to 8 and 12 km only when the spread and its margins need it', () => {
    // 4 km fits a spread of up to 2.5 km (0.75 km margin on each side).
    expect(expectInside(northSouth(2.4)).sizeKm).toBe(4)
    expect(expectInside(northSouth(2.6)).sizeKm).toBe(8)
    // 8 km fits up to about 5.7 km (margin is a fifth of the spread).
    expect(expectInside(northSouth(5.6)).sizeKm).toBe(8)
    expect(expectInside(northSouth(5.8)).sizeKm).toBe(12)
    expect(expectInside(northSouth(8.9)).sizeKm).toBe(12)
  })

  it('reports people just beyond the 12 km square as too far apart, with the spread', () => {
    expect(MAX_PEOPLE_SPAN_KM).toBe(9)
    const result = areaFromPeople(northSouth(9.05))
    expect(result.kind).toBe('too-far')
    expect(result.kind === 'too-far' && result.spanKm).toBeCloseTo(9.05, 6)
    const across = areaFromPeople([
      [2.35, 48.85],
      [-0.12, 51.5],
    ])
    expect(across.kind === 'too-far' && across.spanKm).toBeGreaterThan(290)
  })

  it('measures east-west spread in kilometres, not degrees, at 60° north', () => {
    // 0.15° of longitude is about 8.3 km at 60° north but 16.7 km at the equator.
    const points: Coordinate[] = [
      [10.0, 60.0],
      [10.15, 60.03],
      [10.05, 60.01],
    ]
    const area = expectInside(points)
    expect(area.sizeKm).toBe(12)
    expect(area.spanKm).toBeCloseTo(
      0.15 * Math.cos((60.015 * Math.PI) / 180) * KM_PER_DEGREE,
      6,
    )
  })

  it('keeps every person inside the loaded square across latitudes and layouts', () => {
    // Park–Miller generator: deterministic layouts without float overflow.
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    let checked = 0
    for (const latitude of [-84.9, -45, 0, 37.77, 60, 72, 84.9]) {
      const longitudeStretch = Math.cos((latitude * Math.PI) / 180)
      for (let trial = 0; trial < 40; trial++) {
        const count = 2 + Math.floor(random() * 7)
        const widthKm = random() * 9.5
        const points = Array.from(
          { length: count },
          (): Coordinate => [
            ((random() - 0.5) * widthKm) / (KM_PER_DEGREE * longitudeStretch),
            Math.max(
              -85,
              Math.min(
                85,
                latitude + ((random() - 0.5) * widthKm) / KM_PER_DEGREE,
              ),
            ),
          ],
        )
        if (areaFromPeople(points).kind !== 'area') continue
        expectInside(points)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('distinguishes too few people from an unusable coordinate', () => {
    expect(areaFromPeople([])).toEqual({ kind: 'too-few', count: 0 })
    expect(areaFromPeople([[-122.42, 37.77]])).toEqual({
      kind: 'too-few',
      count: 1,
    })
    const near: Coordinate = [-122.42, 37.77]
    for (const bad of [
      [Number.NaN, 37.77],
      [-122.42, Number.POSITIVE_INFINITY],
      [180.5, 37.77],
      [-122.42, 85.1],
      [-122.42, -85.1],
    ] satisfies Coordinate[]) {
      expect(areaFromPeople([near, near, bad])).toEqual({
        kind: 'invalid',
        index: 2,
      })
    }
  })
})

describe('placePerson', () => {
  const network: MeetingNetwork = {
    version: 1,
    name: 'Test path',
    bounds: [-122.421, 37.769, -122.414, 37.774],
    attribution: 'test',
    source: 'test',
    fetched: '2026-11-16',
    nodes: [
      [-122.42, 37.77],
      [-122.415, 37.77],
    ],
    edges: [[0, 1, 440]],
    places: [],
  }

  it('places a person on the nearest node within 200 m of a path', () => {
    expect(placePerson(network, [-122.4152, 37.7708])).toBe(1)
    expect(placePerson(network, [-122.4199, 37.7701])).toBe(0)
  })

  it('leaves a person unplaced when far from a path, outside the area or unusable', () => {
    // About 330 m north of node 0, still inside the bounds.
    expect(placePerson(network, [-122.42, 37.773])).toBeNull()
    // About 130 m east of node 1, but east of the loaded bounds.
    expect(placePerson(network, [-122.4135, 37.77])).toBeNull()
    expect(placePerson(network, [Number.NaN, 37.77])).toBeNull()
  })
})
