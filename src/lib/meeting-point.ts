export type Coordinate = [longitude: number, latitude: number]
export type MeetingNetwork = {
  version: 1
  name: string
  bounds: [west: number, south: number, east: number, north: number]
  attribution: string
  source: string
  fetched: string
  nodes: Coordinate[]
  edges: [from: number, to: number, metres: number][]
  places: { node: number; name: string }[]
}
export type Objective = 'fair' | 'total'
export type SearchTree = { distances: Float64Array; parents: Int32Array }
export type MeetingResult = {
  node: number
  name: string
  distances: number[]
  longest: number
  total: number
}
export type SearchOutput = { trees: SearchTree[]; results: MeetingResult[] }
export type SearchRequest = {
  network: MeetingNetwork
  origins: number[]
  objective: Objective
}
export type SearchReply =
  { kind: 'result'; output: SearchOutput } | { kind: 'error'; message: string }

export const sfRegion = {
  id: 'sf',
  name: 'San Francisco',
  dataUrl: '/lab/meeting-point/sf.json',
  landmarks: [
    { name: 'Golden Gate Bridge', coordinate: [-122.475, 37.8077] },
    { name: 'Pier 39', coordinate: [-122.409, 37.8087] },
    { name: 'Candlestick Point', coordinate: [-122.386, 37.7133] },
    { name: 'San Francisco Zoo', coordinate: [-122.5027, 37.7334] },
    { name: 'Ferry Building', coordinate: [-122.3937, 37.7955] },
    { name: 'Dolores Park', coordinate: [-122.4269, 37.7597] },
    { name: 'The Castro', coordinate: [-122.435, 37.7625] },
    { name: 'Union Square', coordinate: [-122.4074, 37.7879] },
    { name: 'City Hall', coordinate: [-122.4193, 37.7793] },
    { name: 'Ocean Beach', coordinate: [-122.5094, 37.7594] },
    { name: 'de Young Museum', coordinate: [-122.4687, 37.7715] },
    { name: 'Twin Peaks', coordinate: [-122.4476, 37.7544] },
    { name: 'Glen Park', coordinate: [-122.434, 37.7331] },
    { name: 'Coit Tower', coordinate: [-122.4058, 37.8024] },
    { name: 'Oracle Park', coordinate: [-122.3893, 37.7785] },
    { name: 'Baker Beach', coordinate: [-122.4838, 37.7936] },
    { name: 'Bernal Heights', coordinate: [-122.4151, 37.7431] },
    { name: 'Alamo Square', coordinate: [-122.4347, 37.7764] },
  ],
} satisfies {
  id: string
  name: string
  dataUrl: string
  landmarks: { name: string; coordinate: Coordinate }[]
}

export function distanceBetween(a: Coordinate, b: Coordinate): number {
  return (
    Math.hypot(
      (a[0] - b[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
      a[1] - b[1],
    ) * 111195
  )
}

export function nearestNode(
  network: MeetingNetwork,
  coordinate: Coordinate,
): number {
  let best = 0
  let distance = Infinity
  for (let i = 0; i < network.nodes.length; i++) {
    const candidate = distanceBetween(network.nodes[i], coordinate)
    if (candidate < distance) {
      best = i
      distance = candidate
    }
  }
  return best
}

// The heap stores node IDs and priorities separately, without per-relaxation objects.
class MinHeap {
  private nodes: number[] = []
  private values: number[] = []
  get length() {
    return this.nodes.length
  }
  push(node: number, value: number) {
    let i = this.nodes.length
    this.nodes.push(node)
    this.values.push(value)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.values[parent] <= value) break
      this.nodes[i] = this.nodes[parent]
      this.values[i] = this.values[parent]
      i = parent
    }
    this.nodes[i] = node
    this.values[i] = value
  }
  pop(): [number, number] {
    const node = this.nodes[0]
    const value = this.values[0]
    const lastNode = this.nodes.pop()!
    const lastValue = this.values.pop()!
    if (this.nodes.length) {
      let i = 0
      while (2 * i + 1 < this.nodes.length) {
        let child = 2 * i + 1
        if (
          child + 1 < this.nodes.length &&
          this.values[child + 1] < this.values[child]
        )
          child++
        if (this.values[child] >= lastValue) break
        this.nodes[i] = this.nodes[child]
        this.values[i] = this.values[child]
        i = child
      }
      this.nodes[i] = lastNode
      this.values[i] = lastValue
    }
    return [node, value]
  }
}

