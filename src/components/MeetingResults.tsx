import { memo } from 'react'
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
  const result = output.results[selected]
  if (!result) return null
  const people = objective === 'fair' ? 1 : output.trees.length
  const note = (node: number) =>
    bias
      ? influenceNote(bias.budget * bias.values[node] * people, objective)
      : ''
  const influenced =
    bias !== undefined &&
    bias.budget > 0 &&
    bias.values.some((value) => value !== 0)
  const selectedNote = note(result.node)
  return (
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
          {objective === 'fair'
            ? 'longest journey, then total distance'
            : 'total distance, then longest journey'}
          {influenced && ', with influence zones adjusting the order'}
        </p>
      </div>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,1fr)]">
        <ol className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          {output.results.map((place, i) => (
            <li key={place.node}>
              <button
                className={`focus-visible:outline-ring flex h-full w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${selected === i ? 'border-foreground/60 bg-muted' : 'bg-card hover:bg-muted/50'}`}
                aria-pressed={selected === i}
                onClick={() => onSelect(i)}
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
                  {note(place.node) && (
                    <span className="mt-1 block text-xs">
                      {note(place.node)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="bg-card min-w-0 space-y-4 rounded-xl border p-5">
          <p className="text-muted-foreground text-xs">
            SELECTED MEETING POINT · {selected + 1} / {output.results.length}
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
          {selectedNote && <p className="text-sm">{selectedNote}.</p>}
          <ul className="space-y-3">
            {origins.map((origin, i) => (
              <li key={origin.id} className="flex items-center gap-3 text-sm">
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                  style={{ borderColor: originColor(i) }}
                >
                  {letter(i)}
                </span>
                <span className="min-w-0 flex-1 truncate" title={origin.name}>
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
  )
})
