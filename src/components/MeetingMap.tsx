import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LocateFixed, Minus, Plus } from 'lucide-react'
import {
  distanceBetween,
  routeTo,
  type Coordinate,
  type MeetingNetwork,
  type SearchOutput,
} from '@/lib/meeting-point'
import {
  COLLISION_PING_SPAN,
  SEARCH_COMPLETE_AT,
  searchProgress,
  resultRevealProgress,
  markerRevealOpacity,
  type SearchCollision,
} from '@/lib/meeting-collisions'
import {
  bucketTraversal,
  planTraversal,
  traversalCutoff,
  type TraversalBuckets,
  type TraversalPlan,
} from '@/lib/meeting-map-traversal'

export type Origin = { id: number; name: string; node: number | null }
export const originColor = (index: number) =>
  `hsl(var(--chart-${(index % 5) + 1}))`
const WORLD = 1024
const RASTER = 2
// Heavy preparation runs in slices of this many milliseconds between tasks, so
// input and painting stay responsive; trail painting gets a per-frame budget.
const SLICE_MS = 10
const TRAIL_BUDGET_MS = 6
const TRAIL_SLICE_EDGES = 6000
const NODE_CHUNK = 40000
const EDGE_CHUNK = 60000
const ROAD_CHUNK = 20000

type Props = {
  network: MeetingNetwork
  origins: Origin[]
  output: SearchOutput | null
  selected: number
  progress: number
  collisions: SearchCollision[]
  onPick: (coordinate: Coordinate) => void
  onSelect: (index: number) => void
  /** False while geometry for the current network/output is being prepared. */
  onReadyChange?: (ready: boolean) => void
}

// World-space geometry for one network. `ready` once points and edge endpoints
// are filled; `roads` once the (opaque) road raster is complete.
type Geometry = {
  x: Float64Array
  y: Float64Array
  from: Int32Array
  to: Int32Array
  ready: boolean
  roads: HTMLCanvasElement | null
}

// Select-independent traversal buckets for one output.
type Traversal = {
  output: SearchOutput
  plan: TraversalPlan
  sources: TraversalBuckets[]
  ready: boolean
}

// A trail raster painted up to `done` buckets for every source. `run` is a
// partially painted range [from, to) currently being budgeted.
type Raster = {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  owner: Traversal | null
  version: number
  done: number
  run: { from: number; to: number; source: number; position: number } | null
}

// Benchmark-only evidence. Elapsed includes scheduling waits (and, for geometry,
// the rest of effect setup); CPU sums synchronous setup and generator resumes,
// including the final resume. These are wall-clock intervals, not OS CPU time.
// Setup covers projection constants/arrays, road canvas creation, or traversal
// planning/target allocation. Resumes include scratch/bucket allocations.
// Scheduler bookkeeping, ready callbacks and trail painting are excluded.
// Road CPU includes Canvas2D submission, not asynchronous raster/GPU completion.
const PROFILE_PREPARATION =
  import.meta.env.MODE === 'meeting-benchmark' &&
  import.meta.env.VITE_MEETING_CANVAS_PROFILE === 'true'

type PreparationMeasure = {
  stage: 'geometry' | 'roads' | 'traversal'
  startTime: number
  setupCpuMs: number
  sliceCpuMs: number
  slices: number
}

function beginPreparation(
  stage: PreparationMeasure['stage'],
): PreparationMeasure {
  return {
    stage,
    startTime: performance.now(),
    setupCpuMs: 0,
    sliceCpuMs: 0,
    slices: 0,
  }
}

function finishPreparation(
  measure: PreparationMeasure,
  status: 'completed' | 'cancelled',
) {
  performance.measure(`meeting:map:${measure.stage}`, {
    start: measure.startTime,
    end: performance.now(),
    detail: {
      status,
      cpuMs: measure.setupCpuMs + measure.sliceCpuMs,
      setupCpuMs: measure.setupCpuMs,
      sliceCpuMs: measure.sliceCpuMs,
      slices: measure.slices,
    },
  })
}

