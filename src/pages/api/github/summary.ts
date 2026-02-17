import type { APIRoute } from 'astro'
import { getGitHubSummary } from '@/lib/github'

export const GET: APIRoute = async ({ locals }) => {
  const runtimeEnv = (locals as any).runtime?.env
  const summary = await getGitHubSummary(runtimeEnv)

  if (!summary) {
    return new Response(
      JSON.stringify({
        error: 'GitHub summary unavailable',
        hint: 'Check GitHub API reachability and/or set GITHUB_TOKEN to avoid rate limits.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Allow edge cache; Cloudflare runtime cache is handled inside getGitHubSummary() as well.
      'Cache-Control': 'public, max-age=300',
    },
  })
}

