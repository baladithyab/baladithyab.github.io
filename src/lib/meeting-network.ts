import type { Coordinate, MeetingNetwork } from './meeting-point.ts'

/**
 * Device-memory guard: the most OpenStreetMap road points one load may hold.
 * The compact store below needs well under 100 bytes per point.
 */
export const MAX_SOURCE_NODES = 1_500_000
/** Malformed-input guard; real road data has about 1.3 way references per point. */
export const MAX_WAY_REFERENCES = 4 * MAX_SOURCE_NODES
export const NETWORK_SCHEMA = 2
export const INCOMPLETE_RESPONSE =
  'Overpass returned an incomplete network or query error. Choose a smaller study area or try again later.'

const excludedHighways: Record<string, true> = {
  motorway: true,
  motorway_link: true,
  trunk: true,
  trunk_link: true,
  proposed: true,
  construction: true,
  raceway: true,
}
const malformedData =
  'Overpass returned malformed road data. Try loading the area again later.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function osmId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function grouped(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function tooMuchRoadData(count: number, max: number, unit: string): Error {
  return new Error(
    `This area holds more road data than this device can hold (${grouped(count)} ${unit} reached; at most ${grouped(max)}). Choose locations closer together or a smaller city size.`,
  )
}

/** Throws the device-memory error once a load holds more than `MAX_SOURCE_NODES` road points. */
export function checkSourceNodes(count: number): void {
  if (count > MAX_SOURCE_NODES)
    throw tooMuchRoadData(count, MAX_SOURCE_NODES, 'road points')
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

/**
 * Largest live area the lab asks the public road service for, in km². It keeps
 * a mistyped address from requesting a region; it is not a study-size choice.
 */
export const MAX_LIVE_AREA_KM2 = 4000

/** East-west and north-south extent of bounds, measured along their middle latitude. */
export function boundsSizeKm(bounds: MeetingNetwork['bounds']): {
  widthKm: number
  heightKm: number
  areaKm2: number
} {
  const [west, south, east, north] = bounds
  const widthKm =
    (east - west) * Math.cos(((south + north) * Math.PI) / 360) * 111.195
  const heightKm = (north - south) * 111.195
  return { widthKm, heightKm, areaKm2: widthKm * heightKm }
}

/**
 * Server budgets grow with the area: an 8 × 8 km square keeps 60 s and 64 MiB,
 * and about 700 km² reaches the 180 s and 512 MiB measured to work.
 */
export function overpassBudget(bounds: MeetingNetwork['bounds']): {
  timeoutSeconds: number
  maxsizeBytes: number
} {
  const { areaKm2 } = boundsSizeKm(validateBounds(bounds))
  return {
    timeoutSeconds: Math.min(180, Math.max(60, Math.ceil(45 + 0.2 * areaKm2))),
    maxsizeBytes: Math.round(Math.min(512, Math.max(64, areaKm2)) * 1048576),
  }
}

/** Same bounded, public walking-access query for the CLI and browser worker. */
export function buildOverpassQuery(bounds: MeetingNetwork['bounds']): string {
  const [west, south, east, north] = validateBounds(bounds)
  const { timeoutSeconds, maxsizeBytes } = overpassBudget(bounds)
  return `[out:json][timeout:${timeoutSeconds}][maxsize:${maxsizeBytes}];way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|proposed|construction|raceway)$"]["access"!~"^(private|no)$"]["foot"!="no"](${south},${west},${north},${east});out body;>;out skel qt;`
}

/**
 * Checks the top level of an Overpass response. A `remark` or `error` means the
 * server did not finish; its text is returned for the caller to decide on.
 */
export function readOverpassEnvelope(
  value: unknown,
): { remark: string } | { remark?: undefined; elements: unknown[] } {
  if (!record(value)) throw new Error(malformedData)
  for (const key of ['remark', 'error']) {
    if (key in value) {
      const text = value[key]
      return {
        remark: typeof text === 'string' ? text : (JSON.stringify(text) ?? key),
      }
    }
  }
  if (!Array.isArray(value.elements))
    throw new Error('Overpass returned malformed road data (missing elements).')
  return { elements: value.elements }
}

class Floats {
  data = new Float64Array(1024)
  length = 0
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
}

class Ints {
  data = new Int32Array(1024)
  length = 0
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
}

/** Open-addressing map from positive OpenStreetMap ids to non-negative integers. */
class IdTable {
  keys = new Float64Array(1024)
  values = new Int32Array(1024)
  size = 0

  slot(id: number): number {
    const mask = this.keys.length - 1
    // Ids exceed 32 bits; mix both halves so neighbouring ids spread out.
    let hash = Math.imul(
      (id >>> 0) ^ Math.imul((id / 4294967296) >>> 0, 0x27d4eb2f),
      0x9e3779b1,
    )
    hash ^= hash >>> 16
    let slot = hash & mask
    while (this.keys[slot] !== 0 && this.keys[slot] !== id)
      slot = (slot + 1) & mask
    return slot
  }

  /** The stored value, or -1 when `id` is absent. */
  get(id: number): number {
    const slot = this.slot(id)
    return this.keys[slot] === id ? this.values[slot] : -1
  }

  /** Stores an id that is not present yet. */
  add(id: number, value: number): void {
    if ((this.size + 1) * 4 > this.keys.length * 3)
      this.rebuild(this.keys.length * 2, () => true)
    const slot = this.slot(id)
    this.keys[slot] = id
    this.values[slot] = value
    this.size++
  }

  rebuild(capacity: number, keep: (value: number) => boolean): void {
    const { keys, values } = this
    this.keys = new Float64Array(capacity)
    this.values = new Int32Array(capacity)
    this.size = 0
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === 0 || !keep(values[i])) continue
      const slot = this.slot(keys[i])
      this.keys[slot] = keys[i]
      this.values[slot] = values[i]
      this.size++
    }
  }
}

