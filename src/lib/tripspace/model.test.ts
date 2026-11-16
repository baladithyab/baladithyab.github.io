import { describe, expect, it } from 'vitest'

import {
  addIdea,
  addMember,
  addOption,
  applyGaps,
  chooseOffer,
  createTrip,
  fitStayToArrivals,
  lockPoll,
  openPoll,
  recordSearch,
  scheduleIdea,
  setVotes,
  updateMember,
} from './actions'
import {
  arrivals,
  bestWindows,
  costByMember,
  findGaps,
  findIssues,
  nextAsks,
  splitByWeight,
  stageOf,
  tripSchema,
  type Trip,
} from './model'
import type { FlightOffer, HotelOffer } from './search'

function ids() {
  let n = 0
  return () => `id${++n}`
}

const NOW = Date.parse('2026-11-16T12:00:00Z')

/** Owner Maya (SFO), Priya (SFO), Sam (ORD), Lou (local); Lisbon 10 to 17 May chosen. */
function lisbonTrip(): { trip: Trip; newId: () => string; m: Record<'maya' | 'priya' | 'sam' | 'lou', string>; optionId: string } {
  const newId = ids()
  let trip = createTrip({ title: 'Lisbon', ownerName: 'Maya', newId, now: NOW })
  for (const name of ['Priya', 'Sam', 'Lou']) trip = addMember(trip, { name, newId })
  const [maya, priya, sam, lou] = trip.members.map((x) => x.id) as [string, string, string, string]
  trip = updateMember(trip, maya, { home: { kind: 'airports', codes: ['SFO'] }, dates: [{ start: '2027-05-05', end: '2027-05-20' }] })
  trip = updateMember(trip, priya, { rsvp: 'in', home: { kind: 'airports', codes: ['SFO'] }, dates: [{ start: '2027-05-09', end: '2027-05-18' }] })
  trip = updateMember(trip, sam, { rsvp: 'in', home: { kind: 'airports', codes: ['ORD'] }, dates: [{ start: '2027-05-10', end: '2027-05-25' }] })
  trip = updateMember(trip, lou, { rsvp: 'in', home: { kind: 'local' }, dates: [{ start: '2027-05-01', end: '2027-05-31' }] })
  trip = addOption(trip, { label: 'Lisbon', destination: 'LIS', city: 'Lisbon', depart: '2027-05-10', return: '2027-05-17' }, newId)
  trip = addOption(trip, { label: 'Porto', destination: 'OPO', city: 'Porto', depart: '2027-05-10', return: '2027-05-17' }, newId)
  const [lisbon, porto] = trip.options.map((o) => o.id) as [string, string]
  trip = openPoll(trip, { question: 'Where?', optionIds: [lisbon, porto], closesAt: NOW + 86_400_000, newId })
  const poll = trip.polls[0]
  const lisbonChoice = poll?.choices.find((c) => c.optionId === lisbon)?.id ?? ''
  trip = setVotes(trip, poll?.id ?? '', maya, [lisbonChoice], lisbonChoice)
  trip = lockPoll(trip, { pollId: poll?.id ?? '', choiceId: lisbonChoice, by: maya, now: NOW, newId })
  return { trip, newId, m: { maya, priya, sam, lou }, optionId: lisbon }
}

const flight = (key: string, price: number, arrives: string, departsBack: string): FlightOffer => ({
  kind: 'flight',
  key,
  priceMinor: price,
  outbound: { from: 'SFO', to: 'LIS', departs: '2027-05-10T16:35:00-07:00', arrives, stops: 1, airlines: 'TAP', duration: '15h' },
  inbound: { from: 'LIS', to: 'SFO', departs: departsBack, arrives: '2027-05-17T20:00:00-07:00', stops: 1, airlines: 'TAP', duration: '15h' },
  tags: [],
  link: 'https://skiplagged.com/x',
})

const hotel = (key: string, nightly: number): HotelOffer => ({ kind: 'hotel', key, name: 'Casa', stars: 3, nightlyMinor: nightly, location: null, link: 'https://skiplagged.com/h' })

describe('splitByWeight', () => {
  it('sums exactly and gives remainders to the largest fractions', () => {
    expect(splitByWeight(1000, [1, 1, 1])).toEqual([334, 333, 333])
    expect(splitByWeight(101, [2, 1])).toEqual([67, 34])
    expect(splitByWeight(500, [0, 0])).toEqual([0, 0])
  })
})

