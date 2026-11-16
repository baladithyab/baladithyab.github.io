import { useState } from 'react'
import { ArrowRight, Check, ClipboardCopy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { formatDate, formatRange } from '@/lib/tripspace/dates'
import { chosenOption, nextAsks, type Ask, type Trip } from '@/lib/tripspace/model'

import { Person, Section } from './parts'
import type { PanelProps, Tab } from './types'

function closes(at: number): string {
  return formatDate(new Date(at).toISOString().slice(0, 10))
}

function describe(trip: Trip, ask: Ask): { text: string; short: string; tab: Tab } {
  switch (ask.kind) {
    case 'rsvp':
      return { text: 'Say whether you are coming.', short: 'in or out', tab: 'people' }
    case 'dates':
      return { text: 'Mark the dates that work for you.', short: 'dates', tab: 'people' }
    case 'home':
      return { text: 'Say where you would travel from.', short: 'airport', tab: 'people' }
    case 'vote': {
      const poll = trip.polls.find((p) => p.id === ask.pollId)
      return { text: `Vote: ${poll?.question ?? 'an open question'} Closes ${closes(ask.closesAt)}.`, short: 'vote', tab: 'decide' }
    }
    case 'choose': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      const watch = trip.watches.find((w) => w.id === item?.watchId)
      return { text: `Pick one: ${item?.title ?? 'a slot'}. ${watch?.offers.length ?? 0} options found.`, short: item?.detail.kind === 'stay' ? 'stay' : 'flight', tab: 'plan' }
    }
    case 'book': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      const by = ask.bookBy ? ` by ${formatDate(ask.bookBy)}` : ''
      return { text: `Book ${item?.title ?? 'a reservation'}${by}.`, short: 'booking', tab: item?.detail.kind === 'activity' ? 'ideas' : 'plan' }
    }
    default: {
      const exhaustive: never = ask
      return exhaustive
    }
  }
}

export default function HomePanel({ trip, me, go }: PanelProps) {
  const [copied, setCopied] = useState(false)
  const mine = nextAsks(trip, me.id)
  const [first, ...rest] = mine
  const waiting = trip.members
    .filter((m) => m.id !== me.id)
    .map((m) => ({ member: m, asks: nextAsks(trip, m.id) }))
    .filter((w) => w.asks.length > 0)
  const option = chosenOption(trip)
  const counts = {
    in: trip.members.filter((m) => m.rsvp === 'in').length,
    maybe: trip.members.filter((m) => m.rsvp === 'maybe').length,
    unanswered: trip.members.filter((m) => m.rsvp === 'invited').length,
  }
  const replaced = new Set(trip.decisions.map((d) => d.replacesId).filter((d): d is string => d !== null))

  const nudge = [
    `${trip.title}: still waiting on ${waiting
      .map((w) => `${w.member.name} (${[...new Set(w.asks.map((a) => describe(trip, a).short))].join(', ')})`)
      .join(', ')}.`,
    ...trip.polls.filter((p) => p.status === 'open').map((p) => `The vote "${p.question}" closes ${closes(p.closesAt)}.`),
  ].join(' ')

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-10">
        <section aria-labelledby="next-step" className="bg-card rounded-lg border p-6 sm:p-8">
          <p id="next-step" className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
            Your next step
          </p>
          {first ? (
            <div className="mt-3 space-y-5">
              <p className="text-2xl leading-snug font-semibold tracking-tight sm:text-3xl">{describe(trip, first).text}</p>
              <Button onClick={() => go(describe(trip, first).tab)}>
                Go there <ArrowRight aria-hidden />
              </Button>
              {rest.length > 0 ? (
                <ul className="text-muted-foreground space-y-1 border-t pt-4 text-sm">
                  {rest.map((ask, index) => (
                    <li key={`${ask.kind}-${index}`}>
                      <button type="button" className="hover:text-foreground text-left underline-offset-4 hover:underline" onClick={() => go(describe(trip, ask).tab)}>
                        {describe(trip, ask).text}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-2xl leading-snug font-semibold tracking-tight sm:text-3xl">Nothing is needed from you right now.</p>
          )}
        </section>

        <Section
          title="Waiting on"
          description="Paste the nudge into your group chat. It names who the trip is waiting on and for what."
          action={
            waiting.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(nudge).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                {copied ? <Check aria-hidden /> : <ClipboardCopy aria-hidden />}
                {copied ? 'Copied' : 'Copy nudge'}
              </Button>
            ) : null
          }
        >
          {waiting.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nobody else has anything open.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {waiting.map(({ member, asks }) => (
                <li key={member.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-sm">
                  <Person trip={trip} memberId={member.id} className="font-medium" />
                  <span className="text-muted-foreground">{[...new Set(asks.map((a) => describe(trip, a).short))].join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="space-y-10">
        <Section title="Where things stand">
          <dl className="grid grid-cols-3 gap-3 text-center">
            {[
              { label: 'In', value: counts.in },
              { label: 'Maybe', value: counts.maybe },
              { label: 'Not answered', value: counts.unanswered },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border p-3">
                <dt className="text-muted-foreground text-xs">{c.label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{c.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {option ? (
              <>
                Going to <span className="font-medium">{option.label}</span>, {formatRange(option.depart, option.return)}.
              </>
            ) : trip.options.length > 0 ? (
              `${trip.options.filter((o) => o.status === 'candidate').length} options on the shortlist. No destination decided yet.`
            ) : (
              'No destination ideas yet.'
            )}
          </p>
        </Section>

        <Section title="Decided" description="Settled questions. A change adds a new line; nothing is edited away.">
          {trip.decisions.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing decided yet.</p>
          ) : (
            <ol className="space-y-3">
              {[...trip.decisions].reverse().map((d) => (
                <li key={d.id} className="rounded-lg border p-3 text-sm">
                  <p className={replaced.has(d.id) ? 'text-muted-foreground line-through' : ''}>{d.summary}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {formatDate(new Date(d.at).toISOString().slice(0, 10), true)}, <Person trip={trip} memberId={d.by} />
                    {replaced.has(d.id) ? ', replaced' : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </div>
  )
}
