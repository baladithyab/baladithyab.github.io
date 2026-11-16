import { useEffect, useRef, useState } from 'react'
import { MousePointerClick, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { influenceColorVars } from '@/components/MeetingMap'
import MeetingPlaceSearch from '@/components/MeetingPlaceSearch'
import type { MeetingPlace } from '@/lib/meeting-geocoder'
import {
  addBubble,
  BUBBLE_RADIUS,
  BUBBLE_STRENGTH,
  INFLUENCE_BUDGET,
  type BubbleDraft,
  type BubblePolarity,
  type InfluenceSource,
} from '@/lib/meeting-influence'
import type { MeetingNetwork } from '@/lib/meeting-point'

export type MeetingInfluencePanelProps = {
  network: MeetingNetwork
  /** Local landmarks and intersections for the place search. */
  places: MeetingPlace[]
  /** Hand-placed sources, all of kind 'bubble'. */
  bubbles: InfluenceSource[]
  onBubblesChange: (next: InfluenceSource[]) => void
  /** Polarity and radius for the next bubble, shared with map clicks. */
  draft: BubbleDraft
  onDraftChange: (next: BubbleDraft) => void
  /** Metres of walking per person that a full-strength bubble is worth. */
  budget: number
  onBudgetChange: (next: number) => void
  /** Whether map clicks currently drop bubbles. */
  dropping: boolean
  onDroppingChange: (next: boolean) => void
  /** Live traffic and event sources also active, for the summary line. */
  liveCount?: number
}

const polarities = [
  { value: 'attract', title: 'Meet near' },
  { value: 'avoid', title: 'Keep away' },
] satisfies { value: BubblePolarity; title: string }[]
const placeSearchId = 'meeting-bubble-place'
const dropToggleId = 'meeting-bubble-drop'

// Mirrors the map: attract is a solid ring with a plus, avoid a dashed ring
// with a minus, so the two differ by more than colour.
function PolarityMark({ polarity }: { polarity: BubblePolarity }) {
  const attract = polarity === 'attract'
  const color = attract ? 'var(--influence-attract)' : 'var(--influence-avoid)'
  return (
    <span
      aria-hidden="true"
      className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-sm leading-none font-bold ${attract ? '' : 'border-dashed'}`}
      style={{ borderColor: color, color }}
    >
      {attract ? '+' : '−'}
    </span>
  )
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  valueText,
  describedBy,
  onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  valueText: string
  describedBy?: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <label htmlFor={id} className="text-muted-foreground font-medium">
          {label}
        </label>
        <output htmlFor={id} className="tabular-nums">
          {display}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="accent-foreground focus-visible:outline-ring block h-6 w-full rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        aria-describedby={describedBy}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

function PolarityChoice({
  name,
  legend,
  value,
  onChange,
}: {
  name: string
  legend: string
  value: BubblePolarity
  onChange: (value: BubblePolarity) => void
}) {
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      <div className="grid grid-cols-2 gap-2">
        {polarities.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${value === option.value ? 'border-foreground/50 bg-muted/50' : 'hover:bg-muted/30'}`}
          >
            <input
              type="radio"
              name={name}
              className="accent-foreground size-4"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <PolarityMark polarity={option.value} />
            {option.title}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export default function MeetingInfluencePanel({
  network,
  places,
  bubbles,
  onBubblesChange,
  draft,
  onDraftChange,
  budget,
  onBudgetChange,
  dropping,
  onDroppingChange,
  liveCount = 0,
}: MeetingInfluencePanelProps) {
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState('')
  const [feedback, setFeedback] = useState('')
  // Removing a bubble removes the focused control; focus moves once the
  // parent has applied the change.
  const focusAfter = useRef<string | null>(null)
  useEffect(() => {
    const id = focusAfter.current
    if (!id) return
    focusAfter.current = null
    document.getElementById(id)?.focus()
  }, [bubbles])

  const nameOf = (bubble: InfluenceSource, index: number) =>
    bubble.label.trim() || `Bubble ${index + 1}`
  const idOf = (bubble: InfluenceSource) =>
    `meeting-bubble-${encodeURIComponent(bubble.id)}`
  const update = (id: string, change: Partial<InfluenceSource>) =>
    onBubblesChange(
      bubbles.map((bubble) =>
        bubble.id === id ? { ...bubble, ...change } : bubble,
      ),
    )
  const remove = (index: number) => {
    const next = bubbles.filter((_, i) => i !== index)
    const neighbour = next[Math.min(index, next.length - 1)]
    focusAfter.current = neighbour ? `${idOf(neighbour)}-name` : dropToggleId
    setFeedback(`Removed ${nameOf(bubbles[index], index)}.`)
    onBubblesChange(next)
  }
  const summary = [
    `${bubbles.length} ${bubbles.length === 1 ? 'bubble' : 'bubbles'}`,
    liveCount > 0 &&
      `${liveCount} live traffic and event ${liveCount === 1 ? 'source' : 'sources'}`,
    budget === 0 && 'not changing the ranking',
  ]
    .filter(Boolean)
    .join(' · ')
  const strengthStep = Math.round(BUBBLE_STRENGTH.step * 100)

  return (
    <section
      className={`bg-card space-y-5 rounded-xl border p-4 sm:p-5 ${influenceColorVars}`}
      aria-labelledby="meeting-influence"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id="meeting-influence" className="text-lg font-semibold">
          Places to meet near or avoid
        </h2>
        <span className="text-muted-foreground text-xs">{summary}</span>
      </div>
      <p className="text-muted-foreground text-sm">
        A “meet near” bubble moves the meeting spots inside it up the list; a
        “keep away” bubble moves them down. Walking distances stay the same.
      </p>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold">New bubbles</legend>
        <PolarityChoice
          name="meeting-bubble-polarity"
          legend="New bubbles should"
          value={draft.polarity}
          onChange={(polarity) => onDraftChange({ ...draft, polarity })}
        />
        <Slider
          id="meeting-bubble-radius"
          label="Size"
          value={draft.radius}
          min={BUBBLE_RADIUS.min}
          max={BUBBLE_RADIUS.max}
          step={BUBBLE_RADIUS.step}
          display={`${draft.radius} m`}
          valueText={`Reaches ${draft.radius} metres`}
          onChange={(radius) => onDraftChange({ ...draft, radius })}
        />
        <Button
          id={dropToggleId}
          variant={dropping ? 'default' : 'outline'}
          className="w-full"
          aria-pressed={dropping}
          aria-describedby="meeting-bubble-drop-help"
          onClick={() => {
            onDroppingChange(!dropping)
            setFeedback(
              dropping
                ? 'Map clicks move the selected starting point again.'
                : 'Map clicks now drop bubbles.',
            )
          }}
        >
          <MousePointerClick />
          Drop bubbles by clicking the map
        </Button>
        <p
          id="meeting-bubble-drop-help"
          className="text-muted-foreground text-xs leading-relaxed"
        >
          {dropping
            ? 'Each click on the map adds a bubble there. Starting points stay put until you turn this off.'
            : 'Or add one at a place below, without using the map.'}
        </p>
        <div>
          <div className="rounded-lg border p-3">
            <MeetingPlaceSearch
              id={placeSearchId}
              label="Add a bubble at a place"
              value={query}
              mode="place"
              bounds={network.bounds}
              localPlaces={places}
              placeholder="Address, landmark or intersection"
              invalid={Boolean(searchError)}
              describedBy={searchError ? `${placeSearchId}-error` : undefined}
              onValueChange={(value) => {
                setQuery(value)
                setSearchError('')
              }}
              onSelect={(place) => {
                const added = addBubble({
                  network,
                  bubbles,
                  coordinate: place.coordinate,
                  draft,
                  label: place.name,
                })
                if (!added.ok) {
                  setSearchError(added.message)
                  return
                }
                setQuery('')
                setSearchError('')
                setFeedback(added.message)
                onBubblesChange(added.bubbles)
              }}
            />
          </div>
          {searchError && (
            <p
              id={`${placeSearchId}-error`}
              role="alert"
              className="text-muted-foreground mt-1 px-2 text-xs"
            >
              {searchError}
            </p>
          )}
        </div>
      </fieldset>

      {bubbles.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Your bubbles</h3>
          <ul className="space-y-2">
            {bubbles.map((bubble, index) => {
              const id = idOf(bubble)
              const name = nameOf(bubble, index)
              const polarity: BubblePolarity =
                bubble.weight < 0 ? 'avoid' : 'attract'
              const sign = polarity === 'avoid' ? -1 : 1
              const strength = Math.round(Math.abs(bubble.weight) * 100)
              return (
                <li key={bubble.id} className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <PolarityMark polarity={polarity} />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={`${id}-name`}
                        className="text-muted-foreground block text-[0.625rem] font-medium tracking-wider uppercase"
                      >
                        Name
                      </label>
                      <input
                        id={`${id}-name`}
                        className="focus-visible:ring-ring w-full min-w-0 bg-transparent py-1 text-sm font-medium outline-none focus-visible:rounded-sm focus-visible:ring-2"
                        value={bubble.label}
                        maxLength={80}
                        placeholder={`Bubble ${index + 1}`}
                        onChange={(event) =>
                          update(bubble.id, { label: event.target.value })
                        }
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      aria-label={`Remove ${name}`}
                      onClick={() => remove(index)}
                    >
                      <X />
                    </Button>
                  </div>
                  <PolarityChoice
                    name={`${id}-polarity`}
                    legend={`${name} should`}
                    value={polarity}
                    onChange={(next) =>
                      update(bubble.id, {
                        weight:
                          (next === 'avoid' ? -1 : 1) * Math.abs(bubble.weight),
                      })
                    }
                  />
                  <Slider
                    id={`${id}-radius`}
                    label="Size"
                    value={bubble.radius}
                    min={BUBBLE_RADIUS.min}
                    max={BUBBLE_RADIUS.max}
                    step={BUBBLE_RADIUS.step}
                    display={`${bubble.radius} m`}
                    valueText={`${name} reaches ${bubble.radius} metres`}
                    onChange={(radius) => update(bubble.id, { radius })}
                  />
                  <Slider
                    id={`${id}-strength`}
                    label="Strength"
                    value={strength}
                    min={Math.round(BUBBLE_STRENGTH.min * 100)}
                    max={Math.round(BUBBLE_STRENGTH.max * 100)}
                    step={strengthStep}
                    display={
                      budget > 0
                        ? `${strength}% · up to ${Math.round((budget * strength) / 100)} m`
                        : `${strength}%`
                    }
                    valueText={`${strength} percent${budget > 0 ? `, worth up to ${Math.round((budget * strength) / 100)} metres per person` : ''}`}
                    onChange={(percent) =>
                      update(bubble.id, { weight: (sign * percent) / 100 })
                    }
                  />
                </li>
              )
            })}
          </ul>
          <Button
            variant="ghost"
            className="text-muted-foreground w-full"
            onClick={() => {
              focusAfter.current = dropToggleId
              setFeedback(
                `Removed all ${bubbles.length} ${bubbles.length === 1 ? 'bubble' : 'bubbles'}.`,
              )
              onBubblesChange([])
            }}
          >
            <Trash2 />
            Remove all bubbles
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <Slider
          id="meeting-influence-budget"
          label="How much bubbles and live layers count"
          value={budget}
          min={INFLUENCE_BUDGET.min}
          max={INFLUENCE_BUDGET.max}
          step={INFLUENCE_BUDGET.step}
          display={budget === 0 ? 'Off' : `${budget} m per person`}
          valueText={
            budget === 0 ? 'Off' : `${budget} metres of walking per person`
          }
          describedBy="meeting-influence-budget-help"
          onChange={onBudgetChange}
        />
        <p
          id="meeting-influence-budget-help"
          className="text-muted-foreground text-xs leading-relaxed"
        >
          {budget === 0
            ? 'Off. Bubbles and live layers stay on the map, but only walking distance decides the order.'
            : `A spot at the centre of a full-strength bubble counts as ${budget} m less walking for each person, or ${budget} m more inside a “keep away” bubble. Live traffic and events use the same scale. Set this to 0 to turn them all off.`}
        </p>
      </div>

      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-muted-foreground min-h-4 text-xs"
      >
        {feedback}
      </p>
    </section>
  )
}
