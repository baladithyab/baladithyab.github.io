import {
  distanceBetween,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

export type InfluenceKind = 'bubble' | 'traffic' | 'event'

/** A sphere of influence that pulls meeting spots toward it or pushes them away. */
export type InfluenceSource = {
  id: string
  kind: InfluenceKind
  label: string
  coordinate: Coordinate
  /** Metres. Influence falls smoothly to zero at this distance. */
  radius: number
  /** -1 (strongest avoid) to 1 (strongest attract). */
  weight: number
}

/**
 * Field values in [-1, 1] indexed by network node, and what one full unit is
 * worth when ranking, in metres of travel per person.
 */
export type InfluenceBias = { values: Float64Array; budget: number }

/** Radius range for hand-placed bubbles, in metres. */
export const BUBBLE_RADIUS = {
  min: 100,
  max: 3000,
  step: 50,
  default: 500,
} as const
/** Range for a bubble's strength, the magnitude of its `weight`. */
export const BUBBLE_STRENGTH = {
  min: 0.1,
  max: 1,
  step: 0.05,
  default: 1,
} as const
/** Metres of walking per person that one full unit of influence is worth. */
export const INFLUENCE_BUDGET = {
  min: 0,
  max: 2000,
  step: 50,
  default: 500,
} as const
export const MAX_BUBBLES = 50

export type BubblePolarity = 'attract' | 'avoid'
/** What the next hand-placed bubble gets: its polarity and radius in metres. */
export type BubbleDraft = { polarity: BubblePolarity; radius: number }
export const DEFAULT_BUBBLE_DRAFT: BubbleDraft = {
  polarity: 'attract',
  radius: BUBBLE_RADIUS.default,
}

// Metres per degree of latitude, as used by `distanceBetween`.
const METRES_PER_DEGREE = 111195

/** Smooth falloff: 1 at the centre, easing to exactly 0 at `radius` and beyond. */
export function influenceKernel(distance: number, radius: number): number {
  if (!(distance < radius)) return 0
  const t = 1 - (distance / radius) ** 2
  return t * t
}

function checkSource(source: InfluenceSource) {
  const [longitude, latitude] = source.coordinate
  const name = source.label || source.id
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  )
    throw new Error(`Influence “${name}” has an invalid location.`)
  if (!Number.isFinite(source.radius) || source.radius <= 0)
    throw new Error(`Influence “${name}” needs a radius above 0 m.`)
  if (
    !Number.isFinite(source.weight) ||
    source.weight < -1 ||
    source.weight > 1
  )
    throw new Error(`Influence “${name}” needs a strength from -1 to 1.`)
}

/** Summed influence of every source at one point, clamped to [-1, 1]. */
export function influenceAt(
  sources: readonly InfluenceSource[],
  coordinate: Coordinate,
): number {
  let sum = 0
  for (const source of sources) {
    checkSource(source)
    sum +=
      source.weight *
      influenceKernel(
        distanceBetween(source.coordinate, coordinate),
        source.radius,
      )
  }
  return Math.max(-1, Math.min(1, sum))
}

/**
 * Whether two source lists produce the same field: the same positions, reaches
 * and strengths in the same order. Ids, kinds and labels are ignored, so a
 * renamed bubble keeps its field.
 */
export function sameField(
  a: readonly InfluenceSource[],
  b: readonly InfluenceSource[],
) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return (
      x === y ||
      (x.coordinate[0] === y.coordinate[0] &&
        x.coordinate[1] === y.coordinate[1] &&
        x.radius === y.radius &&
        x.weight === y.weight)
    )
  })
}

// Distinct place nodes sorted by longitude, so each source scans only the
// places inside its longitude band. Networks are immutable once parsed.
type PlaceIndex = {
  nodes: Int32Array
  longitudes: Float64Array
  latitudes: Float64Array
}
const placeIndexes = new WeakMap<MeetingNetwork, PlaceIndex>()

function placeIndex(network: MeetingNetwork): PlaceIndex {
  const cached = placeIndexes.get(network)
  if (cached) return cached
  const unique = [...new Set(network.places.map((place) => place.node))]
  unique.sort((a, b) => network.nodes[a][0] - network.nodes[b][0] || a - b)
  const index: PlaceIndex = {
    nodes: Int32Array.from(unique),
    longitudes: Float64Array.from(unique, (node) => network.nodes[node][0]),
    latitudes: Float64Array.from(unique, (node) => network.nodes[node][1]),
  }
  placeIndexes.set(network, index)
  return index
}

