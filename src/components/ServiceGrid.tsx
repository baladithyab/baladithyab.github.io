/**
 * ServiceGrid — interactive card-grid view of monitored services.
 *
 * Replaces the prior "list inside grouped cards" layout. Every endpoint is
 * its own card; the grid auto-fits to lateral screen real-estate using
 * `repeat(auto-fill, minmax(280px, 1fr))` so wide screens get many columns
 * and narrow ones gracefully reflow to 1.
 *
 * Adds Gatus-UI-style filtering and sort, all client-side over the same
 * endpoint list rendered server-side first (so SSR still produces the full
 * card set for crawlers — the React island just adds interactivity).
 */
import { useMemo, useState, useEffect } from 'react'
import { CheckCircle2, XCircle, ExternalLink, History, Search, X } from 'lucide-react'

export interface ServiceGridEndpoint {
  key: string
  name: string
  group: string
  category: string
  detailUrl: string
  publicUrl?: string
  current: {
    success: boolean
    status?: number
    durationMs: number
    timestamp: string
  }
  recentUptime: number
  recentSamples: number
  recentHistory: Array<boolean | null>
}

interface Props {
  endpoints: ServiceGridEndpoint[]
}

type StatusFilter = 'all' | 'up' | 'down'
type SortMode = 'category' | 'name' | 'status' | 'response' | 'uptime'

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'up', label: 'Up' },
  { key: 'down', label: 'Down' },
]

const SORTS: Array<{ key: SortMode; label: string }> = [
  { key: 'category', label: 'Category' },
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'response', label: 'Response' },
  { key: 'uptime', label: 'Uptime' },
]

function formatUptime(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const pct = ratio * 100
  if (pct >= 99.995) return '100%'
  return `${pct.toFixed(2)}%`
}

