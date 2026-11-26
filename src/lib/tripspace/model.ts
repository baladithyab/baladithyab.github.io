/**
 * Tripspace domain: the stored shape of a trip (zod schemas, so a trip read
 * back from storage is checked before use) and the pure functions every view
 * derives from it. Nothing here touches the network or the DOM.
 *
 * Design: docs/TRIPSPACE.md and docs/TRIPSPACE_UX.md.
 */
import { z } from 'astro/zod'

import {
  addDays,
  consecutiveRuns,
  eachDay,
  localDateOf,
  nightsOf,
} from './dates'
import {
  flightOfferSchema,
  hotelOfferSchema,
  iataSchema,
  isoDateSchema,
  offerSchema,
  searchRequestSchema,
  type FlightOffer,
} from './search'

const id = z.string().min(1)
const minor = z.number().int().min(0)

export const partySchema = z.object({
  adults: z.number().int().min(1).max(9),
  children: z.number().int().min(0).max(8),
})
export type Party = z.infer<typeof partySchema>

/** Where a member travels from. `unanswered` and `local` are different: only one needs asking. */
export const homeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unanswered') }),
  z.object({
    kind: z.literal('airports'),
    codes: z.array(iataSchema).min(1).max(3),
  }),
  z.object({ kind: z.literal('local') }),
])
export type Home = z.infer<typeof homeSchema>

export const dateRangeSchema = z
  .object({ start: isoDateSchema, end: isoDateSchema })
  .refine((r) => r.end >= r.start, 'a range must not end before it starts')
export type DateRange = z.infer<typeof dateRangeSchema>

export const memberSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  role: z.enum(['owner', 'member']),
  rsvp: z.enum(['invited', 'in', 'maybe', 'out']),
  dates: z.array(dateRangeSchema),
  budgetBand: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  home: homeSchema,
  party: partySchema,
})
export type Member = z.infer<typeof memberSchema>
export type Rsvp = Member['rsvp']

const flightPriceSchema = z.object({
  from: z.array(iataSchema).min(1),
  memberIds: z.array(id).min(1),
  offer: flightOfferSchema.nullable(),
  error: z.string().nullable(),
})
const stayPriceSchema = z.object({
  rooms: z.number().int().min(1),
  offer: hotelOfferSchema.nullable(),
  error: z.string().nullable(),
})
export const pricingSchema = z.object({
  at: z.number(),
  flights: z.array(flightPriceSchema),
  stay: stayPriceSchema,
})
export type Pricing = z.infer<typeof pricingSchema>

export const optionSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(80),
    destination: iataSchema,
    city: z.string().trim().min(1).max(80),
    depart: isoDateSchema,
    return: isoDateSchema,
    status: z.enum(['candidate', 'chosen', 'rejected']),
    pricing: pricingSchema.nullable(),
  })
  .refine((o) => o.return > o.depart, 'an option must return after it departs')
export type TripOption = z.infer<typeof optionSchema>

export const interestSchema = z.enum(['reserve', 'want', 'like'])
export type Interest = z.infer<typeof interestSchema>

export const participantSchema = z.object({
  memberId: id,
  /** This member's own bucket for an idea. */
  interest: interestSchema.nullable(),
  /** Narrow one person's part of a stay; null for the whole item. */
  fromDate: isoDateSchema.nullable(),
  toDate: isoDateSchema.nullable(),
  /** A fixed share that overrides the split. */
  shareMinor: minor.nullable(),
})
export type Participant = z.infer<typeof participantSchema>

const flightDetailSchema = z.object({
  kind: z.literal('flight'),
  from: z.array(iataSchema).min(1).max(3),
  to: z.array(iataSchema).min(1).max(3),
  depart: isoDateSchema,
  return: isoDateSchema.nullable(),
  offer: flightOfferSchema.nullable(),
})
const stayDetailSchema = z.object({
  kind: z.literal('stay'),
  city: z.string().trim().min(1),
  rooms: z.number().int().min(1).max(9),
  hotel: hotelOfferSchema.nullable(),
})
const activityDetailSchema = z.object({
  kind: z.literal('activity'),
  place: z.string().nullable(),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  link: z.string().nullable(),
})
export const itemDetailSchema = z.discriminatedUnion('kind', [
  flightDetailSchema,
  stayDetailSchema,
  activityDetailSchema,
])
export type ItemDetail = z.infer<typeof itemDetailSchema>

export const bookingSchema = z.object({
  /** Who sold it: an airline, an agency or a hotel group. */
  soldBy: z.string().trim().min(1).max(60),
  fareType: z.string().nullable(),
  freeCancelUntil: isoDateSchema.nullable(),
})
export type Booking = z.infer<typeof bookingSchema>

