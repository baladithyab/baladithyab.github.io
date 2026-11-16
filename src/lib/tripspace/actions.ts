/**
 * Every change to a trip, as a pure function from one trip to the next. The
 * page applies them and persists the result; tests call them directly.
 */
import { addDays, formatRange } from './dates'
import {
  chosenOption,
  presence,
  heads,
  recordObservation,
  type Booking,
  type Decision,
  type Gap,
  type Interest,
  type Item,
  type Member,
  type Poll,
  type Pricing,
  type Trip,
  type TripOption,
  type Watch,
} from './model'
import { searchKey, type FlightOffer, type HotelOffer, type SearchRequest, type SearchResponse } from './search'

export type NewId = () => string

export function createTrip({ title, ownerName, newId, now }: { title: string; ownerName: string; newId: NewId; now: number }): Trip {
  return {
    id: newId(),
    title,
    createdAt: now,
    members: [
      {
        id: newId(),
        name: ownerName,
        role: 'owner',
        rsvp: 'in',
        dates: [],
        budgetBand: null,
        home: { kind: 'unanswered' },
        party: { adults: 1, children: 0 },
      },
    ],
    options: [],
    items: [],
    polls: [],
    decisions: [],
    watches: [],
  }
}

export function addMember(trip: Trip, { name, newId }: { name: string; newId: NewId }): Trip {
  const member: Member = {
    id: newId(),
    name,
    role: 'member',
    rsvp: 'invited',
    dates: [],
    budgetBand: null,
    home: { kind: 'unanswered' },
    party: { adults: 1, children: 0 },
  }
  return { ...trip, members: [...trip.members, member] }
}

export function updateMember(trip: Trip, memberId: string, patch: Partial<Omit<Member, 'id' | 'role'>>): Trip {
  return { ...trip, members: trip.members.map((m) => (m.id === memberId ? { ...m, ...patch } : m)) }
}

/** Remove a member and every trace of them: participations, votes and the reservations they led. */
export function removeMember(trip: Trip, memberId: string): Trip {
  return {
    ...trip,
    members: trip.members.filter((m) => m.id !== memberId),
    items: trip.items.map((i) => ({
      ...i,
      participants: i.participants.filter((p) => p.memberId !== memberId),
      leadMemberId: i.leadMemberId === memberId ? null : i.leadMemberId,
    })),
    polls: trip.polls.map((p) => ({ ...p, votes: p.votes.filter((v) => v.memberId !== memberId) })),
  }
}

export function addOption(
  trip: Trip,
  option: Pick<TripOption, 'label' | 'destination' | 'city' | 'depart' | 'return'>,
  newId: NewId,
): Trip {
  return { ...trip, options: [...trip.options, { ...option, id: newId(), status: 'candidate', pricing: null }] }
}

export function removeOption(trip: Trip, optionId: string): Trip {
  return {
    ...trip,
    options: trip.options.filter((o) => o.id !== optionId),
    items: trip.items.filter((i) => i.optionId !== optionId),
    polls: trip.polls.map((p) =>
      p.status === 'open' && p.choices.some((c) => c.optionId === optionId) ? { ...p, status: 'cancelled' } : p,
    ),
  }
}

export function setPricing(trip: Trip, optionId: string, pricing: Pricing): Trip {
  return { ...trip, options: trip.options.map((o) => (o.id === optionId ? { ...o, pricing } : o)) }
}

