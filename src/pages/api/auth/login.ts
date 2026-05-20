import type { APIRoute } from 'astro'
import { type AuthEnv, buildLoginRedirect, getOidcConfig } from '@/lib/auth'
import { getRuntimeEnv } from '@/lib/runtime-env'

export const GET: APIRoute = async ({ request }) => {
  const runtimeEnv = getRuntimeEnv<AuthEnv>()
  const cfg = getOidcConfig(runtimeEnv)
  if (!cfg) {
    return new Response(
      JSON.stringify({
        error: 'Auth not configured',
        message:
          'OIDC is stubbed but disabled. Set AUTH_SESSION_SECRET + OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET/OIDC_REDIRECT_URI (or Auth0/Keycloak equivalents).',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return buildLoginRedirect(request, cfg)
}
