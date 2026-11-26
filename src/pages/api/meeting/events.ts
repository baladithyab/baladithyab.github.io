/**
 * Upcoming events for the meeting-point lab, proxied from Ticketmaster so
 * `TICKETMASTER_API_KEY` stays on the server. Contract and limits:
 * `src/lib/meeting-live-server.ts`.
 */
import type { APIRoute } from 'astro'
import { handleEventsRequest, type LiveEnv } from '@/lib/meeting-live-server'
import { getRuntimeEnv } from '@/lib/runtime-env'

export const prerender = false

export const GET: APIRoute = ({ request }) =>
  handleEventsRequest(request, getRuntimeEnv<LiveEnv>())
