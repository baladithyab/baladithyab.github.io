import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
} from 'react'
import {
  CalendarRange,
  Check,
  ChevronDown,
  Compass,
  House,
  Lightbulb,
  Plus,
  RotateCcw,
  TrendingDown,
  Users,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { createTrip, ideasOf, recordSearch } from '@/lib/tripspace/actions'
import { formatRange } from '@/lib/tripspace/dates'
import { sampleTrip } from '@/lib/tripspace/demo'
import {
  chosenOption,
  findGaps,
  findIssues,
  latest,
  matchKey,
  nextAsks,
  stageOf,
  type Member,
  type Stage,
  type Trip,
  type Watch,
} from '@/lib/tripspace/model'
import { searchEach } from '@/lib/tripspace/search'
import {
  loadStored,
  saveStored,
  setAside,
  type Stored,
} from '@/lib/tripspace/store'

import { DecisionLog, NextStep, WaitingOn } from './Briefing'
import DecidePanel from './DecidePanel'
import HomePanel from './HomePanel'
import IdeasPanel from './IdeasPanel'
import PeoplePanel from './PeoplePanel'
import PlanPanel from './PlanPanel'
import PricesPanel from './PricesPanel'
import { Avatar, Field, inputClass, Notice } from './parts'
import type { PanelProps, Tab } from './types'

const newId = () => crypto.randomUUID()

const PANELS: Record<Tab, ComponentType<PanelProps>> = {
  home: HomePanel,
  people: PeoplePanel,
  decide: DecidePanel,
  plan: PlanPanel,
  ideas: IdeasPanel,
  prices: PricesPanel,
}

const STAGES: { stage: Stage; label: string; hint: string; tab: Tab }[] = [
  { stage: 'idea', label: 'Idea', hint: 'Who is in, and when', tab: 'people' },
  {
    stage: 'shortlist',
    label: 'Shortlist',
    hint: 'Pick a place together',
    tab: 'decide',
  },
  {
    stage: 'plan',
    label: 'Plan',
    hint: "Everyone's flights and beds",
    tab: 'plan',
  },
  {
    stage: 'booked',
    label: 'Booked',
    hint: 'Watch for price drops',
    tab: 'prices',
  },
]

const NAV: {
  tab: Tab
  label: string
  short: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}[] = [
  { tab: 'home', label: 'Overview', short: 'Overview', icon: House },
  { tab: 'people', label: 'People', short: 'People', icon: Users },
  { tab: 'decide', label: 'Where and when', short: 'Decide', icon: Compass },
  { tab: 'plan', label: 'Travel plan', short: 'Travel', icon: CalendarRange },
  { tab: 'ideas', label: 'Things to do', short: 'Ideas', icon: Lightbulb },
  { tab: 'prices', label: 'Prices', short: 'Prices', icon: TrendingDown },
]

function withSample(stored: Stored | null): Stored {
  const trip = sampleTrip({ newId, now: Date.now() })
  const owner = trip.members[0]
  return {
    version: 1,
    trips: [...(stored?.trips ?? []), trip],
    activeTripId: trip.id,
    actingAs: {
      ...(stored?.actingAs ?? {}),
      ...(owner ? { [trip.id]: owner.id } : {}),
    },
  }
}

/** True while the viewport is at least `px` wide. */
function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)
    list.addEventListener('change', onChange)
    onChange()
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** What each view is waiting on, from the viewer's side. Shown as a count next to the view's name. */
function attention(
  trip: Trip,
  me: Member,
): Partial<Record<Tab, { count: number; label: string }>> {
  const out: Partial<Record<Tab, { count: number; label: string }>> = {}
  const answering = trip.members.filter(
    (m) =>
      m.rsvp !== 'out' &&
      (m.rsvp === 'invited' ||
        m.dates.length === 0 ||
        m.home.kind === 'unanswered'),
  ).length
  if (answering > 0)
    out.people = { count: answering, label: `${answering} still answering` }
  const poll = trip.polls.find((p) => p.status === 'open')
  if (poll && !poll.votes.some((v) => v.memberId === me.id))
    out.decide = { count: 1, label: 'your vote is open' }
  const option = chosenOption(trip)
  if (option) {
    const open = findGaps(trip, option).length + findIssues(trip, option).length
    if (open > 0) out.plan = { count: open, label: `${open} to sort out` }
  }
  const unsorted = ideasOf(trip).filter(
    (i) => !i.participants.some((p) => p.memberId === me.id),
  ).length
  if (unsorted > 0)
    out.ideas = {
      count: unsorted,
      label: `${unsorted} ideas you have not sorted`,
    }
  const drops = trip.items.filter((i) => {
    if (
      i.status !== 'booked' ||
      i.paidMinor === null ||
      i.detail.kind !== 'flight'
    )
      return false
    const key = matchKey(i)
    const watch = trip.watches.find((w) => w.id === i.watchId)
    const now = key && watch ? latest(watch.tracked[key]) : null
    return now !== null && now < i.paidMinor
  }).length
  if (drops > 0)
    out.prices = {
      count: drops,
      label: `${drops} booked ${drops === 1 ? 'price has' : 'prices have'} dropped`,
    }
  return out
}

