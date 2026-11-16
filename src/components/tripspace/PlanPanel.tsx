import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  ExternalLink,
  Plane,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  applyGaps,
  chooseOffer,
  fitStayToArrivals,
  markBooked,
  setItemStatus,
} from '@/lib/tripspace/actions'
import {
  formatDay,
  formatRange,
  localDateOf,
  localTimeOf,
  nightsOf,
} from '@/lib/tripspace/dates'
import {
  arrivals,
  chosenOption,
  costByMember,
  findGaps,
  findIssues,
  going,
  itemCost,
  latest,
  matchKey,
  unusedNights,
  type Gap,
  type Issue,
  type Item,
  type Trip,
  type TripOption,
} from '@/lib/tripspace/model'
import type { FlightOffer, HotelOffer, Leg } from '@/lib/tripspace/search'

import Timeline from './Timeline'
import {
  Busy,
  Field,
  inputClass,
  money,
  Notice,
  People,
  Person,
  Section,
} from './parts'
import type { PanelProps } from './types'

const newId = () => crypto.randomUUID()

const TAG_LABEL: Record<string, string> = {
  'virtual-interline': 'self-transfer',
  'hidden-city': 'hidden city',
}

function legText(leg: Leg): string {
  const stops =
    leg.stops === 0
      ? 'nonstop'
      : `${leg.stops} ${leg.stops === 1 ? 'stop' : 'stops'}`
  return `${leg.from} ${formatDay(localDateOf(leg.departs))} ${localTimeOf(leg.departs)}, lands ${leg.to} ${formatDay(localDateOf(leg.arrives))} ${localTimeOf(leg.arrives)}. ${leg.duration}, ${stops}, ${leg.airlines}.`
}

function FlightSummary({ offer }: { offer: FlightOffer }) {
  const tags = offer.tags
    .map((t) => TAG_LABEL[t])
    .filter((t): t is string => t !== undefined)
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="text-muted-foreground">Out: </span>
        {legText(offer.outbound)}
      </p>
      {offer.inbound ? (
        <p>
          <span className="text-muted-foreground">Back: </span>
          {legText(offer.inbound)}
        </p>
      ) : null}
      {tags.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Includes {tags.join(' and ')} segments. Check the connection rules
          before booking.
        </p>
      ) : null}
    </div>
  )
}

function HotelSummary({ offer, item }: { offer: HotelOffer; item: Item }) {
  const nights =
    item.startDate && item.endDate
      ? nightsOf(item.startDate, item.endDate).length
      : 0
  const rooms = item.detail.kind === 'stay' ? item.detail.rooms : 1
  return (
    <p className="text-sm">
      {offer.stars ? `${offer.stars} stars, ` : ''}
      {offer.location ? `${offer.location}. ` : ''}
      {money(offer.nightlyMinor)} a night for one room; {rooms}{' '}
      {rooms === 1 ? 'room' : 'rooms'} for {nights} nights is{' '}
      {money(offer.nightlyMinor * rooms * nights)}.
    </p>
  )
}

function gapText(trip: Trip, gap: Gap) {
  return gap.kind === 'no_flight' ? (
    <>
      <Plane className="size-4 shrink-0" aria-hidden /> Flight from{' '}
      {gap.from.join(', ')} to {gap.to.join(', ')},{' '}
      {formatRange(gap.depart, gap.return)}, for{' '}
      <People trip={trip} memberIds={gap.memberIds} />
    </>
  ) : (
    <>
      <BedDouble className="size-4 shrink-0" aria-hidden /> Somewhere to stay in{' '}
      {gap.city}, {formatRange(gap.checkin, gap.checkout)}, for{' '}
      <People trip={trip} memberIds={gap.memberIds} />
    </>
  )
}

function BookForm({
  item,
  onBook,
}: {
  item: Item
  onBook: (paidMinor: number, soldBy: string) => void
}) {
  const [paid, setPaid] = useState(() => {
    const offerPrice =
      item.detail.kind === 'flight' ? item.detail.offer?.priceMinor : undefined
    return offerPrice ? String(Math.round(offerPrice / 100)) : ''
  })
  const [soldBy, setSoldBy] = useState('')
  const amount = Number(paid)
  const ready =
    Number.isFinite(amount) && amount > 0 && soldBy.trim().length > 0
  return (
    <form
      className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onBook(Math.round(amount * 100), soldBy.trim())
      }}
    >
      <Field label="Price paid, USD">
        <input
          className={inputClass}
          inputMode="decimal"
          value={paid}
          onChange={(e) => setPaid(e.target.value)}
        />
      </Field>
      <Field label="Booked with" hint="The airline, agency or hotel.">
        <input
          className={inputClass}
          value={soldBy}
          onChange={(e) => setSoldBy(e.target.value)}
          placeholder="United"
          maxLength={60}
        />
      </Field>
      <Button type="submit" disabled={!ready}>
        Mark booked
      </Button>
    </form>
  )
}

