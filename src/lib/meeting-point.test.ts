import { describe, expect, it } from 'vitest'
import {
  distanceBetween,
  parseNetwork,
  prepareMeetingSearch,
  rankMeetingResults,
  routeTo,
  type MeetingNetwork,
  type Objective,
} from './meeting-point'
import type { InfluenceBias } from './meeting-influence'

const network: MeetingNetwork = {
  version: 1,
  name: 'Test region',
  bounds: [0, 0, 0.05, 0.01],
  attribution: 'Test',
  source: 'https://example.com',
  fetched: '2026-11-11',
  nodes: [
    [0, 0],
    [0.01, 0],
    [0.02, 0],
    [0.03, 0],
    [0.04, 0],
  ],
  edges: [
    [0, 1, 10],
    [1, 2, 10],
    [2, 3, 10],
  ],
  places: [0, 1, 2, 3, 4].map((node) => ({ node, name: `Crossing ${node}` })),
}

describe('meeting point search', () => {
  it('minimizes the longest journey with total distance breaking ties; duplicate starts still count as people', () => {
    const { results } = prepareMeetingSearch(network).find({
      origins: [0, 0, 3],
      objective: 'fair',
    })
    expect(results[0]).toMatchObject({
      node: 1,
      distances: [10, 10, 20],
      longest: 20,
      total: 40,
    })
    expect(results.map((result) => result.node)).toEqual([1, 2, 0, 3])
  })
  it('can choose a different answer when minimizing combined distance', () => {
    const { results } = prepareMeetingSearch(network).find({
      origins: [0, 0, 3],
      objective: 'total',
    })
    expect(results[0]).toMatchObject({
      node: 0,
      distances: [0, 0, 30],
      longest: 30,
      total: 30,
    })
    expect(results.map((result) => result.node)).not.toContain(4)
  })
  it('follows the shortest road path rather than a direct but longer connection', () => {
    const graph = {
      ...network,
      edges: [
        [0, 3, 100],
        [0, 1, 5],
        [1, 2, 7],
        [2, 3, 3],
      ] satisfies MeetingNetwork['edges'],
    }
    const { trees } = prepareMeetingSearch(graph).find({
      origins: [0, 3],
      objective: 'fair',
    })
    expect(trees[0].distances[3]).toBe(15)
    expect(routeTo(trees[0], 3)).toEqual([0, 1, 2, 3])
    expect(routeTo(trees[0], 4)).toEqual([])
  })
  it('does not present adjacent nodes as distinct alternatives', () => {
    const graph = {
      ...network,
      nodes: [
        [0, 0],
        [0.0001, 0],
        [0.02, 0],
        [0.03, 0],
        [0.04, 0],
      ] satisfies MeetingNetwork['nodes'],
    }
    const { results } = prepareMeetingSearch(graph).find({
      origins: [0, 3],
      objective: 'fair',
    })
    expect(results.map((result) => result.node)).toEqual([1, 2, 3])
    for (const a of results)
      for (const b of results)
        if (a !== b)
          expect(
            distanceBetween(graph.nodes[a.node], graph.nodes[b.node]),
          ).toBeGreaterThanOrEqual(400)
  })
  it('returns no meeting point when starts cannot reach any common candidate', () => {
    expect(
      prepareMeetingSearch(network).find({ origins: [0, 4], objective: 'fair' })
        .results,
    ).toEqual([])
  })
  it('rejects fewer than two starts and invalid graph indices without disturbing later searches', () => {
    const search = prepareMeetingSearch(network)
    const before = search.find({ origins: [0, 3], objective: 'fair' })
    expect(() => search.find({ origins: [0], objective: 'fair' })).toThrow(
      'at least two',
    )
    expect(() => search.find({ origins: [0, 5], objective: 'fair' })).toThrow(
      'outside',
    )
    expect(search.find({ origins: [0, 3], objective: 'fair' })).toEqual(before)
  })
  it('reuses one prepared graph for different groups and objectives with independent trees', () => {
    const search = prepareMeetingSearch(network)
    const first = search.find({ origins: [0, 0, 3], objective: 'fair' })
    const second = search.find({ origins: [3, 1], objective: 'total' })
    const again = search.find({ origins: [0, 0, 3], objective: 'fair' })
    expect(again).toEqual(first)
    expect(second.trees).toHaveLength(2)
    expect(second.trees[0].distances[0]).toBe(30)
    expect(first.trees[0].distances).not.toBe(again.trees[0].distances)
    expect(first.trees[0].distances.buffer).not.toBe(
      again.trees[0].distances.buffer,
    )
  })
  it('keeps fractional metres in double precision and lets the cheaper path win', () => {
    const graph = {
      ...network,
      edges: [
        [0, 1, 0.1],
        [1, 2, 0.2],
        [0, 2, 0.3],
      ] satisfies MeetingNetwork['edges'],
    }
    const { trees } = prepareMeetingSearch(graph).find({
      origins: [0, 2],
      objective: 'fair',
    })
    expect(trees[0].distances[1]).toBe(0.1)
    expect(trees[0].distances[2]).toBe(0.3)
    expect(routeTo(trees[0], 2)).toEqual([0, 2])
  })
  it('breaks equal-length path ties by edge insertion order', () => {
    const diamond = (edges: MeetingNetwork['edges']) => ({
      ...network,
      edges,
    })
    const viaOne = diamond([
      [0, 1, 1],
      [0, 2, 1],
      [1, 3, 1],
      [2, 3, 1],
    ])
    const viaTwo = diamond([
      [0, 2, 1],
      [0, 1, 1],
      [2, 3, 1],
      [1, 3, 1],
    ])
    const origins = [0, 3]
    const a = prepareMeetingSearch(viaOne).find({ origins, objective: 'fair' })
    const b = prepareMeetingSearch(viaTwo).find({ origins, objective: 'fair' })
    expect(routeTo(a.trees[0], 3)).toEqual([0, 1, 3])
    expect(routeTo(b.trees[0], 3)).toEqual([0, 2, 3])
  })
  it('does not leak state between prepared networks', () => {
    const shortcut = {
      ...network,
      edges: [[0, 3, 1]] satisfies MeetingNetwork['edges'],
    }
    const original = prepareMeetingSearch(network)
    const other = prepareMeetingSearch(shortcut)
    expect(
      other.find({ origins: [0, 3], objective: 'fair' }).trees[0].distances[3],
    ).toBe(1)
    expect(
      original.find({ origins: [0, 3], objective: 'fair' }).trees[0]
        .distances[3],
    ).toBe(30)
  })
  it('reranks completed trees for another objective without changing them', () => {
    const search = prepareMeetingSearch(network)
    const origins = [0, 0, 3]
    const fair = search.find({ origins, objective: 'fair' })
    const copies = fair.trees.map((tree) => ({
      distances: tree.distances.slice(),
      parents: tree.parents.slice(),
    }))
    const reranked = rankMeetingResults({
      network,
      trees: fair.trees,
      objective: 'total',
    })
    expect(reranked).toEqual(
      search.find({ origins, objective: 'total' }).results,
    )
    expect(reranked[0].node).not.toBe(fair.results[0].node)
    expect(fair.trees).toEqual(copies)
    expect(
      rankMeetingResults({ network, trees: fair.trees, objective: 'fair' }),
    ).toEqual(fair.results)
  })
  it('rejects broken network connections and invalid coordinates at the data boundary', () => {
    expect(() => parseNetwork({ ...network, edges: [[0, 99, 10]] })).toThrow(
      'connections',
    )
    expect(() => parseNetwork({ ...network, edges: [[0, 1, -10]] })).toThrow(
      'connections',
    )
    expect(() => parseNetwork({ ...network, nodes: [[0, Infinity]] })).toThrow(
      'coordinates',
    )
    expect(() => parseNetwork({ ...network, bounds: [5, 0, 1, 1] })).toThrow(
      'bounds',
    )
  })
})

