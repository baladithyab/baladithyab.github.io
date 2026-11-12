import { describe, expect, it } from 'vitest'
import { findMeetings, type MeetingNetwork } from './meeting-point'
import {
  findSearchCollisions,
  searchProgress,
  SEARCH_COMPLETE_AT,
} from './meeting-collisions'

const network: MeetingNetwork = {
  version: 1,
  name: 'Collision test',
  bounds: [0, 0, 0.05, 0.05],
  attribution: 'Test',
  source: 'https://example.com',
  fetched: '2026-11-11',
  nodes: [
    [0, 0],
    [0, 0.02],
    [0.03, 0.02],
    [0.04, 0.02],
  ],
  edges: [
    [0, 1, 6],
    [1, 2, 14],
    [0, 2, 40],
  ],
  places: [{ node: 1, name: 'Road bend' }],
}

describe('search collision timeline', () => {
  it('places first contact inside the shortest-path edge, not at the geographic midpoint or nearest junction', () => {
    const origins = [0, 2]
    const { trees } = findMeetings({ network, origins, objective: 'fair' })
    const contacts = findSearchCollisions({ network, origins, trees })
    expect(contacts).toHaveLength(1)
    expect(contacts[0].sources).toEqual([0, 1])
    expect(contacts[0].metres).toBe(10)
    expect(contacts[0].coordinate[0]).toBeCloseTo((0.03 * 4) / 14)
    expect(contacts[0].coordinate[1]).toBe(0.02)
  })
  it('emits every unordered pair once, preserving simultaneous contacts in deterministic order', () => {
    const graph = {
      ...network,
      edges: [
        [0, 1, 10],
        [1, 2, 10],
        [2, 3, 10],
      ] satisfies MeetingNetwork['edges'],
    }
    const origins = [0, 1, 2, 3]
    const { trees } = findMeetings({
      network: graph,
      origins,
      objective: 'fair',
    })
    const contacts = findSearchCollisions({ network: graph, origins, trees })
    expect(
      contacts.map(({ sources, metres }) => ({ sources, metres })),
    ).toEqual([
      { sources: [0, 1], metres: 5 },
      { sources: [1, 2], metres: 5 },
      { sources: [2, 3], metres: 5 },
      { sources: [0, 2], metres: 10 },
      { sources: [1, 3], metres: 10 },
      { sources: [0, 3], metres: 15 },
    ])
  })
  it('handles coincident starts without dividing by zero and does not invent unreachable contacts', () => {
    const origins = [0, 0, 3]
    const { trees } = findMeetings({ network, origins, objective: 'fair' })
    expect(findSearchCollisions({ network, origins, trees })).toEqual([
      { sources: [0, 1], coordinate: [0, 0], metres: 0 },
    ])
  })
  it('finds a contact exactly at a junction without choosing the following edge', () => {
    const graph = {
      ...network,
      edges: [
        [0, 1, 10],
        [1, 2, 10],
      ] satisfies MeetingNetwork['edges'],
    }
    const origins = [0, 2]
    const { trees } = findMeetings({
      network: graph,
      origins,
      objective: 'fair',
    })
    expect(findSearchCollisions({ network: graph, origins, trees })[0]).toEqual(
      {
        sources: [0, 1],
        coordinate: [0, 0.02],
        metres: 10,
      },
    )
  })
  it('all pairwise first contacts occur before everyone reaches a selected result, for either ranking objective', () => {
    for (const objective of ['fair', 'total'] satisfies ('fair' | 'total')[]) {
      const origins = [0, 1, 2]
      const { trees, results } = findMeetings({ network, origins, objective })
      for (const contact of findSearchCollisions({ network, origins, trees })) {
        expect(contact.metres).toBeLessThanOrEqual(results[0].longest)
      }
    }
  })
  it('finishes road expansion before the final pulse, with reversible and bounded seeking', () => {
    expect(searchProgress(SEARCH_COMPLETE_AT)).toBe(1)
    expect(searchProgress(0.93)).toBe(1)
    expect(searchProgress(0.43)).toBeCloseTo(0.5)
    expect(searchProgress(1)).toBe(1)
    expect(searchProgress(0)).toBe(0)
    expect(searchProgress(-1)).toBe(0)
    expect(searchProgress(2)).toBe(1)
  })
})
