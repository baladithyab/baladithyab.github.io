import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { InfluenceSource } from '@/lib/meeting-influence'
import {
  eventSources,
  fetchEvents,
  fetchTraffic,
  trafficSources,
  type LiveResult,
} from '@/lib/meeting-live'
import type {
  EventWindow,
  IncidentKind,
  LiveEvent,
  TrafficIncident,
} from '@/lib/meeting-live-server'
import type { MeetingNetwork } from '@/lib/meeting-point'

export type MeetingLiveLayersProps = {
  bounds: MeetingNetwork['bounds']
  onSourcesChange: (sources: InfluenceSource[]) => void
}

type LayerState<T> = { kind: 'off' } | { kind: 'loading' } | LiveResult<T>

const windowLabel: Record<EventWindow, string> = {
  day: 'next 24 hours',
  week: 'next 7 days',
}
const kindOrder: IncidentKind[] = [
  'closure',
  'accident',
  'roadworks',
  'jam',
  'other',
]
const kindNames: Record<IncidentKind, [one: string, many: string]> = {
  closure: ['closure', 'closures'],
  accident: ['accident', 'accidents'],
  roadworks: ['roadworks site', 'roadworks sites'],
  jam: ['traffic jam', 'traffic jams'],
  other: ['other incident', 'other incidents'],
}
const clock = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})
const eventTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})
const count = (n: number, [one, many]: [string, string]) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * Fetches one layer while `request` is non-null. Changing `request` or
 * calling `refresh` aborts the previous request and starts a new one.
 */
function useLiveLayer<T>(
  request: string | null,
  load: (signal: AbortSignal) => Promise<LiveResult<T>>,
): [LayerState<T>, () => void] {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    key: string
    value: LiveResult<T>
  } | null>(null)
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })
  const key = request === null ? null : `${request}#${attempt}`
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    loader.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ key, value })
      },
      () => {
        if (controller.signal.aborted) return
        setResult({
          key,
          value: {
            kind: 'error',
            reason: 'site',
            message: 'Something went wrong while loading. Retry.',
          },
        })
      },
    )
    return () => controller.abort()
  }, [key])
  const state: LayerState<T> =
    key === null
      ? { kind: 'off' }
      : result?.key === key
        ? result.value
        : { kind: 'loading' }
  return [state, () => setAttempt((value) => value + 1)]
}

function LayerSwitch({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm font-medium">
          {label}
        </label>
        <p
          id={`${id}-description`}
          className="text-muted-foreground mt-1 text-xs leading-relaxed"
        >
          {description}
        </p>
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="accent-foreground mt-0.5 size-5 shrink-0 cursor-pointer"
        checked={checked}
        aria-describedby={`${id}-description`}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </div>
  )
}

