import { useState } from 'react'
import {
  ArrowRight,
  CalendarRange,
  Check,
  ClipboardCopy,
  RefreshCw,
  TrendingDown,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { daysBetween, formatRange } from '@/lib/tripspace/dates'
import { ideasOf } from '@/lib/tripspace/actions'
import {
  arrivals,
  bestWindows,
  chosenOption,
  costByMember,
  findIssues,
  memberStatus,
  tally,
  tripSignals,
  watchReport,
  type Member,
  type MemberStatus,
} from '@/lib/tripspace/model'

import { AttentionFeed, DecisionLog, signalCopy, WaitingOn } from './Briefing'
import { AvailabilityMatrix, CostBars, Sparkline } from './Charts'
import Timeline from './Timeline'
import {
  Avatar,
  buildNudge,
  money,
  RSVP_LABEL,
  RSVP_TONE,
  SignalBadge,
  Status,
  TRAVEL_STATUS,
  type StatusTone,
} from './parts'
import type { PanelProps } from './types'

function homeLabel(member: Member): { label: string; tone: StatusTone } {
  switch (member.home.kind) {
    case 'unanswered':
      return { label: 'Not given', tone: 'todo' }
    case 'local':
      return { label: 'Local', tone: 'done' }
    case 'airports':
      return { label: member.home.codes.join(', '), tone: 'done' }
    default: {
      const exhaustive: never = member.home
      return exhaustive
    }
  }
}

const VOTE: Record<MemberStatus['vote'], { label: string; tone: StatusTone }> =
  {
    no_poll: { label: 'No vote', tone: 'quiet' },
    voted: { label: 'Voted', tone: 'done' },
    not_voted: { label: 'Not yet', tone: 'todo' },
  }

export default function DashboardPanel(props: PanelProps) {
  const { trip, me, update, go, actAs, runWatches, busyWatches } = props
  const [copied, setCopied] = useState(false)
  const option = chosenOption(trip)
  const poll = trip.polls.find((p) => p.status === 'open')
  const rows = trip.members.map((member) => ({
    member,
    status: memberStatus(trip, member.id),
  }))
  const active = rows.filter((r) => r.member.rsvp !== 'out')

  const steps = active.flatMap(({ member, status }) => [
    member.rsvp !== 'invited',
    member.dates.length > 0,
    member.home.kind !== 'unanswered',
    ...(poll ? [status.vote === 'voted'] : []),
    ...(option && member.rsvp === 'in'
      ? [
          status.flight === 'booked' || status.flight === 'not_needed',
          status.stay === 'booked',
        ]
      : []),
  ])
  const done = steps.filter(Boolean).length
  const percent =
    steps.length === 0 ? 0 : Math.round((done / steps.length) * 100)
  const count = (test: (r: (typeof rows)[number]) => boolean) =>
    `${active.filter(test).length}/${active.length}`

  const goingCount = trip.members.filter((m) => m.rsvp === 'in').length
  const maybeCount = trip.members.filter((m) => m.rsvp === 'maybe').length
  const invitedCount = trip.members.filter((m) => m.rsvp === 'invited').length

  const report = watchReport(trip)
  const signals = tripSignals(trip, me.id)
  const leadSignal = signals[0] ?? null
  const leadCopy = leadSignal ? signalCopy(trip, leadSignal) : null
  const costs = option ? costByMember(trip, option) : null
  const ideas = ideasOf(trip)
  const scheduledCount = ideas.filter((i) => i.startDate !== null).length
  const issueCount = option ? findIssues(trip, option).length : 0
  const landingCount = option ? arrivals(trip, option).length : 0
  const topWindow = bestWindows(trip, 7, 1)[0] ?? null
  const pollTally = poll ? tally(poll) : []
  const bookedPct =
    report.estimatedTotalMinor > 0
      ? Math.min(
          100,
          Math.round(
            (report.bookedTotalMinor / report.estimatedTotalMinor) * 100,
          ),
        )
      : 0
  const nudge = buildNudge(trip, me.id)
  const anyWatchBusy = report.entries.some((e) => busyWatches.has(e.watch.id))

  return (
    <div className="space-y-8">
      {/* Band 1: Asymmetric 7 / 5 Operational Lead + Needs Attention Queue */}
      <div className="grid grid-cols-1 gap-6 @5xl:grid-cols-12 @5xl:items-start">
        <section
          aria-labelledby="trip-readiness-heading"
          className="bg-card flex flex-col justify-between gap-6 rounded-lg border p-6 @5xl:col-span-7"
        >
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="space-y-1">
                <p
                  id="trip-readiness-heading"
                  className="text-muted-foreground text-xs font-medium tracking-widest uppercase"
                >
                  Trip readiness
                </p>
                <div className="flex items-baseline gap-3">
                  <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                    {percent}%
                  </p>
                  <p className="text-muted-foreground text-sm tabular-nums">
                    {done} of {steps.length} steps done
                  </p>
                </div>
              </div>

              {report.estimatedTotalMinor > 0 ? (
                <div className="space-y-1 text-left sm:text-right">
                  <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
                    Estimated group cost
                  </p>
                  <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
                    {money(report.estimatedTotalMinor)}
                  </p>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {money(report.bookedTotalMinor)} booked
                    {report.potentialSavingsMinor > 0
                      ? `, ${money(report.potentialSavingsMinor)} drop available`
                      : ''}
                  </p>
                </div>
              ) : null}
            </div>

            <div
              role="progressbar"
              aria-labelledby="trip-readiness-heading"
              aria-valuemin={0}
              aria-valuemax={steps.length}
              aria-valuenow={done}
              aria-valuetext={`${percent} percent, ${done} of ${steps.length} steps done`}
              className="bg-muted h-2 overflow-hidden rounded-full"
            >
              <div
                className="bg-primary h-full rounded-full transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>

            {leadCopy ? (
              <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-4 rounded-md border px-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-foreground/75 text-xs font-medium tracking-wider uppercase">
                    Recommended next move
                  </p>
                  <p className="text-sm font-semibold">{leadCopy.title}</p>
                  <p className="text-foreground/75 text-xs">
                    {leadCopy.detail}
                  </p>
                </div>
                <Button size="sm" onClick={() => go(leadCopy.tab)}>
                  {leadCopy.cta} <ArrowRight aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">Where and when</dt>
              <dd className="font-medium">
                {option
                  ? `${option.label}, ${formatRange(option.depart, option.return)} (${daysBetween(option.depart, option.return)} nights)`
                  : trip.options.length > 0
                    ? `${trip.options.filter((o) => o.status === 'candidate').length} options on shortlist`
                    : 'Not picked yet'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Group status</dt>
              <dd className="font-medium">
                {goingCount} in, {maybeCount} maybe
                {invitedCount > 0 ? `, ${invitedCount} invited` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Price monitor</dt>
              <dd className="font-medium">
                {report.dropsCount > 0
                  ? `${money(report.potentialSavingsMinor)} drop on ${report.dropsCount} ${report.dropsCount === 1 ? 'booking' : 'bookings'}`
                  : report.activeCount > 0
                    ? `${report.activeCount} active ${report.activeCount === 1 ? 'watch' : 'watches'}`
                    : 'No watches yet'}
              </dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col @5xl:col-span-5">
          <AttentionFeed
            trip={trip}
            me={me}
            signals={signals}
            update={update}
            go={go}
            runWatches={runWatches}
          />
        </div>
      </div>

      {/* Band 2: Asymmetric 7 / 5 Live Planner Snapshot + Price Monitor Pulse */}
      <div className="grid grid-cols-1 gap-6 @5xl:grid-cols-12 @5xl:items-start">
        <section
          aria-labelledby="planner-pulse-heading"
          className="bg-card space-y-4 rounded-lg border p-5 @5xl:col-span-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                id="planner-pulse-heading"
                className="flex items-center gap-2 text-base font-semibold"
              >
                <CalendarRange className="size-4 shrink-0" aria-hidden />
                {option
                  ? `Who is where: ${option.label}`
                  : 'Group date overlap'}
              </h2>
              <p className="text-muted-foreground text-xs">
                {option
                  ? `${formatRange(option.depart, option.return)} · ${scheduledCount} scheduled ${scheduledCount === 1 ? 'activity' : 'activities'}, ${landingCount} arrival ${landingCount === 1 ? 'group' : 'groups'}${issueCount > 0 ? `, ${issueCount} ${issueCount === 1 ? 'conflict' : 'conflicts'}` : ''}`
                  : topWindow
                    ? `Best 7-night overlap: ${formatRange(topWindow.start, topWindow.end)} (${topWindow.memberIds.length} can make it)`
                    : 'Mark dates in Coordinator to find shared windows.'}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => go(option ? 'planner' : 'coordinator')}
            >
              {option ? 'Open Trip Planner' : 'Open Coordinator'}{' '}
              <ArrowRight aria-hidden />
            </Button>
          </div>

          {option ? (
            <Timeline trip={trip} option={option} compact />
          ) : (
            <div className="space-y-4">
              <AvailabilityMatrix trip={trip} highlightWindow={topWindow} />
              {poll && pollTally.length > 0 ? (
                <div className="bg-muted/30 space-y-2.5 rounded-md border p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold">
                      Open vote: {poll.question}
                    </span>
                    <span className="text-muted-foreground">
                      {new Set(poll.votes.map((v) => v.memberId)).size} of{' '}
                      {active.length} voted
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {pollTally.map((entry) => {
                      const pct =
                        active.length > 0
                          ? Math.round((entry.approvals / active.length) * 100)
                          : 0
                      return (
                        <li key={entry.choiceId} className="space-y-1 text-xs">
                          <div className="flex justify-between gap-2">
                            <span className="font-medium">{entry.label}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {entry.approvals} approve, {entry.favourites}{' '}
                              favourite
                            </span>
                          </div>
                          <div
                            className="bg-muted h-1.5 overflow-hidden rounded-full"
                            aria-hidden
                          >
                            <div
                              className="bg-primary h-full rounded-full"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </section>

        <section
          aria-labelledby="price-pulse-heading"
          className="bg-card space-y-4 rounded-lg border p-5 @5xl:col-span-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                id="price-pulse-heading"
                className="flex items-center gap-2 text-base font-semibold"
              >
                <TrendingDown className="size-4 shrink-0" aria-hidden />
                Price monitor
              </h2>
              <p className="text-muted-foreground text-xs">
                {report.activeCount === 0
                  ? 'Track flights and hotels at any stage.'
                  : `${report.activeCount} active · ${report.alertsCount} ${report.alertsCount === 1 ? 'alert' : 'alerts'}`}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {report.entries.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={anyWatchBusy}
                  onClick={() =>
                    void runWatches(report.entries.map((e) => e.watch))
                  }
                >
                  <RefreshCw
                    className={cn(anyWatchBusy && 'animate-spin')}
                    aria-hidden
                  />
                  Check all
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => go('prices')}>
                All <ArrowRight aria-hidden />
              </Button>
            </div>
          </div>

          {report.entries.length === 0 ? (
            <div className="bg-muted/30 space-y-3 rounded-md border border-dashed p-4 text-sm">
              <p className="text-muted-foreground">
                No flights or stays are being watched yet. Watch a shortlist
                destination or add a custom route to start tracking prices.
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => go('prices')}
              >
                Add a price watch
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <ul className="divide-y rounded-md border">
                {report.entries.slice(0, 4).map((entry) => {
                  const suffix = entry.unit === 'nightly' ? '/nt' : ''
                  const positive =
                    entry.signal === 'drop_alert' ||
                    entry.signal === 'at_target' ||
                    entry.signal === 'down'
                  return (
                    <li
                      key={entry.watch.id}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="truncate font-medium">
                          {entry.primaryItem?.title ?? entry.watch.label}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <SignalBadge entry={entry} />
                          {entry.watch.sample ? (
                            <span className="text-muted-foreground text-[0.7rem]">
                              Sample
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <Sparkline
                        series={entry.series}
                        label={entry.watch.label}
                        positive={positive}
                        className="hidden sm:block"
                      />
                      <div className="shrink-0 text-right tabular-nums">
                        <p className="font-semibold">
                          {entry.currentMinor !== null
                            ? `${money(entry.currentMinor)}${suffix}`
                            : 'None'}
                        </p>
                        {entry.deltaMinor !== null && entry.deltaMinor !== 0 ? (
                          <p className="text-muted-foreground text-xs">
                            {entry.deltaMinor < 0 ? '-' : '+'}
                            {money(Math.abs(entry.deltaMinor))}
                          </p>
                        ) : (
                          <p className="text-muted-foreground text-xs">Flat</p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {report.estimatedTotalMinor > 0 ? (
                <div className="space-y-1.5 pt-1 text-xs">
                  <div className="flex justify-between gap-2 tabular-nums">
                    <span className="text-muted-foreground">
                      Booked vs estimated spend
                    </span>
                    <span className="font-medium">
                      {money(report.bookedTotalMinor)} /{' '}
                      {money(report.estimatedTotalMinor)} ({bookedPct}%)
                    </span>
                  </div>
                  <div
                    className="bg-muted h-1.5 overflow-hidden rounded-full"
                    aria-hidden
                  >
                    <div
                      className="bg-chart-2 h-full rounded-full"
                      style={{ width: `${bookedPct}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {/* Band 3: Asymmetric 8 / 4 Group Coordination Matrix + Cost & Decision Log */}
      <div className="grid grid-cols-1 gap-6 @5xl:grid-cols-12 @5xl:items-start">
        <section
          aria-labelledby="group-matrix-heading"
          className="space-y-3 @5xl:col-span-8"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="group-matrix-heading"
                className="text-lg font-semibold tracking-tight"
              >
                Group readiness
              </h2>
              <p className="text-muted-foreground text-xs">
                Every person's answers, bookings and open tasks. Select a name
                to switch to their view.
              </p>
            </div>
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
              {copied ? 'Copied nudge' : 'Copy group nudge'}
            </Button>
          </div>

          <div
            tabIndex={0}
            role="region"
            aria-label="Group readiness matrix"
            className="bg-card focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
          >
            <table className="w-full min-w-[48rem] text-sm">
              <caption className="sr-only">
                Each member's RSVP, dates, origin airport, vote or share, flight
                and stay status.
              </caption>
              <thead>
                <tr className="text-muted-foreground border-b text-left text-xs">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Person
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Coming{' '}
                    <span className="block font-normal">
                      {count((r) => r.member.rsvp !== 'invited')}
                    </span>
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Dates{' '}
                    <span className="block font-normal">
                      {count((r) => r.member.dates.length > 0)}
                    </span>
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    From{' '}
                    <span className="block font-normal">
                      {count((r) => r.member.home.kind !== 'unanswered')}
                    </span>
                  </th>
                  {poll ? (
                    <th scope="col" className="px-3 py-3 font-medium">
                      Vote{' '}
                      <span className="block font-normal">
                        {count((r) => r.status.vote === 'voted')}
                      </span>
                    </th>
                  ) : null}
                  <th scope="col" className="px-3 py-3 font-medium">
                    Flight{' '}
                    <span className="block font-normal">
                      {option
                        ? `${count((r) => r.status.flight === 'booked' || r.status.flight === 'not_needed')} done`
                        : 'after vote'}
                    </span>
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Stay{' '}
                    <span className="block font-normal">
                      {option
                        ? `${count((r) => r.status.stay === 'booked')} booked`
                        : 'after vote'}
                    </span>
                  </th>
                  {costs ? (
                    <th
                      scope="col"
                      className="px-3 py-3 text-right font-medium"
                    >
                      Share
                    </th>
                  ) : null}
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Open
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ member, status }) => {
                  const firstRange = member.dates[0]
                  const home = homeLabel(member)
                  const share = costs?.get(member.id) ?? 0
                  return (
                    <tr
                      key={member.id}
                      className={cn(
                        'border-b last:border-0',
                        member.rsvp === 'out' && 'opacity-60',
                        member.id === me.id && 'bg-accent/40',
                      )}
                    >
                      <th
                        scope="row"
                        className="px-4 py-2.5 text-left font-normal"
                      >
                        <button
                          type="button"
                          onClick={() => actAs(member.id)}
                          aria-pressed={member.id === me.id}
                          className="hover:bg-accent focus-visible:ring-ring -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1 text-left focus-visible:ring-2 focus-visible:outline-none"
                        >
                          <Avatar
                            trip={trip}
                            memberId={member.id}
                            className="size-7"
                          />
                          <span>
                            <span className="block font-medium">
                              {member.name}
                            </span>
                            <span className="text-foreground/75 block text-xs">
                              {member.id === me.id
                                ? 'Viewing as'
                                : member.role === 'owner'
                                  ? 'Organizer'
                                  : 'Switch view'}
                            </span>
                          </span>
                        </button>
                      </th>
                      <td className="px-3 py-2.5">
                        <Status tone={RSVP_TONE[member.rsvp]}>
                          {RSVP_LABEL[member.rsvp]}
                        </Status>
                      </td>
                      <td className="px-3 py-2.5">
                        {firstRange ? (
                          <Status tone="done">
                            {formatRange(firstRange.start, firstRange.end)}
                            {member.dates.length > 1
                              ? ` +${member.dates.length - 1}`
                              : ''}
                          </Status>
                        ) : (
                          <Status tone="todo">Not given</Status>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Status tone={home.tone}>{home.label}</Status>
                      </td>
                      {poll ? (
                        <td className="px-3 py-2.5">
                          <Status tone={VOTE[status.vote].tone}>
                            {VOTE[status.vote].label}
                          </Status>
                        </td>
                      ) : null}
                      <td className="px-3 py-2.5">
                        <Status tone={TRAVEL_STATUS[status.flight].tone}>
                          {TRAVEL_STATUS[status.flight].label}
                        </Status>
                      </td>
                      <td className="px-3 py-2.5">
                        <Status tone={TRAVEL_STATUS[status.stay].tone}>
                          {TRAVEL_STATUS[status.stay].label}
                        </Status>
                      </td>
                      {costs ? (
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {share > 0 ? (
                            money(share)
                          ) : (
                            <span className="text-muted-foreground">
                              Not set
                            </span>
                          )}
                        </td>
                      ) : null}
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {status.asks === 0 ? (
                          <span className="text-muted-foreground">All set</span>
                        ) : (
                          `${status.asks} to do`
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="space-y-6 @5xl:col-span-4">
          {option ? (
            <div className="space-y-2.5">
              <h3 className="text-base font-semibold">Cost by person</h3>
              <CostBars trip={trip} option={option} />
            </div>
          ) : (
            <WaitingOn trip={trip} me={me} actAs={actAs} />
          )}
          <DecisionLog trip={trip} me={me} update={update} />
        </div>
      </div>
    </div>
  )
}
