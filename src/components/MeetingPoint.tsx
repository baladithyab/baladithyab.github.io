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
import MeetingPlaceSearch from '@/components/MeetingPlaceSearch'
import type { MeetingPlace } from '@/lib/meeting-geocoder'
import type {
  NetworkReply,
  NetworkRequest,
  StudySize,
} from '@/lib/meeting-network-loader'
import {
  distanceBetween,
  nearestNode,
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
  | { kind: 'loading'; message: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      network: MeetingNetwork
      landmarks: Place[]
      delivery: Extract<NetworkReply, { kind: 'ready' }>['delivery']
    }
type RunState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'error'; message: string }
  | { kind: 'complete'; output: SearchOutput; objective: Objective }
type Place = { name: string; node: number }
type Region = NetworkRequest & { id: string; name: string }
const defaultRegion: Region = {
  kind: 'preset',
  id: 'sf',
  name: sfRegion.name,
  dataUrl: sfRegion.dataUrl,
}
const sfPlace: MeetingPlace = {
  id: 'preset:sf',
  name: sfRegion.name,
  context: 'California, United States (reel preset)',
  coordinate: [-122.4194, 37.7749],
}
const sfPlaces = [sfPlace]
const initialOrigins = (landmarks: Place[]): Origin[] =>
  landmarks.length
    ? landmarks.slice(0, 4).map((place, id) => ({ ...place, id }))
    : [0, 1].map((id) => ({ id, name: '', node: null }))
const letter = (index: number) =>
  String.fromCharCode(65 + (index % 26)) +
  (index >= 26 ? String(Math.floor(index / 26)) : '')
const km = (metres: number) => `${(metres / 1000).toFixed(1)} km`

