import { describe, expect, it } from 'vitest'
import {
  prepareMeetingSearch,
  type MeetingNetwork,
  type SearchOutput,
  type SearchTree,
} from './meeting-point'
import {
  findSearchCollisions,
  type SearchCollision,
} from './meeting-collisions'
import { prepareScalarSearch } from '../../scripts/meeting-bench/scalar-search'
import {
  fingerprintSearchOutput as fingerprint,
  outputDifferences,
} from '../../scripts/meeting-bench/fingerprint.mjs'

const nodes: MeetingNetwork['nodes'] = [
  [0, 0],
  [0.01, 0],
  [0.02, 0],
  [0.03, 0],
  [0.04, 0],
  [0.05, 0],
]

// Node 5 is unreachable, so every tree carries Infinity/-1 sentinels.
const network: MeetingNetwork = {
  version: 1,
  name: 'Fingerprint graph',
  bounds: [0, 0, 0.05, 0.01],
  attribution: 'Test',
  source: 'https://example.com',
  fetched: '2026-11-12',
  nodes,
  edges: [
    [0, 1, 1],
    [0, 2, 1],
    [1, 3, 1],
    [2, 3, 1],
    [3, 4, 0.25],
  ],
  places: nodes.map((_, node) => ({ node, name: `Place ${node}` })),
}

const origins = [0, 4]

type Reply = {
  origins: number[]
  objective: 'fair' | 'total'
  output: SearchOutput
  collisions: SearchCollision[]
}

function reply(prepare = prepareMeetingSearch): Reply {
  const output = prepare(network).find({ origins, objective: 'fair' })
  const collisions = findSearchCollisions({
    network,
    trees: output.trees,
    origins,
  })
  return { origins, objective: 'fair', output, collisions }
}

// The summary fields the harness compared before complete fingerprints.
const summaries = ({ output }: Reply) =>
  JSON.stringify(
    output.results.map(({ node, name, longest, total }) => ({
      node,
      name,
      longest,
      total,
    })),
  )

// Origin-major packing into one shared buffer per field, with sentinel-unlike
// padding before and between views, as a worker might export them.
function originMajor(trees: SearchTree[], pad: number) {
  const count = trees[0].distances.length
  const size = pad + trees.length * (count + pad)
  const distances = new Float64Array(size).fill(-7)
  const parents = new Int32Array(size).fill(99)
  const views = trees.map((tree, index) => {
    const start = pad + index * (count + pad)
    distances.set(tree.distances, start)
    parents.set(tree.parents, start)
    return {
      distances: distances.subarray(start, start + count),
      parents: parents.subarray(start, start + count),
    }
  })
  return { views, distances, parents }
}

