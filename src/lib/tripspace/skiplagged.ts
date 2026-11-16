/**
 * Server-side client for Skiplagged's public MCP endpoint.
 *
 * The endpoint answers JSON-RPC `tools/call` as one server-sent event and
 * rejects requests that carry a browser `Origin`, so it is called from the
 * Worker, never from the page. Responses are parsed into the offers of
 * `search.ts`; anything unreadable is a failure, never a guessed price.
 */
import { z } from 'astro/zod'

import type { Offer, SearchFailure, SearchRequest } from './search'

export const SKIPLAGGED_MCP_URL = 'https://mcp.skiplagged.com/mcp'
const RESULT_LIMIT = 12
const TIMEOUT_MS = 25_000

export class SearchError extends Error {
  constructor(
    readonly reason: SearchFailure,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message)
    this.name = 'SearchError'
  }
}

const priceSchema = z.object({ amount: z.number().min(0), currency: z.string() })
const endpointSchema = z.object({ airport: z.string(), dateTime: z.string() })
const legCardSchema = z.object({
  airlines: z.string(),
  departure: endpointSchema,
  arrival: endpointSchema,
  duration: z.string(),
  layovers: z.number().int().min(0),
  attributes: z.array(z.string()).default([]),
})
const flightCardSchema = legCardSchema.extend({
  id: z.string(),
  price: priceSchema,
  deepLink: z.string(),
  returnFlight: legCardSchema.nullish(),
})
const dealCardSchema = z.object({
  destination: z.object({ city: z.string(), region: z.string(), airport: z.string() }),
  price: priceSchema,
  flightType: z.string(),
  deepLink: z.string(),
})
const hotelCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  rating: z.object({ stars: z.number().nullable() }).nullish(),
  price: priceSchema,
  location: z.string().nullish(),
  deepLink: z.string(),
})

const flightsContentSchema = z.object({ searchUrl: z.string().nullish(), flights: z.array(z.unknown()) })
const resultsContentSchema = z.object({ searchUrl: z.string().nullish(), results: z.array(z.unknown()) })

const rpcEnvelopeSchema = z.object({
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      structuredContent: z.unknown().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
})

/** The last `data:` line of a server-sent event stream, parsed as JSON. */
export function lastEventData(body: string): unknown {
  const lines = body.split(/\r?\n/).filter((line) => line.startsWith('data:'))
  const last = lines.at(-1)
  if (last === undefined) {
    try {
      return JSON.parse(body)
    } catch {
      throw new SearchError('bad_response', 'The provider answered without a result.')
    }
  }
  try {
    return JSON.parse(last.slice(5).trim())
  } catch {
    throw new SearchError('bad_response', 'The provider answered with an unreadable result.')
  }
}

/** The `structuredContent` of a tool result, or the provider's own error message as a failure. */
export function toolContent(envelope: unknown): unknown {
  const parsed = rpcEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) throw new SearchError('bad_response', 'The provider answered in an unexpected shape.')
  const { result, error } = parsed.data
  if (error) throw new SearchError('unavailable', `The provider refused the search: ${error.message}`)
  if (!result) throw new SearchError('bad_response', 'The provider answered without a result.')
  if (result.isError) {
    const text = result.content.map((part) => part.text ?? '').join(' ').trim()
    throw new SearchError('invalid', text || 'The provider could not run this search.')
  }
  if (result.structuredContent === undefined) throw new SearchError('bad_response', 'The provider answered without structured results.')
  return result.structuredContent
}

const toMinor = (amount: number) => Math.round(amount * 100)

/** Parse each card on its own: one malformed card is dropped, not the whole search. */
function cards<T>(items: unknown[], schema: z.ZodType<T>): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function legOf(card: z.infer<typeof legCardSchema>) {
  return {
    from: card.departure.airport,
    to: card.arrival.airport,
    departs: card.departure.dateTime,
    arrives: card.arrival.dateTime,
    stops: card.layovers,
    airlines: card.airlines,
    duration: card.duration,
  }
}

/** Skiplagged's flight id ends with `trip=<outbound segments>,<return segments>`. */
function itineraryKey(id: string): string {
  const marker = id.indexOf('trip=')
  return marker === -1 ? id : id.slice(marker + 5)
}