function metres(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): number {
  return (
    Math.hypot(
      (fromLon - toLon) * Math.cos(((fromLat + toLat) * Math.PI) / 360),
      fromLat - toLat,
    ) * 111195
  )
}

type NetworkOptions = {
  name: string
  bounds: MeetingNetwork['bounds']
  fetched?: string
}

function checkedOptions(options: NetworkOptions): MeetingNetwork['bounds'] {
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
  return bounds
}

const duplicateCoordinates =
  'Overpass returned invalid or duplicate road coordinates.'
const duplicateWay = 'Overpass returned a malformed or duplicate road way.'
// A missing referenced node means a partial response, not a gap to bridge.
const missingNodes =
  'Overpass returned an incomplete network (missing road nodes). Choose a smaller study area or try again later.'

/**
 * Collects Overpass elements one at a time from one or more responses
 * ("parts"), then builds the walking network once. Within a part a repeated id
 * is an error. A way crossing a part boundary is returned whole, with all its
 * nodes, by every part it touches, so a later part may repeat earlier ids: each
 * copy must match the first exactly (otherwise the map changed between
 * requests), and every part must deliver all nodes of the ways it returns.
 * Source data is stored in typed arrays keyed by id tables, so a load costs
 * tens of bytes per road point instead of a `Map` entry and arrays per point.
 */
export class MeetingNetworkBuilder {
  #nodes = new IdTable()
  #lon = new Floats()
  #lat = new Floats()
  /** Number of the last part that delivered each node. */
  #nodePart = new Ints()
  /** Way id → way index. */
  #ways = new IdTable()
  /** Number of the last part that delivered each way. */
  #wayPart = new Ints()
  /** Interned highway, access and foot tags of each way. */
  #wayTags = new Ints()
  /** Interned trimmed name of each way, -1 for none. */
  #wayNames = new Ints()
  /** Node indices of every committed way, back to back, and each way's end offset. */
  #refs = new Ints()
  #wayEnds = new Ints()
  #names: string[] = []
  #nameIds = new Map<string, number>()
  #tagIds = new Map<string, number>()
  /** Whether ways with each interned tag set are public walking roads. */
  #tagKept: boolean[] = []
  /** Number of the open part, 0 when none is open; part numbers are never reused. */
  #part = 0
  #parts = 0
  #partFirstNode = 0
  #partFirstWay = 0
  /** Raw node ids and ref counts of the open part's new ways, resolved when it ends. */
  #partRefs = new Floats()
  #partWayLengths = new Ints()
  /** Earlier ways the open part delivered again; it must deliver their nodes too. */
  #partRepeats = new Ints()

