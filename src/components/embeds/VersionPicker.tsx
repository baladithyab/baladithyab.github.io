/**
 * VersionPicker — sidebar widget that lists every R2 version of a
 * project and lets the visitor flip between them.
 *
 * Uses the `/api/projects/<slug>/versions` endpoint (lazy-fetched on
 * mount). When the visitor picks a non-current version, navigation goes
 * to `/projects/<slug>?v=<id>` which the page's SSR re-resolves to a
 * different `delivery.url` prefix.
 *
 * Design choices:
 * - Lazy fetch on mount so the slug page's TTFB isn't blocked. A small
 *   "Loading versions…" placeholder is fine for the sidebar.
 * - One entry per version with version id, "current" badge, and click-
 *   to-switch.
 * - Errors fall through silently — version picker is a nice-to-have,
 *   not a requirement for the page to be useful.
 */

import { useEffect, useState } from 'react'
import { History, Check, Loader2 } from 'lucide-react'

interface VersionPickerProps {
  slug: string
  /** The version pinned by the manifest (today's "current"). */
  currentVersion: string
  /** The version the page is actually rendering (may differ from
   *  currentVersion if the visitor came in via `?v=...`). */
  activeVersion: string
}

interface VersionEntry {
  id: string
  lastModified?: string
  sizeBytes?: number
}

interface VersionsResponse {
  ok: boolean
  slug: string
  versions: VersionEntry[]
  error?: string
}

export default function VersionPicker({ slug, currentVersion, activeVersion }: VersionPickerProps) {
  const [versions, setVersions] = useState<VersionEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/projects/${slug}/versions`, { headers: { Accept: 'application/json' } })
      .then(r => r.json() as Promise<VersionsResponse>)
      .then((data: VersionsResponse) => {
        if (cancelled) return
        if (data.ok) {
          setVersions(data.versions)
        } else {
          setError(data.error ?? 'unknown error')
        }
        setLoading(false)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  function hrefFor(versionId: string): string {
    // Pinned (manifest) version → no `?v` query (clean canonical URL).
    if (versionId === currentVersion) return `/projects/${slug}`
    return `/projects/${slug}?v=${encodeURIComponent(versionId)}`
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading versions…
      </div>
    )
  }

  if (error || !versions) {
    return (
      <p className="text-xs text-muted-foreground">
        Versions unavailable {error ? <span className="font-mono">({error})</span> : null}
      </p>
    )
  }

  if (versions.length === 0) {
    return <p className="text-xs text-muted-foreground">No versions yet.</p>
  }

  return (
    <ul className="space-y-1.5">
      {versions.map(v => {
        const isCurrent = v.id === currentVersion
        const isActive = v.id === activeVersion
        return (
          <li key={v.id}>
            <a
              href={hrefFor(v.id)}
              className={`group flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                isActive
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-transparent hover:border-border hover:bg-muted/50'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="flex items-center gap-1.5 truncate font-mono text-foreground">
                <History className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{v.id}</span>
              </span>
              {isCurrent && (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-400">
                  <Check className="size-2.5" />
                  current
                </span>
              )}
            </a>
          </li>
        )
      })}
    </ul>
  )
}