export const itemSchema = z
  .object({
    id,
    optionId: id.nullable(),
    status: z.enum(['open', 'chosen', 'booked', 'dropped']),
    title: z.string().trim().min(1).max(120),
    startDate: isoDateSchema.nullable(),
    endDate: isoDateSchema.nullable(),
    detail: itemDetailSchema,
    participants: z.array(participantSchema),
    quotedMinor: minor.nullable(),
    paidMinor: minor.nullable(),
    bookBy: isoDateSchema.nullable(),
    leadMemberId: id.nullable(),
    booking: bookingSchema.nullable(),
    watchId: id.nullable(),
  })
  .refine(
    (i) => (i.startDate === null) === (i.endDate === null),
    'dates come as a pair',
  )
  .refine(
    (i) =>
      i.startDate === null || i.endDate === null || i.endDate >= i.startDate,
    'an item must not end before it starts',
  )
  .refine(
    (i) =>
      i.startDate !== null ||
      (i.detail.kind === 'activity' && i.status === 'open'),
    'only an unscheduled idea may have no dates',
  )
export type Item = z.infer<typeof itemSchema>
export type ItemStatus = Item['status']

export const observationSchema = z.object({
  firstSeen: z.number(),
  lastSeen: z.number(),
  /** Null: nothing matched at this check. */
  priceMinor: minor.nullable(),
})
export type Observation = z.infer<typeof observationSchema>

export const watchSchema = z.object({
  id,
  label: z.string(),
  request: searchRequestSchema,
  /** The cheapest offer at each check, run-length encoded. */
  cheapest: z.array(observationSchema),
  /** The price of one chosen offer, by offer key, at each check. */
  tracked: z.record(z.string(), z.array(observationSchema)),
  offers: z.array(offerSchema),
  searchUrl: z.string().nullable(),
  checkedAt: z.number().nullable(),
  error: z.string().nullable(),
  /** Optional price alert threshold (total for flights, nightly per room for hotels). */
  targetMinor: minor.nullable().optional(),
  /** True when watched directly on the Price Monitor rather than owned by a slot. */
  standalone: z.boolean().optional(),
  /** True on seeded demo observations until replaced by a live search. */
  sample: z.boolean().optional(),
})
export type Watch = z.infer<typeof watchSchema>

export const voteSchema = z.object({
  choiceId: id,
  memberId: id,
  favourite: z.boolean(),
})
export const pollSchema = z.object({
  id,
  question: z.string().trim().min(1).max(120),
  choices: z.array(z.object({ id, label: z.string(), optionId: id })).min(2),
  votes: z.array(voteSchema),
  closesAt: z.number(),
  status: z.enum(['open', 'decided', 'cancelled']),
})
export type Poll = z.infer<typeof pollSchema>

export const decisionSchema = z.object({
  id,
  summary: z.string().trim().min(1).max(200),
  at: z.number(),
  by: id,
  pollId: id.nullable(),
  optionId: id.nullable(),
  /** The decision this one replaces. The log is never edited. */
  replacesId: id.nullable(),
})
export type Decision = z.infer<typeof decisionSchema>

export const tripSchema = z.object({
  id,
  title: z.string().trim().min(1).max(80),
  createdAt: z.number(),
  members: z.array(memberSchema).min(1),
  options: z.array(optionSchema),
  items: z.array(itemSchema),
  polls: z.array(pollSchema),
  decisions: z.array(decisionSchema),
  watches: z.array(watchSchema),
})
export type Trip = z.infer<typeof tripSchema>

export type Stage = 'idea' | 'shortlist' | 'plan' | 'booked'

// ---------------------------------------------------------------------------

/** People a member's seats and beds are for. */
export function heads(party: Party): number {
  return party.adults + party.children
}

export function chosenOption(trip: Trip): TripOption | null {
  return trip.options.find((o) => o.status === 'chosen') ?? null
}

/** Members who said they are coming. */
export function going(trip: Trip): Member[] {
  return trip.members.filter((m) => m.rsvp === 'in')
}

const isLive = (item: Item) => item.status !== 'dropped'
const hasMember = (item: Item, memberId: string) =>
  item.participants.some((p) => p.memberId === memberId)

/** The offer key a chosen flight or hotel is tracked by. */
export function matchKey(item: Item): string | null {
  switch (item.detail.kind) {
    case 'flight':
      return item.detail.offer?.key ?? null
    case 'stay':
      return item.detail.hotel?.key ?? null
    case 'activity':
      return null
    default: {
      const exhaustive: never = item.detail
      return exhaustive
    }
  }
}

/** The trip's stage, derived so it can never disagree with the plan. */
export function stageOf(trip: Trip): Stage {
  const option = chosenOption(trip)
  if (!option)
    return trip.options.some((o) => o.status === 'candidate')
      ? 'shortlist'
      : 'idea'
  const travel = trip.items.filter(
    (i) =>
      i.optionId === option.id && isLive(i) && i.detail.kind !== 'activity',
  )
  const settled =
    travel.length > 0 &&
    travel.every((i) => i.status === 'booked') &&
    findGaps(trip, option).length === 0
  return settled ? 'booked' : 'plan'
}

/** The chosen or booked flight that takes a member to an option, if there is one. */
export function memberFlight(
  trip: Trip,
  option: TripOption,
  memberId: string,
): { item: Item; offer: FlightOffer } | null {
  for (const item of trip.items) {
    if (
      item.optionId !== option.id ||
      !isLive(item) ||
      item.detail.kind !== 'flight' ||
      !hasMember(item, memberId)
    )
      continue
    if (item.detail.offer) return { item, offer: item.detail.offer }
  }
  return null
}

