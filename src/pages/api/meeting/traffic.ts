/**
 * Live traffic incidents for the meeting-point lab, proxied from TomTom so
 * `TOMTOM_API_KEY` stays on the server. Contract and limits:
 * `src/lib/meeting-live-server.ts`.
 */
import type { APIRoute } from 'astro'
import { handleTrafficRequest, type LiveEnv } from '@/lib/meeting-live-server'
import { getRuntimeEnv } from '@/lib/runtime-env'

export const prerender = false

export const GET: APIRoute = ({ request }) =>
  handleTrafficRequest(request, getRuntimeEnv<LiveEnv>())
