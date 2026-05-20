import type { APIRoute } from 'astro'
import { type AuthEnv, getOidcConfig, handleLogout } from '@/lib/auth'
import { getRuntimeEnv } from '@/lib/runtime-env'

export const GET: APIRoute = async ({ request }) => {
  const runtimeEnv = getRuntimeEnv<AuthEnv>()
  const cfg = getOidcConfig(runtimeEnv)
  if (!cfg) {
    // Local logout only
    return new Response(null, { status: 302, headers: { Location: '/' } })
  }
  return handleLogout(request, cfg)
}