/** The searches that price an option: one flight search per distinct set of home airports, and one stay search. */
export function pricingRequests(trip: Trip, option: TripOption): { flights: { from: string[]; memberIds: string[]; request: SearchRequest }[]; stay: { rooms: number; request: SearchRequest } } {
  const byHome = new Map<string, { from: string[]; memberIds: string[] }>()
  const coming = trip.members.filter((m) => m.rsvp === 'in' || m.rsvp === 'maybe')
  for (const member of coming) {
    if (member.home.kind !== 'airports') continue
    const from = [...member.home.codes].sort()
    const group = byHome.get(from.join('+'))
    if (group) group.memberIds.push(member.id)
    else byHome.set(from.join('+'), { from, memberIds: [member.id] })
  }
  const people = new Map(trip.members.map((m) => [m.id, m.party]))
  const flights = [...byHome.values()].map(({ from, memberIds }) => {
    const adults = memberIds.reduce((sum, m) => sum + (people.get(m)?.adults ?? 1), 0)
    const children = memberIds.reduce((sum, m) => sum + (people.get(m)?.children ?? 0), 0)
    return {
      from,
      memberIds,
      request: { kind: 'flights' as const, from, to: [option.destination], depart: option.depart, return: option.return, adults: Math.min(adults, 9), children: Math.min(children, 8) },
    }
  })
  const staying = trip.members.filter((m) => m.rsvp === 'in').reduce((sum, m) => sum + heads(m.party), 0)
  // Priced as rooms for two, the most common way a group splits a stay.
  const rooms = Math.min(9, Math.max(1, Math.ceil(staying / 2)))
  return {
    flights,
    stay: { rooms, request: { kind: 'hotels', city: option.city, checkin: option.depart, checkout: option.return, adults: 2, rooms: 1 } },
  }
}

export function openPoll(
  trip: Trip,
  { question, optionIds, closesAt, newId }: { question: string; optionIds: string[]; closesAt: number; newId: NewId },
): Trip {
  const choices = trip.options
    .filter((o) => optionIds.includes(o.id))
    .map((o) => ({ id: newId(), label: `${o.label}, ${formatRange(o.depart, o.return)}`, optionId: o.id }))
  if (choices.length < 2) return trip
  const poll: Poll = { id: newId(), question, choices, votes: [], closesAt, status: 'open' }
  return { ...trip, polls: [...trip.polls, poll] }
}

/** Replace one member's votes in a poll: any number of approvals, at most one favourite among them. */
export function setVotes(trip: Trip, pollId: string, memberId: string, approvals: string[], favourite: string | null): Trip {
  return {
    ...trip,
    polls: trip.polls.map((p) => {
      if (p.id !== pollId || p.status !== 'open') return p
      const valid = approvals.filter((c) => p.choices.some((choice) => choice.id === c))
      const fav = favourite !== null && valid.includes(favourite) ? favourite : null
      return {
        ...p,
        votes: [...p.votes.filter((v) => v.memberId !== memberId), ...valid.map((choiceId) => ({ choiceId, memberId, favourite: choiceId === fav }))],
      }
    }),
  }
}

/**
 * Lock a poll's result: the chosen option wins, the others in the poll are
 * rejected, and the decision log gains a line that replaces any earlier
 * choice of option.
 */
export function lockPoll(trip: Trip, { pollId, choiceId, by, now, newId }: { pollId: string; choiceId: string; by: string; now: number; newId: NewId }): Trip {
  const poll = trip.polls.find((p) => p.id === pollId)
  const choice = poll?.choices.find((c) => c.id === choiceId)
  if (!poll || !choice || poll.status !== 'open') return trip
  const approvals = poll.votes.filter((v) => v.choiceId === choiceId).length
  const voters = new Set(poll.votes.map((v) => v.memberId)).size
  const previous = [...trip.decisions].reverse().find((d) => d.optionId !== null)
  const decision: Decision = {
    id: newId(),
    summary: `${choice.label}. Approved by ${approvals} of ${voters} who voted.`,
    at: now,
    by,
    pollId,
    optionId: choice.optionId,
    replacesId: previous?.id ?? null,
  }
  const inPoll = new Set(poll.choices.map((c) => c.optionId))
  return {
    ...trip,
    polls: trip.polls.map((p) => (p.id === pollId ? { ...p, status: 'decided' } : p)),
    options: trip.options.map((o) => {
      if (o.id === choice.optionId) return { ...o, status: 'chosen' }
      if (inPoll.has(o.id) || o.status === 'chosen') return { ...o, status: 'rejected' }
      return o
    }),
    decisions: [...trip.decisions, decision],
  }
}

