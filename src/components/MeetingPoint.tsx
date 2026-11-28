import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ArrowRight, Plus, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { originColor, type Origin } from '@/components/MeetingMap'
import MeetingInfluencePanel from '@/components/MeetingInfluencePanel'
import MeetingLiveLayers from '@/components/MeetingLiveLayers'
import MeetingPlayback, {
  type MeetingSelection,
} from '@/components/MeetingPlayback'
import MeetingResults from '@/components/MeetingResults'
import MeetingPlaceSearch from '@/components/MeetingPlaceSearch'
import MeetingRegionPicker, {
  defaultRegion,
  sizeText,
  type Region,
} from '@/components/MeetingRegionPicker'
import { placePerson } from '@/lib/meeting-area'
import type { MeetingPlace } from '@/lib/meeting-geocoder'
import {
  addBubble,
  DEFAULT_BUBBLE_DRAFT,
  INFLUENCE_BUDGET,
  nodeInfluence,
  sameField,
  type BubbleDraft,
  type InfluenceBias,
  type InfluenceSource,
} from '@/lib/meeting-influence'
import type { NetworkDelivery } from '@/lib/meeting-network-loader'
import {
  distanceBetween,
  nearestNode,
  sfRegion,
  type Coordinate,
  type MeetingNetwork,
  type MeetingResult,
  type Objective,
  type SearchOutput,
  type SearchTree,
  rankMeetingResults,
} from '@/lib/meeting-point'
import type {
  MeetingSessionReply,
  MeetingSessionRequest,
  PlacedStart,
} from '@/lib/meeting-session'
import type { SearchCollision } from '@/lib/meeting-collisions'

type NetworkState =
  | { kind: 'loading'; message: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      network: MeetingNetwork
      landmarks: Place[]
      starts: PlacedStart[]
      delivery: NetworkDelivery
    }
type RunState =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'error'; message: string }
  | {
      kind: 'complete'
      output: SearchOutput
      collisions: SearchCollision[]
      objective: Objective
      /** The bias that ranked `output`; undefined when only distance counted. */
      bias: InfluenceBias | undefined
    }
type Place = { name: string; node: number }
type PendingSearch = {
  id: number
  network: MeetingNetwork
  origins: number[]
  objective: Objective
}
type CompletedSearch = Omit<PendingSearch, 'id' | 'objective'> &
  Pick<SearchOutput, 'trees'> & { collisions: SearchCollision[] }
type WorkerSession = {
  worker: Worker
  phase: 'loading' | 'ready' | 'searching'
  pending: PendingSearch | null
}
type Ranking = {
  network: MeetingNetwork
  trees: SearchTree[]
  collisions: SearchCollision[]
  objective: Objective
  bias: InfluenceBias | undefined
  /** The worker's order, which already applies when there is no bias. */
  workerResults?: MeetingResult[]
  reveal: MeetingSelection['reveal']
  /** The output being re-ranked, kept when the order is unchanged. */
  previous?: SearchOutput
}
const emptyCollisions: SearchCollision[] = []
// People who chose the area start in order; otherwise the preset's first four
// landmarks, otherwise two empty rows.
const initialOrigins = (landmarks: Place[], starts: PlacedStart[]): Origin[] =>
  starts.length
    ? starts.map((start, id) => ({ ...start, id }))
    : landmarks.length
      ? landmarks.slice(0, 4).map((place, id) => ({ ...place, id }))
      : [0, 1].map((id) => ({ id, name: '', node: null }))
const letter = (index: number) =>
  String.fromCharCode(65 + (index % 26)) +
  (index >= 26 ? String(Math.floor(index / 26)) : '')
// Two regions with one key load the same graph: the same preset or bounds.
const graphKey = (region: Region) =>
  region.kind === 'preset'
    ? `preset:${region.dataUrl}`
    : `live:${region.bounds.join(',')}`

