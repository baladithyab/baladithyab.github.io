import type { APIRoute } from 'astro'
import { getOidcConfig, handleCallback } from '@/lib/auth'

export const GET: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any).runtime?.env
  const cfg = getOidcConfig(runtimeEnv)
  if (!cfg) return new Response('Auth not configured', { status: 503 })
  return handleCallback(request, cfg)
}