export function addDecision(trip: Trip, { summary, by, now, newId }: { summary: string; by: string; now: number; newId: NewId }): Trip {
  return { ...trip, decisions: [...trip.decisions, { id: newId(), summary, at: now, by, pollId: null, optionId: null, replacesId: null }] }
}

function gapRequest(trip: Trip, gap: Gap): SearchRequest {
  const parties = trip.members.filter((m) => gap.memberIds.includes(m.id)).map((m) => m.party)
  const adults = parties.reduce((sum, p) => sum + p.adults, 0)
  const children = parties.reduce((sum, p) => sum + p.children, 0)
  if (gap.kind === 'no_flight') {
    return { kind: 'flights', from: gap.from, to: gap.to, depart: gap.depart, return: gap.return, adults: Math.min(adults, 9), children: Math.min(children, 8) }
  }
  const people = adults + children
  return { kind: 'hotels', city: gap.city, checkin: gap.checkin, checkout: gap.checkout, adults: Math.min(people, 10), rooms: Math.min(9, Math.max(1, Math.ceil(people / 2))) }
}

function emptyWatch(id: string, label: string, request: SearchRequest): Watch {
  return { id, label, request, cheapest: [], tracked: {}, offers: [], searchUrl: null, checkedAt: null, error: null }
}

/**
 * Turn confirmed gaps into open slots, each with a search watch. Two slots
 * with the same search share one watch. Existing items are never touched.
 */
export function applyGaps(trip: Trip, option: TripOption, gaps: Gap[], newId: NewId): { trip: Trip; watchIds: string[] } {
  const names = new Map(trip.members.map((m) => [m.id, m.name]))
  let watches = trip.watches
  const items: Item[] = []
  const watchIds: string[] = []
  for (const gap of gaps) {
    const request = gapRequest(trip, gap)
    const who = gap.memberIds.map((m) => names.get(m) ?? 'someone').join(', ')
    const title = gap.kind === 'no_flight' ? `Flight ${gap.from.join('/')} to ${gap.to.join('/')} for ${who}` : `Stay in ${gap.city} for ${who}`
    let watch = watches.find((w) => searchKey(w.request) === searchKey(request))
    if (!watch) {
      watch = emptyWatch(newId(), title, request)
      watches = [...watches, watch]
    }
    watchIds.push(watch.id)
    items.push({
      id: newId(),
      optionId: option.id,
      status: 'open',
      title,
      startDate: gap.kind === 'no_flight' ? gap.depart : gap.checkin,
      endDate: gap.kind === 'no_flight' ? gap.return : gap.checkout,
      detail:
        gap.kind === 'no_flight'
          ? { kind: 'flight', from: gap.from, to: gap.to, depart: gap.depart, return: gap.return, offer: null }
          : { kind: 'stay', city: gap.city, rooms: request.kind === 'hotels' ? request.rooms : 1, hotel: null },
      participants: gap.memberIds.map((memberId) => ({ memberId, interest: null, fromDate: null, toDate: null, shareMinor: null })),
      quotedMinor: null,
      paidMinor: null,
      bookBy: null,
      leadMemberId: null,
      booking: null,
      watchId: watch.id,
    })
  }
  return { trip: { ...trip, items: [...trip.items, ...items], watches }, watchIds: [...new Set(watchIds)] }
}

/**
 * Size a stay to when its people are there. Each participant's part becomes
 * the nights from their arrival to their departure, inside the stay. A stay
 * with no hotel chosen yet also shrinks to those nights and gets a search for
 * the new dates; a chosen hotel keeps its dates.
 */
