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

export type Origin = { id: number; name: string; node: number | null }
export const originColor = (index: number) =>
  `hsl(var(--chart-${(index % 5) + 1}))`
const STEPS = 180
const WORLD = 1024
const RASTER = 2

type Props = {
  network: MeetingNetwork
  origins: Origin[]
  output: SearchOutput | null
  selected: number
  progress: number
  collisions: SearchCollision[]
  onPick: (coordinate: Coordinate) => void
  onSelect: (index: number) => void
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
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const render = useRef<() => void>(() => {})
  const unproject = useRef<(x: number, y: number) => Coordinate>(() => [0, 0])
  const markerHit = useRef<(x: number, y: number) => number>(() => -1)
  const view = useRef({ zoom: 1, x: WORLD / 2, y: WORLD / 2 })
  const pan = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const latest = useRef({
    origins,
    output,
    selected,
    progress,
    collisions,
    onPick,
    onSelect,
  })
  latest.current = {
    origins,
    output,
    selected,
    progress,
    collisions,
    onPick,
    onSelect,
  }
  const [zoom, setZoom] = useState(1)
  const buckets = useRef<Path2D[][]>([])
  const routes = useRef<number[][]>([])
  const painted = useRef(-1)
  const layers = useRef<{
    roads: HTMLCanvasElement
    trails: HTMLCanvasElement
    points: [number, number][]
    height: number
  } | null>(null)

  // Geometry stays in world space. Panning and zooming repaint cached rasters;
  // neither pointer movement nor animation progress rebuilds the road graph.
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const context = element.getContext('2d')
    if (!context) return
    const [west, south, east, north] = network.bounds
    const longitudeScale = Math.cos(((south + north) * Math.PI) / 360)
    const unit = WORLD / ((east - west) * longitudeScale)
    const worldHeight = (north - south) * unit
    const points: [number, number][] = network.nodes.map(([lon, lat]) => [
      (lon - west) * longitudeScale * unit,
      (north - lat) * unit,
    ])
    const roads = document.createElement('canvas')
    const trails = document.createElement('canvas')
    for (const layer of [roads, trails]) {
      layer.width = WORLD * RASTER
      layer.height = Math.ceil(worldHeight * RASTER)
    }
    const roadContext = roads.getContext('2d')!
    const trailContext = trails.getContext('2d')!
    roadContext.scale(RASTER, RASTER)
    trailContext.scale(RASTER, RASTER)
    layers.current = { roads, trails, points, height: worldHeight }
    view.current = { zoom: 1, x: WORLD / 2, y: worldHeight / 2 }
    const roadPath = new Path2D()
    for (const [a, b] of network.edges) {
      roadPath.moveTo(...points[a])
      roadPath.lineTo(...points[b])
    }
    let width = 0
    let height = 0
    let foreground = ''
    let background = ''
    let font = ''
    let colors: string[] = []
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let scale = 1
    let offsetX = 0
    let offsetY = 0
    const screen = (point: [number, number]): [number, number] => [
      point[0] * scale + offsetX,
      point[1] * scale + offsetY,
    ]
    const draw = () => {
      const current = latest.current
      scale =
        Math.min((width - 48) / WORLD, (height - 60) / worldHeight) *
        view.current.zoom
      offsetX = width / 2 - view.current.x * scale
      offsetY = height / 2 - view.current.y * scale
      const explored = searchProgress(current.progress)
      const reveal = resultRevealProgress(current.progress, motion.matches)
      const target = Math.floor(explored * STEPS)
      if (target < painted.current) {
        trailContext.clearRect(0, 0, WORLD, worldHeight)
        painted.current = -1
      }
      if (target > painted.current) {
        buckets.current.forEach((steps, source) => {
          trailContext.strokeStyle = colors[source % 5]
          trailContext.lineWidth = 1.5
          for (let i = painted.current + 1; i <= target; i++)
            trailContext.stroke(steps[i])
        })
        painted.current = target
      }
      context.fillStyle = background
      context.fillRect(0, 0, width, height)
      context.drawImage(
        roads,
        offsetX,
        offsetY,
        WORLD * scale,
        worldHeight * scale,
      )
      context.globalAlpha = 0.8 + (0.27 - 0.8) * reveal
      context.drawImage(
        trails,
        offsetX,
        offsetY,
        WORLD * scale,
        worldHeight * scale,
      )
      context.globalAlpha = 1
      const result = current.output?.results[current.selected]
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      if (current.output && result && explored >= 1) {
        const { trees, results } = current.output
        context.save()
        context.globalAlpha = Math.min(1, reveal / 0.2)
        context.lineCap = 'round'
        routes.current.forEach((route, source) => {
          const tree = trees[source]
          const distance =
            tree.distances[result.node] * Math.min(1, reveal / 0.75)
          context.beginPath()
          for (let i = 0; i < route.length; i++) {
            const node = route[i]
            const point = screen(points[node])
            if (i === 0) {
              context.moveTo(...point)
              continue
            }
            if (tree.distances[node] > distance) {
              const previous = route[i - 1]
              const fraction =
                (distance - tree.distances[previous]) /
                (tree.distances[node] - tree.distances[previous])
              const from = screen(points[previous])
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
        results.forEach((place, i) => {
          const opacity = markerRevealOpacity(
            reveal,
            i,
            current.selected,
            results.length,
          )
          if (opacity === 0) return
          context.globalAlpha = opacity
          const [x, y] = screen(points[place.node])
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
      current.origins.forEach((origin, i) => {
        if (origin.node === null) return
        const [x, y] = screen(points[origin.node])
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
      if (result) {
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
          const [x, y] = screen(points[result.node])
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
    }
    render.current = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    }
    unproject.current = (x, y) => [
      west + (x - offsetX) / scale / (longitudeScale * unit),
      north - (y - offsetY) / scale / unit,
    ]
    markerHit.current = (x, y) => {
      const current = latest.current
      const output = current.output
      if (!output || searchProgress(current.progress) < 1) return -1
      const reveal = resultRevealProgress(current.progress, motion.matches)
      return output.results.findIndex((place, i) => {
        if (
          markerRevealOpacity(
            reveal,
            i,
            current.selected,
            output.results.length,
          ) < 0.5
        )
          return false
        const [px, py] = screen(points[place.node])
        return Math.hypot(px - x, py - y) < 16
      })
    }
    const theme = () => {
      const styles = getComputedStyle(element)
      foreground = `hsl(${styles.getPropertyValue('--foreground')})`
      background = `hsl(${styles.getPropertyValue('--background')})`
      font = styles.fontFamily
      colors = Array.from(
        { length: 5 },
        (_, i) => `hsl(${styles.getPropertyValue(`--chart-${i + 1}`)})`,
      )
      roadContext.clearRect(0, 0, WORLD, worldHeight)
      roadContext.strokeStyle = `hsl(${styles.getPropertyValue('--muted-foreground')})`
      roadContext.globalAlpha = 0.28
      roadContext.lineWidth = 0.9
      roadContext.stroke(roadPath)
      roadContext.globalAlpha = 1
      trailContext.clearRect(0, 0, WORLD, worldHeight)
      painted.current = -1
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
    return () => {
      resize.disconnect()
      observer.disconnect()
      motion.removeEventListener('change', render.current)
      cancelAnimationFrame(frame)
      layers.current = null
    }
  }, [network])

  useEffect(() => {
    const layer = layers.current
    if (!layer) return
    const result = output?.results[selected]
    routes.current =
      output && result
        ? output.trees.map((tree) => routeTo(tree, result.node))
        : []
    const paths =
      output && result
        ? output.trees.map(() =>
            Array.from({ length: STEPS + 1 }, () => new Path2D()),
          )
        : []
    if (output && result) {
      output.trees.forEach((tree, source) => {
        for (const [a, b] of network.edges) {
          const step = Math.floor(
            (Math.min(tree.distances[a], tree.distances[b]) /
              Math.max(result.longest, 1)) *
              STEPS,
          )
          if (step <= STEPS) {
            paths[source][step].moveTo(...layer.points[a])
            paths[source][step].lineTo(...layer.points[b])
          }
        }
      })
    }
    buckets.current = paths
    layer.trails.getContext('2d')!.clearRect(0, 0, WORLD, layer.height)
    painted.current = -1
    render.current()
  }, [network, output, selected])
  useEffect(() => {
    render.current()
  }, [progress, origins])

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
              layers.current?.height ?? WORLD,
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
            view.current.y = (layers.current?.height ?? WORLD) / 2
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
