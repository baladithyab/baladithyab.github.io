import type { ReactNode } from 'react'
import { AlertTriangle, Info, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Member, Trip } from '@/lib/tripspace/model'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

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
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
          {description ? <p className="text-muted-foreground text-sm leading-relaxed">{description}</p> : null}
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
    <div role="group" aria-label={label} className="bg-muted inline-flex flex-wrap gap-1 rounded-md p-1">
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
              pressed ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Notice({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  const Icon = tone === 'error' ? AlertTriangle : Info
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border p-3 text-sm',
        tone === 'error' ? 'border-destructive/50 text-foreground' : 'bg-muted/40 text-muted-foreground',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'error' ? 'text-destructive' : '')} aria-hidden />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  )
}

export function Busy({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-muted-foreground inline-flex items-center gap-2 text-sm">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {children}
    </p>
  )
}

const TONES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5']

/** A member's colour dot and name. The colour only repeats the name; it never stands alone. */
export function Person({ trip, memberId, className }: { trip: Trip; memberId: string; className?: string }) {
  const index = trip.members.findIndex((m) => m.id === memberId)
  const member = trip.members[index]
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('size-2 shrink-0 rounded-full', TONES[index % TONES.length])} aria-hidden />
      {member?.name ?? 'Removed member'}
    </span>
  )
}

export function People({ trip, memberIds }: { trip: Trip; memberIds: string[] }) {
  if (memberIds.length === 0) return <span className="text-muted-foreground">nobody yet</span>
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {memberIds.map((m) => (
        <Person key={m} trip={trip} memberId={m} />
      ))}
    </span>
  )
}

export const RSVP_LABEL: Record<Member['rsvp'], string> = { invited: 'Not answered', in: 'In', maybe: 'Maybe', out: 'Out' }

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-muted-foreground block text-xs">{hint}</span> : null}
    </label>
  )
}

export const inputClass =
  'border-input bg-background focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 aria-[invalid=true]:border-destructive'