export function normalize(request: SearchRequest, content: unknown): { offers: Offer[]; searchUrl: string | null } {
  switch (request.kind) {
    case 'flights': {
      const parsed = flightsContentSchema.safeParse(content)
      if (!parsed.success) throw new SearchError('bad_response', 'The flight results were unreadable.')
      const offers = cards(parsed.data.flights, flightCardSchema)
        .filter((card) => card.price.currency === 'USD')
        .map((card): Offer => ({
          kind: 'flight',
          key: itineraryKey(card.id),
          priceMinor: toMinor(card.price.amount),
          outbound: legOf(card),
          inbound: card.returnFlight ? legOf(card.returnFlight) : null,
          tags: [...new Set([...card.attributes, ...(card.returnFlight?.attributes ?? [])])],
          link: card.deepLink,
        }))
      return { offers, searchUrl: parsed.data.searchUrl ?? null }
    }
    case 'anywhere': {
      const parsed = resultsContentSchema.safeParse(content)
      if (!parsed.success) throw new SearchError('bad_response', 'The destination results were unreadable.')
      const cheapest = new Map<string, Offer & { kind: 'destination' }>()
      for (const card of cards(parsed.data.results, dealCardSchema)) {
        // Hidden-city fares are left out so every origin is compared on fares a person can fly as booked.
        if (card.flightType.toLowerCase().includes('hidden') || card.price.currency !== 'USD') continue
        const offer = {
          kind: 'destination' as const,
          key: card.destination.airport,
          city: card.destination.city,
          region: card.destination.region,
          priceMinor: toMinor(card.price.amount),
          link: card.deepLink,
        }
        const seen = cheapest.get(offer.key)
        if (!seen || offer.priceMinor < seen.priceMinor) cheapest.set(offer.key, offer)
      }
      return { offers: [...cheapest.values()], searchUrl: parsed.data.searchUrl ?? null }
    }
    case 'hotels': {
      const parsed = resultsContentSchema.safeParse(content)
      if (!parsed.success) throw new SearchError('bad_response', 'The hotel results were unreadable.')
      const offers = cards(parsed.data.results, hotelCardSchema)
        .filter((card) => card.price.currency === 'USD')
        .map((card): Offer => ({
          kind: 'hotel',
          key: card.id,
          name: card.name,
          stars: card.rating?.stars ?? null,
          nightlyMinor: toMinor(card.price.amount),
          location: card.location ?? null,
          link: card.deepLink,
        }))
      return { offers, searchUrl: parsed.data.searchUrl ?? null }
    }
    default: {
      const exhaustive: never = request
      return exhaustive
    }
  }
}

function toolCall(request: SearchRequest): { name: string; arguments: Record<string, unknown> } {
  switch (request.kind) {
    case 'flights': {
      const [origin, ...additionalOrigins] = request.from
      const [destination, ...additionalDestinations] = request.to
      return {
        name: 'sk_flights_search',
        arguments: {
          origin,
          destination,
          ...(additionalOrigins.length ? { additionalOrigins } : {}),
          ...(additionalDestinations.length ? { additionalDestinations } : {}),
          departureDate: request.depart,
          ...(request.return ? { returnDate: request.return } : {}),
          adults: request.adults,
          children: request.children,
          sort: 'price',
          limit: RESULT_LIMIT,
          currency: 'USD',
          includeHiddenCity: false,
        },
      }
    }
    case 'anywhere':
      return {
        name: 'sk_destinations_anywhere',
        arguments: {
          from: request.from,
          depart: request.depart,
          ...(request.return ? { return: request.return } : {}),
          adults: request.adults,
          currency: 'USD',
        },
      }
    case 'hotels':
      return {
        name: 'sk_hotels_search',
        arguments: {
          city: request.city,
          checkin: request.checkin,
          checkout: request.checkout,
          numAdults: request.adults,
          numRooms: request.rooms,
          sort: 'price',
          limit: RESULT_LIMIT,
          currency: 'USD',
        },
      }
    default: {
      const exhaustive: never = request
      return exhaustive
    }
  }
}

/** One provider round trip. */
export async function searchSkiplagged(
  request: SearchRequest,
  signal: AbortSignal,
): Promise<{ offers: Offer[]; searchUrl: string | null }> {
  let response: Response
  try {
    response = await fetch(SKIPLAGGED_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'codeseys-tripspace/0.1 (+https://codeseys.io/lab/tripspace)',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: toolCall(request) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new SearchError('timeout', 'The provider took longer than 25 seconds.')
    }
    throw new SearchError('unavailable', 'The provider could not be reached.')
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw new SearchError('rate_limited', 'The provider asked us to slow down.', Number.isFinite(retryAfter) ? retryAfter : null)
  }
  if (!response.ok) throw new SearchError('unavailable', `The provider answered ${response.status}.`)
  return normalize(request, toolContent(lastEventData(await response.text())))
}
