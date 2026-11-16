import { describe, expect, it } from 'vitest'
import {
  addBubble,
  DEFAULT_BUBBLE_DRAFT,
  influenceAt,
  MAX_BUBBLES,
  nodeInfluence,
  sameField,
  type InfluenceSource,
} from './meeting-influence'
import {
  distanceBetween,
  type Coordinate,
  type MeetingNetwork,
} from './meeting-point'

const centre: Coordinate = [-122.42, 37.77]
const source = (overrides: Partial<InfluenceSource> = {}): InfluenceSource => ({
  id: 'source',
  kind: 'bubble',
  label: 'Test bubble',
  coordinate: centre,
  radius: 500,
  weight: 1,
  ...overrides,
})
// About `metres` east of `from` along its latitude.
const east = (metres: number, from: Coordinate = centre): Coordinate => [
  from[0] + metres / (111195 * Math.cos((from[1] * Math.PI) / 180)),
  from[1],
]

// Deterministic pseudo-random numbers in [0, 1).
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function gridNetwork(origin: Coordinate, size: number, step: number) {
  const nodes: Coordinate[] = []
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++)
      nodes.push([
        origin[0] + column * step * 1.3,
        origin[1] + row * step,
      ])
  // Every other node is a named place; one place is listed twice.
  const places = nodes.flatMap((_, node) =>
    node % 2 === 0 ? [{ node, name: `Crossing ${node}` }] : [],
  )
  places.push({ node: 0, name: 'Crossing 0 again' })
  const network: MeetingNetwork = {
    version: 1,
    name: 'Grid',
    bounds: [
      origin[0],
      origin[1],
      origin[0] + (size - 1) * step * 1.3,
      origin[1] + (size - 1) * step,
    ],
    attribution: 'Test',
    source: 'https://example.com',
    fetched: '2026-11-16',
    nodes,
    edges: [],
    places,
  }
  return network
}

describe('influence field', () => {
  it('applies the full weight at the centre', () => {
    expect(influenceAt([source({ weight: 0.6 })], centre)).toBe(0.6)
    expect(influenceAt([source({ weight: -0.35 })], centre)).toBe(-0.35)
  })

  it('is exactly zero at the radius and beyond, and positive just inside', () => {
    const point = east(400)
    const distance = distanceBetween(centre, point)
    expect(influenceAt([source({ radius: distance })], point)).toBe(0)
    expect(influenceAt([source({ radius: distance * 0.999 })], point)).toBe(0)
    expect(influenceAt([source({ radius: distance * 2 })], east(5000))).toBe(0)
    expect(
      influenceAt([source({ radius: distance * 1.001 })], point),
    ).toBeGreaterThan(0)
  })

  it('falls off steadily from the centre to the edge', () => {
    const values = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 490].map(
      (metres) => influenceAt([source({ weight: 0.8 })], east(metres)),
    )
    for (let i = 1; i < values.length; i++)
      expect(values[i]).toBeLessThan(values[i - 1])
    expect(values.at(-1)).toBeGreaterThan(0)
    expect(influenceAt([source({ weight: 0.8 })], east(520))).toBe(0)
  })

  it('lets opposite influences cancel', () => {
    const pair = [
      source({ weight: 0.6 }),
      source({ id: 'other', weight: -0.6 }),
    ]
    for (const metres of [0, 120, 300]) {
      expect(influenceAt(pair, east(metres))).toBe(0)
    }
    const apart = [
      source({ weight: 0.6 }),
      source({ id: 'other', weight: -0.6, coordinate: east(300) }),
    ]
    expect(influenceAt(apart, east(150))).toBeCloseTo(0, 9)
    expect(influenceAt(apart, east(50))).toBeGreaterThan(0)
    expect(influenceAt(apart, east(250))).toBeLessThan(0)
  })

  it('clamps stacked influences to -1 and 1 without clipping smaller sums', () => {
    const stack = (weight: number, count: number) =>
      Array.from({ length: count }, (_, i) => source({ id: `s${i}`, weight }))
    expect(influenceAt(stack(0.8, 3), centre)).toBe(1)
    expect(influenceAt(stack(-0.8, 3), centre)).toBe(-1)
    expect(influenceAt(stack(0.4, 2), centre)).toBe(0.8)
  })

  it('matches influenceAt at every place and stays 0 at other nodes', () => {
    const network = gridNetwork([-122.44, 37.76], 21, 0.0015)
    const next = random(7)
    const [west, south, eastEdge, north] = network.bounds
    const sources = Array.from(
      { length: 40 },
      (_, i): InfluenceSource => ({
        id: `s${i}`,
        kind: i % 3 === 0 ? 'traffic' : 'bubble',
        label: `Source ${i}`,
        // Some centres sit a little outside the loaded area.
        coordinate: [
          west - 0.005 + next() * (eastEdge - west + 0.01),
          south - 0.005 + next() * (north - south + 0.01),
        ],
        radius: 100 + next() * 1400,
        weight: next() * 2 - 1,
      }),
    )
    // Stacks that must clamp at both ends, centred on place nodes.
    for (const [node, weight] of [
      [40, 1],
      [220, -1],
    ] as const)
      for (let i = 0; i < 6; i++)
        sources.push(
          source({
            id: `stack-${node}-${i}`,
            coordinate: network.nodes[node],
            radius: 300,
            weight,
          }),
        )
    // A strong source centred on a node that is not a place.
    sources.push(
      source({ id: 'off-place', coordinate: network.nodes[101], radius: 600 }),
    )

    const values = nodeInfluence(network, sources)
    expect(values).toHaveLength(network.nodes.length)
    const placeNodes = new Set(network.places.map((place) => place.node))
    let nonZero = 0
    for (let node = 0; node < network.nodes.length; node++) {
      if (placeNodes.has(node)) {
        const expected = influenceAt(sources, network.nodes[node])
        expect(values[node]).toBe(expected)
        if (expected !== 0) nonZero++
      } else expect(values[node]).toBe(0)
    }
    expect(nonZero).toBeGreaterThan(50)
    expect(values[40]).toBe(1)
    expect(values[220]).toBe(-1)
    expect(influenceAt(sources, network.nodes[101])).not.toBe(0)
    expect(values[101]).toBe(0)
  })

  it('reaches every place inside the radius far from the equator', () => {
    const north: Coordinate = [18.95, 69.65]
    const network = gridNetwork(north, 3, 0.002)
    network.nodes.push(east(900, north), east(1100, north))
    network.places.push(
      { node: network.nodes.length - 2, name: 'Just inside' },
      { node: network.nodes.length - 1, name: 'Just outside' },
    )
    network.bounds[2] = east(1100, north)[0]
    const sources = [
      source({ coordinate: north, radius: 1000, weight: 0.7 }),
      source({ id: 'south', coordinate: [18.95, -69.65], radius: 1000 }),
    ]
    const values = nodeInfluence(network, sources)
    const inside = network.nodes.length - 2
    expect(values[inside]).toBeGreaterThan(0)
    expect(values[inside]).toBe(influenceAt(sources, network.nodes[inside]))
    expect(values[inside + 1]).toBe(0)
  })

  it('rejects sources with broken locations, sizes or strengths', () => {
    const network = gridNetwork([-122.44, 37.76], 3, 0.001)
    expect(() =>
      nodeInfluence(network, [source({ coordinate: [Number.NaN, 37.7] })]),
    ).toThrow('location')
    expect(() => nodeInfluence(network, [source({ radius: 0 })])).toThrow(
      'radius',
    )
    expect(() => nodeInfluence(network, [source({ weight: 1.5 })])).toThrow(
      'strength',
    )
    expect(() => influenceAt([source({ weight: Number.NaN })], centre)).toThrow(
      'strength',
    )
  })

  it('treats renamed sources as the same field, and moved or resized ones as different', () => {
    const list = [source(), source({ id: 'other', coordinate: east(300) })]
    const renamed = list.map((item) => ({ ...item, label: 'Renamed' }))
    expect(sameField(list, renamed)).toBe(true)
    expect(sameField(list, [list[0], { ...list[1], radius: 600 }])).toBe(false)
    expect(sameField(list, [list[0], { ...list[1], weight: -1 }])).toBe(false)
    expect(
      sameField(list, [list[0], { ...list[1], coordinate: east(310) }]),
    ).toBe(false)
    expect(sameField(list, [list[1], list[0]])).toBe(false)
    expect(sameField(list, list.slice(0, 1))).toBe(false)
  })
})

