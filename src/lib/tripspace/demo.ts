/**
 * Seeded sample trips for the lab. Everyone and every sample price in them is
 * made up; pressing any Search or Check button replaces sample watches with
 * live Skiplagged results.
 */
import { defaultCloseTime, type NewId } from './actions'
import type { Item, Member, Observation, Trip, Watch } from './model'
import type { FlightOffer, HotelOffer } from './search'

const DAY = 86_400_000

/** Build a run-length-encoded observation series stepping backward from `now`. */
function history(
  now: number,
  points: [daysAgo: number, priceMinor: number][],
): Observation[] {
  return points.map(([daysAgo, priceMinor], idx) => {
    const firstSeen = now - daysAgo * DAY
    const nextDays = points[idx + 1]?.[0]
    const lastSeen =
      nextDays !== undefined ? now - (nextDays + 0.25) * DAY : now - 3_600_000
    return {
      firstSeen,
      lastSeen: Math.max(firstSeen, lastSeen),
      priceMinor,
    }
  })
}

function baseMembers(newId: NewId) {
  const maya: Member = {
    id: newId(),
    name: 'Maya',
    role: 'owner',
    rsvp: 'in',
    dates: [{ start: '2027-05-07', end: '2027-05-19' }],
    budgetBand: 2,
    home: { kind: 'airports', codes: ['SFO'] },
    party: { adults: 1, children: 0 },
  }
  const priya: Member = {
    id: newId(),
    name: 'Priya',
    role: 'member',
    rsvp: 'in',
    dates: [{ start: '2027-05-09', end: '2027-05-18' }],
    budgetBand: 2,
    home: { kind: 'airports', codes: ['SFO'] },
    party: { adults: 1, children: 0 },
  }
  const sam: Member = {
    id: newId(),
    name: 'Sam',
    role: 'member',
    rsvp: 'in',
    dates: [{ start: '2027-05-10', end: '2027-05-21' }],
    budgetBand: 3,
    home: { kind: 'airports', codes: ['ORD'] },
    party: { adults: 1, children: 0 },
  }
  const dev: Member = {
    id: newId(),
    name: 'Dev and Ana',
    role: 'member',
    rsvp: 'maybe',
    dates: [{ start: '2027-05-08', end: '2027-05-17' }],
    budgetBand: 2,
    home: { kind: 'airports', codes: ['JFK'] },
    party: { adults: 2, children: 0 },
  }
  const mei: Member = {
    id: newId(),
    name: 'Mei',
    role: 'member',
    rsvp: 'invited',
    dates: [],
    budgetBand: null,
    home: { kind: 'unanswered' },
    party: { adults: 1, children: 0 },
  }
  return { maya, priya, sam, dev, mei }
}

function makeIdea(
  newId: NewId,
  title: string,
  place: string,
  interests: [Member, 'reserve' | 'want' | 'like'][],
  opts?: {
    bookBy?: string | null
    optionId?: string | null
    date?: string | null
    time?: string | null
  },
): Item {
  const scheduled = Boolean(opts?.date && opts?.optionId)
  return {
    id: newId(),
    optionId: scheduled ? (opts?.optionId ?? null) : null,
    status: scheduled ? 'chosen' : 'open',
    title,
    startDate: scheduled ? (opts?.date ?? null) : null,
    endDate: scheduled ? (opts?.date ?? null) : null,
    detail: {
      kind: 'activity',
      place,
      time: scheduled ? (opts?.time ?? null) : null,
      link: null,
    },
    participants: interests.map(([member, interest]) => ({
      memberId: member.id,
      interest,
      fromDate: null,
      toDate: null,
      shareMinor: null,
    })),
    quotedMinor: null,
    paidMinor: null,
    bookBy: opts?.bookBy ?? null,
    leadMemberId: null,
    booking: null,
    watchId: null,
  }
}

/**
 * Active Plan-stage sample trip so the Dashboard, Timeline, Coordinator and
 * Price Monitor all show realistic live-ready data immediately on open.
 */
