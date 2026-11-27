import { memo, useMemo } from 'react'
import { ArrowDownUp, Check, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { originColor, type Origin } from '@/components/MeetingMap'
import type { InfluenceBias } from '@/lib/meeting-influence'
import type {
  MeetingNetwork,
  Objective,
  SearchOutput,
} from '@/lib/meeting-point'

const km = (metres: number) => `${(metres / 1000).toFixed(1)} km`
const letter = (index: number) =>
  String.fromCharCode(65 + (index % 26)) +
  (index >= 26 ? String(Math.floor(index / 26)) : '')

// How far the field moved a spot in the ranking, in the objective's metres:
// positive counts it as closer, negative as farther. Empty when negligible.
function influenceNote(shift: number, objective: Objective) {
  const metres = Math.abs(shift)
  if (!Number.isFinite(shift) || Math.round(metres) === 0) return ''
  const amount = metres < 1000 ? `${Math.round(metres)} m` : km(metres)
  return objective === 'fair'
    ? `Ranked as if the longest walk were ${amount} ${shift > 0 ? 'shorter' : 'longer'}`
    : `Ranked as if everyone walked ${amount} ${shift > 0 ? 'less' : 'more'} in total`
}

export default memo(function MeetingResults({
  network,
  origins,
  output,
  selected,
  objective,
  onSelect,
  bias,
}: {
  network: MeetingNetwork
  origins: Origin[]
  output: SearchOutput
  selected: number
  objective: Objective
  onSelect: (index: number) => void
  /** The influence field and budget that ranked `output`, if any. */
  bias?: InfluenceBias
}) {
  // Candidates are named intersections, so only their nodes can move the order.
  const influenced = useMemo(
    () =>
      bias !== undefined &&
      bias.budget > 0 &&
      network.places.some((place) => bias.values[place.node] !== 0),
    [bias, network],
  )
  const result = output.results[selected]
  if (!result) return null
  const people = objective === 'fair' ? 1 : output.trees.length
  const note = (node: number) =>
    bias
      ? influenceNote(bias.budget * bias.values[node] * people, objective)
      : ''
  const selectedNote = note(result.node)
  return (
    <section aria-labelledby="meeting-results" className="space-y-4">
      <div className="space-y-1">
        <h2 id="meeting-results" className="text-base font-semibold">
          Ranked meeting spots
        </h2>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <ArrowDownUp className="size-3 shrink-0" />
          <span>
            Ranked by{' '}
            {objective === 'fair'
              ? 'longest journey, then total distance'
              : 'total distance, then longest journey'}
            {influenced && ', with influence zones'}
          </span>
        </p>
      </div>
      <div className="bg-muted/35 min-w-0 space-y-3 rounded-lg border p-3.5">
        <p className="text-muted-foreground text-[0.7rem] font-medium tracking-wider uppercase">
          Selected · {selected + 1} / {output.results.length}
        </p>
        <h3 className="text-base font-semibold leading-snug">{result.name}</h3>
        <div className="grid grid-cols-2 gap-3 border-y py-2.5">
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {km(result.longest)}
            </p>
            <p className="text-muted-foreground text-xs">Longest journey</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {km(result.total)}
            </p>
            <p className="text-muted-foreground text-xs">Combined distance</p>
          </div>
        </div>
        {selectedNote && <p className="text-xs">{selectedNote}.</p>}
        <ul className="space-y-2">
          {origins.map((origin, i) => (
            <li key={origin.id} className="flex items-center gap-2.5 text-xs">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full border text-[0.7rem] font-semibold"
                style={{ borderColor: originColor(i) }}
              >
                {letter(i)}
              </span>
              <span className="min-w-0 flex-1 truncate" title={origin.name}>
                {origin.name}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {km(result.distances[i])}
              </span>
            </li>
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-9 w-full whitespace-normal text-xs"
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
        <p className="text-muted-foreground text-[0.7rem] leading-relaxed">
          A road intersection, not a venue recommendation. Check the destination
          and walking route before setting out.
        </p>
      </div>
      <ol className="space-y-2">
        {output.results.map((place, i) => {
          const placeNote = note(place.node)
          return (
            <li key={place.node}>
              <button
                className={`focus-visible:outline-ring flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${selected === i ? 'border-foreground/60 bg-muted' : 'bg-background hover:bg-muted/50'}`}
                aria-pressed={selected === i}
                onClick={() => onSelect(i)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
                  {selected === i ? <Check className="size-3" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium leading-snug">
                    {place.name}
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {km(place.longest)} longest · {km(place.total)} total
                  </span>
                  {placeNote && (
                    <span className="mt-1 block text-xs">{placeNote}</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
})
