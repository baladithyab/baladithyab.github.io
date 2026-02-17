import type { APIRoute } from 'astro'
import { getOidcConfig, handleLogout } from '@/lib/auth'

export const GET: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any).runtime?.env
  const cfg = getOidcConfig(runtimeEnv)
  if (!cfg) {
    // Local logout only
    return new Response(null, { status: 302, headers: { Location: '/' } })
  }
  return handleLogout(request, cfg)
}