  beginPart(): void {
    if (this.#part)
      throw new Error('The previous road-data part is still open.')
    this.#part = ++this.#parts
    this.#partFirstNode = this.#lon.length
    this.#partFirstWay = this.#wayPart.length
  }

  add(element: unknown): void {
    if (!this.#part) throw new Error('No road-data part is open.')
    if (!record(element) || !osmId(element.id))
      throw new Error('Overpass returned a malformed road element.')
    const id = element.id
    if (element.type === 'node') {
      const { lon, lat } = element
      if (
        typeof lon !== 'number' ||
        typeof lat !== 'number' ||
        !Number.isFinite(lon) ||
        !Number.isFinite(lat) ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90
      )
        throw new Error(duplicateCoordinates)
      const existing = this.#nodes.get(id)
      if (existing >= 0) {
        if (this.#nodePart.data[existing] === this.#part)
          throw new Error(duplicateCoordinates)
        if (
          this.#lon.data[existing] !== lon ||
          this.#lat.data[existing] !== lat
        )
          throw new Error(
            'Overpass returned conflicting road coordinates across parts (the map changed while loading). Load the area again.',
          )
        this.#nodePart.data[existing] = this.#part
        return
      }
      checkSourceNodes(this.#lon.length + 1)
      this.#nodes.add(id, this.#lon.length)
      this.#lon.push(lon)
      this.#lat.push(lat)
      this.#nodePart.push(this.#part)
    } else if (element.type === 'way') {
      const { nodes, tags } = element
      if (
        !Array.isArray(nodes) ||
        nodes.length < 2 ||
        !nodes.every(osmId) ||
        !record(tags) ||
        !Object.values(tags).every((tag) => typeof tag === 'string') ||
        typeof tags.highway !== 'string' ||
        !tags.highway
      )
        throw new Error(duplicateWay)
      const tagSet = this.#tagSet(tags.highway, tags.access, tags.foot)
      const name = this.#intern(
        typeof tags.name === 'string' ? tags.name.trim() : '',
      )
      const existing = this.#ways.get(id)
      if (existing >= 0) {
        if (this.#wayPart.data[existing] === this.#part)
          throw new Error(duplicateWay)
        if (!this.#sameWay(existing, nodes, tagSet, name))
          throw new Error(
            'Overpass returned conflicting road data across parts (the map changed while loading). Load the area again.',
          )
        this.#wayPart.data[existing] = this.#part
        this.#partRepeats.push(existing)
        return
      }
      const references =
        this.#refs.length + this.#partRefs.length + nodes.length
      if (references > MAX_WAY_REFERENCES)
        throw tooMuchRoadData(references, MAX_WAY_REFERENCES, 'way references')
      this.#ways.add(id, this.#wayPart.length)
      this.#wayPart.push(this.#part)
      this.#wayTags.push(tagSet)
      this.#wayNames.push(name)
      for (const node of nodes) this.#partRefs.push(node)
      this.#partWayLengths.push(nodes.length)
    } else {
      throw new Error('Overpass returned an unexpected road element type.')
    }
  }

  /** Whether committed way `way` has exactly these node ids, tags and name. */
  #sameWay(
    way: number,
    nodes: number[],
    tagSet: number,
    name: number,
  ): boolean {
    if (this.#wayTags.data[way] !== tagSet || this.#wayNames.data[way] !== name)
      return false
    const refs = this.#refs.data
    const begin = way ? this.#wayEnds.data[way - 1] : 0
    if (this.#wayEnds.data[way] - begin !== nodes.length) return false
    for (let i = 0; i < nodes.length; i++)
      if (this.#nodes.get(nodes[i]) !== refs[begin + i]) return false
    return true
  }

  /**
   * Commits the open part. Every way it returned, new or repeated, must have
   * all its nodes delivered by this part itself.
   */
  endPart(): void {
    if (!this.#part) throw new Error('No road-data part is open.')
    const part = this.#part
    const nodePart = this.#nodePart.data
    const wayEnds = this.#wayEnds.data
    for (let i = 0; i < this.#partRepeats.length; i++) {
      const way = this.#partRepeats.data[i]
      for (let k = way ? wayEnds[way - 1] : 0; k < wayEnds[way]; k++)
        if (nodePart[this.#refs.data[k]] !== part) throw new Error(missingNodes)
    }
    const refs = this.#refs
    const committedRefs = refs.length
    const committedWays = this.#wayEnds.length
    const ids = this.#partRefs.data
    let offset = 0
    for (let way = 0; way < this.#partWayLengths.length; way++) {
      const end = offset + this.#partWayLengths.data[way]
      for (let i = offset; i < end; i++) {
        const node = this.#nodes.get(ids[i])
        if (node < 0 || nodePart[node] !== part) {
          refs.length = committedRefs
          this.#wayEnds.length = committedWays
          throw new Error(missingNodes)
        }
        refs.push(node)
      }
      this.#wayEnds.push(refs.length)
      offset = end
    }
    this.#closePart()
  }

  /** Discards everything the open part delivered. */
  abandonPart(): void {
    if (!this.#part) return
    const firstNode = this.#partFirstNode
    const firstWay = this.#partFirstWay
    // Repeated ids keep this part's number, which no later part reuses.
    this.#nodes.rebuild(this.#nodes.keys.length, (node) => node < firstNode)
    this.#ways.rebuild(this.#ways.keys.length, (way) => way < firstWay)
    this.#lon.length = firstNode
    this.#lat.length = firstNode
    this.#nodePart.length = firstNode
    this.#wayPart.length = firstWay
    this.#wayTags.length = firstWay
    this.#wayNames.length = firstWay
    this.#wayEnds.length = firstWay
    this.#refs.length = firstWay ? this.#wayEnds.data[firstWay - 1] : 0
    this.#closePart()
  }

  #closePart(): void {
    this.#part = 0
    this.#partRefs = new Floats()
    this.#partWayLengths = new Ints()
    this.#partRepeats = new Ints()
  }

  #intern(name: string): number {
    if (!name) return -1
    let id = this.#nameIds.get(name)
    if (id === undefined) {
      id = this.#names.length
      this.#names.push(name)
      this.#nameIds.set(name, id)
    }
    return id
  }

  /** Interns the tags that decide whether a way is a public walking road. */
  #tagSet(highway: string, access: unknown, foot: unknown): number {
    const key = JSON.stringify([highway, access, foot])
    let id = this.#tagIds.get(key)
    if (id === undefined) {
      id = this.#tagKept.length
      this.#tagKept.push(
        !Object.hasOwn(excludedHighways, highway) &&
          access !== 'private' &&
          access !== 'no' &&
          foot !== 'no',
      )
      this.#tagIds.set(key, id)
    }
    return id
  }

  build(options: NetworkOptions): MeetingNetwork & { license: 'ODbL-1.0' } {
    const bounds = checkedOptions(options)
    if (this.#part) throw new Error('A road-data part is still open.')
    const [west, south, east, north] = bounds
    const count = this.#lon.length
    const lon = this.#lon.data
    const lat = this.#lat.data
    const refs = this.#refs.data
    const wayEnds = this.#wayEnds.data
    const wayNames = this.#wayNames.data
    const wayTags = this.#wayTags.data
    const kept = this.#tagKept
    const wayCount = this.#wayEnds.length
    const names = this.#names

    const inside = new Uint8Array(count)
    for (let node = 0; node < count; node++)
      inside[node] =
        lon[node] >= west &&
        lon[node] <= east &&
        lat[node] >= south &&
        lat[node] <= north
          ? 1
          : 0
    const linked = (a: number, b: number) =>
      inside[a] === 1 &&
      inside[b] === 1 &&
      a !== b &&
      (lon[a] !== lon[b] || lat[a] !== lat[b])

    // Degree saturates at 3: only "exactly two" matters. A node keeps its first
    // street name inline; a second distinct name moves it into `crossings`.
    const degree = new Uint8Array(count)
    const firstName = new Int32Array(count).fill(-1)
    const crossings = new Map<number, number[]>()
    const register = (node: number, name: number) => {
      if (degree[node] < 3) degree[node]++
      if (name < 0) return
      const first = firstName[node]
      if (first < 0) firstName[node] = name
      else if (first !== name) {
        const more = crossings.get(node)
        if (!more) crossings.set(node, [name])
        else if (!more.includes(name)) more.push(name)
      }
    }
    for (let way = 0, begin = 0; way < wayCount; begin = wayEnds[way++]) {
      if (!kept[wayTags[way]]) continue
      for (let i = begin + 1; i < wayEnds[way]; i++) {
        if (!linked(refs[i - 1], refs[i])) continue
        register(refs[i - 1], wayNames[way])
        register(refs[i], wayNames[way])
      }
    }

    // Output node indices are assigned in first-use order along the ways.
    const outIndex = new Int32Array(count).fill(-1)
    const outSource = new Ints()
    const index = (node: number): number => {
      let out = outIndex[node]
      if (out < 0) {
        out = outSource.length
        outIndex[node] = out
        outSource.push(node)
      }
      return out
    }
    const edges = new Ints()
    for (let way = 0, begin = 0; way < wayCount; begin = wayEnds[way++]) {
      if (!kept[wayTags[way]]) continue
      const end = wayEnds[way]
      let start = -1
      let previous = -1
      let distance = 0
      for (let i = begin; i < end; i++) {
        const node = refs[i]
        if (!inside[node]) {
          start = -1
          previous = -1
          distance = 0
          continue
        }
        if (start < 0) {
          start = node
          previous = node
          continue
        }
        distance += metres(lon[previous], lat[previous], lon[node], lat[node])
        previous = node
        if (
          degree[node] !== 2 ||
          crossings.has(node) ||
          distance >= 45 ||
          i + 1 === end ||
          !inside[refs[i + 1]]
        ) {
          if (start !== node && distance > 0) {
            edges.push(index(start))
            edges.push(index(node))
            edges.push(Math.max(1, Math.round(distance)))
          }
          start = node
          distance = 0
        }
      }
    }
    if (!edges.length)
      throw new Error(
        'No public walkable roads were found in this study area. Choose another city or study size.',
      )

    // Islands cannot be common meeting points; retain only the largest component.
    const nodeCount = outSource.length
    const edgeData = edges.data
    const edgeCount = edges.length / 3
    const offsets = new Int32Array(nodeCount + 1)
    for (let edge = 0; edge < edgeCount; edge++) {
      offsets[edgeData[edge * 3] + 1]++
      offsets[edgeData[edge * 3 + 1] + 1]++
    }
    for (let node = 0; node < nodeCount; node++)
      offsets[node + 1] += offsets[node]
    const neighbours = new Int32Array(edgeCount * 2)
    const cursor = offsets.slice(0, nodeCount)
    for (let edge = 0; edge < edgeCount; edge++) {
      const a = edgeData[edge * 3]
      const b = edgeData[edge * 3 + 1]
      neighbours[cursor[a]++] = b
      neighbours[cursor[b]++] = a
    }
    const seen = new Uint8Array(nodeCount)
    const queue = new Int32Array(nodeCount)
    let tail = 0
    let largestStart = 0
    let largestLength = 0
    for (let node = 0; node < nodeCount; node++) {
      if (seen[node]) continue
      const head = tail
      seen[node] = 1
      queue[tail++] = node
      for (let i = head; i < tail; i++) {
        const current = queue[i]
        for (let k = offsets[current]; k < offsets[current + 1]; k++) {
          const next = neighbours[k]
          if (!seen[next]) {
            seen[next] = 1
            queue[tail++] = next
          }
        }
      }
      if (tail - head > largestLength) {
        largestStart = head
        largestLength = tail - head
      }
    }
    const remap = new Int32Array(nodeCount).fill(-1)
    for (let i = 0; i < largestLength; i++) remap[queue[largestStart + i]] = i

    // Places follow the order in which nodes first got a street name.
    const places: MeetingNetwork['places'] = []
    const visit = (node: number) => {
      const more = crossings.get(node)
      if (!more) return
      crossings.delete(node)
      const out = outIndex[node]
      const mapped = out < 0 ? -1 : remap[out]
      if (mapped >= 0)
        places.push({
          node: mapped,
          name: [firstName[node], ...more]
            .map((name) => names[name])
            .sort()
            .slice(0, 2)
            .join(' & '),
        })
    }
    for (let way = 0, begin = 0; way < wayCount; begin = wayEnds[way++]) {
      if (wayNames[way] < 0 || !kept[wayTags[way]]) continue
      for (let i = begin + 1; i < wayEnds[way]; i++) {
        if (!linked(refs[i - 1], refs[i])) continue
        visit(refs[i - 1])
        visit(refs[i])
      }
    }
    if (!places.length)
      throw new Error(
        'No named street intersections were found on the connected walking network. Choose another city or study size.',
      )

    const nodes: Coordinate[] = []
    for (let i = 0; i < largestLength; i++) {
      const source = outSource.data[queue[largestStart + i]]
      // Keep clipped coordinates exact; rounding can move boundary nodes outside.
      nodes.push([lon[source], lat[source]])
    }
    const connectedEdges: MeetingNetwork['edges'] = []
    for (let edge = 0; edge < edgeCount; edge++) {
      const from = remap[edgeData[edge * 3]]
      const to = remap[edgeData[edge * 3 + 1]]
      if (from >= 0 && to >= 0)
        connectedEdges.push([from, to, edgeData[edge * 3 + 2]])
    }
    return {
      version: 1,
      name: options.name.trim(),
      bounds,
      attribution: '© OpenStreetMap contributors',
      source: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL-1.0',
      fetched: options.fetched ?? 'unknown',
      nodes,
      edges: connectedEdges,
      places,
    }
  }
}

/** One parsed Overpass response in, one network out. No I/O or runtime imports: usable with Node's native TypeScript stripping. */
export function buildMeetingNetwork(
  value: unknown,
  options: NetworkOptions,
): MeetingNetwork & { license: 'ODbL-1.0' } {
  checkedOptions(options)
  const envelope = readOverpassEnvelope(value)
  if (envelope.remark !== undefined) throw new Error(INCOMPLETE_RESPONSE)
  const builder = new MeetingNetworkBuilder()
  builder.beginPart()
  for (const element of envelope.elements) builder.add(element)
  builder.endPart()
  return builder.build(options)
}