export function fitStayToArrivals(trip: Trip, itemId: string, newId: NewId): { trip: Trip; watch: Watch | null } {
  const item = trip.items.find((i) => i.id === itemId)
  const option = trip.options.find((o) => o.id === item?.optionId)
  if (!item || !option || item.detail.kind !== 'stay' || item.startDate === null || item.endDate === null) return { trip, watch: null }
  const { startDate: start, endDate: end } = item
  const fits = new Map(
    item.participants.map((p) => {
      const { arrive, leave } = presence(trip, option, p.memberId)
      return [p.memberId, { from: arrive > start ? arrive : start, to: leave < end ? leave : end }]
    }),
  )
  const present = [...fits.values()].filter((f) => f.to > f.from)
  if (present.length === 0) return { trip, watch: null }
  const reopen = item.status === 'open'
  const newStart = reopen ? (present.map((f) => f.from).sort()[0] ?? start) : start
  const newEnd = reopen ? (present.map((f) => f.to).sort().at(-1) ?? end) : end
  const participants = item.participants.map((p) => {
    const fit = fits.get(p.memberId)
    if (!fit || fit.to <= fit.from) return p
    return { ...p, fromDate: fit.from === newStart ? null : fit.from, toDate: fit.to === newEnd ? null : fit.to }
  })

  let watches = trip.watches
  let watch: Watch | null = null
  let watchId = item.watchId
  const old = trip.watches.find((w) => w.id === item.watchId)
  if (reopen && (newStart !== start || newEnd !== end) && old?.request.kind === 'hotels') {
    const request: SearchRequest = { ...old.request, checkin: newStart, checkout: newEnd }
    watch = trip.watches.find((w) => searchKey(w.request) === searchKey(request)) ?? emptyWatch(newId(), old.label, request)
    if (!trip.watches.some((w) => w.id === watch?.id)) watches = [...watches, watch]
    watchId = watch.id
  }
  return {
    trip: { ...trip, watches, items: trip.items.map((i) => (i.id === itemId ? { ...i, startDate: newStart, endDate: newEnd, participants, watchId } : i)) },
    watch,
  }
}

/** Record one search on its watch: the offers, the cheapest price, and the price of every tracked offer. */
export function recordSearch(trip: Trip, watchId: string, response: SearchResponse, now: number): Trip {
  return {
    ...trip,
    watches: trip.watches.map((w) => {
      if (w.id !== watchId) return w
      if (!response.ok) return { ...w, checkedAt: now, error: response.message }
      const prices = response.offers.map((o) => (o.kind === 'hotel' ? o.nightlyMinor : o.priceMinor))
      const cheapest = prices.length > 0 ? Math.min(...prices) : null
      const tracked = Object.fromEntries(
        Object.entries(w.tracked).map(([key, series]) => {
          const offer = response.offers.find((o) => o.key === key)
          const price = offer ? (offer.kind === 'hotel' ? offer.nightlyMinor : offer.priceMinor) : null
          return [key, recordObservation(series, price, now)]
        }),
      )
      return {
        ...w,
        offers: response.offers,
        searchUrl: response.searchUrl,
        checkedAt: now,
        error: null,
        cheapest: recordObservation(w.cheapest, cheapest, now),
        tracked,
      }
    }),
  }
}

/** Fill a slot from one offer of its search. The chooser leads the booking unless someone already does. */
export function chooseOffer(trip: Trip, itemId: string, offer: FlightOffer | HotelOffer, { by, now }: { by: string; now: number }): Trip {
  const item = trip.items.find((i) => i.id === itemId)
  if (!item) return trip
  const price = offer.kind === 'hotel' ? offer.nightlyMinor : offer.priceMinor
  const detail =
    item.detail.kind === 'flight' && offer.kind === 'flight'
      ? { ...item.detail, offer }
      : item.detail.kind === 'stay' && offer.kind === 'hotel'
        ? { ...item.detail, hotel: offer }
        : null
  if (!detail) return trip
  const title = offer.kind === 'flight' ? `${offer.outbound.airlines}, ${offer.outbound.from} to ${offer.outbound.to}` : offer.name
  return {
    ...trip,
    items: trip.items.map((i) => (i.id === itemId ? { ...i, detail, title, status: 'chosen', leadMemberId: i.leadMemberId ?? by } : i)),
    watches: trip.watches.map((w) =>
      w.id === item.watchId && !(offer.key in w.tracked) ? { ...w, tracked: { ...w.tracked, [offer.key]: recordObservation([], price, now) } } : w,
    ),
  }
}

