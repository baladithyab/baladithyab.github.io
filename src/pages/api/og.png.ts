/**
 * Dynamic Open Graph image generator.
 *
 * Renders a 1200×630 PNG on Cloudflare Workers using Takumi's WASM backend
 * and a React card component. The renderer owns its WASM and font lifecycle.
 *
 * Used by the site's HeadSEO component as the default `og:image` so every
 * page gets a tailored social preview without having to hand-author one.
 *
 * Query params (all optional):
 *   - `title`       — large heading text (default: site name)
 *   - `subtitle`    — small kicker line above the title (default: "codeseys.io")
 *   - `description` — supporting copy under the title
 *   - `accent`      — accent colour (any CSS-valid colour string), default: bright cyan
 *   - `tag`         — small badge text in the upper-right corner (e.g. "Blog", "Status")
 *   - `debug=1`     — surface the render error as plain text instead of redirecting to the fallback
 *
 * Output: image/png, cached publicly for 1 day in `caches.default` keyed
 * on the full query string.
 */
import type { APIRoute } from 'astro'
import { createElement } from 'react'
import { ImageResponse } from 'takumi-js/response'
import { isEmojiImageUrl } from 'takumi-js/helpers/emoji'
import OpenGraphCard from '../../components/OpenGraphCard'

export const prerender = false

/**
 * Truncate text to fit within a target character cap, appending an ellipsis
 * if truncation occurred. Keeps copy within the social card's fixed bounds.
 */
function clip(text: string | null | undefined, maxLen: number): string {
  if (!text) return ''
  const t = text.trim()
  if (t.length <= maxLen) return t
  return t.slice(0, maxLen - 1).trimEnd() + '…'
}

export const GET: APIRoute = async ({ url }) => {
  const params = url.searchParams
  const title = clip(params.get('title') ?? 'Baladithya Balamurugan', 90)
  const subtitle = clip(params.get('subtitle') ?? 'codeseys.io', 60)
  const description = clip(
    params.get('description') ??
      'Solutions Architect at AWS — machine learning, cloud architecture, and the bits in between.',
    180,
  )
  const accent = params.get('accent') ?? '#22d3ee' // cyan-400 — matches site primary highlight tone
  const tag = clip(params.get('tag') ?? '', 20)

  // Edge-cache the rendered PNG for a day so a single hit warms unfurls
  // for everyone who shares that URL afterwards.
  const cacheKey = new Request(
    `https://codeseys.io/__cache/og${url.search || '?'}`,
    { method: 'GET' },
  )
  if (typeof caches !== 'undefined' && 'default' in caches) {
    const cache = (caches as any).default
    const cached = await cache.match(cacheKey)
    if (cached) return cached
  }

  const tree = createElement(OpenGraphCard, { title, subtitle, description, accent, tag })

  try {
    const res = new ImageResponse(tree, {
      width: 1200,
      height: 630,
      format: 'png',
      images: { allowUrl: isEmojiImageUrl },
      headers: {
        // 1 day at the edge; covers Slack/Discord/Twitter unfurl behaviour.
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    })
    await res.ready

    if (typeof caches !== 'undefined' && 'default' in caches) {
      const cache = (caches as any).default
      await cache.put(cacheKey, res.clone())
    }
    return res
  } catch (err) {
    console.error('OG image render failed:', err)
    if (params.get('debug') === '1') {
      const message =
        err instanceof Error
          ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
          : String(err)
      return new Response(message, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    // Static template image keeps unfurls from 500'ing if rendering breaks.
    return Response.redirect(
      new URL('/og-image-fallback.png', url.origin).toString(),
      302,
    )
  }
}