/** The days one member is at the destination: from their flight once chosen, else the option's dates. */
export function presence(
  trip: Trip,
  option: TripOption,
  memberId: string,
): { arrive: string; leave: string; known: boolean } {
  const flight = memberFlight(trip, option, memberId)
  if (flight) {
    const { outbound, inbound } = flight.offer
    return {
      arrive: localDateOf(outbound.arrives),
      leave: inbound ? localDateOf(inbound.departs) : option.return,
      known: true,
    }
  }
  return { arrive: option.depart, leave: option.return, known: false }
}

/** The nights one participant spends in a stay. */
export function stayNights(item: Item, participant: Participant): string[] {
  if (item.startDate === null || item.endDate === null) return []
  return nightsOf(
    participant.fromDate ?? item.startDate,
    participant.toDate ?? item.endDate,
  )
}

export type Gap =
  | {
      kind: 'no_flight'
      memberIds: string[]
      from: string[]
      to: string[]
      depart: string
      return: string
    }
  | {
      kind: 'no_stay'
      memberIds: string[]
      city: string
      checkin: string
      checkout: string
    }

/**
 * What the members who are coming still need for an option: a flight from
 * their home airports, and a bed for every night they are there. Members who
 * need the same thing share one gap, so they can share one search.
 */
export function findGaps(trip: Trip, option: TripOption): Gap[] {
  const flightGaps = new Map<string, Extract<Gap, { kind: 'no_flight' }>>()
  const stayGaps = new Map<string, Extract<Gap, { kind: 'no_stay' }>>()
  const items = trip.items.filter((i) => i.optionId === option.id && isLive(i))

  for (const member of going(trip)) {
    if (member.home.kind === 'airports') {
      const covered = items.some(
        (i) => i.detail.kind === 'flight' && hasMember(i, member.id),
      )
      if (!covered) {
        const from = [...member.home.codes].sort()
        const key = from.join('+')
        const gap = flightGaps.get(key)
        if (gap) gap.memberIds.push(member.id)
        else
          flightGaps.set(key, {
            kind: 'no_flight',
            memberIds: [member.id],
            from,
            to: [option.destination],
            depart: option.depart,
            return: option.return,
          })
      }
    }

    const { arrive, leave } = presence(trip, option, member.id)
    const covered = new Set(
      items.flatMap((i) => {
        if (i.detail.kind !== 'stay') return []
        const participant = i.participants.find((p) => p.memberId === member.id)
        return participant ? stayNights(i, participant) : []
      }),
    )
    for (const run of consecutiveRuns(
      nightsOf(arrive, leave).filter((night) => !covered.has(night)),
    )) {
      const checkin = run[0] ?? arrive
      const checkout = addDays(run.at(-1) ?? arrive, 1)
      const key = `${checkin}|${checkout}`
      const gap = stayGaps.get(key)
      if (gap) gap.memberIds.push(member.id)
      else
        stayGaps.set(key, {
          kind: 'no_stay',
          memberIds: [member.id],
          city: option.city,
          checkin,
          checkout,
        })
    }
  }
  return [...flightGaps.values(), ...stayGaps.values()]
}

export type Issue =
  | { kind: 'not_there'; itemId: string; memberId: string }
  | { kind: 'double_booked'; memberId: string; itemIds: [string, string] }
  | { kind: 'added_twice'; itemIds: [string, string] }
  | { kind: 'no_one_booking'; itemId: string }
  /** Nights a person is booked into a stay while they are not there yet, or have left. */
  | {
      kind: 'unused_nights'
      itemId: string
      memberId: string
      nights: string[]
    }

/** The nights of a stay one participant pays for but is not at the destination. */
export function unusedNights(
  trip: Trip,
  option: TripOption,
  item: Item,
  participant: Participant,
): string[] {
  const { arrive, leave } = presence(trip, option, participant.memberId)
  return stayNights(item, participant).filter(
    (night) => night < arrive || night >= leave,
  )
}

