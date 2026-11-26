import type { Member, Trip, Watch } from '@/lib/tripspace/model'

export type Tab = 'dashboard' | 'planner' | 'coordinator' | 'prices'

export type PanelProps = {
  trip: Trip
  /** The member this browser is acting as. */
  me: Member
  update: (change: (trip: Trip) => Trip) => void
  go: (tab: Tab) => void
  /** Switch which member this browser answers as. */
  actAs: (memberId: string) => void
  /** Run these watches' searches and record each result on the trip. */
  runWatches: (watches: Pick<Watch, 'id' | 'request'>[]) => Promise<void>
  busyWatches: ReadonlySet<string>
}
