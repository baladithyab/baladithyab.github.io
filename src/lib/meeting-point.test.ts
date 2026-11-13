import { describe, expect, it } from 'vitest'
import {
  distanceBetween,
  parseNetwork,
  prepareMeetingSearch,
  rankMeetingResults,
  routeTo,
  type MeetingNetwork,
} from './meeting-point'

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