/** Things in an option's plan that cannot all be true, or that nobody owns. */
export function findIssues(trip: Trip, option: TripOption): Issue[] {
  const issues: Issue[] = []
  const items = trip.items.filter(
    (i) => isLive(i) && (i.optionId === option.id || i.optionId === null),
  )

  for (const item of items) {
    if (item.detail.kind === 'activity' && item.startDate !== null) {
      for (const p of item.participants) {
        const { arrive, leave } = presence(trip, option, p.memberId)
        if (item.startDate < arrive || item.startDate > leave)
          issues.push({
            kind: 'not_there',
            itemId: item.id,
            memberId: p.memberId,
          })
      }
    }
    if (item.detail.kind === 'stay' && item.optionId === option.id) {
      for (const p of item.participants) {
        const nights = unusedNights(trip, option, item, p)
        if (nights.length > 0)
          issues.push({
            kind: 'unused_nights',
            itemId: item.id,
            memberId: p.memberId,
            nights,
          })
      }
    }
    if (
      item.bookBy !== null &&
      item.leadMemberId === null &&
      item.status !== 'booked'
    ) {
      issues.push({ kind: 'no_one_booking', itemId: item.id })
    }
  }

  for (const member of trip.members) {
    const mine = items.filter(
      (i) => i.startDate !== null && hasMember(i, member.id),
    )
    const nightsBy = new Map<string, string>()
    const slotsBy = new Map<string, string>()
    for (const item of mine) {
      if (item.detail.kind === 'stay') {
        const participant = item.participants.find(
          (p) => p.memberId === member.id,
        )
        for (const night of participant ? stayNights(item, participant) : []) {
          const other = nightsBy.get(night)
          if (other && other !== item.id) {
            issues.push({
              kind: 'double_booked',
              memberId: member.id,
              itemIds: [other, item.id],
            })
            break
          }
          nightsBy.set(night, item.id)
        }
      } else if (item.detail.kind === 'activity' && item.detail.time !== null) {
        const slot = `${item.startDate}T${item.detail.time}`
        const other = slotsBy.get(slot)
        if (other)
          issues.push({
            kind: 'double_booked',
            memberId: member.id,
            itemIds: [other, item.id],
          })
        else slotsBy.set(slot, item.id)
      }
    }
  }

  const byKey = new Map<string, string>()
  for (const item of items) {
    const key = matchKey(item)
    if (key === null) continue
    const other = byKey.get(`${item.detail.kind}|${key}`)
    if (other) issues.push({ kind: 'added_twice', itemIds: [other, item.id] })
    else byKey.set(`${item.detail.kind}|${key}`, item.id)
  }
  return issues
}

/** The newest observed price of a series, or null when there is none. */
export function latest(series: Observation[] | undefined): number | null {
  return series?.at(-1)?.priceMinor ?? null
}

/** What an item costs in total: paid, else the newest observed price, else typed in. */
export function itemCost(trip: Trip, item: Item): number | null {
  if (item.paidMinor !== null) return item.paidMinor
  const watch = trip.watches.find((w) => w.id === item.watchId)
  const key = matchKey(item)
  const observed = key && watch ? latest(watch.tracked[key]) : null
  switch (item.detail.kind) {
    case 'flight':
      return item.detail.offer
        ? (observed ?? item.detail.offer.priceMinor)
        : item.quotedMinor
    case 'stay': {
      const nightly = item.detail.hotel
        ? (observed ?? item.detail.hotel.nightlyMinor)
        : null
      if (nightly === null || item.startDate === null || item.endDate === null)
        return item.quotedMinor
      return (
        nightly *
        item.detail.rooms *
        nightsOf(item.startDate, item.endDate).length
      )
    }
    case 'activity':
      return item.quotedMinor
    default: {
      const exhaustive: never = item.detail
      return exhaustive
    }
  }
}

/**
 * Split an amount by weight into whole minor units that sum exactly to it.
 * Remainders go to the largest fractional parts, ties to the earlier entry.
 */
export function splitByWeight(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (amount * w) / total)
  const shares = exact.map(Math.floor)
  let left = amount - shares.reduce((sum, s) => sum + s, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (const { index } of order) {
    if (left <= 0) break
    shares[index] = (shares[index] ?? 0) + 1
    left -= 1
  }
  return shares
}

/**
 * What each member pays for an option's plan. An item's cost is split across
 * its participants by head count, and by nights for a stay, unless a share is
 * fixed by hand. Items without a cost are skipped.
 */
export function costByMember(
  trip: Trip,
  option: TripOption,
): Map<string, number> {
  const totals = new Map<string, number>(trip.members.map((m) => [m.id, 0]))
  const people = new Map(trip.members.map((m) => [m.id, heads(m.party)]))
  for (const item of trip.items) {
    if (
      !isLive(item) ||
      (item.optionId !== option.id && item.optionId !== null) ||
      item.participants.length === 0
    )
      continue
    const cost = itemCost(trip, item)
    if (cost === null) continue
    const fixed = item.participants.reduce(
      (sum, p) => sum + (p.shareMinor ?? 0),
      0,
    )
    const open = item.participants.filter((p) => p.shareMinor === null)
    const weights = open.map(
      (p) =>
        (people.get(p.memberId) ?? 1) *
        (item.detail.kind === 'stay' ? stayNights(item, p).length : 1),
    )
    const shares = splitByWeight(Math.max(0, cost - fixed), weights)
    item.participants.forEach((p) => {
      if (p.shareMinor !== null)
        totals.set(p.memberId, (totals.get(p.memberId) ?? 0) + p.shareMinor)
    })
    open.forEach((p, index) =>
      totals.set(
        p.memberId,
        (totals.get(p.memberId) ?? 0) + (shares[index] ?? 0),
      ),
    )
  }
  return totals
}

/** Members who answered with dates and cannot be there for all of an option's days. */
export function cannotMake(trip: Trip, option: TripOption): Member[] {
  return trip.members.filter(
    (m) =>
      m.rsvp !== 'out' &&
      m.dates.length > 0 &&
      !m.dates.some((r) => r.start <= option.depart && r.end >= option.return),
  )
}

export type OptionCost = {
  perMember: Map<string, number>
  total: number
  /** Members with no price yet, because their flight search failed or has not run. */
  unpriced: string[]
}

