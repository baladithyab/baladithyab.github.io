import { describe, expect, it } from 'vitest'

import { searchRequestSchema } from './search'
import { lastEventData, normalize, SearchError, toolContent } from './skiplagged'

// Trimmed from real responses recorded on 2026-11-16.
const flightsStream = `event: message
data: {"result":{"content":[{"type":"text","text":"..."}],"structuredContent":{"searchUrl":"https://skiplagged.com/flights/SFO/LIS/2027-05-10/2027-05-17","flights":[{"type":"FlightCard","id":"SFO-LIS-2027-05-10-2027-05-17-trip=SK936-SK4303-IB539,FR8197-EI401-EI61","airlines":"Scandinavian Airlines, Iberia","departure":{"airport":"SFO","dateTime":"2027-05-10T16:35:00-07:00"},"arrival":{"airport":"LIS","dateTime":"2027-05-11T23:25:00+01:00"},"duration":"22h 50m","layovers":2,"price":{"amount":1820,"currency":"USD","usdAmount":1820},"deepLink":"https://skiplagged.com/flights/SFO/LIS/2027-05-10/2027-05-17#trip=SK936","attributes":["virtual-interline","multi-stop"],"returnFlight":{"airlines":"Ryanair, Aer Lingus","departure":{"airport":"LIS","dateTime":"2027-05-17T16:00:00+01:00"},"arrival":{"airport":"SFO","dateTime":"2027-05-18T15:50:00-07:00"},"duration":"31h 50m","layovers":2,"attributes":["virtual-interline"]}},{"type":"FlightCard","id":"broken"}]}},"jsonrpc":"2.0","id":1}

`

const flights = { kind: 'flights' as const, from: ['SFO'], to: ['LIS'], depart: '2027-05-10', return: '2027-05-17', adults: 2, children: 0 }

describe('Skiplagged responses', () => {
  it('reads the last event of a stream and keys a flight by its segments', () => {
    const { offers, searchUrl } = normalize(flights, toolContent(lastEventData(flightsStream)))
    expect(searchUrl).toBe('https://skiplagged.com/flights/SFO/LIS/2027-05-10/2027-05-17')
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({
      kind: 'flight',
      key: 'SK936-SK4303-IB539,FR8197-EI401-EI61',
      priceMinor: 182000,
      outbound: { from: 'SFO', to: 'LIS', arrives: '2027-05-11T23:25:00+01:00', stops: 2 },
      inbound: { from: 'LIS', departs: '2027-05-17T16:00:00+01:00' },
      tags: ['virtual-interline', 'multi-stop'],
    })
  })

  it("turns the provider's own error into an invalid search with its message", () => {
    const envelope = { result: { content: [{ type: 'text', text: 'No IATA code available for "XYZQ".' }], isError: true }, jsonrpc: '2.0', id: 4 }
    expect(() => toolContent(envelope)).toThrow(SearchError)
    try {
      toolContent(envelope)
    } catch (error) {
      expect(error).toMatchObject({ reason: 'invalid', message: 'No IATA code available for "XYZQ".' })
    }
  })

  it('fails instead of guessing when a stream has no result', () => {
    expect(() => toolContent(lastEventData('event: message\ndata: {"jsonrpc":"2.0","id":1}\n'))).toThrow(/without a result/)
    expect(() => lastEventData('event: message\ndata: {not json\n')).toThrow(SearchError)
  })

  it('keeps the cheapest bookable fare per destination and drops hidden-city fares', () => {
    const content = {
      results: [
        { destination: { city: 'Lisbon', region: 'Portugal', airport: 'LIS' }, price: { amount: 500, currency: 'USD' }, flightType: 'Standard', deepLink: 'a' },
        { destination: { city: 'Lisbon', region: 'Portugal', airport: 'LIS' }, price: { amount: 300, currency: 'USD' }, flightType: 'Hidden City', deepLink: 'b' },
        { destination: { city: 'Lisbon', region: 'Portugal', airport: 'LIS' }, price: { amount: 450, currency: 'USD' }, flightType: 'Standard', deepLink: 'c' },
      ],
    }
    const { offers } = normalize({ kind: 'anywhere', from: 'SFO', depart: '2027-05-10', return: '2027-05-17', adults: 1 }, content)
    expect(offers).toEqual([{ kind: 'destination', key: 'LIS', city: 'Lisbon', region: 'Portugal', priceMinor: 45000, link: 'c' }])
  })

  it('reads a hotel nightly price in minor units', () => {
    const content = {
      results: [{ id: 'hotel_18929', name: 'Hotel Duas Nações', rating: { stars: 2, text: '2 stars' }, price: { amount: 58.43, currency: 'USD', text: '$58/night' }, location: 'Rua Da Vitória 39', deepLink: 'h' }],
    }
    const { offers } = normalize({ kind: 'hotels', city: 'Lisbon', checkin: '2027-05-10', checkout: '2027-05-17', adults: 2, rooms: 1 }, content)
    expect(offers[0]).toMatchObject({ kind: 'hotel', key: 'hotel_18929', nightlyMinor: 5843, stars: 2 })
  })
})

describe('searchRequestSchema', () => {
  it('rejects requests the provider would misread', () => {
    expect(searchRequestSchema.safeParse(flights).success).toBe(true)
    expect(searchRequestSchema.safeParse({ ...flights, from: ['sfo'] }).success).toBe(false)
    expect(searchRequestSchema.safeParse({ ...flights, return: '2027-05-01' }).success).toBe(false)
    expect(searchRequestSchema.safeParse({ ...flights, depart: '2027-02-30' }).success).toBe(false)
    expect(searchRequestSchema.safeParse({ kind: 'hotels', city: 'Lisbon', checkin: '2027-05-10', checkout: '2027-05-10', adults: 2, rooms: 1 }).success).toBe(false)
  })
})