describe('findGaps', () => {
  it('shares one flight gap per set of home airports and asks nothing of a local member', () => {
    const { trip, m, optionId } = lisbonTrip()
    const option = trip.options.find((o) => o.id === optionId)!
    const flights = findGaps(trip, option).filter((g) => g.kind === 'no_flight')
    expect(flights).toHaveLength(2)
    expect(flights.find((g) => g.from[0] === 'SFO')?.memberIds.sort()).toEqual([m.maya, m.priya].sort())
    expect(flights.some((g) => g.memberIds.includes(m.lou))).toBe(false)
  })

  it('starts a stay gap the night a chosen flight lands, not the night it leaves', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    const { trip: slotted } = applyGaps(base, option, findGaps(base, option).filter((g) => g.kind === 'no_flight'), newId)
    const sfoSlot = slotted.items.find((i) => i.detail.kind === 'flight' && i.participants.some((p) => p.memberId === m.maya))!
    const trip = chooseOffer(slotted, sfoSlot.id, flight('TP1-TP2', 180000, '2027-05-11T09:00:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.maya, now: NOW })
    const stay = findGaps(trip, option).find((g) => g.kind === 'no_stay' && g.memberIds.includes(m.maya))
    expect(stay).toMatchObject({ checkin: '2027-05-11', checkout: '2027-05-17' })
    // Sam has no flight yet, so his stay need is the option's dates.
    const sams = findGaps(trip, option).find((g) => g.kind === 'no_stay' && g.memberIds.includes(m.sam))
    expect(sams).toMatchObject({ checkin: '2027-05-10', checkout: '2027-05-17' })
  })

  it('leaves only the uncovered nights of someone who joins a shared stay late', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    const stayGaps = findGaps(base, option).filter((g) => g.kind === 'no_stay')
    const { trip: slotted } = applyGaps(base, option, stayGaps, newId)
    const stay = slotted.items.find((i) => i.detail.kind === 'stay')!
    const trip: Trip = {
      ...slotted,
      items: slotted.items.map((i) =>
        i.id === stay.id ? { ...i, participants: i.participants.map((p) => (p.memberId === m.sam ? { ...p, fromDate: '2027-05-12' } : p)) } : i,
      ),
    }
    const left = findGaps(trip, option).filter((g) => g.kind === 'no_stay')
    expect(left).toEqual([{ kind: 'no_stay', memberIds: [m.sam], city: 'Lisbon', checkin: '2027-05-10', checkout: '2027-05-12' }])
  })
})

