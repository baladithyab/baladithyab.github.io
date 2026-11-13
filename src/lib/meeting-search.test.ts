import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type * as GeneratedModule from '../../crates/meeting-point/pkg/meeting_point.js'
import { findSearchCollisions } from './meeting-collisions'
import {
  nearestNode,
  parseNetwork,
  prepareMeetingSearch as prepareReference,
  rankMeetingResults,
  sfRegion,
  type Coordinate,
  type MeetingNetwork,
  type MeetingSearch as ReferenceSearch,
  type Objective,
  type SearchOutput,
  type SearchTree,
} from './meeting-point'

// The frozen private adapter seam (src/lib/meeting-search.ts).
type Found = { output: SearchOutput; transfer: ArrayBuffer[] }
type Prepared = {
  find(request: { origins: number[]; objective: Objective }): Found
  dispose(): void
  memoryBytes(): number
}
type Adapter = {
  prepareMeetingSearch(network: MeetingNetwork): Promise<Prepared>
}
type Generated = typeof GeneratedModule
type RawGraph = GeneratedModule.MeetingSearch
type Edge = MeetingNetwork['edges'][number]

const WASM_PAGE = 65536
const INF = Infinity

let wasm: Generated
let memory: WebAssembly.Memory
let adapter: Adapter

// The real generated wasm-bindgen module is initialised from file bytes BEFORE the
// adapter is imported, so both share one module instance and one WebAssembly
// instance. Nothing is mocked: the files exist only after the parent builds the
// meeting-point package (`build:wasm:meeting`). Static imports cannot be used here:
// the adapter must load only after initSync, which is the loading order under test.
beforeAll(async () => {
  wasm = await import('../../crates/meeting-point/pkg/meeting_point.js')
  const bytes = readFileSync(
    fileURLToPath(
      new URL(
        '../../crates/meeting-point/pkg/meeting_point_bg.wasm',
        import.meta.url,
      ),
    ),
  )
  memory = wasm.initSync({ module: bytes }).memory
  adapter = await import('./meeting-search')
})

// --- fixtures -------------------------------------------------------------

function makeNetwork(
  count: number,
  edges: Edge[],
  placeNodes: number[] = Array.from({ length: count }, (_, node) => node),
): MeetingNetwork {
  // Distinct points at least ~1 km apart, so every place can be ranked.
  const nodes = Array.from({ length: count }, (_, index): Coordinate => [
    (index % 90) * 0.01,
    Math.floor(index / 90) * 0.01,
  ])
  return {
    version: 1,
    name: 'Contract graph',
    bounds: [0, 0, 1, 1],
    attribution: 'Test',
    source: 'https://example.com',
    fetched: '2026-11-12',
    nodes,
    edges,
    places: placeNodes.map((node) => ({ node, name: `Place ${node}` })),
  }
}

// Diamond 0-1-3 / 0-2-3 with a tail 3-4 and an isolated node 5.
const hand: Edge[] = [
  [0, 1, 1],
  [0, 2, 1],
  [1, 3, 1],
  [2, 3, 1],
  [3, 4, 0.25],
]
const fromZero = {
  distances: [0, 1, 1, 2, 2.25, INF],
  parents: [-1, 0, 0, 1, 3, -1],
}
const fromFour = {
  distances: [2.25, 1.25, 1.25, 0.25, 0, INF],
  parents: [1, 3, 3, 4, -1, -1],
}
const fromFive = {
  distances: [INF, INF, INF, INF, INF, 0],
  parents: [-1, -1, -1, -1, -1, -1],
}
const handNetwork = makeNetwork(6, hand)

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** kind: ties and zero weights, tenths, arbitrary fractions, halves. */
function randomEdges(
  seed: number,
  count: number,
  edgeCount: number,
  kind: 0 | 1 | 2 | 3,
): Edge[] {
  const next = rng(seed)
  return Array.from({ length: edgeCount }, (): Edge => {
    const a = Math.floor(next() * count)
    const b = Math.floor(next() * count)
    const metres =
      kind === 0
        ? Math.floor(next() * 4)
        : kind === 1
          ? Math.floor(next() * 10) / 10
          : kind === 2
            ? next() * 5
            : (Math.floor(next() * 3) + 1) * 0.5
    return [a, b, metres]
  })
}

function gridEdges(width: number, height: number): Edge[] {
  const edges: Edge[] = []
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const id = y * width + x
      if (x + 1 < width) edges.push([id, id + 1, 1])
      if (y + 1 < height) edges.push([id, id + width, 1])
    }
  return edges
}

function randomOrigins(seed: number, count: number, size: number): number[] {
  const next = rng(seed)
  return Array.from({ length: size }, () => Math.floor(next() * count))
}