/**
 * An option's estimated cost per member from its last pricing run: their own
 * flight, plus a head-count share of the stay.
 */
export function optionCost(trip: Trip, option: TripOption): OptionCost | null {
  const pricing = option.pricing
  if (!pricing) return null
  const people = new Map(trip.members.map((m) => [m.id, heads(m.party)]))
  const perMember = new Map<string, number>()
  const unpriced: string[] = []
  for (const flight of pricing.flights) {
    if (!flight.offer) {
      unpriced.push(...flight.memberIds)
      continue
    }
    const shares = splitByWeight(
      flight.offer.priceMinor,
      flight.memberIds.map((m) => people.get(m) ?? 1),
    )
    flight.memberIds.forEach((m, index) =>
      perMember.set(m, (perMember.get(m) ?? 0) + (shares[index] ?? 0)),
    )
  }
  const staying = going(trip)
  if (pricing.stay.offer && staying.length > 0) {
    const stayTotal =
      pricing.stay.offer.nightlyMinor *
      pricing.stay.rooms *
      nightsOf(option.depart, option.return).length
    const shares = splitByWeight(
      stayTotal,
      staying.map((m) => heads(m.party)),
    )
    staying.forEach((m, index) =>
      perMember.set(m.id, (perMember.get(m.id) ?? 0) + (shares[index] ?? 0)),
    )
  }
  const total = [...perMember.values()].reduce((sum, v) => sum + v, 0)
  return { perMember, total, unpriced }
}

export type Ask =
  | { kind: 'rsvp' }
  | { kind: 'dates' }
  | { kind: 'home' }
  | { kind: 'vote'; pollId: string; closesAt: number }
  | { kind: 'choose'; itemId: string }
  | { kind: 'book'; itemId: string; bookBy: string | null }

/**
 * What the trip still needs from one member, most urgent first. Derived on
 * every read, so an ask is gone the moment it is answered.
 */
export function nextAsks(trip: Trip, memberId: string): Ask[] {
  const member = trip.members.find((m) => m.id === memberId)
  if (!member || member.rsvp === 'out') return []
  const asks: Ask[] = []
  if (member.rsvp === 'invited') asks.push({ kind: 'rsvp' })
  if (member.dates.length === 0) asks.push({ kind: 'dates' })
  if (member.home.kind === 'unanswered') asks.push({ kind: 'home' })
  trip.polls
    .filter(
      (p) =>
        p.status === 'open' && !p.votes.some((v) => v.memberId === memberId),
    )
    .sort((a, b) => a.closesAt - b.closesAt)
    .forEach((p) =>
      asks.push({ kind: 'vote', pollId: p.id, closesAt: p.closesAt }),
    )
  for (const item of trip.items) {
    if (
      item.status !== 'open' ||
      item.detail.kind === 'activity' ||
      !hasMember(item, memberId)
    )
      continue
    const watch = trip.watches.find((w) => w.id === item.watchId)
    if (watch && watch.offers.length > 0)
      asks.push({ kind: 'choose', itemId: item.id })
  }
  trip.items
    .filter(
      (i) =>
        i.leadMemberId === memberId &&
        (i.status === 'chosen' || (i.status === 'open' && i.bookBy !== null)),
    )
    .sort((a, b) =>
      (a.bookBy ?? '9999-12-31').localeCompare(b.bookBy ?? '9999-12-31'),
    )
    .forEach((i) => asks.push({ kind: 'book', itemId: i.id, bookBy: i.bookBy }))
  return asks
}

export type TravelStatus =
  | 'not_coming'
  | 'no_destination'
  | 'not_needed'
  | 'none'
  | 'searching'
  | 'partial'
  | 'chosen'
  | 'booked'

export type MemberStatus = {
  vote: 'no_poll' | 'voted' | 'not_voted'
  flight: TravelStatus
  stay: TravelStatus
  /** How many things the trip is waiting on from this member. */
  asks: number
}

/** Where one member stands on every step, for the group checklist. */
export function memberStatus(trip: Trip, memberId: string): MemberStatus {
  const member = trip.members.find((m) => m.id === memberId)
  const poll = trip.polls.find((p) => p.status === 'open')
  const option = chosenOption(trip)
  const stayGap = option
    ? findGaps(trip, option).some(
        (g) => g.kind === 'no_stay' && g.memberIds.includes(memberId),
      )
    : false
  const travel = (kind: 'flight' | 'stay'): TravelStatus => {
    if (member?.rsvp === 'out') return 'not_coming'
    if (!option) return 'no_destination'
    if (kind === 'flight' && member?.home.kind === 'local') return 'not_needed'
    const items = trip.items.filter(
      (i) =>
        i.optionId === option.id &&
        isLive(i) &&
        i.detail.kind === kind &&
        hasMember(i, memberId),
    )
    if (items.length === 0) return 'none'
    if (kind === 'stay' && stayGap) return 'partial'
    if (items.every((i) => i.status === 'booked')) return 'booked'
    return items.some((i) => i.status !== 'open') ? 'chosen' : 'searching'
  }
  return {
    vote: !poll
      ? 'no_poll'
      : poll.votes.some((v) => v.memberId === memberId)
        ? 'voted'
        : 'not_voted',
    flight: travel('flight'),
    stay: travel('stay'),
    asks: nextAsks(trip, memberId).length,
  }
}

