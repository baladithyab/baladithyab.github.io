import { useMemo, useState } from 'react'
import { Check, Lock, Search, Star, Trash2, Vote } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  addOption,
  defaultCloseTime,
  lockPoll,
  openPoll,
  pricingRequests,
  removeOption,
  setPricing,
  setVotes,
} from '@/lib/tripspace/actions'
import {
  addDays,
  daysBetween,
  formatDate,
  formatDay,
  formatRange,
  isIsoDate,
} from '@/lib/tripspace/dates'
import {
  availabilityByDay,
  bestWindows,
  cannotMake,
  heads,
  optionCost,
  tally,
  type Pricing,
  type Trip,
  type TripOption,
  type Window,
} from '@/lib/tripspace/model'
import {
  searchEach,
  type DestinationOffer,
  type SearchResponse,
} from '@/lib/tripspace/search'

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

function Availability({ trip }: { trip: Trip }) {
  const answering = trip.members.filter(
    (m) => m.rsvp !== 'out' && m.dates.length > 0,
  )
  if (answering.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        Nobody has given dates yet.
      </p>
    )
  const start = answering.flatMap((m) => m.dates.map((r) => r.start)).sort()[0]
  const ends = answering.flatMap((m) => m.dates.map((r) => r.end)).sort()
  const end = ends.at(-1)
  if (!start || !end) return null
  // A long spread of dates is cut at 60 days, so the strip stays readable.
  const days = availabilityByDay(
    trip,
    start,
    daysBetween(start, end) > 60 ? addDays(start, 60) : end,
  )
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Who can travel each day"
      className="focus-visible:ring-ring overflow-x-auto rounded-md pb-2 focus-visible:ring-2 focus-visible:outline-none"
    >
      <ol
        className="flex w-full min-w-max gap-1"
        aria-label={`Who can travel each day, out of ${answering.length} who answered`}
      >
        {days.map((d) => {
          const share = d.memberIds.length / answering.length
          return (
            <li
              key={d.date}
              className={cn(
                'flex min-w-11 flex-1 flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs',
                share === 1
                  ? 'bg-primary text-primary-foreground'
                  : share >= 0.5
                    ? 'bg-muted'
                    : '',
              )}
              aria-label={`${formatDay(d.date)}: ${d.memberIds.length} of ${answering.length}`}
            >
              <span className={share === 1 ? '' : 'text-foreground/75'}>
                {formatDay(d.date).split(' ')[0]}
              </span>
              <span className="font-medium">{d.date.slice(8)}</span>
              <span className="tabular-nums">{d.memberIds.length}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

type ExploreState = {
  window: Window
  origins: string[]
  results: Map<string, SearchResponse | null>
}

function Explore({
  trip,
  window: win,
  onAdd,
}: {
  trip: Trip
  window: Window
  onAdd: (offer: DestinationOffer) => void
}) {
  const [state, setState] = useState<ExploreState | null>(null)
  const travellers = trip.members.filter(
    (m) =>
      (m.rsvp === 'in' || m.rsvp === 'maybe') && m.home.kind === 'airports',
  )
  const origins = [
    ...new Set(
      travellers.flatMap((m) =>
        m.home.kind === 'airports' && m.home.codes[0] ? [m.home.codes[0]] : [],
      ),
    ),
  ]
  const current =
    state && state.window.start === win.start && state.window.end === win.end
      ? state
      : null

  const run = async () => {
    const initial: ExploreState = {
      window: win,
      origins,
      results: new Map(origins.map((o) => [o, null])),
    }
    setState(initial)
    await searchEach(
      origins.map((from) => ({
        key: from,
        request: {
          kind: 'anywhere' as const,
          from,
          depart: win.start,
          return: win.end,
          adults: 1,
        },
      })),
      (from, response) =>
        setState((prev) =>
          prev
            ? { ...prev, results: new Map(prev.results).set(from, response) }
            : prev,
        ),
    )
  }

  const rows = useMemo(() => {
    if (!current) return { complete: [], partial: 0 }
    const byDestination = new Map<
      string,
      { offer: DestinationOffer; fares: Map<string, number> }
    >()
    for (const [from, response] of current.results) {
      if (!response?.ok) continue
      for (const offer of response.offers) {
        if (offer.kind !== 'destination' || current.origins.includes(offer.key))
          continue
        const row = byDestination.get(offer.key) ?? {
          offer,
          fares: new Map<string, number>(),
        }
        row.fares.set(from, offer.priceMinor)
        byDestination.set(offer.key, row)
      }
    }
    const all = [...byDestination.values()]
    const complete = all
      .filter((row) => current.origins.every((o) => row.fares.has(o)))
      .map((row) => ({
        ...row,
        total: travellers.reduce((sum, m) => {
          const from = m.home.kind === 'airports' ? m.home.codes[0] : undefined
          return sum + (from ? (row.fares.get(from) ?? 0) * heads(m.party) : 0)
        }, 0),
      }))
      .sort((a, b) => a.total - b.total)
    return {
      complete: complete.slice(0, 10),
      partial: all.length - complete.length,
    }
  }, [current, travellers])

  if (origins.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        Once people give their home airports, this searches from all of them at
        once.
      </p>
    )
  const pending = current
    ? [...current.results.values()].filter((r) => r === null).length
    : 0
  const failed = current
    ? [...current.results.entries()].filter(([, r]) => r !== null && !r.ok)
    : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void run()}
          disabled={pending > 0}
          className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal"
        >
          <Search aria-hidden /> Search destinations from {origins.join(', ')}
        </Button>
        {pending > 0 ? (
          <Busy>
            Searching {pending} of {origins.length} airports. Each takes a few
            seconds.
          </Busy>
        ) : null}
      </div>
      {failed.map(([from, r]) => (
        <Notice key={from} tone="error">
          From {from}: {r && !r.ok ? r.message : ''}
        </Notice>
      ))}
      {current &&
      pending === 0 &&
      rows.complete.length === 0 &&
      failed.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No destination had fares from every airport for these dates.
        </p>
      ) : null}
      {rows.complete.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="text-muted-foreground px-4 pt-3 text-left text-xs">
              Round-trip fares for one adult from each airport, cheapest group
              total first. The total multiplies each fare by the people flying
              from that airport.
            </caption>
            <thead>
              <tr className="text-muted-foreground border-b text-left text-xs">
                <th className="px-4 py-2 font-medium">Destination</th>
                {current?.origins.map((o) => (
                  <th key={o} className="px-4 py-2 text-right font-medium">
                    From {o}
                  </th>
                ))}
                <th className="px-4 py-2 text-right font-medium">
                  Group total
                </th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.complete.map((row) => (
                <tr key={row.offer.key} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-medium">{row.offer.city}</span>{' '}
                    <span className="text-muted-foreground">
                      {row.offer.key}
                    </span>
                  </td>
                  {current?.origins.map((o) => (
                    <td key={o} className="px-4 py-2 text-right tabular-nums">
                      {money(row.fares.get(o) ?? 0)}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right font-medium tabular-nums">
                    {money(row.total)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={trip.options.some(
                        (o) => o.destination === row.offer.key,
                      )}
                      onClick={() => onAdd(row.offer)}
                    >
                      {trip.options.some((o) => o.destination === row.offer.key)
                        ? 'On the list'
                        : 'Add to shortlist'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {rows.partial > 0 && pending === 0 ? (
        <p className="text-muted-foreground text-xs">
          {rows.partial} more destinations had fares from only some of the
          airports and are left out.
        </p>
      ) : null}
    </div>
  )
}

function OptionCard({
  trip,
  me,
  option,
  update,
  pricing,
  onPrice,
}: Pick<PanelProps, 'trip' | 'me' | 'update'> & {
  option: TripOption
  pricing: boolean
  onPrice: () => void
}) {
  const cost = optionCost(trip, option)
  const missing = cannotMake(trip, option)
  const poll = trip.polls.find(
    (p) =>
      p.status === 'open' && p.choices.some((c) => c.optionId === option.id),
  )
  const choice = poll?.choices.find((c) => c.optionId === option.id)
  const myVotes = poll?.votes.filter((v) => v.memberId === me.id) ?? []
  const approved = choice
    ? myVotes.some((v) => v.choiceId === choice.id)
    : false
  const favourite = choice
    ? myVotes.some((v) => v.choiceId === choice.id && v.favourite)
    : false
  const votes =
    choice && poll
      ? tally(poll).find((t) => t.choiceId === choice.id)
      : undefined

  const vote = (nextApproved: boolean, nextFavourite: boolean) => {
    if (!poll || !choice) return
    const others = myVotes.filter((v) => v.choiceId !== choice.id)
    const approvals = [
      ...others.map((v) => v.choiceId),
      ...(nextApproved || nextFavourite ? [choice.id] : []),
    ]
    const fav = nextFavourite
      ? choice.id
      : (others.find((v) => v.favourite)?.choiceId ?? null)
    update((t) => setVotes(t, poll.id, me.id, approvals, fav))
  }

  return (
    <li
      className={cn(
        'bg-card space-y-4 rounded-lg border p-5',
        option.status === 'rejected' && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">
            {option.label}{' '}
            <span className="text-muted-foreground text-sm font-normal">
              {option.destination}
            </span>
          </h3>
          <p className="text-muted-foreground text-sm">
            {formatRange(option.depart, option.return)},{' '}
            {daysBetween(option.depart, option.return)} nights
          </p>
        </div>
        <span className="rounded-full border px-2.5 py-0.5 text-xs">
          {option.status === 'chosen'
            ? 'Chosen'
            : option.status === 'rejected'
              ? 'Not chosen'
              : 'Candidate'}
        </span>
      </div>

      {missing.length > 0 ? (
        <p className="text-sm">
          <span className="text-muted-foreground">
            Cannot make these dates:{' '}
          </span>
          <People trip={trip} memberIds={missing.map((m) => m.id)} />
        </p>
      ) : null}

      {cost ? (
        <div className="space-y-2">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {[...cost.perMember.entries()].map(([memberId, value]) => (
              <li key={memberId} className="flex justify-between gap-2">
                <Person trip={trip} memberId={memberId} />
                <span className="tabular-nums">{money(value)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            <span className="font-medium">
              Group total {money(cost.total)}.
            </span>
            <span className="text-muted-foreground">
              {' '}
              Each person's cheapest round trip from their airport, plus a share
              of {option.pricing?.stay.rooms ?? 1}{' '}
              {(option.pricing?.stay.rooms ?? 1) === 1 ? 'room' : 'rooms'} for
              two at the cheapest hotel found. Priced{' '}
              {formatDate(
                new Date(option.pricing?.at ?? 0).toISOString().slice(0, 10),
              )}
              .
            </span>
          </p>
          {option.pricing?.flights
            .filter((f) => f.error)
            .map((f) => (
              <Notice key={f.from.join('+')} tone="error">
                No fare from {f.from.join(', ')}: {f.error}
              </Notice>
            ))}
          {option.pricing?.stay.error ? (
            <Notice tone="error">
              No stay price: {option.pricing.stay.error}
            </Notice>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {option.status === 'candidate' ? (
          pricing ? (
            <Busy>Pricing for everyone</Busy>
          ) : (
            <Button
              size="sm"
              variant={cost ? 'ghost' : 'secondary'}
              onClick={onPrice}
            >
              <Search aria-hidden />{' '}
              {cost ? 'Price again' : 'Price it for everyone'}
            </Button>
          )
        ) : null}
        {poll && choice ? (
          <>
            <Button
              size="sm"
              variant={approved ? 'default' : 'outline'}
              aria-pressed={approved}
              onClick={() => vote(!approved, approved ? false : favourite)}
            >
              <Check aria-hidden /> Works for me
            </Button>
            <Button
              size="sm"
              variant={favourite ? 'default' : 'outline'}
              aria-pressed={favourite}
              onClick={() => vote(true, !favourite)}
            >
              <Star aria-hidden /> My favourite
            </Button>
            <span className="text-muted-foreground text-sm">
              {votes?.approvals ?? 0} approve, {votes?.favourites ?? 0}{' '}
              favourite
            </span>
          </>
        ) : null}
        {me.role === 'owner' && option.status === 'candidate' && !poll ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => update((t) => removeOption(t, option.id))}
          >
            <Trash2 aria-hidden /> Remove
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function AddOption({
  onAdd,
  defaults,
}: {
  onAdd: (
    option: Pick<
      TripOption,
      'label' | 'destination' | 'city' | 'depart' | 'return'
    >,
  ) => void
  defaults: Window | null
}) {
  const [city, setCity] = useState('')
  const [code, setCode] = useState('')
  const [depart, setDepart] = useState(defaults?.start ?? '')
  const [back, setBack] = useState(defaults?.end ?? '')
  const ready =
    city.trim().length > 1 &&
    /^[A-Z]{3}$/.test(code) &&
    isIsoDate(depart) &&
    isIsoDate(back) &&
    back > depart
  return (
    <form
      className="bg-card grid gap-3 rounded-lg border p-4 @xl:grid-cols-2 @4xl:grid-cols-[2fr_1fr_1fr_1fr_auto] @4xl:items-end"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        onAdd({
          label: city.trim(),
          city: city.trim(),
          destination: code,
          depart,
          return: back,
        })
        setCity('')
        setCode('')
      }}
    >
      <Field label="City">
        <input
          className={inputClass}
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="Lisbon"
        />
      </Field>
      <Field label="Airport code">
        <input
          className={inputClass}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 3))}
          placeholder="LIS"
          autoCapitalize="characters"
        />
      </Field>
      <Field label="Depart">
        <input
          type="date"
          className={inputClass}
          value={depart}
          onChange={(e) => setDepart(e.target.value)}
        />
      </Field>
      <Field label="Return">
        <input
          type="date"
          className={inputClass}
          value={back}
          min={depart || undefined}
          onChange={(e) => setBack(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="secondary" disabled={!ready}>
        Add option
      </Button>
    </form>
  )
}

export default function DecidePanel({ trip, me, update, go }: PanelProps) {
  const [nights, setNights] = useState(7)
  const [picked, setPicked] = useState<Window | null>(null)
  const [pricingIds, setPricingIds] = useState<ReadonlySet<string>>(new Set())
  const windows = bestWindows(trip, nights)
  const span =
    picked &&
    windows.some((w) => w.start === picked.start && w.end === picked.end)
      ? picked
      : (windows[0] ?? null)
  const answering = trip.members.filter(
    (m) => m.rsvp !== 'out' && m.dates.length > 0,
  ).length
  const poll = trip.polls.find((p) => p.status === 'open')
  const candidates = trip.options.filter((o) => o.status === 'candidate')
  const leader = poll ? tally(poll)[0] : undefined
  const notVoted = poll
    ? trip.members
        .filter(
          (m) =>
            m.rsvp !== 'out' && !poll.votes.some((v) => v.memberId === m.id),
        )
        .map((m) => m.id)
    : []

  const price = async (option: TripOption) => {
    setPricingIds((prev) => new Set([...prev, option.id]))
    const plan = pricingRequests(trip, option)
    const flights: Pricing['flights'] = plan.flights.map((f) => ({
      from: f.from,
      memberIds: f.memberIds,
      offer: null,
      error: null,
    }))
    const stay: Pricing['stay'] = {
      rooms: plan.stay.rooms,
      offer: null,
      error: null,
    }
    const jobs = [
      ...plan.flights.map((f, index) => ({
        key: `flight:${index}`,
        request: f.request,
      })),
      { key: 'stay', request: plan.stay.request },
    ]
    await searchEach(jobs, (key, response) => {
      if (key === 'stay') {
        const offer = response.ok
          ? response.offers.find((o) => o.kind === 'hotel')
          : undefined
        stay.offer = offer?.kind === 'hotel' ? offer : null
        stay.error = response.ok
          ? offer
            ? null
            : 'no hotels found'
          : response.message
        return
      }
      const entry = flights[Number(key.slice(7))]
      if (!entry) return
      const offer = response.ok
        ? response.offers.find((o) => o.kind === 'flight')
        : undefined
      entry.offer = offer?.kind === 'flight' ? offer : null
      entry.error = response.ok
        ? offer
          ? null
          : 'no flights found'
        : response.message
    })
    update((t) => setPricing(t, option.id, { at: Date.now(), flights, stay }))
    setPricingIds((prev) => new Set([...prev].filter((id) => id !== option.id)))
  }

  return (
    <div className="space-y-12">
      <Section
        title="When can people go?"
        description={`From the dates ${answering} ${answering === 1 ? 'person has' : 'people have'} given. A filled day suits everyone who answered.`}
      >
        <Availability trip={trip} />
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Trip length</span>
            <Segmented
              label="Trip length in nights"
              options={[3, 5, 7, 10].map((n) => ({
                value: n,
                label: `${n} nights`,
              }))}
              value={nights}
              onChange={(n) => {
                setNights(n)
                setPicked(null)
              }}
            />
          </div>
          {windows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No window of {nights} nights fits anyone's dates yet.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-3">
              {windows.map((w) => {
                const active = span?.start === w.start && span.end === w.end
                return (
                  <li key={w.start}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setPicked(w)}
                      className={cn(
                        'focus-visible:ring-ring w-full rounded-lg border p-3 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-muted',
                      )}
                    >
                      <span className="block font-medium">
                        {formatRange(w.start, w.end)}
                      </span>
                      <span className={active ? '' : 'text-muted-foreground'}>
                        {w.memberIds.length} of {answering} can make it
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </Section>

      <div
        className={cn(
          'grid grid-cols-1 gap-12',
          span &&
            '@7xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] @7xl:items-start',
        )}
      >
        {span ? (
          <Section
            title="Where could we go?"
            description={`Every destination with fares from everyone's home airport, ${formatRange(span.start, span.end)}. Prices are live from Skiplagged.`}
          >
            <Explore
              trip={trip}
              window={span}
              onAdd={(offer) =>
                update((t) =>
                  addOption(
                    t,
                    {
                      label: offer.city,
                      city: offer.region
                        ? `${offer.city}, ${offer.region}`
                        : offer.city,
                      destination: offer.key,
                      depart: span.start,
                      return: span.end,
                    },
                    newId,
                  ),
                )
              }
            />
          </Section>
        ) : null}

        <div className="@container min-w-0">
          <Section
            title="Shortlist"
            description="Each option priced for each person: their own flight and a share of the stay."
            action={
              me.role === 'owner' && !poll && candidates.length >= 2 ? (
                <Button
                  onClick={() =>
                    update((t) =>
                      openPoll(t, {
                        question: 'Where should we go?',
                        optionIds: candidates.map((o) => o.id),
                        closesAt: defaultCloseTime(Date.now()),
                        newId,
                      }),
                    )
                  }
                >
                  <Vote aria-hidden /> Put the shortlist to a vote
                </Button>
              ) : null
            }
          >
            {poll ? (
              <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm">
                <p>
                  <span className="font-medium">{poll.question}</span> Approve
                  every option that works for you, and mark one favourite.
                  Closes{' '}
                  {formatDate(
                    new Date(poll.closesAt).toISOString().slice(0, 10),
                  )}
                  .{' '}
                  {leader ? (
                    <>
                      Leading:{' '}
                      <span className="font-medium">{leader.label}</span>,{' '}
                      {leader.approvals} approve.
                    </>
                  ) : null}{' '}
                  <span className="text-muted-foreground">
                    {notVoted.length === 0 ? (
                      'Everyone has voted.'
                    ) : (
                      <>
                        Not voted yet:{' '}
                        <People trip={trip} memberIds={notVoted} />
                      </>
                    )}
                  </span>
                </p>
                {me.role === 'owner' && leader ? (
                  <Button
                    onClick={() => {
                      update((t) =>
                        lockPoll(t, {
                          pollId: poll.id,
                          choiceId: leader.choiceId,
                          by: me.id,
                          now: Date.now(),
                          newId,
                        }),
                      )
                      go('plan')
                    }}
                  >
                    <Lock aria-hidden /> Lock {leader.label.split(',')[0]}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {trip.options.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No options yet. Add one from the search above, or by hand below.
              </p>
            ) : (
              <ul className="grid gap-4 @4xl:grid-cols-2">
                {[...trip.options]
                  .sort(
                    (a, b) =>
                      (a.status === 'rejected' ? 1 : 0) -
                      (b.status === 'rejected' ? 1 : 0),
                  )
                  .map((option) => (
                    <OptionCard
                      key={option.id}
                      trip={trip}
                      me={me}
                      option={option}
                      update={update}
                      pricing={pricingIds.has(option.id)}
                      onPrice={() => void price(option)}
                    />
                  ))}
              </ul>
            )}
            {me.role === 'owner' ? (
              <AddOption
                key={span?.start ?? 'none'}
                defaults={span}
                onAdd={(o) => update((t) => addOption(t, o, newId))}
              />
            ) : null}
            {!poll && candidates.length >= 2 && me.role !== 'owner' ? (
              <p className="text-muted-foreground text-sm">
                The organizer,{' '}
                <Person
                  trip={trip}
                  memberId={
                    trip.members.find((m) => m.role === 'owner')?.id ?? ''
                  }
                />
                , puts the shortlist to a vote.
              </p>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  )
}
