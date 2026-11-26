import { useMemo, useState } from 'react'
import {
  Check,
  ClipboardCopy,
  Eye,
  Lock,
  Minus,
  Plus,
  Search,
  Star,
  Trash2,
  Vote,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  addMember,
  addOption,
  defaultCloseTime,
  lockPoll,
  openPoll,
  pricingRequests,
  removeMember,
  removeOption,
  setPricing,
  setVotes,
  updateMember,
  watchOption,
} from '@/lib/tripspace/actions'
import {
  daysBetween,
  formatDate,
  formatRange,
  isIsoDate,
} from '@/lib/tripspace/dates'
import {
  bestWindows,
  cannotMake,
  heads,
  memberStatus,
  optionCost,
  tally,
  type Member,
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

import { WaitingOn } from './Briefing'
import { AvailabilityMatrix } from './Charts'
import {
  Avatar,
  buildNudge,
  Busy,
  Field,
  inputClass,
  money,
  Notice,
  People,
  Person,
  RSVP_LABEL,
  RSVP_TONE,
  Section,
  Segmented,
  Status,
  TRAVEL_STATUS,
} from './parts'
import type { PanelProps } from './types'

const newId = () => crypto.randomUUID()
const BANDS = { 1: '$', 2: '$$', 3: '$$$' } as const

function homeText(member: Member): string {
  switch (member.home.kind) {
    case 'unanswered':
      return 'Not answered'
    case 'local':
      return 'Already there'
    case 'airports':
      return member.home.codes.join(', ')
    default: {
      const exhaustive: never = member.home
      return exhaustive
    }
  }
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
          aria-label={`Fewer ${label.toLowerCase()}`}
        >
          <Minus aria-hidden />
        </Button>
        <span className="w-8 text-center tabular-nums">{value}</span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          aria-label={`More ${label.toLowerCase()}`}
        >
          <Plus aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function AnswersCard({
  trip,
  me,
  update,
}: Pick<PanelProps, 'trip' | 'me' | 'update'>) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [codes, setCodes] = useState(
    me.home.kind === 'airports' ? me.home.codes.join(', ') : '',
  )
  const [codesError, setCodesError] = useState<string | null>(null)

  const patch = (change: Partial<Omit<Member, 'id' | 'role'>>) =>
    update((t) => updateMember(t, me.id, change))
  const rangeReady = isIsoDate(start) && isIsoDate(end) && end >= start

  const saveCodes = () => {
    const parsed = codes
      .toUpperCase()
      .split(/[\s,]+/)
      .filter(Boolean)
    if (parsed.length === 0) {
      setCodesError(null)
      patch({ home: { kind: 'unanswered' } })
      return
    }
    if (parsed.length > 3 || parsed.some((c) => !/^[A-Z]{3}$/.test(c))) {
      setCodesError(
        'Enter up to three 3-letter airport codes, such as SFO, OAK.',
      )
      return
    }
    setCodesError(null)
    patch({ home: { kind: 'airports', codes: [...new Set(parsed)] } })
  }

  return (
    <section
      aria-labelledby="your-answers"
      className="bg-card @container space-y-5 rounded-lg border p-5"
    >
      <div className="space-y-1">
        <h2 id="your-answers" className="text-lg font-semibold">
          Your answers, as <Person trip={trip} memberId={me.id} />
        </h2>
        <p className="text-muted-foreground text-xs">
          Four inputs. Availability overlap, pricing and travel slots all update
          live from these.
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">Are you in?</p>
        <Segmented
          label="Are you in?"
          options={[
            { value: 'in' as const, label: 'In' },
            { value: 'maybe' as const, label: 'Maybe' },
            { value: 'out' as const, label: 'Out' },
          ]}
          value={me.rsvp === 'invited' ? null : me.rsvp}
          onChange={(rsvp) => patch({ rsvp })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Dates that work</p>
        {me.dates.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {me.dates.map((r, index) => (
              <li
                key={`${r.start}-${r.end}`}
                className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full py-1 pr-1.5 pl-3 text-xs font-medium"
              >
                {formatRange(r.start, r.end)}
                <button
                  type="button"
                  onClick={() =>
                    patch({ dates: me.dates.filter((_, i) => i !== index) })
                  }
                  aria-label={`Remove ${formatRange(r.start, r.end)}`}
                  className="hover:bg-background focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">
            No dates added yet. Add a window to show up in the overlap matrix.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 @md:grid-cols-[1fr_1fr_auto] @md:items-end">
          <Field label="From">
            <input
              type="date"
              className={inputClass}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={inputClass}
              value={end}
              min={start || undefined}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            className="col-span-2 @md:col-span-1"
            disabled={!rangeReady}
            onClick={() => {
              patch({
                dates: [...me.dates, { start, end }].sort((a, b) =>
                  a.start.localeCompare(b.start),
                ),
              })
              setStart('')
              setEnd('')
            }}
          >
            Add dates
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">Budget band</p>
        <Segmented
          label="Budget band"
          options={[
            { value: 1 as const, label: '$ Budget' },
            { value: 2 as const, label: '$$ Mid' },
            { value: 3 as const, label: '$$$ Splurge' },
          ]}
          value={me.budgetBand}
          onChange={(budgetBand) => patch({ budgetBand })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Travelling from</p>
        <Segmented
          label="How you travel"
          options={[
            { value: 'fly' as const, label: 'I fly in' },
            { value: 'local' as const, label: 'Already there' },
          ]}
          value={me.home.kind === 'local' ? 'local' : 'fly'}
          onChange={(v) => {
            if (v === 'local') patch({ home: { kind: 'local' } })
            else if (me.home.kind === 'local')
              patch({ home: { kind: 'unanswered' } })
          }}
        />
        {me.home.kind !== 'local' ? (
          <div className="space-y-1.5">
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                saveCodes()
              }}
            >
              <div className="min-w-0 flex-1">
                <Field label="Home airports">
                  <input
                    className={inputClass}
                    value={codes}
                    aria-invalid={codesError !== null}
                    onChange={(e) => setCodes(e.target.value)}
                    onBlur={saveCodes}
                    placeholder="SFO, OAK"
                    autoCapitalize="characters"
                  />
                </Field>
              </div>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </form>
            <p className="text-muted-foreground text-xs">
              Up to three 3-letter codes, comma separated.
            </p>
          </div>
        ) : null}
        {codesError ? <Notice tone="error">{codesError}</Notice> : null}
      </div>

      <div className="flex flex-wrap gap-6">
        <Stepper
          label="Adults"
          value={me.party.adults}
          min={1}
          max={9}
          onChange={(adults) => patch({ party: { ...me.party, adults } })}
        />
        <Stepper
          label="Children"
          value={me.party.children}
          min={0}
          max={8}
          onChange={(children) => patch({ party: { ...me.party, children } })}
        />
      </div>
    </section>
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
      travellers
        .map((m) => (m.home.kind === 'airports' ? m.home.codes[0] : undefined))
        .filter((c): c is string => c !== undefined),
    ),
  ]
  const current =
    state?.window.start === win.start && state?.window.end === win.end
      ? state
      : null

  const run = async () => {
    const initial = new Map<string, SearchResponse | null>(
      origins.map((o) => [o, null]),
    )
    setState({ window: win, origins, results: initial })
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
        setState((prev) => {
          if (
            !prev ||
            prev.window.start !== win.start ||
            prev.window.end !== win.end
          )
            return prev
          const next = new Map(prev.results)
          next.set(from, response)
          return { ...prev, results: next }
        }),
    )
  }

  const rows = useMemo(() => {
    if (!current) return { complete: [], partial: 0 }
    const byDest = new Map<
      string,
      { offer: DestinationOffer; fares: Map<string, number> }
    >()
    for (const [origin, res] of current.results) {
      if (!res?.ok) continue
      for (const offer of res.offers) {
        if (offer.kind !== 'destination') continue
        const entry = byDest.get(offer.key) ?? {
          offer,
          fares: new Map<string, number>(),
        }
        entry.fares.set(origin, offer.priceMinor)
        byDest.set(offer.key, entry)
      }
    }
    const all = [...byDest.values()]
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

  if (origins.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Once people add home airports, search live destinations from all of them
        at once.
      </p>
    )
  }
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
            Searching {pending} of {origins.length} airports.
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
        <div
          tabIndex={0}
          role="region"
          aria-label="Destinations ranked by group fare total"
          className="bg-card focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
        >
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="text-muted-foreground px-4 pt-3 text-left text-xs">
              Round-trip fares per adult from each origin, ranked by total group
              fare.
            </caption>
            <thead>
              <tr className="text-muted-foreground border-b text-left text-xs">
                <th className="px-4 py-2 font-medium">Destination</th>
                {current?.origins.map((o) => (
                  <th key={o} className="px-3 py-2 text-right font-medium">
                    {o}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Group</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.complete.map((row) => {
                const listed = trip.options.some(
                  (o) => o.destination === row.offer.key,
                )
                return (
                  <tr key={row.offer.key} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-medium">{row.offer.city}</span>{' '}
                      <span className="text-muted-foreground text-xs">
                        {row.offer.key}
                      </span>
                    </td>
                    {current?.origins.map((o) => (
                      <td key={o} className="px-3 py-2 text-right tabular-nums">
                        {money(row.fares.get(o) ?? 0)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {money(row.total)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={listed}
                        onClick={() => onAdd(row.offer)}
                      >
                        {listed ? 'Listed' : 'Add'}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {rows.partial > 0 && pending === 0 ? (
        <p className="text-muted-foreground text-xs">
          {rows.partial} more destinations had fares from only some airports.
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
  onWatch,
}: Pick<PanelProps, 'trip' | 'me' | 'update'> & {
  option: TripOption
  pricing: boolean
  onPrice: () => void
  onWatch: () => void
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
          <span className="text-muted-foreground">Cannot make dates: </span>
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
            </span>{' '}
            <span className="text-muted-foreground text-xs">
              Priced{' '}
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
            <>
              <Button
                size="sm"
                variant={cost ? 'ghost' : 'secondary'}
                onClick={onPrice}
              >
                <Search aria-hidden />{' '}
                {cost ? 'Price again' : 'Price for everyone'}
              </Button>
              <Button size="sm" variant="outline" onClick={onWatch}>
                <Eye aria-hidden /> Watch prices
              </Button>
            </>
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
              <Star aria-hidden /> Favourite
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">
              {votes?.approvals ?? 0} approve, {votes?.favourites ?? 0} fav
            </span>
          </>
        ) : null}
        {me.role === 'owner' && option.status === 'candidate' && !poll ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground ml-auto"
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
      className="bg-card grid grid-cols-1 gap-3 rounded-lg border p-4 @xl:grid-cols-2 @4xl:grid-cols-[2fr_1fr_1fr_1fr_auto] @4xl:items-end"
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
          placeholder="Lisbon, Portugal"
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

export default function CoordinatorPanel(props: PanelProps) {
  const { trip, me, update, go, actAs, runWatches } = props
  const [nights, setNights] = useState(7)
  const [picked, setPicked] = useState<Window | null>(null)
  const [pricingIds, setPricingIds] = useState<ReadonlySet<string>>(new Set())
  const [memberName, setMemberName] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
  const isOwner = me.role === 'owner'
  const nudge = buildNudge(trip, me.id)

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

  const pushToMonitor = (option: TripOption) => {
    const res = watchOption(trip, option, newId)
    const addedWatches = res.trip.watches.filter((w) =>
      res.watchIds.includes(w.id),
    )
    update((t) => {
      const existingIds = new Set(t.watches.map((w) => w.id))
      return {
        ...t,
        watches: [
          ...t.watches.map((w) =>
            res.watchIds.includes(w.id) ? { ...w, standalone: true } : w,
          ),
          ...addedWatches.filter((w) => !existingIds.has(w.id)),
        ],
      }
    })
    void runWatches(addedWatches)
    go('prices')
  }

  return (
    <div className="space-y-10">
      {/* Band 1: Your Answers + Group Date Overlap Matrix */}
      <div className="grid grid-cols-1 gap-8 @5xl:grid-cols-[24rem_minmax(0,1fr)] @5xl:items-start">
        <AnswersCard key={me.id} trip={trip} me={me} update={update} />

        <Section
          title="Group date overlap"
          description={`From the dates ${answering} ${answering === 1 ? 'person has' : 'people have'} given. Highlighted columns show the selected trip window.`}
        >
          <AvailabilityMatrix trip={trip} highlightWindow={span} />
          <div className="space-y-3 pt-1">
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
                No {nights}-night window fits anyone's dates yet.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                            : 'bg-card hover:bg-muted',
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
      </div>

      {/* Band 2: Destination Explorer + Shortlist & Voting */}
      <div
        className={cn(
          'grid grid-cols-1 gap-8',
          span &&
            '@7xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] @7xl:items-start',
        )}
      >
        {span ? (
          <Section
            title="Explore destinations"
            description={`Live Skiplagged fares from everyone's home airport for ${formatRange(span.start, span.end)}.`}
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
            title="Shortlist and vote"
            description="Compare real per-person flight and stay totals, send a candidate to the Price Monitor, or lock the winner."
            action={
              isOwner && !poll && candidates.length >= 2 ? (
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
                  <Vote aria-hidden /> Put shortlist to a vote
                </Button>
              ) : null
            }
          >
            {poll ? (
              <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm">
                <p>
                  <span className="font-semibold">{poll.question}</span> Approve
                  every option that works and mark one favourite. Closes{' '}
                  {formatDate(
                    new Date(poll.closesAt).toISOString().slice(0, 10),
                  )}
                  .{' '}
                  {leader ? (
                    <>
                      Leading:{' '}
                      <span className="font-semibold">{leader.label}</span> (
                      {leader.approvals} approve).
                    </>
                  ) : null}{' '}
                  <span className="text-foreground/75">
                    {notVoted.length === 0 ? (
                      'Everyone has voted.'
                    ) : (
                      <>
                        Waiting on: <People trip={trip} memberIds={notVoted} />
                      </>
                    )}
                  </span>
                </p>
                {isOwner && leader ? (
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
                      go('planner')
                    }}
                  >
                    <Lock aria-hidden /> Lock {leader.label.split(',')[0]}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {trip.options.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No destination options yet. Add one from the explorer or by hand
                below.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
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
                      onWatch={() => pushToMonitor(option)}
                    />
                  ))}
              </ul>
            )}

            {isOwner ? (
              <AddOption
                key={span?.start ?? 'none'}
                defaults={span}
                onAdd={(o) => update((t) => addOption(t, o, newId))}
              />
            ) : null}
          </Section>
        </div>
      </div>

      {/* Band 3: Group Roster + Chat Nudge Composer */}
      <div className="grid grid-cols-1 gap-8 @5xl:grid-cols-12 @5xl:items-start">
        <Section
          className="@5xl:col-span-8"
          title="Group roster"
          description="A member is a travelling party: one person, or a couple or family travelling together."
        >
          <ul className="grid grid-cols-1 gap-3 @6xl:grid-cols-2">
            {trip.members.map((m) => {
              const status = memberStatus(trip, m.id)
              return (
                <li
                  key={m.id}
                  className={cn(
                    'bg-card @container space-y-3 rounded-lg border p-4 text-sm',
                    m.rsvp === 'out' && 'opacity-60',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2.5">
                      <Avatar trip={trip} memberId={m.id} className="size-8" />
                      <span>
                        <span className="block font-semibold">{m.name}</span>
                        <span className="text-muted-foreground block text-xs">
                          {m.role === 'owner' ? 'Organizer' : 'Member'}
                        </span>
                      </span>
                    </span>
                    <Status tone={RSVP_TONE[m.rsvp]}>
                      {RSVP_LABEL[m.rsvp]}
                    </Status>
                  </div>
                  <dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-2 @lg:grid-cols-4">
                    <div>
                      <dt className="text-xs">Dates</dt>
                      <dd className="text-foreground">
                        {m.dates.length
                          ? m.dates
                              .map((r) => formatRange(r.start, r.end))
                              .join('; ')
                          : 'Not given'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs">From</dt>
                      <dd className="text-foreground">{homeText(m)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs">Party</dt>
                      <dd className="text-foreground">
                        {heads(m.party)}{' '}
                        {heads(m.party) === 1 ? 'person' : 'people'}
                        {m.budgetBand ? `, ${BANDS[m.budgetBand]}` : ''}
                      </dd>
                    </div>
                    <div className="col-span-2 @lg:col-span-1">
                      <dt className="text-xs">Travel</dt>
                      <dd className="text-foreground space-y-0.5">
                        <Status
                          tone={TRAVEL_STATUS[status.flight].tone}
                          className="flex"
                        >
                          Flight:{' '}
                          {TRAVEL_STATUS[status.flight].label.toLowerCase()}
                        </Status>
                        <Status
                          tone={TRAVEL_STATUS[status.stay].tone}
                          className="flex"
                        >
                          Stay: {TRAVEL_STATUS[status.stay].label.toLowerCase()}
                        </Status>
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2 border-t pt-2.5">
                    {m.id !== me.id ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => actAs(m.id)}
                      >
                        Answer as {m.name}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        Currently answering as you
                      </span>
                    )}
                    {isOwner && m.id !== me.id ? (
                      confirming === m.id ? (
                        <div className="ml-auto flex gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => update((t) => removeMember(t, m.id))}
                          >
                            <Trash2 aria-hidden /> Confirm remove
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirming(null)}
                          >
                            Keep
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground ml-auto"
                          onClick={() => setConfirming(m.id)}
                        >
                          <Trash2 aria-hidden /> Remove
                        </Button>
                      )
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>

          {isOwner ? (
            <form
              className="bg-card flex flex-wrap items-end gap-3 rounded-lg border p-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (!memberName.trim()) return
                update((t) => addMember(t, { name: memberName.trim(), newId }))
                setMemberName('')
              }}
            >
              <div className="min-w-48 flex-1">
                <Field
                  label="Add someone to the trip"
                  hint="Switch to them from the top bar to answer as them."
                >
                  <input
                    className={inputClass}
                    value={memberName}
                    onChange={(e) => setMemberName(e.target.value)}
                    placeholder="Jordan"
                    maxLength={60}
                  />
                </Field>
              </div>
              <Button
                type="submit"
                variant="secondary"
                disabled={!memberName.trim()}
              >
                <Plus aria-hidden /> Add member
              </Button>
            </form>
          ) : null}
        </Section>

        <div className="space-y-6 @5xl:col-span-4">
          <section
            aria-labelledby="nudge-composer"
            className="bg-card space-y-3 rounded-lg border p-5"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="nudge-composer" className="text-base font-semibold">
                Group chat nudge
              </h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(nudge).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="bg-muted/40 text-foreground rounded-md border p-3 text-xs leading-relaxed">
              {nudge}
            </p>
            <p className="text-muted-foreground text-xs">
              Paste into WhatsApp, iMessage or Slack to chase open answers and
              votes without writing it by hand.
            </p>
          </section>

          <WaitingOn trip={trip} me={me} actAs={actAs} />
        </div>
      </div>
    </div>
  )
}