function LocationInput({
  origin,
  index,
  places,
  network,
  active,
  onActivate,
  onPlaceOnMap,
  onChange,
  onRemove,
  removable,
  coarseQuery,
}: {
  origin: Origin
  index: number
  places: MeetingPlace[]
  network: MeetingNetwork
  active: boolean
  /** Focus in the search: this start becomes the one map clicks move. */
  onActivate: () => void
  /** The letter button: map clicks move this start, not drop bubbles. */
  onPlaceOnMap: () => void
  /** Send searches to Photon as a coarse box with no midpoint. */
  coarseQuery: boolean
  onChange: (name: string, node: number | null) => void
  onRemove: () => void
  removable: boolean
}) {
  const [selectionError, setSelectionError] = useState<{
    origin: Origin
    message: string
  } | null>(null)
  // Map picks and resets replace the origin, even when its name is unchanged.
  const error = selectionError?.origin === origin ? selectionError.message : ''
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
          onClick={onPlaceOnMap}
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
            coarseQuery={coarseQuery}
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
              setSelectionError(null)
              onChange(name, null)
            }}
            onSelect={(place) => {
              const node = placePerson(network, place.coordinate)
              if (node === null) {
                setSelectionError({
                  origin,
                  message:
                    'This place is outside the loaded area or more than 200 m from a connected path. Choose another suggestion or place the start on the map.',
                })
                return
              }
              setSelectionError(null)
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
  const [selection, setSelection] = useState<MeetingSelection>({
    index: 0,
    reveal: 'auto',
  })
  const [notice, setNotice] = useState('')
  const session = useRef<WorkerSession | null>(null)
  const completed = useRef<CompletedSearch | null>(null)
  const nextSearchId = useRef(0)
  const selectResult = useCallback((index: number) => {
    setSelection({ index, reveal: 'routes' })
  }, [])
  const [bubbles, setBubbles] = useState<InfluenceSource[]>([])
  const [draft, setDraft] = useState<BubbleDraft>(DEFAULT_BUBBLE_DRAFT)
  const [budget, setBudget] = useState<number>(INFLUENCE_BUDGET.default)
  const [dropping, setDropping] = useState(false)
  const [liveSources, setLiveSources] = useState<InfluenceSource[]>([])
  const [panelTab, setPanelTab] = useState<'starts' | 'results' | 'layers' | 'area'>('starts')
  const [showAbout, setShowAbout] = useState(false)
  const sidebarScroll = useRef<HTMLDivElement>(null)
  const switchPanel = useCallback(
    (next: 'starts' | 'results' | 'layers' | 'area') => {
      setPanelTab(next)
      sidebarScroll.current?.scrollTo({ top: 0 })
    },
    [],
  )
  useEffect(() => {
    if (!showAbout) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowAbout(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showAbout])
  // Worker replies arrive outside render; they rank with the latest bias.
  const latestBias = useRef<InfluenceBias | undefined>(undefined)
  // Every completed result list is ranked here, with the bias it stores.
  const finishSearch = useCallback(
    ({
      network,
      trees,
      collisions,
      objective,
      bias,
      workerResults,
      reveal,
      previous,
    }: Ranking) => {
      let results: MeetingResult[]
      try {
        results =
          workerResults && !bias
            ? workerResults
            : rankMeetingResults({ network, trees, objective, bias })
      } catch (error) {
        setRun({
          kind: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'The meeting spots could not be ranked. Try the search again.',
        })
        return
      }
      if (!results.length) {
        setRun({
          kind: 'error',
          message:
            'No common reachable meeting points were found. Try different starting locations.',
        })
        return
      }
      const unchanged =
        previous !== undefined &&
        previous.results.length === results.length &&
        previous.results.every((result, i) => result.node === results[i].node)
      if (unchanged) {
        // The same order keeps the same output, selection and playback
        // position, so the map keeps its layers and nobody loses their place.
        setRun({
          kind: 'complete',
          output: previous,
          collisions,
          objective,
          bias,
        })
        return
      }
      setRun({
        kind: 'complete',
        output: { trees, results },
        collisions,
        objective,
        bias,
      })
      setSelection({ index: 0, reveal })
      if (reveal === 'auto') switchPanel('results')
    },
    [switchPanel],
  )

  const createSession = useCallback(() => {
    const worker = new Worker(
      new URL('../scripts/meeting-point.worker.ts', import.meta.url),
      { type: 'module' },
    )
    const current: WorkerSession = { worker, phase: 'loading', pending: null }
    session.current = current
    const fail = (message: string) => {
      if (session.current !== current) return
      worker.terminate()
      session.current = null
      if (current.phase === 'loading') setData({ kind: 'error', message })
      else setRun({ kind: 'error', message })
    }
    worker.onmessage = (event: MessageEvent<MeetingSessionReply>) => {
      if (session.current !== current) return
      const reply = event.data
      if (reply.kind === 'progress') {
        if (current.phase === 'loading')
          setData({ kind: 'loading', message: reply.message })
      } else if (reply.kind === 'ready') {
        current.phase = 'ready'
        const starts = initialOrigins(reply.landmarks, reply.starts)
        setData({
          kind: 'ready',
          network: reply.network,
          landmarks: reply.landmarks,
          starts: reply.starts,
          delivery: reply.delivery,
        })
        setOrigins(starts)
        setActive(0)
        nextId.current = starts.length
      } else if (reply.kind === 'result') {
        const pending = current.pending
        if (!pending || pending.id !== reply.id) return
        current.phase = 'ready'
        current.pending = null
        completed.current = {
          network: pending.network,
          origins: pending.origins,
          trees: reply.output.trees,
          collisions: reply.collisions,
        }
        finishSearch({
          network: pending.network,
          trees: reply.output.trees,
          collisions: reply.collisions,
          objective: pending.objective,
          bias: latestBias.current,
          workerResults: reply.output.results,
          reveal: 'auto',
        })
      } else {
        if (reply.id !== null && current.pending?.id !== reply.id) return
        fail(reply.message)
      }
    }
    worker.onerror = () =>
      fail(
        current.phase === 'loading'
          ? 'The road loader could not finish. Try a smaller area or load the SF preset.'
          : 'The search worker could not finish. Try the search again.',
      )
    return current
  }, [finishSearch])
  // Only a different graph reloads: a region with the same preset or bounds
  // keeps the loaded network, bubbles and live layers, and the load reads the
  // latest region (its name and starts) when it does run.
  const graphId = graphKey(region)
  const loadRegion = useRef(region)
  useLayoutEffect(() => {
    loadRegion.current = region
  })
  useEffect(() => {
    const request = loadRegion.current
    session.current?.worker.terminate()
    session.current = null
    completed.current = null
    setData({ kind: 'loading', message: `Loading ${request.name}…` })
    let current: WorkerSession | undefined
    try {
      current = createSession()
      const load: MeetingSessionRequest = {
        kind: 'load',
        request,
        landmarks: request.kind === 'preset' ? sfRegion.landmarks : [],
        starts: request.starts ?? [],
      }
      current.worker.postMessage(load)
    } catch {
      current?.worker.terminate()
      session.current = null
      setData({
        kind: 'error',
        message:
          'This browser could not start the road loader. Try a current browser.',
      })
    }
    return () => {
      session.current?.worker.terminate()
      session.current = null
      completed.current = null
    }
  }, [graphId, attempt, createSession])

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
  // Bubbles first, then live sources: the order the map and the field use.
  const influences = useMemo(
    () => [...bubbles, ...liveSources],
    [bubbles, liveSources],
  )
  // Renaming a bubble rebuilds the list but not the field, so only moving,
  // resizing, reweighting, adding or removing a source reaches the ranking.
  const [fieldSources, setFieldSources] = useState(influences)
  if (!sameField(fieldSources, influences)) setFieldSources(influences)
  const influenceOn = budget > 0
  const field = useMemo(() => {
    if (!network || !influenceOn || fieldSources.length === 0) return null
    try {
      return { values: nodeInfluence(network, fieldSources), error: '' }
    } catch (error) {
      return {
        values: null,
        error:
          error instanceof Error
            ? error.message
            : 'An influence zone could not be applied.',
      }
    }
  }, [network, fieldSources, influenceOn])
  const bias = useMemo<InfluenceBias | undefined>(
    () => (field?.values ? { values: field.values, budget } : undefined),
    [field, budget],
  )
  // Updated during commit, before any later worker reply can be handled.
  useLayoutEffect(() => {
    latestBias.current = bias
  })
  // A new bias re-ranks the finished search from its retained trees and
  // collisions; Dijkstra does not run again and the search stays complete.
  if (run.kind === 'complete' && run.bias !== bias && network)
    finishSearch({
      network,
      trees: run.output.trees,
      collisions: run.collisions,
      objective: run.objective,
      bias,
      reveal: 'routes',
      previous: run.output,
    })
  const output = run.kind === 'complete' ? run.output : null
  const selected = selection.index
  const collisions = run.kind === 'complete' ? run.collisions : emptyCollisions
  const invalidate = () => {
    if (session.current?.phase === 'searching') {
      session.current.worker.terminate()
      session.current = null
    }
    setRun({ kind: 'idle' })
    setNotice('')
    setSelection({ index: 0, reveal: 'auto' })
  }
  const search = () => {
    if (
      !network ||
      origins.length < 2 ||
      origins.some((origin) => origin.node === null)
    )
      return
    const nodes = origins.flatMap((origin) =>
      origin.node === null ? [] : [origin.node],
    )
    setRun({ kind: 'searching' })
    setSelection({ index: 0, reveal: 'auto' })
    setNotice('')
    try {
      const previous = completed.current
      if (
        previous?.network === network &&
        previous.origins.length === nodes.length &&
        previous.origins.every((node, index) => node === nodes[index])
      ) {
        finishSearch({
          network,
          trees: previous.trees,
          collisions: previous.collisions,
          objective,
          bias,
          reveal: 'auto',
        })
        return
      }
      let current = session.current
      if (!current) {
        current = createSession()
        const attach: MeetingSessionRequest = { kind: 'attach', network }
        current.worker.postMessage(attach)
      }
      const id = ++nextSearchId.current
      current.phase = 'searching'
      current.pending = { id, network, origins: nodes, objective }
      const request: MeetingSessionRequest = {
        kind: 'search',
        id,
        origins: nodes,
        objective,
      }
      current.worker.postMessage(request)
    } catch {
      session.current?.worker.terminate()
      session.current = null
      setRun({
        kind: 'error',
        message:
          'This browser could not start the search worker. Try a current browser.',
      })
    }
  }
  const areaPicker = (
    <MeetingRegionPicker
      region={region}
      busy={data.kind === 'loading'}
      onLoad={(next) => {
        invalidate()
        const sameGraph = graphKey(next) === graphKey(region)
        if (sameGraph && data.kind === 'ready') {
          // The graph is already here: keep it with its bubbles and live
          // layers, and place the submitted people on it as a load would.
          const placed: PlacedStart[] = (next.starts ?? []).map(
            ({ name, coordinate }) => ({
              name,
              node: placePerson(data.network, coordinate),
            }),
          )
          if (placed.length || data.starts.length)
            setData({ ...data, starts: placed })
          const starts = initialOrigins(data.landmarks, placed)
          setOrigins(starts)
          setActive(0)
          nextId.current = starts.length
          setNotice(
            placed.length
              ? 'This road network is already loaded. Starting points have been updated.'
              : 'This road network is already loaded. Starting points have been reset.',
          )
          setRegion({ ...next })
          return
        }
        // Bubbles and live sources describe the old area.
        setBubbles([])
        setDropping(false)
        setLiveSources([])
        setOrigins([])
        setData({ kind: 'loading', message: `Loading ${next.name}…` })
        setRegion({ ...next })
        // The same graph does not reload by itself; start again with these starts.
        if (sameGraph) setAttempt((value) => value + 1)
      }}
    />
  )

  const tabs: {
    id: 'starts' | 'results' | 'layers' | 'area'
    label: string
    badge?: number
  }[] = [
    { id: 'starts', label: 'Starts', badge: origins.length || undefined },
    {
      id: 'results',
      label: 'Results',
      badge: output ? output.results.length : undefined,
    },
    {
      id: 'layers',
      label: 'Layers',
      badge: influences.length || undefined,
    },
    { id: 'area', label: 'Area' },
  ]
  const effectiveTab = data.kind === 'ready' ? panelTab : 'area'

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden lg:flex-row">
      <aside
        aria-label="Meeting point controls"
        className="bg-card order-2 flex max-h-[54%] min-h-0 w-full shrink-0 flex-col overflow-hidden border-t lg:order-1 lg:max-h-none lg:w-[24rem] lg:border-t-0 lg:border-r xl:w-[26rem]"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3.5 py-2">
          <p className="text-muted-foreground min-w-0 truncate text-xs" role="status">
            <span className="text-foreground font-medium">{region.name}</span>
            {data.kind === 'ready' && region.kind === 'live'
              ? ` · ${sizeText(data.network.bounds)}`
              : region.kind === 'preset'
                ? ' · reel preset'
                : ''}
            {data.kind === 'ready' && data.delivery === 'cached'
              ? ' · cached'
              : ''}
          </p>
          <button
            type="button"
            onClick={() => setShowAbout(true)}
            className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors"
          >
            How it works
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Meeting point panels"
          className="grid shrink-0 grid-cols-4 gap-1 border-b p-1.5"
        >
          {tabs.map((tabItem) => {
            const activeTab = effectiveTab === tabItem.id
            const disabled = data.kind !== 'ready' && tabItem.id !== 'area'
            return (
              <button
                key={tabItem.id}
                type="button"
                role="tab"
                aria-selected={activeTab}
                disabled={disabled}
                onClick={() => switchPanel(tabItem.id)}
                className={`inline-flex min-h-8 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                  activeTab
                    ? 'bg-accent text-foreground border-border'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground border-transparent'
                }`}
              >
                <span className="truncate">{tabItem.label}</span>
                {tabItem.badge !== undefined && (
                  <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[0.65rem] leading-4 font-semibold tabular-nums">
                    {tabItem.badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div
          ref={sidebarScroll}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5 sm:p-4"
        >
          {effectiveTab === 'area' && areaPicker}

          {data.kind === 'ready' && network && effectiveTab === 'starts' && (
            <section className="space-y-4" aria-labelledby="meeting-starts">
              <div className="flex items-center justify-between">
                <h2 id="meeting-starts" className="text-base font-semibold">
                  Where’s everyone?
                </h2>
                <span className="text-muted-foreground text-xs">
                  {origins.length} starting points
                </span>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Search an address, landmark or street intersection.{' '}
                {dropping
                  ? 'Map clicks currently drop bubbles. Select a letter to switch back to moving a start.'
                  : 'Select a letter, then click the map to move that start.'}
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
                    coarseQuery={Boolean(region.hasDeviceLocation)}
                    onActivate={() => setActive(origin.id)}
                    onPlaceOnMap={() => {
                      setActive(origin.id)
                      if (dropping) {
                        setDropping(false)
                        setNotice('Map clicks now move starting points.')
                      }
                    }}
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
                size="sm"
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
                <legend className="mb-1.5 text-xs font-semibold">
                  What makes a good meeting spot?
                </legend>
                {(
                  [
                    {
                      value: 'fair',
                      title: 'Shortest longest journey',
                      description:
                        'Keep the farthest person as close as possible.',
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
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 ${objective === option.value ? 'border-foreground/50 bg-muted/50' : 'hover:bg-muted/30'}`}
                  >
                    <input
                      type="radio"
                      name="meeting-objective"
                      className="accent-foreground mt-0.5 size-4"
                      checked={objective === option.value}
                      onChange={() => {
                        invalidate()
                        setObjective(option.value)
                      }}
                    />
                    <span>
                      <span className="block text-xs font-medium">
                        {option.title}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-[0.7rem] leading-relaxed">
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
                size="sm"
                className="text-muted-foreground w-full"
                onClick={() => {
                  invalidate()
                  const starts =
                    data.kind === 'ready'
                      ? initialOrigins(data.landmarks, data.starts)
                      : initialOrigins([], [])
                  setOrigins(starts)
                  setActive(0)
                  nextId.current = starts.length
                }}
              >
                <RotateCcw />
                {region.kind === 'preset'
                  ? 'Reset to the reel'
                  : 'Reset starting points'}
              </Button>
              {field?.error && (
                <p className="rounded-lg border p-3 text-xs" role="alert">
                  {field.error} Ranking by walking distance only.
                </p>
              )}
              {run.kind === 'error' && (
                <p className="rounded-lg border p-3 text-xs" role="alert">
                  {run.message}
                </p>
              )}
              <p className="text-muted-foreground text-[0.7rem] leading-relaxed">
                Distances are walking only: no transit, elevation or opening
                hours. Traffic, events and bubbles only change which spots rank
                first.
              </p>
            </section>
          )}

          {data.kind === 'ready' && network && effectiveTab === 'results' && (
            <>
              {output && run.kind === 'complete' ? (
                <MeetingResults
                  network={network}
                  origins={origins}
                  output={output}
                  selected={selected}
                  objective={run.objective}
                  onSelect={selectResult}
                  bias={run.bias}
                />
              ) : (
                <div className="space-y-3 rounded-lg border p-4 text-sm">
                  <p className="font-medium">No results yet</p>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Run a search from the Starts tab to watch the walking search
                    unfold and compare ranked meeting intersections.
                  </p>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={
                      run.kind === 'searching' ||
                      origins.length < 2 ||
                      origins.some((origin) => origin.node === null)
                    }
                    onClick={search}
                  >
                    {run.kind === 'searching'
                      ? 'Searching…'
                      : 'Find meeting spots'}
                    <ArrowRight />
                  </Button>
                </div>
              )}
            </>
          )}

          {data.kind === 'ready' && network && effectiveTab === 'layers' && (
            <div className="space-y-4">
              <p className="text-muted-foreground text-xs">
                Optional influence zones and live layers. Changes reorder
                results automatically.
              </p>
              <MeetingInfluencePanel
                network={network}
                places={places}
                bubbles={bubbles}
                onBubblesChange={setBubbles}
                draft={draft}
                onDraftChange={setDraft}
                budget={budget}
                onBudgetChange={setBudget}
                dropping={dropping}
                onDroppingChange={setDropping}
                liveCount={liveSources.length}
                coarseQuery={Boolean(region.hasDeviceLocation)}
              />
              <MeetingLiveLayers
                key={graphKey(region)}
                bounds={network.bounds}
                budget={budget}
                onSourcesChange={setLiveSources}
              />
            </div>
          )}
        </div>
      </aside>

      <div className="bg-background relative order-1 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:order-2">
        {data.kind === 'loading' && (
          <div className="flex flex-1 items-center justify-center p-6">
            <div
              role="status"
              aria-busy="true"
              className="bg-card max-w-lg rounded-xl border p-6"
            >
              <p className="font-medium">{data.message}</p>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                Most areas load within a minute or two. A large area can take
                several minutes and may arrive in several parts. When the road
                service is at capacity, the lab retries automatically. You can
                choose another area or return to the SF preset while it loads.
              </p>
            </div>
          </div>
        )}
        {(data.kind === 'error' || (data.kind !== 'loading' && !network)) && (
          <div className="flex flex-1 items-center justify-center p-6">
            <div role="alert" className="bg-card max-w-lg rounded-xl border p-6">
              <p className="text-sm">
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
        )}
        {data.kind === 'ready' && network && (
          <MeetingPlayback
            network={network}
            origins={origins}
            output={output}
            selection={selection}
            collisions={collisions}
            notice={notice}
            searching={run.kind === 'searching'}
            onSelect={selectResult}
            influences={influences}
            picking={dropping ? 'bubble' : 'start'}
            areaName={region.name}
            onPick={(coordinate: Coordinate) => {
              if (dropping) {
                const added = addBubble({
                  network,
                  bubbles,
                  coordinate,
                  draft,
                })
                setNotice(added.message)
                if (added.ok) setBubbles(added.bubbles)
                return
              }
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
        )}
      </div>

      {showAbout && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="meeting-about-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowAbout(false)
          }}
        >
          <div className="bg-card max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-xl border p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 id="meeting-about-title" className="text-base font-semibold">
                What’s happening under the map?
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAbout(false)}
              >
                Close
              </Button>
            </div>
            <div className="text-muted-foreground space-y-3 text-sm leading-relaxed">
              <p>
                Inspired by{' '}
                <a
                  className="hover:text-foreground underline underline-offset-4"
                  href="https://www.instagram.com/reel/DfkWNDNlHTM/"
                  target="_blank"
                  rel="noreferrer"
                >
                  The Map World’s San Francisco reel
                </a>
                . Built for more than four friends and more than one answer.
              </p>
              <p>
                Dijkstra’s algorithm finds shortest paths from every starting
                point along this connected walking graph. The animation replays
                those distance fields simultaneously, rather than drawing
                straight-line circles. Each color belongs to a start; letters
                keep them identifiable without color. Split-color pings mark
                each pair’s first contact, halfway along a shortest road path
                between their starts.
              </p>
              {network && (
                <p>
                  We score {network.places.length.toLocaleString()} named
                  intersections, sort by your objective and any influence zones,
                  and keep up to ten alternatives at least 400 metres apart.
                </p>
              )}
              <p>
                Influence zones are optional: bubbles you place, live traffic
                incidents (always keep away) and events (meet near or keep
                away). Zones only change the order; every distance shown is the
                true walking distance.
              </p>
              {network && (
                <p>
                  {network.nodes.length.toLocaleString()} nodes ·{' '}
                  {network.edges.length.toLocaleString()} road/path segments ·
                  OpenStreetMap snapshot {network.fetched}.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