function spacedPlaces(count: number, wanted = 64): number[] {
  const size = Math.min(count, wanted)
  return Array.from({ length: size }, (_, i) => Math.floor((i * count) / size))
}

// --- comparison helpers ---------------------------------------------------

/** Index of the first differing byte, -1 when identical. Fast path is one memcmp. */
function firstDifference(a: ArrayBufferView, b: ArrayBufferView): number {
  const x = Buffer.from(a.buffer, a.byteOffset, a.byteLength)
  const y = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  if (x.equals(y)) return -1
  if (x.length !== y.length) return Math.min(x.length, y.length)
  return x.findIndex((value: number, index: number) => value !== y[index])
}

function expectSameTrees(actual: SearchTree[], expected: SearchTree[]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((tree, index) => {
    expect(tree.distances).toBeInstanceOf(Float64Array)
    expect(tree.parents).toBeInstanceOf(Int32Array)
    expect(tree.distances).toHaveLength(expected[index].distances.length)
    expect(firstDifference(tree.distances, expected[index].distances)).toBe(-1)
    expect(firstDifference(tree.parents, expected[index].parents)).toBe(-1)
  })
}

/** Trees, ranking and contacts all equal the original JavaScript output. */
function expectSameOutput(
  actual: SearchOutput,
  expected: SearchOutput,
  network: MeetingNetwork,
  origins: number[],
) {
  expectSameTrees(actual.trees, expected.trees)
  expect(actual.results).toEqual(expected.results)
  expect(
    findSearchCollisions({ network, origins, trees: actual.trees }),
  ).toEqual(findSearchCollisions({ network, origins, trees: expected.trees }))
}

/** Two unique owned flat blocks with row subarrays, transferred once each. */
function expectFlatBlocks(found: Found, count: number, origins: number) {
  const { trees } = found.output
  expect(trees).toHaveLength(origins)
  const distances = trees[0].distances.buffer
  const parents = trees[0].parents.buffer
  expect(distances).toBeInstanceOf(ArrayBuffer)
  expect(parents).toBeInstanceOf(ArrayBuffer)
  expect(distances).not.toBe(parents)
  expect(distances).not.toBe(memory.buffer)
  expect(parents).not.toBe(memory.buffer)
  expect(distances.byteLength).toBe(origins * count * 8)
  expect(parents.byteLength).toBe(origins * count * 4)
  trees.forEach((tree, index) => {
    expect(tree.distances).toBeInstanceOf(Float64Array)
    expect(tree.parents).toBeInstanceOf(Int32Array)
    expect(tree.distances.buffer).toBe(distances)
    expect(tree.parents.buffer).toBe(parents)
    expect(tree.distances.byteOffset).toBe(index * count * 8)
    expect(tree.parents.byteOffset).toBe(index * count * 4)
    expect(tree.distances).toHaveLength(count)
    expect(tree.parents).toHaveLength(count)
  })
  expect(found.transfer).toHaveLength(2)
  expect(new Set(found.transfer).size).toBe(2)
  expect(found.transfer).toContain(distances)
  expect(found.transfer).toContain(parents)
}

/**
 * One adapter find compared to the JS reference: exact bytes, ranking, contacts
 * and the flat-block layout.
 */
function checkFind(
  prepared: Prepared,
  reference: ReferenceSearch,
  network: MeetingNetwork,
  origins: number[],
  objective: Objective,
): Found {
  const found = prepared.find({ origins, objective })
  const expected = reference.find({ origins, objective })
  expectFlatBlocks(found, network.nodes.length, origins.length)
  expectSameOutput(found.output, expected, network, origins)
  return found
}

function rawGraph(count: number, edges: Edge[]): RawGraph {
  return new wasm.MeetingSearch(
    count,
    Uint32Array.from(edges.flatMap(([a, b]) => [a, b])),
    Float64Array.from(edges.map(([, , metres]) => metres)),
  )
}

function rawSolve(graph: RawGraph, origins: number[]) {
  const batch = graph.solve(Uint32Array.from(origins))
  try {
    return { distances: batch.take_distances(), parents: batch.take_parents() }
  } finally {
    batch.free()
  }
}

function expectRawMatches(
  graph: RawGraph,
  reference: ReferenceSearch,
  count: number,
  origins: number[],
) {
  const { distances, parents } = rawSolve(graph, origins)
  const expected = reference.find({ origins, objective: 'fair' }).trees
  expect(distances).toHaveLength(origins.length * count)
  expect(parents).toHaveLength(origins.length * count)
  expected.forEach((tree, row) => {
    const range: [number, number] = [row * count, (row + 1) * count]
    expect(firstDifference(distances.subarray(...range), tree.distances)).toBe(
      -1,
    )
    expect(firstDifference(parents.subarray(...range), tree.parents)).toBe(-1)
  })
}

