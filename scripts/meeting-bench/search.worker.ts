import {
  prepareMeetingSearch,
  type MeetingNetwork,
  type MeetingSearch,
  type Objective,
  type SearchOutput,
} from '../../src/lib/meeting-point'
import {
  findSearchCollisions,
  type SearchCollision,
} from '../../src/lib/meeting-collisions'
import { prepareScalarSearch } from './scalar-search'
import type { PreparedMeetingSearch } from '../../src/lib/meeting-search'

export type Engine = 'current' | 'scalar' | 'wasm'
export type Request =
  | { kind: 'init'; id: number; engine: Engine; network: MeetingNetwork }
  | { kind: 'search'; id: number; origins: number[]; objective: Objective }
  | { kind: 'fail-init'; id: number }
export type Result = {
  kind: 'result'
  id: number
  output: SearchOutput
  collisions: SearchCollision[]
  searchIncludingRankMs: number
  collisionsMs: number
  exportTransferListMs: number
  uniqueOutputBytes: number
  uniqueOutputBuffers: number
  wasmMemoryBytes?: number
}
export type Reply =
  | { kind: 'boot' }
  | {
      kind: 'ready'
      id: number
      preparationMs: number
      network: MeetingNetwork
    }
  | Result
  | {
      kind: 'delivery'
      id: number
      postMessageMs: number
      detached: boolean | null
    }
  | { kind: 'error'; id: number; message: string }

type Prepared =
  | { kind: 'js'; network: MeetingNetwork; search: MeetingSearch }
  | { kind: 'wasm'; network: MeetingNetwork; search: PreparedMeetingSearch }
let prepared: Prepared | null = null
let terminalError: WebAssembly.RuntimeError | null = null

function disposePrepared(): void {
  const owned = prepared
  prepared = null
  if (owned?.kind === 'wasm') owned.search.dispose()
}
const post = (reply: Reply, transfer: ArrayBuffer[] = []) =>
  self.postMessage(reply, { transfer })

// Only the selected WASM engine imports/boots its bindings. JS-only workers keep
// their cold startup free of WASM fetch, compilation and initialization.
async function handle(request: Request): Promise<void> {
  try {
    if (terminalError) throw terminalError
    if (request.kind === 'fail-init') {
      disposePrepared()
      throw new Error('Deliberate benchmark initialization failure')
    }
    if (request.kind === 'init') {
      disposePrepared()
      const start = performance.now()
      if (request.engine === 'wasm') {
        const { prepareMeetingSearch: prepareWasm } =
          await import('../../src/lib/meeting-search')
        prepared = {
          kind: 'wasm',
          network: request.network,
          search: await prepareWasm(request.network),
        }
      } else {
        prepared = {
          kind: 'js',
          network: request.network,
          search:
            request.engine === 'current'
              ? prepareMeetingSearch(request.network)
              : prepareScalarSearch(request.network),
        }
      }
      const preparationMs = performance.now() - start
      // Like production load/ready, the graph is cloned back, never transferred.
      const postStart = performance.now()
      post({
        kind: 'ready',
        id: request.id,
        network: request.network,
        preparationMs,
      })
      post({
        kind: 'delivery',
        id: request.id,
        postMessageMs: performance.now() - postStart,
        detached: null,
      })
      return
    }
    if (!prepared) throw new Error('The walking network is not ready.')
    const searchStart = performance.now()
    let output: SearchOutput
    let ownedTransfer: ArrayBuffer[] | null = null
    if (prepared.kind === 'wasm') {
      const found = prepared.search.find(request)
      output = found.output
      ownedTransfer = found.transfer
    } else {
      output = prepared.search.find(request)
    }
    const searchIncludingRankMs = performance.now() - searchStart
    const collisionStart = performance.now()
    const collisions = findSearchCollisions({
      network: prepared.network,
      trees: output.trees,
      origins: request.origins,
    })
    const collisionsMs = performance.now() - collisionStart
    if (
      import.meta.env?.MODE === 'meeting-benchmark' &&
      prepared.kind === 'wasm'
    )
      performance.measure('meeting:wasm:collisions', {
        start: collisionStart,
        detail: { origins: request.origins.length },
      })
    const exportStart = performance.now()
    let transfer: ArrayBuffer[]
    if (ownedTransfer) {
      transfer = ownedTransfer
    } else {
      const buffers = new Set<ArrayBuffer>()
      for (const tree of output.trees) {
        for (const view of [tree.distances, tree.parents]) {
          if (!(view.buffer instanceof ArrayBuffer))
            throw new Error(
              'Search outputs must own transferable ArrayBuffers.',
            )
          buffers.add(view.buffer)
        }
      }
      transfer = [...buffers]
    }
    const uniqueOutputBytes = transfer.reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    )
    const exportTransferListMs = performance.now() - exportStart
    const reply: Result = {
      kind: 'result',
      id: request.id,
      output,
      collisions,
      searchIncludingRankMs,
      collisionsMs,
      exportTransferListMs,
      uniqueOutputBytes,
      uniqueOutputBuffers: transfer.length,
      ...(prepared.kind === 'wasm'
        ? { wasmMemoryBytes: prepared.search.memoryBytes() }
        : {}),
    }
    const distancesBytesBefore =
      import.meta.env?.MODE === 'meeting-benchmark' && prepared.kind === 'wasm'
        ? transfer[0].byteLength
        : 0
    const parentsBytesBefore =
      import.meta.env?.MODE === 'meeting-benchmark' && prepared.kind === 'wasm'
        ? transfer[1].byteLength
        : 0
    const postStart = performance.now()
    post(reply, transfer)
    const postMessageMs = performance.now() - postStart
    if (
      import.meta.env?.MODE === 'meeting-benchmark' &&
      prepared.kind === 'wasm'
    )
      performance.measure('meeting:wasm:transfer', {
        start: postStart,
        detail: {
          outputBytes: uniqueOutputBytes,
          distancesBytesBefore,
          parentsBytesBefore,
          distancesBytesAfter: transfer[0].byteLength,
          parentsBytesAfter: transfer[1].byteLength,
          buffersBefore: transfer.length,
          buffersAfter: transfer.filter((buffer) => buffer.byteLength > 0)
            .length,
          memoryBytes: prepared.search.memoryBytes(),
        },
      })
    post({
      kind: 'delivery',
      id: request.id,
      postMessageMs,
      detached: transfer.every((buffer) => buffer.byteLength === 0),
    })
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError && !terminalError)
      terminalError = error
    post({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<Request>) => {
  queue = queue.then(() => handle(event.data))
}
post({ kind: 'boot' })