function formatResponse(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'N/A'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

function relativeAge(iso: string, nowMs: number): string {
  const seconds = Math.max(0, (nowMs - Date.parse(iso)) / 1000)
  if (seconds < 60) return `${Math.round(seconds)}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

export default function ServiceGrid({ endpoints }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('category')

  // `nowMs` is undefined on the server and during the first client render,
  // so SSR and first-hydrate produce matching markup ("just now"). Once
  // mounted we set it to the real wall-clock and refresh every minute so
  // "X minutes ago" timestamps stay current without requiring page reloads.
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const categories = useMemo(() => {
    const seen = new Map<string, number>()
    for (const ep of endpoints) {
      seen.set(ep.category, (seen.get(ep.category) ?? 0) + 1)
    }
    return Array.from(seen.entries()).map(([key, count]) => ({ key, count }))
  }, [endpoints])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = endpoints.filter((ep) => {
      if (statusFilter === 'up' && !ep.current.success) return false
      if (statusFilter === 'down' && ep.current.success) return false
      if (categoryFilter !== 'all' && ep.category !== categoryFilter) return false
      if (q && !ep.name.toLowerCase().includes(q) && !ep.category.toLowerCase().includes(q)) {
        return false
      }
      return true
    })

    out = [...out].sort((a, b) => {
      switch (sortMode) {
        case 'name':
          return a.name.localeCompare(b.name)
        case 'status':
          // down first so problems are visible
          if (a.current.success !== b.current.success) {
            return a.current.success ? 1 : -1
          }
          return a.name.localeCompare(b.name)
        case 'response':
          return a.current.durationMs - b.current.durationMs
        case 'uptime':
          return b.recentUptime - a.recentUptime
        case 'category':
        default:
          if (a.category !== b.category) return a.category.localeCompare(b.category)
          return a.name.localeCompare(b.name)
      }
    })
    return out
  }, [endpoints, statusFilter, categoryFilter, search, sortMode])

  const upCount = endpoints.filter((ep) => ep.current.success).length
  const downCount = endpoints.length - upCount

  return (
    <div className="md:col-span-6 xl:col-span-12 flex flex-col gap-4">
      {/* Filter / search / sort toolbar */}
      <div className="rounded-xl border bg-card/50 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Search */}
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name or category…"
              aria-label="Filter services"
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

          {/* Sort */}
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

        {/* Status pills + category chips */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((f) => {
            const count =
              f.key === 'all' ? endpoints.length : f.key === 'up' ? upCount : downCount
            const active = statusFilter === f.key
            const tone =
              f.key === 'up'
                ? active
                  ? 'border-green-500/60 bg-green-500/15 text-green-700 dark:text-green-400'
                  : 'border-input bg-background text-muted-foreground hover:bg-green-500/10 hover:text-green-700 dark:hover:text-green-400'
                : f.key === 'down'
                  ? active
                    ? 'border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-400'
                    : 'border-input bg-background text-muted-foreground hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-400'
                  : active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatusFilter(f.key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${tone}`}
              >
                {f.label}
                <span className="ml-1.5 tabular-nums opacity-80">{count}</span>
              </button>
            )
          })}

          <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />

          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
              (categoryFilter === 'all'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
            }
          >
            All categories
          </button>
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategoryFilter(c.key)}
              className={
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                (categoryFilter === c.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
              }
            >
              {c.key}
              <span className="ml-1.5 tabular-nums opacity-70">{c.count}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 text-xs text-muted-foreground tabular-nums">
          Showing <span className="font-semibold text-foreground">{filtered.length}</span> of{' '}
          {endpoints.length}
        </div>
      </div>

      {/* Card grid — auto-fit lateral real-estate */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">No services match the current filters.</p>
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setStatusFilter('all')
              setCategoryFilter('all')
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
          {filtered.map((ep) => (
            <ServiceCard key={ep.key} endpoint={ep} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  )
}

function ServiceCard({
  endpoint,
  nowMs,
}: {
  endpoint: ServiceGridEndpoint
  nowMs: number | undefined
}) {
  const ok = endpoint.current.success
  const StatusIcon = ok ? CheckCircle2 : XCircle
  const statusColor = ok
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'

  // Anchor target — prefer the public app URL when it's known and the
  // service is up. Otherwise deep-link into Gatus's detail page.
  const primaryHref = endpoint.publicUrl ?? endpoint.detailUrl
  const primaryLabel = endpoint.publicUrl
    ? `Open ${endpoint.name}`
    : `View ${endpoint.name} on Gatus`

  return (
    <div
      className={
        'group relative flex flex-col gap-2.5 rounded-xl border bg-card p-3.5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md ' +
        (ok ? '' : 'border-red-500/30 bg-red-500/[0.02]')
      }
    >
      {/* Header row: name + status icon */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <a
            href={primaryHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={primaryLabel}
            className="block truncate text-sm font-semibold leading-tight hover:underline"
            title={endpoint.name}
          >
            {endpoint.name}
          </a>
          <div className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-muted-foreground">
            {endpoint.category}
          </div>
        </div>
        <StatusIcon className={`size-5 shrink-0 ${statusColor}`} aria-hidden="true" />
      </div>

      {/* Sparkline */}
      <div
        className="flex h-7 items-end gap-[2px]"
        aria-label={`Last ${endpoint.recentSamples} probes`}
      >
        {endpoint.recentHistory.map((bucket, i) => {
          const tone =
            bucket === null
              ? 'bg-muted/40'
              : bucket
                ? 'bg-green-500/70 group-hover:bg-green-500'
                : 'bg-red-500/80 group-hover:bg-red-500'
          return (
            <span
              key={i}
              className={`flex-1 rounded-sm ${tone}`}
              style={{ height: bucket === null ? '30%' : bucket ? '100%' : '60%' }}
            />
          )
        })}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-1.5 text-[11px]">
        <div className="rounded-md border bg-background/60 px-1.5 py-1">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Up</div>
          <div className="font-semibold tabular-nums">
            {formatUptime(endpoint.recentUptime)}
          </div>
        </div>
        <div className="rounded-md border bg-background/60 px-1.5 py-1">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">RT</div>
          <div className="font-semibold tabular-nums">
            {formatResponse(endpoint.current.durationMs)}
          </div>
        </div>
        <div className="rounded-md border bg-background/60 px-1.5 py-1">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">HTTP</div>
          <div className="font-semibold tabular-nums">{endpoint.current.status ?? '—'}</div>
        </div>
      </div>

      {/* Footer: links + last seen */}
      <div className="flex items-center justify-between gap-2 border-t pt-2 text-[11px]">
        <span className="text-muted-foreground" title={endpoint.current.timestamp}>
          {nowMs === undefined ? 'just now' : relativeAge(endpoint.current.timestamp, nowMs)}
        </span>
        <div className="flex items-center gap-1">
          {endpoint.publicUrl && (
            <a
              href={endpoint.publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${endpoint.name}`}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] hover:bg-muted"
            >
              <ExternalLink className="size-3" />
              Open
            </a>
          )}
          <a
            href={endpoint.detailUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View ${endpoint.name} history on Gatus`}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] hover:bg-muted"
          >
            <History className="size-3" />
            History
          </a>
        </div>
      </div>
    </div>
  )
}