export function findMeetings({
  network,
  origins,
  objective,
}: SearchRequest): SearchOutput {
  if (origins.length < 2)
    throw new Error('Choose at least two starting locations.')
  if (
    origins.some(
      (node) =>
        !Number.isInteger(node) || node < 0 || node >= network.nodes.length,
    )
  )
    throw new Error('A starting location is outside the network.')
  const adjacency: { node: number; metres: number }[][] = Array.from(
    { length: network.nodes.length },
    () => [],
  )
  for (const [a, b, metres] of network.edges) {
    adjacency[a].push({ node: b, metres })
    adjacency[b].push({ node: a, metres })
  }
  const trees = origins.map((origin) => {
    const distances = new Float64Array(network.nodes.length).fill(Infinity)
    const parents = new Int32Array(network.nodes.length).fill(-1)
    const queue = new MinHeap()
    distances[origin] = 0
    queue.push(origin, 0)
    while (queue.length) {
      const [node, distance] = queue.pop()
      if (distance !== distances[node]) continue
      for (const edge of adjacency[node]) {
        const next = distance + edge.metres
        if (next < distances[edge.node]) {
          distances[edge.node] = next
          parents[edge.node] = node
          queue.push(edge.node, next)
        }
      }
    }
    return { distances, parents }
  })
  const candidates: MeetingResult[] = []
  const seen = new Set<number>()
  for (const place of network.places) {
    if (seen.has(place.node)) continue
    seen.add(place.node)
    const distances = trees.map((tree) => tree.distances[place.node])
    if (distances.some((distance) => !Number.isFinite(distance))) continue
    const longest = Math.max(...distances)
    const total = distances.reduce((sum, distance) => sum + distance, 0)
    candidates.push({ ...place, distances, longest, total })
  }
  candidates.sort((a, b) =>
    objective === 'fair'
      ? a.longest - b.longest || a.total - b.total || a.node - b.node
      : a.total - b.total || a.longest - b.longest || a.node - b.node,
  )
  const results: MeetingResult[] = []
  for (const candidate of candidates) {
    if (
      results.every(
        (result) =>
          distanceBetween(
            network.nodes[candidate.node],
            network.nodes[result.node],
          ) >= 400,
      )
    )
      results.push(candidate)
    if (results.length === 10) break
  }
  return { trees, results }
}

export function routeTo(tree: SearchTree, destination: number): number[] {
  if (!Number.isFinite(tree.distances[destination])) return []
  const route: number[] = []
  for (let node = destination; node !== -1; node = tree.parents[node])
    route.push(node)
  return route.reverse()
}

export function parseNetwork(value: unknown): MeetingNetwork {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('nodes' in value) ||
    !('edges' in value) ||
    !('places' in value) ||
    !('bounds' in value) ||
    !('name' in value) ||
    !('attribution' in value) ||
    !('source' in value) ||
    !('fetched' in value)
  )
    throw new Error('Unsupported road-network format.')
  const coordinate = (point: unknown): point is Coordinate =>
    Array.isArray(point) &&
    point.length === 2 &&
    point.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90
  const nodes = value.nodes
  if (!Array.isArray(nodes) || !nodes.length || !nodes.every(coordinate))
    throw new Error('Invalid road coordinates.')
  const validNode = (node: unknown): node is number =>
    typeof node === 'number' &&
    Number.isInteger(node) &&
    node >= 0 &&
    node < nodes.length
  const edge = (item: unknown): item is MeetingNetwork['edges'][number] =>
    Array.isArray(item) &&
    item.length === 3 &&
    validNode(item[0]) &&
    validNode(item[1]) &&
    typeof item[2] === 'number' &&
    Number.isFinite(item[2]) &&
    item[2] > 0
  const place = (item: unknown): item is MeetingNetwork['places'][number] =>
    !!item &&
    typeof item === 'object' &&
    'node' in item &&
    validNode(item.node) &&
    'name' in item &&
    typeof item.name === 'string'
  const bounds = value.bounds
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    !coordinate([bounds[0], bounds[1]]) ||
    !coordinate([bounds[2], bounds[3]]) ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3]
  )
    throw new Error('Invalid region bounds.')
  if (
    !Array.isArray(value.edges) ||
    !value.edges.every(edge) ||
    !Array.isArray(value.places) ||
    !value.places.length ||
    !value.places.every(place)
  )
    throw new Error('Invalid road connections or meeting points.')
  if (
    typeof value.name !== 'string' ||
    typeof value.attribution !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.fetched !== 'string'
  )
    throw new Error('Invalid region metadata.')
  return {
    version: 1,
    nodes,
    edges: value.edges,
    places: value.places,
    bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
    name: value.name,
    attribution: value.attribution,
    source: value.source,
    fetched: value.fetched,
  }
}
