import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'
import {
  addDays,
  daysBetween,
  eachDay,
  formatDate,
  formatDay,
  formatRange,
} from '@/lib/tripspace/dates'
import {
  availabilityByDay,
  costByMember,
  going,
  type Observation,
  type Trip,
  type TripOption,
} from '@/lib/tripspace/model'

import { Avatar, money, Person, RSVP_LABEL, toneOf } from './parts'

const BANDS = { 1: '$', 2: '$$', 3: '$$$' } as const

/** Step-area price history chart with optional Paid and Target dashed reference lines. */
export function PriceHistoryChart({
  series,
  label,
  unit,
  paidRefMinor = null,
  targetMinor = null,
  positive = false,
}: {
  series: Observation[]
  label: string
  unit: 'total' | 'nightly'
  /** Paid price in the same unit as `series` (total for flights, nightly for hotels). */
  paidRefMinor?: number | null
  targetMinor?: number | null
  positive?: boolean
}) {
  const priced = series.filter(
    (o): o is Observation & { priceMinor: number } => o.priceMinor !== null,
  )
  if (priced.length === 0) {
    return (
      <div className="bg-muted/30 text-muted-foreground flex h-24 items-center justify-center rounded-md border border-dashed text-xs">
        No price history recorded yet. Press Check now to start tracking.
      </div>
    )
  }

  const width = 560
  const height = 120
  const padX = 10
  const padY = 14
  const prices = priced.map((o) => o.priceMinor)
  const obsLo = Math.min(...prices)
  const obsHi = Math.max(...prices)
  const refs = [paidRefMinor, targetMinor].filter(
    (v): v is number => v !== null && v > 0,
  )
  const rawLo = Math.min(obsLo, ...refs)
  const rawHi = Math.max(obsHi, ...refs)
  const span = Math.max(rawHi - rawLo, Math.round(rawHi * 0.08), 100)
  const domainLo = Math.max(0, rawLo - span * 0.14)
  const domainHi = rawHi + span * 0.14

  const t0 = series[0]?.firstSeen ?? 0
  const t1 = Math.max(series.at(-1)?.lastSeen ?? t0, t0 + 1)
  const x = (t: number) =>
    t1 === t0 ? width / 2 : padX + ((t - t0) / (t1 - t0)) * (width - padX * 2)
  const y = (p: number) =>
    height -
    padY -
    ((p - domainLo) / (domainHi - domainLo)) * (height - padY * 2)

  // Step path connecting observed runs.
  const lineParts: string[] = []
  const areaParts: string[] = []
  const baselineY = height - padY
  priced.forEach((o, idx) => {
    const x0 = x(o.firstSeen)
    const x1 = Math.max(
      x(o.lastSeen),
      x0 + (priced.length === 1 ? width - padX * 2 : 6),
    )
    const clampedX1 = Math.min(width - padX, x1)
    const py = y(o.priceMinor)
    if (idx === 0) {
      lineParts.push(
        `M${x0.toFixed(1)},${py.toFixed(1)}H${clampedX1.toFixed(1)}`,
      )
      areaParts.push(
        `M${x0.toFixed(1)},${baselineY.toFixed(1)}V${py.toFixed(1)}H${clampedX1.toFixed(1)}`,
      )
    } else {
      lineParts.push(
        `L${x0.toFixed(1)},${py.toFixed(1)}H${clampedX1.toFixed(1)}`,
      )
      areaParts.push(
        `L${x0.toFixed(1)},${py.toFixed(1)}H${clampedX1.toFixed(1)}`,
      )
    }
    if (idx === priced.length - 1) {
      areaParts.push(`V${baselineY.toFixed(1)}Z`)
    }
  })

  const stroke = positive ? 'hsl(var(--chart-2))' : 'hsl(var(--chart-1))'
  const fill = positive
    ? 'hsl(var(--chart-2) / 0.16)'
    : 'hsl(var(--chart-1) / 0.14)'
  const last = priced.at(-1)!
  const lastX = Math.min(
    width - padX,
    Math.max(x(last.lastSeen), x(last.firstSeen) + 6),
  )
  const lastY = y(last.priceMinor)
  const suffix = unit === 'nightly' ? '/night' : ''
  const startLabel = formatDate(new Date(t0).toISOString().slice(0, 10))
  const endLabel = formatDate(new Date(t1).toISOString().slice(0, 10))
  const summary = [
    `${label}: low ${money(obsLo)}${suffix}, high ${money(obsHi)}${suffix}, latest ${money(last.priceMinor)}${suffix}`,
    paidRefMinor !== null ? `paid ${money(paidRefMinor)}${suffix}` : null,
    targetMinor !== null ? `target ${money(targetMinor)}${suffix}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
        <span>
          Range {money(obsLo)}
          {suffix} to {money(obsHi)}
          {suffix}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          {paidRefMinor !== null ? (
            <span className="text-foreground inline-flex items-center gap-1.5">
              <span
                className="border-foreground/60 inline-block w-3 border-t border-dashed"
                aria-hidden
              />
              Paid {money(paidRefMinor)}
              {suffix}
            </span>
          ) : null}
          {targetMinor !== null ? (
            <span className="text-foreground inline-flex items-center gap-1.5">
              <span
                className="border-chart-2 inline-block w-3 border-t border-dashed"
                aria-hidden
              />
              Target {money(targetMinor)}
              {suffix}
            </span>
          ) : null}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="bg-muted/20 aspect-[14/3] w-full rounded-md border"
        role="img"
        aria-label={summary}
      >
        <line
          x1={padX}
          x2={width - padX}
          y1={y(obsHi)}
          y2={y(obsHi)}
          stroke="hsl(var(--border))"
          strokeWidth="1"
        />
        <line
          x1={padX}
          x2={width - padX}
          y1={baselineY}
          y2={baselineY}
          stroke="hsl(var(--border))"
          strokeWidth="1"
        />
        {paidRefMinor !== null ? (
          <line
            x1={padX}
            x2={width - padX}
            y1={y(paidRefMinor)}
            y2={y(paidRefMinor)}
            stroke="hsl(var(--foreground) / 0.55)"
            strokeWidth="1.25"
            strokeDasharray="4 3"
          />
        ) : null}
        {targetMinor !== null ? (
          <line
            x1={padX}
            x2={width - padX}
            y1={y(targetMinor)}
            y2={y(targetMinor)}
            stroke="hsl(var(--chart-2))"
            strokeWidth="1.25"
            strokeDasharray="2 3"
          />
        ) : null}
        <path d={areaParts.join(' ')} fill={fill} />
        <path
          d={lineParts.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {priced.map((o) => (
          <circle
            key={o.firstSeen}
            cx={x(o.firstSeen)}
            cy={y(o.priceMinor)}
            r="2.25"
            fill={stroke}
          />
        ))}
        <circle
          cx={lastX}
          cy={lastY}
          r="3.75"
          fill="hsl(var(--card))"
          stroke={stroke}
          strokeWidth="2"
        />
      </svg>

      <div className="text-muted-foreground flex items-center justify-between text-[0.7rem] tabular-nums">
        <span>{startLabel}</span>
        <span>
          {priced.length} {priced.length === 1 ? 'check' : 'price points'}
        </span>
        <span>{endLabel}</span>
      </div>
    </div>
  )
}

/** Compact step-area sparkline for Dashboard price rows. */
export function Sparkline({
  series,
  label,
  positive = false,
  className,
}: {
  series: Observation[]
  label: string
  positive?: boolean
  className?: string
}) {
  const priced = series.filter(
    (o): o is Observation & { priceMinor: number } => o.priceMinor !== null,
  )
  if (priced.length === 0) return null
  const width = 104
  const height = 28
  const pad = 3
  const prices = priced.map((o) => o.priceMinor)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const t0 = series[0]?.firstSeen ?? 0
  const t1 = Math.max(series.at(-1)?.lastSeen ?? t0, t0 + 1)
  const x = (t: number) =>
    t1 === t0 ? width / 2 : pad + ((t - t0) / (t1 - t0)) * (width - pad * 2)
  const y = (p: number) =>
    hi === lo
      ? height / 2
      : height - pad - ((p - lo) / (hi - lo)) * (height - pad * 2)
  const pts = priced
    .map((o) => `${x(o.firstSeen).toFixed(1)},${y(o.priceMinor).toFixed(1)}`)
    .concat(
      `${Math.min(width - pad, Math.max(x(priced.at(-1)!.lastSeen), x(priced.at(-1)!.firstSeen) + 4)).toFixed(1)},${y(priced.at(-1)!.priceMinor).toFixed(1)}`,
    )
    .join(' ')
  const stroke = positive ? 'hsl(var(--chart-2))' : 'hsl(var(--chart-1))'
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-7 w-24 shrink-0', className)}
      role="img"
      aria-label={`${label}: ${money(lo)} to ${money(hi)}, latest ${money(priced.at(-1)!.priceMinor)}`}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Ranked per-person cost bars for a chosen trip option. */
export function CostBars({ trip, option }: { trip: Trip; option: TripOption }) {
  const members = going(trip)
  const costs = costByMember(trip, option)
  const rows = members
    .map((m) => ({ member: m, total: costs.get(m.id) ?? 0 }))
    .sort((a, b) => b.total - a.total)
  const max = Math.max(...rows.map((r) => r.total), 1)
  const groupTotal = rows.reduce((sum, r) => sum + r.total, 0)

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No confirmed travellers yet.
      </p>
    )
  }

  return (
    <div className="bg-card space-y-4 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2 border-b pb-3">
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Group total
        </span>
        <span className="text-xl font-semibold tabular-nums">
          {money(groupTotal)}
        </span>
      </div>
      <ul className="space-y-3">
        {rows.map(({ member, total }) => {
          const tone = toneOf(trip, member.id)
          const pct = Math.round((total / max) * 100)
          return (
            <li key={member.id} className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Person
                    trip={trip}
                    memberId={member.id}
                    className="truncate font-medium"
                  />
                  {member.budgetBand ? (
                    <span className="text-muted-foreground text-xs">
                      {BANDS[member.budgetBand]}
                    </span>
                  ) : null}
                </span>
                <span className="font-medium tabular-nums">
                  {total > 0 ? money(total) : 'Unpriced'}
                </span>
              </div>
              <div
                className="bg-muted h-2 overflow-hidden rounded-full"
                aria-hidden
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-[width]',
                    tone.dot,
                  )}
                  style={{ width: `${total > 0 ? Math.max(pct, 4) : 0}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Person-by-day availability matrix showing exactly who overlaps on which dates. */
export function AvailabilityMatrix({
  trip,
  highlightWindow = null,
}: {
  trip: Trip
  highlightWindow?: { start: string; end: string } | null
}) {
  const active = trip.members.filter((m) => m.rsvp !== 'out')
  const answering = active.filter((m) => m.dates.length > 0)
  if (answering.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nobody has marked dates yet. Add yours to see the overlap.
      </p>
    )
  }
  const starts = answering.flatMap((m) => m.dates.map((r) => r.start)).sort()
  const ends = answering.flatMap((m) => m.dates.map((r) => r.end)).sort()
  const start = starts[0]
  const rawEnd = ends.at(-1)
  if (!start || !rawEnd) return null
  const end = daysBetween(start, rawEnd) > 35 ? addDays(start, 35) : rawEnd
  const days = eachDay(start, end)
  const byDay = availabilityByDay(trip, start, end)
  const columns: CSSProperties = {
    gridTemplateColumns: `minmax(7.5rem, 9.5rem) repeat(${days.length}, minmax(2.25rem, 1fr))`,
  }
  const inWindow = (date: string) =>
    highlightWindow !== null &&
    date >= highlightWindow.start &&
    date <= highlightWindow.end

  return (
    <div
      tabIndex={0}
      role="region"
      aria-label={`Date overlap across ${active.length} people, ${formatRange(start, end)}`}
      className="bg-card focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="relative min-w-max">
        <div className="grid border-b" style={columns}>
          <div className="bg-card sticky left-0 z-10 px-3 py-2">
            <span className="text-muted-foreground text-xs font-medium">
              Person
            </span>
          </div>
          {days.map((date) => {
            const selected = inWindow(date)
            const [weekday] = formatDay(date).split(' ')
            return (
              <div
                key={date}
                className={cn(
                  'px-1 py-2 text-center text-[0.7rem] leading-tight',
                  selected
                    ? 'bg-primary text-primary-foreground font-semibold'
                    : 'text-muted-foreground',
                )}
              >
                <span className="block">{weekday}</span>
                <span
                  className={cn(
                    'block tabular-nums',
                    selected ? '' : 'text-foreground font-medium',
                  )}
                >
                  {date.slice(8)}
                </span>
              </div>
            )
          })}
        </div>

        {active.map((member) => {
          const tone = toneOf(trip, member.id)
          const hasDates = member.dates.length > 0
          return (
            <div
              key={member.id}
              className="grid items-center border-b last:border-0"
              style={columns}
            >
              <div className="bg-card sticky left-0 z-10 flex items-center gap-2 px-3 py-2">
                <Avatar
                  trip={trip}
                  memberId={member.id}
                  className="size-6 text-[0.65rem]"
                />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{member.name}</p>
                  <p className="text-muted-foreground text-[0.65rem]">
                    {RSVP_LABEL[member.rsvp]}
                  </p>
                </div>
              </div>
              {days.map((date) => {
                const free = member.dates.some(
                  (r) => r.start <= date && r.end >= date,
                )
                return (
                  <div
                    key={date}
                    className={cn(
                      'relative flex h-9 items-center justify-center px-0.5',
                      inWindow(date) && 'bg-accent/30',
                    )}
                    title={`${member.name}, ${formatDay(date)}: ${free ? 'available' : hasDates ? 'not available' : 'no dates given'}`}
                  >
                    {free ? (
                      <span
                        className={cn('h-5 w-full rounded-sm', tone.bar)}
                        aria-hidden
                      />
                    ) : !hasDates ? (
                      <span
                        className="border-muted-foreground/30 h-2 w-full border-t border-dashed"
                        aria-hidden
                      />
                    ) : (
                      <span
                        className="bg-muted h-1.5 w-1.5 rounded-full"
                        aria-hidden
                      />
                    )}
                    <span className="sr-only">
                      {member.name} {formatDay(date)}:{' '}
                      {free ? 'free' : hasDates ? 'busy' : 'unanswered'}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}

        <div className="bg-muted/40 grid items-center border-t" style={columns}>
          <div className="bg-muted/90 sticky left-0 z-10 px-3 py-2">
            <span className="text-foreground/80 text-xs font-medium">
              Can make it
            </span>
          </div>
          {byDay.map((d) => {
            const all = d.memberIds.length === answering.length
            return (
              <div
                key={d.date}
                className={cn(
                  'py-2 text-center text-xs tabular-nums',
                  all ? 'text-foreground font-semibold' : 'text-foreground/70',
                )}
              >
                {d.memberIds.length}/{answering.length}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
