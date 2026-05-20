/**
 * Dynamic Open Graph image generator.
 *
 * Renders a 1200×630 PNG OG image on the Cloudflare Workers runtime via
 * `@cf-wasm/og` (a Workers-friendly Satori + Resvg bundle that ships its
 * wasm modules pre-bound — bypassing the runtime `WebAssembly.instantiate`
 * restriction in the Workers sandbox that breaks the upstream
 * satori + @resvg/resvg-wasm pair).
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
import { ImageResponse } from '@cf-wasm/og'

export const prerender = false

/**
 * Truncate text to fit within a target character cap, appending an ellipsis
 * if truncation occurred. Keeps the description from spilling outside the
 * visible bounds without relying on CSS line-clamp (which Satori implements
 * but is fussy at the resolutions we care about).
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

  // ------- Satori VNode tree -------
  // Satori supports a subset of CSS — flexbox + backgrounds + borderRadius +
  // absolute positioning are reliable. Avoid grid / transforms.
  const tag_node = tag
    ? {
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            top: 64,
            right: 80,
            padding: '8px 18px',
            borderRadius: 999,
            border: `2px solid ${accent}`,
            color: accent,
            fontSize: 22,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 2,
            display: 'flex',
          },
          children: tag,
        },
      }
    : null

  const tree: any = {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(135deg, #0b0f17 0%, #111827 60%, #0b0f17 100%)',
        color: '#f8fafc',
        fontFamily: 'sans-serif',
        padding: '64px 80px',
        position: 'relative',
      },
      children: [
        // Top-left brand mark + subtitle row
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              fontSize: 28,
              color: '#94a3b8',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: accent,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#0b0f17',
                    fontWeight: 700,
                    fontSize: 22,
                  },
                  children: '{#}',
                },
              },
              { type: 'span', props: { children: subtitle } },
            ],
          },
        },

        tag_node,

        // Spacer to push title to vertical centre
        { type: 'div', props: { style: { flex: 1, display: 'flex' }, children: [] } },

        // Main title
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              maxWidth: '100%',
            },
            children: title,
          },
        },

        // Description
        description
          ? {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  marginTop: 28,
                  fontSize: 30,
                  color: '#cbd5e1',
                  lineHeight: 1.4,
                  maxWidth: 1000,
                },
                children: description,
              },
            }
          : null,

        // Spacer
        { type: 'div', props: { style: { flex: 1, display: 'flex' }, children: [] } },

        // Bottom strip — accent bar + URL
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              fontSize: 26,
              color: '#94a3b8',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: 56,
                    height: 6,
                    borderRadius: 3,
                    background: accent,
                    display: 'flex',
                  },
                  children: [],
                },
              },
              {
                type: 'span',
                props: { children: 'codeseys.io' },
              },
            ],
          },
        },
      ].filter(Boolean),
    },
  }

  try {
    // `ImageResponse.async` so we can attach a cache-control header and
    // copy the body for the edge cache. The constructor variant works too,
    // but we want a settled `Response` to inspect/clone.
    const res = await ImageResponse.async(tree, {
      width: 1200,
      height: 630,
      format: 'png',
      headers: {
        // 1 day at the edge; covers Slack/Discord/Twitter unfurl behaviour.
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    })

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