// A straight path 0-4 (100 m per segment) with node 5 on a 30 m spur from
// node 2. Every node is about 1.1 km from the others, so none are merged.
const spur: MeetingNetwork = {
  ...network,
  bounds: [0, 0, 0.05, 0.02],
  nodes: [
    [0, 0],
    [0.01, 0],
    [0.02, 0],
    [0.03, 0],
    [0.04, 0],
    [0.02, 0.01],
  ],
  edges: [
    [0, 1, 100],
    [1, 2, 100],
    [2, 3, 100],
    [3, 4, 100],
    [2, 5, 30],
  ],
  places: [0, 1, 2, 3, 4, 5].map((node) => ({
    node,
    name: `Crossing ${node}`,
  })),
}
const spurOrigins = [0, 4]
const spurTrees = prepareMeetingSearch(spur).find({
  origins: spurOrigins,
  objective: 'fair',
}).trees
const field = (entries: Record<number, number>) => {
  const values = new Float64Array(spur.nodes.length)
  for (const [node, value] of Object.entries(entries))
    values[Number(node)] = value
  return values
}
const rank = (objective: Objective, bias?: InfluenceBias) =>
  rankMeetingResults({ network: spur, trees: spurTrees, objective, bias })
const order = (objective: Objective, bias?: InfluenceBias) =>
  rank(objective, bias).map((result) => result.node)

