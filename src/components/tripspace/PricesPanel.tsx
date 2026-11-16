import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatRange } from '@/lib/tripspace/dates'
import { latest, matchKey, type Observation, type Trip, type Watch } from '@/lib/tripspace/model'
import type { SearchRequest } from '@/lib/tripspace/search'

import { Busy, money, Notice, People, Section } from './parts'
import type { PanelProps } from './types'

function requestText(request: SearchRequest): string {
  switch (request.kind) {
    case 'flights':
      return `Flights ${request.from.join('/')} to ${request.to.join('/')}, ${request.return ? formatRange(request.depart, request.return) : request.depart}, ${request.adults + request.children} ${request.adults + request.children === 1 ? 'seat' : 'seats'}`
    case 'anywhere':
      return `Anywhere from ${request.from}`
    case 'hotels':
      return `Hotels in ${request.city}, ${formatRange(request.checkin, request.checkout)}, ${request.rooms} ${request.rooms === 1 ? 'room' : 'rooms'} for ${request.adults}, price per room per night`
    default: {
      const exhaustive: never = request
      return exhaustive
    }
  }
}

/** A step chart of a run-length-encoded series. Gaps are checks where nothing matched. */
function StepChart({ series, label }: { series: Observation[]; label: string }) {
  const priced = series.filter((o): o is Observation & { priceMinor: number } => o.priceMinor !== null)
  if (priced.length === 0) return null
  const width = 280
  const height = 56
  const t0 = series[0]?.firstSeen ?? 0
  const t1 = Math.max(series.at(-1)?.lastSeen ?? t0, t0 + 1)
  const prices = priced.map((o) => o.priceMinor)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const x = (t: number) => ((t - t0) / (t1 - t0)) * (width - 8) + 4
  const y = (p: number) => (hi === lo ? height / 2 : height - 6 - ((p - lo) / (hi - lo)) * (height - 12))
  const path = priced.map((o) => `M${x(o.firstSeen).toFixed(1)},${y(o.priceMinor).toFixed(1)}H${Math.max(x(o.lastSeen), x(o.firstSeen) + 2).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="text-foreground h-14 w-full max-w-xs" role="img" aria-label={`${label}: from ${money(lo)} to ${money(hi)} over ${series.length} price runs`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function WatchCard({ trip, watch, busy, onCheck }: { trip: Trip; watch: Watch; busy: boolean; onCheck: () => void }) {
  const items = trip.items.filter((i) => i.watchId === watch.id && i.status !== 'dropped')
  const cheapest = latest(watch.cheapest)
  const changes = watch.cheapest.length - 1
  return (
    <li className="bg-card space-y-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="font-semibold">{watch.label}</h3>
          <p className="text-muted-foreground text-sm">{requestText(watch.request)}</p>
        </div>
        {busy ? (
          <Busy>Checking</Busy>
        ) : (
          <Button size="sm" variant="outline" onClick={onCheck}>
            <RefreshCw aria-hidden /> Check now
          </Button>
        )}
      </div>
      {watch.error ? <Notice tone="error">{watch.error}</Notice> : null}
      {watch.checkedAt === null ? (
        <p className="text-muted-foreground text-sm">Not searched yet.</p>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-muted-foreground text-xs">Cheapest now</p>
            <p className="text-3xl font-semibold tabular-nums">{cheapest === null ? 'none' : money(cheapest)}</p>
            <p className="text-muted-foreground text-xs">
              Last checked {new Date(watch.checkedAt).toLocaleString()}.{' '}
              {changes === 0 ? 'No change since the first search.' : `Changed ${changes} ${changes === 1 ? 'time' : 'times'} since the first search.`}
            </p>
          </div>
          <StepChart series={watch.cheapest} label="Cheapest price" />
        </div>
      )}
      {items
        .filter((i) => matchKey(i) !== null)
        .map((item) => {
          const key = matchKey(item) ?? ''
          const series = watch.tracked[key] ?? []
          const now = latest(series)
          const first = series[0]?.priceMinor ?? null
          const paid = item.status === 'booked' ? item.paidMinor : null
          const nowTotal = now !== null && item.detail.kind === 'flight' ? now : null
          return (
            <div key={item.id} className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                <span className="font-medium">{item.title}</span>, for <People trip={trip} memberIds={item.participants.map((p) => p.memberId)} />
              </p>
              <p className="text-muted-foreground">
                {now === null ? 'Not found at the last check, so the choice may be sold out.' : `Now ${money(now)}`}
                {first !== null && now !== null && first !== now ? `, was ${money(first)} when chosen` : ''}
                {item.detail.kind === 'stay' ? ' a night' : ''}.
              </p>
              {paid !== null && nowTotal !== null && nowTotal < paid ? (
                <Notice tone="info">
                  <p className="text-foreground font-medium">
                    {money(paid - nowTotal)} under the {money(paid)} paid with {item.booking?.soldBy}.
                  </p>
                  <p>
                    No capture policy is on file for {item.booking?.soldBy} yet. Some airlines reprice a booked ticket for a credit when the same flight gets cheaper; check its
                    change rules before rebooking anything.
                  </p>
                </Notice>
              ) : null}
            </div>
          )
        })}
    </li>
  )
}

export default function PricesPanel({ trip, runWatches, busyWatches }: PanelProps) {
  const used = new Set(trip.items.filter((i) => i.status !== 'dropped').map((i) => i.watchId))
  const watches = trip.watches.filter((w) => used.has(w.id))
  return (
    <Section
      title="Prices"
      description="Every slot is a saved search. Each search is recorded here, so you can see whether the price is moving."
      action={
        watches.length > 0 ? (
          <Button variant="outline" disabled={watches.some((w) => busyWatches.has(w.id))} onClick={() => void runWatches(watches)}>
            <RefreshCw aria-hidden /> Check all now
          </Button>
        ) : null
      }
    >
      <Notice tone="info">
        In this prototype a price is only checked when someone presses a search button. Checking on a schedule while nobody has the page open needs the backend in the design,
        which is not built yet.
      </Notice>
      {watches.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing is being watched. Slots created on the Plan tab show up here.</p>
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2">
          {watches.map((watch) => (
            <WatchCard key={watch.id} trip={trip} watch={watch} busy={busyWatches.has(watch.id)} onCheck={() => void runWatches([watch])} />
          ))}
        </ul>
      )}
    </Section>
  )
}
