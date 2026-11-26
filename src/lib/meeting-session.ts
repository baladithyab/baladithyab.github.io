import type {
  Coordinate,
  MeetingNetwork,
  Objective,
  SearchOutput,
} from './meeting-point'
import type { NetworkDelivery, NetworkRequest } from './meeting-network-loader'
import type { SearchCollision } from './meeting-collisions'

export type Landmark = { name: string; coordinate: Coordinate }
/** A person's start; `node` is null when they could not be placed on the network. */
export type PlacedStart = { name: string; node: number | null }

/**
 * Messages to the retained meeting-point worker. `load` fetches and prepares a
 * network in the worker. Its `landmarks` always snap to their nearest node;
 * its `starts` (people, in order) are placed only inside the loaded bounds and
 * within 200 m of a connected path. `attach` is only the restart path after a
 * busy worker was terminated: it prepares an already validated main-thread
 * graph, has no success reply and completes before the next queued message runs.
 */
export type MeetingSessionRequest =
  | {
      kind: 'load'
      request: NetworkRequest
      landmarks: Landmark[]
      starts: Landmark[]
    }
  | { kind: 'attach'; network: MeetingNetwork }
  | { kind: 'search'; id: number; origins: number[]; objective: Objective }

export type MeetingSessionReply =
  | { kind: 'progress'; message: string }
  | {
      kind: 'ready'
      network: MeetingNetwork
      landmarks: { name: string; node: number }[]
      starts: PlacedStart[]
      delivery: NetworkDelivery
    }
  | {
      kind: 'result'
      id: number
      output: SearchOutput
      collisions: SearchCollision[]
    }
  | { kind: 'error'; id: number | null; message: string }
