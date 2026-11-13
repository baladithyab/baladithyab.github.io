import type { Coordinate, MeetingNetwork } from './meeting-point.ts'

// Bound both decoded provider input and the graph work it can induce.
export const MAX_NETWORK_BYTES = 24 * 1024 * 1024
export const MAX_SOURCE_ELEMENTS = 350_000
export const MAX_SOURCE_NODES = 250_000
export const MAX_SOURCE_WAYS = 75_000
export const MAX_WAY_REFERENCES = 1_500_000
export const NETWORK_SCHEMA = 2

const excludedHighways: Record<string, true> = {
  motorway: true,
  motorway_link: true,
  trunk: true,
  trunk_link: true,
  proposed: true,
  construction: true,
  raceway: true,
}
const oversized =
  'This walking network is too large. Choose a smaller study area and load again.'

type SourceWay = { nodes: number[]; tags: Record<string, string> }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function osmId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function validateBounds(value: unknown): MeetingNetwork['bounds'] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((part) => typeof part === 'number' && Number.isFinite(part)) ||
    value[0] < -180 ||
    value[2] > 180 ||
    value[1] < -90 ||
    value[3] > 90 ||
    value[0] >= value[2] ||
    value[1] >= value[3]
  )
    throw new Error('Invalid walking-network bounds.')
  return [value[0], value[1], value[2], value[3]]
}

/** Same bounded, public walking-access query for the CLI and browser worker. */
export function buildOverpassQuery(bounds: MeetingNetwork['bounds']): string {
  const [west, south, east, north] = validateBounds(bounds)
  return `[out:json][timeout:60][maxsize:67108864];way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|proposed|construction|raceway)$"]["access"!~"^(private|no)$"]["foot"!="no"](${south},${west},${north},${east});out body;>;out skel qt;`
}

function readSource(value: unknown): {
  points: Map<number, Coordinate>
  ways: SourceWay[]
} {
  if (!record(value))
    throw new Error(
      'Overpass returned malformed road data. Try loading the area again later.',
    )
  if ('remark' in value || 'error' in value) {
    throw new Error(
      'Overpass returned an incomplete network or query error. Choose a smaller study area or try again later.',
    )
  }
  if (!Array.isArray(value.elements))
    throw new Error('Overpass returned malformed road data (missing elements).')
  if (value.elements.length > MAX_SOURCE_ELEMENTS) throw new Error(oversized)
  const points = new Map<number, Coordinate>()
  const ways: SourceWay[] = []
  const wayIds = new Set<number>()
  let references = 0
  for (const element of value.elements) {
    if (!record(element) || !osmId(element.id))
      throw new Error('Overpass returned a malformed road element.')
    if (element.type === 'node') {
      if (
        typeof element.lon !== 'number' ||
        typeof element.lat !== 'number' ||
        !Number.isFinite(element.lon) ||
        !Number.isFinite(element.lat) ||
        Math.abs(element.lon) > 180 ||
        Math.abs(element.lat) > 90 ||
        points.has(element.id)
      )
        throw new Error(
          'Overpass returned invalid or duplicate road coordinates.',
        )
      points.set(element.id, [element.lon, element.lat])
      if (points.size > MAX_SOURCE_NODES) throw new Error(oversized)
    } else if (element.type === 'way') {
      if (
        !Array.isArray(element.nodes) ||
        element.nodes.length < 2 ||
        !element.nodes.every(osmId) ||
        !record(element.tags) ||
        !Object.values(element.tags).every((tag) => typeof tag === 'string') ||
        typeof element.tags.highway !== 'string' ||
        !element.tags.highway ||
        wayIds.has(element.id)
      )
        throw new Error('Overpass returned a malformed or duplicate road way.')
      references += element.nodes.length
      if (references > MAX_WAY_REFERENCES || ways.length >= MAX_SOURCE_WAYS)
        throw new Error(oversized)
      wayIds.add(element.id)
      const tags: Record<string, string> = {}
      for (const [key, tag] of Object.entries(element.tags)) {
        // Validate before retaining only the tags normalization actually uses.
        if (typeof tag !== 'string')
          throw new Error('Overpass returned malformed road tags.')
        if (
          key === 'highway' ||
          key === 'access' ||
          key === 'foot' ||
          key === 'name'
        )
          tags[key] = tag
      }
      ways.push({ nodes: element.nodes, tags })
    } else {
      throw new Error('Overpass returned an unexpected road element type.')
    }
  }
  // A missing referenced node means a partial response, not a gap to bridge.
  for (const way of ways) {
    for (const id of way.nodes) {
      if (!points.has(id))
        throw new Error(
          'Overpass returned an incomplete network (missing road nodes). Choose a smaller study area or try again later.',
        )
    }
  }
  return { points, ways }
}