/** Loading, not configured and error states shared by both layers. */
function LayerStatus<T>({
  state,
  layer,
  loading,
  unconfigured,
  onRetry,
  children,
}: {
  state: LayerState<T>
  layer: string
  loading: string
  unconfigured: string
  onRetry: () => void
  children: (items: T[], fetched: string) => ReactNode
}) {
  if (state.kind === 'off') return null
  if (state.kind === 'loading')
    return (
      <p role="status" aria-busy="true" className="text-muted-foreground text-sm">
        {loading}
      </p>
    )
  if (state.kind === 'unconfigured')
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {unconfigured}
      </p>
    )
  if (state.kind === 'error')
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>{state.message}</p>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Retry ${layer}`}
          onClick={onRetry}
        >
          <RotateCcw />
          Retry
        </Button>
      </div>
    )
  return (
    <div className="space-y-2">
      {children(state.items, state.fetched)}
      <Button
        variant="outline"
        size="sm"
        aria-label={`Refresh ${layer}`}
        onClick={onRetry}
      >
        <RefreshCw />
        Refresh
      </Button>
    </div>
  )
}

function TrafficSummary({
  incidents,
  fetched,
}: {
  incidents: TrafficIncident[]
  fetched: string
}) {
  // An incident that leaves and re-enters the area arrives as parts `id`, `id~1`, ….
  const kinds = new Map<string, IncidentKind>()
  for (const incident of incidents)
    kinds.set(incident.id.replace(/~\d+$/, ''), incident.kind)
  const tally = kindOrder
    .map((kind) => ({
      kind,
      n: [...kinds.values()].filter((item) => item === kind).length,
    }))
    .filter(({ n }) => n > 0)
  const updated = `Updated ${clock.format(new Date(fetched))}.`
  return (
    <p role="status" className="text-sm">
      {kinds.size === 0
        ? `No traffic incidents reported in this area. ${updated}`
        : `${count(kinds.size, ['incident', 'incidents'])} nearby: ${tally
            .map(({ kind, n }) => count(n, kindNames[kind]))
            .join(', ')}. Meeting spots near them rank lower. ${updated}`}
    </p>
  )
}

function EventsSummary({
  events,
  fetched,
  eventWindow,
}: {
  events: LiveEvent[]
  fetched: string
  eventWindow: EventWindow
}) {
  const venues = new Set(events.map((event) => event.coordinate.join(','))).size
  const updated = `Updated ${clock.format(new Date(fetched))}.`
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm">
        {events.length === 0
          ? `No events found in this area in the ${windowLabel[eventWindow]}. ${updated}`
          : `${count(events.length, ['event', 'events'])} in the ${windowLabel[eventWindow]} at ${count(venues, ['venue', 'venues'])}. ${updated}`}
      </p>
      {events.length > 0 && (
        <ul className="space-y-1 text-sm">
          {events.slice(0, 3).map((event) => (
            <li key={event.id} className="leading-snug">
              {event.url ? (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {event.name}
                  <span className="sr-only"> (opens Ticketmaster in a new tab)</span>
                </a>
              ) : (
                <span className="font-medium">{event.name}</span>
              )}
              <span className="text-muted-foreground block text-xs">
                {event.start
                  ? eventTime.format(new Date(event.start))
                  : 'Time not announced'}{' '}
                · {event.venue}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function MeetingLiveLayers({
  bounds,
  onSourcesChange,
}: MeetingLiveLayersProps) {
  const [trafficOn, setTrafficOn] = useState(false)
  const [eventsOn, setEventsOn] = useState(false)
  const [eventWindow, setEventWindow] = useState<EventWindow>('day')
  const [polarity, setPolarity] = useState<1 | -1>(1)
  const [west, south, east, north] = bounds
  const area = `${west},${south},${east},${north}`

  const [traffic, refreshTraffic] = useLiveLayer(
    trafficOn ? `traffic|${area}` : null,
    (signal) => fetchTraffic([west, south, east, north], signal),
  )
  const [events, refreshEvents] = useLiveLayer(
    eventsOn ? `events|${area}|${eventWindow}` : null,
    (signal) => fetchEvents([west, south, east, north], eventWindow, signal),
  )

  const trafficItems = traffic.kind === 'ready' ? traffic.items : null
  const eventItems = events.kind === 'ready' ? events.items : null
  const sources = useMemo(
    () => [
      ...(trafficItems ? trafficSources(trafficItems) : []),
      ...(eventItems ? eventSources(eventItems, polarity) : []),
    ],
    [trafficItems, eventItems, polarity],
  )
  const notify = useRef(onSourcesChange)
  useEffect(() => {
    notify.current = onSourcesChange
  })
  useEffect(() => {
    notify.current(sources)
  }, [sources])

  return (
    <section
      className="bg-card space-y-4 rounded-xl border p-4 sm:p-5"
      aria-labelledby="meeting-live"
    >
      <div>
        <h2 id="meeting-live" className="text-lg font-semibold">
          Live conditions
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Optional. Rank meeting spots lower near traffic trouble, and nearer
          to or farther from events.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <LayerSwitch
          id="meeting-live-traffic"
          label="Live traffic"
          description="Avoid spots near current jams, closures, road works and accidents."
          checked={trafficOn}
          onChange={(on) => {
            setTrafficOn(on)
            if (on) refreshTraffic()
          }}
        />
        <LayerStatus
          state={traffic}
          layer="live traffic"
          loading="Checking live traffic…"
          unconfigured="Live traffic is not configured on this site."
          onRetry={refreshTraffic}
        >
          {(items, fetched) => (
            <TrafficSummary incidents={items} fetched={fetched} />
          )}
        </LayerStatus>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <LayerSwitch
          id="meeting-live-events"
          label="Events"
          description="Concerts, games and shows at venues in this area."
          checked={eventsOn}
          onChange={(on) => {
            setEventsOn(on)
            if (on) refreshEvents()
          }}
        />
        {eventsOn && (
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-medium">When</legend>
              {(['day', 'week'] satisfies EventWindow[]).map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="meeting-live-window"
                    className="accent-foreground"
                    checked={eventWindow === value}
                    onChange={() => setEventWindow(value)}
                  />
                  {value === 'day' ? 'Next 24 hours' : 'Next 7 days'}
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-medium">
                Meeting spots should
              </legend>
              {(
                [
                  { value: 1, label: 'Be near events' },
                  { value: -1, label: 'Steer away from events' },
                ] satisfies { value: 1 | -1; label: string }[]
              ).map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="meeting-live-polarity"
                    className="accent-foreground"
                    checked={polarity === option.value}
                    onChange={() => setPolarity(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          </div>
        )}
        <LayerStatus
          state={events}
          layer="events"
          loading={`Looking for events in the ${windowLabel[eventWindow]}…`}
          unconfigured="Events are not configured on this site."
          onRetry={refreshEvents}
        >
          {(items, fetched) => (
            <EventsSummary
              events={items}
              fetched={fetched}
              eventWindow={eventWindow}
            />
          )}
        </LayerStatus>
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Turning a layer on sends only this area’s boundaries to this site, which
        asks TomTom for traffic or Ticketmaster for events. Starting locations
        are never sent. This site keeps event listings for up to 30 minutes and
        does not store traffic. Traffic data © TomTom. Event listings from
        Ticketmaster.
      </p>
    </section>
  )
}
