import type { ReactNode } from 'react'
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Info,
  Loader2,
  Minus,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Member, TravelStatus, Trip } from '@/lib/tripspace/model'

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
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl space-y-1">
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
              'focus-visible:ring-ring rounded-sm px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50',
              pressed
                ? 'bg-background text-foreground shadow-sm'
                : 'text-foreground/70 hover:text-foreground',
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
        'flex items-start gap-2 rounded-md border p-3 text-sm',
        tone === 'error'
          ? 'border-destructive/50 text-foreground'
          : 'bg-muted/40 text-muted-foreground',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'error' ? 'text-destructive' : '',
        )}
        aria-hidden
      />
      <div className="min-w-0 space-y-1">{children}</div>
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
  },
  {
    dot: 'bg-chart-2',
    soft: 'bg-chart-2/15',
    ring: 'ring-chart-2',
    bar: 'bg-chart-2/30',
  },
  {
    dot: 'bg-chart-3',
    soft: 'bg-chart-3/15',
    ring: 'ring-chart-3',
    bar: 'bg-chart-3/30',
  },
  {
    dot: 'bg-chart-4',
    soft: 'bg-chart-4/15',
    ring: 'ring-chart-4',
    bar: 'bg-chart-4/30',
  },
  {
    dot: 'bg-chart-5',
    soft: 'bg-chart-5/15',
    ring: 'ring-chart-5',
    bar: 'bg-chart-5/30',
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
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1',
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
