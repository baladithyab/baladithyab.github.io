import type { ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Info,
  Loader2,
  Minus,
  Target,
  TrendingDown,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/tripspace/dates'
import {
  nextAsks,
  type Ask,
  type Member,
  type TravelStatus,
  type Trip,
  type WatchInsight,
} from '@/lib/tripspace/model'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/** `$1,820` from minor units. */
export function money(minor: number): string {
  return usd.format(Math.round(minor / 100))
}

export function Section({
  title,
  eyebrow,
  description,
  action,
  children,
  className,
}: {
  title: string
  eyebrow?: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          {eyebrow ? (
            <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {title}
          </h2>
          {description ? (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A row of toggle buttons for one choice. Each button says whether it is pressed. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T | null
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="bg-muted inline-flex flex-wrap gap-1 rounded-md p-1"
    >
      {options.map((option) => {
        const pressed = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'focus-visible:ring-ring min-h-8 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50',
              pressed
                ? 'bg-background text-foreground ring-border ring-1'
                : 'text-foreground/75 hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'error'
  children: ReactNode
}) {
  const Icon = tone === 'error' ? AlertTriangle : Info
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-md border p-3 text-sm',
        tone === 'error'
          ? 'border-destructive/50 bg-card text-foreground'
          : 'bg-muted/50 text-foreground/80',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'error' ? 'text-destructive' : 'text-foreground/70',
        )}
        aria-hidden
      />
      <div className="min-w-0 space-y-1.5">{children}</div>
    </div>
  )
}

export function Busy({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="text-muted-foreground inline-flex items-center gap-2 text-sm"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {children}
    </p>
  )
}

/** Each member's colour, by their position in the trip. Literal class names, so Tailwind keeps them. */
export const TONES = [
  {
    dot: 'bg-chart-1',
    soft: 'bg-chart-1/15',
    ring: 'ring-chart-1',
    bar: 'bg-chart-1/30',
    stroke: 'hsl(var(--chart-1))',
  },
  {
    dot: 'bg-chart-2',
    soft: 'bg-chart-2/15',
    ring: 'ring-chart-2',
    bar: 'bg-chart-2/30',
    stroke: 'hsl(var(--chart-2))',
  },
  {
    dot: 'bg-chart-3',
    soft: 'bg-chart-3/15',
    ring: 'ring-chart-3',
    bar: 'bg-chart-3/30',
    stroke: 'hsl(var(--chart-3))',
  },
  {
    dot: 'bg-chart-4',
    soft: 'bg-chart-4/15',
    ring: 'ring-chart-4',
    bar: 'bg-chart-4/30',
    stroke: 'hsl(var(--chart-4))',
  },
  {
    dot: 'bg-chart-5',
    soft: 'bg-chart-5/15',
    ring: 'ring-chart-5',
    bar: 'bg-chart-5/30',
    stroke: 'hsl(var(--chart-5))',
  },
] as const

export function toneOf(trip: Trip, memberId: string): (typeof TONES)[number] {
  const index = Math.max(
    0,
    trip.members.findIndex((m) => m.id === memberId),
  )
  return TONES[index % TONES.length] ?? TONES[0]
}

/** A member's colour dot and name. The colour only repeats the name; it never stands alone. */
export function Person({
  trip,
  memberId,
  className,
}: {
  trip: Trip
  memberId: string
  className?: string
}) {
  const member = trip.members.find((m) => m.id === memberId)
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          toneOf(trip, memberId).dot,
        )}
        aria-hidden
      />
      {member?.name ?? 'Removed member'}
    </span>
  )
}

/** Initials in the member's colour. Decorative: the name is always written next to it. */
export function Avatar({
  trip,
  memberId,
  className,
}: {
  trip: Trip
  memberId: string
  className?: string
}) {
  const member = trip.members.find((m) => m.id === memberId)
  const initials = (member?.name ?? '?')
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word) && word.toLowerCase() !== 'and')
    .map((word) => word[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('')
  const tone = toneOf(trip, memberId)
  return (
    <span
      aria-hidden
      className={cn(
        'text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1',
        tone.soft,
        tone.ring,
        className,
      )}
    >
      {initials || '?'}
    </span>
  )
}

export type StatusTone = 'done' | 'progress' | 'todo' | 'quiet'

/** A short status with an icon, so it reads without colour. */
export function Status({
  tone,
  children,
  className,
}: {
  tone: StatusTone
  children: ReactNode
  className?: string
}) {
  const Icon =
    tone === 'done'
      ? CircleCheck
      : tone === 'progress'
        ? CircleDot
        : tone === 'todo'
          ? CircleDashed
          : Minus
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        tone === 'quiet' || tone === 'todo'
          ? 'text-muted-foreground'
          : 'text-foreground',
        className,
      )}
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          tone === 'done' && 'text-chart-2',
          tone === 'progress' && 'text-chart-3',
        )}
        aria-hidden
      />
      {children}
    </span>
  )
}

