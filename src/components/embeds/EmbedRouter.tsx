/**
 * EmbedRouter — switches on `manifest.embed.kind` and dispatches to the
 * matching renderer. Single entry point used by `/projects/[slug].astro`.
 *
 * Most embed kinds reduce to "load an HTML document in an iframe":
 * - `static-html` — load `delivery.url + embed.entry`
 * - `notebook-html` — same, but the entry is the notebook's HTML export
 * - `external-app` — load `embed.url` (foreign origin, sandboxed strictly)
 * - `tex-pdf` — load the PDF in an iframe (browser PDF viewer handles it)
 * - `wasm-emscripten` / `wasm-rust` — Emscripten/wasm-bindgen produce a
 *   self-contained HTML harness; we point the iframe at that harness URL.
 *   A future first-party React harness can replace this for finer control,
 *   but the iframe path is correct and simple for v1.
 *
 * The kinds that *can't* be reduced to an iframe yet:
 * - `pyodide` — needs a React component that boots Pyodide on the page,
 *   loads the entry, and renders stdout/stdin. Stub for now.
 * - `pglite-db` — needs a PGlite-style WASM postgres or mongo-shaped
 *   browser DB. Stub for now (CSCI 585's pilot will define the shape).
 *
 * When we add real renderers for those, replace the stub branches with
 * imports of `WasmEmbed`, `PyodideEmbed`, `PGliteEmbed`, etc.
 */

import type { ProjectEntry } from '@/lib/types/project-manifest'
import IframeEmbed from './IframeEmbed'

interface EmbedRouterProps {
  entry: ProjectEntry
}

/**
 * Build the absolute URL of the entry HTML for kinds that load a doc.
 * `delivery.url` always ends with `/`; embed entries are relative paths.
 */
function entryUrl(entry: ProjectEntry, relativePath: string): string {
  const base = entry.delivery.url.endsWith('/') ? entry.delivery.url : entry.delivery.url + '/'
  return base + relativePath.replace(/^\//, '')
}

export default function EmbedRouter({ entry }: EmbedRouterProps) {
  const { embed, title } = entry

  switch (embed.kind) {
    case 'static-html':
      return <IframeEmbed src={entryUrl(entry, embed.entry)} title={title} />

    case 'notebook-html':
      return <IframeEmbed src={entryUrl(entry, embed.notebook)} title={title} />

    case 'external-app':
      // Foreign origin — visitor is leaving our origin's same-origin trust
      // boundary. Looser sandbox for popup/form behavior, no
      // allow-same-origin (the artifact lives on someone else's host).
      return (
        <IframeEmbed
          src={embed.url}
          title={title}
          allowForms
          allowPopups
        />
      )

    case 'tex-pdf':
      return <IframeEmbed src={entryUrl(entry, embed.pdf)} title={title} aspectRatio="8.5 / 11" />

    case 'wasm-emscripten':
    case 'wasm-rust':
      // Emscripten + wasm-bindgen ship a self-contained HTML harness next
      // to the .wasm. v1: just iframe the harness. v2 (future): a first-
      // party React harness with React-side controls + state.
      return <IframeEmbed src={entryUrl(entry, embed.entry)} title={title} />

    case 'pyodide':
    case 'pglite-db':
      return (
        <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border border-dashed bg-muted/20 p-8 text-center">
          <div>
            <p className="font-medium text-foreground">
              {embed.kind === 'pyodide' ? 'Pyodide harness' : 'Browser database'} coming soon
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              This embed kind needs a first-party renderer. Source artifact lives at{' '}
              <a className="underline hover:text-primary" href={entry.delivery.url} target="_blank" rel="noopener noreferrer">
                {entry.delivery.url}
              </a>
              .
            </p>
          </div>
        </div>
      )

    default: {
      // Exhaustiveness check — TypeScript will flag this branch if a new
      // EmbedSpec variant is added without a case.
      const _exhaustive: never = embed
      void _exhaustive
      return null
    }
  }
}
