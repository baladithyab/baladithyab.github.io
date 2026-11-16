import type { CSSProperties, ReactNode } from 'react'
import { BedDouble, PlaneLanding, PlaneTakeoff } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  consecutiveRuns,
  eachDay,
  formatDay,
  formatRange,
  localTimeOf,
  nightsOf,
} from '@/lib/tripspace/dates'
import {
  audience,
  going,
  memberFlight,
  presence,
  stayNights,
  type Item,
  type Trip,
  type TripOption,
} from '@/lib/tripspace/model'

import { Avatar, toneOf } from './parts'

const AUDIENCE = { group: 'Group', breakout: 'Breakout', solo: 'Solo' } as const

/** A bar across day columns `start` to `end` (indices into the day list, inclusive) on one row of a member's lane. */
function Bar({
  start,
  end,
  row,
  className,
  children,
}: {
  start: number
  end: number
  row: number
  className?: string
  children: ReactNode
}) {
  const style: CSSProperties = {
    gridColumn: `${start + 2} / ${end + 3}`,
    gridRow: row,
  }
  return (
    <div
      style={style}
      className={cn(
        'relative z-[1] mx-0.5 flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs',
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * One row per person who is coming, one column per day of the trip. Each row
 * shows when that person is there (from their own flight), the nights each of
 * their stays covers, nights with no bed, and their activities. Shared stays
 * and activities line up across rows, which is where the overlap shows.
 */
export default function Timeline({
  trip,
  option,
}: {
  trip: Trip
  option: TripOption
}) {
  const days = eachDay(option.depart, option.return)
  const members = going(trip)
  const index = (date: string) => {
    const at = days.indexOf(date)
    if (at !== -1) return at
    return date < (days[0] ?? date) ? 0 : days.length - 1
  }
  const columns: CSSProperties = {
    gridTemplateColumns: `minmax(7.5rem, 10rem) repeat(${days.length}, minmax(6.5rem, 1fr))`,
  }
  const weekend = (date: string) =>
    [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
  const lanes = members.map((member) => ({
    member,
    ...presence(trip, option, member.id),
  }))
  const hereOn = (date: string) =>
    lanes.filter((l) => l.arrive <= date && date <= l.leave).length

  const live = trip.items.filter(
    (i) =>
      i.status !== 'dropped' &&
      (i.optionId === option.id || i.optionId === null),
  )

  if (members.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nobody has said they are coming yet.
      </p>
    )
  }

  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Who is where, day by day"
      className="bg-card focus-visible:ring-ring overflow-x-auto rounded-lg border focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="min-w-max">
        <div className="grid border-b" style={columns}>
          <div className="bg-card sticky left-0 z-10 px-3 py-2">
            <p className="text-muted-foreground text-xs">Here each day</p>
          </div>
          {days.map((date) => {
            const here = hereOn(date)
            const everyone = here === members.length
            return (
              <div
                key={date}
                className={cn(
                  'space-y-1 px-2 py-2 text-xs',
                  weekend(date) && 'bg-muted/40',
                )}
              >
                <p className="font-medium">{formatDay(date)}</p>
                <p
                  className={
                    everyone ? 'text-foreground' : 'text-muted-foreground'
                  }
                >
                  {everyone ? 'Everyone' : `${here} of ${members.length}`}
                </p>
                <div
                  className="bg-muted h-1 overflow-hidden rounded-full"
                  aria-hidden
                >
                  <div
                    className="bg-muted-foreground/70 h-full rounded-full"
                    style={{ width: `${(here / members.length) * 100}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>

        {lanes.map(({ member, arrive, leave, known }) => {
          const tone = toneOf(trip, member.id)
          const flight = memberFlight(trip, option, member.id)
          const start = index(arrive)
          const end = index(leave)
          const stays = live.flatMap((item) => {
            if (item.detail.kind !== 'stay' || item.optionId !== option.id)
              return []
            const part = item.participants.find((p) => p.memberId === member.id)
            return part
              ? consecutiveRuns(stayNights(item, part)).map((nights) => ({
                  item,
                  nights,
                }))
              : []
          })
          const covered = new Set(stays.flatMap((s) => s.nights))
          const noBed = consecutiveRuns(
            nightsOf(arrive, leave).filter((night) => !covered.has(night)),
          )
          const activities = live.filter(
            (i): i is Item & { startDate: string } =>
              i.detail.kind === 'activity' &&
              i.startDate !== null &&
              i.participants.some((p) => p.memberId === member.id),
          )
          const byDay = new Map<string, (Item & { startDate: string })[]>()
          for (const activity of activities)
            byDay.set(activity.startDate, [
              ...(byDay.get(activity.startDate) ?? []),
              activity,
            ])

          return (
            <div
              key={member.id}
              role="group"
              aria-label={member.name}
              className="grid border-b last:border-0"
              style={{ ...columns, gridTemplateRows: 'auto auto auto' }}
            >
              <div
                className="bg-card sticky left-0 z-10 flex items-start gap-2 px-3 py-2.5"
                style={{ gridColumn: 1, gridRow: '1 / 4' }}
              >
                <Avatar trip={trip} memberId={member.id} className="size-7" />
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">{member.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {member.home.kind === 'airports'
                      ? `From ${member.home.codes.join(', ')}`
                      : member.home.kind === 'local'
                        ? 'Local'
                        : 'From unknown'}
                  </p>
                </div>
              </div>
              {days.map((date, i) =>
                weekend(date) ? (
                  <div
                    key={date}
                    aria-hidden
                    className="bg-muted/40"
                    style={{ gridColumn: i + 2, gridRow: '1 / 4' }}
                  />
                ) : null,
              )}

              {member.home.kind === 'local' ? (
                <Bar
                  start={start}
                  end={end}
                  row={1}
                  className={cn('mt-2', tone.bar)}
                >
                  <span className="sr-only">
                    {formatRange(arrive, leave)}:{' '}
                  </span>
                  Local, there all trip
                </Bar>
              ) : known && flight ? (
                <Bar
                  start={start}
                  end={end}
                  row={1}
                  className={cn('mt-2 justify-between', tone.bar)}
                >
                  <span className="inline-flex items-center gap-1 truncate">
                    <PlaneLanding className="size-3.5 shrink-0" aria-hidden />
                    <span className="sr-only">Lands {formatDay(arrive)}</span>
                    {localTimeOf(flight.offer.outbound.arrives)}{' '}
                    {flight.offer.outbound.to}
                  </span>
                  {flight.offer.inbound ? (
                    <span className="inline-flex items-center gap-1 truncate">
                      <span className="sr-only">Leaves {formatDay(leave)}</span>
                      {localTimeOf(flight.offer.inbound.departs)}
                      <PlaneTakeoff className="size-3.5 shrink-0" aria-hidden />
                    </span>
                  ) : null}
                </Bar>
              ) : (
                <Bar
                  start={start}
                  end={end}
                  row={1}
                  className="text-muted-foreground mt-2 border border-dashed"
                >
                  <span className="sr-only">
                    {formatRange(arrive, leave)}:{' '}
                  </span>
                  No flight chosen, so these are the trip's dates
                </Bar>
              )}

              {days.map((date, i) => {
                const today = byDay.get(date)
                if (!today) return null
                return (
                  <div
                    key={date}
                    className="relative z-[1] space-y-1 px-1 pt-1.5"
                    style={{ gridColumn: i + 2, gridRow: 2 }}
                  >
                    {today.map((activity) => (
                      <div
                        key={activity.id}
                        className="bg-secondary text-secondary-foreground rounded-md px-2 py-1 text-xs"
                      >
                        <span className="sr-only">{formatDay(date)}: </span>
                        <span className="block truncate font-medium">
                          {activity.title}
                        </span>
                        <span className="text-muted-foreground block">
                          {activity.detail.kind === 'activity' &&
                          activity.detail.time
                            ? `${activity.detail.time}, `
                            : ''}
                          {AUDIENCE[audience(trip, activity)]}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}

              {stays.map(({ item, nights }) => (
                <Bar
                  key={`${item.id}-${nights[0]}`}
                  start={index(nights[0] ?? arrive)}
                  end={index(nights.at(-1) ?? arrive)}
                  row={3}
                  className="bg-muted text-foreground my-1.5"
                >
                  <BedDouble className="size-3.5 shrink-0" aria-hidden />
                  <span className="sr-only">
                    Nights of{' '}
                    {formatRange(nights[0] ?? arrive, nights.at(-1) ?? arrive)}
                    :{' '}
                  </span>
                  <span className="truncate">
                    {item.detail.kind === 'stay' && item.detail.hotel
                      ? item.detail.hotel.name
                      : 'Stay, hotel not chosen'}
                    {item.status === 'booked' ? ', booked' : ''}
                  </span>
                </Bar>
              ))}
              {noBed.map((nights) => (
                <Bar
                  key={`nobed-${nights[0]}`}
                  start={index(nights[0] ?? arrive)}
                  end={index(nights.at(-1) ?? arrive)}
                  row={3}
                  className="text-muted-foreground my-1.5 border border-dashed"
                >
                  <span className="sr-only">
                    Nights of{' '}
                    {formatRange(nights[0] ?? arrive, nights.at(-1) ?? arrive)}
                    :{' '}
                  </span>
                  No bed yet
                </Bar>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
