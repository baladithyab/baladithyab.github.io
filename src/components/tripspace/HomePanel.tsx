import { cn } from '@/lib/utils'
import { daysBetween, formatRange } from '@/lib/tripspace/dates'
import {
  chosenOption,
  memberStatus,
  type Member,
  type MemberStatus,
} from '@/lib/tripspace/model'

import { DecisionLog, NextStep, WaitingOn } from './Briefing'
import {
  Avatar,
  RSVP_LABEL,
  RSVP_TONE,
  Section,
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
      return { label: 'Already there', tone: 'done' }
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
    no_poll: { label: 'No vote open', tone: 'quiet' },
    voted: { label: 'Voted', tone: 'done' },
    not_voted: { label: 'Not yet', tone: 'todo' },
  }

export default function HomePanel(props: PanelProps) {
  const { trip, me, actAs } = props
  const option = chosenOption(trip)
  const poll = trip.polls.find((p) => p.status === 'open')
  const rows = trip.members.map((member) => ({
    member,
    status: memberStatus(trip, member.id),
  }))
  const active = rows.filter((r) => r.member.rsvp !== 'out')

  // Progress toward "everyone booked": every step each person who might come still owes.
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
    `${active.filter(test).length} of ${active.length}`
  const going = trip.members.filter((m) => m.rsvp === 'in').length
  const maybe = trip.members.filter((m) => m.rsvp === 'maybe').length
  const travelItems = option
    ? trip.items.filter(
        (i) =>
          i.optionId === option.id &&
          i.status !== 'dropped' &&
          i.detail.kind !== 'activity',
      )
    : []

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-1 gap-6 2xl:hidden @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <NextStep trip={trip} me={me} go={props.go} size="hero" />
        <WaitingOn trip={trip} me={me} actAs={actAs} />
      </div>

      <section
        aria-labelledby="progress"
        className="bg-card space-y-5 rounded-lg border p-6"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
          <div className="space-y-1">
            <h2
              id="progress"
              className="text-muted-foreground text-xs font-medium tracking-widest uppercase"
            >
              Toward everyone booked
            </h2>
            <p className="text-4xl font-semibold tracking-tight tabular-nums">
              {done}{' '}
              <span className="text-muted-foreground text-lg font-normal">
                of {steps.length} steps done
              </span>
            </p>
          </div>
          <dl className="grid grid-cols-1 gap-x-10 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">Where and when</dt>
              <dd className="font-medium">
                {option
                  ? `${option.label}, ${formatRange(option.depart, option.return)}, ${daysBetween(option.depart, option.return)} nights`
                  : trip.options.length > 0
                    ? `Not decided, ${trip.options.filter((o) => o.status === 'candidate').length} on the shortlist`
                    : 'Not decided'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Coming</dt>
              <dd className="font-medium">
                {going} in, {maybe} maybe,{' '}
                {trip.members.filter((m) => m.rsvp === 'invited').length} not
                answered
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">
                Flights and stays
              </dt>
              <dd className="font-medium">
                {option
                  ? `${travelItems.filter((i) => i.status === 'booked').length} of ${travelItems.length} booked`
                  : 'After the vote'}
              </dd>
            </div>
          </dl>
        </div>
        <div
          role="progressbar"
          aria-labelledby="progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${steps.length} steps done`}
          className="bg-muted h-2 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </section>

      <Section
        title="Everyone at a glance"
        description="Who has answered, voted and booked. Select a name to answer as that person."
      >
        <div
          tabIndex={0}
          role="region"
          aria-label="Everyone at a glance"
          className="bg-card focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
        >
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left text-xs">
                <th scope="col" className="px-4 py-3 font-medium">
                  Person
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Coming{' '}
                  <span className="block font-normal">
                    {count((r) => r.member.rsvp !== 'invited')} answered
                  </span>
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Dates{' '}
                  <span className="block font-normal">
                    {count((r) => r.member.dates.length > 0)} given
                  </span>
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Travelling from{' '}
                  <span className="block font-normal">
                    {count((r) => r.member.home.kind !== 'unanswered')} given
                  </span>
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Vote{' '}
                  <span className="block font-normal">
                    {poll
                      ? `${count((r) => r.status.vote === 'voted')} voted`
                      : 'none open'}
                  </span>
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Flight{' '}
                  <span className="block font-normal">
                    {option
                      ? `${count((r) => r.status.flight === 'booked' || r.status.flight === 'not_needed')} done`
                      : 'after the vote'}
                  </span>
                </th>
                <th scope="col" className="px-3 py-3 font-medium">
                  Stay{' '}
                  <span className="block font-normal">
                    {option
                      ? `${count((r) => r.status.stay === 'booked')} booked`
                      : 'after the vote'}
                  </span>
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member, status }) => {
                const firstRange = member.dates[0]
                const home = homeLabel(member)
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
                          <span className="text-muted-foreground block text-xs">
                            {member.id === me.id
                              ? 'You'
                              : member.role === 'owner'
                                ? 'Organizer'
                                : 'Answer as them'}
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
                    <td className="px-3 py-2.5">
                      <Status tone={VOTE[status.vote].tone}>
                        {VOTE[status.vote].label}
                      </Status>
                    </td>
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
      </Section>

      <div className="2xl:hidden">
        <DecisionLog trip={trip} />
      </div>
    </div>
  )
}
