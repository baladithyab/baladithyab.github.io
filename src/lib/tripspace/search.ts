/**
 * The search contract between the Tripspace page and `/api/tripspace/search`.
 * Both sides parse with these schemas, so a request the page can build is a
 * request the route accepts.
 */
import { z } from 'astro/zod'

import { isIsoDate } from './dates'

export const iataSchema = z.string().regex(/^[A-Z]{3}$/, 'an IATA airport or city code')
export const isoDateSchema = z.string().refine(isIsoDate, 'a YYYY-MM-DD date')

const flightsRequestSchema = z
  .object({
    kind: z.literal('flights'),
    from: z.array(iataSchema).min(1).max(3),
    to: z.array(iataSchema).min(1).max(3),
    depart: isoDateSchema,
    return: isoDateSchema.nullable(),
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(8),
  })
  .refine((r) => r.return === null || r.return >= r.depart, 'return before departure')

const anywhereRequestSchema = z
  .object({
    kind: z.literal('anywhere'),
    from: iataSchema,
    depart: isoDateSchema,
    return: isoDateSchema.nullable(),
    adults: z.number().int().min(1).max(9),
  })
  .refine((r) => r.return === null || r.return >= r.depart, 'return before departure')

const hotelsRequestSchema = z
  .object({
    kind: z.literal('hotels'),
    city: z.string().trim().min(2).max(80),
    checkin: isoDateSchema,
    checkout: isoDateSchema,
    adults: z.number().int().min(1).max(10),
    rooms: z.number().int().min(1).max(9),
  })
  .refine((r) => r.checkout > r.checkin, 'check-out must be after check-in')

export const searchRequestSchema = z.union([flightsRequestSchema, anywhereRequestSchema, hotelsRequestSchema])
export type SearchRequest = z.infer<typeof searchRequestSchema>
export type FlightsRequest = z.infer<typeof flightsRequestSchema>
export type HotelsRequest = z.infer<typeof hotelsRequestSchema>

export const legSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Local time at the airport, with its UTC offset. */
  departs: z.string(),
  arrives: z.string(),
  stops: z.number().int().min(0),
  airlines: z.string(),
  duration: z.string(),
})
export type Leg = z.infer<typeof legSchema>

export const flightOfferSchema = z.object({
  kind: z.literal('flight'),
  /** Flight numbers of every segment: the same itinerary has the same key in every search. */
  key: z.string(),
  priceMinor: z.number().int().min(0),
  outbound: legSchema,
  inbound: legSchema.nullable(),
  tags: z.array(z.string()),
  link: z.string(),
})

export const destinationOfferSchema = z.object({
  kind: z.literal('destination'),
  key: z.string(),
  city: z.string(),
  region: z.string(),
  priceMinor: z.number().int().min(0),
  link: z.string(),
})

export const hotelOfferSchema = z.object({
  kind: z.literal('hotel'),
  key: z.string(),
  name: z.string(),
  stars: z.number().nullable(),
  /** One room, one night, as the provider quotes it. */
  nightlyMinor: z.number().int().min(0),
  location: z.string().nullable(),
  link: z.string(),
})

export const offerSchema = z.discriminatedUnion('kind', [flightOfferSchema, destinationOfferSchema, hotelOfferSchema])
export type Offer = z.infer<typeof offerSchema>
export type FlightOffer = z.infer<typeof flightOfferSchema>
export type DestinationOffer = z.infer<typeof destinationOfferSchema>
export type HotelOffer = z.infer<typeof hotelOfferSchema>

export const searchFailureSchema = z.enum(['invalid', 'rate_limited', 'unavailable', 'bad_response', 'timeout', 'no_results'])
export type SearchFailure = z.infer<typeof searchFailureSchema>

export const searchResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    provider: z.literal('skiplagged'),
    offers: z.array(offerSchema),
    searchUrl: z.string().nullable(),
    fetchedAt: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    reason: searchFailureSchema,
    message: z.string(),
    retryAfterS: z.number().nullable(),
  }),
])
export type SearchResponse = z.infer<typeof searchResponseSchema>

/** Canonical form of a request: equal searches have equal keys. */
export function searchKey(request: SearchRequest): string {
  switch (request.kind) {
    case 'flights':
      return [
        'flights',
        [...request.from].sort().join('+'),
        [...request.to].sort().join('+'),
        request.depart,
        request.return ?? '-',
        request.adults,
        request.children,
      ].join('|')
    case 'anywhere':
      return ['anywhere', request.from, request.depart, request.return ?? '-', request.adults].join('|')
    case 'hotels':
      return ['hotels', request.city.trim().toLowerCase(), request.checkin, request.checkout, request.adults, request.rooms].join('|')
    default: {
      const exhaustive: never = request
      return exhaustive
    }
  }
}

/** Run one search through the site's route. Never throws for a provider failure: it is in the result. */
export async function search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  let response: Response
  try {
    response = await fetch('/api/tripspace/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return { ok: false, reason: 'unavailable', message: 'Search could not reach the site. Check the connection.', retryAfterS: null }
  }
  const parsed = searchResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    return { ok: false, reason: 'bad_response', message: `Search answered ${response.status} with an unreadable body.`, retryAfterS: null }
  }
  return parsed.data
}

/**
 * Run several searches, at most `limit` at a time, and report each result as
 * it arrives. A provider search takes seconds; this keeps a group's searches
 * from arriving at the provider all at once.
 */
export async function searchEach<K>(
  jobs: { key: K; request: SearchRequest }[],
  onResult: (key: K, response: SearchResponse) => void,
  limit = 3,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next]
      next += 1
      if (job) onResult(job.key, await search(job.request))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}
