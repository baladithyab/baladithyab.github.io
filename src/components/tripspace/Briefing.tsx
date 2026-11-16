import { useState } from 'react'
import { ArrowRight, Check, ClipboardCopy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/tripspace/dates'
import { nextAsks, type Ask, type Trip } from '@/lib/tripspace/model'

import { Avatar, Person } from './parts'
import type { PanelProps, Tab } from './types'

function closes(at: number): string {
  return formatDate(new Date(at).toISOString().slice(0, 10))
}

/** What an ask says, where it is answered, and the button that takes you there. */
export function askText(
  trip: Trip,
  ask: Ask,
): { text: string; short: string; tab: Tab; cta: string } {
  switch (ask.kind) {
    case 'rsvp':
      return {
        text: 'Say whether you are coming.',
        short: 'in or out',
        tab: 'people',
        cta: 'Answer',
      }
    case 'dates':
      return {
        text: 'Mark the dates that work for you.',
        short: 'dates',
        tab: 'people',
        cta: 'Add your dates',
      }
    case 'home':
      return {
        text: 'Say where you would travel from.',
        short: 'airport',
        tab: 'people',
        cta: 'Add your airport',
      }
    case 'vote': {
      const poll = trip.polls.find((p) => p.id === ask.pollId)
      return {
        text: `Vote: ${poll?.question ?? 'an open question'} Closes ${closes(ask.closesAt)}.`,
        short: 'vote',
        tab: 'decide',
        cta: 'Vote',
      }
    }
    case 'choose': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      const watch = trip.watches.find((w) => w.id === item?.watchId)
      const found = watch?.offers.length ?? 0
      return {
        text: `Pick one: ${item?.title ?? 'a slot'}. ${found} ${found === 1 ? 'option' : 'options'} found.`,
        short: item?.detail.kind === 'stay' ? 'stay' : 'flight',
        tab: 'plan',
        cta: 'See the options',
      }
    }
    case 'book': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      const by = ask.bookBy ? ` by ${formatDate(ask.bookBy)}` : ''
      return {
        text: `Book ${item?.title ?? 'a reservation'}${by}.`,
        short: 'booking',
        tab: item?.detail.kind === 'activity' ? 'ideas' : 'plan',
        cta: 'Open it',
      }
    }
    default: {
      const exhaustive: never = ask
      return exhaustive
    }
  }
}

/** The one thing the trip needs from the person viewing it, and what comes after. */
export function NextStep({
  trip,
  me,
  go,
  size,
}: Pick<PanelProps, 'trip' | 'me' | 'go'> & { size: 'hero' | 'rail' }) {
  const [first, ...rest] = nextAsks(trip, me.id)
  const shown = rest.slice(0, 3)
  const hero = size === 'hero'
  return (
    <section
      aria-label="Your next step"
      className={cn('bg-card rounded-lg border', hero ? 'p-6 sm:p-8' : 'p-5')}
    >
      <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
        Your next step
      </p>
      {first ? (
        <div className={cn('space-y-4', hero ? 'mt-3' : 'mt-2')}>
          <p
            className={cn(
              'leading-snug font-semibold tracking-tight',
              hero ? 'text-2xl sm:text-3xl' : 'text-lg',
            )}
          >
            {askText(trip, first).text}
          </p>
          <Button
            size={hero ? 'default' : 'sm'}
            onClick={() => go(askText(trip, first).tab)}
          >
            {askText(trip, first).cta} <ArrowRight aria-hidden />
          </Button>
          {shown.length > 0 ? (
            <div className="space-y-1.5 border-t pt-3">
              <p className="text-muted-foreground text-xs">Then</p>
              <ul className="space-y-1 text-sm">
                {shown.map((ask, index) => (
                  <li key={`${ask.kind}-${index}`}>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-block rounded-sm py-0.5 text-left underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                      onClick={() => go(askText(trip, ask).tab)}
                    >
                      {askText(trip, ask).text}
                    </button>
                  </li>
                ))}
              </ul>
              {rest.length > shown.length ? (
                <p className="text-muted-foreground text-xs">
                  and {rest.length - shown.length} more
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p
          className={cn(
            'leading-snug font-semibold tracking-tight',
            hero ? 'mt-3 text-2xl sm:text-3xl' : 'mt-2 text-lg',
          )}
        >
          Nothing is needed from you right now.
        </p>
      )}
    </section>
  )
}

/** Who else the trip is waiting on, with a message to paste into the group chat. */
export function WaitingOn({
  trip,
  me,
  actAs,
}: Pick<PanelProps, 'trip' | 'me' | 'actAs'>) {
  const [copied, setCopied] = useState(false)
  const waiting = trip.members
    .filter((m) => m.id !== me.id)
    .map((m) => ({
      member: m,
      shorts: [
        ...new Set(nextAsks(trip, m.id).map((a) => askText(trip, a).short)),
      ],
    }))
    .filter((w) => w.shorts.length > 0)
  const nudge = [
    `${trip.title}: still waiting on ${waiting.map((w) => `${w.member.name} (${w.shorts.join(', ')})`).join(', ')}.`,
    ...trip.polls
      .filter((p) => p.status === 'open')
      .map((p) => `The vote "${p.question}" closes ${closes(p.closesAt)}.`),
  ].join(' ')

  return (
    <section aria-labelledby="waiting-on" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="waiting-on" className="text-base font-semibold">
          Waiting on
        </h2>
        {waiting.length > 0 ? (
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
            {copied ? 'Copied' : 'Copy a nudge'}
          </Button>
        ) : null}
      </div>
      {waiting.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nobody else has anything open.
        </p>
      ) : (
        <ul className="bg-card divide-y rounded-lg border">
          {waiting.map(({ member, shorts }) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => actAs(member.id)}
                className="hover:bg-accent/60 focus-visible:ring-ring flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
              >
                <Avatar trip={trip} memberId={member.id} className="size-7" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{member.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {shorts.join(', ')}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">Answer as</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">
        The nudge names who the trip is waiting on and for what, ready for your
        group chat.
      </p>
    </section>
  )
}

/** Settled questions. A change adds a line that replaces the old one. */
export function DecisionLog({ trip }: { trip: Trip }) {
  const replaced = new Set(
    trip.decisions
      .map((d) => d.replacesId)
      .filter((d): d is string => d !== null),
  )
  return (
    <section aria-labelledby="decided" className="space-y-3">
      <h2 id="decided" className="text-base font-semibold">
        Decided
      </h2>
      {trip.decisions.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing decided yet.</p>
      ) : (
        <ol className="space-y-2">
          {[...trip.decisions].reverse().map((d) => (
            <li
              key={d.id}
              className="bg-card rounded-lg border px-3 py-2.5 text-sm"
            >
              <p
                className={
                  replaced.has(d.id) ? 'text-muted-foreground line-through' : ''
                }
              >
                {d.summary}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {formatDate(new Date(d.at).toISOString().slice(0, 10), true)},{' '}
                <Person trip={trip} memberId={d.by} />
                {replaced.has(d.id) ? ', replaced' : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