function firstAtLeast(values: Float64Array, target: number) {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (values[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * The field at every node named by `network.places` (0 at all other nodes).
 * Each value equals `influenceAt(sources, network.nodes[node])`: sources are
 * summed in the same order, and a conservative latitude/longitude box skips
 * only pairs whose distance is at least the radius.
 */
export function nodeInfluence(
  network: MeetingNetwork,
  sources: readonly InfluenceSource[],
): Float64Array {
  const values = new Float64Array(network.nodes.length)
  if (sources.length === 0) return values
  for (const source of sources) checkSource(source)
  const { nodes, longitudes, latitudes } = placeIndex(network)
  for (const source of sources) {
    const [longitude, latitude] = source.coordinate
    // A small margin keeps rounding from rejecting a pair just inside.
    const latitudeReach = (source.radius / METRES_PER_DEGREE) * (1 + 1e-9)
    // `distanceBetween` scales longitude by the cosine of the mean latitude,
    // which is at least the cosine at the far edge of the latitude band.
    const edge = Math.min(90, Math.abs(latitude) + latitudeReach)
    const longitudeReach = latitudeReach / Math.cos((edge * Math.PI) / 180)
    const east = longitude + longitudeReach
    for (
      let i = firstAtLeast(longitudes, longitude - longitudeReach);
      i < longitudes.length && longitudes[i] <= east;
      i++
    ) {
      if (Math.abs(latitudes[i] - latitude) > latitudeReach) continue
      const node = nodes[i]
      const k = influenceKernel(
        distanceBetween(source.coordinate, network.nodes[node]),
        source.radius,
      )
      if (k > 0) values[node] += source.weight * k
    }
  }
  for (const node of nodes)
    values[node] = Math.max(-1, Math.min(1, values[node]))
  return values
}

export type BubbleAddition =
  | {
      ok: true
      bubble: InfluenceSource
      bubbles: InfluenceSource[]
      message: string
    }
  | { ok: false; message: string }

/**
 * Builds the next hand-placed bubble at `coordinate` with the draft's polarity
 * and radius at full strength, and returns the list with it appended. Used for
 * map clicks and place search alike. Refuses places outside the loaded area
 * and more than `MAX_BUBBLES`.
 */
export function addBubble({
  network,
  bubbles,
  coordinate,
  draft,
  label,
}: {
  network: MeetingNetwork
  bubbles: readonly InfluenceSource[]
  coordinate: Coordinate
  draft: BubbleDraft
  /** Defaults to a generated name such as “Bubble 3”. */
  label?: string
}): BubbleAddition {
  if (
    !Number.isFinite(draft.radius) ||
    draft.radius < BUBBLE_RADIUS.min ||
    draft.radius > BUBBLE_RADIUS.max
  )
    throw new Error(
      `Bubble size must be ${BUBBLE_RADIUS.min}–${BUBBLE_RADIUS.max} m.`,
    )
  if (bubbles.length >= MAX_BUBBLES)
    return {
      ok: false,
      message: `You can add up to ${MAX_BUBBLES} bubbles. Remove one to add another.`,
    }
  const [west, south, east, north] = network.bounds
  const [longitude, latitude] = coordinate
  if (
    !(longitude >= west && longitude <= east) ||
    !(latitude >= south && latitude <= north)
  )
    return {
      ok: false,
      message: 'Place bubbles inside the loaded area.',
    }
  let next = 1
  for (const bubble of bubbles) {
    const match = /^bubble-(\d+)$/.exec(bubble.id)
    if (match) next = Math.max(next, Number(match[1]) + 1)
  }
  const name = label?.trim() || `Bubble ${next}`
  const bubble: InfluenceSource = {
    id: `bubble-${next}`,
    kind: 'bubble',
    label: name,
    coordinate: [longitude, latitude],
    radius: draft.radius,
    weight:
      draft.polarity === 'attract'
        ? BUBBLE_STRENGTH.default
        : -BUBBLE_STRENGTH.default,
  }
  return {
    ok: true,
    bubble,
    bubbles: [...bubbles, bubble],
    message: `Added ${name}: ${draft.polarity === 'attract' ? 'meet near here' : 'keep away from here'}, reaching ${draft.radius} m.`,
  }
}
