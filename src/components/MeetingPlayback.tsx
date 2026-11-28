import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import MeetingMap, { type Origin } from '@/components/MeetingMap'
import { searchProgress, type SearchCollision } from '@/lib/meeting-collisions'
import type { InfluenceSource } from '@/lib/meeting-influence'
import type {
  Coordinate,
  MeetingNetwork,
  SearchOutput,
} from '@/lib/meeting-point'

export type MeetingSelection = { index: number; reveal: 'auto' | 'routes' }
const letter = (index: number) =>
  String.fromCharCode(65 + (index % 26)) +
  (index >= 26 ? String(Math.floor(index / 26)) : '')

export default function MeetingPlayback({
  network,
  origins,
  output,
  selection,
  collisions,
  notice,
  searching,
  onPick,
  onSelect,
  influences,
  picking,
  areaName,
}: {
  network: MeetingNetwork
  origins: Origin[]
  output: SearchOutput | null
  selection: MeetingSelection
  collisions: SearchCollision[]
  notice: string
  searching: boolean
  onPick: (coordinate: Coordinate) => void
  onSelect: (index: number) => void
  /** Spheres of influence shown on the map. */
  influences?: readonly InfluenceSource[]
  /** What a map click does: move the active start or drop a bubble. */
  picking?: 'start' | 'bubble'
  /** Displayed area title; defaults to `network.name`. */
  areaName?: string
}) {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [ready, setReady] = useState(false)
  const reducedMotion = useRef(false)
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
    return () => preference.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    // The selection object is a command, including a repeat click on the same result.
    const final =
      Boolean(output) &&
      (selection.reveal === 'routes' || reducedMotion.current)
    setProgress(final ? 1 : 0)
    setPlaying(Boolean(output) && !final)
  }, [output, selection])
  useEffect(() => {
    if (!playing || !ready) return
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
  }, [playing, ready, speed])
  useEffect(() => {
    if (progress >= 1) setPlaying(false)
  }, [progress])

  const result = output?.results[selection.index]
  const explored = searchProgress(progress)
  const collisionCount = collisions.reduce(
    (count, collision) =>
      count + Number(collision.metres <= explored * (result?.longest ?? 0)),
    0,
  )
  const lastCollision = collisions.findLast(
    (collision) => collision.metres <= explored * (result?.longest ?? 0),
  )
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Animated road search"
    >
      <div className="relative flex min-h-0 flex-1">
        <MeetingMap
          network={network}
          origins={origins}
          output={output}
          selected={selection.index}
          progress={progress}
          collisions={collisions}
          onPick={onPick}
          onSelect={onSelect}
          onReadyChange={setReady}
          influences={influences}
          picking={picking}
          areaName={areaName}
        />
      </div>
      <div className="bg-card/95 shrink-0 space-y-1.5 border-t px-3 py-2.5 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={!output}
            aria-label={
              playing ? 'Pause search animation' : 'Play search animation'
            }
            onClick={() => {
              if (progress >= 1) setProgress(0)
              setPlaying((value) => !value)
            }}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={!output}
            aria-label="Replay search animation"
            onClick={() => {
              setProgress(0)
              setPlaying(true)
            }}
          >
            <RotateCcw className="size-4" />
          </Button>
          <label className="flex h-8 min-w-24 flex-1 items-center">
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
            className="h-8 px-2 text-xs"
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
            className="h-8 px-2 text-xs"
            disabled={!output || progress >= 1}
            onClick={() => {
              setProgress(1)
              setPlaying(false)
            }}
          >
            Skip to routes
          </Button>
        </div>
        <p className="text-muted-foreground truncate text-xs" role="status">
          {notice ||
            (searching
              ? `Running ${origins.length} shortest-path searches in a background worker…`
              : output && !ready && playing
                ? 'Preparing the animated road layer…'
                : output
                  ? `${output.results.length} alternatives found. ${explored < 1 ? `${collisionCount} of ${collisions.length} first contacts.${lastCollision ? ` Latest: ${lastCollision.sources.map(letter).join(' + ')}.` : ''} Split-color pings mark where searches first meet.` : `All ${origins.length} starts have reached ${result?.name}. The larger ping marks convergence; solid lines show shortest routes.`}`
                  : ready
                    ? 'Ready when you are. Run the search to watch the roads light up.'
                    : 'Drawing the walking network…')}
        </p>
      </div>
    </section>
  )
}