function TravelItem({
  trip,
  me,
  item,
  option,
  update,
  runWatches,
  busyWatches,
}: Omit<PanelProps, 'go'> & { item: Item; option: TripOption }) {
  const [booking, setBooking] = useState(false)
  const watch = trip.watches.find((w) => w.id === item.watchId)
  const busy = watch ? busyWatches.has(watch.id) : false
  const key = matchKey(item)
  const nowPrice = key && watch ? latest(watch.tracked[key]) : null
  const Icon = item.detail.kind === 'flight' ? Plane : BedDouble
  const offers = (watch?.offers ?? [])
    .filter(
      (o): o is FlightOffer | HotelOffer =>
        o.kind === (item.detail.kind === 'flight' ? 'flight' : 'hotel'),
    )
    .slice(0, 5)
  const cost = itemCost(trip, item)
  const unused =
    item.detail.kind === 'stay'
      ? item.participants
          .filter((p) => unusedNights(trip, option, item, p).length > 0)
          .map((p) => p.memberId)
      : []
  const fit = () => {
    // Compute once from what is on screen, then put that one item and watch into the latest trip.
    const result = fitStayToArrivals(trip, item.id, newId)
    const fitted = result.trip.items.find((i) => i.id === item.id)
    if (!fitted) return
    const added = result.watch
    update((t) => ({
      ...t,
      items: t.items.map((i) => (i.id === item.id ? fitted : i)),
      watches:
        added && !t.watches.some((w) => w.id === added.id)
          ? [...t.watches, added]
          : t.watches,
    }))
    if (added && added.checkedAt === null) void runWatches([added])
  }

  return (
    <li className="bg-card space-y-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-2 font-semibold">
            <Icon className="size-4 shrink-0" aria-hidden /> {item.title}
          </h3>
          <p className="text-muted-foreground text-sm">
            {item.startDate && item.endDate
              ? formatRange(item.startDate, item.endDate)
              : ''}
            , for{' '}
            <People
              trip={trip}
              memberIds={item.participants.map((p) => p.memberId)}
            />
            {item.leadMemberId ? (
              <>
                . Booking: <Person trip={trip} memberId={item.leadMemberId} />
              </>
            ) : null}
          </p>
        </div>
        <span className="rounded-full border px-2.5 py-0.5 text-xs">
          {item.status === 'open'
            ? 'Choosing'
            : item.status === 'chosen'
              ? 'Chosen, not booked'
              : 'Booked'}
        </span>
      </div>

      {unused.length > 0 ? (
        <Notice tone="info">
          <p>
            <People trip={trip} memberIds={unused} />{' '}
            {unused.length === 1 ? 'is' : 'are'} booked in for nights before
            arriving or after leaving.
            {item.status === 'open'
              ? ' Fitting the stay changes its dates and searches again.'
              : ' Fitting gives each person their own nights, so they are not charged for empty ones.'}
          </p>
          <Button size="sm" variant="outline" onClick={fit}>
            Fit to arrivals
          </Button>
        </Notice>
      ) : null}
      {item.status === 'open' ? (
        <div className="space-y-3">
          {busy ? (
            <Busy>Searching Skiplagged. This takes a few seconds.</Busy>
          ) : null}
          {watch?.error ? <Notice tone="error">{watch.error}</Notice> : null}
          {!busy &&
          watch &&
          watch.checkedAt !== null &&
          offers.length === 0 &&
          !watch.error ? (
            <p className="text-muted-foreground text-sm">
              The last search found nothing for these dates.
            </p>
          ) : null}
          {offers.length > 0 ? (
            <ol className="divide-y rounded-md border">
              {offers.map((offer) => (
                <li
                  key={offer.key}
                  className="flex flex-wrap items-start justify-between gap-3 p-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium">
                      {offer.kind === 'flight'
                        ? money(offer.priceMinor)
                        : offer.name}
                      {offer.kind === 'flight' ? (
                        <span className="text-muted-foreground font-normal">
                          {' '}
                          total for this party
                        </span>
                      ) : null}
                    </p>
                    {offer.kind === 'flight' ? (
                      <FlightSummary offer={offer} />
                    ) : (
                      <HotelSummary offer={offer} item={item} />
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" asChild>
                      <a href={offer.link} target="_blank" rel="noreferrer">
                        <ExternalLink aria-hidden />{' '}
                        <span className="sr-only">Open on Skiplagged</span>
                      </a>
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        update((t) =>
                          chooseOffer(t, item.id, offer, {
                            by: me.id,
                            now: Date.now(),
                          }),
                        )
                      }
                    >
                      Choose
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {watch ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void runWatches([watch])}
            >
              <RefreshCw aria-hidden />{' '}
              {watch.checkedAt === null ? 'Search' : 'Search again'}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {item.detail.kind === 'flight' && item.detail.offer ? (
            <FlightSummary offer={item.detail.offer} />
          ) : null}
          {item.detail.kind === 'stay' && item.detail.hotel ? (
            <>
              <p className="font-medium">{item.detail.hotel.name}</p>
              <HotelSummary offer={item.detail.hotel} item={item} />
            </>
          ) : null}
          <p className="text-sm">
            {item.status === 'booked' && item.paidMinor !== null ? (
              <>
                Paid {money(item.paidMinor)} with {item.booking?.soldBy}.{' '}
                {nowPrice !== null &&
                item.detail.kind === 'flight' &&
                nowPrice < item.paidMinor ? (
                  <span className="font-medium">
                    Now {money(nowPrice)}, {money(item.paidMinor - nowPrice)}{' '}
                    under what was paid. See Prices.
                  </span>
                ) : null}
              </>
            ) : cost !== null ? (
              <>
                {money(cost)} at the last check
                {watch?.checkedAt
                  ? `, ${new Date(watch.checkedAt).toLocaleString()}`
                  : ''}
                .
              </>
            ) : null}
          </p>
          {item.status === 'chosen' ? (
            booking ? (
              <BookForm
                item={item}
                onBook={(paidMinor, soldBy) => {
                  update((t) =>
                    markBooked(t, item.id, {
                      paidMinor,
                      booking: {
                        soldBy,
                        fareType: null,
                        freeCancelUntil: null,
                      },
                    }),
                  )
                  setBooking(false)
                }}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setBooking(true)}>
                  I booked it
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    update((t) => setItemStatus(t, item.id, 'open'))
                  }
                >
                  <Undo2 aria-hidden /> Choose again
                </Button>
              </div>
            )
          ) : null}
        </div>
      )}

      {item.status !== 'booked' ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => update((t) => setItemStatus(t, item.id, 'dropped'))}
        >
          <X aria-hidden /> Drop this
        </Button>
      ) : null}
    </li>
  )
}

function issueText(trip: Trip, issue: Issue) {
  const title = (itemId: string) =>
    trip.items.find((i) => i.id === itemId)?.title ?? 'an item'
  switch (issue.kind) {
    case 'not_there':
      return (
        <>
          <Person trip={trip} memberId={issue.memberId} /> is on{' '}
          {title(issue.itemId)} on a day they are not there yet, or have left.
        </>
      )
    case 'double_booked':
      return (
        <>
          <Person trip={trip} memberId={issue.memberId} /> is on{' '}
          {title(issue.itemIds[0])} and {title(issue.itemIds[1])} at the same
          time.
        </>
      )
    case 'added_twice':
      return <>The same booking was added twice: {title(issue.itemIds[0])}.</>
    case 'no_one_booking':
      return (
        <>
          {title(issue.itemId)} needs booking ahead and nobody has said they
          will book it.
        </>
      )
    case 'unused_nights':
      return (
        <>
          <Person trip={trip} memberId={issue.memberId} /> is in{' '}
          {title(issue.itemId)} for {issue.nights.length}{' '}
          {issue.nights.length === 1 ? 'night' : 'nights'} they are not there (
          {issue.nights.map((n) => formatDay(n)).join(', ')}).
        </>
      )
    default: {
      const exhaustive: never = issue
      return exhaustive
    }
  }
}

export default function PlanPanel(props: PanelProps) {
  const { trip, update, runWatches, go } = props
  const option = chosenOption(trip)
  if (!option) {
    return (
      <div className="bg-card max-w-xl space-y-4 rounded-lg border p-6">
        <h2 className="text-lg font-semibold">
          No destination is decided yet.
        </h2>
        <p className="text-muted-foreground text-sm">
          Planning starts once the group locks a place. Price the shortlist and
          put it to a vote first.
        </p>
        <Button onClick={() => go('decide')}>
          Go to Where and when <ArrowRight aria-hidden />
        </Button>
      </div>
    )
  }
  const gaps = findGaps(trip, option)
  const issues = findIssues(trip, option)
  const travel = trip.items.filter(
    (i) =>
      i.optionId === option.id &&
      i.status !== 'dropped' &&
      i.detail.kind !== 'activity',
  )
  const landings = arrivals(trip, option)
  const costs = costByMember(trip, option)
  const coming = going(trip)

  const fillIn = () => {
    // Build the slots once, then merge them into the latest trip, so a search result
    // that lands in between is kept.
    const result = applyGaps(trip, option, gaps, newId)
    const known = new Set([
      ...trip.items.map((i) => i.id),
      ...trip.watches.map((w) => w.id),
    ])
    const items = result.trip.items.filter((i) => !known.has(i.id))
    const watches = result.trip.watches.filter((w) => !known.has(w.id))
    update((t) => ({
      ...t,
      items: [...t.items, ...items],
      watches: [...t.watches, ...watches],
    }))
    void runWatches(
      result.trip.watches.filter((w) => result.watchIds.includes(w.id)),
    )
  }

  return (
    <div className="space-y-10">
      {gaps.length > 0 ? (
        <section
          aria-labelledby="still-needed"
          className="bg-card rounded-lg border p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div className="min-w-0 space-y-3">
              <h2
                id="still-needed"
                className="text-xl font-semibold tracking-tight"
              >
                Still needed for {option.label}
              </h2>
              <ul className="space-y-1.5 text-sm">
                {gaps.map((gap) => (
                  <li
                    key={`${gap.kind}-${gap.memberIds.join()}-${gap.kind === 'no_stay' ? gap.checkin : ''}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    {gapText(trip, gap)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="max-w-sm space-y-2">
              <Button onClick={fillIn}>
                Fill in travel: {gaps.length}{' '}
                {gaps.length === 1 ? 'search' : 'searches'}
              </Button>
              <p className="text-muted-foreground text-xs">
                People flying from the same airports share one search, and
                people missing the same nights share one stay. Each becomes a
                slot you can watch.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <Section
        title="Who is where"
        description={`${option.label}, ${formatRange(option.depart, option.return)}. One row per person: when they are there, where they sleep, and what they are doing. Shared plans line up across rows.`}
      >
        <Timeline trip={trip} option={option} />
        {gaps.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Everyone who is coming has a flight and a bed for every night, at
            least as a choice in progress.
          </p>
        ) : null}
      </Section>

      <div className="grid grid-cols-1 gap-10 @5xl:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)]">
        <Section
          title="Flights and stays"
          description="Each slot is a live search. Choose an option, then mark it booked once you have paid."
        >
          {travel.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No slots yet. Fill in travel above to search for everyone at once.
            </p>
          ) : (
            <ul className="grid gap-4 @7xl:grid-cols-2">
              {travel.map((item) => (
                <TravelItem
                  key={item.id}
                  {...props}
                  item={item}
                  option={option}
                />
              ))}
            </ul>
          )}
        </Section>

        <div className="space-y-10">
          <Section
            title="Arrivals"
            description="Landings within an hour at one airport are grouped, so people can share the ride in."
          >
            {landings.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No flights chosen yet.
              </p>
            ) : (
              <ul className="bg-card divide-y rounded-lg border">
                {landings.map((a) => (
                  <li
                    key={`${a.airport}-${a.at}`}
                    className="space-y-1 px-4 py-3 text-sm"
                  >
                    <p className="font-medium tabular-nums">
                      {formatDay(localDateOf(a.at))}, {localTimeOf(a.at)} at{' '}
                      {a.airport}
                    </p>
                    <People trip={trip} memberIds={a.memberIds} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Issues">
            {issues.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing conflicts.
              </p>
            ) : (
              <ul className="bg-card divide-y rounded-lg border">
                {issues.map((issue, index) => (
                  <li
                    key={`${issue.kind}-${index}`}
                    className="flex gap-2.5 px-4 py-3 text-sm"
                  >
                    <AlertTriangle
                      className="text-destructive mt-0.5 size-4 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0">{issueText(trip, issue)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Cost by person"
            description="Paid prices where booked, otherwise the latest price. Shared items split by head count, stays by nights too."
          >
            <ul className="bg-card divide-y rounded-lg border">
              {coming.map((m) => (
                <li
                  key={m.id}
                  className="flex justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <Person trip={trip} memberId={m.id} />
                  <span className="tabular-nums">
                    {money(costs.get(m.id) ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  )
}
