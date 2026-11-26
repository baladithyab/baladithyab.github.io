import { MinHeap } from './meeting-point'
import type { Coordinate } from './meeting-point'

export type Point = [x: number, y: number]
type Road = [
  from: number,
  to: number,
  seconds: number,
  direction: number,
  rank: number,
]
export type RoadData = { nodes: Point[]; edges: Road[]; date: string }
export type CensusGrid = {
  cellSize: number
  columns: number
  rows: number
  outline: Point[][]
}
export type CensusData = CensusGrid & {
  // Sparse cells indexed from the southwest corner. Counts are area-weighted.
  cells: [
    index: number,
    residents: number,
    households: number,
    renters: number,
  ][]
}

export const studyBounds = [-122.34, 37.08, -121.53, 37.64] as const
export const originBounds = [-122.065, 37.21, -121.78, 37.48] as const
export const minutes = [5, 10, 15] as const
const longitudeMetres = 88_400
const latitudeMetres = 111_195
const maxSeconds = minutes[2] * 60
const localMetresPerSecond = 7

export const sites: { name: string; coordinate: Coordinate }[] = [
  { name: 'Downtown', coordinate: [-121.8863, 37.3388] },
  { name: 'Santana Row', coordinate: [-121.9494, 37.3201] },
  { name: 'North San José', coordinate: [-121.9348, 37.416] },
  { name: 'Almaden', coordinate: [-121.8794, 37.2449] },
]

export function project([lon, lat]: Coordinate): Point {
  return [
    (lon - studyBounds[0]) * longitudeMetres,
    (lat - studyBounds[1]) * latitudeMetres,
  ]
}

export function unproject([x, y]: Point): Coordinate {
  return [
    studyBounds[0] + x / longitudeMetres,
    studyBounds[1] + y / latitudeMetres,
  ]
}

export function isStudyOrigin([lon, lat]: Coordinate) {
  const [west, south, east, north] = originBounds
  return lon >= west && lon <= east && lat >= south && lat <= north
}

export function cellIndex(data: CensusGrid, [x, y]: Point) {
  const col = Math.floor(x / data.cellSize)
  const row = Math.floor(y / data.cellSize)
  if (col < 0 || col >= data.columns || row < 0 || row >= data.rows) return -1
  return row * data.columns + col
}

export type AreaStats = {
  residents: number
  households: number
  renters: number
}
export type SiteResult = {
  times: Float32Array
  stats: AreaStats[]
  snapped: Point
  clipped: boolean
}