describe('meeting point ranking with influence', () => {
  it('reproduces the unbiased ranking exactly without a bias or with a zero budget', () => {
    const values = field({ 1: 1, 2: -1, 5: 0.5 })
    for (const objective of ['fair', 'total'] as const) {
      const unbiased = prepareMeetingSearch(spur).find({
        origins: spurOrigins,
        objective,
      }).results
      expect(rank(objective)).toStrictEqual(unbiased)
      expect(rank(objective, { values, budget: 0 })).toStrictEqual(unbiased)
    }
    expect(order('fair')).toEqual([2, 5, 1, 3, 0, 4])
    expect(order('total')).toEqual([2, 1, 3, 0, 4, 5])
  })
  it('promotes a slightly longer option only when the attract budget outweighs the gap', () => {
    // Node 1's longest walk is 100 m more than node 2's.
    const full = field({ 1: 1 })
    expect(order('fair', { values: full, budget: 90 })[0]).toBe(2)
    expect(order('fair', { values: full, budget: 110 })[0]).toBe(1)
    // A half-strength field is worth half as much.
    const half = field({ 1: 0.5 })
    expect(order('fair', { values: half, budget: 110 })[0]).toBe(2)
    expect(order('fair', { values: half, budget: 210 })[0]).toBe(1)
  })
  it('demotes the unbiased winner inside an avoid field', () => {
    const values = field({ 2: -1 })
    expect(order('fair', { values, budget: 50 })).toEqual([5, 2, 1, 3, 0, 4])
    expect(order('total', { values, budget: 50 })).toEqual([1, 3, 0, 4, 5, 2])
  })
  it('counts the field once per person when minimizing combined distance', () => {
    // Node 5 adds a 30 m detour for both people: 30 m on the longest walk,
    // 60 m combined. The same field moves it twice as far under 'total', so a
    // budget just over 30 m per person promotes it under both objectives.
    const values = field({ 5: 1 })
    expect(order('fair', { values, budget: 29 })[0]).toBe(2)
    expect(order('fair', { values, budget: 31 })[0]).toBe(5)
    expect(order('total', { values, budget: 29 })).toEqual([2, 1, 3, 0, 4, 5])
    expect(order('total', { values, budget: 31 })[0]).toBe(5)
  })
  it('reports true distances whatever the bias', () => {
    const bias = { values: field({ 2: -1, 5: 1, 0: 0.4 }), budget: 300 }
    for (const objective of ['fair', 'total'] as const) {
      const unbiased = rank(objective)
      const biased = rank(objective, bias)
      expect(biased.map((result) => result.node)).not.toEqual(
        unbiased.map((result) => result.node),
      )
      for (const result of biased) {
        expect(Object.keys(result)).toEqual([
          'node',
          'name',
          'distances',
          'longest',
          'total',
        ])
        expect(result).toEqual(
          unbiased.find((candidate) => candidate.node === result.node),
        )
      }
    }
  })
  it('keeps promoted spots at least 400 m from every other alternative', () => {
    const graph = {
      ...network,
      nodes: [
        [0, 0],
        [0.0001, 0],
        [0.02, 0],
        [0.03, 0],
        [0.04, 0],
      ] satisfies MeetingNetwork['nodes'],
    }
    const { trees } = prepareMeetingSearch(graph).find({
      origins: [0, 3],
      objective: 'fair',
    })
    const values = new Float64Array(graph.nodes.length)
    values[0] = 1
    const results = rankMeetingResults({
      network: graph,
      trees,
      objective: 'fair',
      bias: { values, budget: 100 },
    })
    expect(results.map((result) => result.node)).toEqual([0, 2, 3])
    for (const a of results)
      for (const b of results)
        if (a !== b)
          expect(
            distanceBetween(graph.nodes[a.node], graph.nodes[b.node]),
          ).toBeGreaterThanOrEqual(400)
  })
  it('rejects a field built for another network or a negative budget', () => {
    expect(() =>
      rank('fair', { values: new Float64Array(3), budget: 100 }),
    ).toThrow('network')
    expect(() => rank('fair', { values: field({}), budget: -1 })).toThrow(
      'budget',
    )
  })
})