// --- generated wasm-bindgen class ----------------------------------------

describe('generated MeetingSearch class', () => {
  it('moves each output out exactly once as an owned copy of the exact trees', () => {
    const graph = rawGraph(6, hand)
    const batch = graph.solve(Uint32Array.of(0, 4))
    try {
      const distances = batch.take_distances()
      expect(() => batch.take_distances()).toThrow()
      const parents = batch.take_parents()
      expect(() => batch.take_parents()).toThrow()

      expect(distances).toBeInstanceOf(Float64Array)
      expect(parents).toBeInstanceOf(Int32Array)
      expect(Array.from(distances)).toEqual([
        ...fromZero.distances,
        ...fromFour.distances,
      ])
      expect(Array.from(parents)).toEqual([
        ...fromZero.parents,
        ...fromFour.parents,
      ])
      // Two distinct buffers that exactly fit their contents and are not views
      // of WebAssembly memory.
      expect(distances.buffer).not.toBe(parents.buffer)
      expect(distances.byteOffset).toBe(0)
      expect(parents.byteOffset).toBe(0)
      expect(distances.buffer.byteLength).toBe(distances.byteLength)
      expect(parents.buffer.byteLength).toBe(parents.byteLength)
      expect(distances.buffer).not.toBe(memory.buffer)
      expect(parents.buffer).not.toBe(memory.buffer)
    } finally {
      batch.free()
      graph.free()
    }
  })

  it('lets either output be taken first and a rejected take leaves the other intact', () => {
    const graph = rawGraph(6, hand)
    const batch = graph.solve(Uint32Array.of(4, 0))
    try {
      const parents = batch.take_parents()
      expect(() => batch.take_parents()).toThrow()
      const distances = batch.take_distances()
      expect(Array.from(distances)).toEqual([
        ...fromFour.distances,
        ...fromZero.distances,
      ])
      expect(Array.from(parents)).toEqual([
        ...fromFour.parents,
        ...fromZero.parents,
      ])
      // A failed take is an ordinary error: the instance keeps working.
      expect(() => batch.take_distances()).toThrow()
    } finally {
      batch.free()
    }
    try {
      const again = rawSolve(graph, [0, 4])
      expect(Array.from(again.parents)).toEqual([
        ...fromZero.parents,
        ...fromFour.parents,
      ])
    } finally {
      graph.free()
    }
  })

  it('keeps taken outputs valid after the batch is freed, later solves and real memory.grow', () => {
    const graph = rawGraph(6, hand)
    try {
      const first = rawSolve(graph, [0, 4])
      const firstDistances = Array.from(first.distances)
      const before = memory.buffer.byteLength

      memory.grow(8)
      expect(memory.buffer.byteLength).toBe(before + 8 * WASM_PAGE)
      const second = rawSolve(graph, [5, 5, 0])
      expect(second.distances.buffer).not.toBe(first.distances.buffer)
      expect(second.parents.buffer).not.toBe(first.parents.buffer)

      // Mutating one owned result never reaches another.
      second.distances.fill(-7)
      second.parents.fill(99)
      expect(Array.from(first.distances)).toEqual(firstDistances)
      expect(Array.from(first.parents)).toEqual([
        ...fromZero.parents,
        ...fromFour.parents,
      ])
      const third = rawSolve(graph, [5, 5, 0])
      expect(Array.from(third.distances)).toEqual([
        ...fromFive.distances,
        ...fromFive.distances,
        ...fromZero.distances,
      ])
      expect(Array.from(third.parents)).toEqual([
        ...fromFive.parents,
        ...fromFive.parents,
        ...fromZero.parents,
      ])
    } finally {
      graph.free()
    }
  })

  it('reuses one graph for many differently sized solves, matching the JS reference bytes', () => {
    const count = 40
    const edges = randomEdges(11, count, 120, 0)
    const network = makeNetwork(count, edges)
    const reference = prepareReference(network)
    const graph = rawGraph(count, edges)
    try {
      const groups = [
        randomOrigins(1, count, 2),
        randomOrigins(2, count, 16),
        randomOrigins(3, count, 5),
        [3, 3, 3, 3],
        randomOrigins(4, count, 40),
        randomOrigins(5, count, 2),
      ]
      groups.forEach((origins, index) => {
        if (index === 3) memory.grow(1)
        expectRawMatches(graph, reference, count, origins)
      })
      // No arbitrary origin cap.
      expectRawMatches(graph, reference, count, randomOrigins(6, count, 1100))
    } finally {
      graph.free()
    }
  })

  it('handles graphs without edges, one node, zero loops and self loops', () => {
    for (const [count, edges] of [
      [3, []],
      [1, []],
      [1, [[0, 0, 0.5]]],
      [
        3,
        [
          [0, 1, 0],
          [1, 2, 0],
          [2, 0, 0],
          [1, 1, 0],
        ],
      ],
      [
        3,
        [
          [0, 0, 1],
          [0, 1, 2],
          [1, 1, 0],
          [1, 2, 2],
          [2, 2, 7],
        ],
      ],
    ] as [number, Edge[]][]) {
      const network = makeNetwork(count, edges)
      const reference = prepareReference(network)
      const graph = rawGraph(count, edges)
      try {
        expectRawMatches(graph, reference, count, [0, count - 1])
        expectRawMatches(graph, reference, count, [count - 1, 0, 0])
      } finally {
        graph.free()
      }
    }
  })

  it('reports invalid construction and origins as ordinary errors and keeps working', () => {
    const edges = Uint32Array.from([0, 1, 1, 2])
    const metres = Float64Array.from([1, 1])
    const faults: (() => unknown)[] = [
      () => new wasm.MeetingSearch(0, new Uint32Array(0), new Float64Array(0)),
      () =>
        new wasm.MeetingSearch(
          3,
          Uint32Array.from([0, 1, 2]),
          Float64Array.of(1),
        ),
      () => new wasm.MeetingSearch(3, edges, Float64Array.of(1)),
      () => new wasm.MeetingSearch(3, edges, Float64Array.of(1, 1, 1)),
      () => new wasm.MeetingSearch(3, Uint32Array.of(0, 3), Float64Array.of(1)),
      () => new wasm.MeetingSearch(3, Uint32Array.of(3, 0), Float64Array.of(1)),
      () =>
        new wasm.MeetingSearch(
          2 ** 32 - 1,
          new Uint32Array(0),
          new Float64Array(0),
        ),
      ...[-1, -1e-300, NaN, INF, -INF].map(
        (weight) => () =>
          new wasm.MeetingSearch(
            3,
            Uint32Array.of(0, 1),
            Float64Array.of(weight),
          ),
      ),
    ]
    const network = makeNetwork(3, [
      [0, 1, 1],
      [1, 2, 1],
    ])
    const reference = prepareReference(network)
    for (const construct of faults) {
      expect(construct).toThrow()
      const graph = new wasm.MeetingSearch(3, edges, metres)
      try {
        expectRawMatches(graph, reference, 3, [0, 2])
      } finally {
        graph.free()
      }
    }

    const graph = new wasm.MeetingSearch(3, edges, metres)
    try {
      const baseline = rawSolve(graph, [0, 2])
      const solveFaults: Uint32Array[] = [
        new Uint32Array(0),
        Uint32Array.of(1),
        Uint32Array.of(0, 3),
        Uint32Array.of(3, 0),
        Uint32Array.of(0, 2, 3),
        Uint32Array.of(0, 2 ** 32 - 1),
      ]
      for (const origins of solveFaults) {
        expect(() => graph.solve(origins)).toThrow()
        const again = rawSolve(graph, [0, 2])
        expect(firstDifference(again.distances, baseline.distances)).toBe(-1)
        expect(firstDifference(again.parents, baseline.parents)).toBe(-1)
      }
    } finally {
      graph.free()
    }
  })
})

