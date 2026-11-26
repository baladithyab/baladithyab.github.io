import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CalendarPlus,
  ExternalLink,
  Plane,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  addIdea,
  applyGaps,
  chooseOffer,
  fitStayToArrivals,
  ideasOf,
  markBooked,
  scheduleIdea,
  setInterest,
  setItemStatus,
  setReservation,
  unscheduleIdea,
} from '@/lib/tripspace/actions'
import {
  formatDate,
  formatDay,
  formatRange,
  isIsoDate,
  localDateOf,
  localTimeOf,
  nightsOf,
} from '@/lib/tripspace/dates'
import {
  arrivals,
  audience,
  chosenOption,
  findGaps,
  findIssues,
  interestScore,
  itemCost,
  latest,
  matchKey,
  tally,
  unusedNights,
  type Gap,
  type Interest,
  type Item,
  type Trip,
  type TripOption,
} from '@/lib/tripspace/model'
import type { FlightOffer, HotelOffer, Leg } from '@/lib/tripspace/search'

import { groupIssues } from './Briefing'
import { CostBars } from './Charts'
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
  Segmented,
} from './parts'
import type { PanelProps } from './types'

const newId = () => crypto.randomUUID()

const TAG_LABEL: Record<string, string> = {
  'virtual-interline': 'self-transfer',
  'hidden-city': 'hidden city',
}

const BUCKETS: { value: Interest; label: string; hint: string }[] = [
  {
    value: 'reserve',
    label: 'Reservation needed',
    hint: 'A must, book ahead',
  },
  { value: 'want', label: 'Want to do', hint: 'Would be sad to miss' },
  { value: 'like', label: 'Would like to do', hint: 'Good if there is time' },
]

const AUDIENCE_LABEL = {
  group: 'Group activity',
  breakout: 'Breakout',
  solo: 'Solo',
} as const

