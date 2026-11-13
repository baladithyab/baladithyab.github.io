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

export type Engine = 'current' | 'scalar'
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

let prepared: { network: MeetingNetwork; search: MeetingSearch } | null = null
const post = (reply: Reply, transfer: ArrayBuffer[] = []) =>
  self.postMessage(reply, { transfer })

// Both engines expose the same synchronous contract. CSR is prepared only at init.
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    if (request.kind === 'fail-init') {
      prepared = null
      throw new Error('Deliberate benchmark initialization failure')
    }
    if (request.kind === 'init') {
      prepared = null
      const start = performance.now()
      const search =
        request.engine === 'current'
          ? prepareMeetingSearch(request.network)
          : prepareScalarSearch(request.network)
      const preparationMs = performance.now() - start
      prepared = { network: request.network, search }
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
    const output = prepared.search.find(request)
    const searchIncludingRankMs = performance.now() - searchStart
    const collisionStart = performance.now()
    const collisions = findSearchCollisions({
      network: prepared.network,
      trees: output.trees,
      origins: request.origins,
    })
    const collisionsMs = performance.now() - collisionStart
    const exportStart = performance.now()
    const buffers = new Set<ArrayBuffer>()
    for (const tree of output.trees) {
      for (const view of [tree.distances, tree.parents]) {
        if (!(view.buffer instanceof ArrayBuffer))
          throw new Error('Search outputs must own transferable ArrayBuffers.')
        buffers.add(view.buffer)
      }
    }
    const transfer = [...buffers]
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
    }
    const postStart = performance.now()
    post(reply, transfer)
    const postMessageMs = performance.now() - postStart
    post({
      kind: 'delivery',
      id: request.id,
      postMessageMs,
      detached: transfer.every((buffer) => buffer.byteLength === 0),
    })
  } catch (error) {
    post({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
post({ kind: 'boot' })