// --- prepared adapter ----------------------------------------------------

describe('prepared meeting search adapter', () => {
  it('matches the JavaScript trees, ranking and contacts for both objectives', async () => {
    const network = makeNetwork(6, hand, [0, 1, 1, 2, 3, 4, 4])
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      for (const origins of [
        [0, 4],
        [0, 0, 4],
        [0, 5],
        [5, 5],
        [4, 0, 5],
      ])
        for (const objective of ['fair', 'total'] as const)
          checkFind(prepared, reference, network, origins, objective)

      const alternating = Array.from({ length: 16 }, (_, i) =>
        i % 2 === 0 ? 0 : 4,
      )
      const found = checkFind(prepared, reference, network, alternating, 'fair')
      expect(Array.from(found.output.trees[3].distances)).toEqual(
        fromFour.distances,
      )
      expect(found.output.results.map((result) => result.node)).toEqual([
        1, 2, 3, 0, 4,
      ])
    } finally {
      prepared.dispose()
    }
  })

  it('returns trees in request order for the hand-derived diamond', async () => {
    const prepared = await adapter.prepareMeetingSearch(handNetwork)
    try {
      const { output } = prepared.find({ origins: [0, 4], objective: 'fair' })
      expect(Array.from(output.trees[0].distances)).toEqual(fromZero.distances)
      expect(Array.from(output.trees[0].parents)).toEqual(fromZero.parents)
      expect(Array.from(output.trees[1].distances)).toEqual(fromFour.distances)
      expect(Array.from(output.trees[1].parents)).toEqual(fromFour.parents)
      expect(output.results.map((result) => result.node)).toEqual([
        1, 2, 3, 0, 4,
      ])
    } finally {
      prepared.dispose()
    }
  })

  it('exposes two owned flat blocks with row subarrays that transfer exactly once', async () => {
    const prepared = await adapter.prepareMeetingSearch(handNetwork)
    try {
      for (const size of [2, 3, 16, 17]) {
        const origins = Array.from({ length: size }, (_, i) => [0, 4, 5][i % 3])
        const found = prepared.find({ origins, objective: 'fair' })
        expectFlatBlocks(found, 6, size)
      }

      const origins = [0, 4, 5]
      const found = prepared.find({ origins, objective: 'total' })
      const expected = prepareReference(handNetwork).find({
        origins,
        objective: 'total',
      })
      // Rows are disjoint views of one block: writing one row leaves the others.
      const flat = new Float64Array(found.output.trees[0].distances.buffer)
      found.output.trees[0].distances[1] = -5
      expect(flat[1]).toBe(-5)
      expect(Array.from(found.output.trees[1].distances)).toEqual(
        fromFour.distances,
      )
      found.output.trees[0].distances[1] = 1
      expectSameTrees(found.output.trees, expected.trees)

      const moved = structuredClone(found.output.trees, {
        transfer: found.transfer,
      })
      for (const buffer of found.transfer) expect(buffer.byteLength).toBe(0)
      expectSameTrees(moved, expected.trees)

      // Transferring one result does not disturb the next.
      const later = checkFind(
        prepared,
        prepareReference(handNetwork),
        handNetwork,
        [0, 4],
        'fair',
      )
      for (const buffer of later.transfer)
        expect(buffer.byteLength).toBeGreaterThan(0)
    } finally {
      prepared.dispose()
    }
  })

  it('keeps earlier outputs independent and valid across later finds, growth and disposal', async () => {
    const network = makeNetwork(40, randomEdges(21, 40, 120, 1))
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    const firstOrigins = randomOrigins(31, 40, 4)
    const issued: Found[] = []
    try {
      const first = checkFind(
        prepared,
        reference,
        network,
        firstOrigins,
        'fair',
      )
      issued.push(first)
      const second = checkFind(
        prepared,
        reference,
        network,
        randomOrigins(32, 40, 16),
        'total',
      )
      for (const buffer of second.transfer)
        expect(first.transfer).not.toContain(buffer)

      second.output.trees[0].distances.fill(-1)
      second.output.trees[0].parents.fill(-9)
      memory.grow(32)
      checkFind(prepared, reference, network, randomOrigins(33, 40, 7), 'fair')
      expectSameOutput(
        first.output,
        reference.find({ origins: firstOrigins, objective: 'fair' }),
        network,
        firstOrigins,
      )
    } finally {
      prepared.dispose()
    }
    // The issued result outlives the prepared graph that produced it.
    expect(issued).toHaveLength(1)
    expectSameOutput(
      issued[0].output,
      reference.find({ origins: firstOrigins, objective: 'fair' }),
      network,
      firstOrigins,
    )
  })

  it('does not mutate its inputs and reads the static edges only once', async () => {
    const network = makeNetwork(6, hand)
    const pristine = structuredClone(network)
    const reference = prepareReference(pristine)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      for (const edge of network.edges) edge[2] = 1e6
      network.edges.length = 0
      const origins = [0, 4, 0]
      const snapshot = [...origins]
      const found = prepared.find({ origins, objective: 'fair' })
      expect(origins).toEqual(snapshot)
      expectSameOutput(
        found.output,
        reference.find({ origins, objective: 'fair' }),
        pristine,
        origins,
      )
    } finally {
      prepared.dispose()
    }
  })

  it('matches the reference on randomized graphs with ties, zero weights, loops and parallel edges', async () => {
    for (let seed = 0; seed < 24; seed++) {
      const next = rng(1000 + seed)
      const count = 1 + Math.floor(next() * 60)
      const kind = (seed % 4) as 0 | 1 | 2 | 3
      const edges = randomEdges(
        seed,
        count,
        Math.floor(next() * count * 4),
        kind,
      )
      const network = makeNetwork(count, edges)
      const reference = prepareReference(network)
      const prepared = await adapter.prepareMeetingSearch(network)
      try {
        for (let round = 0; round < 4; round++) {
          const size = 2 + Math.floor(next() * 19)
          const origins = randomOrigins(seed * 10 + round, count, size)
          checkFind(prepared, reference, network, origins, 'fair')
          checkFind(prepared, reference, network, origins, 'total')
        }
      } finally {
        prepared.dispose()
      }
    }
  })

  it('has no origin cap and keeps duplicate origins as separate rows', async () => {
    const count = 30
    const network = makeNetwork(count, randomEdges(41, count, 90, 0))
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      const origins = randomOrigins(42, count, 300)
      const found = checkFind(prepared, reference, network, origins, 'fair')
      const twinRow = origins.indexOf(origins[0], 1)
      expect(twinRow).toBeGreaterThan(0)
      expect(
        firstDifference(
          found.output.trees[0].distances,
          found.output.trees[twinRow].distances,
        ),
      ).toBe(-1)
    } finally {
      prepared.dispose()
    }
  })

  it('rejects invalid origins and keeps the session usable', async () => {
    const network = handNetwork
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      const baseline = checkFind(prepared, reference, network, [0, 4], 'fair')
      expect(() => prepared.find({ origins: [], objective: 'fair' })).toThrow()
      expect(() => prepared.find({ origins: [0], objective: 'fair' })).toThrow()

      const invalid: unknown[] = [
        -1,
        0.5,
        1.5,
        NaN,
        INF,
        -INF,
        6,
        7,
        // Values that would silently wrap or truncate when packed as uint32.
        2 ** 32,
        2 ** 32 + 1,
        -(2 ** 32) + 1,
        2 ** 53,
        '1',
        null,
        undefined,
        true,
        1n,
      ]
      for (const bad of invalid) {
        const value = bad as number
        for (const origins of [
          [0, value],
          [value, 1],
          [0, 1, value, 2],
        ])
          expect(() => prepared.find({ origins, objective: 'fair' })).toThrow()
        checkFind(prepared, reference, network, [0, 4], 'fair')
      }

      // A hole is a missing origin, not something to skip.
      const holey = new Array<number>(3)
      holey[0] = 0
      holey[2] = 4
      expect(() =>
        prepared.find({ origins: holey, objective: 'fair' }),
      ).toThrow()
      checkFind(prepared, reference, network, [0, 4], 'fair')

      expectSameOutput(
        baseline.output,
        reference.find({ origins: [0, 4], objective: 'fair' }),
        network,
        [0, 4],
      )
    } finally {
      prepared.dispose()
    }
  })

  it('rejects an invalid network before packing and later prepares still work', async () => {
    const bads: number[] = [-1, 0.5, 1.5, NaN, INF, 6, 2 ** 32, 2 ** 32 + 1]
    const networks: MeetingNetwork[] = [
      makeNetwork(0, []),
      ...bads.flatMap((bad) => [
        makeNetwork(6, [...hand, [bad, 1, 1]]),
        makeNetwork(6, [...hand, [0, bad, 1]]),
      ]),
      ...[-1, -Number.MIN_VALUE, NaN, INF, -INF].map((metres) =>
        makeNetwork(6, [...hand, [0, 5, metres]]),
      ),
    ]
    const reference = prepareReference(handNetwork)
    for (const network of networks) {
      await expect(adapter.prepareMeetingSearch(network)).rejects.toThrow()
      const prepared = await adapter.prepareMeetingSearch(handNetwork)
      try {
        checkFind(prepared, reference, handNetwork, [0, 4, 5], 'fair')
      } finally {
        prepared.dispose()
      }
    }
  })

  it('accepts zero-weight edges, self loops, parallel edges and edgeless graphs', async () => {
    const cases: [number, Edge[]][] = [
      [1, []],
      [4, []],
      [1, [[0, 0, 0]]],
      [
        4,
        [
          [0, 1, 0],
          [1, 2, 0],
          [2, 0, 0],
          [1, 1, 0],
          [2, 3, 1],
          [2, 3, 1],
          [3, 3, 5],
        ],
      ],
    ]
    for (const [count, edges] of cases) {
      const network = makeNetwork(count, edges)
      const reference = prepareReference(network)
      const prepared = await adapter.prepareMeetingSearch(network)
      try {
        for (const objective of ['fair', 'total'] as const) {
          checkFind(prepared, reference, network, [0, count - 1], objective)
          checkFind(prepared, reference, network, [count - 1, 0, 0], objective)
        }
      } finally {
        prepared.dispose()
      }
    }
  })

  it('observes real committed memory and survives memory.grow between and during finds', async () => {
    const count = 30_000
    const edges = randomEdges(51, count, 90_000, 2)
    const network = makeNetwork(count, edges, spacedPlaces(count))
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      expect(prepared.memoryBytes()).toBe(memory.buffer.byteLength)
      const small = checkFind(
        prepared,
        reference,
        network,
        randomOrigins(52, count, 2),
        'fair',
      )
      const settled = memory.buffer.byteLength
      expect(prepared.memoryBytes()).toBe(settled)

      memory.grow(64)
      expect(prepared.memoryBytes()).toBe(settled + 64 * WASM_PAGE)
      const wide = randomOrigins(53, count, 16)
      checkFind(prepared, reference, network, wide, 'total')
      expect(prepared.memoryBytes()).toBe(memory.buffer.byteLength)
      expect(prepared.memoryBytes()).toBeGreaterThanOrEqual(
        settled + 64 * WASM_PAGE,
      )

      memory.grow(256)
      checkFind(prepared, reference, network, wide, 'fair')
      expectSameOutput(
        small.output,
        reference.find({
          origins: randomOrigins(52, count, 2),
          objective: 'fair',
        }),
        network,
        randomOrigins(52, count, 2),
      )
    } finally {
      prepared.dispose()
    }
  }, 60_000)

  it('matches the reference on a tie-heavy grid and a large random graph', async () => {
    const grid = makeNetwork(
      120 * 120,
      gridEdges(120, 120),
      spacedPlaces(120 * 120),
    )
    const random = makeNetwork(
      20_000,
      randomEdges(61, 20_000, 60_000, 0),
      spacedPlaces(20_000),
    )
    for (const network of [grid, random]) {
      const count = network.nodes.length
      const reference = prepareReference(network)
      const prepared = await adapter.prepareMeetingSearch(network)
      try {
        for (const size of [2, 16]) {
          const origins = randomOrigins(62 + size, count, size)
          checkFind(prepared, reference, network, origins, 'fair')
          checkFind(prepared, reference, network, origins, 'total')
        }
        checkFind(
          prepared,
          reference,
          network,
          [0, count - 1, 0, count - 1],
          'fair',
        )
      } finally {
        prepared.dispose()
      }
    }
  }, 60_000)

  it('disposes idempotently, keeps issued outputs, and never disturbs other prepared graphs', async () => {
    const networkA = makeNetwork(40, randomEdges(71, 40, 100, 1))
    const networkB = makeNetwork(25, randomEdges(72, 25, 60, 3))
    const referenceA = prepareReference(networkA)
    const referenceB = prepareReference(networkB)
    const a = await adapter.prepareMeetingSearch(networkA)
    const b = await adapter.prepareMeetingSearch(networkB)
    const c = await adapter.prepareMeetingSearch(networkA)
    const originsA = randomOrigins(73, 40, 6)
    const outA = checkFind(a, referenceA, networkA, originsA, 'fair')
    checkFind(b, referenceB, networkB, randomOrigins(74, 25, 4), 'fair')

    a.dispose()
    expect(() => a.dispose()).not.toThrow()
    expect(() => a.find({ origins: originsA, objective: 'fair' })).toThrow()

    expectSameOutput(
      outA.output,
      referenceA.find({ origins: originsA, objective: 'fair' }),
      networkA,
      originsA,
    )
    // Same network prepared twice shares nothing; the survivors are unaffected.
    checkFind(c, referenceA, networkA, originsA, 'total')
    checkFind(b, referenceB, networkB, randomOrigins(75, 25, 9), 'total')
    c.dispose()
    checkFind(b, referenceB, networkB, randomOrigins(76, 25, 3), 'fair')
    b.dispose()
    b.dispose()

    const fresh = await adapter.prepareMeetingSearch(networkA)
    try {
      checkFind(fresh, referenceA, networkA, originsA, 'fair')
    } finally {
      fresh.dispose()
      fresh.dispose()
    }
  })

  it('releases native graph and result memory on disposal', async () => {
    const count = 20_000
    const network = makeNetwork(
      count,
      randomEdges(81, count, 60_000, 2),
      spacedPlaces(count),
    )
    const origins = randomOrigins(82, count, 16)
    const cycle = async () => {
      const prepared = await adapter.prepareMeetingSearch(network)
      try {
        prepared.find({ origins, objective: 'fair' })
      } finally {
        prepared.dispose()
      }
    }
    // Identical single-threaded cycles with explicit frees reach an allocator
    // fixed point; memory never shrinks, so any leak shows as further growth.
    for (let i = 0; i < 3; i++) await cycle()
    const settled = memory.buffer.byteLength
    for (let i = 0; i < 25; i++) await cycle()
    expect(memory.buffer.byteLength).toBe(settled)
  }, 60_000)
})

