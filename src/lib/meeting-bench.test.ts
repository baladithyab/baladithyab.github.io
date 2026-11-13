import { describe, expect, it } from 'vitest'
import {
  prepareMeetingSearch,
  type MeetingNetwork,
  type MeetingSearch,
  type SearchTree,
} from './meeting-point'
import { prepareScalarSearch } from '../../scripts/meeting-bench/scalar-search'
import { summarize } from '../../scripts/meeting-bench/statistics.mjs'

type ExpectedTree = { distances: number[]; parents: number[] }

const nodes: MeetingNetwork['nodes'] = [
  [0, 0],
  [0.01, 0],
  [0.02, 0],
  [0.03, 0],
  [0.04, 0],
  [0.05, 0],
]

function network(edges: MeetingNetwork['edges']): MeetingNetwork {
  return {
    version: 1,
    name: 'Contract graph',
    bounds: [0, 0, 0.05, 0.01],
    attribution: 'Test',
    source: 'https://example.com',
    fetched: '2026-11-12',
    nodes,
    edges,
    places: nodes.map((_, node) => ({ node, name: `Place ${node}` })),
  }
}

const handNetwork = network([
  [0, 1, 1],
  [0, 2, 1],
  [1, 3, 1],
  [2, 3, 1],
  [3, 4, 0.25],
])

const fromZero: ExpectedTree = {
  distances: [0, 1, 1, 2, 2.25, Infinity],
  parents: [-1, 0, 0, 1, 3, -1],
}
const fromFour: ExpectedTree = {
  distances: [2.25, 1.25, 1.25, 0.25, 0, Infinity],
  parents: [1, 3, 3, 4, -1, -1],
}
const fromFive: ExpectedTree = {
  distances: [Infinity, Infinity, Infinity, Infinity, Infinity, 0],
  parents: [-1, -1, -1, -1, -1, -1],
}

const rankedZeroFour = [
  {
    node: 1,
    name: 'Place 1',
    distances: [1, 1.25],
    longest: 1.25,
    total: 2.25,
  },
  {
    node: 2,
    name: 'Place 2',
    distances: [1, 1.25],
    longest: 1.25,
    total: 2.25,
  },
  { node: 3, name: 'Place 3', distances: [2, 0.25], longest: 2, total: 2.25 },
  {
    node: 0,
    name: 'Place 0',
    distances: [0, 2.25],
    longest: 2.25,
    total: 2.25,
  },
  {
    node: 4,
    name: 'Place 4',
    distances: [2.25, 0],
    longest: 2.25,
    total: 2.25,
  },
]

function expectTree(tree: SearchTree, expected: ExpectedTree) {
  expect(tree.distances).toBeInstanceOf(Float64Array)
  expect(tree.parents).toBeInstanceOf(Int32Array)
  expect(Array.from(tree.distances)).toEqual(expected.distances)
  expect(Array.from(tree.parents)).toEqual(expected.parents)
}

