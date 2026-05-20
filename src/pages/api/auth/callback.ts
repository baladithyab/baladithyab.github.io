import type { APIRoute } from 'astro'
import { type AuthEnv, getOidcConfig, handleCallback } from '@/lib/auth'
import { getRuntimeEnv } from '@/lib/runtime-env'

export const GET: APIRoute = async ({ request }) => {
  const runtimeEnv = getRuntimeEnv<AuthEnv>()
  const cfg = getOidcConfig(runtimeEnv)
  if (!cfg) return new Response('Auth not configured', { status: 503 })
  return handleCallback(request, cfg)
}
