import type { APIRoute } from 'astro'
import { edgeCache } from '@/lib/meeting-live-server'
import { getRuntimeEnv } from '@/lib/runtime-env'
import {
  handleLiveListingsRequest,
  type HomeHarvestEnv,
} from '@/lib/site-study-live-listings'

export const prerender = false

export const GET: APIRoute = ({ request }) =>
  handleLiveListingsRequest(
    request,
    getRuntimeEnv<HomeHarvestEnv>(),
    edgeCache(),
  )
