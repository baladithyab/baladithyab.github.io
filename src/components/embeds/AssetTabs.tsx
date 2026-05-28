/**
 * AssetTabs — tab strip for switching between assets on a multi-asset
 * project page.
 *
 * Layout pattern: horizontally scrollable when assets > viewport, grouped
 * visually by `asset.group` when projects declare groups (e.g. "Demos" /
 * "Writeups" / "Source").
 *
 * For single-asset projects, the parent route should skip rendering this
 * component entirely — `assets.length === 1` makes a tab strip noise.
 */

import type { Asset } from '@/lib/types/project-manifest'

interface AssetTabsProps {
  assets: Asset[]
  /** id of the currently-active asset. */
  activeId: string
  /** Build a real href for each asset (so the tab works without JS and
   *  shows the correct hover URL). The parent uses this to render
   *  `?asset=<id>`-style links that match the URL state. */
  hrefFor: (assetId: string) => string
  /** Called when a tab is clicked. Receives the asset id. The parent
   *  uses this to update its own state without a full page reload — but
   *  the tab is still a real <a> with a real href so JS-off / open-in-
   *  new-tab still works. */
  onSelect: (assetId: string) => void
}

/**
 * Group assets by their `group` field, preserving original order within
 * each group. Assets without a group land in a synthetic "Default"
 * bucket which renders without a header.
 */
function groupAssets(assets: Asset[]): Array<{ group: string | null; items: Asset[] }> {
  const buckets = new Map<string | null, Asset[]>()
  for (const a of assets) {
    const key = a.group ?? null
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(a)
  }
  return [...buckets.entries()].map(([group, items]) => ({ group, items }))
}

export default function AssetTabs({ assets, activeId, hrefFor, onSelect }: AssetTabsProps) {
  const groups = groupAssets(assets)

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {groups.map((g, gi) => (
        <div key={g.group ?? `__default_${gi}`} className="flex items-center gap-2">
          {g.group && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {g.group}
            </span>
          )}
          <div className="flex flex-wrap gap-1">
            {g.items.map(asset => {
              const active = asset.id === activeId
              return (
                <a
                  key={asset.id}
                  href={hrefFor(asset.id)}
                  onClick={(e) => {
                    // Modifier-click → let the browser handle (open in
                    // new tab, etc.). Plain click → swap state in place.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                    e.preventDefault()
                    onSelect(asset.id)
                  }}
                  className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  {asset.title}
                </a>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Hook for keeping a `selectedAssetId` state in sync with the
 * `?asset=<id>` query parameter. Two-way: external query changes (back/
 * forward) update state; calling `setSelectedAssetId(...)` updates state
 * and pushes a new history entry without reloading.
 */
import { useEffect, useState } from 'react'

export function useAssetSelection(
  assets: Asset[],
  defaultAssetId: string,
): [string, (id: string) => void] {
  const ids = assets.map(a => a.id)
  const [selectedId, setSelectedId] = useState<string>(() => {
    if (typeof window === 'undefined') return defaultAssetId
    const fromUrl = new URLSearchParams(window.location.search).get('asset')
    return fromUrl && ids.includes(fromUrl) ? fromUrl : defaultAssetId
  })

  useEffect(() => {
    const onPop = () => {
      const fromUrl = new URLSearchParams(window.location.search).get('asset')
      setSelectedId(fromUrl && ids.includes(fromUrl) ? fromUrl : defaultAssetId)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAssetId, ids.join(',')])

  function select(id: string): void {
    if (!ids.includes(id)) return
    setSelectedId(id)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (id === defaultAssetId) {
      url.searchParams.delete('asset')
    } else {
      url.searchParams.set('asset', id)
    }
    window.history.pushState({}, '', url.toString())
  }

  return [selectedId, select]
}
