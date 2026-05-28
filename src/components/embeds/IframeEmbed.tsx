/**
 * IframeEmbed — sandboxed iframe used by every embed kind that loads a
 * full HTML document (static-html, notebook-html, external-app, tex-pdf).
 *
 * Why iframe over inline rendering: the artifact's HTML can include its
 * own <script>, its own CSS, its own <canvas>, its own WebGL context. We
 * give it a sealed origin-isolated frame and let it do whatever it wants
 * inside without leaking into the site's React / Tailwind tree.
 *
 * Sandbox posture:
 * - Default: allow-scripts + allow-same-origin (matches the security
 *   posture documented in PROJECT_EMBEDS.md). allow-same-origin is needed
 *   because R2-hosted artifacts use relative URLs to load their own
 *   subassets (textures, model JSON, etc.).
 * - Pointer events for trackpad-zoomable WebGL canvases work fine inside
 *   the sandbox.
 * - allow-forms is opt-in via `allowForms` prop for the rare embed that
 *   actually needs form submission (notebook UIs sometimes do).
 *
 * UX:
 * - Loading skeleton until the iframe fires `load`. Some artifacts take
 *   2-3 seconds to wire up their canvas; staring at a blank rectangle is
 *   bad UX.
 * - "Open in new tab" affordance always rendered top-right so visitors
 *   can pop the artifact full-screen — they can't always tell the embed
 *   is interactive without trying it, and full-screen helps.
 * - Aspect ratio defaults to 16/10 (works well for both notebook-style
 *   wide and canvas-style content); overridable per-project.
 */

import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

interface IframeEmbedProps {
  /** Absolute URL of the HTML document to load. */
  src: string
  /** Visible title for screen readers and `<iframe title>`. */
  title: string
  /**
   * CSS aspect ratio expression. Default `16 / 10` works for both wide
   * notebook content and canvas-heavy WebGL embeds. Pass `1 / 1` for
   * square content, `4 / 3` for old-school graphics.
   */
  aspectRatio?: string
  /** Loosen the sandbox to allow form submission. Off by default. */
  allowForms?: boolean
  /** Loosen the sandbox to allow popups (e.g. project links inside the
   *  artifact opening a tab). Off by default. */
  allowPopups?: boolean
  /** Show the "Open in new tab" affordance. Default true. */
  showExternalLink?: boolean
}

export default function IframeEmbed({
  src,
  title,
  aspectRatio = '16 / 10',
  allowForms = false,
  allowPopups = false,
  showExternalLink = true,
}: IframeEmbedProps) {
  const [loaded, setLoaded] = useState(false)

  const sandboxParts = ['allow-scripts', 'allow-same-origin']
  if (allowForms) sandboxParts.push('allow-forms')
  if (allowPopups) sandboxParts.push('allow-popups', 'allow-popups-to-escape-sandbox')
  const sandbox = sandboxParts.join(' ')

  return (
    <div className="relative w-full overflow-hidden rounded-xl border bg-card shadow-sm" style={{ aspectRatio }}>
      {/* Loading skeleton — visible until the iframe fires load.
          Some artifacts take a few seconds to bootstrap their canvas. */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/30">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            Loading embed…
          </div>
        </div>
      )}

      <iframe
        src={src}
        title={title}
        sandbox={sandbox}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className="size-full"
        // referrerpolicy + allow attributes are passed through:
        referrerPolicy="strict-origin-when-cross-origin"
        // WebGL + WebGPU need to be explicitly enabled via permissions
        // policy for some artifact-host configs. allowfullscreen lets a
        // canvas request fullscreen on visitor click.
        allowFullScreen
      />

      {showExternalLink && (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-md border bg-background/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-primary"
          aria-label={`Open ${title} in a new tab`}
        >
          <ExternalLink className="size-3" />
          Open
        </a>
      )}
    </div>
  )
}
