import { describe, expect, it } from 'vitest'
import { buildMeetingNetwork, buildOverpassQuery } from './meeting-network'
import { regionBounds } from './meeting-network-loader'
import type { MeetingNetwork } from './meeting-point'

const bounds: MeetingNetwork['bounds'] = [0, 0, 0.01, 0.01]
const options = { name: 'Test city', bounds, fetched: '2026-11-11' }
const node = (id: number, lon: number, lat: number) => ({
  type: 'node',
  id,
  lon,
  lat,
})
const way = (
  id: number,
  nodes: number[],
  name: string,
  tags: Record<string, string> = {},
) => ({
  type: 'way',
  id,
  nodes,
  tags: { highway: 'residential', name, ...tags },
})

const bentCrossing = [
  node(1, 0.001, 0.001),
  node(2, 0.0011, 0.0011),
  node(3, 0.0012, 0.001),
  node(4, 0.0013, 0.0011),
  node(5, 0.0013, 0.0009),
  node(6, 0.0013, 0.0013),
  way(101, [1, 2, 3, 4], 'Main Street'),
  way(102, [5, 4, 6], 'Cross Street'),
]

// These exercise the real public-data boundary and graph builder, not mocked roads.
describe('walking-network normalization', () => {
  it.each([
    null,
    {},
    { elements: 'not an array' },
    { elements: [node(1, Number.NaN, 0)] },
    { elements: [node(1, 181, 0)] },
    { elements: [node(1, 0, 0), node(1, 0, 0)] },
    {
      elements: [
        { type: 'way', id: 100, nodes: [1, '2'], tags: { highway: 'path' } },
      ],
    },
    {
      elements: [{ type: 'way', id: 100, nodes: [1, 2], tags: { highway: 3 } }],
    },
    { elements: [{ type: 'relation', id: 100 }] },
  ])('rejects malformed provider data before using it: %j', (raw) => {
    expect(() => buildMeetingNetwork(raw, options)).toThrow(Error)
  })

  it('rejects provider partial results even if they contain otherwise usable roads', () => {
    expect(() =>
      buildMeetingNetwork(
        { elements: bentCrossing, remark: 'runtime error: Query timed out' },
        options,
      ),
    ).toThrow(Error)
    expect(() =>
      buildMeetingNetwork(
        { elements: [...bentCrossing, way(103, [1, 999], 'Missing Road')] },
        options,
      ),
    ).toThrow(Error)
  })

  it('simplifies degree-two bends but keeps full-chain distance, connected candidates, and attribution', () => {
    const network = buildMeetingNetwork({ elements: bentCrossing }, options)
    expect(network.nodes).toHaveLength(4)
    expect(network.nodes).not.toContainEqual([0.0011, 0.0011])
    expect(network.nodes).not.toContainEqual([0.0012, 0.001])
    const first = network.nodes.findIndex(
      ([lon, lat]) => lon === 0.001 && lat === 0.001,
    )
    const crossing = network.nodes.findIndex(
      ([lon, lat]) => lon === 0.0013 && lat === 0.0011,
    )
    expect(network.edges).toContainEqual([first, crossing, 47])
    expect(network.places).toEqual([
      { node: crossing, name: 'Cross Street & Main Street' },
    ])
  })

  it('retains short degree-two chains at named road transitions as real candidates', () => {
    const network = buildMeetingNetwork(
      {
        elements: [
          node(1, 0.001, 0.001),
          node(2, 0.0011, 0.001),
          node(3, 0.0012, 0.001),
          way(101, [1, 2], 'First Street'),
          way(102, [2, 3], 'Second Street'),
        ],
      },
      options,
    )
    const crossing = network.nodes.findIndex(([lon]) => lon === 0.0011)
    expect(network.places).toEqual([
      { node: crossing, name: 'First Street & Second Street' },
    ])
    expect(network.edges).toHaveLength(2)
  })

  it('drops disconnected islands and remaps every edge and named candidate to the largest component', () => {
    const network = buildMeetingNetwork(
      {
        elements: [
          ...bentCrossing,
          node(10, 0.008, 0.008),
          node(11, 0.009, 0.008),
          way(110, [10, 11], 'Island A'),
          way(111, [10, 11], 'Island B'),
        ],
      },
      options,
    )
    expect(network.nodes).toHaveLength(4)
    expect(network.nodes.every(([lon]) => lon < 0.002)).toBe(true)
    expect(network.edges).toHaveLength(3)
    expect(
      network.edges.every(
        ([a, b]) =>
          a >= 0 &&
          b >= 0 &&
          a < network.nodes.length &&
          b < network.nodes.length,
      ),
    ).toBe(true)
    expect(network.places.map(({ name }) => name)).toEqual([
      'Cross Street & Main Street',
    ])
  })

  it('does not bridge paths that leave and reenter the box, and preserves the last in-bounds endpoint', () => {
    const network = buildMeetingNetwork(
      {
        elements: [
          node(1, 0.001, 0.001),
          node(2, 0.0011, 0.001),
          node(3, 0.0012, 0.001),
          node(4, 0.012, 0.001),
          node(5, 0.004, 0.001),
          node(6, 0.005, 0.001),
          node(7, 0.006, 0.001),
          node(8, 0.0011, 0.002),
          node(9, 0.0011, 0.003),
          way(101, [1, 2, 3, 4, 5, 6, 7], 'Main Street'),
          way(102, [8, 2, 9], 'Cross Street'),
        ],
      },
      options,
    )
    expect(network.nodes).toContainEqual([0.0012, 0.001])
    expect(network.nodes.some(([lon]) => lon >= 0.004)).toBe(false)
    expect(network.nodes).toHaveLength(5)
    expect(network.edges).toHaveLength(4)
    expect(network.places).toHaveLength(1)
  })

  const restrictions: Record<string, string>[] = [
    { access: 'private' },
    { access: 'no' },
    { foot: 'no' },
    ...[
      'motorway',
      'motorway_link',
      'trunk',
      'trunk_link',
      'proposed',
      'construction',
      'raceway',
    ].map((highway) => ({ highway })),
  ]
  it.each(restrictions)(
    'does not turn filtered roads into named intersection candidates: %j',
    (tags) => {
      expect(() =>
        buildMeetingNetwork(
          {
            elements: [
              node(1, 0.001, 0.001),
              node(2, 0.002, 0.001),
              node(3, 0.003, 0.001),
              node(4, 0.002, 0.002),
              way(101, [1, 2, 3], 'Public Street'),
              way(102, [2, 4], 'Restricted Street', tags),
            ],
          },
          options,
        ),
      ).toThrow(Error)
    },
  )

  it('does not invent intersection names from clipped-away or zero-length roads', () => {
    expect(() =>
      buildMeetingNetwork(
        {
          elements: [
            node(1, 0.001, 0.001),
            node(2, 0.002, 0.001),
            node(3, 0.003, 0.001),
            node(4, 0.02, 0.001),
            node(5, 0.002, 0.001),
            way(101, [1, 2, 3], 'Public Street'),
            way(102, [2, 4], 'Outside Street'),
            way(103, [2, 5], 'Zero Length Street'),
          ],
        },
        options,
      ),
    ).toThrow(Error)
  })

  it('distinguishes empty/no-road regions from connected regions without named candidates', () => {
    expect(() => buildMeetingNetwork({ elements: [] }, options)).toThrow(Error)
    expect(() =>
      buildMeetingNetwork(
        {
          elements: [
            node(1, 0.001, 0.001),
            node(2, 0.002, 0.001),
            way(101, [1, 2], 'Only Street'),
          ],
        },
        options,
      ),
    ).toThrow(Error)
  })
})

