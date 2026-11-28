import type { InfluenceBias } from './meeting-influence'

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
export class MinHeap {
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

export type MeetingSearch = {
  find(request: { origins: number[]; objective: Objective }): SearchOutput
}

/**
 * Builds a compressed adjacency once for repeated searches over one network. Each
 * node's neighbours keep the original edge insertion order, so relaxation order,
 * parents and tie behaviour match a per-call adjacency list exactly.
 */
export function prepareMeetingSearch(network: MeetingNetwork): MeetingSearch {
  const count = network.nodes.length
  const offsets = new Int32Array(count + 1)
  for (const [a, b] of network.edges) {
    offsets[a + 1]++
    offsets[b + 1]++
  }
  for (let i = 0; i < count; i++) offsets[i + 1] += offsets[i]
  const targets = new Int32Array(offsets[count])
  const weights = new Float64Array(offsets[count])
  const cursor = offsets.slice(0, count)
  for (const [a, b, metres] of network.edges) {
    let slot = cursor[a]++
    targets[slot] = b
    weights[slot] = metres
    slot = cursor[b]++
    targets[slot] = a
    weights[slot] = metres
  }
  return {
    find({ origins, objective }) {
      if (origins.length < 2)
        throw new Error('Choose at least two starting locations.')
      if (
        origins.some(
          (node) => !Number.isInteger(node) || node < 0 || node >= count,
        )
      )
        throw new Error('A starting location is outside the network.')
      const trees = origins.map((origin) => {
        const distances = new Float64Array(count).fill(Infinity)
        const parents = new Int32Array(count).fill(-1)
        const queue = new MinHeap()
        distances[origin] = 0
        queue.push(origin, 0)
        while (queue.length) {
          const [node, distance] = queue.pop()
          if (distance !== distances[node]) continue
          for (let slot = offsets[node]; slot < offsets[node + 1]; slot++) {
            const target = targets[slot]
            const next = distance + weights[slot]
            if (next < distances[target]) {
              distances[target] = next
              parents[target] = node
              queue.push(target, next)
            }
          }
        }
        return { distances, parents }
      })
      return {
        trees,
        results: rankMeetingResults({ network, trees, objective }),
      }
    },
  }
}

/** Reached places of one tree set and network, in place order; never mutated once stored. */
type Candidates = { trees: SearchTree[]; results: readonly MeetingResult[] }
const candidateCache = new WeakMap<
  SearchTree[],
  WeakMap<MeetingNetwork, Candidates>
>()

/**
 * Distinct places every tree reaches, with their true distances. Callers rerank
 * the same trees for another objective or bias, so the scan runs once per tree
 * set and network; a tree set whose members changed is scanned again.
 */
function reachedPlaces(
  network: MeetingNetwork,
  trees: SearchTree[],
): readonly MeetingResult[] {
  const cached = candidateCache.get(trees)?.get(network)
  if (
    cached &&
    cached.trees.length === trees.length &&
    cached.trees.every((tree, i) => tree === trees[i])
  )
    return cached.results
  const results: MeetingResult[] = []
  const seen = new Set<number>()
  for (const place of network.places) {
    if (seen.has(place.node)) continue
    seen.add(place.node)
    const distances = trees.map((tree) => tree.distances[place.node])
    if (distances.some((distance) => !Number.isFinite(distance))) continue
    const longest = Math.max(...distances)
    const total = distances.reduce((sum, distance) => sum + distance, 0)
    results.push({ ...place, distances, longest, total })
  }
  let byNetwork = candidateCache.get(trees)
  if (!byNetwork) {
    byNetwork = new WeakMap()
    candidateCache.set(trees, byNetwork)
  }
  byNetwork.set(network, { trees: trees.slice(), results })
  return results
}

/**
 * Ranks and separates meeting places from complete trees without mutating them.
 * An optional influence bias reorders candidates by
 * `cost - budget * field * people`, where cost is the longest journey for
 * 'fair' and the combined distance for 'total', and people is 1 for 'fair' and
 * every tree for 'total'. Reported distances stay the true walking distances.
 * Result objects are shared between calls for the same trees: treat them as read-only.
 */
export function rankMeetingResults({
  network,
  trees,
  objective,
  bias,
}: {
  network: MeetingNetwork
  trees: SearchTree[]
  objective: Objective
  bias?: InfluenceBias
}): MeetingResult[] {
  if (bias) {
    if (bias.values.length !== network.nodes.length)
      throw new Error('The influence field does not match this road network.')
    if (!Number.isFinite(bias.budget) || bias.budget < 0)
      throw new Error('The influence budget must be 0 m or more.')
  }
  const people = objective === 'fair' ? 1 : trees.length
  const places = reachedPlaces(network, trees)
  const candidates: { result: MeetingResult; score: number }[] = []
  for (const result of places) {
    let score = objective === 'fair' ? result.longest : result.total
    if (bias) {
      const value = bias.values[result.node]
      if (!(value >= -1 && value <= 1))
        throw new Error('The influence field has a value outside -1 to 1.')
      score -= bias.budget * value * people
    }
    candidates.push({ result, score })
  }
  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      (objective === 'fair'
        ? a.result.total - b.result.total
        : a.result.longest - b.result.longest) ||
      a.result.node - b.result.node,
  )
  const results: MeetingResult[] = []
  for (const { result: candidate } of candidates) {
    if (
      results.every(
        (result) =>
          distanceBetween(
            network.nodes[candidate.node],
            network.nodes[result.node],
          ) >= 400,
      )
    )
      results.push({ ...candidate, distances: candidate.distances.slice() })
    if (results.length === 10) break
  }
  return results
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