// Runs a generator in cancellable time slices, outside the React commit or
// input handler that requested preparation.
function runSliced(
  task: Generator<void, void, void>,
  done: () => void,
  measure?: PreparationMeasure,
) {
  const channel = new MessageChannel()
  let active = true
  const stop = (status: 'completed' | 'cancelled' = 'cancelled') => {
    if (PROFILE_PREPARATION && active && measure)
      finishPreparation(measure, status)
    active = false
    channel.port1.close()
    channel.port2.close()
  }
  const step = () => {
    if (!active) return
    const end = performance.now() + SLICE_MS
    do {
      const sliceStart = PROFILE_PREPARATION ? performance.now() : 0
      const result = task.next()
      if (PROFILE_PREPARATION && measure) {
        measure.sliceCpuMs += performance.now() - sliceStart
        measure.slices++
      }
      if (result.done) {
        stop('completed')
        done()
        return
      }
    } while (performance.now() < end)
    channel.port2.postMessage(null)
  }
  channel.port1.onmessage = step
  channel.port2.postMessage(null)
  return stop
}

// Buckets already (or being) painted; a lower cutoff than this needs a repaint.
const reach = (raster: Raster) => (raster.run ? raster.run.to : raster.done)

// Paints buckets [done, wanted) for every source in source order, stopping at
// the deadline after at least one slice. Returns whether the raster is current.
function paintRaster(
  raster: Raster,
  geometry: Geometry,
  sources: TraversalBuckets[],
  colors: string[],
  wanted: number,
  deadline: number,
) {
  const { context } = raster
  const { x, y, from, to } = geometry
  if (sources.length === 0) return true
  context.lineWidth = 1.5
  for (;;) {
    let run = raster.run
    if (!run) {
      if (raster.done >= wanted) return true
      run = raster.run = {
        from: raster.done,
        to: wanted,
        source: 0,
        position: sources[0]?.offsets[raster.done] ?? 0,
      }
    }
    const { offsets, edges } = sources[run.source]
    const stop = Math.min(offsets[run.to], run.position + TRAIL_SLICE_EDGES)
    context.strokeStyle = colors[run.source % 5]
    context.beginPath()
    for (let i = run.position; i < stop; i++) {
      const edge = edges[i]
      const a = from[edge]
      const b = to[edge]
      context.moveTo(x[a], y[a])
      context.lineTo(x[b], y[b])
    }
    context.stroke()
    run.position = stop
    if (stop >= offsets[run.to]) {
      run.source++
      if (run.source >= sources.length) {
        raster.done = run.to
        raster.run = null
      } else run.position = sources[run.source].offsets[run.from]
    }
    if (performance.now() >= deadline)
      return !raster.run && raster.done >= wanted
  }
}

