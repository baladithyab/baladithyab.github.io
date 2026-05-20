/**
 * BlogGrid — interactive card-grid view of blog posts.
 *
 * Mirrors ServiceGrid (status) and RepoGrid (profile):
 *   - One card per post, auto-filling lateral columns at every viewport.
 *   - Toolbar with search, tag-filter chips, and sort modes (Recent / Title).
 *   - SSR pre-renders rich-text previews into HTML — passed as a string and
 *     mounted via `dangerouslySetInnerHTML`. Crawlers see the full preview.
 */
import { useMemo, useState } from 'react'
import { Calendar, Edit, Search, Tag, X } from 'lucide-react'

export interface BlogGridPost {
  id: string
  href: string
  title: string
  description: string
  /** Pre-rendered HTML preview produced by `getRichPreview` at SSR time. */
  previewHtml: string | null
  publishedAt: string
  updatedAt: string | null
  tags: string[]
  /** Pre-formatted dates so the client doesn't need a date library. */
  publishedAtDisplay: string
  updatedAtDisplay: string | null
}

interface Props {
  posts: BlogGridPost[]
}

type SortMode = 'recent' | 'title'

const SORTS: Array<{ key: SortMode; label: string }> = [
  { key: 'recent', label: 'Recent' },
  { key: 'title', label: 'Title' },
]

export default function BlogGrid({ posts }: Props) {
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  const tags = useMemo(() => {
    const seen = new Map<string, number>()
    for (const p of posts) {
      for (const t of p.tags) seen.set(t, (seen.get(t) ?? 0) + 1)
    }
    return Array.from(seen.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  }, [posts])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = posts.filter((p) => {
      if (tagFilter !== 'all' && !p.tags.includes(tagFilter)) return false
      if (
        q &&
        !p.title.toLowerCase().includes(q) &&
        !p.description.toLowerCase().includes(q) &&
        !p.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        return false
      }
      return true
    })
    out = [...out].sort((a, b) => {
      switch (sortMode) {
        case 'title':
          return a.title.localeCompare(b.title)
        case 'recent':
        default:
          return Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
      }
    })
    return out
  }, [posts, tagFilter, search, sortMode])

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
              placeholder="Filter by title, description, or tag…"
              aria-label="Filter posts"
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

        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTagFilter('all')}
              className={
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                (tagFilter === 'all'
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
              }
            >
              All
              <span className="ml-1.5 tabular-nums opacity-80">{posts.length}</span>
            </button>
            {tags.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTagFilter(t.key)}
                className={
                  'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                  (tagFilter === t.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                <Tag className="size-3" />
                {t.key}
                <span className="tabular-nums opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 text-xs text-muted-foreground tabular-nums">
          Showing <span className="font-semibold text-foreground">{filtered.length}</span> of{' '}
          {posts.length}
        </div>
      </div>

      {/* Card grid */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">No posts match the current filters.</p>
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setTagFilter('all')
            }}
            className="mt-3 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <div
          className="grid auto-rows-fr gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
        >
          {filtered.map((p) => (
            <BlogCard key={p.id} post={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function BlogCard({ post }: { post: BlogGridPost }) {
  return (
    <a
      href={post.href}
      data-astro-prefetch
      className="group flex h-full flex-col gap-2.5 rounded-xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <h2 className="text-base font-semibold leading-snug group-hover:text-primary">
        {post.title}
      </h2>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Calendar className="size-3" />
          {post.publishedAtDisplay}
        </span>
        {post.updatedAtDisplay && (
          <span className="inline-flex items-center gap-1">
            <Edit className="size-3" />
            {post.updatedAtDisplay}
          </span>
        )}
      </div>

      {post.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {post.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="blog-preview flex-1 text-xs text-muted-foreground">
        {post.previewHtml ? (
          <div dangerouslySetInnerHTML={{ __html: post.previewHtml }} />
        ) : (
          <p>{post.description}</p>
        )}
      </div>

      <div className="mt-auto pt-1 text-[11px] font-medium text-primary group-hover:underline">
        Read more →
      </div>
    </a>
  )
}
