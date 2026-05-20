/**
 * RepoGrid — interactive card-grid view of public GitHub repositories.
 *
 * Mirrors the ServiceGrid pattern from /status:
 *   - One card per repo, auto-filling lateral columns at every viewport.
 *   - Toolbar with search, language-filter chips, and sort modes
 *     (Recent / Stars / Name).
 *   - SSR-safe relative timestamps (`just now` until hydrated).
 */
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Search, Star, X } from 'lucide-react'
import type { Repo } from '@/lib/github'

interface Props {
  repos: Repo[]
}

type SortMode = 'recent' | 'stars' | 'name'

const SORTS: Array<{ key: SortMode; label: string }> = [
  { key: 'recent', label: 'Recent' },
  { key: 'stars', label: 'Stars' },
  { key: 'name', label: 'Name' },
]

// Map known language names to a hue (0–360) so the language dot stays
// stable across re-renders and roughly matches GitHub's colour palette.
function languageColor(language: string): string {
  const map: Record<string, string> = {
    TypeScript: '#3178c6',
    JavaScript: '#f1e05a',
    Python: '#3572a5',
    Go: '#00add8',
    Rust: '#dea584',
    Java: '#b07219',
    'C++': '#f34b7d',
    C: '#555555',
    Shell: '#89e051',
    HTML: '#e34c26',
    CSS: '#563d7c',
    Astro: '#ff5d01',
    Svelte: '#ff3e00',
    Vue: '#41b883',
    Ruby: '#701516',
    PHP: '#4f5d95',
    Swift: '#f05138',
    Kotlin: '#a97bff',
    Dart: '#00b4ab',
    Solidity: '#aa6746',
    Lua: '#000080',
    Zig: '#ec915c',
    Dockerfile: '#384d54',
    HCL: '#844fba',
  }
  if (map[language]) return map[language]
  // Stable hash → hue for unknown languages
  let hash = 0
  for (const ch of language) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff
  return `hsl(${Math.abs(hash) % 360}, 60%, 55%)`
}

function relativeAge(iso: string, nowMs: number): string {
  const seconds = Math.max(0, (nowMs - Date.parse(iso)) / 1000)
  if (seconds < 60) return `${Math.round(seconds)}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  if (seconds < 2_592_000) return `${Math.round(seconds / 86400)}d ago`
  if (seconds < 31_536_000) return `${Math.round(seconds / 2_592_000)}mo ago`
  return `${Math.round(seconds / 31_536_000)}y ago`
}

export default function RepoGrid({ repos }: Props) {
  const [search, setSearch] = useState('')
  const [languageFilter, setLanguageFilter] = useState<string>('all')
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  // SSR-safe wall clock (matches first hydrate, then ticks). See ServiceGrid
  // for the rationale — same hydration-mismatch fix.
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const languages = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of repos) {
      const lang = r.language ?? 'Unknown'
      seen.set(lang, (seen.get(lang) ?? 0) + 1)
    }
    return Array.from(seen.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
  }, [repos])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = repos.filter((r) => {
      if (languageFilter !== 'all') {
        const lang = r.language ?? 'Unknown'
        if (lang !== languageFilter) return false
      }
      if (
        q &&
        !r.name.toLowerCase().includes(q) &&
        !(r.description ?? '').toLowerCase().includes(q) &&
        !(r.language ?? '').toLowerCase().includes(q)
      ) {
        return false
      }
      return true
    })

    out = [...out].sort((a, b) => {
      switch (sortMode) {
        case 'stars':
          return (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name)
        case 'name':
          return a.name.localeCompare(b.name)
        case 'recent':
        default:
          return Date.parse(b.updated_at) - Date.parse(a.updated_at)
      }
    })
    return out
  }, [repos, languageFilter, search, sortMode])

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="rounded-xl border bg-card/50 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by repo name, description, or language…"
              aria-label="Filter repositories"
              className="h-9 w-full rounded-md border bg-background pl-9 pr-9 text-sm placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="hidden text-muted-foreground sm:inline">Sort:</span>
            <div className="flex flex-wrap gap-1">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSortMode(s.key)}
                  className={
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ' +
                    (sortMode === s.key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setLanguageFilter('all')}
            className={
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
              (languageFilter === 'all'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
            }
          >
            All
            <span className="ml-1.5 tabular-nums opacity-80">{repos.length}</span>
          </button>
          {languages.map((lang) => {
            const active = languageFilter === lang.key
            return (
              <button
                key={lang.key}
                type="button"
                onClick={() => setLanguageFilter(lang.key)}
                className={
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                  (active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                {lang.key !== 'Unknown' && (
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: languageColor(lang.key) }}
                    aria-hidden="true"
                  />
                )}
                {lang.key}
                <span className="tabular-nums opacity-70">{lang.count}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-3 text-xs text-muted-foreground tabular-nums">
          Showing <span className="font-semibold text-foreground">{filtered.length}</span> of{' '}
          {repos.length}
        </div>
      </div>

      {/* Card grid */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No repositories match the current filters.
          </p>
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setLanguageFilter('all')
            }}
            className="mt-3 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <div
          className="grid auto-rows-fr gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
        >
          {filtered.map((r) => (
            <RepoCard key={r.html_url} repo={r} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  )
}

function RepoCard({ repo, nowMs }: { repo: Repo; nowMs: number | undefined }) {
  const lang = repo.language ?? null
  return (
    <a
      href={repo.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex h-full flex-col gap-2.5 rounded-xl border bg-card p-3.5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold leading-tight group-hover:underline">
              {repo.name}
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary" />
          </div>
        </div>
      </div>

      <p className="line-clamp-3 flex-1 text-xs text-muted-foreground">
        {repo.description}
      </p>

      <div className="flex items-center justify-between gap-2 border-t pt-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          {lang && (
            <span className="inline-flex items-center gap-1 truncate">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: languageColor(lang) }}
                aria-hidden="true"
              />
              <span className="truncate text-muted-foreground">{lang}</span>
            </span>
          )}
          {(repo.stars ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Star className="size-3" />
              <span className="tabular-nums">{repo.stars}</span>
            </span>
          )}
        </div>
        <span
          className="shrink-0 text-muted-foreground tabular-nums"
          title={repo.updated_at}
        >
          {nowMs === undefined ? 'just now' : relativeAge(repo.updated_at, nowMs)}
        </span>
      </div>
    </a>
  )
}