function ownedBuffers(trees: SearchTree[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  for (const tree of trees)
    for (const { buffer } of [tree.distances, tree.parents]) {
      if (!(buffer instanceof ArrayBuffer))
        throw new Error(
          'search output is not backed by a transferable ArrayBuffer',
        )
      buffers.add(buffer)
    }
  return [...buffers]
}

function expectSummary(
  samples: number[],
  expected: { median: number; p95: number },
) {
  const { median, p95 } = summarize(samples)
  expect({ median, p95 }).toEqual(expected)
}

const engines: {
  engine: string
  prepare: (network: MeetingNetwork) => MeetingSearch
}[] = [
  { engine: 'current', prepare: prepareMeetingSearch },
  { engine: 'scalar', prepare: prepareScalarSearch },
]

describe.each(engines)('$engine meeting search contract', ({ prepare }) => {
  it('builds complete double-precision trees with unreachable sentinels', () => {
    const { trees } = prepare(handNetwork).find({
      origins: [0, 4],
      objective: 'fair',
    })
    expect(trees).toHaveLength(2)
    expectTree(trees[0], fromZero)
    expectTree(trees[1], fromFour)
  })

  it('ranks every reachable separated place for both objectives', () => {
    const search = prepare(handNetwork)
    for (const objective of ['fair', 'total'] as const)
      expect(search.find({ origins: [0, 4], objective }).results).toEqual(
        rankedZeroFour,
      )
  })

  it('counts duplicate origins as separate people with unaliased trees', () => {
    const { trees, results } = prepare(handNetwork).find({
      origins: [0, 0, 4],
      objective: 'total',
    })
    expectTree(trees[0], fromZero)
    expectTree(trees[1], fromZero)
    expectTree(trees[2], fromFour)
    expect(results).toEqual([
      {
        node: 0,
        name: 'Place 0',
        distances: [0, 0, 2.25],
        longest: 2.25,
        total: 2.25,
      },
      {
        node: 1,
        name: 'Place 1',
        distances: [1, 1, 1.25],
        longest: 1.25,
        total: 3.25,
      },
      {
        node: 2,
        name: 'Place 2',
        distances: [1, 1, 1.25],
        longest: 1.25,
        total: 3.25,
      },
      {
        node: 3,
        name: 'Place 3',
        distances: [2, 2, 0.25],
        longest: 2,
        total: 4.25,
      },
      {
        node: 4,
        name: 'Place 4',
        distances: [2.25, 2.25, 0],
        longest: 2.25,
        total: 4.5,
      },
    ])
    trees[0].distances[1] = 99
    trees[0].parents[3] = 99
    expect(trees[1].distances[1]).toBe(1)
    expect(trees[1].parents[3]).toBe(1)
  })

  it('handles sixteen alternating origins', () => {
    const origins = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0 ? 0 : 4,
    )
    const { trees, results } = prepare(handNetwork).find({
      origins,
      objective: 'fair',
    })
    expect(trees).toHaveLength(16)
    trees.forEach((tree, index) =>
      expectTree(tree, index % 2 === 0 ? fromZero : fromFour),
    )
    expect(results.map((result) => result.node)).toEqual([1, 2, 3, 0, 4])
    expect(results[0]).toEqual({
      node: 1,
      name: 'Place 1',
      distances: origins.map((origin) => (origin === 0 ? 1 : 1.25)),
      longest: 1.25,
      total: 18,
    })
  })

  it('returns complete trees but no meeting place for a disconnected origin', () => {
    const { trees, results } = prepare(handNetwork).find({
      origins: [0, 5],
      objective: 'fair',
    })
    expectTree(trees[0], fromZero)
    expectTree(trees[1], fromFive)
    expect(results).toEqual([])
  })

  it('relaxes only strict double-precision improvements', () => {
    const { trees } = prepare(
      network([
        [0, 1, 0.3],
        [0, 2, 0.1],
        [2, 1, 0.2],
        [0, 3, 0.3],
        [0, 4, 0.1],
        [4, 3, 0.1],
      ]),
    ).find({ origins: [0, 1], objective: 'fair' })
    expectTree(trees[0], {
      distances: [0, 0.3, 0.1, 0.2, 0.1, Infinity],
      parents: [-1, 0, 0, 4, 0, -1],
    })
  })

  it('reaches nodes over zero-metre edges without re-parenting equal paths', () => {
    const { trees } = prepare(
      network([
        [0, 1, 0],
        [0, 2, 1],
        [1, 2, 1],
      ]),
    ).find({ origins: [0, 1], objective: 'fair' })
    expectTree(trees[0], {
      distances: [0, 0, 1, Infinity, Infinity, Infinity],
      parents: [-1, 0, 0, -1, -1, -1],
    })
    expectTree(trees[1], {
      distances: [0, 0, 1, Infinity, Infinity, Infinity],
      parents: [1, -1, 1, -1, -1, -1],
    })
  })

  it('keeps the current heap order when sinking past equal priorities', () => {
    const { trees } = prepare(
      network([
        [0, 1, 1],
        [0, 2, 1],
        [0, 3, 1],
        [2, 4, 1],
        [3, 4, 1],
      ]),
    ).find({ origins: [0, 4], objective: 'fair' })
    expectTree(trees[0], {
      distances: [0, 1, 1, 1, 2, Infinity],
      parents: [-1, 0, 0, 0, 3, -1],
    })
  })

  it('prefers the left child when equal-priority children sink past a larger value', () => {
    const { trees } = prepare(
      network([
        [0, 1, 1],
        [0, 2, 2],
        [0, 3, 2],
        [0, 4, 3],
        [2, 5, 1],
        [3, 5, 1],
      ]),
    ).find({ origins: [0, 5], objective: 'fair' })
    expectTree(trees[0], {
      distances: [0, 1, 2, 2, 3, 3],
      parents: [-1, 0, 0, 0, 0, 2],
    })
  })

  it('keeps returned outputs owned across later solves and transfer', () => {
    const search = prepare(handNetwork)
    const first = search.find({ origins: [0, 4], objective: 'fair' })
    const later = search.find({ origins: [4, 0, 5], objective: 'total' })
    expectTree(first.trees[0], fromZero)
    expectTree(first.trees[1], fromFour)
    expect(first.results).toEqual(rankedZeroFour)
    expectTree(later.trees[0], fromFour)
    expectTree(later.trees[1], fromZero)
    expectTree(later.trees[2], fromFive)
    expect(later.results).toEqual([])

    const firstBuffers = ownedBuffers(first.trees)
    for (const buffer of ownedBuffers(later.trees))
      expect(firstBuffers).not.toContain(buffer)

    const moved = structuredClone(first.trees, { transfer: firstBuffers })
    for (const buffer of firstBuffers) expect(buffer.byteLength).toBe(0)
    expectTree(moved[0], fromZero)
    expectTree(moved[1], fromFour)
    expectTree(later.trees[0], fromFour)

    const again = search.find({ origins: [0, 4], objective: 'fair' })
    expectTree(again.trees[0], fromZero)
    expectTree(again.trees[1], fromFour)
    expect(again.results).toEqual(rankedZeroFour)
  })
})

describe('benchmark statistics contract', () => {
  const twenty = Array.from(
    { length: 20 },
    (_, index) => ((index * 7) % 20) + 1,
  )

  it('reports the conventional median and nearest-rank p95', () => {
    expectSummary(twenty, { median: 10.5, p95: 19 })
    expectSummary([10, 9, 100, 2], { median: 9.5, p95: 100 })
    expectSummary([7, 2, 5], { median: 5, p95: 7 })
    expectSummary([4.25], { median: 4.25, p95: 4.25 })
  })

  it('rejects empty and non-finite samples', () => {
    expect(() => summarize([])).toThrow()
    expect(() => summarize([1, Number.NaN])).toThrow()
    expect(() => summarize([1, Infinity])).toThrow()
    expect(() => summarize([-Infinity, 1])).toThrow()
  })
})
