import init, {
  MeetingSearch,
  type SearchBatch,
} from '../../crates/meeting-point/pkg/meeting_point.js'
import {
  rankMeetingResults,
  type MeetingNetwork,
  type Objective,
  type SearchOutput,
  type SearchTree,
} from './meeting-point'

/** Private prototype seam; the production worker still uses the JS engine. */
export type PreparedMeetingSearch = {
  find(request: { origins: number[]; objective: Objective }): {
    output: SearchOutput
    transfer: ArrayBuffer[]
  }
  dispose(): void
  memoryBytes(): number
}

type NativeOwner = MeetingSearch | SearchBatch
let terminalError: WebAssembly.RuntimeError | null = null
// On a trap, retain EVERY owned wrapper for the lifetime of this realm. Merely
// skipping free() would let generated FinalizationRegistry callbacks enter WASM.
const owners = new Set<NativeOwner>()

function recordFailure(error: unknown): void {
  if (error instanceof WebAssembly.RuntimeError && !terminalError)
    terminalError = error
}

function release(owner: NativeOwner): void {
  if (terminalError) return
  try {
    owner.free()
    owners.delete(owner)
  } catch (error) {
    recordFailure(error)
    throw error
  }
}

type BootOutcome =
  | { kind: 'ready'; memory: WebAssembly.Memory }
  | { kind: 'error'; error: unknown }

// Starts at module evaluation, overlapping the protocol worker's graph fetch.
// This promise NEVER rejects: an early failure remains observable by every
// prepare call, without an unhandled rejection, hidden retry or JS fallback.
const boot: Promise<BootOutcome> = (async () => {
  const start =
    import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
  try {
    const { memory } = await init()
    if (import.meta.env?.MODE === 'meeting-benchmark')
      performance.measure('meeting:wasm:boot', {
        start,
        detail: { memoryBytes: memory.buffer.byteLength },
      })
    return { kind: 'ready', memory }
  } catch (error) {
    recordFailure(error)
    return { kind: 'error', error }
  }
})()

/** Packs a validated graph once; each find returns two independent owned blocks. */
export async function prepareMeetingSearch(
  network: MeetingNetwork,
): Promise<PreparedMeetingSearch> {
  const outcome = await boot
  if (terminalError) throw terminalError
  if (outcome.kind === 'error') throw outcome.error
  const { memory } = outcome
  const start =
    import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
  const count = network.nodes.length
  if (!Number.isInteger(count) || count < 1 || count > 0x80000000)
    throw new Error('Invalid walking-network node count.')
  // Validate before Uint32 conversion: negatives, fractions and 2**32 must not
  // silently become valid endpoints. Zero-edge/isolated-node graphs are valid.
  for (const [from, to, weight] of network.edges) {
    if (
      !Number.isInteger(from) ||
      from < 0 ||
      from >= count ||
      !Number.isInteger(to) ||
      to < 0 ||
      to >= count
    )
      throw new Error('A road endpoint is outside the network.')
    if (!Number.isFinite(weight) || weight < 0)
      throw new Error('A road distance must be finite and nonnegative.')
  }
  const pairs = new Uint32Array(network.edges.length * 2)
  const weights = new Float64Array(network.edges.length)
  for (let i = 0; i < network.edges.length; i++) {
    const [from, to, weight] = network.edges[i]
    pairs[i * 2] = from
    pairs[i * 2 + 1] = to
    weights[i] = weight
  }
  let graph: MeetingSearch | null
  try {
    graph = new MeetingSearch(count, pairs, weights)
    owners.add(graph)
  } catch (error) {
    recordFailure(error)
    throw error
  }
  if (import.meta.env?.MODE === 'meeting-benchmark')
    performance.measure('meeting:wasm:prepare', {
      start,
      detail: { graphNodes: count, memoryBytes: memory.buffer.byteLength },
    })

  return {
    find({ origins, objective }) {
      if (terminalError) throw terminalError
      if (!graph) throw new Error('The walking-network search was disposed.')
      if (origins.length < 2)
        throw new Error('Choose at least two starting locations.')
      // for-of visits holes as undefined; Array.some would silently skip them.
      for (const origin of origins)
        if (!Number.isInteger(origin) || origin < 0 || origin >= count)
          throw new Error('A starting location is outside the network.')
      let batch: SearchBatch | null = null
      let distances: Float64Array
      let parents: Int32Array
      try {
        const solveStart =
          import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
        batch = graph.solve(new Uint32Array(origins))
        owners.add(batch)
        if (import.meta.env?.MODE === 'meeting-benchmark')
          performance.measure('meeting:wasm:solve', {
            start: solveStart,
            detail: {
              origins: origins.length,
              memoryBytes: memory.buffer.byteLength,
            },
          })
        const takeStart =
          import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
        try {
          distances = batch.take_distances()
          parents = batch.take_parents()
        } catch (error) {
          // Mark a trap BEFORE finally: neither batch nor graph may be freed.
          recordFailure(error)
          throw error
        } finally {
          const owned = batch
          batch = null
          release(owned)
        }
        if (import.meta.env?.MODE === 'meeting-benchmark')
          performance.measure('meeting:wasm:take', {
            start: takeStart,
            detail: {
              outputBytes: distances.byteLength + parents.byteLength,
              memoryBytes: memory.buffer.byteLength,
            },
          })
      } catch (error) {
        recordFailure(error)
        throw error
      } finally {
        // Also covers an error between solve and the consuming-take region.
        const owned = batch
        batch = null
        if (owned) release(owned)
      }
      if (
        !(distances.buffer instanceof ArrayBuffer) ||
        !(parents.buffer instanceof ArrayBuffer) ||
        distances.buffer === parents.buffer ||
        distances.buffer === memory.buffer ||
        parents.buffer === memory.buffer
      )
        throw new Error(
          'Search outputs must own two transferable ArrayBuffers.',
        )
      const trees: SearchTree[] = []
      for (let i = 0; i < origins.length; i++) {
        const offset = i * count
        trees.push({
          distances: distances.subarray(offset, offset + count),
          parents: parents.subarray(offset, offset + count),
        })
      }
      const rankStart =
        import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
      const results = rankMeetingResults({ network, trees, objective })
      if (import.meta.env?.MODE === 'meeting-benchmark')
        performance.measure('meeting:wasm:rank', {
          start: rankStart,
          detail: { origins: origins.length },
        })
      return {
        output: { trees, results },
        transfer: [distances.buffer, parents.buffer],
      }
    },
    dispose() {
      const owned = graph
      graph = null
      if (owned) release(owned)
    },
    memoryBytes() {
      if (terminalError) throw terminalError
      return memory.buffer.byteLength
    },
  }
}
