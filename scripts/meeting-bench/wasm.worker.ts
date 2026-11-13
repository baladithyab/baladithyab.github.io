import { loadMeetingNetwork } from '../../src/lib/meeting-network-loader'
import { findSearchCollisions } from '../../src/lib/meeting-collisions'
import { nearestNode, type MeetingNetwork } from '../../src/lib/meeting-point'
import {
  prepareMeetingSearch,
  type PreparedMeetingSearch,
} from '../../src/lib/meeting-search'
import type {
  MeetingSessionReply,
  MeetingSessionRequest,
} from '../../src/lib/meeting-session'

// Standalone protocol implementation: importing the production worker here would
// recurse when the UI benchmark replaces that module with this candidate.
let prepared: {
  network: MeetingNetwork
  search: PreparedMeetingSearch
} | null = null
let terminalError: WebAssembly.RuntimeError | null = null
const post = (reply: MeetingSessionReply, transfer: ArrayBuffer[] = []) =>
  self.postMessage(reply, { transfer })

function disposePrepared(): void {
  const owned = prepared
  prepared = null
  owned?.search.dispose()
}

async function handle(data: MeetingSessionRequest): Promise<void> {
  try {
    if (terminalError) throw terminalError
    if (data.kind === 'load') {
      disposePrepared()
      const { network, delivery } = await loadMeetingNetwork(
        data.request,
        (message) => post({ kind: 'progress', message }),
      )
      post({
        kind: 'progress',
        message: 'Preparing search data and saved landmarks…',
      })
      const landmarks = data.landmarks.map(({ name, coordinate }) => ({
        name,
        node: nearestNode(network, coordinate),
      }))
      prepared = { network, search: await prepareMeetingSearch(network) }
      post({ kind: 'ready', network, landmarks, delivery })
    } else if (data.kind === 'attach') {
      disposePrepared()
      prepared = {
        network: data.network,
        search: await prepareMeetingSearch(data.network),
      }
      // The production restart protocol has no attach acknowledgement.
    } else {
      if (!prepared) throw new Error('The walking network is not ready.')
      const { output, transfer } = prepared.search.find(data)
      const collisionStart =
        import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
      const collisions = findSearchCollisions({
        network: prepared.network,
        trees: output.trees,
        origins: data.origins,
      })
      if (import.meta.env?.MODE === 'meeting-benchmark')
        performance.measure('meeting:wasm:collisions', {
          start: collisionStart,
          detail: { origins: data.origins.length },
        })
      const transferStart =
        import.meta.env?.MODE === 'meeting-benchmark' ? performance.now() : 0
      const distancesBytesBefore =
        import.meta.env?.MODE === 'meeting-benchmark'
          ? transfer[0].byteLength
          : 0
      const parentsBytesBefore =
        import.meta.env?.MODE === 'meeting-benchmark'
          ? transfer[1].byteLength
          : 0
      post({ kind: 'result', id: data.id, output, collisions }, transfer)
      if (import.meta.env?.MODE === 'meeting-benchmark')
        performance.measure('meeting:wasm:transfer', {
          start: transferStart,
          detail: {
            outputBytes: distancesBytesBefore + parentsBytesBefore,
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
    }
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError && !terminalError)
      terminalError = error
    post({
      kind: 'error',
      id: data.kind === 'search' ? data.id : null,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

// One FIFO covers complete load/attach/search handlers, including async boot and
// fetch. Each handler reports its error and resolves; ordinary failures cannot
// poison the queue or let an immediately following attach/search overtake boot.
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<MeetingSessionRequest>) => {
  queue = queue.then(() => handle(event.data))
}
