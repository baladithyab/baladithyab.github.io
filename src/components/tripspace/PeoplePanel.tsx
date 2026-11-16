import { useState } from 'react'
import { Minus, Plus, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { isIsoDate, formatRange } from '@/lib/tripspace/dates'
import { addMember, removeMember, updateMember } from '@/lib/tripspace/actions'
import { cn } from '@/lib/utils'
import { heads, memberStatus, type Member } from '@/lib/tripspace/model'

import {
  Avatar,
  Field,
  inputClass,
  Notice,
  Person,
  RSVP_LABEL,
  RSVP_TONE,
  Section,
  Segmented,
  Status,
  TRAVEL_STATUS,
} from './parts'
import type { PanelProps } from './types'

const newId = () => crypto.randomUUID()
const BANDS = { 1: '$', 2: '$$', 3: '$$$' } as const

function homeText(member: Member): string {
  switch (member.home.kind) {
    case 'unanswered':
      return 'not answered'
    case 'local':
      return 'already there'
    case 'airports':
      return member.home.codes.join(', ')
    default: {
      const exhaustive: never = member.home
      return exhaustive
    }
  }
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Fewer ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          <Minus aria-hidden />
        </Button>
        <span className="w-6 text-center tabular-nums" aria-live="polite">
          {value}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`More ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          <Plus aria-hidden />
        </Button>
      </div>
    </div>
  )
}

function Answers({
  trip,
  me,
  update,
}: Pick<PanelProps, 'trip' | 'me' | 'update'>) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [codes, setCodes] = useState(
    me.home.kind === 'airports' ? me.home.codes.join(', ') : '',
  )
  const [codesError, setCodesError] = useState<string | null>(null)
  const patch = (change: Partial<Omit<Member, 'id' | 'role'>>) =>
    update((t) => updateMember(t, me.id, change))
  const rangeReady = isIsoDate(start) && isIsoDate(end) && end >= start

  const saveCodes = () => {
    const parsed = codes
      .split(/[\s,]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean)
    if (parsed.length === 0) {
      setCodesError(null)
      patch({ home: { kind: 'unanswered' } })
      return
    }
    if (parsed.length > 3 || parsed.some((c) => !/^[A-Z]{3}$/.test(c))) {
      setCodesError(
        'Use up to three three-letter airport codes, such as SFO, OAK.',
      )
      return
    }
    setCodesError(null)
    patch({ home: { kind: 'airports', codes: [...new Set(parsed)] } })
  }

  return (
    <div className="bg-card @container space-y-6 rounded-lg border p-5 sm:p-6">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">
          Your answers, as <Person trip={trip} memberId={me.id} />
        </h3>
        <p className="text-muted-foreground text-sm">
          Four questions. Everything else in the trip is built from them.
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">Are you in?</p>
        <Segmented
          label="Are you in?"
          options={[
            { value: 'in', label: 'In' },
            { value: 'maybe', label: 'Maybe' },
            { value: 'out', label: 'Out' },
          ]}
          value={me.rsvp === 'invited' ? null : me.rsvp}
          onChange={(rsvp) => patch({ rsvp })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Dates that work</p>
        {me.dates.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {me.dates.map((r, index) => (
              <li
                key={`${r.start}-${r.end}`}
                className="bg-muted inline-flex items-center gap-1 rounded-full py-1 pr-1 pl-3 text-sm"
              >
                {formatRange(r.start, r.end)}
                <button
                  type="button"
                  aria-label={`Remove ${formatRange(r.start, r.end)}`}
                  className="hover:bg-background focus-visible:ring-ring rounded-full p-1 focus-visible:ring-2 focus-visible:outline-none"
                  onClick={() =>
                    patch({ dates: me.dates.filter((_, i) => i !== index) })
                  }
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            None yet. Add every range you could do.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 @md:grid-cols-[1fr_1fr_auto] @md:items-end">
          <Field label="From">
            <input
              type="date"
              className={inputClass}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={inputClass}
              value={end}
              min={start || undefined}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            className="col-span-2 @md:col-span-1"
            disabled={!rangeReady}
            onClick={() => {
              patch({
                dates: [...me.dates, { start, end }].sort((a, b) =>
                  a.start.localeCompare(b.start),
                ),
              })
              setStart('')
              setEnd('')
            }}
          >
            Add these dates
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">Budget</p>
        <Segmented
          label="Budget"
          options={[
            { value: 1, label: '$ keep it cheap' },
            { value: 2, label: '$$ middle' },
            { value: 3, label: '$$$ treat ourselves' },
          ]}
          value={me.budgetBand}
          onChange={(budgetBand) => patch({ budgetBand })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Travelling from</p>
        <Segmented
          label="Travelling from"
          options={[
            { value: 'airports', label: 'I fly in' },
            { value: 'local', label: 'I am already there' },
          ]}
          value={me.home.kind === 'unanswered' ? null : me.home.kind}
          onChange={(kind) =>
            kind === 'local' ? patch({ home: { kind: 'local' } }) : saveCodes()
          }
        />
        {me.home.kind !== 'local' ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveCodes()
            }}
          >
            <Field label="Home airports" hint="Up to three, comma separated.">
              <input
                className={inputClass}
                value={codes}
                aria-invalid={codesError !== null}
                onChange={(e) => setCodes(e.target.value)}
                onBlur={saveCodes}
                placeholder="SFO, OAK"
                autoCapitalize="characters"
              />
            </Field>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
        ) : null}
        {codesError ? <Notice tone="error">{codesError}</Notice> : null}
      </div>

      <div className="flex flex-wrap gap-8">
        <Stepper
          label="Adults"
          value={me.party.adults}
          min={1}
          max={9}
          onChange={(adults) => patch({ party: { ...me.party, adults } })}
        />
        <Stepper
          label="Children"
          value={me.party.children}
          min={0}
          max={8}
          onChange={(children) => patch({ party: { ...me.party, children } })}
        />
      </div>
    </div>
  )
}

export default function PeoplePanel({ trip, me, update }: PanelProps) {
  const [name, setName] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const isOwner = me.role === 'owner'

  return (
    <div className="grid grid-cols-1 gap-10 @4xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] @4xl:items-start">
      <Answers key={me.id} trip={trip} me={me} update={update} />

      <Section
        title="Everyone"
        description="A member is a travelling party: one person, or a couple or family who move together."
      >
        <ul className="grid gap-3 @7xl:grid-cols-2">
          {trip.members.map((m) => {
            const status = memberStatus(trip, m.id)
            return (
              <li
                key={m.id}
                className={cn(
                  'bg-card @container space-y-3 rounded-lg border px-4 py-4 text-sm',
                  m.rsvp === 'out' && 'opacity-60',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2.5">
                    <Avatar trip={trip} memberId={m.id} className="size-8" />
                    <span className="text-base font-medium">{m.name}</span>
                  </span>
                  <Status tone={RSVP_TONE[m.rsvp]}>{RSVP_LABEL[m.rsvp]}</Status>
                </div>
                <dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 @lg:grid-cols-4">
                  <div>
                    <dt className="text-xs">Dates</dt>
                    <dd className="text-foreground">
                      {m.dates.length
                        ? m.dates
                            .map((r) => formatRange(r.start, r.end))
                            .join('; ')
                        : 'not answered'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs">From</dt>
                    <dd className="text-foreground">{homeText(m)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs">Party</dt>
                    <dd className="text-foreground">
                      {heads(m.party)}{' '}
                      {heads(m.party) === 1 ? 'person' : 'people'}
                      {m.budgetBand ? `, ${BANDS[m.budgetBand]}` : ''}
                    </dd>
                  </div>
                  <div className="col-span-2 @lg:col-span-1">
                    <dt className="text-xs">Travel</dt>
                    <dd className="text-foreground space-y-0.5">
                      <Status
                        tone={TRAVEL_STATUS[status.flight].tone}
                        className="flex"
                      >
                        Flight:{' '}
                        {TRAVEL_STATUS[status.flight].label.toLowerCase()}
                      </Status>
                      <Status
                        tone={TRAVEL_STATUS[status.stay].tone}
                        className="flex"
                      >
                        Stay: {TRAVEL_STATUS[status.stay].label.toLowerCase()}
                      </Status>
                    </dd>
                  </div>
                </dl>
                {isOwner && m.id !== me.id ? (
                  <div className="flex gap-2 pt-1">
                    {confirming === m.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => update((t) => removeMember(t, m.id))}
                        >
                          <Trash2 aria-hidden /> Remove {m.name} from the trip
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => setConfirming(m.id)}
                      >
                        <Trash2 aria-hidden /> Remove
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        {isOwner ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!name.trim()) return
              update((t) => addMember(t, { name: name.trim(), newId }))
              setName('')
            }}
          >
            <Field
              label="Add someone"
              hint="They answer for themselves when you pick them under Viewing as."
            >
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                maxLength={60}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={!name.trim()}>
              <Plus aria-hidden /> Add
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">
            Only the organizer adds or removes people.
          </p>
        )}
      </Section>
    </div>
  )
}