export function activeSampleTrip({
  newId,
  now,
}: {
  newId: NewId
  now: number
}): Trip {
  const { maya, priya, sam, dev, mei } = baseMembers(newId)

  const lisbon = {
    id: newId(),
    label: 'Lisbon',
    destination: 'LIS',
    city: 'Lisbon, Portugal',
    depart: '2027-05-10',
    return: '2027-05-17',
    status: 'chosen' as const,
    pricing: null,
  }
  const porto = {
    id: newId(),
    label: 'Porto',
    destination: 'OPO',
    city: 'Porto, Portugal',
    depart: '2027-05-10',
    return: '2027-05-17',
    status: 'rejected' as const,
    pricing: null,
  }

  const sfoOffer: FlightOffer = {
    kind: 'flight',
    key: 'TP236-TP237',
    priceMinor: 182000,
    outbound: {
      from: 'SFO',
      to: 'LIS',
      departs: '2027-05-10T16:10:00-07:00',
      arrives: '2027-05-11T11:25:00+01:00',
      stops: 0,
      airlines: 'TAP Portugal',
      duration: '11h 15m',
    },
    inbound: {
      from: 'LIS',
      to: 'SFO',
      departs: '2027-05-17T10:35:00+01:00',
      arrives: '2027-05-17T14:40:00-07:00',
      stops: 0,
      airlines: 'TAP Portugal',
      duration: '12h 05m',
    },
    tags: [],
    link: 'https://skiplagged.com/flights/SFO/LIS/2027-05-10/2027-05-17',
  }

  const ordOffer: FlightOffer = {
    kind: 'flight',
    key: 'EI124-EI484-EI485-EI125',
    priceMinor: 89000,
    outbound: {
      from: 'ORD',
      to: 'LIS',
      departs: '2027-05-10T17:20:00-05:00',
      arrives: '2027-05-11T11:50:00+01:00',
      stops: 1,
      airlines: 'Aer Lingus',
      duration: '12h 30m',
    },
    inbound: {
      from: 'LIS',
      to: 'ORD',
      departs: '2027-05-17T12:15:00+01:00',
      arrives: '2027-05-17T19:45:00-05:00',
      stops: 1,
      airlines: 'Aer Lingus',
      duration: '13h 30m',
    },
    tags: [],
    link: 'https://skiplagged.com/flights/ORD/LIS/2027-05-10/2027-05-17',
  }

  const jfkOffer: FlightOffer = {
    kind: 'flight',
    key: 'TP208-TP209',
    priceMinor: 134000,
    outbound: {
      from: 'JFK',
      to: 'LIS',
      departs: '2027-05-10T20:15:00-04:00',
      arrives: '2027-05-11T08:10:00+01:00',
      stops: 0,
      airlines: 'TAP Portugal',
      duration: '6h 55m',
    },
    inbound: {
      from: 'LIS',
      to: 'JFK',
      departs: '2027-05-17T17:00:00+01:00',
      arrives: '2027-05-17T20:05:00-04:00',
      stops: 0,
      airlines: 'TAP Portugal',
      duration: '8h 05m',
    },
    tags: [],
    link: 'https://skiplagged.com/flights/JFK/LIS/2027-05-10/2027-05-17',
  }

  const hotelOffers: HotelOffer[] = [
    {
      kind: 'hotel',
      key: 'lisbon-chiado-house',
      name: 'Casa Balthazar Chiado',
      stars: 4,
      nightlyMinor: 14800,
      location: 'Chiado',
      link: 'https://skiplagged.com/hotels/Lisbon',
    },
    {
      kind: 'hotel',
      key: 'lisbon-baixa-suites',
      name: 'Baixa Terrace Suites',
      stars: 4,
      nightlyMinor: 16200,
      location: 'Baixa',
      link: 'https://skiplagged.com/hotels/Lisbon',
    },
    {
      kind: 'hotel',
      key: 'lisbon-principe-real',
      name: 'Jardim Principe Real Boutique',
      stars: 4,
      nightlyMinor: 17900,
      location: 'Principe Real',
      link: 'https://skiplagged.com/hotels/Lisbon',
    },
  ]

  const sfoWatchId = newId()
  const ordWatchId = newId()
  const stayWatchId = newId()
  const jfkWatchId = newId()

  const watches: Watch[] = [
    {
      id: sfoWatchId,
      label: 'Flight SFO to LIS for Maya, Priya',
      request: {
        kind: 'flights',
        from: ['SFO'],
        to: ['LIS'],
        depart: '2027-05-10',
        return: '2027-05-17',
        adults: 2,
        children: 0,
      },
      cheapest: history(now, [
        [10, 196000],
        [7, 198500],
        [4, 191000],
        [2, 186000],
        [0, 182000],
      ]),
      tracked: {
        [sfoOffer.key]: history(now, [
          [10, 196000],
          [7, 198500],
          [4, 191000],
          [2, 186000],
          [0, 182000],
        ]),
      },
      offers: [sfoOffer],
      searchUrl: sfoOffer.link,
      checkedAt: now - 3_600_000,
      error: null,
      targetMinor: 185000,
      sample: true,
    },
    {
      id: ordWatchId,
      label: 'Flight ORD to LIS for Sam',
      request: {
        kind: 'flights',
        from: ['ORD'],
        to: ['LIS'],
        depart: '2027-05-10',
        return: '2027-05-17',
        adults: 1,
        children: 0,
      },
      cheapest: history(now, [
        [9, 96000],
        [6, 94500],
        [3, 91000],
        [0, 89000],
      ]),
      tracked: {
        [ordOffer.key]: history(now, [
          [9, 96000],
          [6, 94500],
          [3, 91000],
          [0, 89000],
        ]),
      },
      offers: [ordOffer],
      searchUrl: ordOffer.link,
      checkedAt: now - 3_600_000,
      error: null,
      targetMinor: 85000,
      sample: true,
    },
    {
      id: stayWatchId,
      label: 'Stay in Lisbon, Portugal for Maya, Priya, Sam',
      request: {
        kind: 'hotels',
        city: 'Lisbon, Portugal',
        checkin: '2027-05-10',
        checkout: '2027-05-17',
        adults: 3,
        rooms: 2,
      },
      cheapest: history(now, [
        [8, 16500],
        [5, 16100],
        [2, 15400],
        [0, 14800],
      ]),
      tracked: {},
      offers: hotelOffers,
      searchUrl: 'https://skiplagged.com/hotels/Lisbon',
      checkedAt: now - 3_600_000,
      error: null,
      targetMinor: 15000,
      sample: true,
    },
    {
      id: jfkWatchId,
      label: 'JFK to LIS (Dev and Ana, 2 seats)',
      request: {
        kind: 'flights',
        from: ['JFK'],
        to: ['LIS'],
        depart: '2027-05-10',
        return: '2027-05-17',
        adults: 2,
        children: 0,
      },
      cheapest: history(now, [
        [8, 146000],
        [5, 142000],
        [2, 138000],
        [0, 134000],
      ]),
      tracked: {},
      offers: [jfkOffer],
      searchUrl: jfkOffer.link,
      checkedAt: now - 3_600_000,
      error: null,
      targetMinor: 140000,
      standalone: true,
      sample: true,
    },
  ]

  const items: Item[] = [
    {
      id: newId(),
      optionId: lisbon.id,
      status: 'booked',
      title: 'TAP Portugal, SFO to LIS',
      startDate: '2027-05-10',
      endDate: '2027-05-17',
      detail: {
        kind: 'flight',
        from: ['SFO'],
        to: ['LIS'],
        depart: '2027-05-10',
        return: '2027-05-17',
        offer: sfoOffer,
      },
      participants: [maya, priya].map((m) => ({
        memberId: m.id,
        interest: null,
        fromDate: null,
        toDate: null,
        shareMinor: null,
      })),
      quotedMinor: 196000,
      paidMinor: 196000,
      bookBy: null,
      leadMemberId: maya.id,
      booking: {
        soldBy: 'TAP Portugal',
        fareType: 'Classic',
        freeCancelUntil: null,
      },
      watchId: sfoWatchId,
    },
    {
      id: newId(),
      optionId: lisbon.id,
      status: 'chosen',
      title: 'Aer Lingus, ORD to LIS',
      startDate: '2027-05-10',
      endDate: '2027-05-17',
      detail: {
        kind: 'flight',
        from: ['ORD'],
        to: ['LIS'],
        depart: '2027-05-10',
        return: '2027-05-17',
        offer: ordOffer,
      },
      participants: [
        {
          memberId: sam.id,
          interest: null,
          fromDate: null,
          toDate: null,
          shareMinor: null,
        },
      ],
      quotedMinor: 89000,
      paidMinor: null,
      bookBy: null,
      leadMemberId: sam.id,
      booking: null,
      watchId: ordWatchId,
    },
    {
      id: newId(),
      optionId: lisbon.id,
      status: 'open',
      title: 'Stay in Lisbon, Portugal for Maya, Priya, Sam',
      startDate: '2027-05-10',
      endDate: '2027-05-17',
      detail: {
        kind: 'stay',
        city: 'Lisbon, Portugal',
        rooms: 2,
        hotel: null,
      },
      participants: [maya, priya, sam].map((m) => ({
        memberId: m.id,
        interest: null,
        fromDate: null,
        toDate: null,
        shareMinor: null,
      })),
      quotedMinor: null,
      paidMinor: null,
      bookBy: null,
      leadMemberId: null,
      booking: null,
      watchId: stayWatchId,
    },
    makeIdea(
      newId,
      'Fado dinner in Alfama',
      'Alfama',
      [
        [maya, 'reserve'],
        [priya, 'reserve'],
        [sam, 'want'],
      ],
      {
        bookBy: '2027-04-20',
        optionId: lisbon.id,
        date: '2027-05-12',
        time: '20:00',
      },
    ),
    makeIdea(newId, 'Sintra day trip', 'Sintra', [
      [priya, 'want'],
      [dev, 'want'],
    ]),
    makeIdea(newId, 'Surf lesson', 'Costa da Caparica', [[sam, 'want']]),
    makeIdea(newId, 'Tile museum', 'Museu Nacional do Azulejo', [
      [maya, 'like'],
    ]),
  ]

  const pollId = newId()
  const lisbonChoice = newId()
  const portoChoice = newId()

  return {
    id: newId(),
    title: 'Lisbon in May',
    createdAt: now - 12 * DAY,
    members: [maya, priya, sam, dev, mei],
    options: [lisbon, porto],
    items,
    polls: [
      {
        id: pollId,
        question: 'Where should we go?',
        choices: [
          {
            id: lisbonChoice,
            label: 'Lisbon, 10 to 17 May',
            optionId: lisbon.id,
          },
          {
            id: portoChoice,
            label: 'Porto, 10 to 17 May',
            optionId: porto.id,
          },
        ],
        votes: [
          { choiceId: lisbonChoice, memberId: maya.id, favourite: true },
          { choiceId: portoChoice, memberId: maya.id, favourite: false },
          { choiceId: lisbonChoice, memberId: priya.id, favourite: true },
          { choiceId: lisbonChoice, memberId: sam.id, favourite: true },
        ],
        closesAt: now - 9 * DAY,
        status: 'decided',
      },
    ],
    decisions: [
      {
        id: newId(),
        summary: 'The trip is on: Portugal, one week in mid-May 2027.',
        at: now - 12 * DAY,
        by: maya.id,
        pollId: null,
        optionId: null,
        replacesId: null,
      },
      {
        id: newId(),
        summary: 'Lisbon, 10 to 17 May. Approved by 3 of 3 who voted.',
        at: now - 9 * DAY,
        by: maya.id,
        pollId,
        optionId: lisbon.id,
        replacesId: null,
      },
    ],
    watches,
  }
}