describe('meeting search output fingerprints', () => {
  it('match for current, scalar and a structured-cloned identity reply', async () => {
    const current = reply()
    expect(current.output.results.length).toBeGreaterThan(0)
    expect(current.collisions.length).toBeGreaterThan(0)
    const reference = await fingerprint(current)
    const scalar = await fingerprint(reply(prepareScalarSearch))
    const identity = await fingerprint(structuredClone(current))
    expect(outputDifferences(reference, scalar)).toEqual([])
    expect(outputDifferences(reference, identity)).toEqual([])
    expect(identity.digest).toBe(reference.digest)
    expect(reference).toMatchObject({
      originCount: 2,
      treeCount: 2,
      viewBytes: 2 * 6 * (8 + 4),
    })
  })

  it('rejects filled parents that preserve summaries, distances and contacts', async () => {
    const reference = await fingerprint(reply())
    const corrupted = reply()
    for (const tree of corrupted.output.trees) tree.parents.fill(-1)
    expect(summaries(corrupted)).toBe(summaries(reply()))
    const candidate = await fingerprint(corrupted)
    expect(outputDifferences(reference, candidate)).toEqual(['parents'])
    expect(candidate.digest).not.toBe(reference.digest)
  })

  it('rejects changed unreachable sentinels in distances and parents', async () => {
    const reference = await fingerprint(reply())
    const distance = reply()
    expect(distance.output.trees[0].distances[5]).toBe(Infinity)
    distance.output.trees[0].distances[5] = Number.MAX_VALUE
    expect(outputDifferences(reference, await fingerprint(distance))).toEqual([
      'distances',
    ])
    const parent = reply()
    expect(parent.output.trees[1].parents[5]).toBe(-1)
    parent.output.trees[1].parents[5] = 0
    expect(outputDifferences(reference, await fingerprint(parent))).toEqual([
      'parents',
    ])
  })

  it('rejects per-origin candidate distances behind unchanged summaries', async () => {
    const reference = await fingerprint(reply())
    const corrupted = reply()
    corrupted.output.results[0].distances[1] += 0.5
    expect(summaries(corrupted)).toBe(summaries(reply()))
    expect(outputDifferences(reference, await fingerprint(corrupted))).toEqual([
      'results',
    ])
  })

  it('rejects a moved collision contact or swapped collision sources', async () => {
    const reference = await fingerprint(reply())
    const moved = reply()
    const [contact] = moved.collisions
    contact.coordinate = [contact.coordinate[0], contact.coordinate[1] + 1e-9]
    expect(outputDifferences(reference, await fingerprint(moved))).toEqual([
      'collisions',
    ])
    const swapped = reply()
    swapped.collisions[0].sources = [1, 0]
    expect(outputDifferences(reference, await fingerprint(swapped))).toEqual([
      'collisions',
    ])
  })

  it('rejects a changed posted objective as request metadata', async () => {
    const reference = await fingerprint(reply())
    const objective = await fingerprint({ ...reply(), objective: 'total' })
    expect(outputDifferences(reference, objective)).toEqual(['request'])
  })

  it('keeps nonfinite metadata distinct where JSON collapses it to null', async () => {
    const infinite = reply()
    const missing = reply()
    infinite.output.results[0].longest = Infinity
    missing.output.results[0].longest = NaN
    expect(JSON.stringify(infinite.output.results)).toBe(
      JSON.stringify(missing.output.results),
    )
    expect(
      outputDifferences(
        await fingerprint(infinite),
        await fingerprint(missing),
      ),
    ).toEqual(['results'])
  })

  it('ignores object property insertion order in candidates and collisions', async () => {
    const reference = await fingerprint(reply())
    const reordered = reply()
    const reverse = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T
    reordered.output.results = reordered.output.results.map(reverse)
    reordered.collisions = reordered.collisions.map(reverse)
    expect((await fingerprint(reordered)).digest).toBe(reference.digest)
    expect(Object.keys(reordered.output.results[0])).not.toEqual(
      Object.keys(reply().output.results[0]),
    )
  })

  it('hashes only each subview of a shared origin-major buffer', async () => {
    const owned = reply()
    const reference = await fingerprint(owned)
    const shared = originMajor(owned.output.trees, 3)
    const packed = {
      ...owned,
      output: { ...owned.output, trees: shared.views },
    }
    expect(shared.views[1].distances.buffer).toBe(
      shared.views[0].distances.buffer,
    )
    expect((await fingerprint(packed)).digest).toBe(reference.digest)

    shared.distances[0] = 123
    shared.parents.fill(55, 0, 3)
    expect((await fingerprint(packed)).digest).toBe(reference.digest)

    shared.views[1].distances[2] += 1
    expect(outputDifferences(reference, await fingerprint(packed))).toEqual([
      'distances',
    ])
  })

  it('requires typed tree views instead of expanding plain arrays', async () => {
    const plain = reply()
    const [tree] = plain.output.trees
    plain.output.trees[0] = {
      distances: Array.from(tree.distances),
      parents: tree.parents,
    } as unknown as SearchTree
    await expect(fingerprint(plain)).rejects.toThrow(/not a Float64Array/)
  })
})