type SubView = 'all' | 'travel' | 'ideas'

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
          Includes {tags.join(' and ')} segments. Check connection rules before
          booking.
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
      {money(offer.nightlyMinor)}/night per room; {rooms}{' '}
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
      <BedDouble className="size-4 shrink-0" aria-hidden /> Stay in {gap.city},{' '}
      {formatRange(gap.checkin, gap.checkout)}, for{' '}
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
      className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
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
      <Field label="Booked with" hint="Airline, agency or hotel.">
        <input
          className={inputClass}
          value={soldBy}
          onChange={(e) => setSoldBy(e.target.value)}
          placeholder="TAP Portugal"
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
  go,
  runWatches,
  busyWatches,
}: PanelProps & { item: Item; option: TripOption }) {
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
            {unused.length === 1 ? 'is' : 'are'} booked for nights before
            arriving or after leaving.
            {item.status === 'open'
              ? ' Fitting updates the stay dates and searches again.'
              : ' Fitting assigns each person only the nights they are there.'}
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
              {watch.checkedAt === null
                ? 'Search live'
                : watch.sample
                  ? 'Search live on Skiplagged'
                  : 'Search again'}
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
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>
              {item.status === 'booked' && item.paidMinor !== null ? (
                <>
                  Paid {money(item.paidMinor)} with {item.booking?.soldBy}.{' '}
                  {nowPrice !== null &&
                  item.detail.kind === 'flight' &&
                  nowPrice < item.paidMinor ? (
                    <span className="font-semibold">
                      Now {money(nowPrice)} ({money(item.paidMinor - nowPrice)}{' '}
                      drop).
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
            {item.status === 'booked' &&
            item.paidMinor !== null &&
            nowPrice !== null &&
            item.detail.kind === 'flight' &&
            nowPrice < item.paidMinor ? (
              <Button size="sm" variant="outline" onClick={() => go('prices')}>
                Inspect drop <ArrowRight aria-hidden />
              </Button>
            ) : null}
          </div>

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

function IdeaCard({
  trip,
  me,
  item,
  update,
}: Pick<PanelProps, 'trip' | 'me' | 'update'> & { item: Item }) {
  const option = chosenOption(trip)
  const [date, setDate] = useState(item.startDate ?? option?.depart ?? '')
  const [time, setTime] = useState(
    item.detail.kind === 'activity' ? (item.detail.time ?? '') : '',
  )
  const [bookBy, setBookBy] = useState(item.bookBy ?? '')
  const mine =
    item.participants.find((p) => p.memberId === me.id)?.interest ?? null
  const needsBooking = item.participants.some((p) => p.interest === 'reserve')
  const scheduled = item.startDate !== null
  const detail = item.detail.kind === 'activity' ? item.detail : null

  return (
    <li className="bg-card space-y-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="text-muted-foreground text-sm">
            {detail?.place ?? 'No place given'}
            {detail?.link ? (
              <>
                {' '}
                <a
                  className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-4"
                  href={detail.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  link <ExternalLink className="size-3" aria-hidden />
                </a>
              </>
            ) : null}
          </p>
        </div>
        <span
          className="rounded-full border px-2.5 py-0.5 text-xs tabular-nums"
          title="3 per reservation needed, 2 per want, 1 per would like"
        >
          Score {interestScore(item)}
        </span>
      </div>

      <dl className="grid gap-1 text-sm">
        {BUCKETS.map((b) => {
          const who = item.participants
            .filter((p) => p.interest === b.value)
            .map((p) => p.memberId)
          return who.length > 0 ? (
            <div key={b.value} className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{b.label}:</dt>
              <dd>
                <People trip={trip} memberIds={who} />
              </dd>
            </div>
          ) : null
        })}
      </dl>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Your bucket</p>
        <Segmented
          label={`Your bucket for ${item.title}`}
          options={[
            ...BUCKETS.map((b) => ({ value: b.value, label: b.label })),
            { value: 'none' as const, label: 'Not for me' },
          ]}
          value={mine ?? 'none'}
          onChange={(value) =>
            update((t) =>
              setInterest(t, item.id, me.id, value === 'none' ? null : value),
            )
          }
        />
      </div>

      {scheduled ? (
        <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <span>
            <span className="font-medium">
              {formatDay(item.startDate ?? '')}
            </span>
            {detail?.time ? ` at ${detail.time}` : ''}.{' '}
            {AUDIENCE_LABEL[audience(trip, item)]} for{' '}
            <People
              trip={trip}
              memberIds={item.participants.map((p) => p.memberId)}
            />
            .
          </span>
          {item.status !== 'booked' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update((t) => unscheduleIdea(t, item.id))}
            >
              <Undo2 aria-hidden /> Unschedule
            </Button>
          ) : null}
        </div>
      ) : option ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!isIsoDate(date)) return
            update((t) =>
              scheduleIdea(t, item.id, { date, time: time || null }),
            )
          }}
        >
          <Field label="Day">
            <input
              type="date"
              className={inputClass}
              value={date}
              min={option.depart}
              max={option.return}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="Time, optional">
            <input
              type="time"
              className={inputClass}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal"
            disabled={!isIsoDate(date) || item.participants.length === 0}
          >
            <CalendarPlus aria-hidden /> Schedule onto timeline
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">
          Scheduling opens once a destination is locked in Coordinator.
        </p>
      )}

      {needsBooking ? (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p className="font-medium">
            Needs booking ahead
            {item.bookBy ? `, by ${formatDate(item.bookBy)}` : ''}.{' '}
            {item.leadMemberId ? (
              <>
                Booking: <Person trip={trip} memberId={item.leadMemberId} />.
              </>
            ) : (
              'Nobody is booking it yet.'
            )}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Book by">
              <input
                type="date"
                className={inputClass}
                value={bookBy}
                onChange={(e) => {
                  const next = e.target.value
                  setBookBy(next)
                  if (next === '' || isIsoDate(next))
                    update((t) =>
                      setReservation(t, item.id, {
                        bookBy: next || null,
                        leadMemberId: item.leadMemberId,
                        quotedMinor: item.quotedMinor,
                      }),
                    )
                }}
              />
            </Field>
            <Button
              size="sm"
              variant={item.leadMemberId === me.id ? 'outline' : 'secondary'}
              onClick={() =>
                update((t) =>
                  setReservation(t, item.id, {
                    bookBy: item.bookBy,
                    leadMemberId: item.leadMemberId === me.id ? null : me.id,
                    quotedMinor: item.quotedMinor,
                  }),
                )
              }
            >
              {item.leadMemberId === me.id
                ? 'Release booking'
                : 'I will book it'}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function IdeasBoard({
  trip,
  me,
  update,
}: Pick<PanelProps, 'trip' | 'me' | 'update'>) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [place, setPlace] = useState('')
  const [link, setLink] = useState('')
  const [bucket, setBucket] = useState<Interest>('want')

  const ideas = ideasOf(trip).sort(
    (a, b) =>
      interestScore(b) - interestScore(a) || a.title.localeCompare(b.title),
  )
  const myMusts = ideas.filter((i) =>
    i.participants.some(
      (p) => p.memberId === me.id && p.interest === 'reserve',
    ),
  )
  const validLink = link.trim() === '' || /^https?:\/\//.test(link.trim())

  return (
    <Section
      title="Activities and ideas"
      description={
        myMusts.length > 0
          ? `${myMusts.filter((i) => i.startDate !== null).length} of your ${myMusts.length} reservation-needed ${myMusts.length === 1 ? 'idea is' : 'ideas are'} scheduled. Scheduling puts everyone interested onto the timeline above.`
          : 'Sort ideas into three personal buckets, then schedule them onto trip days. Group, breakout or solo derives from who cares.'
      }
      action={
        <Button
          size="sm"
          variant={adding ? 'ghost' : 'outline'}
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus aria-hidden /> Add idea
        </Button>
      }
    >
      {/* Compact 3-bucket personal summary */}
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-3">
        {BUCKETS.map((b) => {
          const inBucket = ideas.filter((i) =>
            i.participants.some(
              (p) => p.memberId === me.id && p.interest === b.value,
            ),
          )
          return (
            <div key={b.value} className="bg-card rounded-lg border p-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{b.label}</h3>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {inBucket.length}
                </span>
              </div>
              <p className="text-muted-foreground mb-2 text-xs">{b.hint}</p>
              {inBucket.length === 0 ? (
                <p className="text-muted-foreground text-xs">Nothing here.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {inBucket.map((i) => (
                    <li key={i.id} className="truncate">
                      <span className="font-medium">{i.title}</span>
                      {i.startDate ? (
                        <span className="text-muted-foreground">
                          , {formatDay(i.startDate)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      {adding ? (
        <form
          className="bg-card grid grid-cols-1 gap-4 rounded-lg border p-4 @xl:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!title.trim() || !validLink) return
            update((t) =>
              addIdea(t, {
                title: title.trim(),
                place: place.trim() || null,
                link: link.trim() || null,
                interest: bucket,
                by: me.id,
                newId,
              }),
            )
            setTitle('')
            setPlace('')
            setLink('')
            setAdding(false)
          }}
        >
          <Field label="What">
            <input
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sunset at Miradouro da Senhora do Monte"
              maxLength={120}
              autoFocus
            />
          </Field>
          <Field label="Where, optional">
            <input
              className={inputClass}
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder="Graca"
            />
          </Field>
          <Field label="Link, optional">
            <input
              className={inputClass}
              value={link}
              aria-invalid={!validLink}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://"
              inputMode="url"
            />
          </Field>
          <div className="space-y-1.5 text-sm">
            <span className="font-medium">Your bucket</span>
            <div>
              <Segmented
                label="Your bucket for the new idea"
                options={BUCKETS.map((b) => ({
                  value: b.value,
                  label: b.label,
                }))}
                value={bucket}
                onChange={setBucket}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 @xl:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={!title.trim() || !validLink}
            >
              <Plus aria-hidden /> Add idea
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {ideas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No ideas yet. Add places to eat, visit or do together.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 @7xl:grid-cols-2">
          {ideas.map((item) => (
            <IdeaCard
              key={item.id}
              trip={trip}
              me={me}
              item={item}
              update={update}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}

export default function PlannerPanel(props: PanelProps) {
  const { trip, me, update, runWatches, go } = props
  const [subView, setSubView] = useState<SubView>('all')
  const option = chosenOption(trip)

  if (!option) {
    const poll = trip.polls.find((p) => p.status === 'open')
    const leader = poll ? tally(poll)[0] : undefined
    return (
      <div className="space-y-8">
        <section className="bg-card flex flex-wrap items-center justify-between gap-4 rounded-lg border p-6">
          <div className="max-w-2xl space-y-1.5">
            <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
              Destination not locked yet
            </p>
            <h2 className="text-xl font-semibold tracking-tight">
              Flights, stays and the day-by-day timeline unlock once the group
              picks a place.
            </h2>
            <p className="text-muted-foreground text-sm">
              {leader
                ? `Current poll leader: ${leader.label} (${leader.approvals} approve). You can still collect and rank activity ideas below in the meantime.`
                : 'Shortlist a few places and run a quick vote in Coordinator. You can still collect activity ideas below.'}
            </p>
          </div>
          <Button onClick={() => go('coordinator')}>
            Go to Coordinator <ArrowRight aria-hidden />
          </Button>
        </section>

        <IdeasBoard trip={trip} me={me} update={update} />
      </div>
    )
  }

  const gaps = findGaps(trip, option)
  const issues = findIssues(trip, option)
  const groupedIssues = groupIssues(trip, issues)
  const fitStay = (itemId: string) => {
    const result = fitStayToArrivals(trip, itemId, newId)
    const fitted = result.trip.items.find((i) => i.id === itemId)
    if (!fitted) return
    const added = result.watch
    update((t) => ({
      ...t,
      items: t.items.map((i) => (i.id === itemId ? fitted : i)),
      watches:
        added && !t.watches.some((w) => w.id === added.id)
          ? [...t.watches, added]
          : t.watches,
    }))
    if (added && added.checkedAt === null) void runWatches([added])
  }
  const travel = trip.items.filter(
    (i) =>
      i.optionId === option.id &&
      i.status !== 'dropped' &&
      i.detail.kind !== 'activity',
  )
  const ideasCount = ideasOf(trip).length
  const landings = arrivals(trip, option)

  const fillIn = () => {
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
    <div className="space-y-8">
      {gaps.length > 0 ? (
        <section
          aria-labelledby="still-needed"
          className="bg-card rounded-lg border p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div className="min-w-0 space-y-2.5">
              <h2
                id="still-needed"
                className="text-lg font-semibold tracking-tight"
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
                Shared origin airports combine into one search, and shared
                uncovered nights combine into one stay watch.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <Section
        title={`Who is where: ${option.label}`}
        description={`${formatRange(option.depart, option.return)}. Flight presence, stays, missing beds and scheduled activities line up across rows.`}
      >
        <Timeline trip={trip} option={option} />
      </Section>

      <div className="grid grid-cols-1 gap-8 @5xl:grid-cols-[minmax(0,1fr)_20rem] @5xl:items-start">
        <div className="min-w-0 space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Planner view"
              options={[
                { value: 'all' as const, label: 'All' },
                {
                  value: 'travel' as const,
                  label: `Flights and stays (${travel.length})`,
                },
                {
                  value: 'ideas' as const,
                  label: `Activities and ideas (${ideasCount})`,
                },
              ]}
              value={subView}
              onChange={setSubView}
            />
          </div>

          {subView === 'all' || subView === 'travel' ? (
            <Section
              title="Flights and stays"
              description="Each slot is a live price watch. Pick an offer, then record what you paid once booked."
            >
              {travel.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No travel slots yet. Use Fill in travel above to search for
                  everyone at once.
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-4 @7xl:grid-cols-2">
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
          ) : null}

          {subView === 'all' || subView === 'ideas' ? (
            <IdeasBoard trip={trip} me={me} update={update} />
          ) : null}
        </div>

        {/* Right Trip Intelligence Sidebar */}
        <aside aria-label="Trip intelligence" className="space-y-6">
          <section aria-labelledby="planner-issues" className="space-y-3">
            <h3 id="planner-issues" className="text-base font-semibold">
              Conflicts and bookings ({groupedIssues.length})
            </h3>
            {groupedIssues.length === 0 ? (
              <p className="bg-card text-muted-foreground rounded-lg border px-4 py-3 text-sm">
                Nothing conflicts right now.
              </p>
            ) : (
              <ul className="bg-card divide-y rounded-lg border">
                {groupedIssues.map((entry, index) => {
                  const claimId =
                    entry.kind === 'single' &&
                    entry.issue.kind === 'no_one_booking'
                      ? entry.issue.itemId
                      : null
                  const claimItem = claimId
                    ? trip.items.find((i) => i.id === claimId)
                    : null
                  return (
                    <li
                      key={`${entry.kind}-${index}`}
                      className="space-y-2 px-4 py-3 text-sm"
                    >
                      <div className="flex gap-2.5">
                        <AlertTriangle
                          className="text-chart-3 mt-0.5 size-4 shrink-0"
                          aria-hidden
                        />
                        <span className="min-w-0">{entry.label}</span>
                      </div>
                      {entry.kind === 'unused_stay' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => fitStay(entry.itemId)}
                        >
                          Fit stay to arrivals
                        </Button>
                      ) : claimItem ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            update((t) =>
                              setReservation(t, claimItem.id, {
                                bookBy: claimItem.bookBy,
                                leadMemberId: me.id,
                                quotedMinor: claimItem.quotedMinor,
                              }),
                            )
                          }
                        >
                          I will book it
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="planner-arrivals" className="space-y-3">
            <h3 id="planner-arrivals" className="text-base font-semibold">
              Arrivals
            </h3>
            <p className="text-muted-foreground text-xs">
              Landings within one hour at the same airport group together for
              shared rides.
            </p>
            {landings.length === 0 ? (
              <p className="bg-card text-muted-foreground rounded-lg border px-4 py-3 text-sm">
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
          </section>

          <section aria-labelledby="planner-costs" className="space-y-3">
            <h3 id="planner-costs" className="text-base font-semibold">
              Cost by person
            </h3>
            <CostBars trip={trip} option={option} />
          </section>
        </aside>
      </div>
    </div>
  )
}