const INTEREST_WEIGHT: Record<Interest, number> = {
  reserve: 3,
  want: 2,
  like: 1,
}

/** 3 per reservation-needed, 2 per want, 1 per would-like. Ideas are ranked by it. */
export function interestScore(item: Item): number {
  return item.participants.reduce(
    (sum, p) => sum + (p.interest ? INTEREST_WEIGHT[p.interest] : 0),
    0,
  )
}

/** Who an activity is for, from who is on it. Members who might come count, so a maybe is not left out of a breakout. */
export function audience(
  trip: Trip,
  item: Item,
): 'group' | 'breakout' | 'solo' {
  const coming = trip.members
    .filter((m) => m.rsvp === 'in' || m.rsvp === 'maybe')
    .map((m) => m.id)
  const on = item.participants.filter((p) => coming.includes(p.memberId)).length
  if (on <= 1) return 'solo'
  return on >= coming.length ? 'group' : 'breakout'
}

export type Tally = {
  choiceId: string
  label: string
  optionId: string
  approvals: number
  favourites: number
}

/** Choices by approvals, then favourites, then their order in the poll. */
export function tally(poll: Poll): Tally[] {
  return poll.choices
    .map((choice, index) => ({
      index,
      choiceId: choice.id,
      label: choice.label,
      optionId: choice.optionId,
      approvals: poll.votes.filter((v) => v.choiceId === choice.id).length,
      favourites: poll.votes.filter(
        (v) => v.choiceId === choice.id && v.favourite,
      ).length,
    }))
    .sort(
      (a, b) =>
        b.approvals - a.approvals ||
        b.favourites - a.favourites ||
        a.index - b.index,
    )
    .map(({ index: _index, ...rest }) => rest)
}

export type Window = { start: string; end: string; memberIds: string[] }

/**
 * The date windows of a given length that suit the most members who have
 * answered, at most `limit` of them and none overlapping a better one.
 */
export function bestWindows(trip: Trip, nights: number, limit = 3): Window[] {
  const answering = trip.members.filter(
    (m) => m.rsvp !== 'out' && m.dates.length > 0,
  )
  const starts = [
    ...new Set(
      answering.flatMap((m) => m.dates.flatMap((r) => eachDay(r.start, r.end))),
    ),
  ].sort()
  const candidates = starts
    .map((start) => {
      const end = addDays(start, nights)
      const memberIds = answering
        .filter((m) => m.dates.some((r) => r.start <= start && r.end >= end))
        .map((m) => m.id)
      return { start, end, memberIds }
    })
    .filter((w) => w.memberIds.length > 0)
    .sort(
      (a, b) =>
        b.memberIds.length - a.memberIds.length ||
        a.start.localeCompare(b.start),
    )
  const picked: Window[] = []
  for (const candidate of candidates) {
    if (picked.length >= limit) break
    if (
      picked.some((w) => candidate.start <= w.end && candidate.end >= w.start)
    )
      continue
    picked.push(candidate)
  }
  return picked
}

/** How many answering members can be there on each day of a range. */
export function availabilityByDay(
  trip: Trip,
  start: string,
  end: string,
): { date: string; memberIds: string[] }[] {
  const answering = trip.members.filter(
    (m) => m.rsvp !== 'out' && m.dates.length > 0,
  )
  return eachDay(start, end).map((date) => ({
    date,
    memberIds: answering
      .filter((m) => m.dates.some((r) => r.start <= date && r.end >= date))
      .map((m) => m.id),
  }))
}

export type Arrival = {
  airport: string
  at: string
  itemIds: string[]
  memberIds: string[]
}