// --- real San Francisco network ----------------------------------------

describe('San Francisco and fixture networks', () => {
  const load = (path: string) =>
    parseNetwork(
      JSON.parse(
        readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'),
      ),
    )

  it('reproduces complete trees, rankings and contacts for 4 and 16 origins under both objectives', async () => {
    const sf = load('../../public/lab/meeting-point/sf.json')
    const landmarks = sfRegion.landmarks.map(({ coordinate }) =>
      nearestNode(sf, coordinate),
    )
    const groups: number[][] = [
      landmarks.slice(0, 4),
      landmarks.slice(0, 16),
      // Duplicate starts still count as separate people.
      [landmarks[0], landmarks[0], ...landmarks.slice(1, 4)],
    ]
    const reference = prepareReference(sf)
    const prepared = await adapter.prepareMeetingSearch(sf)
    try {
      const issued: {
        found: Found
        origins: number[]
        objective: Objective
      }[] = []
      for (const origins of groups)
        for (const objective of ['fair', 'total'] as const) {
          const expected = reference.find({ origins, objective })
          expect(expected.results.length).toBeGreaterThan(0)
          const found = prepared.find({ origins, objective })
          expectFlatBlocks(found, sf.nodes.length, origins.length)
          expectSameOutput(found.output, expected, sf, origins)
          issued.push({ found, origins, objective })
        }

      // The cached opposite objective reranks the same trees without changing them.
      const fair = issued[2].found
      const rerank = rankMeetingResults({
        network: sf,
        trees: fair.output.trees,
        objective: 'total',
      })
      expect(rerank).toEqual(
        reference.find({ origins: groups[1], objective: 'total' }).results,
      )

      // Earlier outputs are untouched by every later solve.
      for (const { found, origins, objective } of issued)
        expectSameOutput(
          found.output,
          reference.find({ origins, objective }),
          sf,
          origins,
        )
    } finally {
      prepared.dispose()
    }
  }, 120_000)

  it('reproduces the West Oakland fixture for many random groups', async () => {
    const network = load(
      '../../scripts/meeting-bench/fixtures/west-oakland.json',
    )
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      const count = network.nodes.length
      for (let round = 0; round < 40; round++) {
        const origins = randomOrigins(900 + round, count, 2 + (round % 15))
        checkFind(prepared, reference, network, origins, 'fair')
        checkFind(prepared, reference, network, origins, 'total')
      }
    } finally {
      prepared.dispose()
    }
  })
})