/** Pill carrying a price watch signal via icon plus signed text, never colour alone. */
export function SignalBadge({ entry }: { entry: WatchInsight }) {
  switch (entry.signal) {
    case 'drop_alert':
      return (
        <span className="bg-primary text-primary-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums">
          <TrendingDown className="size-3.5 shrink-0" aria-hidden />
          Drop {money(entry.dropBelowPaidMinor)}
        </span>
      )
    case 'at_target':
      return (
        <span className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium">
          <Target className="text-chart-2 size-3.5 shrink-0" aria-hidden />
          At target
        </span>
      )
    case 'down':
      return (
        <span className="bg-card text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums">
          <ArrowDownRight
            className="text-chart-2 size-3.5 shrink-0"
            aria-hidden
          />
          Down {entry.deltaPct !== null ? `${Math.abs(entry.deltaPct)}%` : ''}
        </span>
      )
    case 'up':
      return (
        <span className="bg-card text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums">
          <ArrowUpRight
            className="text-chart-3 size-3.5 shrink-0"
            aria-hidden
          />
          Up {entry.deltaPct !== null ? `+${entry.deltaPct}%` : ''}
        </span>
      )
    case 'steady':
      return (
        <span className="bg-card text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs">
          <Minus className="size-3 shrink-0" aria-hidden />
          Steady
        </span>
      )
    case 'sold_out':
      return (
        <span className="bg-card text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium">
          <AlertTriangle
            className="text-destructive size-3.5 shrink-0"
            aria-hidden
          />
          Not found
        </span>
      )
    case 'unchecked':
      return (
        <span className="bg-card text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs">
          <CircleDashed className="size-3 shrink-0" aria-hidden />
          Not checked
        </span>
      )
    default: {
      const exhaustive: never = entry.signal
      return exhaustive
    }
  }
}

export const TRAVEL_STATUS: Record<
  TravelStatus,
  { label: string; tone: StatusTone }
> = {
  not_coming: { label: 'Not coming', tone: 'quiet' },
  no_destination: { label: 'After the vote', tone: 'quiet' },
  not_needed: { label: 'Not needed', tone: 'quiet' },
  none: { label: 'Not started', tone: 'todo' },
  searching: { label: 'Choosing', tone: 'progress' },
  partial: { label: 'Nights missing', tone: 'progress' },
  chosen: { label: 'Chosen', tone: 'progress' },
  booked: { label: 'Booked', tone: 'done' },
}

export function People({
  trip,
  memberIds,
}: {
  trip: Trip
  memberIds: string[]
}) {
  if (memberIds.length === 0)
    return <span className="text-muted-foreground">nobody yet</span>
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {memberIds.map((m) => (
        <Person key={m} trip={trip} memberId={m} />
      ))}
    </span>
  )
}

export const RSVP_LABEL: Record<Member['rsvp'], string> = {
  invited: 'Not answered',
  in: 'In',
  maybe: 'Maybe',
  out: 'Out',
}
export const RSVP_TONE: Record<Member['rsvp'], StatusTone> = {
  in: 'done',
  maybe: 'progress',
  invited: 'todo',
  out: 'quiet',
}

function askShort(trip: Trip, ask: Ask): string {
  switch (ask.kind) {
    case 'rsvp':
      return 'in or out'
    case 'dates':
      return 'dates'
    case 'home':
      return 'airport'
    case 'vote':
      return 'vote'
    case 'choose': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      return item?.detail.kind === 'stay' ? 'stay' : 'flight'
    }
    case 'book':
      return 'booking'
    default: {
      const exhaustive: never = ask
      return exhaustive
    }
  }
}

/** Ready-to-paste group chat nudge naming everyone with open steps. */
export function buildNudge(trip: Trip, excludeMemberId?: string): string {
  const waiting = trip.members
    .filter((m) => m.id !== excludeMemberId)
    .map((m) => ({
      name: m.name,
      shorts: [...new Set(nextAsks(trip, m.id).map((a) => askShort(trip, a)))],
    }))
    .filter((w) => w.shorts.length > 0)
  if (waiting.length === 0) return `${trip.title}: everyone is caught up.`
  return [
    `${trip.title}: still waiting on ${waiting.map((w) => `${w.name} (${w.shorts.join(', ')})`).join(', ')}.`,
    ...trip.polls
      .filter((p) => p.status === 'open')
      .map(
        (p) =>
          `The vote "${p.question}" closes ${formatDate(new Date(p.closesAt).toISOString().slice(0, 10))}.`,
      ),
  ].join(' ')
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="text-muted-foreground block text-xs">{hint}</span>
      ) : null}
    </label>
  )
}

export const inputClass =
  'border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 aria-[invalid=true]:border-destructive'