/**
 * Shortlist-stage sample trip, half way through a destination vote, so the
 * full Idea -> Shortlist -> Vote -> Lock flow is one click away.
 */
export function sampleTrip({
  newId,
  now,
}: {
  newId: NewId
  now: number
}): Trip {
  const { maya, priya, sam, dev, mei } = baseMembers(newId)

  // The country disambiguates the hotel search: plain "Porto" matches Porto Alegre.
  const lisbon = {
    id: newId(),
    label: 'Lisbon',
    destination: 'LIS',
    city: 'Lisbon, Portugal',
    depart: '2027-05-10',
    return: '2027-05-17',
    status: 'candidate' as const,
    pricing: null,
  }
  const porto = {
    id: newId(),
    label: 'Porto',
    destination: 'OPO',
    city: 'Porto, Portugal',
    depart: '2027-05-10',
    return: '2027-05-17',
    status: 'candidate' as const,
    pricing: null,
  }
  const lisbonChoice = newId()
  const portoChoice = newId()

  return {
    id: newId(),
    title: 'Portugal in May (Voting)',
    createdAt: now,
    members: [maya, priya, sam, dev, mei],
    options: [lisbon, porto],
    items: [
      makeIdea(
        newId,
        'Fado dinner in Alfama',
        'Alfama',
        [
          [maya, 'reserve'],
          [priya, 'reserve'],
          [sam, 'want'],
        ],
        { bookBy: '2027-04-20' },
      ),
      makeIdea(newId, 'Sintra day trip', 'Sintra', [
        [priya, 'want'],
        [dev, 'want'],
      ]),
      makeIdea(newId, 'Surf lesson', 'Costa da Caparica', [[sam, 'want']]),
      makeIdea(newId, 'Tile museum', 'Museu Nacional do Azulejo', [
        [maya, 'like'],
      ]),
    ],
    polls: [
      {
        id: newId(),
        question: 'Where should we go?',
        choices: [
          {
            id: lisbonChoice,
            label: 'Lisbon, 10 to 17 May',
            optionId: lisbon.id,
          },
          {
            id: portoChoice,
            label: 'Porto, 10 to 17 May',
            optionId: porto.id,
          },
        ],
        votes: [
          { choiceId: lisbonChoice, memberId: maya.id, favourite: true },
          { choiceId: portoChoice, memberId: maya.id, favourite: false },
          { choiceId: lisbonChoice, memberId: sam.id, favourite: true },
        ],
        closesAt: defaultCloseTime(now),
        status: 'open',
      },
    ],
    decisions: [
      {
        id: newId(),
        summary: 'The trip is on: Portugal, one week in mid-May 2027.',
        at: now,
        by: maya.id,
        pollId: null,
        optionId: null,
        replacesId: null,
      },
    ],
    watches: [],
  }
}

export function sampleTrips(opts: { newId: NewId; now: number }): Trip[] {
  return [activeSampleTrip(opts), sampleTrip(opts)]
}
