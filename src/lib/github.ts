/**
 * GitHub API client — fetches a public profile + repository summary, cached
 * in `caches.default` for 60s so the Worker doesn't hammer the GitHub API.
 *
 * `GITHUB_TOKEN` (Worker secret) is optional. With it set, requests jump
 * from 60 req/hr (unauth) to 5000 req/hr (auth).
 */

/** A trimmed-down repository shape suitable for client-side card rendering. */
export type Repo = {
  name: string
  html_url: string
  description: string
  updated_at: string
  /** Primary language detected by GitHub. `null` when none / unknown. */
  language?: string | null
  /** Stargazer count. Optional for backwards compat with older callers. */
  stars?: number
}

export interface GitHubEnv {
  GITHUB_TOKEN?: string
}

interface GitHubUser {
  login: string
  html_url: string
  public_repos: number
  followers: number
  following: number
}

interface GitHubRepo {
  name: string
  html_url: string
  description: string | null
  updated_at: string
  fork: boolean
  private: boolean
  language: string | null
  stargazers_count: number
}

export interface GitHubSummary {
  user: GitHubUser
  topRepos: Repo[]
  stars: number
  topLanguages: Array<{ language: string; count: number }>
}

function buildHeaders(runtimeEnv?: GitHubEnv) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'codeseys-website',
  }
  if (runtimeEnv?.GITHUB_TOKEN) headers.Authorization = `Bearer ${runtimeEnv.GITHUB_TOKEN}`
  return headers
}

export async function getGitHubSummary(runtimeEnv?: GitHubEnv): Promise<GitHubSummary | null> {
  try {
    if (typeof caches !== 'undefined' && 'default' in caches) {
      const cacheKey = new Request('https://codeseys.io/api/github/summary')
      const cache = (caches as any).default
      const cached = await cache.match(cacheKey)
      if (cached) return cached.json()
    }

    const headers = buildHeaders(runtimeEnv)
    const username = 'baladithyab'

    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${username}`, { headers }),
      fetch(`https://api.github.com/users/${username}/repos?type=all&sort=pushed&per_page=100`, { headers }),
    ])

    if (!userRes.ok) {
      console.error('GitHub user API error:', userRes.status, userRes.statusText)
      return null
    }
    if (!reposRes.ok) {
      console.error('GitHub repos API error:', reposRes.status, reposRes.statusText)
      return null
    }

    const user: GitHubUser = await userRes.json()
    const repos: GitHubRepo[] = await reposRes.json()

    const publicNonFork = repos.filter((r) => !r.fork && !r.private)

    const topRepos: Repo[] = publicNonFork
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 30)
      .map((repo) => ({
        name: repo.name,
        html_url: repo.html_url,
        description: repo.description || 'No description',
        updated_at: repo.updated_at,
        language: repo.language,
        stars: repo.stargazers_count,
      }))

    const stars = publicNonFork.reduce((sum, r) => sum + (r.stargazers_count || 0), 0)

    const langCount = new Map<string, number>()
    for (const r of publicNonFork) {
      if (!r.language) continue
      langCount.set(r.language, (langCount.get(r.language) ?? 0) + 1)
    }
    const topLanguages = [...langCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([language, count]) => ({ language, count }))

    const summary: GitHubSummary = { user, topRepos, stars, topLanguages }

    if (typeof caches !== 'undefined' && 'default' in caches) {
      const cacheKey = new Request('https://codeseys.io/api/github/summary')
      const cache = (caches as any).default
      const newResponse = new Response(JSON.stringify(summary), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600',
          ETag: `"${Date.now()}"`,
        },
      })
      await cache.put(cacheKey, newResponse.clone())
    }

    return summary
  } catch (err) {
    console.error('Error fetching GitHub summary:', err)
    return null
  }
}