/** Landings for an option, with landings at one airport within an hour of each other grouped. */
export function arrivals(trip: Trip, option: TripOption): Arrival[] {
  const landings = trip.items
    .filter((i) => i.optionId === option.id && isLive(i))
    .flatMap((i) =>
      i.detail.kind === 'flight' && i.detail.offer
        ? [
            {
              itemId: i.id,
              airport: i.detail.offer.outbound.to,
              at: i.detail.offer.outbound.arrives,
              memberIds: i.participants.map((p) => p.memberId),
            },
          ]
        : [],
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const groups: (Arrival & { firstMs: number })[] = []
  for (const landing of landings) {
    const ms = Date.parse(landing.at)
    const group = groups.find(
      (g) => g.airport === landing.airport && ms - g.firstMs <= 3_600_000,
    )
    if (group) {
      group.itemIds.push(landing.itemId)
      group.memberIds.push(...landing.memberIds)
    } else {
      groups.push({
        airport: landing.airport,
        at: landing.at,
        firstMs: ms,
        itemIds: [landing.itemId],
        memberIds: [...landing.memberIds],
      })
    }
  }
  return groups.map(({ firstMs: _firstMs, ...rest }) => rest)
}

/** Append a check to a run-length-encoded series: an unchanged price extends the last run. */
export function recordObservation(
  series: Observation[],
  priceMinor: number | null,
  at: number,
): Observation[] {
  const last = series.at(-1)
  if (last && last.priceMinor === priceMinor)
    return [...series.slice(0, -1), { ...last, lastSeen: at }]
  return [...series, { firstSeen: at, lastSeen: at, priceMinor }]
}

export type WatchSignal =
  | 'drop_alert'
  | 'at_target'
  | 'down'
  | 'up'
  | 'steady'
  | 'sold_out'
  | 'unchecked'

export type WatchInsight = {
  watch: Watch
  items: Item[]
  primaryItem: Item | null
  unit: 'total' | 'nightly'
  series: Observation[]
  currentMinor: number | null
  firstMinor: number | null
  minMinor: number | null
  maxMinor: number | null
  deltaMinor: number | null
  deltaPct: number | null
  paidMinor: number | null
  comparableCurrentTotalMinor: number | null
  dropBelowPaidMinor: number
  targetMinor: number | null
  atTarget: boolean
  signal: WatchSignal
}

export type WatchReport = {
  entries: WatchInsight[]
  activeCount: number
  dropsCount: number
  targetsHitCount: number
  alertsCount: number
  potentialSavingsMinor: number
  bookedTotalMinor: number
  estimatedTotalMinor: number
}

const SIGNAL_RANK: Record<WatchSignal, number> = {
  drop_alert: 0,
  at_target: 1,
  down: 2,
  up: 3,
  steady: 4,
  sold_out: 5,
  unchecked: 6,
}

/** Live price intelligence across every slot-linked and standalone watch in a trip. */
export function watchReport(trip: Trip): WatchReport {
  const liveItems = trip.items.filter(isLive)
  const usedIds = new Set(
    liveItems.map((i) => i.watchId).filter((w): w is string => w !== null),
  )
  const active = trip.watches.filter(
    (w) => w.standalone === true || usedIds.has(w.id),
  )
  const entries: WatchInsight[] = active.map((watch) => {
    const items = liveItems.filter((i) => i.watchId === watch.id)
    const primaryItem =
      items.find((i) => i.status === 'booked' && matchKey(i) !== null) ??
      items.find((i) => i.status === 'chosen' && matchKey(i) !== null) ??
      items[0] ??
      null
    const key = primaryItem ? matchKey(primaryItem) : null
    const tracked = key ? watch.tracked[key] : undefined
    const series = tracked && tracked.length > 0 ? tracked : watch.cheapest
    const unit: 'total' | 'nightly' =
      watch.request.kind === 'hotels' ? 'nightly' : 'total'
    const priced = series.filter(
      (o): o is Observation & { priceMinor: number } => o.priceMinor !== null,
    )
    const currentMinor = latest(series)
    const firstMinor = priced[0]?.priceMinor ?? null
    const minMinor =
      priced.length > 0 ? Math.min(...priced.map((o) => o.priceMinor)) : null
    const maxMinor =
      priced.length > 0 ? Math.max(...priced.map((o) => o.priceMinor)) : null
    const deltaMinor =
      currentMinor !== null && firstMinor !== null
        ? currentMinor - firstMinor
        : null
    const deltaPct =
      deltaMinor !== null && firstMinor !== null && firstMinor > 0
        ? Math.round((deltaMinor / firstMinor) * 100)
        : null
    const paidMinor =
      primaryItem?.status === 'booked' ? primaryItem.paidMinor : null
    const comparableCurrentTotalMinor =
      currentMinor === null
        ? null
        : primaryItem?.detail.kind === 'stay' &&
            primaryItem.startDate &&
            primaryItem.endDate
          ? currentMinor *
            primaryItem.detail.rooms *
            nightsOf(primaryItem.startDate, primaryItem.endDate).length
          : watch.request.kind === 'hotels'
            ? currentMinor *
              watch.request.rooms *
              nightsOf(watch.request.checkin, watch.request.checkout).length
            : currentMinor
    const dropBelowPaidMinor =
      paidMinor !== null &&
      comparableCurrentTotalMinor !== null &&
      comparableCurrentTotalMinor < paidMinor
        ? paidMinor - comparableCurrentTotalMinor
        : 0
    const targetMinor = watch.targetMinor ?? null
    const atTarget =
      targetMinor !== null &&
      currentMinor !== null &&
      currentMinor <= targetMinor
    const signal: WatchSignal =
      watch.checkedAt === null
        ? 'unchecked'
        : currentMinor === null
          ? 'sold_out'
          : dropBelowPaidMinor > 0
            ? 'drop_alert'
            : atTarget
              ? 'at_target'
              : deltaMinor !== null && deltaMinor < 0
                ? 'down'
                : deltaMinor !== null && deltaMinor > 0
                  ? 'up'
                  : 'steady'
    return {
      watch,
      items,
      primaryItem,
      unit,
      series,
      currentMinor,
      firstMinor,
      minMinor,
      maxMinor,
      deltaMinor,
      deltaPct,
      paidMinor,
      comparableCurrentTotalMinor,
      dropBelowPaidMinor,
      targetMinor,
      atTarget,
      signal,
    }
  })
  entries.sort((a, b) => SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal])
  const option = chosenOption(trip)
  const planItems = option
    ? liveItems.filter((i) => i.optionId === option.id || i.optionId === null)
    : liveItems
  const bookedTotalMinor = planItems.reduce(
    (sum, i) =>
      sum + (i.status === 'booked' && i.paidMinor !== null ? i.paidMinor : 0),
    0,
  )
  const planEstimated = planItems.reduce(
    (sum, i) => sum + (itemCost(trip, i) ?? 0),
    0,
  )
  const standaloneEstimated = entries
    .filter((e) => e.items.length === 0)
    .reduce((sum, e) => sum + (e.comparableCurrentTotalMinor ?? 0), 0)
  return {
    entries,
    activeCount: entries.length,
    dropsCount: entries.filter((e) => e.dropBelowPaidMinor > 0).length,
    targetsHitCount: entries.filter((e) => e.atTarget).length,
    alertsCount: entries.filter(
      (e) => e.signal === 'drop_alert' || e.signal === 'at_target',
    ).length,
    potentialSavingsMinor: entries.reduce(
      (sum, e) => sum + e.dropBelowPaidMinor,
      0,
    ),
    bookedTotalMinor,
    estimatedTotalMinor:
      planEstimated > 0 ? planEstimated : standaloneEstimated,
  }
}

