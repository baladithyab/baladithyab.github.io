import type { APIRoute } from 'astro'
import { getOidcConfig, getSessionFromRequest } from '@/lib/auth'

export const GET: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any).runtime?.env
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