function metres(a: Coordinate, b: Coordinate): number {
  return (
    Math.hypot(
      (a[0] - b[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
      a[1] - b[1],
    ) * 111195
  )
}

/** No I/O or runtime imports: usable with Node's native TypeScript stripping. */
export function buildMeetingNetwork(
  value: unknown,
  options: { name: string; bounds: MeetingNetwork['bounds']; fetched?: string },
): MeetingNetwork & { license: 'ODbL-1.0' } {
  const bounds = validateBounds(options.bounds)
  if (
    typeof options.name !== 'string' ||
    !options.name.trim() ||
    options.name.length > 200
  ) {
    throw new Error(
      'Choose a valid city name before loading its walking network.',
    )
  }
  const { points: sourcePoints, ways: sourceWays } = readSource(value)
  const [west, south, east, north] = bounds
  const points = new Map<number, Coordinate>()
  for (const [id, point] of sourcePoints) {
    if (
      point[0] >= west &&
      point[0] <= east &&
      point[1] >= south &&
      point[1] <= north
    )
      points.set(id, point)
  }
  const ways = sourceWays.filter(
    ({ tags }) =>
      !Object.hasOwn(excludedHighways, tags.highway) &&
      tags.access !== 'private' &&
      tags.access !== 'no' &&
      tags.foot !== 'no',
  )
  const degree = new Map<number, number>()
  const labels = new Map<number, Set<string>>()
  const register = (id: number, name: string | undefined) => {
    degree.set(id, (degree.get(id) ?? 0) + 1)
    if (!name) return
    let names = labels.get(id)
    if (!names) {
      names = new Set()
      labels.set(id, names)
    }
    names.add(name)
  }
  for (const way of ways) {
    const name = way.tags.name?.trim()
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1]
      const b = way.nodes[i]
      const from = points.get(a)
      const to = points.get(b)
      if (!from || !to || a === b || (from[0] === to[0] && from[1] === to[1]))
        continue
      register(a, name)
      register(b, name)
    }
  }
  const nodes: Coordinate[] = []
  const ids = new Map<number, number>()
  const index = (id: number): number => {
    const existing = ids.get(id)
    if (existing !== undefined) return existing
    const point = points.get(id)
    if (!point) throw new Error('Invalid road geometry during normalization.')
    const next = nodes.length
    ids.set(id, next)
    // Keep clipped coordinates exact; rounding can move boundary nodes outside.
    nodes.push([point[0], point[1]])
    return next
  }
  const edges: MeetingNetwork['edges'] = []
  for (const way of ways) {
    let start: number | undefined
    let previous: Coordinate | undefined
    let distance = 0
    for (let i = 0; i < way.nodes.length; i++) {
      const id = way.nodes[i]
      const point = points.get(id)
      if (!point) {
        start = undefined
        previous = undefined
        distance = 0
        continue
      }
      if (start === undefined || !previous) {
        start = id
        previous = point
        continue
      }
      distance += metres(previous, point)
      previous = point
      const next = way.nodes[i + 1]
      if (
        degree.get(id) !== 2 ||
        (labels.get(id)?.size ?? 0) >= 2 ||
        distance >= 45 ||
        next === undefined ||
        !points.has(next)
      ) {
        if (start !== id && distance > 0)
          edges.push([
            index(start),
            index(id),
            Math.max(1, Math.round(distance)),
          ])
        start = id
        distance = 0
      }
    }
  }
  if (!edges.length)
    throw new Error(
      'No public walkable roads were found in this study area. Choose another city or study size.',
    )

  // Islands cannot be common meeting points; retain only the largest component.
  const adjacency: number[][] = Array.from({ length: nodes.length }, () => [])
  for (const [a, b] of edges) {
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
  const seen = new Uint8Array(nodes.length)
  let largest: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (seen[i]) continue
    const component = [i]
    seen[i] = 1
    for (let j = 0; j < component.length; j++) {
      for (const next of adjacency[component[j]]) {
        if (!seen[next]) {
          seen[next] = 1
          component.push(next)
        }
      }
    }
    if (component.length > largest.length) largest = component
  }
  const remap = new Map(largest.map((old, i) => [old, i]))
  const places: MeetingNetwork['places'] = []
  for (const [id, names] of labels) {
    const old = ids.get(id)
    const node = old === undefined ? undefined : remap.get(old)
    if (node !== undefined && names.size >= 2)
      places.push({ node, name: [...names].sort().slice(0, 2).join(' & ') })
  }
  if (!places.length)
    throw new Error(
      'No named street intersections were found on the connected walking network. Choose another city or study size.',
    )
  const connectedEdges: MeetingNetwork['edges'] = []
  for (const [a, b, distance] of edges) {
    const from = remap.get(a)
    const to = remap.get(b)
    if (from !== undefined && to !== undefined)
      connectedEdges.push([from, to, distance])
  }
  return {
    version: 1,
    name: options.name.trim(),
    bounds,
    attribution: '© OpenStreetMap contributors',
    source: 'https://www.openstreetmap.org/copyright',
    license: 'ODbL-1.0',
    fetched: options.fetched ?? 'unknown',
    nodes: largest.map((old) => nodes[old]),
    edges: connectedEdges,
    places,
  }
}