export type TripSignal =
  | { kind: 'ask'; ask: Ask }
  | {
      kind: 'price_drop'
      watchId: string
      label: string
      savingsMinor: number
      paidMinor: number
      nowTotalMinor: number
      soldBy: string
    }
  | {
      kind: 'target_hit'
      watchId: string
      label: string
      currentMinor: number
      targetMinor: number
      unit: 'total' | 'nightly'
    }
  | { kind: 'issue'; issue: Issue }
  | { kind: 'gaps'; count: number }
  | { kind: 'price_shortlist'; unpricedCount: number }
  | {
      kind: 'lock_poll'
      pollId: string
      choiceId: string
      leaderLabel: string
      approvals: number
      waitingCount: number
    }
  | { kind: 'waiting_group'; count: number }

/**
 * Prioritized operational signals across the whole trip for one viewer: their
 * own asks, active price drops, plan conflicts, unfilled travel gaps, target
 * hits, and organizer actions (pricing, locking a vote, nudging the group).
 */
export function tripSignals(trip: Trip, memberId: string): TripSignal[] {
  const out: TripSignal[] = []
  const member = trip.members.find((m) => m.id === memberId)
  for (const ask of nextAsks(trip, memberId)) {
    out.push({ kind: 'ask', ask })
  }
  const report = watchReport(trip)
  for (const entry of report.entries) {
    if (
      entry.dropBelowPaidMinor > 0 &&
      entry.paidMinor !== null &&
      entry.comparableCurrentTotalMinor !== null
    ) {
      out.push({
        kind: 'price_drop',
        watchId: entry.watch.id,
        label: entry.primaryItem?.title ?? entry.watch.label,
        savingsMinor: entry.dropBelowPaidMinor,
        paidMinor: entry.paidMinor,
        nowTotalMinor: entry.comparableCurrentTotalMinor,
        soldBy: entry.primaryItem?.booking?.soldBy ?? 'provider',
      })
    }
  }
  const option = chosenOption(trip)
  if (option) {
    for (const issue of findIssues(trip, option)) {
      out.push({ kind: 'issue', issue })
    }
    const gaps = findGaps(trip, option)
    if (gaps.length > 0) out.push({ kind: 'gaps', count: gaps.length })
  }
  for (const entry of report.entries) {
    if (
      entry.atTarget &&
      entry.dropBelowPaidMinor === 0 &&
      entry.currentMinor !== null &&
      entry.targetMinor !== null
    ) {
      out.push({
        kind: 'target_hit',
        watchId: entry.watch.id,
        label: entry.watch.label,
        currentMinor: entry.currentMinor,
        targetMinor: entry.targetMinor,
        unit: entry.unit,
      })
    }
  }
  const poll = trip.polls.find((p) => p.status === 'open')
  if (member?.role === 'owner' && !option) {
    const unpriced = trip.options.filter(
      (o) => o.status === 'candidate' && o.pricing === null,
    ).length
    if (unpriced > 0)
      out.push({ kind: 'price_shortlist', unpricedCount: unpriced })
    if (poll) {
      const leader = tally(poll)[0]
      const waitingCount = trip.members.filter(
        (m) => m.rsvp !== 'out' && !poll.votes.some((v) => v.memberId === m.id),
      ).length
      if (leader && leader.approvals > 0) {
        out.push({
          kind: 'lock_poll',
          pollId: poll.id,
          choiceId: leader.choiceId,
          leaderLabel: leader.label,
          approvals: leader.approvals,
          waitingCount,
        })
      }
    }
  }
  const waitingOthers = trip.members.filter(
    (m) => m.id !== memberId && nextAsks(trip, m.id).length > 0,
  ).length
  if (waitingOthers > 0)
    out.push({ kind: 'waiting_group', count: waitingOthers })
  return out
}