export function markBooked(trip: Trip, itemId: string, { paidMinor, booking }: { paidMinor: number; booking: Booking }): Trip {
  return { ...trip, items: trip.items.map((i) => (i.id === itemId && i.status === 'chosen' ? { ...i, status: 'booked', paidMinor, booking } : i)) }
}

export function setItemStatus(trip: Trip, itemId: string, status: 'dropped' | 'open'): Trip {
  return {
    ...trip,
    items: trip.items.map((i) => {
      if (i.id !== itemId) return i
      if (status === 'dropped') return { ...i, status }
      // Reopening clears the choice so the slot searches again.
      const detail = i.detail.kind === 'flight' ? { ...i.detail, offer: null } : i.detail.kind === 'stay' ? { ...i.detail, hotel: null } : i.detail
      return { ...i, status, detail, paidMinor: null, booking: null }
    }),
  }
}

export function addIdea(
  trip: Trip,
  { title, link, place, interest, by, newId }: { title: string; link: string | null; place: string | null; interest: Interest; by: string; newId: NewId },
): Trip {
  const idea: Item = {
    id: newId(),
    optionId: null,
    status: 'open',
    title,
    startDate: null,
    endDate: null,
    detail: { kind: 'activity', place, time: null, link },
    participants: [{ memberId: by, interest, fromDate: null, toDate: null, shareMinor: null }],
    quotedMinor: null,
    paidMinor: null,
    bookBy: null,
    leadMemberId: null,
    booking: null,
    watchId: null,
  }
  return { ...trip, items: [...trip.items, idea] }
}

/** Put one member's own bucket on an activity, or take them off it. */
export function setInterest(trip: Trip, itemId: string, memberId: string, interest: Interest | null): Trip {
  return {
    ...trip,
    items: trip.items.map((i) => {
      if (i.id !== itemId) return i
      const others = i.participants.filter((p) => p.memberId !== memberId)
      if (interest === null) return { ...i, participants: others, leadMemberId: i.leadMemberId === memberId ? null : i.leadMemberId }
      const mine = i.participants.find((p) => p.memberId === memberId)
      return { ...i, participants: [...others, { memberId, interest, fromDate: mine?.fromDate ?? null, toDate: mine?.toDate ?? null, shareMinor: mine?.shareMinor ?? null }] }
    }),
  }
}

/** Put an idea on a day of the chosen option. Its participants are the members interested in it. */
export function scheduleIdea(trip: Trip, itemId: string, { date, time }: { date: string; time: string | null }): Trip {
  const option = chosenOption(trip)
  if (!option || date < option.depart || date > option.return) return trip
  return {
    ...trip,
    items: trip.items.map((i) =>
      i.id === itemId && i.detail.kind === 'activity'
        ? { ...i, optionId: option.id, startDate: date, endDate: date, status: 'chosen', detail: { ...i.detail, time } }
        : i,
    ),
  }
}

export function unscheduleIdea(trip: Trip, itemId: string): Trip {
  return {
    ...trip,
    items: trip.items.map((i) =>
      i.id === itemId && i.detail.kind === 'activity' && i.status !== 'booked'
        ? { ...i, optionId: null, startDate: null, endDate: null, status: 'open', detail: { ...i.detail, time: null } }
        : i,
    ),
  }
}

export function setReservation(trip: Trip, itemId: string, { bookBy, leadMemberId, quotedMinor }: { bookBy: string | null; leadMemberId: string | null; quotedMinor: number | null }): Trip {
  return { ...trip, items: trip.items.map((i) => (i.id === itemId ? { ...i, bookBy, leadMemberId, quotedMinor } : i)) }
}

/** The ideas board: activities not dropped, with the members who care about each. */
export function ideasOf(trip: Trip): Item[] {
  return trip.items.filter((i) => i.detail.kind === 'activity' && i.status !== 'dropped')
}

/** The default closing time for a new poll: three days out, at the end of that day UTC. */
export function defaultCloseTime(now: number): number {
  const day = new Date(now).toISOString().slice(0, 10)
  return Date.parse(`${addDays(day, 3)}T23:59:00Z`)
}
