import { describe, expect, it } from 'vitest'
import {
  distanceBetween,
  findMeetings,
  parseNetwork,
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
    const { results } = findMeetings({
      network,
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
    const { results } = findMeetings({
      network,
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
    const { trees } = findMeetings({
      network: graph,
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
    const { results } = findMeetings({
      network: graph,
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
      findMeetings({ network, origins: [0, 4], objective: 'fair' }).results,
    ).toEqual([])
  })
  it('rejects fewer than two starts and invalid graph indices', () => {
    expect(() =>
      findMeetings({ network, origins: [0], objective: 'fair' }),
    ).toThrow('at least two')
    expect(() =>
      findMeetings({ network, origins: [0, 5], objective: 'fair' }),
    ).toThrow('outside')
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