describe('adding bubbles', () => {
  const network = gridNetwork([-122.44, 37.76], 5, 0.002)
  const inside: Coordinate = [-122.435, 37.765]

  it('drops a bubble with the chosen polarity and size at the given point', () => {
    const before: InfluenceSource[] = []
    const added = addBubble({
      network,
      bubbles: before,
      coordinate: inside,
      draft: { polarity: 'avoid', radius: 800 },
    })
    if (!added.ok) throw new Error(added.message)
    expect(added.bubble).toMatchObject({
      kind: 'bubble',
      coordinate: inside,
      radius: 800,
      weight: -1,
    })
    expect(added.bubbles).toEqual([added.bubble])
    expect(before).toEqual([])
    const attract = addBubble({
      network,
      bubbles: added.bubbles,
      coordinate: inside,
      draft: DEFAULT_BUBBLE_DRAFT,
      label: '  Dolores Park ',
    })
    if (!attract.ok) throw new Error(attract.message)
    expect(attract.bubble.weight).toBe(1)
    expect(attract.bubble.radius).toBe(DEFAULT_BUBBLE_DRAFT.radius)
    expect(attract.bubble.label).toBe('Dolores Park')
  })

  it('keeps ids and generated names distinct after removals', () => {
    let bubbles: InfluenceSource[] = []
    for (let i = 0; i < 3; i++) {
      const added = addBubble({
        network,
        bubbles,
        coordinate: inside,
        draft: DEFAULT_BUBBLE_DRAFT,
      })
      if (!added.ok) throw new Error(added.message)
      bubbles = added.bubbles
    }
    bubbles = bubbles.filter((_, i) => i !== 1)
    const added = addBubble({
      network,
      bubbles,
      coordinate: inside,
      draft: DEFAULT_BUBBLE_DRAFT,
    })
    if (!added.ok) throw new Error(added.message)
    expect(new Set(added.bubbles.map((bubble) => bubble.id)).size).toBe(3)
    expect(new Set(added.bubbles.map((bubble) => bubble.label)).size).toBe(3)
  })

  it('refuses points outside the loaded area and more than the maximum', () => {
    const outside = addBubble({
      network,
      bubbles: [],
      coordinate: [-122.3, 37.765],
      draft: DEFAULT_BUBBLE_DRAFT,
    })
    expect(outside.ok).toBe(false)
    const full = Array.from({ length: MAX_BUBBLES }, (_, i) =>
      source({ id: `bubble-${i + 1}` }),
    )
    const crowded = addBubble({
      network,
      bubbles: full,
      coordinate: inside,
      draft: DEFAULT_BUBBLE_DRAFT,
    })
    expect(crowded.ok).toBe(false)
  })
})