function RegionPicker({
  region,
  busy,
  onLoad,
}: {
  region: Region
  busy: boolean
  onLoad: (region: Region) => void
}) {
  const [query, setQuery] = useState(sfPlace.name)
  const [chosen, setChosen] = useState<MeetingPlace | null>(sfPlace)
  const [sizeKm, setSizeKm] = useState<StudySize>(8)
  const target: Region | null = !chosen
    ? null
    : chosen.id === sfPlace.id
      ? defaultRegion
      : {
          kind: 'live',
          id: `${chosen.id}/${chosen.coordinate.join(',')}/${sizeKm}`,
          name: [chosen.name, chosen.context].filter(Boolean).join(', '),
          coordinate: chosen.coordinate,
          sizeKm,
        }
  const loadingTarget = busy && target?.id === region.id
  return (
    <section
      className="bg-card space-y-4 rounded-xl border p-4 sm:p-5"
      aria-labelledby="meeting-area"
    >
      <div>
        <h2 id="meeting-area" className="text-lg font-semibold">
          Choose an area
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Select a city or town, then load its walking network. Loading an area
          resets starting points and results.
        </p>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="rounded-lg border p-3">
          <MeetingPlaceSearch
            id="meeting-city"
            label="City or town"
            value={query}
            mode="city"
            localPlaces={sfPlaces}
            placeholder="Search any city or town"
            onValueChange={(value) => {
              setQuery(value)
              setChosen(null)
            }}
            onSelect={(place) => {
              setQuery(place.name)
              setChosen(place)
            }}
          />
        </div>
        <Button
          disabled={!target || loadingTarget}
          aria-busy={loadingTarget}
          onClick={() => {
            if (target) onLoad(target)
          }}
        >
          {loadingTarget ? 'Loading area…' : 'Load walking network'}
          <ArrowRight />
        </Button>
      </div>
      {chosen && chosen.id !== sfPlace.id && (
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="mb-2 text-sm font-medium">Study area width</legend>
          {([4, 8, 12] satisfies StudySize[]).map((size) => (
            <label
              key={size}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${sizeKm === size ? 'border-foreground/50 bg-muted/50' : 'hover:bg-muted/30'}`}
            >
              <input
                type="radio"
                name="meeting-study-size"
                className="accent-foreground"
                checked={sizeKm === size}
                onChange={() => setSizeKm(size)}
              />
              {size} km
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">
        {chosen?.id === sfPlace.id
          ? 'The SF preset uses the bundled walking-network snapshot and original four starts.'
          : `Live areas cover up to ${sizeKm} × ${sizeKm} km around the selected city center, not its administrative boundary. Choose a smaller area if a dense network is too large.`}
      </p>
      <Button
        variant="outline"
        onClick={() => {
          setQuery(sfPlace.name)
          setChosen(sfPlace)
          onLoad(defaultRegion)
        }}
        disabled={busy && region.kind === 'preset'}
      >
        <RotateCcw />
        Use SF reel preset
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Typed city, address and landmark queries go to Photon. Loading a live
        area sends its bounds to Overpass. These public services can be busy or
        unavailable. Road graphs are saved locally; autocomplete uses only a
        short-lived, in-memory cache, not saved search history.
      </p>
    </section>
  )
}

function LocationInput({
  origin,
  index,
  places,
  network,
  active,
  onActivate,
  onChange,
  onRemove,
  removable,
}: {
  origin: Origin
  index: number
  places: MeetingPlace[]
  network: MeetingNetwork
  active: boolean
  onActivate: () => void
  onChange: (name: string, node: number | null) => void
  onRemove: () => void
  removable: boolean
}) {
  const [error, setError] = useState('')
  const id = `meeting-origin-${origin.id}`
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
          <MeetingPlaceSearch
            id={id}
            label={`Starting location ${letter(index)}`}
            value={origin.name}
            mode="place"
            bounds={network.bounds}
            localPlaces={places}
            placeholder="Address, landmark or intersection"
            invalid={
              Boolean(error) || (origin.node === null && origin.name.length > 0)
            }
            describedBy={
              origin.node === null || error ? `${id}-hint` : undefined
            }
            autoFocus={origin.name === '' && active}
            onFocus={onActivate}
            onValueChange={(name) => {
              setError('')
              onChange(name, null)
            }}
            onSelect={(place) => {
              const [west, south, east, north] = network.bounds
              const [longitude, latitude] = place.coordinate
              const node = nearestNode(network, place.coordinate)
              if (
                longitude < west ||
                longitude > east ||
                latitude < south ||
                latitude > north ||
                distanceBetween(place.coordinate, network.nodes[node]) > 200
              ) {
                setError(
                  'This place is outside the loaded area or more than 200 m from a connected path. Choose another suggestion or place the start on the map.',
                )
                return
              }
              setError('')
              onChange(
                place.id.startsWith('local:')
                  ? place.name
                  : [place.name, place.context].filter(Boolean).join(', '),
                node,
              )
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
      {(origin.node === null || error) && (
        <p
          id={`${id}-hint`}
          role={error ? 'alert' : undefined}
          className="text-muted-foreground mt-1 px-2 text-xs"
        >
          {error || 'Choose a suggestion or place this start on the map.'}
        </p>
      )}
    </li>
  )
}

export default function MeetingPoint() {
  const [region, setRegion] = useState<Region>(defaultRegion)
  const [data, setData] = useState<NetworkState>({
    kind: 'loading',
    message: 'Loading the SF walking-network snapshot…',
  })
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
  const networkWorker = useRef<Worker | null>(null)
  const reducedMotion = useRef(false)

  useEffect(() => {
    setData({ kind: 'loading', message: `Loading ${region.name}…` })
    try {
      const current = new Worker(
        new URL('../scripts/meeting-network.worker.ts', import.meta.url),
        { type: 'module' },
      )
      networkWorker.current = current
      const fail = (message: string) => {
        if (networkWorker.current !== current) return
        setData({ kind: 'error', message })
        current.terminate()
        networkWorker.current = null
      }
      current.onmessage = (event: MessageEvent<NetworkReply>) => {
        if (networkWorker.current !== current) return
        const reply = event.data
        if (reply.kind === 'progress') {
          setData({ kind: 'loading', message: reply.message })
          return
        }
        if (reply.kind === 'error') {
          fail(reply.message)
          return
        }
        const network = reply.network
        const landmarks =
          region.kind === 'preset'
            ? sfRegion.landmarks.map((place) => ({
                name: place.name,
                node: nearestNode(network, place.coordinate),
              }))
            : []
        const starts = initialOrigins(landmarks)
        setData({ kind: 'ready', network, landmarks, delivery: reply.delivery })
        setOrigins(starts)
        setActive(0)
        nextId.current = starts.length
        current.terminate()
        networkWorker.current = null
      }
      current.onerror = () =>
        fail(
          'The road loader could not finish. Try a smaller area or load the SF preset.',
        )
      current.postMessage(region)
      return () => {
        current.terminate()
        if (networkWorker.current === current) networkWorker.current = null
      }
    } catch {
      networkWorker.current?.terminate()
      networkWorker.current = null
      setData({
        kind: 'error',
        message:
          'This browser could not start the road loader. Try a current browser.',
      })
    }
  }, [region, attempt])
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
  const places = useMemo<MeetingPlace[]>(() => {
    if (data.kind !== 'ready') return []
    const { network, landmarks } = data
    return [...landmarks, ...network.places].map((place, index) => ({
      id: `local:${place.node}:${index}`,
      name: place.name,
      context:
        index < landmarks.length ? 'Local landmark' : 'Local intersection',
      coordinate: network.nodes[place.node],
    }))
  }, [data])
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
  const areaPicker = (
    <RegionPicker
      region={region}
      busy={data.kind === 'loading'}
      onLoad={(next) => {
        invalidate()
        setOrigins([])
        setData({ kind: 'loading', message: `Loading ${next.name}…` })
        setRegion({ ...next })
      }}
    />
  )

  if (data.kind === 'loading')
    return (
      <div className="space-y-6">
        {areaPicker}
        <div
          role="status"
          aria-busy="true"
          className="bg-muted/30 rounded-xl border p-8"
        >
          <p className="font-medium">{data.message}</p>
          <p className="text-muted-foreground mt-2 text-sm">
            Live road data can take up to 90 seconds. You can choose another
            area or return to the SF preset while it loads.
          </p>
        </div>
      </div>
    )
  if (data.kind === 'error' || !network)
    return (
      <div className="space-y-6">
        {areaPicker}
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
      </div>
    )

  return (
    <div className="space-y-6">
      {areaPicker}
      <p className="text-muted-foreground text-sm" role="status">
        {network.name}
        {region.kind === 'live'
          ? ` · up to ${region.sizeKm} × ${region.sizeKm} km study area`
          : ' · reel preset'}
        {data.kind === 'ready' && data.delivery === 'cached'
          ? ' · cached road snapshot'
          : ''}
      </p>
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
            Search an address, landmark or street intersection in the loaded
            area. Select a letter, then click the map to move that start.
          </p>
          <ol className="space-y-2">
            {origins.map((origin, i) => (
              <LocationInput
                key={`${region.id}:${origin.id}`}
                origin={origin}
                index={i}
                places={places}
                network={network}
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
                initialOrigins(data.kind === 'ready' ? data.landmarks : []),
              )
              setActive(0)
              nextId.current =
                data.kind === 'ready' && data.landmarks.length ? 4 : 2
            }}
          >
            <RotateCcw />
            {region.kind === 'preset'
              ? 'Reset to the reel'
              : 'Reset starting points'}
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
                  'Click within 200 m of a connected road or path in the loaded area.',
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
            Route searches run locally after the graph loads. Autocomplete sends
            typed queries to Photon; live area requests send bounds to Overpass.
            Public road graphs may be cached on this device for up to seven
            days. Starting locations and typed search history are not saved. SF
            remains a bundled snapshot; other areas use a bounded network
            retrieved on demand, not guaranteed live routing.
          </p>
        </div>
      </details>
    </div>
  )
}