export default function MeetingMap({
  network,
  origins,
  output,
  selected,
  progress,
  collisions,
  onPick,
  onSelect,
  onReadyChange,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const render = useRef<() => void>(() => {})
  const prepare = useRef<() => void>(() => {})
  const unproject = useRef<(x: number, y: number) => Coordinate>(() => [0, 0])
  const markerHit = useRef<(x: number, y: number) => number>(() => -1)
  const view = useRef({ zoom: 1, x: WORLD / 2, y: WORLD / 2 })
  const mapHeight = useRef(WORLD)
  const pan = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const latest = useRef({
    origins,
    output,
    selected,
    progress,
    collisions,
    onPick,
    onSelect,
    onReadyChange,
  })
  latest.current = {
    origins,
    output,
    selected,
    progress,
    collisions,
    onPick,
    onSelect,
    onReadyChange,
  }
  const [zoom, setZoom] = useState(1)

  // Geometry stays in world space. Panning and zooming repaint cached rasters;
  // neither pointer movement nor animation progress rebuilds the road graph.
  // Base geometry (points, road raster) and per-output traversal buckets are
  // prepared in cancellable slices; `onReadyChange` reports when both are ready.
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const context = element.getContext('2d')
    if (!context) return
    const geometryMeasure = PROFILE_PREPARATION
      ? beginPreparation('geometry')
      : undefined
    const [west, south, east, north] = network.bounds
    const longitudeScale = Math.cos(((south + north) * Math.PI) / 360)
    const unit = WORLD / ((east - west) * longitudeScale)
    const worldHeight = (north - south) * unit
    const count = network.nodes.length
    const geometry: Geometry = {
      x: new Float64Array(count),
      y: new Float64Array(count),
      from: new Int32Array(network.edges.length),
      to: new Int32Array(network.edges.length),
      ready: false,
      roads: null,
    }
    if (PROFILE_PREPARATION && geometryMeasure)
      geometryMeasure.setupCpuMs = performance.now() - geometryMeasure.startTime
    mapHeight.current = worldHeight
    view.current = { zoom: 1, x: WORLD / 2, y: worldHeight / 2 }
    const createLayer = () => {
      const layer = document.createElement('canvas')
      layer.width = WORLD * RASTER
      layer.height = Math.ceil(worldHeight * RASTER)
      layer.getContext('2d')!.scale(RASTER, RASTER)
      return layer
    }
    const release = (layer: HTMLCanvasElement) => {
      layer.width = 0
      layer.height = 0
    }
    const createRaster = (owner: Traversal): Raster => {
      const layer = createLayer()
      return {
        canvas: layer,
        context: layer.getContext('2d')!,
        owner,
        version,
        done: 0,
        run: null,
      }
    }
    let width = 0
    let height = 0
    let foreground = ''
    let background = ''
    let font = ''
    let roadColor = ''
    let colors: string[] = []
    let signature = ''
    let version = 0
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let scale = 1
    let offsetX = 0
    let offsetY = 0
    let alive = true
    let reported: boolean | null = null
    let traversal: Traversal | null = null
    let live: Raster | null = null
    let stage: Raster | null = null
    let lastSelected = -1
    let lastWanted = 0
    let routeCache: {
      output: SearchOutput
      selected: number
      routes: number[][]
    } | null = null
    let checked: { output: SearchOutput; fits: boolean } | null = null
    let stopBase = () => {}
    let stopRoads = () => {}
    let stopTraversal = () => {}

    // An output only applies to the network whose node count it was built for.
    const fit = (candidate: SearchOutput | null) => {
      if (!candidate) return null
      if (checked?.output !== candidate)
        checked = {
          output: candidate,
          fits:
            candidate.trees.every(
              (tree) =>
                tree.distances.length === count &&
                tree.parents.length === count,
            ) &&
            candidate.results.every(
              (spot) => spot.node >= 0 && spot.node < count,
            ),
        }
      return checked.fits ? candidate : null
    }
    const report = () => {
      if (!alive) return
      const wanted = fit(latest.current.output)
      const ready =
        geometry.roads !== null &&
        (!wanted ||
          (traversal !== null &&
            traversal.output === wanted &&
            traversal.ready))
      if (ready === reported) return
      reported = ready
      latest.current.onReadyChange?.(ready)
    }
    const screen = (point: [number, number]): [number, number] => [
      point[0] * scale + offsetX,
      point[1] * scale + offsetY,
    ]
    const place = (node: number): [number, number] => [
      geometry.x[node] * scale + offsetX,
      geometry.y[node] * scale + offsetY,
    ]

    function* project(): Generator<void, void, void> {
      for (let start = 0; start < count; start += NODE_CHUNK) {
        const end = Math.min(count, start + NODE_CHUNK)
        for (let i = start; i < end; i++) {
          const [lon, lat] = network.nodes[i]
          geometry.x[i] = (lon - west) * longitudeScale * unit
          geometry.y[i] = (north - lat) * unit
        }
        yield
      }
      const total = network.edges.length
      for (let start = 0; start < total; start += EDGE_CHUNK) {
        const end = Math.min(total, start + EDGE_CHUNK)
        for (let i = start; i < end; i++) {
          geometry.from[i] = network.edges[i][0]
          geometry.to[i] = network.edges[i][1]
        }
        yield
      }
    }
    // Roads are stroked opaque into a fresh layer and blended once when
    // drawn; a theme change repaints a replacement while the old one shows.
    function* strokeRoads(
      layer: HTMLCanvasElement,
      color: string,
    ): Generator<void, void, void> {
      const layerContext = layer.getContext('2d')!
      layerContext.strokeStyle = color
      layerContext.lineWidth = 0.9
      const total = geometry.from.length
      for (let start = 0; start < total; start += ROAD_CHUNK) {
        const end = Math.min(total, start + ROAD_CHUNK)
        layerContext.beginPath()
        for (let i = start; i < end; i++) {
          const a = geometry.from[i]
          const b = geometry.to[i]
          layerContext.moveTo(geometry.x[a], geometry.y[a])
          layerContext.lineTo(geometry.x[b], geometry.y[b])
        }
        layerContext.stroke()
        yield
      }
    }
    const paintRoads = () => {
      stopRoads()
      const measure = PROFILE_PREPARATION
        ? beginPreparation('roads')
        : undefined
      const layer = createLayer()
      if (PROFILE_PREPARATION && measure)
        measure.setupCpuMs = performance.now() - measure.startTime
      let finished = false
      const stop = runSliced(
        strokeRoads(layer, roadColor),
        () => {
          finished = true
          if (geometry.roads) release(geometry.roads)
          geometry.roads = layer
          report()
          render.current()
        },
        measure,
      )
      stopRoads = () => {
        if (finished) return
        stop()
        release(layer)
      }
    }
    function* bucketOutput(target: Traversal): Generator<void, void, void> {
      const scratch = new Uint16Array(geometry.from.length)
      for (const tree of target.output.trees)
        target.sources.push(
          yield* bucketTraversal(
            tree.distances,
            geometry.from,
            geometry.to,
            target.plan,
            scratch,
          ),
        )
    }
    // Idempotent: (re)starts traversal preparation when the output changed and
    // cancels any older job, so a late result can never replace a newer one.
    const prepareTraversal = () => {
      if (!alive) return
      const wanted = fit(latest.current.output)
      if (!geometry.ready) {
        report()
        return
      }
      if (traversal ? traversal.output === wanted : wanted === null) {
        report()
        return
      }
      stopTraversal()
      stopTraversal = () => {}
      traversal = null
      if (wanted) {
        const measure = PROFILE_PREPARATION
          ? beginPreparation('traversal')
          : undefined
        const target: Traversal = {
          output: wanted,
          plan: planTraversal(
            wanted.results.map((candidate) => candidate.longest),
          ),
          sources: [],
          ready: false,
        }
        if (PROFILE_PREPARATION && measure)
          measure.setupCpuMs = performance.now() - measure.startTime
        traversal = target
        if (target.plan.count === 0) {
          target.ready = true
          if (PROFILE_PREPARATION && measure)
            finishPreparation(measure, 'completed')
        } else {
          let finished = false
          const stop = runSliced(
            bucketOutput(target),
            () => {
              finished = true
              target.ready = true
              if (traversal !== target) return
              report()
              render.current()
            },
            measure,
          )
          stopTraversal = () => {
            if (!finished) stop()
          }
        }
      }
      report()
      render.current()
    }
    prepare.current = prepareTraversal

    // Seeking back, or moving to a lower candidate cutoff, cannot un-paint a
    // raster. A seek repaints in place (partial, never stale); a selection or
    // theme change repaints a staging raster and swaps it in when complete, so
    // the previous coherent trail stays until the replacement is ready.
    const settleTrail = (
      prepared: Traversal | null,
      wanted: number,
      pick: number,
    ) => {
      const changed = pick !== lastSelected
      lastSelected = pick
      const rewound = !changed && wanted < lastWanted
      lastWanted = wanted
      if (!prepared || wanted === 0) {
        if (stage) release(stage.canvas)
        stage = null
        if (live && (live.owner || live.done || live.run)) {
          live.context.clearRect(0, 0, WORLD, worldHeight)
          live.owner = null
          live.done = 0
          live.run = null
        }
        return true
      }
      const restart = (raster: Raster) => {
        raster.context.clearRect(0, 0, WORLD, worldHeight)
        raster.owner = prepared
        raster.version = version
        raster.done = 0
        raster.run = null
      }
      if (!live) live = createRaster(prepared)
      else if (live.owner !== prepared) {
        if (stage) release(stage.canvas)
        stage = null
        restart(live)
      }
      let target = live
      if (live.version === version && wanted >= reach(live)) {
        if (stage) release(stage.canvas)
        stage = null
      } else if (
        live.version === version &&
        (rewound || (!changed && !stage))
      ) {
        if (stage) release(stage.canvas)
        stage = null
        restart(live)
      } else {
        if (stage && (stage.owner !== prepared || stage.version !== version)) {
          release(stage.canvas)
          stage = null
        }
        if (!stage) stage = createRaster(prepared)
        else if (wanted < reach(stage)) restart(stage)
        target = stage
      }
      const current = paintRaster(
        target,
        geometry,
        prepared.sources,
        colors,
        wanted,
        performance.now() + TRAIL_BUDGET_MS,
      )
      if (target === stage && current) {
        release(live.canvas)
        live = stage
        stage = null
      }
      return current
    }

    const draw = () => {
      frame = 0
      const current = latest.current
      scale =
        Math.min((width - 48) / WORLD, (height - 60) / worldHeight) *
        view.current.zoom
      offsetX = width / 2 - view.current.x * scale
      offsetY = height / 2 - view.current.y * scale
      const explored = searchProgress(current.progress)
      const reveal = resultRevealProgress(current.progress, motion.matches)
      const output = fit(current.output)
      const result = output?.results[current.selected]
      const prepared =
        traversal && traversal.ready && traversal.output === output
          ? traversal
          : null
      const wanted =
        prepared && result
          ? traversalCutoff(prepared.plan, result.longest, explored)
          : 0
      const caughtUp = geometry.ready
        ? settleTrail(prepared, wanted, current.selected)
        : true
      context.fillStyle = background
      context.fillRect(0, 0, width, height)
      if (geometry.roads) {
        context.globalAlpha = 0.28
        context.drawImage(
          geometry.roads,
          offsetX,
          offsetY,
          WORLD * scale,
          worldHeight * scale,
        )
        context.globalAlpha = 1
      }
      if (live && prepared && live.owner === prepared && result) {
        context.globalAlpha = 0.8 + (0.27 - 0.8) * reveal
        context.drawImage(
          live.canvas,
          offsetX,
          offsetY,
          WORLD * scale,
          worldHeight * scale,
        )
        context.globalAlpha = 1
      }
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      if (output && result && geometry.ready && explored >= 1) {
        const { trees, results } = output
        if (
          routeCache?.output !== output ||
          routeCache.selected !== current.selected
        )
          routeCache = {
            output,
            selected: current.selected,
            routes: trees.map((tree) => routeTo(tree, result.node)),
          }
        context.save()
        context.globalAlpha = Math.min(1, reveal / 0.2)
        context.lineCap = 'round'
        routeCache.routes.forEach((route, source) => {
          const tree = trees[source]
          const distance =
            tree.distances[result.node] * Math.min(1, reveal / 0.75)
          context.beginPath()
          for (let i = 0; i < route.length; i++) {
            const node = route[i]
            const point = place(node)
            if (i === 0) {
              context.moveTo(...point)
              continue
            }
            if (tree.distances[node] > distance) {
              const previous = route[i - 1]
              const fraction =
                (distance - tree.distances[previous]) /
                (tree.distances[node] - tree.distances[previous])
              const from = place(previous)
              context.lineTo(
                from[0] + (point[0] - from[0]) * fraction,
                from[1] + (point[1] - from[1]) * fraction,
              )
              break
            }
            context.lineTo(...point)
          }
          context.strokeStyle = colors[source % 5]
          context.lineWidth = 3
          context.lineJoin = 'round'
          context.stroke()
        })
        results.forEach((candidate, i) => {
          const opacity = markerRevealOpacity(
            reveal,
            i,
            current.selected,
            results.length,
          )
          if (opacity === 0) return
          context.globalAlpha = opacity
          const [x, y] = place(candidate.node)
          context.beginPath()
          context.arc(
            x,
            y,
            (i === current.selected ? 13 : 9) * (0.7 + 0.3 * opacity),
            0,
            Math.PI * 2,
          )
          context.fillStyle = foreground
          context.fill()
          context.strokeStyle = background
          context.lineWidth = 2
          context.stroke()
          context.fillStyle = background
          context.font = `600 11px ${font}`
          context.fillText(String(i + 1), x, y)
        })
        context.restore()
      }
      if (geometry.ready)
        current.origins.forEach((origin, i) => {
          if (origin.node === null || origin.node >= count) return
          const [x, y] = place(origin.node)
          context.beginPath()
          context.arc(x, y, 12, 0, Math.PI * 2)
          context.fillStyle = background
          context.fill()
          context.strokeStyle = colors[i % 5]
          context.lineWidth = 3
          context.stroke()
          context.fillStyle = foreground
          context.font = `700 11px ${font}`
          context.fillText(
            String.fromCharCode(65 + (i % 26)) +
              (i >= 26 ? String(Math.floor(i / 26)) : ''),
            x,
            y,
          )
        })
      if (result && geometry.ready) {
        context.save()
        context.textAlign = 'center'
        context.font = `600 11px ${font}`
        for (const collision of current.collisions) {
          const start =
            (collision.metres / Math.max(result.longest, 1)) *
            SEARCH_COMPLETE_AT
          const age = (current.progress - start) / COLLISION_PING_SPAN
          if (age < 0 || age >= 1 || motion.matches) continue
          const [x, y] = screen([
            (collision.coordinate[0] - west) * longitudeScale * unit,
            (north - collision.coordinate[1]) * unit,
          ])
          const radius = 7 + 30 * (1 - (1 - age) ** 3)
          context.globalAlpha = 1 - age
          context.lineWidth = 3
          collision.sources.forEach((source, half) => {
            context.strokeStyle = colors[source % 5]
            context.shadowColor = colors[source % 5]
            context.shadowBlur = 10
            context.beginPath()
            context.arc(x, y, radius, half * Math.PI, (half + 1) * Math.PI)
            context.stroke()
          })
          context.shadowBlur = 0
          context.strokeStyle = foreground
          context.lineWidth = 2
          context.beginPath()
          context.moveTo(x - 3, y)
          context.lineTo(x + 3, y)
          context.moveTo(x, y - 3)
          context.lineTo(x, y + 3)
          context.stroke()
          const label = collision.sources
            .map(
              (source) =>
                String.fromCharCode(65 + (source % 26)) +
                (source >= 26 ? String(Math.floor(source / 26)) : ''),
            )
            .join(' + ')
          context.lineWidth = 3
          context.strokeStyle = background
          context.strokeText(label, x, y + radius + 12)
          context.fillStyle = foreground
          context.fillText(label, x, y + radius + 12)
        }
        if (explored >= 1) {
          const [x, y] = place(result.node)
          const age =
            (current.progress - SEARCH_COMPLETE_AT) / (1 - SEARCH_COMPLETE_AT)
          context.globalAlpha = reveal
          context.shadowBlur = 0
          // The steady segmented halo survives the pulse, including reduced motion.
          current.origins.forEach((_, source) => {
            context.strokeStyle = colors[source % 5]
            context.lineWidth = 3
            context.beginPath()
            context.arc(
              x,
              y,
              23,
              (source / current.origins.length) * Math.PI * 2,
              ((source + 1) / current.origins.length) * Math.PI * 2,
            )
            context.stroke()
          })
          if (!motion.matches && age < 1) {
            for (const delay of [0, 0.18, 0.36]) {
              const pulse = (age - delay) / (1 - delay)
              if (pulse < 0 || pulse >= 1) continue
              context.globalAlpha =
                Math.min(1, pulse / 0.12) * (1 - pulse) ** 1.5
              context.strokeStyle = foreground
              context.shadowColor = foreground
              context.shadowBlur = 14
              context.lineWidth = 2
              context.beginPath()
              context.arc(
                x,
                y,
                18 + 62 * (1 - (1 - pulse) ** 3),
                0,
                Math.PI * 2,
              )
              context.stroke()
            }
          }
        }
        context.restore()
      }
      context.strokeStyle = foreground
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(24, height - 29)
      context.lineTo(24, height - 24)
      context.lineTo(104, height - 24)
      context.lineTo(104, height - 29)
      context.stroke()
      context.fillStyle = foreground
      context.textAlign = 'left'
      context.font = `11px ${font}`
      context.fillText(
        `${(distanceBetween(unproject.current(24, height - 24), unproject.current(104, height - 24)) / 1000).toFixed(1)} km`,
        24,
        height - 39,
      )
      // Budgeted trail painting continues next frame until it catches up.
      if (!caughtUp) render.current()
    }
    render.current = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    unproject.current = (x, y) => [
      west + (x - offsetX) / scale / (longitudeScale * unit),
      north - (y - offsetY) / scale / unit,
    ]
    markerHit.current = (x, y) => {
      const current = latest.current
      const output = fit(current.output)
      if (!geometry.ready || !output || searchProgress(current.progress) < 1)
        return -1
      const reveal = resultRevealProgress(current.progress, motion.matches)
      return output.results.findIndex((candidate, i) => {
        if (
          markerRevealOpacity(
            reveal,
            i,
            current.selected,
            output.results.length,
          ) < 0.5
        )
          return false
        const [px, py] = place(candidate.node)
        return Math.hypot(px - x, py - y) < 16
      })
    }
    const theme = () => {
      const styles = getComputedStyle(element)
      const next = [
        'foreground',
        'background',
        'muted-foreground',
        'chart-1',
        'chart-2',
        'chart-3',
        'chart-4',
        'chart-5',
      ].map((name) => `hsl(${styles.getPropertyValue(`--${name}`)})`)
      const key = `${styles.fontFamily}|${next.join('|')}`
      if (key === signature) return
      signature = key
      font = styles.fontFamily
      ;[foreground, background, roadColor, ...colors] = next
      version++
      if (geometry.ready) paintRoads()
      render.current()
    }
    const resize = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      width = rect.width
      height = rect.height
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      render.current()
    })
    resize.observe(element)
    const observer = new MutationObserver(theme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    theme()
    motion.addEventListener('change', render.current)
    report()
    const stop = runSliced(
      project(),
      () => {
        geometry.ready = true
        paintRoads()
        prepareTraversal()
      },
      geometryMeasure,
    )
    stopBase = stop
    return () => {
      alive = false
      stopBase()
      stopRoads()
      stopTraversal()
      for (const raster of [live, stage]) if (raster) release(raster.canvas)
      if (geometry.roads) release(geometry.roads)
      prepare.current = () => {}
      resize.disconnect()
      observer.disconnect()
      motion.removeEventListener('change', render.current)
      cancelAnimationFrame(frame)
    }
  }, [network])

  // A new output (or network) restarts traversal preparation; selection and
  // progress only repaint.
  useEffect(() => {
    prepare.current()
  }, [network, output])
  useEffect(() => {
    render.current()
  }, [progress, origins, selected, collisions])

  const changeZoom = (value: number) => {
    view.current.zoom = value
    setZoom(value)
    render.current()
  }
  return (
    <div className="bg-background relative overflow-hidden rounded-xl border">
      <div className="border-b px-4 py-3 text-xs">
        <span className="block font-semibold">
          {network.name.toUpperCase()}
        </span>
        <span className="text-muted-foreground">Walking network · North ↑</span>
      </div>
      <canvas
        ref={canvas}
        className="block aspect-square w-full cursor-crosshair touch-none"
        role="img"
        aria-label={`Interactive walking network of ${network.name}. Use the location inputs for keyboard access. Drag to pan; click to place the active starting location.`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          pan.current = { x: event.clientX, y: event.clientY, moved: false }
        }}
        onPointerMove={(event) => {
          const start = pan.current
          if (!start) return
          if (
            Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5 &&
            !start.moved
          )
            return
          start.moved = true
          const rect = event.currentTarget.getBoundingClientRect()
          const a = unproject.current(start.x - rect.left, start.y - rect.top)
          const b = unproject.current(
            event.clientX - rect.left,
            event.clientY - rect.top,
          )
          const [west, south, east, north] = network.bounds
          const unit = WORLD / (east - west)
          view.current.x = Math.max(
            0,
            Math.min(WORLD, view.current.x + (a[0] - b[0]) * unit),
          )
          view.current.y = Math.max(
            0,
            Math.min(
              mapHeight.current,
              view.current.y -
                ((a[1] - b[1]) * unit) /
                  Math.cos(((south + north) * Math.PI) / 360),
            ),
          )
          start.x = event.clientX
          start.y = event.clientY
          render.current()
        }}
        onPointerUp={(event) => {
          const start = pan.current
          pan.current = null
          if (!start || start.moved) return
          const rect = event.currentTarget.getBoundingClientRect()
          const x = event.clientX - rect.left
          const y = event.clientY - rect.top
          const hit = markerHit.current(x, y)
          if (hit >= 0) latest.current.onSelect(hit)
          else latest.current.onPick(unproject.current(x, y))
        }}
        onPointerCancel={() => {
          pan.current = null
        }}
      />
      <div className="bg-background absolute top-20 right-4 flex flex-col gap-1 rounded-lg border p-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={zoom >= 4}
          onClick={() => changeZoom(Math.min(4, zoom + 0.5))}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={zoom <= 1}
          onClick={() => changeZoom(Math.max(1, zoom - 0.5))}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Fit region"
          onClick={() => {
            view.current.x = WORLD / 2
            view.current.y = mapHeight.current / 2
            changeZoom(1)
          }}
        >
          <LocateFixed />
        </Button>
      </div>
      <a
        className="bg-background/90 absolute right-3 bottom-3 rounded px-2 py-1 text-[0.625rem] underline underline-offset-2"
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © OpenStreetMap contributors · ODbL
      </a>
    </div>
  )
}
