/**
 * ProjectViewer — combined React island for a project's asset tab strip
 * + active-asset embed. Mounted once per project page so URL state and
 * embed render share a single source of truth.
 *
 * URL semantics:
 * - No query → render `defaultAssetId`
 * - `?asset=<id>` → render that asset (state updates via popstate too)
 * - `?v=<sha>` → handled in `[slug].astro`'s SSR (different
 *   `deliveryUrl` is computed at request time before this island
 *   mounts)
 *
 * Single-asset case: AssetTabs renders nothing, but the island still
 * mounts so the future version-picker can drive a re-render without
 * code duplication.
 */

import EmbedRouter from './EmbedRouter'
import AssetTabs, { useAssetSelection } from './AssetTabs'
import type { Asset } from '@/lib/types/project-manifest'

interface ProjectViewerProps {
  assets: Asset[]
  defaultAssetId: string
  /** Shared delivery prefix (already includes the `<sha>` segment). */
  deliveryUrl: string
}

export default function ProjectViewer({ assets, defaultAssetId, deliveryUrl }: ProjectViewerProps) {
  const [activeId, setActiveId] = useAssetSelection(assets, defaultAssetId)
  const active = assets.find(a => a.id === activeId) ?? assets[0]!

  return (
    <div>
      {assets.length > 1 && (
        <AssetTabs
          assets={assets}
          activeId={active.id}
          hrefFor={(id) => {
            // Build a real href so right-click / copy-link / open-in-
            // new-tab works. Default-asset → no query string.
            if (id === defaultAssetId) {
              if (typeof window === 'undefined') return ''
              const u = new URL(window.location.href)
              u.searchParams.delete('asset')
              return u.search || ''
            }
            if (typeof window === 'undefined') return `?asset=${id}`
            const u = new URL(window.location.href)
            u.searchParams.set('asset', id)
            return u.search
          }}
          onSelect={setActiveId}
        />
      )}

      <EmbedRouter asset={active} deliveryUrl={deliveryUrl} />

      {active.description && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{active.description}</p>
      )}
    </div>
  )
}
