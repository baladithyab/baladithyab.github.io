import type { APIRoute } from 'astro'
import { type AuthEnv, getOidcConfig, getSessionFromRequest } from '@/lib/auth'
import { getRuntimeEnv } from '@/lib/runtime-env'

export const GET: APIRoute = async ({ request }) => {
  const runtimeEnv = getRuntimeEnv<AuthEnv>()
  const cfg = getOidcConfig(runtimeEnv)
  if (!cfg) {
    return new Response(JSON.stringify({ configured: false, user: null, session: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const authed = await getSessionFromRequest(request, cfg)
  return new Response(
    JSON.stringify({
      configured: true,
      user: authed?.user ?? null,
      session: authed?.session
        ? { ...authed.session, expiresAt: authed.session.expiresAt.toISOString() }
        : null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}
