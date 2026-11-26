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
  ClipboardCopy,
  LayoutDashboard,
  Plus,
  RotateCcw,
  TrendingDown,
  Users,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { createTrip, recordSearch } from '@/lib/tripspace/actions'
import { formatRange } from '@/lib/tripspace/dates'
import { sampleTrips } from '@/lib/tripspace/demo'
import {
  chosenOption,
  findGaps,
  findIssues,
  nextAsks,
  stageOf,
  watchReport,
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

import CoordinatorPanel from './CoordinatorPanel'
import DashboardPanel from './DashboardPanel'
import PlannerPanel from './PlannerPanel'
import PricesPanel from './PricesPanel'
import { Avatar, buildNudge, Field, inputClass, money, Notice } from './parts'
import type { PanelProps, Tab } from './types'

const newId = () => crypto.randomUUID()

const PANELS: Record<Tab, ComponentType<PanelProps>> = {
  dashboard: DashboardPanel,
  planner: PlannerPanel,
  coordinator: CoordinatorPanel,
  prices: PricesPanel,
}

const STAGES: { stage: Stage; label: string; tab: Tab }[] = [
  { stage: 'idea', label: 'Idea', tab: 'coordinator' },
  { stage: 'shortlist', label: 'Shortlist', tab: 'coordinator' },
  { stage: 'plan', label: 'Plan', tab: 'planner' },
  { stage: 'booked', label: 'Booked', tab: 'prices' },
]

const NAV: {
  tab: Tab
  label: string
  short: string
  hint: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
}[] = [
  {
    tab: 'dashboard',
    label: 'Dashboard',
    short: 'Home',
    hint: 'Readiness, alerts, spend',
    icon: LayoutDashboard,
  },
  {
    tab: 'planner',
    label: 'Trip Planner',
    short: 'Plan',
    hint: 'Timeline, travel, ideas',
    icon: CalendarRange,
  },
  {
    tab: 'coordinator',
    label: 'Coordinator',
    short: 'Group',
    hint: 'Dates, shortlist, vote',
    icon: Users,
  },
  {
    tab: 'prices',
    label: 'Price Monitor',
    short: 'Prices',
    hint: 'Charts, targets, drops',
    icon: TrendingDown,
  },
]

function withSamples(stored: Stored | null): Stored {
  const seeded = sampleTrips({ newId, now: Date.now() })
  const first = seeded[0]
  const acting: Record<string, string> = { ...(stored?.actingAs ?? {}) }
  for (const trip of seeded) {
    if (trip.members[0]) acting[trip.id] = trip.members[0].id
  }
  return {
    version: 1,
    trips: [...seeded, ...(stored?.trips ?? [])],
    activeTripId: first?.id ?? stored?.activeTripId ?? null,
    actingAs: acting,
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

/** Attention badges per workspace, derived from the live trip model. */
function workspaceBadges(
  trip: Trip,
  me: Member,
): Partial<Record<Tab, { count: number; label: string }>> {
  const out: Partial<Record<Tab, { count: number; label: string }>> = {}
  const option = chosenOption(trip)
  const report = watchReport(trip)
  if (option) {
    const open = findGaps(trip, option).length + findIssues(trip, option).length
    if (open > 0)
      out.planner = { count: open, label: `${open} to sort in planner` }
  }
  const answering = trip.members.filter(
    (m) =>
      m.rsvp !== 'out' &&
      (m.rsvp === 'invited' ||
        m.dates.length === 0 ||
        m.home.kind === 'unanswered'),
  ).length
  const poll = trip.polls.find((p) => p.status === 'open')
  const needVote = poll && !poll.votes.some((v) => v.memberId === me.id) ? 1 : 0
  if (answering + needVote > 0) {
    out.coordinator = {
      count: answering + needVote,
      label: `${answering + needVote} open in coordinator`,
    }
  }
  if (report.alertsCount > 0) {
    out.prices = {
      count: report.alertsCount,
      label: `${report.alertsCount} price ${report.alertsCount === 1 ? 'alert' : 'alerts'}`,
    }
  }
  return out
}

export default function Tripspace() {
  const [stored, setStored] = useState<Stored | null>(null)
  const [storageNote, setStorageNote] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [copiedNudge, setCopiedNudge] = useState(false)
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
        'A trip saved in this browser could not be read. It was kept aside and the sample trips opened instead.',
      )
    }
    setStored(withSamples(null))
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
  const badges = workspaceBadges(trip, me)
  const report = watchReport(trip)
  const going = trip.members.filter((m) => m.rsvp === 'in').length
  const maybe = trip.members.filter((m) => m.rsvp === 'maybe').length
  const nudge = buildNudge(trip, me.id)

  const go = (next: Tab) => {
    setTab(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const actAs = (memberId: string) =>
    setStored((prev) =>
      prev
        ? { ...prev, actingAs: { ...prev.actingAs, [trip.id]: memberId } }
        : prev,
    )

  const panelProps: PanelProps = {
    trip,
    me,
    update: (change) => updateTrip(trip.id, change),
    go,
    actAs,
    runWatches,
    busyWatches: busy,
  }

  const where = option
    ? `${option.label}, ${formatRange(option.depart, option.return)}`
    : stage === 'shortlist'
      ? `Voting between ${trip.options.filter((o) => o.status === 'candidate').length} places`
      : 'Gathering group answers'

  return (
    <Tabs
      value={tab}
      onValueChange={(value) =>
        setTab(NAV.find((n) => n.tab === value)?.tab ?? 'dashboard')
      }
      orientation={wide ? 'vertical' : 'horizontal'}
    >
      {storageNote ? (
        <div className="mb-4">
          <Notice tone="error">{storageNote}</Notice>
        </div>
      ) : null}

      {/* Unified Command Bar */}
      <div className="bg-card mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <TripSwitcher
            stored={stored}
            trip={trip}
            onPick={(tripId) => {
              setStored((prev) =>
                prev ? { ...prev, activeTripId: tripId } : prev,
              )
              setTab('dashboard')
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
                      trips: [created, ...prev.trips],
                      activeTripId: created.id,
                      actingAs: {
                        ...prev.actingAs,
                        [created.id]: created.members[0]?.id ?? '',
                      },
                    }
                  : prev,
              )
              setTab('coordinator')
            }}
            onResetSamples={() => {
              setStored((prev) => withSamples(prev))
              setTab('dashboard')
            }}
          />
          <p className="text-muted-foreground text-xs sm:text-sm">
            {where} · {going} in{maybe > 0 ? `, ${maybe} maybe` : ''}
          </p>
        </div>

        {/* Inline Stage Lifecycle Pipeline (status, distinct from nav) */}
        <nav aria-label="Trip stage" className="hidden xl:block">
          <ol className="flex items-center gap-1">
            {STAGES.map((s, index) => {
              const current = s.stage === stage
              const past = index < stageIndex
              return (
                <li key={s.stage} className="flex items-center gap-1">
                  {index > 0 ? (
                    <span
                      aria-hidden
                      className="bg-border inline-block h-px w-3"
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => go(s.tab)}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'focus-visible:ring-ring inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none',
                      current
                        ? 'bg-secondary text-secondary-foreground border font-semibold'
                        : past
                          ? 'text-foreground hover:bg-accent'
                          : 'text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'inline-flex size-4 items-center justify-center rounded-full text-[0.65rem] font-semibold',
                        current
                          ? 'bg-primary text-primary-foreground'
                          : past
                            ? 'bg-muted text-foreground'
                            : 'border border-dashed',
                      )}
                    >
                      {past ? <Check className="size-2.5" /> : index + 1}
                    </span>
                    {s.label}
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <IdentityMenu trip={trip} me={me} actAs={actAs} />
      </div>

      {/* Main Workspace Shell: Slim Rail + Full-Width Canvas */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
        <aside
          aria-label="Workspace navigation"
          className="min-w-0 space-y-5 lg:sticky lg:top-24 lg:self-start"
        >
          <TabsList className="bg-muted text-foreground/75 grid h-auto w-full grid-cols-2 gap-1 p-1 min-[380px]:grid-cols-4 lg:flex lg:flex-col lg:items-stretch lg:gap-1 lg:bg-transparent lg:p-0">
            {NAV.map(({ tab: value, label, short, hint, icon: Icon }) => {
              const badge = badges[value]
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="text-foreground/75 hover:text-foreground data-[state=active]:text-foreground lg:data-[state=active]:bg-accent lg:data-[state=active]:border-border min-w-0 justify-center gap-1.5 px-1.5 py-2 sm:px-2.5 lg:justify-start lg:gap-2 lg:rounded-lg lg:border lg:border-transparent lg:px-3 lg:py-2.5 lg:data-[state=active]:shadow-none"
                >
                  <Icon
                    className="hidden size-4 shrink-0 lg:block"
                    aria-hidden
                  />
                  <span className="truncate text-xs sm:text-sm lg:hidden">
                    {short}
                  </span>
                  <span className="hidden min-w-0 flex-1 text-left lg:block">
                    <span className="block truncate text-sm leading-tight font-medium">
                      {label}
                    </span>
                    <span className="text-foreground/70 block truncate text-[0.7rem] font-normal">
                      {hint}
                    </span>
                  </span>
                  {badge ? (
                    <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[0.7rem] leading-5 font-semibold tabular-nums lg:ml-auto">
                      <span aria-hidden>{badge.count}</span>
                      <span className="sr-only">, {badge.label}</span>
                    </span>
                  ) : null}
                </TabsTrigger>
              )
            })}
          </TabsList>

          {/* Compact Desktop Rail Pulse (never scrolls off-screen) */}
          <div className="bg-card hidden space-y-3 rounded-lg border p-3.5 text-xs lg:block">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground font-medium tracking-wider uppercase">
                Live pulse
              </span>
              <span className="font-medium capitalize">{stage}</span>
            </div>
            {report.potentialSavingsMinor > 0 ? (
              <button
                type="button"
                onClick={() => go('prices')}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:ring-ring flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="inline-flex items-center gap-1.5 font-semibold">
                  <TrendingDown
                    className="text-chart-2 size-3.5 shrink-0"
                    aria-hidden
                  />
                  {money(report.potentialSavingsMinor)} drop
                </span>
                <span>Inspect</span>
              </button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="w-full justify-start"
              onClick={() => {
                void navigator.clipboard.writeText(nudge).then(() => {
                  setCopiedNudge(true)
                  window.setTimeout(() => setCopiedNudge(false), 2000)
                })
              }}
            >
              {copiedNudge ? (
                <Check aria-hidden />
              ) : (
                <ClipboardCopy aria-hidden />
              )}
              {copiedNudge ? 'Copied nudge' : 'Copy group nudge'}
            </Button>
          </div>
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
      </div>
    </Tabs>
  )
}

function IdentityMenu({
  trip,
  me,
  actAs,
}: Pick<PanelProps, 'trip' | 'me' | 'actAs'>) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const myAsks = nextAsks(trip, me.id).length

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

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent focus-visible:ring-ring inline-flex min-h-9 items-center gap-2 rounded-full border py-1 pr-3 pl-1.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <Avatar
          trip={trip}
          memberId={me.id}
          className="size-6 text-[0.65rem]"
        />
        <span className="max-w-36 truncate font-medium">{me.name}</span>
        {myAsks > 0 ? (
          <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[0.7rem] leading-4 font-semibold tabular-nums">
            {myAsks}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            'text-muted-foreground size-3.5 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          id={panelId}
          className="bg-popover text-popover-foreground absolute right-0 z-30 mt-2 w-[min(18rem,calc(100vw-2rem))] space-y-2 rounded-lg border p-2 shadow-lg"
        >
          <p className="text-muted-foreground px-2 pt-1 text-xs">
            Acting as (shared screen prototype)
          </p>
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
                      'hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none',
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
        </div>
      ) : null}
    </div>
  )
}

function TripSwitcher({
  stored,
  trip,
  onPick,
  onCreate,
  onResetSamples,
}: {
  stored: Stored
  trip: Trip
  onPick: (tripId: string) => void
  onCreate: (title: string, ownerName: string) => void
  onResetSamples: () => void
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
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
        className="hover:bg-accent focus-visible:ring-ring -ml-2 inline-flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="text-xl font-semibold tracking-tight sm:text-2xl">
          {trip.title}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          id={panelId}
          className="bg-popover text-popover-foreground absolute left-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] space-y-1 rounded-lg border p-2 shadow-lg"
        >
          <p className="text-muted-foreground px-2 pt-1 text-xs">
            Trips in this browser ({stored.trips.length})
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
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {t.title}
                  </span>
                  <span className="text-muted-foreground text-xs capitalize">
                    {stageOf(t)}
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
              onResetSamples()
              close()
            }}
            className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCcw className="size-4 shrink-0" aria-hidden /> Load sample
            trips
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
