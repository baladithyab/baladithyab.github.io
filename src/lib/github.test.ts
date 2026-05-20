/**
 * Smoke tests for src/lib/github.ts
 *
 * Verifies:
 *   - happy-path summary aggregation (stars, top repos, top languages)
 *   - non-OK responses → null
 *   - fetch rejection → null
 *   - GITHUB_TOKEN injection into Authorization header
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getGitHubSummary } from './github'

interface RawRepo {
  name: string
  html_url: string
  description: string | null
  updated_at: string
  fork: boolean
  private: boolean
  language: string | null
  stargazers_count: number
}

const sampleUser = {
  login: 'baladithyab',
  html_url: 'https://github.com/baladithyab',
  public_repos: 52,
  followers: 10,
  following: 5,
}

const sampleRepos: RawRepo[] = [
  {
    name: 'recent-1',
    html_url: 'https://github.com/baladithyab/recent-1',
    description: 'newest',
    updated_at: '2025-06-15T00:00:00Z',
    fork: false,
    private: false,
    language: 'TypeScript',
    stargazers_count: 100,
  },
  {
    name: 'older-2',
    html_url: 'https://github.com/baladithyab/older-2',
    description: null,
    updated_at: '2024-01-01T00:00:00Z',
    fork: false,
    private: false,
    language: 'TypeScript',
    stargazers_count: 50,
  },
  {
    name: 'forked',
    html_url: 'https://github.com/baladithyab/forked',
    description: 'should be excluded',
    updated_at: '2025-06-20T00:00:00Z',
    fork: true,
    private: false,
    language: 'Python',
    stargazers_count: 999,
  },
  {
    name: 'private-repo',
    html_url: 'https://github.com/baladithyab/private-repo',
    description: 'should be excluded',
    updated_at: '2025-07-01T00:00:00Z',
    fork: false,
    private: true,
    language: 'Rust',
    stargazers_count: 999,
  },
  {
    name: 'python-project',
    html_url: 'https://github.com/baladithyab/python-project',
    description: 'a py thing',
    updated_at: '2025-05-01T00:00:00Z',
    fork: false,
    private: false,
    language: 'Python',
    stargazers_count: 25,
  },
]

function makeFetchMock(opts: {
  userStatus?: number
  reposStatus?: number
  user?: unknown
  repos?: unknown
} = {}) {
  const userStatus = opts.userStatus ?? 200
  const reposStatus = opts.reposStatus ?? 200
  const user = opts.user ?? sampleUser
  const repos = opts.repos ?? sampleRepos

  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/repos')) {
      return Promise.resolve(new Response(JSON.stringify(repos), { status: reposStatus }))
    }
    return Promise.resolve(new Response(JSON.stringify(user), { status: userStatus }))
  })
}

describe('getGitHubSummary', () => {
  let originalFetch: typeof globalThis.fetch
  let originalCaches: typeof globalThis.caches | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalCaches = (globalThis as { caches?: typeof globalThis.caches }).caches
    delete (globalThis as { caches?: typeof globalThis.caches }).caches
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalCaches) {
      (globalThis as { caches?: typeof globalThis.caches }).caches = originalCaches
    }
    vi.restoreAllMocks()
  })

  it('aggregates stars across non-fork, non-private repos', async () => {
    globalThis.fetch = makeFetchMock()
    const summary = await getGitHubSummary()
    expect(summary).not.toBeNull()
    // 100 + 50 + 25 = 175 (forked & private excluded)
    expect(summary!.stars).toBe(175)
  })

  it('returns top 5 repos sorted by updated_at desc', async () => {
    globalThis.fetch = makeFetchMock()
    const summary = await getGitHubSummary()
    expect(summary!.topRepos[0].name).toBe('recent-1')
    expect(summary!.topRepos.map((r) => r.name)).not.toContain('forked')
    expect(summary!.topRepos.map((r) => r.name)).not.toContain('private-repo')
  })

  it('produces topLanguages sorted by count desc', async () => {
    globalThis.fetch = makeFetchMock()
    const summary = await getGitHubSummary()
    // TypeScript: 2 repos, Python: 1 repo (excluding forked).
    expect(summary!.topLanguages[0]).toEqual({ language: 'TypeScript', count: 2 })
    expect(summary!.topLanguages[1]).toEqual({ language: 'Python', count: 1 })
  })

  it('uses "No description" placeholder when null', async () => {
    globalThis.fetch = makeFetchMock()
    const summary = await getGitHubSummary()
    const older = summary!.topRepos.find((r) => r.name === 'older-2')!
    expect(older.description).toBe('No description')
  })

  it('returns null when user fetch is non-OK', async () => {
    globalThis.fetch = makeFetchMock({ userStatus: 500 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getGitHubSummary()).toBeNull()
  })

  it('returns null when repos fetch is non-OK', async () => {
    globalThis.fetch = makeFetchMock({ reposStatus: 403 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getGitHubSummary()).toBeNull()
  })

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getGitHubSummary()).toBeNull()
  })

  it('injects Bearer token when GITHUB_TOKEN is set', async () => {
    const fetchMock = makeFetchMock()
    globalThis.fetch = fetchMock

    await getGitHubSummary({ GITHUB_TOKEN: 'ghp_abc123' })

    // Inspect headers passed to the first fetch call.
    const firstCallInit = fetchMock.mock.calls[0][1] as RequestInit
    const headers = firstCallInit.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ghp_abc123')
  })

  it('omits Authorization header when no token is set', async () => {
    const fetchMock = makeFetchMock()
    globalThis.fetch = fetchMock

    await getGitHubSummary()

    const firstCallInit = fetchMock.mock.calls[0][1] as RequestInit
    const headers = firstCallInit.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})
