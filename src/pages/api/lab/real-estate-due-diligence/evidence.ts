import type { APIRoute } from 'astro'
import { edgeCache } from '@/lib/meeting-live-server'
import { getRuntimeEnv } from '@/lib/runtime-env'
import {
  handlePropertyEvidenceRequest,
  type PropertyEvidenceEnv,
} from '@/lib/site-study-property-evidence'

export const prerender = false

export const GET: APIRoute = ({ request }) =>
  handlePropertyEvidenceRequest(
    request,
    getRuntimeEnv<PropertyEvidenceEnv>(),
    edgeCache(),
  )
