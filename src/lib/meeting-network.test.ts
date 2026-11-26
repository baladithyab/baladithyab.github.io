import { describe, expect, it } from 'vitest'
import {
  boundsSizeKm,
  buildMeetingNetwork,
  buildOverpassQuery,
  MAX_SOURCE_NODES,
  MeetingNetworkBuilder,
} from './meeting-network'
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
const transition = [
  node(1, 0.001, 0.001),
  node(2, 0.0011, 0.001),
  node(3, 0.0012, 0.001),
  way(101, [1, 2], 'First Street'),
  way(102, [2, 3], 'Second Street'),
]
const islands = [
  ...bentCrossing,
  node(10, 0.008, 0.008),
  node(11, 0.009, 0.008),
  way(110, [10, 11], 'Island A'),
  way(111, [10, 11], 'Island B'),
]
const reentry = [
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
]

/** Feeds each list of elements as one part, as the loader does with responses. */
function inParts(parts: unknown[][]) {
  const builder = new MeetingNetworkBuilder()
  for (const part of parts) {
    builder.beginPart()
    for (const element of part) builder.add(element)
    builder.endPart()
  }
  return builder.build(options)
}

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
      elements: [way(100, [1, 2], 'Twice'), way(100, [1, 2], 'Twice')],
    },
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
    const network = buildMeetingNetwork({ elements: transition }, options)
    const crossing = network.nodes.findIndex(([lon]) => lon === 0.0011)
    expect(network.places).toEqual([
      { node: crossing, name: 'First Street & Second Street' },
    ])
    expect(network.edges).toHaveLength(2)
  })

  it('drops disconnected islands and remaps every edge and named candidate to the largest component', () => {
    const network = buildMeetingNetwork({ elements: islands }, options)
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
    const network = buildMeetingNetwork({ elements: reentry }, options)
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

describe('incremental normalization from several responses', () => {
  it.each([
    ['a bent crossing', bentCrossing],
    ['a named road transition', transition],
    ['islands', islands],
    ['a path leaving the box', reentry],
  ])(
    'builds the same network from one part as from one response: %s',
    (_name, elements) => {
      expect(inParts([elements])).toEqual(
        buildMeetingNetwork({ elements }, options),
      )
    },
  )

  it('merges overlapping parts by OpenStreetMap id into the network of the combined data', () => {
    const third = [node(7, 0.0016, 0.0013), way(103, [6, 7], 'Third Street')]
    const west = bentCrossing
    // The east part repeats the way crossing the boundary with all its nodes.
    const east = [
      way(102, [5, 4, 6], 'Cross Street'),
      third[1],
      node(4, 0.0013, 0.0011),
      node(5, 0.0013, 0.0009),
      node(6, 0.0013, 0.0013),
      third[0],
    ]
    const merged = inParts([west, east])
    expect(merged).toEqual(
      buildMeetingNetwork({ elements: [...bentCrossing, ...third] }, options),
    )
    expect(merged.places.map(({ name }) => name).sort()).toEqual([
      'Cross Street & Main Street',
      'Cross Street & Third Street',
    ])
  })

  it('rejects an id repeated within one part', () => {
    const builder = new MeetingNetworkBuilder()
    builder.beginPart()
    builder.add(node(1, 0.001, 0.001))
    expect(() => builder.add(node(1, 0.001, 0.001))).toThrow(Error)
    builder.add(way(101, [1, 2], 'Main Street'))
    expect(() => builder.add(way(101, [1, 2], 'Main Street'))).toThrow(Error)
  })

  it('leaves no trace of an abandoned part, and accepts its ids again later', () => {
    // New ids plus a repeated way and node, all consistent with the first part.
    const ghost = [
      node(20, 0.0011, 0.002),
      way(120, [2, 20], 'Ghost Street'),
      way(101, [1, 2, 3, 4], 'Main Street'),
      node(2, 0.0011, 0.0011),
    ]
    const builder = new MeetingNetworkBuilder()
    builder.beginPart()
    for (const element of bentCrossing) builder.add(element)
    builder.endPart()
    builder.beginPart()
    for (const element of ghost) builder.add(element)
    builder.abandonPart()
    expect(builder.build(options)).toEqual(
      buildMeetingNetwork({ elements: bentCrossing }, options),
    )

    const again = new MeetingNetworkBuilder()
    // Like an Overpass part, the late part repeats the shared node 2 it uses.
    const late = [
      node(20, 0.0011, 0.002),
      way(120, [2, 20], 'Late Street'),
      node(2, 0.0011, 0.0011),
    ]
    again.beginPart()
    for (const element of [
      ...late,
      node(30, 0.005, 0.005),
      way(130, [4, 30], 'Abandoned Road'),
    ])
      again.add(element)
    again.abandonPart()
    again.beginPart()
    for (const element of bentCrossing) again.add(element)
    again.endPart()
    again.beginPart()
    for (const element of late) again.add(element)
    again.endPart()
    const network = again.build(options)
    expect(network.places.map(({ name }) => name).sort()).toEqual([
      'Cross Street & Main Street',
      'Late Street & Main Street',
    ])
    expect(network.nodes).not.toContainEqual([0.005, 0.005])
  })

  it('rejects a part whose way references a node the part did not deliver', () => {
    const builder = new MeetingNetworkBuilder()
    builder.beginPart()
    for (const element of bentCrossing) builder.add(element)
    builder.add(way(103, [4, 999], 'Missing Road'))
    expect(() => builder.endPart()).toThrow(Error)
  })

  /** A builder holding `bentCrossing` as its first part, with a second part open. */
  function secondPart() {
    const builder = new MeetingNetworkBuilder()
    builder.beginPart()
    for (const element of bentCrossing) builder.add(element)
    builder.endPart()
    builder.beginPart()
    return builder
  }
  const bentNetwork = buildMeetingNetwork({ elements: bentCrossing }, options)

  it('rejects a later part that moves a node shared with an earlier part, and keeps the earlier data', () => {
    const builder = secondPart()
    builder.add(way(102, [5, 4, 6], 'Cross Street'))
    builder.add(node(5, 0.0013, 0.0009))
    expect(() => builder.add(node(4, 0.00131, 0.0011))).toThrow(
      'conflicting road coordinates across parts',
    )
    builder.abandonPart()
    expect(builder.build(options)).toEqual(bentNetwork)
  })

  it.each([
    ['other nodes', way(102, [5, 4], 'Cross Street')],
    ['reordered nodes', way(102, [6, 4, 5], 'Cross Street')],
    ['another name', way(102, [5, 4, 6], 'Other Street')],
    [
      'another highway type',
      way(102, [5, 4, 6], 'Cross Street', { highway: 'footway' }),
    ],
    [
      'an access restriction',
      way(102, [5, 4, 6], 'Cross Street', { access: 'private' }),
    ],
    ['a foot tag', way(102, [5, 4, 6], 'Cross Street', { foot: 'yes' })],
  ])('rejects a later copy of a way with %s', (_case, changed) => {
    const builder = secondPart()
    expect(() => builder.add(changed)).toThrow(
      'conflicting road data across parts',
    )
    builder.abandonPart()
    expect(builder.build(options)).toEqual(bentNetwork)
  })

  it('rejects an earlier node or way delivered twice within a later part', () => {
    const builder = secondPart()
    builder.add(node(4, 0.0013, 0.0011))
    expect(() => builder.add(node(4, 0.0013, 0.0011))).toThrow('duplicate')
    builder.add(way(102, [5, 4, 6], 'Cross Street'))
    expect(() => builder.add(way(102, [5, 4, 6], 'Cross Street'))).toThrow(
      'duplicate',
    )
  })

  it.each([
    ['a new way', [way(103, [6, 7], 'Third Street'), node(7, 0.0016, 0.0013)]],
    [
      'a repeated way',
      [
        way(102, [5, 4, 6], 'Cross Street'),
        node(4, 0.0013, 0.0011),
        node(5, 0.0013, 0.0009),
      ],
    ],
  ])(
    'rejects %s whose node only an earlier part delivered',
    (_case, elements) => {
      const builder = secondPart()
      for (const element of elements) builder.add(element)
      expect(() => builder.endPart()).toThrow('missing road nodes')
      builder.abandonPart()
      expect(builder.build(options)).toEqual(bentNetwork)
    },
  )

  it('accepts parts that repeat identical nodes and ways', () => {
    expect(inParts([bentCrossing, bentCrossing])).toEqual(bentNetwork)
    // The third part repeats only the island, with all of its nodes.
    expect(inParts([islands, bentCrossing, islands.slice(8)])).toEqual(
      buildMeetingNetwork({ elements: islands }, options),
    )
  })

  it('keeps ways that are not walkable out of the network across parts', () => {
    const motorway = [
      node(8, 0.0011, 0.002),
      way(108, [2, 8], 'Fast Road', { highway: 'motorway' }),
    ]
    const elements = [...bentCrossing, ...motorway]
    const single = buildMeetingNetwork({ elements }, options)
    expect(single).toEqual(bentNetwork)
    expect(inParts([elements, [...motorway, node(2, 0.0011, 0.0011)]])).toEqual(
      single,
    )
  })

  it('stops as soon as the area holds more road points than this device can hold', () => {
    const builder = new MeetingNetworkBuilder()
    builder.beginPart()
    for (let id = 1; id <= MAX_SOURCE_NODES; id++)
      builder.add(node(id, (id % 1000) * 0.00001, 0.001))
    expect(() => builder.add(node(MAX_SOURCE_NODES + 1, 0.001, 0.001))).toThrow(
      '1,500,001',
    )
  }, 30_000)
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

  const budget = (query: string) => {
    const match = /^\[out:json\]\[timeout:(\d+)\]\[maxsize:(\d+)\];/.exec(query)
    if (!match) throw new Error(`Unexpected query: ${query}`)
    return { seconds: Number(match[1]), bytes: Number(match[2]) }
  }
  const MiB = 1024 * 1024

  it.each([
    ['an 8 × 8 km square', regionBounds([-122.27, 37.8], 8), 60, 64 * MiB],
    [
      'a tiny area',
      [0, 0, 0.001, 0.001] as MeetingNetwork['bounds'],
      60,
      64 * MiB,
    ],
    ['a 12 × 12 km square', regionBounds([0, 0], 12), 74, 144 * MiB],
    [
      'the 702 km² three-person area',
      [-122.01085, 37.51399, -121.69563, 37.74126] as MeetingNetwork['bounds'],
      180,
      512 * MiB,
    ],
  ])(
    'scales server time and memory with the area of %s',
    (_name, area, seconds, bytes) => {
      expect(budget(buildOverpassQuery(area))).toEqual({ seconds, bytes })
    },
  )

  it('keeps the walking filter and asks for the whole bounds', () => {
    const area: MeetingNetwork['bounds'] = [
      -122.01085, 37.51399, -121.69563, 37.74126,
    ]
    expect(boundsSizeKm(area).areaKm2).toBeCloseTo(702, -1)
    const query = buildOverpassQuery(area)
    expect(query).toContain('(37.51399,-122.01085,37.74126,-121.69563)')
    expect(query).toContain('["foot"!="no"]')
    expect(query).toMatch(/out body;>;out skel qt;$/)
  })
})
