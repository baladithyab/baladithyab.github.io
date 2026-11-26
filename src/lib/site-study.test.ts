import { describe, expect, it } from 'vitest'
import {
  cellIndex,
  prepareDriveStudy,
  project,
  unproject,
  type CensusData,
  type Point,
  type RoadData,
} from './site-study'
import { parseListings } from './site-study-listings'

const west: Point = [38_125, 28_125]
const origin: Point = [39_125, 28_125]
const fiveMinutes: Point = [40_125, 28_125]
const tenMinutes: Point = [41_125, 28_125]
const fifteenMinutes: Point = [42_125, 28_125]
const grid: CensusData = {
  cellSize: 250,
  columns: 280,
  rows: 250,
  outline: [],
  cells: [],
}
grid.cells = [
  [cellIndex(grid, west), 100, 40, 5],
  [cellIndex(grid, origin), 5, 2, 1],
  [cellIndex(grid, fiveMinutes), 10, 4, 3],
  [cellIndex(grid, tenMinutes), 20, 8, 6],
  [cellIndex(grid, fifteenMinutes), 30, 12, 4],
]
const roads: RoadData = {
  nodes: [west, origin, fiveMinutes, tenMinutes, fifteenMinutes],
  edges: [
    [0, 1, 120, 1, 0],
    [1, 2, 250, 1, 0],
    [2, 3, 260, 1, 0],
    [3, 4, 265, 1, 0],
  ],
  date: 'fixture',
}

describe('drive study', () => {
  it('observes one-way roads and accumulates estimates inside each time area', () => {
    const result = prepareDriveStudy(roads, grid)(unproject(origin))
    expect(result.times[cellIndex(grid, west)]).toBe(Infinity)
    expect(result.stats).toEqual([
      { residents: 15, households: 6, renters: 4 },
      { residents: 35, households: 14, renters: 10 },
      { residents: 65, households: 26, renters: 14 },
    ])
  })

  it('does not drive backward from the middle of a one-way segment', () => {
    const result = prepareDriveStudy(roads, grid)(unproject([39_625, 28_125]))
    expect(result.times[cellIndex(grid, origin)]).toBe(Infinity)
    expect(result.times[cellIndex(grid, fiveMinutes)]).toBeCloseTo(125)
  })

  it('does not silently move distant or out-of-region sites', () => {
    const study = prepareDriveStudy(roads, grid)
    expect(() => study(unproject([42_125, 29_125]))).toThrow('within 400 m')
    expect(() => study([-122.5, 37.7])).toThrow('study boundary')
    expect(cellIndex(grid, project([-122.5, 37.7]))).toBe(-1)
  })
})

describe('listing CSV', () => {
  it('accepts HomeHarvest coordinates and quoted addresses without substituting missing values', () => {
    const csv =
      '\uFEFFformatted_address,latitude,longitude,list_price,sold_price,status\r\n' +
      '"123 Main St, Unit ""B""",37.3388,-121.8863,"$800,000",799000,sold\r\n' +
      'Missing coordinate,,-121.88,900000,,for_sale\r\n' +
      'Another site,37.34,-121.87,,,for_rent\r\n'
    expect(parseListings(csv)).toEqual([
      {
        address: '123 Main St, Unit "B"',
        coordinate: [-121.8863, 37.3388],
        price: 799000,
        status: 'sold',
      },
      {
        address: 'Another site',
        coordinate: [-121.87, 37.34],
        price: null,
        status: 'for rent',
      },
    ])
  })

  it('rejects files without usable coordinates', () => {
    expect(() => parseListings('address,price\nMain,1')).toThrow(
      'latitude and longitude',
    )
    expect(() => parseListings('lat,lng\nNaN,500')).toThrow('no rows')
  })
})
