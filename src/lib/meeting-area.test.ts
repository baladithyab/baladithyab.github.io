import { describe, expect, it } from 'vitest'
import {
  areaFromPeople,
  boxCenter,
  placePerson,
  type PeopleArea,
} from './meeting-area'
import { boundsSizeKm, MAX_LIVE_AREA_KM2 } from './meeting-network'
import type { Coordinate, MeetingNetwork } from './meeting-point'

const KM_PER_DEGREE = 111.195
// Rounding a bound outward to 0.01° moves it by less than this many km north-south.
const LATITUDE_STEP_KM = 0.01 * KM_PER_DEGREE

/** Two people `km` apart due north-south, starting at `origin`. */
const northSouth = (km: number, origin: Coordinate = [-122.42, 37.77]) =>
  [origin, [origin[0], origin[1] + km / KM_PER_DEGREE]] satisfies Coordinate[]

/** Two people at opposite corners of a `widthKm` × `heightKm` box from `origin`. */
function corners(
  widthKm: number,
  heightKm: number,
  origin: Coordinate = [-122.42, 37.77],
): Coordinate[] {
  const north = origin[1] + heightKm / KM_PER_DEGREE
  const middle = (origin[1] + north) / 2
  const east =
    origin[0] + widthKm / (KM_PER_DEGREE * Math.cos((middle * Math.PI) / 180))
  return [origin, [east, north]]
}

function expectArea(result: PeopleArea) {
  if (result.kind !== 'area')
    throw new Error(`Expected an area, got ${JSON.stringify(result)}`)
  return result
}

/**
 * Everyone is inside the area, and unless a side is clamped at 85° or 180°,
 * at least the margin from each edge. East-west kilometres are measured along
 * the area's middle latitude, as `boundsSizeKm` measures them. Every bound is
 * a whole multiple of 0.01°.
 */
function expectInside(points: Coordinate[]) {
  const area = expectArea(areaFromPeople(points))
  const [west, south, east, north] = area.bounds
  const margin = Math.min(1.5, Math.max(0.75, 0.2 * area.spanKm)) - 1e-9
  const kmPerLongitude =
    Math.cos(((south + north) * Math.PI) / 360) * KM_PER_DEGREE
  for (const [longitude, latitude] of points) {
    expect(longitude).toBeGreaterThanOrEqual(west)
    expect(longitude).toBeLessThanOrEqual(east)
    expect(latitude).toBeGreaterThanOrEqual(south)
    expect(latitude).toBeLessThanOrEqual(north)
    if (west > -180)
      expect((longitude - west) * kmPerLongitude).toBeGreaterThanOrEqual(margin)
    if (east < 180)
      expect((east - longitude) * kmPerLongitude).toBeGreaterThanOrEqual(margin)
    if (south > -85)
      expect((latitude - south) * KM_PER_DEGREE).toBeGreaterThanOrEqual(margin)
    if (north < 85)
      expect((north - latitude) * KM_PER_DEGREE).toBeGreaterThanOrEqual(margin)
  }
  for (const bound of area.bounds)
    expect(Math.abs(bound * 100 - Math.round(bound * 100))).toBeLessThan(1e-6)
  // The reported size is the loaded bounds' size.
  const size = boundsSizeKm(area.bounds)
  expect(area.widthKm).toBeCloseTo(size.widthKm, 9)
  expect(area.heightKm).toBeCloseTo(size.heightKm, 9)
  return area
}

/**
 * The loaded sides are the unrounded `widthKm` × `heightKm`, each grown by
 * rounding both of its edges outward by less than 0.01°.
 */
function expectGrown(
  area: Extract<PeopleArea, { kind: 'area' }>,
  widthKm: number,
  heightKm: number,
) {
  const [, south, , north] = area.bounds
  const longitudeStepKm =
    LATITUDE_STEP_KM * Math.cos(((south + north) * Math.PI) / 360)
  // A few metres of slack: rounding also moves the middle latitude slightly.
  expect(area.widthKm).toBeGreaterThan(widthKm - 0.01)
  expect(area.widthKm).toBeLessThan(widthKm + 2 * longitudeStepKm + 0.01)
  expect(area.heightKm).toBeGreaterThan(heightKm - 1e-6)
  expect(area.heightKm).toBeLessThan(heightKm + 2 * LATITUDE_STEP_KM + 1e-6)
}

