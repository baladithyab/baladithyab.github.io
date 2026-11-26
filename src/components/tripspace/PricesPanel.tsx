import { useState } from 'react'
import {
  BedDouble,
  ChevronDown,
  ExternalLink,
  Plane,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  TrendingDown,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { addWatch, removeWatch, setWatchTarget } from '@/lib/tripspace/actions'
import { formatRange, isIsoDate, nightsOf } from '@/lib/tripspace/dates'
import {
  chosenOption,
  watchReport,
  type Trip,
  type WatchInsight,
} from '@/lib/tripspace/model'
import type { SearchRequest } from '@/lib/tripspace/search'

import { PriceHistoryChart } from './Charts'
import {
  Busy,
  Field,
  inputClass,
  money,
  Notice,
  People,
  Segmented,
  SignalBadge,
} from './parts'
import type { PanelProps } from './types'

const newId = () => crypto.randomUUID()

type Filter = 'all' | 'alerts' | 'flights' | 'hotels' | 'booked'

function requestText(request: SearchRequest): string {
  switch (request.kind) {
    case 'flights':
      return `${request.from.join('/')} to ${request.to.join('/')}, ${request.return ? formatRange(request.depart, request.return) : request.depart}, ${request.adults + request.children} ${request.adults + request.children === 1 ? 'seat' : 'seats'}`
    case 'anywhere':
      return `Anywhere from ${request.from}`
    case 'hotels':
      return `${request.city}, ${formatRange(request.checkin, request.checkout)}, ${request.rooms} ${request.rooms === 1 ? 'room' : 'rooms'} for ${request.adults}`
    default: {
      const exhaustive: never = request
      return exhaustive
    }
  }
}

function AddWatchForm({
  trip,
  onAdd,
  onClose,
}: {
  trip: Trip
  onAdd: (payload: {
    label: string
    request: SearchRequest
    targetMinor: number | null
  }) => void
  onClose: () => void
}) {
  const option = chosenOption(trip) ?? trip.options[0] ?? null
  const [kind, setKind] = useState<'flights' | 'hotels'>('flights')
  const [from, setFrom] = useState('SFO')
  const [to, setTo] = useState(option?.destination ?? 'LIS')
  const [city, setCity] = useState(option?.city ?? 'Lisbon, Portugal')
  const [start, setStart] = useState(option?.depart ?? '2027-05-10')
  const [end, setEnd] = useState(option?.return ?? '2027-05-17')
  const [adults, setAdults] = useState('1')
  const [rooms, setRooms] = useState('1')
  const [target, setTarget] = useState('')

  const fromOk = /^[A-Z]{3}$/.test(from)
  const toOk = /^[A-Z]{3}$/.test(to)
  const datesOk = isIsoDate(start) && isIsoDate(end) && end > start
  const adultsNum = Math.min(9, Math.max(1, Math.round(Number(adults) || 1)))
  const roomsNum = Math.min(9, Math.max(1, Math.round(Number(rooms) || 1)))
  const targetNum = Number(target)
  const targetMinor =
    target.trim() !== '' && Number.isFinite(targetNum) && targetNum > 0
      ? Math.round(targetNum * 100)
      : null
  const ready =
    datesOk && (kind === 'flights' ? fromOk && toOk : city.trim().length >= 2)

  return (
    <form
      className="bg-card space-y-4 rounded-lg border p-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        if (kind === 'flights') {
          onAdd({
            label: `${from} to ${to} (${adultsNum} ${adultsNum === 1 ? 'seat' : 'seats'})`,
            request: {
              kind: 'flights',
              from: [from],
              to: [to],
              depart: start,
              return: end,
              adults: adultsNum,
              children: 0,
            },
            targetMinor,
          })
        } else {
          onAdd({
            label: `Hotels in ${city.trim()}`,
            request: {
              kind: 'hotels',
              city: city.trim(),
              checkin: start,
              checkout: end,
              adults: adultsNum,
              rooms: roomsNum,
            },
            targetMinor,
          })
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">Watch a flight or hotel</h3>
          <p className="text-muted-foreground text-xs">
            Runs a live Skiplagged search immediately and starts recording its
            price history.
          </p>
        </div>
        <Segmented
          label="Watch type"
          options={[
            { value: 'flights' as const, label: 'Flight route' },
            { value: 'hotels' as const, label: 'Hotel stay' },
          ]}
          value={kind}
          onChange={setKind}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-6">
        {kind === 'flights' ? (
          <>
            <Field label="From (IATA)">
              <input
                className={inputClass}
                value={from}
                onChange={(e) =>
                  setFrom(e.target.value.toUpperCase().slice(0, 3))
                }
                placeholder="SFO"
                autoCapitalize="characters"
              />
            </Field>
            <Field label="To (IATA)">
              <input
                className={inputClass}
                value={to}
                onChange={(e) =>
                  setTo(e.target.value.toUpperCase().slice(0, 3))
                }
                placeholder="LIS"
                autoCapitalize="characters"
              />
            </Field>
          </>
        ) : (
          <div className="@4xl:col-span-2">
            <Field label="City">
              <input
                className={inputClass}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Lisbon, Portugal"
              />
            </Field>
          </div>
        )}

        <Field label={kind === 'flights' ? 'Depart' : 'Check-in'}>
          <input
            type="date"
            className={inputClass}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label={kind === 'flights' ? 'Return' : 'Check-out'}>
          <input
            type="date"
            className={inputClass}
            value={end}
            min={start || undefined}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
        <Field label={kind === 'flights' ? 'Travellers' : 'Rooms'}>
          <input
            type="number"
            min={1}
            max={9}
            className={inputClass}
            value={kind === 'flights' ? adults : rooms}
            onChange={(e) =>
              kind === 'flights'
                ? setAdults(e.target.value)
                : setRooms(e.target.value)
            }
          />
        </Field>
        <Field
          label={kind === 'flights' ? 'Alert below ($)' : 'Alert below ($/nt)'}
        >
          <input
            inputMode="decimal"
            className={inputClass}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Optional"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          <Plus aria-hidden /> Start watching and search live
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function WatchCard({
  trip,
  entry,
  busy,
  onCheck,
  onSetTarget,
  onRemove,
}: {
  trip: Trip
  entry: WatchInsight
  busy: boolean
  onCheck: () => void
  onSetTarget: (targetMinor: number | null) => void
  onRemove: (() => void) | null
}) {
  const { watch, primaryItem } = entry
  const [editingTarget, setEditingTarget] = useState(false)
  const [targetInput, setTargetInput] = useState(
    entry.targetMinor !== null
      ? String(Math.round(entry.targetMinor / 100))
      : '',
  )
  const [showOffers, setShowOffers] = useState(false)
  const Icon = watch.request.kind === 'hotels' ? BedDouble : Plane
  const suffix = entry.unit === 'nightly' ? '/night' : ''
  const positive =
    entry.signal === 'drop_alert' ||
    entry.signal === 'at_target' ||
    entry.signal === 'down'

  // Paid reference line in the same unit as the chart (nightly for stays, total for flights).
  const paidRefMinor = (() => {
    if (entry.paidMinor === null) return null
    if (
      entry.unit === 'nightly' &&
      primaryItem?.detail.kind === 'stay' &&
      primaryItem.startDate &&
      primaryItem.endDate
    ) {
      const denom =
        primaryItem.detail.rooms *
        Math.max(1, nightsOf(primaryItem.startDate, primaryItem.endDate).length)
      return Math.round(entry.paidMinor / denom)
    }
    return entry.paidMinor
  })()

  const offers = watch.offers.slice(0, 4)

  return (
    <li className="bg-card flex flex-col justify-between gap-4 rounded-lg border p-5">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="size-4 shrink-0" aria-hidden />
              <h3 className="leading-snug font-semibold">
                {primaryItem?.title ?? watch.label}
              </h3>
            </div>
            <p className="text-muted-foreground text-xs">
              {requestText(watch.request)}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <SignalBadge entry={entry} />
              {primaryItem?.status === 'booked' ? (
                <span className="bg-muted text-foreground/80 rounded-full px-2 py-0.5 text-xs font-medium">
                  Booked
                </span>
              ) : primaryItem?.status === 'chosen' ? (
                <span className="bg-muted text-foreground/80 rounded-full px-2 py-0.5 text-xs">
                  Chosen
                </span>
              ) : watch.standalone ? (
                <span className="bg-muted text-foreground/80 rounded-full px-2 py-0.5 text-xs">
                  Custom watch
                </span>
              ) : null}
              {watch.sample ? (
                <span className="text-muted-foreground text-xs">
                  Sample history
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {busy ? (
              <Busy>Checking</Busy>
            ) : (
              <Button size="sm" variant="outline" onClick={onCheck}>
                <RefreshCw aria-hidden /> Check now
              </Button>
            )}
            {onRemove ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove watch ${watch.label}`}
                onClick={onRemove}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>

        {watch.error ? <Notice tone="error">{watch.error}</Notice> : null}

        {/* Primary figures strip */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-muted-foreground text-xs">
              {primaryItem && entry.series !== watch.cheapest
                ? 'Tracked offer now'
                : 'Cheapest now'}
            </p>
            <p className="text-3xl font-semibold tracking-tight tabular-nums">
              {entry.currentMinor === null
                ? 'None'
                : `${money(entry.currentMinor)}${suffix}`}
            </p>
            <p className="text-muted-foreground text-xs">
              {watch.checkedAt === null
                ? 'Never checked yet.'
                : `Checked ${new Date(watch.checkedAt).toLocaleString()}`}
            </p>
          </div>

          <div className="flex flex-wrap gap-5 text-right text-xs tabular-nums">
            {entry.deltaMinor !== null ? (
              <div>
                <p className="text-muted-foreground">Since first check</p>
                <p className="text-sm font-semibold">
                  {entry.deltaMinor === 0
                    ? 'No change'
                    : `${entry.deltaMinor < 0 ? '-' : '+'}${money(Math.abs(entry.deltaMinor))}${entry.deltaPct !== null ? ` (${entry.deltaPct > 0 ? '+' : ''}${entry.deltaPct}%)` : ''}`}
                </p>
              </div>
            ) : null}
            {entry.paidMinor !== null ? (
              <div>
                <p className="text-muted-foreground">Paid total</p>
                <p className="text-sm font-semibold">
                  {money(entry.paidMinor)}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <PriceHistoryChart
          series={entry.series}
          label={primaryItem?.title ?? watch.label}
          unit={entry.unit}
          paidRefMinor={paidRefMinor}
          targetMinor={entry.targetMinor}
          positive={positive}
        />

        {/* Drop capture callout when a booked item is undercut */}
        {entry.dropBelowPaidMinor > 0 &&
        entry.paidMinor !== null &&
        entry.comparableCurrentTotalMinor !== null &&
        primaryItem ? (
          <Notice tone="info">
            <p className="text-foreground font-semibold">
              {money(entry.dropBelowPaidMinor)} under the{' '}
              {money(entry.paidMinor)} paid with{' '}
              {primaryItem.booking?.soldBy ?? 'provider'} (now{' '}
              {money(entry.comparableCurrentTotalMinor)}).
            </p>
            <p className="text-foreground/80">
              Many airlines and refundable hotels reprice for a travel credit or
              refund when the exact fare drops. Check{' '}
              {primaryItem.booking?.soldBy ?? 'the seller'}'s change rules
              before modifying your booking.
            </p>
          </Notice>
        ) : null}

        {entry.items.length > 0 ? (
          <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>
              Linked to{' '}
              <People
                trip={trip}
                memberIds={[
                  ...new Set(
                    entry.items.flatMap((i) =>
                      i.participants.map((p) => p.memberId),
                    ),
                  ),
                ]}
              />
            </span>
          </div>
        ) : null}
      </div>

      {/* Footer: Target price alert + live offers toggle */}
      <div className="space-y-3 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {editingTarget ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                const parsed = Number(targetInput)
                onSetTarget(
                  targetInput.trim() === ''
                    ? null
                    : Number.isFinite(parsed) && parsed > 0
                      ? Math.round(parsed * 100)
                      : entry.targetMinor,
                )
                setEditingTarget(false)
              }}
            >
              <label className="sr-only" htmlFor={`target-${watch.id}`}>
                Alert target price in USD
              </label>
              <input
                id={`target-${watch.id}`}
                inputMode="decimal"
                className="border-input bg-background h-8 w-28 rounded-md border px-2 text-xs tabular-nums"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="USD"
                autoFocus
              />
              <Button type="submit" size="sm" variant="secondary">
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditingTarget(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTargetInput(
                  entry.targetMinor !== null
                    ? String(Math.round(entry.targetMinor / 100))
                    : '',
                )
                setEditingTarget(true)
              }}
              className="text-foreground/80 hover:text-foreground focus-visible:ring-ring inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 focus-visible:ring-2 focus-visible:outline-none"
            >
              <Target className="size-3.5 shrink-0" aria-hidden />
              {entry.targetMinor !== null
                ? `Alert target: ${money(entry.targetMinor)}${suffix}`
                : 'Set alert target'}
            </button>
          )}

          {offers.length > 0 ? (
            <button
              type="button"
              aria-expanded={showOffers}
              onClick={() => setShowOffers((v) => !v)}
              className="text-foreground/80 hover:text-foreground focus-visible:ring-ring inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 focus-visible:ring-2 focus-visible:outline-none"
            >
              {offers.length} {offers.length === 1 ? 'offer' : 'offers'}
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform',
                  showOffers && 'rotate-180',
                )}
                aria-hidden
              />
            </button>
          ) : null}
        </div>

        {showOffers && offers.length > 0 ? (
          <ul className="bg-muted/30 divide-y rounded-md border text-xs">
            {offers.map((offer) => (
              <li
                key={offer.key}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <span className="min-w-0 truncate">
                  {offer.kind === 'flight'
                    ? `${offer.outbound.airlines} (${offer.outbound.stops === 0 ? 'nonstop' : `${offer.outbound.stops} stop`}, ${offer.outbound.duration})`
                    : offer.kind === 'hotel'
                      ? `${offer.name}${offer.location ? `, ${offer.location}` : ''}`
                      : offer.city}
                </span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  <span className="font-semibold">
                    {offer.kind === 'hotel'
                      ? `${money(offer.nightlyMinor)}/nt`
                      : money(offer.priceMinor)}
                  </span>
                  <a
                    href={offer.link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open on Skiplagged"
                    className="text-foreground/75 hover:text-foreground inline-flex size-7 items-center justify-center rounded-sm"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  )
}

export default function PricesPanel({
  trip,
  update,
  runWatches,
  busyWatches,
}: PanelProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)
  const report = watchReport(trip)
  const anyBusy = report.entries.some((e) => busyWatches.has(e.watch.id))
  const hasSamples = report.entries.some((e) => e.watch.sample)
  const lastCheck = report.entries
    .map((e) => e.watch.checkedAt)
    .filter((t): t is number => t !== null)
    .sort((a, b) => b - a)[0]

  const filtered = report.entries.filter((entry) => {
    switch (filter) {
      case 'all':
        return true
      case 'alerts':
        return entry.signal === 'drop_alert' || entry.signal === 'at_target'
      case 'flights':
        return entry.watch.request.kind === 'flights'
      case 'hotels':
        return entry.watch.request.kind === 'hotels'
      case 'booked':
        return entry.primaryItem?.status === 'booked'
      default: {
        const exhaustive: never = filter
        return exhaustive
      }
    }
  })

  const bookedPct =
    report.estimatedTotalMinor > 0
      ? Math.min(
          100,
          Math.round(
            (report.bookedTotalMinor / report.estimatedTotalMinor) * 100,
          ),
        )
      : 0

  return (
    <div className="space-y-8">
      {/* Band 1: Asymmetric 7 / 5 Price Monitor Lead + Telemetry */}
      <div className="grid grid-cols-1 gap-6 @5xl:grid-cols-12 @5xl:items-start">
        <section
          aria-labelledby="monitor-lead"
          className="bg-card flex flex-col justify-between gap-5 rounded-lg border p-6 @5xl:col-span-7"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <p
                id="monitor-lead"
                className="text-muted-foreground text-xs font-medium tracking-widest uppercase"
              >
                {report.potentialSavingsMinor > 0
                  ? 'Drop savings detected'
                  : 'Tracked trip spend'}
              </p>
              <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                {report.potentialSavingsMinor > 0
                  ? money(report.potentialSavingsMinor)
                  : money(report.estimatedTotalMinor)}
              </p>
              <p className="text-muted-foreground text-sm">
                {report.potentialSavingsMinor > 0
                  ? `Across ${report.dropsCount} booked ${report.dropsCount === 1 ? 'item' : 'items'} undercut below what you paid.`
                  : report.activeCount > 0
                    ? `Across ${report.activeCount} active ${report.activeCount === 1 ? 'watch' : 'watches'}.`
                    : 'Add any route or hotel below to start watching live fares.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {report.entries.length > 0 ? (
                <Button
                  disabled={anyBusy}
                  onClick={() =>
                    void runWatches(report.entries.map((e) => e.watch))
                  }
                >
                  <RefreshCw
                    className={cn(anyBusy && 'animate-spin')}
                    aria-hidden
                  />
                  Check all live
                </Button>
              ) : null}
              <Button
                variant={report.entries.length === 0 ? 'default' : 'outline'}
                aria-expanded={adding}
                onClick={() => setAdding((v) => !v)}
              >
                <Plus aria-hidden /> Watch route or hotel
              </Button>
            </div>
          </div>

          <p className="text-muted-foreground border-t pt-3 text-xs leading-relaxed">
            Checks query Skiplagged live on demand when you press Check.
            {hasSamples
              ? ' Seeded sample watches show example history until you press Check now.'
              : ''}{' '}
            Background scheduled checks require the Worker backend in the design
            doc.
          </p>
        </section>

        <section
          aria-label="Monitor telemetry"
          className="bg-card flex flex-col justify-between gap-4 rounded-lg border p-6 @5xl:col-span-5"
        >
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Active watches</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {report.activeCount}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Drops and target hits
              </dt>
              <dd className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
                {report.alertsCount > 0 ? (
                  <TrendingDown
                    className="text-chart-2 size-5 shrink-0"
                    aria-hidden
                  />
                ) : null}
                {report.alertsCount}
              </dd>
            </div>
          </dl>

          <div className="space-y-1.5">
            <div className="flex justify-between gap-2 text-xs tabular-nums">
              <span className="text-muted-foreground">Booked vs estimated</span>
              <span className="font-medium">
                {money(report.bookedTotalMinor)} /{' '}
                {money(report.estimatedTotalMinor)} ({bookedPct}%)
              </span>
            </div>
            <div
              className="bg-muted h-2 overflow-hidden rounded-full"
              aria-hidden
            >
              <div
                className="bg-chart-2 h-full rounded-full"
                style={{ width: `${bookedPct}%` }}
              />
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            {lastCheck
              ? `Last reading: ${new Date(lastCheck).toLocaleString()}`
              : 'No checks run yet.'}
          </p>
        </section>
      </div>

      {adding ? (
        <AddWatchForm
          trip={trip}
          onClose={() => setAdding(false)}
          onAdd={({ label, request, targetMinor }) => {
            const added = addWatch(trip, { label, request, targetMinor, newId })
            const created = added.trip.watches.find(
              (w) => w.id === added.watchId,
            )
            update(
              (t) =>
                addWatch(t, {
                  label,
                  request,
                  targetMinor,
                  newId: () => added.watchId,
                }).trip,
            )
            setAdding(false)
            if (created) void runWatches([created])
          }}
        />
      ) : null}

      {/* Band 2: Filter Bar + Watch Cards */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Filter watches"
            options={[
              { value: 'all' as const, label: `All (${report.activeCount})` },
              {
                value: 'alerts' as const,
                label: `Alerts (${report.alertsCount})`,
              },
              {
                value: 'flights' as const,
                label: `Flights (${report.entries.filter((e) => e.watch.request.kind === 'flights').length})`,
              },
              {
                value: 'hotels' as const,
                label: `Hotels (${report.entries.filter((e) => e.watch.request.kind === 'hotels').length})`,
              },
              {
                value: 'booked' as const,
                label: `Booked (${report.entries.filter((e) => e.primaryItem?.status === 'booked').length})`,
              },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </div>

        {filtered.length === 0 ? (
          <div className="bg-card space-y-3 rounded-lg border p-6 text-sm">
            <p className="font-medium">
              {report.activeCount === 0
                ? 'Nothing is being watched yet.'
                : 'No watches match this filter.'}
            </p>
            <p className="text-muted-foreground">
              {report.activeCount === 0
                ? 'Add a flight route or hotel stay above, or push a shortlist option from Coordinator.'
                : 'Switch to All to see every active watch.'}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-5 @5xl:grid-cols-2 @5xl:items-start @min-[115rem]:grid-cols-3">
            {filtered.map((entry) => (
              <WatchCard
                key={entry.watch.id}
                trip={trip}
                entry={entry}
                busy={busyWatches.has(entry.watch.id)}
                onCheck={() => void runWatches([entry.watch])}
                onSetTarget={(targetMinor) =>
                  update((t) => setWatchTarget(t, entry.watch.id, targetMinor))
                }
                onRemove={
                  entry.items.length === 0
                    ? () => update((t) => removeWatch(t, entry.watch.id))
                    : null
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
