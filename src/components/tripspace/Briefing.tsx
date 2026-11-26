import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardCopy,
  Plus,
  Target,
  TrendingDown,
  Users,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  addDecision,
  fitStayToArrivals,
  setReservation,
} from '@/lib/tripspace/actions'
import { formatDate, formatDay } from '@/lib/tripspace/dates'
import {
  nextAsks,
  type Ask,
  type Issue,
  type Trip,
  type TripSignal,
} from '@/lib/tripspace/model'

import { Avatar, buildNudge, inputClass, money, Person } from './parts'
import type { PanelProps, Tab } from './types'

const newId = () => crypto.randomUUID()

/** What a personal ask says, which workspace answers it, and its button label. */
export function askText(
  trip: Trip,
  ask: Ask,
): { text: string; short: string; tab: Tab; cta: string } {
  switch (ask.kind) {
    case 'rsvp':
      return {
        text: 'Say whether you are coming.',
        short: 'in or out',
        tab: 'coordinator',
        cta: 'Answer',
      }
    case 'dates':
      return {
        text: 'Mark the dates that work for you.',
        short: 'dates',
        tab: 'coordinator',
        cta: 'Add your dates',
      }
    case 'home':
      return {
        text: 'Say where you would travel from.',
        short: 'airport',
        tab: 'coordinator',
        cta: 'Add your airport',
      }
    case 'vote': {
      const poll = trip.polls.find((p) => p.id === ask.pollId)
      return {
        text: `Vote: ${poll?.question ?? 'an open question'} Closes ${formatDate(new Date(ask.closesAt).toISOString().slice(0, 10))}.`,
        short: 'vote',
        tab: 'coordinator',
        cta: 'Vote now',
      }
    }
    case 'choose': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      const watch = trip.watches.find((w) => w.id === item?.watchId)
      const found = watch?.offers.length ?? 0
      return {
        text: `Pick one: ${item?.title ?? 'a slot'}. ${found} ${found === 1 ? 'option' : 'options'} ready.`,
        short: item?.detail.kind === 'stay' ? 'stay' : 'flight',
        tab: 'planner',
        cta: 'See options',
      }
    }
    case 'book': {
      const item = trip.items.find((i) => i.id === ask.itemId)
      const by = ask.bookBy ? ` by ${formatDate(ask.bookBy)}` : ''
      return {
        text: `Book ${item?.title ?? 'a reservation'}${by}.`,
        short: 'booking',
        tab: 'planner',
        cta: 'Open planner',
      }
    }
    default: {
      const exhaustive: never = ask
      return exhaustive
    }
  }
}

export function issueLabel(trip: Trip, issue: Issue): string {
  const title = (itemId: string) =>
    trip.items.find((i) => i.id === itemId)?.title ?? 'an item'
  const who = (memberId: string) =>
    trip.members.find((m) => m.id === memberId)?.name ?? 'Someone'
  switch (issue.kind) {
    case 'not_there':
      return `${who(issue.memberId)} is on ${title(issue.itemId)} on a day they are not there.`
    case 'double_booked':
      return `${who(issue.memberId)} is on ${title(issue.itemIds[0])} and ${title(issue.itemIds[1])} at the same time.`
    case 'added_twice':
      return `The same booking was added twice: ${title(issue.itemIds[0])}.`
    case 'no_one_booking':
      return `${title(issue.itemId)} needs booking ahead and nobody has claimed it.`
    case 'unused_nights':
      return `${who(issue.memberId)} is on ${title(issue.itemId)} for ${issue.nights.length} unused ${issue.nights.length === 1 ? 'night' : 'nights'} (${issue.nights.map((n) => formatDay(n)).join(', ')}).`
    default: {
      const exhaustive: never = issue
      return exhaustive
    }
  }
}