// --- bounded wasm32 capacity transition (keep last: memory never shrinks) -----

describe('wasm32 capacity error', () => {
  // 1100 origins over 250000 nodes need 275 million f64 results: 2.2 GB, more than
  // isize::MAX on wasm32. The reservation fails before any physical allocation.
  const COUNT = 250_000
  const OVERSIZED = 1100
  const SAFE_MEMORY = 2 ** 31

  it('rejects the oversized solve on the raw class, then solves two origins', () => {
    const graph = new wasm.MeetingSearch(
      COUNT,
      new Uint32Array(0),
      new Float64Array(0),
    )
    try {
      expect(() => graph.solve(new Uint32Array(OVERSIZED))).toThrow()
      expect(memory.buffer.byteLength).toBeLessThan(SAFE_MEMORY)

      const { distances, parents } = rawSolve(graph, [7, 249_999])
      expect(distances).toHaveLength(2 * COUNT)
      expect(parents).toHaveLength(2 * COUNT)
      expect(
        distances.every((value, index) =>
          index === 7 || index === COUNT + 249_999
            ? value === 0
            : value === INF,
        ),
      ).toBe(true)
      expect(parents.every((value) => value === -1)).toBe(true)
    } finally {
      graph.free()
    }
  })

  it('reports the same failure through the adapter as an ordinary error and recovers', async () => {
    const network = makeNetwork(COUNT, [], [7, 249_999])
    const reference = prepareReference(network)
    const prepared = await adapter.prepareMeetingSearch(network)
    try {
      const oversized = new Array<number>(OVERSIZED).fill(7)
      expect(() =>
        prepared.find({ origins: oversized, objective: 'fair' }),
      ).toThrow()
      expect(prepared.memoryBytes()).toBeLessThan(SAFE_MEMORY)
      // The failure is repeatable and does not poison the session or module.
      expect(() =>
        prepared.find({ origins: oversized, objective: 'total' }),
      ).toThrow()

      const found = checkFind(prepared, reference, network, [7, 7], 'fair')
      expect(found.output.results).toEqual([
        {
          node: 7,
          name: 'Place 7',
          distances: [0, 0],
          longest: 0,
          total: 0,
        },
      ])
      checkFind(prepared, reference, network, [249_999, 7], 'total')
    } finally {
      prepared.dispose()
    }
  }, 60_000)
})