describe('bounded city geometry and query', () => {
  it('produces an approximately eight-kilometre square and clips coverage at supported edges', () => {
    const equator = regionBounds([0, 0], 8)
    expect((equator[2] - equator[0]) * 111195).toBeCloseTo(8000, 5)
    expect((equator[3] - equator[1]) * 111195).toBeCloseTo(8000, 5)
    const edge = regionBounds([180, 85], 12)
    expect(edge[2]).toBe(180)
    expect(edge[3]).toBe(85)
    expect(edge[0]).toBeLessThan(180)
    expect(edge[1]).toBeLessThan(85)
  })

  it('rejects invalid caller geometry instead of making an unbounded provider request', () => {
    expect(() => regionBounds([Number.NaN, 0], 8)).toThrow(Error)
    expect(() => regionBounds([0, 85.1], 8)).toThrow(Error)
    expect(() => regionBounds([181, 0], 8)).toThrow(Error)
    expect(() => Reflect.apply(regionBounds, undefined, [[0, 0], 6])).toThrow(
      Error,
    )
    expect(() => Reflect.apply(regionBounds, undefined, [['0', 0], 8])).toThrow(
      Error,
    )
    expect(() => buildOverpassQuery([0.01, 0, 0, 0.01])).toThrow(Error)
  })
})