export function signalCopy(
  trip: Trip,
  signal: TripSignal,
): { title: string; detail: string; tab: Tab; cta: string } {
  switch (signal.kind) {
    case 'ask': {
      const info = askText(trip, signal.ask)
      return {
        title: info.text,
        detail: 'Waiting on you',
        tab: info.tab,
        cta: info.cta,
      }
    }
    case 'price_drop':
      return {
        title: `${money(signal.savingsMinor)} price drop on ${signal.label}`,
        detail: `Paid ${money(signal.paidMinor)} with ${signal.soldBy}, now ${money(signal.nowTotalMinor)}.`,
        tab: 'prices',
        cta: 'Inspect drop',
      }
    case 'target_hit':
      return {
        title: `${signal.label} hit your ${money(signal.targetMinor)}${signal.unit === 'nightly' ? '/night' : ''} target`,
        detail: `Currently ${money(signal.currentMinor)}${signal.unit === 'nightly' ? '/night' : ''}.`,
        tab: 'prices',
        cta: 'Open watch',
      }
    case 'issue':
      return {
        title: issueLabel(trip, signal.issue),
        detail:
          signal.issue.kind === 'unused_nights'
            ? 'Fit the stay dates to when people actually land.'
            : signal.issue.kind === 'no_one_booking'
              ? 'Claim the booking so the deadline is not missed.'
              : 'Review this conflict in the planner.',
        tab: 'planner',
        cta: 'Review in planner',
      }
    case 'gaps':
      return {
        title: `${signal.count} travel ${signal.count === 1 ? 'slot' : 'slots'} still missing`,
        detail: 'Search flights and stays for everyone coming at once.',
        tab: 'planner',
        cta: 'Fill in travel',
      }
    case 'price_shortlist':
      return {
        title: `Price ${signal.unpricedCount} shortlist ${signal.unpricedCount === 1 ? 'option' : 'options'} for everyone`,
        detail: 'Compare real per-person flight and stay costs before locking.',
        tab: 'coordinator',
        cta: 'Price shortlist',
      }
    case 'lock_poll':
      return {
        title: `Vote leading: ${signal.leaderLabel}`,
        detail: `${signal.approvals} approve${signal.waitingCount > 0 ? `, ${signal.waitingCount} not voted yet` : ', everyone voted'}.`,
        tab: 'coordinator',
        cta: 'Review vote',
      }
    case 'waiting_group':
      return {
        title: `Waiting on ${signal.count} ${signal.count === 1 ? 'person' : 'people'} in the group`,
        detail: 'Copy a short nudge for your group chat.',
        tab: 'coordinator',
        cta: 'Open coordinator',
      }
    default: {
      const exhaustive: never = signal
      return exhaustive
    }
  }
}

export type DisplayIssue =
  | {
      kind: 'unused_stay'
      itemId: string
      memberIds: string[]
      nights: string[]
      label: string
    }
  | { kind: 'single'; issue: Issue; label: string }

/** Collapse duplicate per-member unused_nights issues on the same stay into one actionable row. */
export function groupIssues(trip: Trip, issues: Issue[]): DisplayIssue[] {
  const byStay = new Map<string, { memberIds: string[]; nights: Set<string> }>()
  const out: DisplayIssue[] = []
  for (const issue of issues) {
    if (issue.kind === 'unused_nights') {
      const entry = byStay.get(issue.itemId) ?? {
        memberIds: [],
        nights: new Set<string>(),
      }
      if (!entry.memberIds.includes(issue.memberId))
        entry.memberIds.push(issue.memberId)
      for (const n of issue.nights) entry.nights.add(n)
      byStay.set(issue.itemId, entry)
    } else {
      out.push({ kind: 'single', issue, label: issueLabel(trip, issue) })
    }
  }
  for (const [itemId, entry] of byStay) {
    const title = trip.items.find((i) => i.id === itemId)?.title ?? 'a stay'
    const names = entry.memberIds
      .map((id) => trip.members.find((m) => m.id === id)?.name ?? 'Someone')
      .join(', ')
    const sorted = [...entry.nights].sort()
    const nightWord = sorted.length === 1 ? 'unused night' : 'unused nights'
    out.unshift({
      kind: 'unused_stay',
      itemId,
      memberIds: entry.memberIds,
      nights: sorted,
      label: `${names} ${entry.memberIds.length === 1 ? 'has' : 'have'} ${sorted.length} ${nightWord} on ${title} (${sorted.map((n) => formatDay(n)).join(', ')}).`,
    })
  }
  return out
}

