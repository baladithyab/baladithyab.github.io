import type {
  Coordinate,
  MeetingNetwork,
  Objective,
  SearchOutput,
} from './meeting-point'
import type { NetworkDelivery, NetworkRequest } from './meeting-network-loader'
import type { SearchCollision } from './meeting-collisions'

export type Landmark = { name: string; coordinate: Coordinate }

/**
 * Messages to the retained meeting-point worker. `load` fetches and prepares a
 * network in the worker. `attach` is only the restart path after a busy worker was
 * terminated: it prepares an already validated main-thread graph, has no success
 * reply and completes before the next queued message runs.
 */
export type MeetingSessionRequest =
  | { kind: 'load'; request: NetworkRequest; landmarks: Landmark[] }
  | { kind: 'attach'; network: MeetingNetwork }
  | { kind: 'search'; id: number; origins: number[]; objective: Objective }

export type MeetingSessionReply =
  | { kind: 'progress'; message: string }
  | {
      kind: 'ready'
      network: MeetingNetwork
      landmarks: { name: string; node: number }[]
      delivery: NetworkDelivery
    }
  | {
      kind: 'result'
      id: number
      output: SearchOutput
      collisions: SearchCollision[]
    }
  | { kind: 'error'; id: number | null; message: string }
