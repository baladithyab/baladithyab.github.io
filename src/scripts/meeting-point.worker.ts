import { loadMeetingNetwork } from '@/lib/meeting-network-loader'
import { findSearchCollisions } from '@/lib/meeting-collisions'
import { MAX_PEOPLE, placePerson } from '@/lib/meeting-area'
import {
  nearestNode,
  prepareMeetingSearch,
  type Coordinate,
  type MeetingSearch,
  type MeetingNetwork,
} from '@/lib/meeting-point'
import type {
  Landmark,
  MeetingSessionReply,
  MeetingSessionRequest,
} from '@/lib/meeting-session'

// The loaded graph is retained here so searches never send it across threads again.
let prepared: { network: MeetingNetwork; search: MeetingSearch } | null = null

const post = (reply: MeetingSessionReply, transfer: Transferable[] = []) =>
  self.postMessage(reply, { transfer })
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

function parseStarts(value: unknown): Landmark[] {
  const invalid = new Error(
    'The starting locations could not be read. Choose them again, then load the area.',
  )
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) throw invalid
  return value.map((start: unknown) => {
    if (
      typeof start !== 'object' ||
      start === null ||
      !('name' in start) ||
      typeof start.name !== 'string' ||
      !start.name.trim() ||
      !('coordinate' in start) ||
      !Array.isArray(start.coordinate) ||
      start.coordinate.length !== 2 ||
      !start.coordinate.every(
        (part: unknown) => typeof part === 'number' && Number.isFinite(part),
      )
    )
      throw invalid
    const coordinate: Coordinate = [start.coordinate[0], start.coordinate[1]]
    return { name: start.name.trim(), coordinate }
  })
}

self.onmessage = (event: MessageEvent<MeetingSessionRequest>) => {
  const data = event.data
  if (data.kind === 'load') {
    prepared = null
    void (async () => {
      try {
        const people = parseStarts(data.starts)
        const { network, delivery } = await loadMeetingNetwork(
          data.request,
          (message) => post({ kind: 'progress', message }),
        )
        post({
          kind: 'progress',
          message: people.length
            ? 'Preparing search data and placing everyone on the paths…'
            : 'Preparing search data and saved landmarks…',
        })
        const landmarks = data.landmarks.map(({ name, coordinate }) => ({
          name,
          node: nearestNode(network, coordinate),
        }))
        const starts = people.map(({ name, coordinate }) => ({
          name,
          node: placePerson(network, coordinate),
        }))
        prepared = { network, search: prepareMeetingSearch(network) }
        post({ kind: 'ready', network, landmarks, starts, delivery })
      } catch (error) {
        post({
          kind: 'error',
          id: null,
          message: messageOf(error, 'The walking network could not be loaded.'),
        })
      }
    })()
  } else if (data.kind === 'attach') {
    prepared = null
    try {
      prepared = {
        network: data.network,
        search: prepareMeetingSearch(data.network),
      }
    } catch (error) {
      post({
        kind: 'error',
        id: null,
        message: messageOf(error, 'The walking network could not be prepared.'),
      })
    }
  } else {
    try {
      if (!prepared) throw new Error('The walking network is not ready.')
      const output = prepared.search.find(data)
      const collisions = findSearchCollisions({
        network: prepared.network,
        trees: output.trees,
        origins: data.origins,
      })
      post(
        { kind: 'result', id: data.id, output, collisions },
        output.trees.flatMap((tree) => [
          tree.distances.buffer,
          tree.parents.buffer,
        ]),
      )
    } catch (error) {
      post({
        kind: 'error',
        id: data.id,
        message: messageOf(error, 'The road search failed.'),
      })
    }
  }
}
