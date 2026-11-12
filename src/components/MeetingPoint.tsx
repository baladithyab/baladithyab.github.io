import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownUp,
  ArrowRight,
  Check,
  MapPin,
  Pause,
  Play,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import MeetingMap, { originColor, type Origin } from '@/components/MeetingMap'
import {
  distanceBetween,
  nearestNode,
  parseNetwork,
  sfRegion,
  type Coordinate,
  type MeetingNetwork,
  type Objective,
  type SearchOutput,
  type SearchReply,
} from '@/lib/meeting-point'
import {
  findSearchCollisions,
  searchProgress,
  type SearchCollision,
} from '@/lib/meeting-collisions'

type NetworkState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; network: MeetingNetwork }
type RunState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'error'; message: string }
  | { kind: 'complete'; output: SearchOutput; objective: Objective }
type Place = { name: string; node: number }
const letter = (index: number) =>
  String.fromCharCode(65 + (index % 26)) +
  (index >= 26 ? String(Math.floor(index / 26)) : '')
const km = (metres: number) => `${(metres / 1000).toFixed(1)} km`

function LocationInput({
  origin,
  index,
  places,
  active,
  onActivate,
  onChange,
  onRemove,
  removable,
}: {
  origin: Origin
  index: number
  places: Place[]
  active: boolean
  onActivate: () => void
  onChange: (name: string, node: number | null) => void
  onRemove: () => void
  removable: boolean
}) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const matches = useMemo(() => {
    const query = origin.name.trim().toLocaleLowerCase()
    const words = query.split(/\s+/)
    const unique = new Set<string>()
    return places
      .filter((place) => {
        if (
          unique.has(place.name) ||
          !words.every((word) => place.name.toLocaleLowerCase().includes(word))
        )
          return false
        unique.add(place.name)
        return true
      })
      .slice(0, 7)
  }, [origin.name, places])
  const id = `meeting-origin-${origin.id}`
  const choose = (place: Place) => {
    onChange(place.name, place.node)
    setOpen(false)
  }
  return (
    <li className="relative">
      <div
        className={`flex items-center gap-2 rounded-lg border p-2 ${active ? 'border-foreground/50 bg-muted/50' : 'bg-background'}`}
      >
        <button
          type="button"
          className="focus-visible:outline-ring flex size-10 shrink-0 items-center justify-center rounded-md border text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ borderColor: originColor(index) }}
          aria-label={`Place location ${letter(index)} on the map`}
          aria-pressed={active}
          onClick={onActivate}
        >
          {letter(index)}
        </button>
        <div className="min-w-0 flex-1">
          <label
            htmlFor={id}
            className="text-muted-foreground block text-[0.625rem] font-medium tracking-wider uppercase"
          >
            Starting location {letter(index)}
          </label>
          <input
            id={id}
            className="focus-visible:ring-ring w-full min-w-0 bg-transparent py-1 text-sm outline-none focus-visible:rounded-sm focus-visible:ring-2"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-options`}
            aria-activedescendant={
              open && matches[highlight]
                ? `${id}-option-${highlight}`
                : undefined
            }
            aria-invalid={origin.node === null && origin.name.length > 0}
            aria-describedby={origin.node === null ? `${id}-hint` : undefined}
            value={origin.name}
            autoComplete="off"
            placeholder="Landmark or street intersection"
            autoFocus={origin.name === ''}
            onFocus={() => {
              onActivate()
              setOpen(true)
              setHighlight(0)
            }}
            onBlur={() => setOpen(false)}
            onChange={(event) => {
              onChange(event.target.value, null)
              setOpen(true)
              setHighlight(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false)
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setOpen(true)
                setHighlight((value) =>
                  Math.max(
                    0,
                    Math.min(
                      matches.length - 1,
                      value + (event.key === 'ArrowDown' ? 1 : -1),
                    ),
                  ),
                )
              }
              if (open && event.key === 'Home') {
                event.preventDefault()
                setHighlight(0)
              }
              if (open && event.key === 'End') {
                event.preventDefault()
                setHighlight(matches.length - 1)
              }
              if (open && event.key === 'Enter' && matches[highlight]) {
                event.preventDefault()
                choose(matches[highlight])
              }
            }}
          />
        </div>
        <Button
          variant="destructive"
          size="icon"
          className="shrink-0"
          aria-label={`Remove location ${letter(index)}`}
          disabled={!removable}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {origin.node === null && (
        <p
          id={`${id}-hint`}
          className="text-muted-foreground mt-1 px-2 text-xs"
        >
          Choose a suggestion or place this start on the map.
        </p>
      )}
      {open && (
        <ul
          id={`${id}-options`}
          role="listbox"
          aria-label={`Suggestions for location ${letter(index)}`}
          className="bg-popover absolute top-full z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border p-1 shadow-lg"
        >
          {matches.length ? (
            matches.map((place, i) => (
              <li
                key={`${place.name}-${place.node}`}
                id={`${id}-option-${i}`}
                role="option"
                aria-selected={highlight === i}
                className={`cursor-pointer rounded-md px-3 py-3 text-sm ${highlight === i ? 'bg-accent text-accent-foreground' : ''}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  choose(place)
                }}
                onPointerMove={() => setHighlight(i)}
              >
                {place.name}
              </li>
            ))
          ) : (
            <li className="text-muted-foreground px-3 py-3 text-sm">
              No local match. Try a street name, or click the map.
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

export default function MeetingPoint() {
  const [data, setData] = useState<NetworkState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [origins, setOrigins] = useState<Origin[]>([])
  const [active, setActive] = useState(0)
  const nextId = useRef(4)
  const [objective, setObjective] = useState<Objective>('fair')
  const [run, setRun] = useState<RunState>({ kind: 'idle' })
  const [selected, setSelected] = useState(0)
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [notice, setNotice] = useState('')
  const worker = useRef<Worker | null>(null)
  const reducedMotion = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setData({ kind: 'loading' })
    fetch(sfRegion.dataUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Road data could not be loaded (${response.status}).`)
        const value: unknown = await response.json()
        const network = parseNetwork(value)
        setData({ kind: 'ready', network })
        setOrigins(
          sfRegion.landmarks.slice(0, 4).map((place, id) => ({
            id,
            name: place.name,
            node: nearestNode(network, place.coordinate),
          })),
        )
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setData({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Road data could not be loaded.',
          })
      })
    return () => controller.abort()
  }, [attempt])
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      reducedMotion.current = preference.matches
      if (preference.matches) {
        setPlaying(false)
        setProgress(1)
      }
    }
    update()
    preference.addEventListener('change', update)
    return () => {
      preference.removeEventListener('change', update)
      worker.current?.terminate()
    }
  }, [])
  useEffect(() => {
    if (!playing) return
    let frame = 0
    let previous = performance.now()
    const tick = (now: number) => {
      const delta = ((now - previous) / 8000) * speed
      previous = now
      setProgress((value) => Math.min(1, value + delta))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed])
  useEffect(() => {
    if (progress >= 1) setPlaying(false)
  }, [progress])

  const network = data.kind === 'ready' ? data.network : null
  const places = useMemo(
    () =>
      network
        ? [
            ...sfRegion.landmarks.map((place) => ({
              name: place.name,
              node: nearestNode(network, place.coordinate),
            })),
            ...network.places,
          ]
        : [],
    [network],
  )
  const output = run.kind === 'complete' ? run.output : null
  const result = output?.results[selected]
  const collisions = useMemo<SearchCollision[]>(
    () =>
      network && output
        ? findSearchCollisions({
            network,
            trees: output.trees,
            origins: origins.flatMap((origin) =>
              origin.node === null ? [] : [origin.node],
            ),
          })
        : [],
    [network, output, origins],
  )
  const explored = searchProgress(progress)
  const collisionCount = collisions.reduce(
    (count, collision) =>
      count + Number(collision.metres <= explored * (result?.longest ?? 0)),
    0,
  )
  const lastCollision = collisions.findLast(
    (collision) => collision.metres <= explored * (result?.longest ?? 0),
  )
  const invalidate = () => {
    worker.current?.terminate()
    worker.current = null
    setRun({ kind: 'idle' })
    setPlaying(false)
    setProgress(0)
    setNotice('')
    setSelected(0)
  }
  const search = () => {
    if (
      !network ||
      origins.length < 2 ||
      origins.some((origin) => origin.node === null)
    )
      return
    worker.current?.terminate()
    setRun({ kind: 'searching' })
    setPlaying(false)
    setProgress(0)
    setSelected(0)
    setNotice('')
    try {
      const current = new Worker(
        new URL('../scripts/meeting-point.worker.ts', import.meta.url),
        { type: 'module' },
      )
      worker.current = current
      current.onmessage = (event: MessageEvent<SearchReply>) => {
        if (worker.current !== current) return
        if (event.data.kind === 'error') {
          setRun({ kind: 'error', message: event.data.message })
          return
        }
        if (!event.data.output.results.length) {
          setRun({
            kind: 'error',
            message:
              'No common reachable meeting points were found. Try different starting locations.',
          })
          return
        }
        setRun({ kind: 'complete', output: event.data.output, objective })
        setProgress(reducedMotion.current ? 1 : 0)
        setPlaying(!reducedMotion.current)
      }
      current.onerror = () => {
        if (worker.current === current)
          setRun({
            kind: 'error',
            message:
              'The search worker could not finish. Try the search again.',
          })
      }
      current.postMessage({
        network,
        origins: origins.flatMap((origin) =>
          origin.node === null ? [] : [origin.node],
        ),
        objective,
      })
    } catch {
      setRun({
        kind: 'error',
        message:
          'This browser could not start the search worker. Try a current browser.',
      })
    }
  }

  if (data.kind === 'loading')
    return (
      <div
        role="status"
        aria-busy="true"
        className="bg-muted/30 rounded-xl border p-8"
      >
        <p className="font-medium">Loading San Francisco’s walking network…</p>
        <p className="text-muted-foreground mt-2 text-sm">
          A local road graph, not a live map service. The first visit downloads
          about 5 MB.
        </p>
      </div>
    )
  if (data.kind === 'error' || !network)
    return (
      <div role="alert" className="rounded-xl border p-6">
        <p>
          {data.kind === 'error'
            ? data.message
            : 'The road network is unavailable.'}
        </p>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry loading road data
        </Button>
      </div>
    )

  return (
    <div className="space-y-6">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <section
          className="bg-card space-y-5 rounded-xl border p-4 sm:p-5"
          aria-labelledby="meeting-starts"
        >
          <div className="flex items-center justify-between">
            <h2 id="meeting-starts" className="text-lg font-semibold">
              Where’s everyone?
            </h2>
            <span className="text-muted-foreground text-xs">
              {origins.length} starting points
            </span>
          </div>
          <p className="text-muted-foreground text-sm">
            Search a landmark or street intersection. Select a letter, then
            click the map to move that start.
          </p>
          <ol className="space-y-2">
            {origins.map((origin, i) => (
              <LocationInput
                key={origin.id}
                origin={origin}
                index={i}
                places={places}
                active={active === origin.id}
                removable={origins.length > 2}
                onActivate={() => setActive(origin.id)}
                onChange={(name, node) => {
                  invalidate()
                  setOrigins((items) =>
                    items.map((item) =>
                      item.id === origin.id ? { ...item, name, node } : item,
                    ),
                  )
                }}
                onRemove={() => {
                  invalidate()
                  setOrigins((items) =>
                    items.filter((item) => item.id !== origin.id),
                  )
                  if (active === origin.id)
                    setActive(
                      origins.find((item) => item.id !== origin.id)?.id ?? 0,
                    )
                }}
              />
            ))}
          </ol>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              invalidate()
              const id = nextId.current++
              setOrigins((items) => [...items, { id, name: '', node: null }])
              setActive(id)
            }}
          >
            <Plus />
            Add starting point
          </Button>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">
              What makes a good meeting spot?
            </legend>
            {(
              [
                {
                  value: 'fair',
                  title: 'Shortest longest journey',
                  description: 'Keep the farthest person as close as possible.',
                },
                {
                  value: 'total',
                  title: 'Least distance together',
                  description: 'Minimize everyone’s combined travel.',
                },
              ] satisfies {
                value: Objective
                title: string
                description: string
              }[]
            ).map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${objective === option.value ? 'border-foreground/50 bg-muted/50' : 'hover:bg-muted/30'}`}
              >
                <input
                  type="radio"
                  name="meeting-objective"
                  className="accent-foreground mt-1 size-4"
                  checked={objective === option.value}
                  onChange={() => {
                    invalidate()
                    setObjective(option.value)
                  }}
                />
                <span>
                  <span className="block text-sm font-medium">
                    {option.title}
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button
            size="lg"
            className="w-full"
            disabled={
              run.kind === 'searching' ||
              origins.length < 2 ||
              origins.some((origin) => origin.node === null)
            }
            aria-busy={run.kind === 'searching'}
            onClick={search}
          >
            {run.kind === 'searching'
              ? 'Searching the road network…'
              : 'Find meeting spots'}
            <ArrowRight />
          </Button>
          <Button
            variant="ghost"
            className="text-muted-foreground w-full"
            onClick={() => {
              invalidate()
              setOrigins(
                sfRegion.landmarks.slice(0, 4).map((place, id) => ({
                  id,
                  name: place.name,
                  node: nearestNode(network, place.coordinate),
                })),
              )
              setActive(0)
              nextId.current = 4
            }}
          >
            <RotateCcw />
            Reset to the reel
          </Button>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Walking distance only. No traffic, transit, elevation, or opening
            hours. Starts snap to the nearest connected road or path.
          </p>
        </section>
        <section
          className="min-w-0 space-y-3"
          aria-label="Animated road search"
        >
          <MeetingMap
            network={network}
            origins={origins}
            output={output}
            selected={selected}
            progress={progress}
            collisions={collisions}
            onSelect={(index) => {
              setSelected(index)
              setProgress(1)
              setPlaying(false)
            }}
            onPick={(coordinate: Coordinate) => {
              const node = nearestNode(network, coordinate)
              if (distanceBetween(coordinate, network.nodes[node]) > 200) {
                setNotice(
                  'Click closer to a road or path inside San Francisco.',
                )
                return
              }
              invalidate()
              const nearby = network.places.find(
                (place) =>
                  distanceBetween(
                    network.nodes[place.node],
                    network.nodes[node],
                  ) < 60,
              )
              const name =
                nearby?.name ??
                `${network.nodes[node][1].toFixed(5)}, ${network.nodes[node][0].toFixed(5)}`
              setOrigins((items) =>
                items.map((item) =>
                  item.id === active ? { ...item, name, node } : item,
                ),
              )
              setNotice(
                `Location ${letter(
                  Math.max(
                    0,
                    origins.findIndex((origin) => origin.id === active),
                  ),
                )} moved to ${name}. Find meeting spots to recalculate.`,
              )
            }}
          />
          <div className="bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
            <Button
              variant="outline"
              size="icon"
              disabled={!output}
              aria-label={
                playing ? 'Pause search animation' : 'Play search animation'
              }
              onClick={() => {
                if (progress >= 1) setProgress(0)
                setPlaying((value) => !value)
              }}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={!output}
              aria-label="Replay search animation"
              onClick={() => {
                setProgress(0)
                setPlaying(true)
              }}
            >
              <RotateCcw />
            </Button>
            <label className="flex h-10 min-w-24 flex-1 items-center">
              <span className="sr-only">Search animation progress</span>
              <input
                className="accent-foreground block w-full"
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(progress * 100)}
                disabled={!output}
                aria-valuetext={`${Math.round(explored * 100)} percent explored${explored >= 1 ? ', all starts have reached the selected meeting point' : ''}`}
                onChange={(event) => {
                  setPlaying(false)
                  setProgress(Number(event.target.value) / 100)
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={!output}
              aria-label={`Animation speed ${speed} times. Click to change.`}
              onClick={() =>
                setSpeed((value) => (value === 1 ? 2 : value === 2 ? 0.5 : 1))
              }
            >
              {speed}×
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!output || progress >= 1}
              onClick={() => {
                setProgress(1)
                setPlaying(false)
              }}
            >
              Skip to routes
            </Button>
          </div>
          <p className="text-muted-foreground min-h-5 text-xs" role="status">
            {notice ||
              (run.kind === 'searching'
                ? `Running ${origins.length} shortest-path searches in a background worker…`
                : run.kind === 'complete'
                  ? `${output?.results.length} alternatives found. ${explored < 1 ? `${collisionCount} of ${collisions.length} first contacts.${lastCollision ? ` Latest: ${lastCollision.sources.map(letter).join(' + ')}.` : ''} Split-color pings mark where searches first meet.` : `All ${origins.length} starts have reached ${result?.name}. The larger ping marks convergence; solid lines show shortest routes.`}`
                  : 'Ready when you are. Run the search to watch the roads light up.')}
          </p>
        </section>
      </div>
      {run.kind === 'error' && (
        <p className="rounded-lg border p-4 text-sm" role="alert">
          {run.message}
        </p>
      )}
      {output && result && (
        <section aria-labelledby="meeting-results" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-muted-foreground mb-1 text-xs tracking-widest uppercase">
                Room for alternatives
              </p>
              <h2 id="meeting-results" className="text-2xl font-semibold">
                Meet somewhere that works.
              </h2>
            </div>
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <ArrowDownUp className="size-3" />
              Ranked by{' '}
              {run.kind === 'complete' && run.objective === 'fair'
                ? 'longest journey, then total distance'
                : 'total distance, then longest journey'}
            </p>
          </div>
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,1fr)]">
            <ol className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              {output.results.map((place, i) => (
                <li key={place.node}>
                  <button
                    className={`focus-visible:outline-ring flex h-full w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${selected === i ? 'border-foreground/60 bg-muted' : 'bg-card hover:bg-muted/50'}`}
                    aria-pressed={selected === i}
                    onClick={() => {
                      setSelected(i)
                      setProgress(1)
                      setPlaying(false)
                    }}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
                      {selected === i ? <Check className="size-3" /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {place.name}
                      </span>
                      <span className="text-muted-foreground mt-2 block text-xs">
                        {km(place.longest)} longest · {km(place.total)} total
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="bg-card min-w-0 space-y-4 rounded-xl border p-5">
              <p className="text-muted-foreground text-xs">
                SELECTED MEETING POINT · {selected + 1} /{' '}
                {output.results.length}
              </p>
              <h3 className="text-xl font-semibold">{result.name}</h3>
              <div className="grid grid-cols-2 gap-3 border-y py-4">
                <div>
                  <p className="text-2xl font-semibold tabular-nums">
                    {km(result.longest)}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Longest journey
                  </p>
                </div>
                <div>
                  <p className="text-2xl font-semibold tabular-nums">
                    {km(result.total)}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Combined distance
                  </p>
                </div>
              </div>
              <ul className="space-y-3">
                {origins.map((origin, i) => (
                  <li
                    key={origin.id}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                      style={{ borderColor: originColor(i) }}
                    >
                      {letter(i)}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={origin.name}
                    >
                      {origin.name}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {km(result.distances[i])}
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                className="h-auto min-h-10 w-full whitespace-normal"
                asChild
              >
                <a
                  href={`https://www.openstreetmap.org/?mlat=${network.nodes[result.node][1]}&mlon=${network.nodes[result.node][0]}#map=18/${network.nodes[result.node][1]}/${network.nodes[result.node][0]}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MapPin />
                  Open meeting point on OSM
                </a>
              </Button>
              <p className="text-muted-foreground text-xs leading-relaxed">
                A road intersection, not a venue recommendation. Check the
                destination and walking route before setting out.
              </p>
            </div>
          </div>
        </section>
      )}
      <details className="bg-card rounded-xl border p-5">
        <summary className="focus-visible:outline-ring cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-4">
          What’s happening under the map?
        </summary>
        <div className="text-muted-foreground mt-4 max-w-3xl space-y-3 text-sm leading-relaxed">
          <p>
            Dijkstra’s algorithm finds shortest paths from every starting point
            along this connected walking graph. The animation replays those
            distance fields simultaneously, rather than drawing straight-line
            circles. Each color belongs to a start; letters keep them
            identifiable without color. Split-color pings mark each pair’s first
            contact, halfway along a shortest road path between their starts. A
            larger ping marks when every start reaches the selected meeting
            point. The last part of playback is reserved for that final pulse; a
            colored halo remains afterward. Pings follow the playback position,
            so pausing and scrubbing preserve their timing. Reduced motion uses
            a static halo.
          </p>
          <p>
            We score {network.places.length.toLocaleString()} named
            intersections, sort by your objective, and keep up to ten
            alternatives at least 400 metres apart. “Shortest longest journey”
            minimizes the maximum distance, with total distance breaking ties.
            “Least distance together” reverses those priorities. These are the
            best points among the dataset’s named intersections, not an exact
            continuous geographic optimum.
          </p>
          <p>
            The reel compares two search strategies. This lab visualizes one
            independent shortest-path search per person; it does not claim the
            reel’s road-check counts or algorithmic speedup. Playback speed
            changes the visualization, not the distances.
          </p>
          <p>
            {network.nodes.length.toLocaleString()} nodes ·{' '}
            {network.edges.length.toLocaleString()} road/path segments ·
            OpenStreetMap snapshot {network.fetched}. Roads are treated as
            two-way for walking; stairs and paths are included.
            Private/no-access ways, motorways, and disconnected components are
            excluded. The simplified graph does not model hills, turn
            restrictions, ferries, accessibility, or temporary closures.
          </p>
          <p>
            All searches run locally after the graph loads. No location queries
            are sent to a geocoder. This is a San Francisco dataset; another
            town needs its own connected network and landmark preset, not a
            different search algorithm.
          </p>
        </div>
      </details>
    </div>
  )
}