describe('areaFromPeople', () => {
  it('loads at least 4 × 4 km around two people a few streets apart, rounded outward to 0.01°', () => {
    const area = expectInside([
      [-122.4194, 37.7749],
      [-122.4094, 37.7799],
    ])
    expect(area.spanKm).toBeCloseTo(0.88, 1)
    expectGrown(area, 4, 4)
    expect(area.bounds).toEqual([-122.44, 37.75, -122.39, 37.8])
    // Still about centred on them: rounding moves the centre under 0.005°.
    const [west, south, east, north] = area.bounds
    expect(Math.abs((west + east) / 2 - -122.4144)).toBeLessThan(0.005)
    expect(Math.abs((south + north) / 2 - 37.7774)).toBeLessThan(0.005)
  })

  it('gives nearby groups the same bounds, so the bounds do not pin anyone down', () => {
    const moved = areaFromPeople([
      [-122.419, 37.7753],
      [-122.409, 37.7803],
    ])
    expect(expectArea(moved).bounds).toEqual([-122.44, 37.75, -122.39, 37.8])
  })

  it('keeps sides of about 4 km for a 1.8 km spread', () => {
    for (const points of [northSouth(1.8), corners(1.8, 1.2)]) {
      const area = expectInside(points)
      expect(area.spanKm).toBeCloseTo(1.8, 6)
      expectGrown(area, 4, 4)
    }
  })

  it('fits three East Bay addresses 24.76 km apart in about 29 × 27 km', () => {
    const area = expectInside([
      [-121.7126641, 37.7277714],
      [-121.993815, 37.5533782],
      [-121.9821409, 37.5274813],
    ])
    expect(area.spanKm).toBeCloseTo(24.76, 2)
    // Unrounded, the area was [-122.01085, 37.51399, -121.69563, 37.74126]:
    // about 27.8 × 25.3 km.
    expectGrown(area, 27.8, 25.3)
    expect(area.bounds).toEqual([-122.02, 37.51, -121.69, 37.75])
    expect(area.widthKm).toBeCloseTo(29.06, 2)
    expect(area.heightKm).toBeCloseTo(26.69, 2)
  })

  it('makes the short side at least half the long side for a long, thin group', () => {
    // Two people 20 km apart on one street: 23 km long with margins.
    const tall = expectInside(northSouth(20))
    expectGrown(tall, 11.5, 23)
    expect(tall.widthKm * 2).toBeGreaterThanOrEqual(
      tall.heightKm - 2 * LATITUDE_STEP_KM,
    )
    const wide = expectInside(corners(30, 2))
    expectGrown(wide, 33, 16.5)
    // A group already wider than half its length keeps its own shape.
    const broad = expectInside(corners(20, 15))
    expectGrown(broad, 23, 18)
  })

  it('measures east-west spread in kilometres, not degrees, at 60° north', () => {
    // 0.15° of longitude is about 8.3 km at 60° north but 16.7 km at the equator.
    const points: Coordinate[] = [
      [10.0, 60.0],
      [10.15, 60.03],
      [10.05, 60.01],
    ]
    const area = expectInside(points)
    expect(area.spanKm).toBeCloseTo(
      0.15 * Math.cos((60.015 * Math.PI) / 180) * KM_PER_DEGREE,
      6,
    )
    // 8.3 × 3.3 km apart: a 1.5 km margin, already more than half as tall as wide.
    expectGrown(area, area.spanKm + 2 * 1.5, 0.03 * KM_PER_DEGREE + 2 * 1.5)
  })

  it('keeps everyone inside with a margin across latitudes, layouts and sizes', () => {
    // Park–Miller generator: deterministic layouts without float overflow.
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    let checked = 0
    for (const latitude of [-84.9, -60, -45, 0, 37.77, 60, 72, 84.9]) {
      const longitudeStretch = Math.cos((latitude * Math.PI) / 180)
      for (let trial = 0; trial < 40; trial++) {
        const count = 2 + Math.floor(random() * 7)
        const widthKm = random() ** 2 * 80
        const heightKm = random() ** 2 * 80
        const points = Array.from({ length: count }, (): Coordinate => [
          ((random() - 0.5) * widthKm) / (KM_PER_DEGREE * longitudeStretch),
          Math.max(
            -85,
            Math.min(
              85,
              latitude + ((random() - 0.5) * heightKm) / KM_PER_DEGREE,
            ),
          ),
        ])
        const result = areaFromPeople(points)
        if (result.kind === 'too-large') {
          expect(result.areaKm2).toBeGreaterThan(MAX_LIVE_AREA_KM2)
          continue
        }
        const area = expectInside(points)
        expect(area.widthKm * area.heightKm).toBeLessThanOrEqual(
          MAX_LIVE_AREA_KM2,
        )
        checked++
      }
    }
    expect(checked).toBeGreaterThan(250)
  })

  it('refuses only areas above the live-area limit once rounded, with the spread and area', () => {
    // Rounding outward adds up to about 2.2 km a side: a square spread of 58 km
    // loads about 61 × 62 km (3,818 km²); 61 km is 64 × 64 km before rounding.
    const fits = expectInside(corners(58, 58))
    expect(fits.widthKm * fits.heightKm).toBeLessThanOrEqual(MAX_LIVE_AREA_KM2)
    const over = areaFromPeople(corners(61, 61))
    expect(over.kind).toBe('too-large')
    expect(over.kind === 'too-large' && over.areaKm2).toBeGreaterThan(
      MAX_LIVE_AREA_KM2,
    )
    const far = areaFromPeople(northSouth(200))
    expect(far.kind).toBe('too-large')
    expect(far.kind === 'too-large' && far.spanKm).toBeCloseTo(200, 6)
    const across = areaFromPeople([
      [2.35, 48.85],
      [-0.12, 51.5],
    ])
    expect(across.kind === 'too-large' && across.spanKm).toBeGreaterThan(290)
  })

  it('refuses people on either side of the 180° meridian, measuring them the short way', () => {
    // 222 m apart across the meridian, not 40,000 km apart around the world.
    const close = areaFromPeople([
      [179.999, 10],
      [-179.999, 10],
    ])
    expect(close.kind).toBe('antimeridian')
    expect(close.kind === 'antimeridian' && close.spanKm).toBeCloseTo(0.219, 3)
    const fijiPair = areaFromPeople([
      [179.9, -17.8],
      [-179.9, -17.7],
    ])
    expect(fijiPair.kind).toBe('antimeridian')
    expect(fijiPair.kind === 'antimeridian' && fijiPair.spanKm).toBeCloseTo(
      0.2 * Math.cos((17.75 * Math.PI) / 180) * KM_PER_DEGREE,
      6,
    )
    // One place, written as both 180° and -180°.
    expect(
      areaFromPeople([
        [-180, 52],
        [180, 52],
      ]),
    ).toEqual({ kind: 'antimeridian', spanKm: 0 })
    // Across the meridian but far apart: too large, measured the short way.
    const fijiHawaii = areaFromPeople([
      [178.44, -18.14],
      [-157.86, 21.31],
    ])
    expect(fijiHawaii.kind).toBe('too-large')
    expect(fijiHawaii.kind === 'too-large' && fijiHawaii.spanKm).toBeLessThan(
      5000,
    )
    // Spread over more than half the world without crossing it: too large.
    expect(
      areaFromPeople([
        [-100, 0],
        [0, 0],
        [100, 0],
      ]).kind,
    ).toBe('too-large')
    // People on one side of it get an area clamped at 180°.
    const fiji = expectInside([
      [179.999, -16.8],
      [179.98, -16.79],
    ])
    expect(fiji.bounds[2]).toBe(180)
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

describe('boxCenter', () => {
  it('centres the bounding box, or nothing without points', () => {
    expect(boxCenter([])).toBeNull()
    const center = boxCenter([
      [-122.42, 37.77],
      [-122.4, 37.79],
      [-122.41, 37.75],
    ])
    expect(center?.[0]).toBeCloseTo(-122.41, 9)
    expect(center?.[1]).toBeCloseTo(37.77, 9)
    // More than half the world apart the short way round: the plain middle.
    expect(
      boxCenter([
        [-100, 0],
        [0, 0],
        [100, 0],
      ]),
    ).toEqual([0, 0])
  })

  it('centres people across the 180° meridian there, not at 0°', () => {
    const east = boxCenter([
      [179.8, 0],
      [-179.9, 1],
    ])
    expect(east?.[0]).toBeCloseTo(179.95, 9)
    expect(east?.[1]).toBeCloseTo(0.5, 9)
    const west = boxCenter([
      [179.9, 0],
      [-179.8, 1],
    ])
    expect(west?.[0]).toBeCloseTo(-179.95, 9)
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

  it('places a person halfway along a long straight road on its nearer end', () => {
    // One 1,112 m road along the equator: its middle is 556 m from either end.
    const road: MeetingNetwork = {
      ...network,
      bounds: [-0.001, -0.001, 0.011, 0.003],
      nodes: [
        [0, 0],
        [0.01, 0],
      ],
      edges: [[0, 1, 1112]],
    }
    // About 100 m north of the road, a little east or west of its middle.
    expect(placePerson(road, [0.0052, 0.0009])).toBe(1)
    expect(placePerson(road, [0.0048, 0.0009])).toBe(0)
    expect(placePerson(road, [0.005, 0])).toBe(0)
    // About 300 m north of the road's middle: too far from any path.
    expect(placePerson(road, [0.005, 0.0027])).toBeNull()
  })
})