export function prepareDriveStudy(roads: RoadData, census: CensusData) {
  const { nodes, edges } = roads
  const { columns, rows, cellSize } = census
  const offsets = new Uint32Array(nodes.length + 1)
  for (const [a, b, , direction] of edges) {
    if (direction >= 0) offsets[a + 1]++
    if (direction <= 0) offsets[b + 1]++
  }
  for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1]
  const next = offsets.slice()
  const targets = new Uint32Array(offsets[nodes.length])
  const costs = new Float32Array(targets.length)
  for (const [a, b, seconds, direction] of edges) {
    if (direction >= 0) {
      const arc = next[a]++
      targets[arc] = b
      costs[arc] = seconds
    }
    if (direction <= 0) {
      const arc = next[b]++
      targets[arc] = a
      costs[arc] = seconds
    }
  }

  return (coordinate: Coordinate): SiteResult => {
    if (!isStudyOrigin(coordinate))
      throw new Error('Choose a site inside the dashed study boundary.')
    const point = project(coordinate)
    let nearest: Road | undefined
    let fraction = 0
    let snapped: Point = point
    let gap = 400
    for (const edge of edges) {
      const [a, b, , , rank] = edge
      if (rank === 3) continue // Controlled-access roads are reachable via their ramps.
      const [x, y] = nodes[a]
      const dx = nodes[b][0] - x
      const dy = nodes[b][1] - y
      const lengthSquared = dx * dx + dy * dy
      if (lengthSquared === 0) continue
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point[0] - x) * dx + (point[1] - y) * dy) / lengthSquared,
        ),
      )
      const px = x + t * dx
      const py = y + t * dy
      const distance = Math.hypot(point[0] - px, point[1] - py)
      if (distance >= gap) continue
      nearest = edge
      fraction = t
      snapped = [px, py]
      gap = distance
    }
    if (!nearest)
      throw new Error('Choose a site within 400 m of a modeled street.')

    const [start, end, length, direction] = nearest
    const access = gap / localMetresPerSecond
    const distances = new Float64Array(nodes.length).fill(Infinity)
    const queue = new MinHeap()
    const relax = (node: number, seconds: number) => {
      if (seconds > maxSeconds || seconds >= distances[node]) return
      distances[node] = seconds
      queue.push(node, seconds)
    }
    if (direction <= 0 || fraction === 0)
      relax(start, access + fraction * length)
    if (direction >= 0 || fraction === 1)
      relax(end, access + (1 - fraction) * length)
    while (queue.length) {
      const [node, seconds] = queue.pop()
      if (seconds !== distances[node]) continue
      for (let arc = offsets[node]; arc < offsets[node + 1]; arc++) {
        relax(targets[arc], seconds + costs[arc])
      }
    }

    const times = new Float32Array(columns * rows).fill(Infinity)
    let clipped = false
    const stamp = (x: number, y: number, time: number, speed: number) => {
      if (time > maxSeconds) return
      const col = Math.floor(x / cellSize)
      const row = Math.floor(y / cellSize)
      if (col <= 0 || row <= 0 || col >= columns - 2 || row >= rows - 2)
        clipped = true
      for (
        let j = Math.max(0, row - 1);
        j <= Math.min(rows - 1, row + 1);
        j++
      ) {
        for (
          let i = Math.max(0, col - 1);
          i <= Math.min(columns - 1, col + 1);
          i++
        ) {
          const distance = Math.hypot(
            (i + 0.5) * cellSize - x,
            (j + 0.5) * cellSize - y,
          )
          const at = j * columns + i
          const arrival = time + distance / speed
          if (distance <= cellSize && arrival < times[at]) times[at] = arrival
        }
      }
    }
    for (const edge of edges) {
      const [a, b, seconds, oneWay, rank] = edge
      if (
        edge !== nearest &&
        !Number.isFinite(distances[a]) &&
        !Number.isFinite(distances[b])
      )
        continue
      const [x, y] = nodes[a]
      const dx = nodes[b][0] - x
      const dy = nodes[b][1] - y
      const metres = Math.hypot(dx, dy)
      const steps = Math.max(1, Math.ceil(metres / (cellSize / 2)))
      const speed = metres
        ? Math.min(localMetresPerSecond, metres / seconds)
        : localMetresPerSecond
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        let time = Math.min(
          oneWay >= 0 ? distances[a] + t * seconds : Infinity,
          oneWay <= 0 ? distances[b] + (1 - t) * seconds : Infinity,
        )
        if (
          edge === nearest &&
          (oneWay === 0 || (t - fraction) * oneWay >= 0)
        ) {
          time = Math.min(time, access + Math.abs(t - fraction) * seconds)
        }
        const px = x + t * dx
        const py = y + t * dy
        // Detect coverage loss on motorways too, without counting roadside access there.
        if (rank === 3) {
          if (
            time <= maxSeconds &&
            (px < cellSize ||
              py < cellSize ||
              px > (columns - 2) * cellSize ||
              py > (rows - 2) * cellSize)
          )
            clipped = true
        } else stamp(px, py, time, speed)
      }
    }
    const chord = Math.hypot(
      nodes[start][0] - nodes[end][0],
      nodes[start][1] - nodes[end][1],
    )
    stamp(
      snapped[0],
      snapped[1],
      access,
      Math.min(localMetresPerSecond, chord / length),
    )

    const stats = minutes.map((limit) => {
      const total = { residents: 0, households: 0, renters: 0 }
      for (const [index, residents, households, renters] of census.cells) {
        if (times[index] > limit * 60) continue
        total.residents += residents
        total.households += households
        total.renters += renters
      }
      return total
    })
    return { times, stats, snapped, clipped }
  }
}