/** Prioritized action queue surfacing personal asks, price drops, conflicts and group nudges. */
export function AttentionFeed({
  trip,
  me,
  signals,
  update,
  go,
  runWatches,
}: Pick<PanelProps, 'trip' | 'me' | 'update' | 'go' | 'runWatches'> & {
  signals: TripSignal[]
}) {
  const [copied, setCopied] = useState(false)
  // Collapse multiple unused_nights signals for the same stay into one row.
  const deduped: {
    key: string
    signal: TripSignal
    overrideTitle?: string
    fitStayId?: string
  }[] = []
  const seenUnusedStay = new Set<string>()
  const unusedIssues = signals
    .filter(
      (s): s is Extract<TripSignal, { kind: 'issue' }> =>
        s.kind === 'issue' && s.issue.kind === 'unused_nights',
    )
    .map((s) => s.issue)
  const groupedUnused = new Map(
    groupIssues(trip, unusedIssues)
      .filter(
        (g): g is Extract<DisplayIssue, { kind: 'unused_stay' }> =>
          g.kind === 'unused_stay',
      )
      .map((g) => [g.itemId, g]),
  )
  signals.forEach((signal, index) => {
    if (signal.kind === 'issue' && signal.issue.kind === 'unused_nights') {
      if (seenUnusedStay.has(signal.issue.itemId)) return
      seenUnusedStay.add(signal.issue.itemId)
      const grouped = groupedUnused.get(signal.issue.itemId)
      deduped.push({
        key: `unused-${signal.issue.itemId}`,
        signal,
        overrideTitle: grouped?.label,
        fitStayId: signal.issue.itemId,
      })
      return
    }
    deduped.push({ key: `${signal.kind}-${index}`, signal })
  })
  const items = deduped.slice(0, 5)
  const nudge = buildNudge(trip, me.id)

  const fitStay = (itemId: string) => {
    const result = fitStayToArrivals(trip, itemId, newId)
    const fitted = result.trip.items.find((i) => i.id === itemId)
    if (!fitted) return
    const added = result.watch
    update((t) => ({
      ...t,
      items: t.items.map((i) => (i.id === itemId ? fitted : i)),
      watches:
        added && !t.watches.some((w) => w.id === added.id)
          ? [...t.watches, added]
          : t.watches,
    }))
    if (added && added.checkedAt === null) void runWatches([added])
  }
  if (items.length === 0) {
    return (
      <div className="bg-card flex flex-col justify-between gap-3 rounded-lg border p-5">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
            Needs attention
          </p>
          <p className="mt-2 text-lg font-semibold">All caught up.</p>
          <p className="text-muted-foreground mt-1 text-sm">
            No open tasks, conflicts or price alerts right now.
          </p>
        </div>
      </div>
    )
  }

  return (
    <section
      aria-labelledby="attention-heading"
      className="bg-card flex flex-col justify-between gap-4 rounded-lg border p-5"
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="attention-heading"
            className="text-muted-foreground text-xs font-medium tracking-widest uppercase"
          >
            Needs attention ({deduped.length})
          </h2>
          {signals.some((s) => s.kind === 'waiting_group') ? (
            <Button
              size="sm"
              variant="outline"
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
          ) : null}
        </div>
        <ul className="divide-y">
          {items.map(({ key, signal, overrideTitle, fitStayId }) => {
            const copy = signalCopy(trip, signal)
            const Icon =
              signal.kind === 'price_drop'
                ? TrendingDown
                : signal.kind === 'target_hit'
                  ? Target
                  : signal.kind === 'issue'
                    ? AlertTriangle
                    : signal.kind === 'waiting_group'
                      ? Users
                      : ArrowRight
            const claimId =
              signal.kind === 'issue' && signal.issue.kind === 'no_one_booking'
                ? signal.issue.itemId
                : null
            const claimItem = claimId
              ? trip.items.find((i) => i.id === claimId)
              : null
            return (
              <li
                key={key}
                className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <Icon
                    className={
                      signal.kind === 'price_drop' ||
                      signal.kind === 'target_hit'
                        ? 'text-chart-2 mt-0.5 size-4 shrink-0'
                        : signal.kind === 'issue'
                          ? 'text-chart-3 mt-0.5 size-4 shrink-0'
                          : 'text-muted-foreground mt-0.5 size-4 shrink-0'
                    }
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-sm leading-snug font-medium">
                      {overrideTitle ?? copy.title}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {copy.detail}
                    </p>
                  </div>
                </div>
                {fitStayId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => fitStay(fitStayId)}
                  >
                    Fit stay
                  </Button>
                ) : claimItem ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() =>
                      update((t) =>
                        setReservation(t, claimItem.id, {
                          bookBy: claimItem.bookBy,
                          leadMemberId: me.id,
                          quotedMinor: claimItem.quotedMinor,
                        }),
                      )
                    }
                  >
                    I will book it
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => go(copy.tab)}
                  >
                    {copy.cta}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      {deduped.length > items.length ? (
        <p className="text-muted-foreground border-t pt-2.5 text-xs">
          +{deduped.length - items.length} more items across planner and prices
        </p>
      ) : null}
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
  const nudge = buildNudge(trip, me.id)

  return (
    <section aria-labelledby="waiting-on" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="waiting-on" className="text-base font-semibold">
          Waiting on
        </h3>
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
            {copied ? 'Copied' : 'Copy nudge'}
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
                <span className="text-muted-foreground text-xs">Switch to</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Settled questions, with an inline control to record a new group decision. */
export function DecisionLog({
  trip,
  me,
  update,
}: Pick<PanelProps, 'trip' | 'me' | 'update'>) {
  const [adding, setAdding] = useState(false)
  const [summary, setSummary] = useState('')
  const replaced = new Set(
    trip.decisions
      .map((d) => d.replacesId)
      .filter((d): d is string => d !== null),
  )

  return (
    <section aria-labelledby="decided" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="decided" className="text-base font-semibold">
          Decision log
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
        >
          <Plus aria-hidden /> Log decision
        </Button>
      </div>
      {adding ? (
        <form
          className="bg-card flex flex-wrap gap-2 rounded-lg border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!summary.trim()) return
            update((t) =>
              addDecision(t, {
                summary: summary.trim(),
                by: me.id,
                now: Date.now(),
                newId,
              }),
            )
            setSummary('')
            setAdding(false)
          }}
        >
          <input
            aria-label="Decision summary"
            className={`${inputClass} min-w-0 flex-1`}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Stay in Chiado, cap flights at $1,000 each"
            maxLength={200}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!summary.trim()}>
            Record
          </Button>
        </form>
      ) : null}
      {trip.decisions.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing decided yet.</p>
      ) : (
        <ol className="space-y-2">
          {[...trip.decisions].reverse().map((d) => (
            <li
              key={d.id}
              className="bg-card rounded-lg border px-3.5 py-2.5 text-sm"
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