export default function Tripspace() {
  const [stored, setStored] = useState<Stored | null>(null)
  const [storageNote, setStorageNote] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const storedRef = useRef<Stored | null>(null)
  storedRef.current = stored
  const wide = useMinWidth(1024)

  useEffect(() => {
    const result = loadStored(window.localStorage)
    if (result.kind === 'loaded' && result.stored.trips.length > 0) {
      setStored(result.stored)
      return
    }
    if (result.kind === 'unreadable') {
      setAside(window.localStorage, result.raw, Date.now())
      setStorageNote(
        'A trip saved in this browser could not be read. It was kept aside and the sample trip opened instead.',
      )
    }
    setStored(withSample(null))
  }, [])

  useEffect(() => {
    if (stored && !saveStored(window.localStorage, stored)) {
      setStorageNote(
        'This browser did not let the page save. Changes will be lost when the tab closes.',
      )
    }
  }, [stored])

  const updateTrip = useCallback(
    (tripId: string, change: (trip: Trip) => Trip) => {
      setStored((prev) =>
        prev
          ? {
              ...prev,
              trips: prev.trips.map((t) => (t.id === tripId ? change(t) : t)),
            }
          : prev,
      )
    },
    [],
  )

  const runWatches = useCallback(
    async (watches: Pick<Watch, 'id' | 'request'>[]) => {
      const tripId = storedRef.current?.activeTripId
      if (!tripId) return
      setBusy((prev) => new Set([...prev, ...watches.map((w) => w.id)]))
      await searchEach(
        watches.map((w) => ({ key: w.id, request: w.request })),
        (watchId, response) => {
          updateTrip(tripId, (t) =>
            recordSearch(t, watchId, response, Date.now()),
          )
          setBusy((prev) => new Set([...prev].filter((id) => id !== watchId)))
        },
      )
    },
    [updateTrip],
  )

  if (!stored) {
    return <p className="text-muted-foreground text-sm">Opening your trips.</p>
  }

  const trip =
    stored.trips.find((t) => t.id === stored.activeTripId) ?? stored.trips[0]
  if (!trip) return null
  const me =
    trip.members.find((m) => m.id === stored.actingAs[trip.id]) ??
    trip.members[0]
  if (!me) return null
  const stage = stageOf(trip)
  const stageIndex = STAGES.findIndex((s) => s.stage === stage)
  const option = chosenOption(trip)
  const badges = attention(trip, me)
  const going = trip.members.filter((m) => m.rsvp === 'in').length
  const maybe = trip.members.filter((m) => m.rsvp === 'maybe').length

  const go = (next: Tab) => {
    setTab(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const panelProps: PanelProps = {
    trip,
    me,
    update: (change) => updateTrip(trip.id, change),
    go,
    actAs: (memberId) =>
      setStored((prev) =>
        prev
          ? { ...prev, actingAs: { ...prev.actingAs, [trip.id]: memberId } }
          : prev,
      ),
    runWatches,
    busyWatches: busy,
  }
  const where = option
    ? `${option.label}, ${formatRange(option.depart, option.return)}`
    : stage === 'shortlist'
      ? `Choosing between ${trip.options.filter((o) => o.status === 'candidate').length} places`
      : 'Gathering answers'

  return (
    <Tabs
      value={tab}
      onValueChange={(value) =>
        setTab(NAV.find((n) => n.tab === value)?.tab ?? 'home')
      }
      orientation={wide ? 'vertical' : 'horizontal'}
    >
      {storageNote ? (
        <div className="mb-6">
          <Notice tone="error">{storageNote}</Notice>
        </div>
      ) : null}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 lg:mb-8">
        <div className="min-w-0 space-y-1">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {trip.title}
          </h2>
          <p className="text-muted-foreground text-sm">
            {where}. {going} going{maybe > 0 ? `, ${maybe} maybe` : ''}.
          </p>
        </div>
        <TripMenu
          stored={stored}
          trip={trip}
          onPick={(tripId) => {
            setStored((prev) =>
              prev ? { ...prev, activeTripId: tripId } : prev,
            )
            setTab('home')
          }}
          onCreate={(title, ownerName) => {
            const created = createTrip({
              title,
              ownerName,
              newId,
              now: Date.now(),
            })
            setStored((prev) =>
              prev
                ? {
                    ...prev,
                    trips: [...prev.trips, created],
                    activeTripId: created.id,
                    actingAs: {
                      ...prev.actingAs,
                      [created.id]: created.members[0]?.id ?? '',
                    },
                  }
                : prev,
            )
            setTab('people')
          }}
          onSample={() => {
            setStored((prev) => withSample(prev))
            setTab('home')
          }}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8 2xl:grid-cols-[16rem_minmax(0,1fr)_20rem] 2xl:gap-10">
        <aside
          aria-label="Trip navigation"
          className="min-w-0 space-y-5 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:space-y-8 lg:self-start lg:overflow-y-auto lg:pr-1"
        >
          <nav aria-label="Trip stage">
            <p className="text-muted-foreground mb-2 hidden text-xs font-medium tracking-widest uppercase lg:block">
              Stage
            </p>
            <ol className="flex gap-1 lg:flex-col lg:gap-0.5">
              {STAGES.map((s, index) => {
                const current = s.stage === stage
                const past = index < stageIndex
                return (
                  <li
                    key={s.stage}
                    className={cn(
                      current ? 'min-w-0 flex-1' : 'shrink-0',
                      'lg:flex-none',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => go(s.tab)}
                      aria-current={current ? 'step' : undefined}
                      className={cn(
                        'hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none lg:px-2',
                        current && 'bg-accent',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          current
                            ? 'bg-primary text-primary-foreground'
                            : past
                              ? 'bg-muted text-foreground'
                              : 'text-muted-foreground border border-dashed',
                        )}
                      >
                        {past ? <Check className="size-3.5" /> : index + 1}
                      </span>
                      <span
                        className={
                          current
                            ? 'min-w-0'
                            : 'sr-only lg:not-sr-only lg:min-w-0'
                        }
                      >
                        <span
                          className={cn(
                            'block truncate text-xs lg:text-sm',
                            current
                              ? 'font-semibold'
                              : past
                                ? 'text-foreground'
                                : 'text-muted-foreground',
                          )}
                        >
                          {s.label}
                          <span className="sr-only">
                            {current ? ', current stage' : past ? ', done' : ''}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'truncate text-xs',
                            current
                              ? 'text-foreground/80 block'
                              : 'text-muted-foreground hidden lg:block',
                          )}
                        >
                          {s.hint}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>

          <div>
            <p className="text-muted-foreground mb-2 hidden text-xs font-medium tracking-widest uppercase lg:block">
              Views
            </p>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 min-[360px]:grid-cols-3 md:grid-cols-6 lg:flex lg:flex-col lg:items-stretch lg:gap-0.5 lg:bg-transparent lg:p-0">
              {NAV.map(({ tab: value, label, short, icon: Icon }) => {
                const badge = badges[value]
                return (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="hover:text-foreground lg:data-[state=active]:bg-accent min-w-0 justify-start gap-2 px-2.5 py-2 lg:px-2 lg:data-[state=active]:shadow-none"
                  >
                    <Icon
                      className="hidden size-4 shrink-0 lg:block"
                      aria-hidden
                    />
                    <span className="truncate lg:hidden">{short}</span>
                    <span className="hidden truncate lg:inline">{label}</span>
                    {badge ? (
                      <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[0.7rem] leading-5 font-semibold tabular-nums">
                        <span aria-hidden>{badge.count}</span>
                        <span className="sr-only">, {badge.label}</span>
                      </span>
                    ) : null}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </div>

          <ViewingAs trip={trip} me={me} actAs={panelProps.actAs} />
        </aside>

        <div className="@container min-w-0">
          {NAV.map(({ tab: value }) => {
            const Panel = PANELS[value]
            return (
              <TabsContent
                key={value}
                value={value}
                className="mt-0 focus-visible:ring-offset-4"
              >
                <Panel {...panelProps} />
              </TabsContent>
            )
          })}
        </div>

        <aside
          aria-label="Your next step and the group"
          className="hidden space-y-8 self-start 2xl:sticky 2xl:top-24 2xl:block 2xl:max-h-[calc(100vh-7rem)] 2xl:overflow-y-auto"
        >
          <NextStep trip={trip} me={me} go={go} size="rail" />
          <WaitingOn trip={trip} me={me} actAs={panelProps.actAs} />
          <DecisionLog trip={trip} />
        </aside>
      </div>
    </Tabs>
  )
}

function ViewingAs({
  trip,
  me,
  actAs,
}: Pick<PanelProps, 'trip' | 'me' | 'actAs'>) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <section aria-label="Viewing as" className="space-y-2">
      <p className="text-muted-foreground hidden text-xs font-medium tracking-widest uppercase lg:block">
        Viewing as
      </p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none lg:hidden"
      >
        <Avatar trip={trip} memberId={me.id} className="size-7" />
        <span className="min-w-0 flex-1">
          Viewing as <span className="font-semibold">{me.name}</span>
        </span>
        <span className="text-muted-foreground text-xs">Switch</span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      <div
        id={listId}
        className={cn('space-y-2', open ? 'block' : 'hidden', 'lg:block')}
      >
        <ul className="space-y-0.5">
          {trip.members.map((m) => {
            const asks = nextAsks(trip, m.id).length
            const selected = m.id === me.id
            return (
              <li key={m.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    actAs(m.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-2 focus-visible:outline-none',
                    selected && 'bg-accent',
                  )}
                >
                  <Avatar trip={trip} memberId={m.id} className="size-7" />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate',
                        selected && 'font-semibold',
                      )}
                    >
                      {m.name}
                    </span>
                    <span
                      className={cn(
                        'block truncate text-xs',
                        selected
                          ? 'text-foreground/80'
                          : 'text-muted-foreground',
                      )}
                    >
                      {m.role === 'owner' ? 'Organizer, ' : ''}
                      {m.rsvp === 'out'
                        ? 'not coming'
                        : asks === 0
                          ? 'all set'
                          : `${asks} to do`}
                    </span>
                  </span>
                  {selected ? (
                    <Check className="size-4 shrink-0" aria-hidden />
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
        <p className="text-muted-foreground text-xs leading-relaxed">
          In this prototype the group shares one screen. Pick a person to
          answer, vote and choose as them.
        </p>
      </div>
    </section>
  )
}

function TripMenu({
  stored,
  trip,
  onPick,
  onCreate,
  onSample,
}: {
  stored: Stored
  trip: Trip
  onPick: (tripId: string) => void
  onCreate: (title: string, ownerName: string) => void
  onSample: () => void
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !wrapper.current?.contains(event.target)
      )
        setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    setCreating(false)
  }

  return (
    <div ref={wrapper} className="relative">
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Trips{' '}
        <span className="text-muted-foreground tabular-nums">
          {stored.trips.length}
        </span>
        <ChevronDown
          className={cn('transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </Button>
      {open ? (
        <div
          id={panelId}
          className="bg-popover text-popover-foreground absolute left-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] space-y-1 rounded-lg border p-2 shadow-lg sm:right-0 sm:left-auto"
        >
          <p className="text-muted-foreground px-2 pt-1 text-xs">
            Trips in this browser
          </p>
          <ul>
            {stored.trips.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-current={t.id === trip.id ? 'true' : undefined}
                  onClick={() => {
                    onPick(t.id)
                    close()
                  }}
                  className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Check
                    className={cn(
                      'size-4 shrink-0',
                      t.id === trip.id ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {t.members.length} people
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div role="separator" className="bg-border my-1 h-px" />
          {creating ? (
            <NewTripForm
              onCreate={(title, ownerName) => {
                onCreate(title, ownerName)
                close()
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <Plus className="size-4 shrink-0" aria-hidden /> New trip
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onSample()
              close()
            }}
            className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCcw className="size-4 shrink-0" aria-hidden /> Open a fresh
            sample trip
          </button>
        </div>
      ) : null}
    </div>
  )
}

function NewTripForm({
  onCreate,
}: {
  onCreate: (title: string, ownerName: string) => void
}) {
  const [title, setTitle] = useState('')
  const [name, setName] = useState('')
  const ready = title.trim().length > 0 && name.trim().length > 0
  return (
    <form
      className="space-y-3 px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onCreate(title.trim(), name.trim())
      }}
    >
      <Field label="Trip name">
        <input
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Somewhere warm in March"
          maxLength={80}
          autoFocus
        />
      </Field>
      <Field label="Your name">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Maya"
          maxLength={60}
        />
      </Field>
      <Button type="submit" size="sm" disabled={!ready}>
        Create trip
      </Button>
    </form>
  )
}