describe('findIssues', () => {
  it('flags an activity before someone arrives, a booking added twice, and a reservation nobody leads', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    const { trip: slotted } = applyGaps(base, option, findGaps(base, option).filter((g) => g.kind === 'no_flight'), newId)
    const sfo = slotted.items.find((i) => i.detail.kind === 'flight' && i.participants.some((p) => p.memberId === m.maya))!
    let trip = chooseOffer(slotted, sfo.id, flight('TP1-TP2', 180000, '2027-05-11T09:00:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.maya, now: NOW })
    trip = addIdea(trip, { title: 'Fado', link: null, place: null, interest: 'reserve', by: m.maya, newId })
    const fado = trip.items.at(-1)!
    trip = scheduleIdea(trip, fado.id, { date: '2027-05-10', time: '20:00' })
    trip = { ...trip, items: trip.items.map((i) => (i.id === fado.id ? { ...i, bookBy: '2027-04-20' } : i)) }
    const ord = trip.items.find((i) => i.detail.kind === 'flight' && i.participants.some((p) => p.memberId === m.sam))!
    trip = chooseOffer(trip, ord.id, flight('TP1-TP2', 90000, '2027-05-11T09:00:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.sam, now: NOW })

    const kinds = findIssues(trip, option).map((i) => i.kind).sort()
    expect(kinds).toEqual(['added_twice', 'no_one_booking', 'not_there'])
  })
})

describe('nextAsks', () => {
  it('asks a new member for their answers first, then their vote', () => {
    const newId = ids()
    let trip = createTrip({ title: 'T', ownerName: 'Maya', newId, now: NOW })
    trip = addMember(trip, { name: 'Mei', newId })
    trip = addOption(trip, { label: 'A', destination: 'LIS', city: 'Lisbon', depart: '2027-05-10', return: '2027-05-17' }, newId)
    trip = addOption(trip, { label: 'B', destination: 'OPO', city: 'Porto', depart: '2027-05-10', return: '2027-05-17' }, newId)
    trip = openPoll(trip, { question: 'Where?', optionIds: trip.options.map((o) => o.id), closesAt: NOW, newId })
    const mei = trip.members[1]!.id
    expect(nextAsks(trip, mei).map((a) => a.kind)).toEqual(['rsvp', 'dates', 'home', 'vote'])
    const poll = trip.polls[0]!
    trip = setVotes(trip, poll.id, mei, [poll.choices[0]!.id], null)
    expect(nextAsks(trip, mei).map((a) => a.kind)).toEqual(['rsvp', 'dates', 'home'])
    trip = updateMember(trip, mei, { rsvp: 'out' })
    expect(nextAsks(trip, mei)).toEqual([])
  })
})

describe('lockPoll', () => {
  it('chooses the option, rejects the others and moves the trip to planning', () => {
    const { trip, optionId } = lisbonTrip()
    expect(trip.options.map((o) => [o.id === optionId, o.status])).toEqual([
      [true, 'chosen'],
      [false, 'rejected'],
    ])
    expect(stageOf(trip)).toBe('plan')
    expect(trip.decisions.at(-1)?.summary).toMatch(/^Lisbon, 10 to 17 May\. Approved by 1 of 1/)
  })
})

describe('fitStayToArrivals', () => {
  it('shrinks an unchosen stay to when people land and gives a late arrival their own nights', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    let { trip } = applyGaps(base, option, findGaps(base, option), newId)
    const slot = (memberId: string) => trip.items.find((i) => i.detail.kind === 'flight' && i.participants.some((p) => p.memberId === memberId))!
    trip = chooseOffer(trip, slot(m.maya).id, flight('SFO1', 1, '2027-05-11T09:00:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.maya, now: NOW })
    trip = chooseOffer(trip, slot(m.sam).id, flight('ORD1', 1, '2027-05-12T18:25:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.sam, now: NOW })
    const stay = trip.items.find((i) => i.detail.kind === 'stay')!
    expect(findIssues(trip, option).filter((i) => i.kind === 'unused_nights').map((i) => i.kind === 'unused_nights' && i.memberId).sort()).toEqual(
      [m.maya, m.priya, m.sam].sort(),
    )

    const { trip: fitted, watch } = fitStayToArrivals(trip, stay.id, newId)
    const after = fitted.items.find((i) => i.id === stay.id)!
    // Lou is local, so the stay still starts the day the option does.
    expect([after.startDate, after.endDate]).toEqual(['2027-05-10', '2027-05-17'])
    expect(after.participants.find((p) => p.memberId === m.sam)).toMatchObject({ fromDate: '2027-05-12', toDate: null })
    expect(after.participants.find((p) => p.memberId === m.maya)).toMatchObject({ fromDate: '2027-05-11' })
    expect(watch).toBeNull()
    expect(findIssues(fitted, option).some((i) => i.kind === 'unused_nights')).toBe(false)

    const withoutLou = { ...trip, items: trip.items.map((i) => (i.id === stay.id ? { ...i, participants: i.participants.filter((p) => p.memberId !== m.lou) } : i)) }
    const { trip: shrunk, watch: search } = fitStayToArrivals(withoutLou, stay.id, newId)
    expect(shrunk.items.find((i) => i.id === stay.id)).toMatchObject({ startDate: '2027-05-11', endDate: '2027-05-17', watchId: search?.id })
    expect(search?.request).toMatchObject({ kind: 'hotels', checkin: '2027-05-11', checkout: '2027-05-17' })
  })
})

describe('recordSearch', () => {
  it('extends an unchanged price and records a chosen offer that disappears as nothing found', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    const { trip: slotted, watchIds } = applyGaps(base, option, findGaps(base, option).filter((g) => g.kind === 'no_stay'), newId)
    const watchId = watchIds[0]!
    const offers = [hotel('h1', 9000), hotel('h2', 12000)]
    let trip = recordSearch(slotted, watchId, { ok: true, provider: 'skiplagged', offers, searchUrl: null, fetchedAt: 1 }, 1)
    const stay = trip.items.find((i) => i.watchId === watchId)!
    trip = chooseOffer(trip, stay.id, offers[1]!, { by: m.maya, now: 1 })
    trip = recordSearch(trip, watchId, { ok: true, provider: 'skiplagged', offers, searchUrl: null, fetchedAt: 2 }, 2)
    trip = recordSearch(trip, watchId, { ok: true, provider: 'skiplagged', offers: [hotel('h1', 8500)], searchUrl: null, fetchedAt: 3 }, 3)
    const watch = trip.watches.find((w) => w.id === watchId)!
    expect(watch.cheapest).toEqual([
      { firstSeen: 1, lastSeen: 2, priceMinor: 9000 },
      { firstSeen: 3, lastSeen: 3, priceMinor: 8500 },
    ])
    expect(watch.tracked.h2).toEqual([
      { firstSeen: 1, lastSeen: 2, priceMinor: 12000 },
      { firstSeen: 3, lastSeen: 3, priceMinor: null },
    ])
  })
})

describe('costByMember', () => {
  it('splits a stay by people and nights, and honours a fixed share', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    const { trip: slotted } = applyGaps(base, option, findGaps(base, option).filter((g) => g.kind === 'no_stay'), newId)
    const stay = slotted.items.find((i) => i.detail.kind === 'stay')!
    let trip = chooseOffer(slotted, stay.id, hotel('h1', 10000), { by: m.maya, now: NOW })
    // 2 rooms for 7 nights at $100 = $1,400. Sam is there 5 of the 7 nights; Lou pays a fixed $100.
    trip = {
      ...trip,
      items: trip.items.map((i) =>
        i.id === stay.id
          ? {
              ...i,
              participants: i.participants.map((p) =>
                p.memberId === m.sam ? { ...p, fromDate: '2027-05-12' } : p.memberId === m.lou ? { ...p, shareMinor: 10000 } : p,
              ),
            }
          : i,
      ),
    }
    const costs = costByMember(trip, option)
    expect(costs.get(m.lou)).toBe(10000)
    expect(costs.get(m.maya)).toBe(costs.get(m.priya))
    expect((costs.get(m.maya) ?? 0) + (costs.get(m.priya) ?? 0) + (costs.get(m.sam) ?? 0) + (costs.get(m.lou) ?? 0)).toBe(140000)
    // 130000 by weights 7, 7, 5: floors 47894, 47894, 34210; the two cents left go to the larger fractions.
    expect([costs.get(m.maya), costs.get(m.priya), costs.get(m.sam)]).toEqual([47895, 47895, 34210])
  })
})

describe('bestWindows', () => {
  it('prefers the window that suits most people and does not repeat overlapping windows', () => {
    const { trip } = lisbonTrip()
    const [best, ...others] = bestWindows(trip, 7)
    expect(best).toMatchObject({ start: '2027-05-10', end: '2027-05-17' })
    expect(best?.memberIds).toHaveLength(4)
    for (const w of others) expect(w.start > best!.end || w.end < best!.start).toBe(true)
  })
})

describe('arrivals', () => {
  it('groups landings at one airport within an hour of each other', () => {
    const { trip: base, newId, optionId, m } = lisbonTrip()
    const option = base.options.find((o) => o.id === optionId)!
    const { trip: slotted } = applyGaps(base, option, findGaps(base, option).filter((g) => g.kind === 'no_flight'), newId)
    const [a, b] = slotted.items.filter((i) => i.detail.kind === 'flight')
    let trip = chooseOffer(slotted, a!.id, flight('A1', 1, '2027-05-11T09:00:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.maya, now: NOW })
    trip = chooseOffer(trip, b!.id, flight('B1', 1, '2027-05-11T09:50:00+01:00', '2027-05-17T11:00:00+01:00'), { by: m.sam, now: NOW })
    expect(arrivals(trip, option)).toHaveLength(1)
    trip = { ...trip, items: trip.items.map((i) => (i.id === b!.id && i.detail.kind === 'flight' && i.detail.offer ? { ...i, detail: { ...i.detail, offer: { ...i.detail.offer, outbound: { ...i.detail.offer.outbound, arrives: '2027-05-11T10:30:00+01:00' } } } } : i)) }
    expect(arrivals(trip, option)).toHaveLength(2)
  })
})

describe('tripSchema', () => {
  it('rejects a flight with no dates and accepts an unscheduled idea', () => {
    const { trip: base, newId, m } = lisbonTrip()
    const trip = addIdea(base, { title: 'Surf', link: null, place: null, interest: 'want', by: m.sam, newId })
    expect(tripSchema.safeParse(trip).success).toBe(true)
    const broken = { ...trip, items: [{ ...trip.items[0], detail: { kind: 'flight', from: ['SFO'], to: ['LIS'], depart: '2027-05-10', return: null, offer: null }, startDate: null, endDate: null }] }
    expect(tripSchema.safeParse(broken).success).toBe(false)
  })
})
