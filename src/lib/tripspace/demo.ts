/**
 * The sample trip the lab opens with. Everyone in it is made up. It starts at
 * the Shortlist stage, with a vote half done, so every later step runs live.
 */
import { defaultCloseTime, type NewId } from './actions'
import type { Item, Member, Trip } from './model'

export function sampleTrip({ newId, now }: { newId: NewId; now: number }): Trip {
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

  // The country disambiguates the hotel search: plain "Porto" matches Porto Alegre.
  const lisbon = { id: newId(), label: 'Lisbon', destination: 'LIS', city: 'Lisbon, Portugal', depart: '2027-05-10', return: '2027-05-17', status: 'candidate' as const, pricing: null }
  const porto = { id: newId(), label: 'Porto', destination: 'OPO', city: 'Porto, Portugal', depart: '2027-05-10', return: '2027-05-17', status: 'candidate' as const, pricing: null }
  const lisbonChoice = newId()
  const portoChoice = newId()

  const idea = (title: string, place: string, interests: [Member, 'reserve' | 'want' | 'like'][], bookBy: string | null = null): Item => ({
    id: newId(),
    optionId: null,
    status: 'open',
    title,
    startDate: null,
    endDate: null,
    detail: { kind: 'activity', place, time: null, link: null },
    participants: interests.map(([member, interest]) => ({ memberId: member.id, interest, fromDate: null, toDate: null, shareMinor: null })),
    quotedMinor: null,
    paidMinor: null,
    bookBy,
    leadMemberId: null,
    booking: null,
    watchId: null,
  })

  return {
    id: newId(),
    title: 'Portugal in May',
    createdAt: now,
    members: [maya, priya, sam, dev, mei],
    options: [lisbon, porto],
    items: [
      idea('Fado dinner in Alfama', 'Alfama', [[maya, 'reserve'], [priya, 'reserve'], [sam, 'want']], '2027-04-20'),
      idea('Sintra day trip', 'Sintra', [[priya, 'want'], [dev, 'want']]),
      idea('Surf lesson', 'Costa da Caparica', [[sam, 'want']]),
      idea('Tile museum', 'Museu Nacional do Azulejo', [[maya, 'like']]),
    ],
    polls: [
      {
        id: newId(),
        question: 'Where should we go?',
        choices: [
          { id: lisbonChoice, label: 'Lisbon, 10 to 17 May', optionId: lisbon.id },
          { id: portoChoice, label: 'Porto, 10 to 17 May', optionId: porto.id },
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
      { id: newId(), summary: 'The trip is on: Portugal, one week in mid-May 2027.', at: now, by: maya.id, pollId: null, optionId: null, replacesId: null },
    ],
    watches: [],
  }
}
