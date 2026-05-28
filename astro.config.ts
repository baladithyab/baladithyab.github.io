import { defineConfig, sessionDrivers } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import mdx from '@astrojs/mdx'
import react from '@astrojs/react'
import Icons from 'unplugin-icons/vite'
import tailwindcss from '@tailwindcss/vite'
import rehypeMermaid from 'rehype-mermaid'
import { visit } from 'unist-util-visit'

// Mermaid block rendering at build time.
// - `strategy: 'inline-svg'` inlines the SVG directly into the HTML so there
//   is zero client-side JS cost and unfurls/SEO see real diagrams.
// - `dark: false` because our theme toggle flips `html.dark` independent of
//   the OS preference. The `dark: true` option emits a <picture> with light
//   and dark variants gated on prefers-color-scheme — that wouldn't follow
//   our manual toggle. Mermaid's 'neutral' theme renders cleanly on both
//   backgrounds.
// - On Linux/CI runners we need Playwright + Chromium installed before
//   `bun run build` (see .github/workflows/cloudflare-deploy.yml).
// Tuple form `[plugin, options]` so unified treats this as a single
// configured plugin entry. Cast widens the literal type so Astro's
// `RehypePlugin` union accepts it.
const mermaidConfig: [typeof rehypeMermaid, Parameters<typeof rehypeMermaid>[0]] = [
  rehypeMermaid,
  {
    strategy: 'inline-svg',
    // Omit `dark` so rehype-mermaid renders a single neutral SVG. Setting
    // `dark: true` would emit a <picture> with prefers-color-scheme variants
    // that don't follow our manual `html.dark` toggle. The 'neutral' theme
    // renders cleanly on both light and dark backgrounds.
    mermaidConfig: {
      theme: 'neutral',
      themeVariables: {
        // Use a fontFamily that matches our site so labels look native.
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        // Bump from mermaid's default 16px to 17px — small change that
        // makes dense flowcharts noticeably more readable without
        // forcing diagrams to overflow the prose column. The theme CSS
        // (in [slug].astro) repaints node fills + edge label backplates
        // to match the site palette in both light and dark modes.
        fontSize: '17px',
      },
    },
  },
]

// rehype-mermaid emits SVGs with `width="100%"` + `style="max-width:<intrinsic>"`,
// which forces the SVG to scale-fit any container — squishing wide sequence
// diagrams and stretching narrow flowcharts. The HTML `width` attribute beats
// CSS, so we have to fix it at build time.
//
// Approach: parse the viewBox to recover intrinsic width/height, then wrap the
// SVG in a `<div class="mermaid-frame">` whose CSS pins the SVG to its
// intrinsic size and adds horizontal scroll when wider than the prose column.
// This sidesteps Markdown's auto-wrap-in-<p> by giving the SVG a parent whose
// styling we control.
function rehypeMermaidNormalize() {
  return (tree: unknown) => {
    visit(tree as Parameters<typeof visit>[0], 'element', (node: any, index: number | undefined, parent: any) => {
      if (
        node.tagName !== 'svg' ||
        typeof node.properties?.id !== 'string' ||
        !node.properties.id.startsWith('mermaid-')
      ) return
      // Parse viewBox `minX minY width height` so we can pin intrinsic size.
      const vb = typeof node.properties.viewBox === 'string'
        ? node.properties.viewBox.split(/\s+/).map(Number)
        : null
      const intrinsicW = vb && vb.length === 4 && Number.isFinite(vb[2]) ? Math.ceil(vb[2]) : null
      const intrinsicH = vb && vb.length === 4 && Number.isFinite(vb[3]) ? Math.ceil(vb[3]) : null

      // Strip rehype-mermaid's auto-fit attributes.
      delete node.properties.width
      if (typeof node.properties.style === 'string') {
        node.properties.style = node.properties.style
          .replace(/max-width:\s*[^;]+;?/gi, '')
          .replace(/width:\s*[^;]+;?/gi, '')
          .trim()
        if (!node.properties.style) delete node.properties.style
      }

      // Pin the SVG to its intrinsic pixel dimensions via inline style so the
      // browser doesn't fall back to the SVG default of 100% × 100%. The
      // wrapping `.mermaid-frame` div handles overflow with horizontal scroll
      // for diagrams wider than the prose column, so we deliberately do NOT
      // set `max-width: 100%` here — that would defeat the whole point and
      // the diagram would shrink-fit + lose readability.
      if (intrinsicW && intrinsicH) {
        node.properties.style = `width:${intrinsicW}px;height:${intrinsicH}px`
      }

      // Strip the `<style>` element that mermaid bakes into every SVG. It
      // contains ~40 ID-scoped rules like
      //   #mermaid-0 .edgeLabel p { background-color: white }
      //   #mermaid-0 .node rect { fill: #eee; stroke: #999 }
      // ID specificity (1,0,0) beats every class-scoped selector (max
      // 0,3,2) we can write from outside, so as long as that style block
      // exists, our theme overrides lose the cascade and edge-label
      // backplates show as white blocks on dark mode (and vice-versa).
      // Stripping it here means our CSS in `[slug].astro` owns the entire
      // palette — no specificity arms-race, no `!important` games.
      //
      // Side effect: we also lose mermaid's defaults for things our CSS
      // doesn't touch (font-family, edge-animation keyframes, .marker
      // fill, .arrowheadPath fill, .cluster styling, neo-look filters).
      // We explicitly cover the visible ones in `[slug].astro` under
      // "Replacements for the mermaid-baked <style> element". The
      // animation keyframes go unused because we don't emit
      // `.edge-animation-*` classes.
      if (Array.isArray(node.children)) {
        node.children = node.children.filter(
          (c: any) => !(c?.type === 'element' && c?.tagName === 'style'),
        )
      }

      // Wrap the SVG in <div class="mermaid-frame"> for horizontal scroll on
      // overflow. We can't safely insert siblings via visit, so we mutate the
      // current node into the wrapper and put the original SVG inside.
      if (parent && typeof index === 'number') {
        const svgClone = { ...node }
        parent.children[index] = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['mermaid-frame'] },
          children: [svgClone],
        }
        return ['skip', index + 1]
      }
    })
  }
}

// https://astro.build/config
export default defineConfig({
  output: 'server',
  site: 'https://codeseys.io/',

  // Disable Astro's built-in cross-origin form-submission check.
  //
  // The check rejects PUT/POST/DELETE/PATCH whose Origin header doesn't
  // match the request URL. That breaks legitimate API clients (curl,
  // CI workflows, server-to-server calls) that don't set Origin at all.
  //
  // Our APIs use bearer-token auth (`Authorization: Bearer ...`), which
  // is inherently CSRF-immune because attackers can't read the token from
  // a victim's browser. Cookie-based OIDC auth is currently inert, but
  // when it lands its endpoints (`/api/auth/*`) should set explicit
  // CSRF protection (state param + signed cookie) rather than relying on
  // Astro's blanket origin check.
  //
  // See:
  // - https://docs.astro.dev/en/reference/configuration-reference/#securitycheckorigin
  // - docs/PROJECT_EMBEDS.md (the /api/embed-upload endpoint depends on this)
  security: {
    checkOrigin: false,
  },

  adapter: cloudflare({
    // v13+ default: Cloudflare Images binding for runtime image transforms.
    // Astro auto-provisions an `IMAGES` binding on deploy — no manual setup
    // needed. Build-time prerendered routes still use sharp via 'compile'.
    // This unlocks runtime image optimization at the edge (resize, format
    // conversion, quality) for any image referenced via the Astro Image
    // component, without paying for Cloudflare Images storage.
    imageService: { build: 'compile', runtime: 'cloudflare-binding' },
  }),
  // Astro 6 + @astrojs/cloudflare v13 auto-enable Sessions backed by Workers KV
  // when the Sessions API is used. We're not using sessions yet, so keep an
  // in-memory LRU driver to avoid the auto-provisioned KV namespace.
  session: {
    driver: sessionDrivers.lruCache({
      max: 500,
    }),
  },
  // Markdown config applies to both .md and .mdx files but Astro 5+ requires
  // the rehype plugin to also be set explicitly on the MDX integration —
  // otherwise mermaid blocks render in .md but not .mdx.
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      // Without this, Shiki turns the ```mermaid block into a syntax-highlighted
      // <code> node and rehype-mermaid never sees the original text. excludeLangs
      // tells Shiki to leave mermaid blocks untouched.
      excludeLangs: ['mermaid'],
    },
    // ORDER MATTERS: mermaid must run first to produce the SVG, then we strip
    // the SVG's width="100%" + max-width inline style so CSS can take over.
    rehypePlugins: [mermaidConfig, rehypeMermaidNormalize],
  },
  integrations: [
    mdx({
      // Inherit markdown config (rehypePlugins, syntaxHighlight) so mermaid
      // works in both .md and .mdx. extendMarkdownConfig defaults to true,
      // but we set it explicitly + repeat the rehype plugin to be safe.
      extendMarkdownConfig: true,
      rehypePlugins: [mermaidConfig, rehypeMermaidNormalize],
    }),
    react(),
  ],
  vite: {
    ssr: {
      external: ['node:path'],
    },
    // Note: @astrojs/cloudflare configures SSR aliasing/conditions for workerd during build.
    plugins: [
      tailwindcss(),
      Icons({
        compiler: 'astro',
        autoInstall: true,
      }),
      {
        // Workaround for https://github.com/withastro/astro/issues/16248
        // Pre-bundle SSR deps that workerd's CustomModuleRunner can't discover at runtime.
        // Without this, the first request crashes with "Astro is not defined" / "module is not defined"
        // because deps cascade through program reloads and chunk references go stale.
        // The Cloudflare adapter seeds Astro internals + transitions; this list adds our app deps.
        name: 'codeseys-cloudflare-ssr-deps',
        configEnvironment(name) {
          if (name === 'client') return
          return {
            optimizeDeps: {
              include: [
                // React stack — heavy CJS interop, must be pre-bundled for workerd SSR
                'react',
                'react/jsx-runtime',
                'react-dom',
                'react-dom/server',
                // UI libraries used in .astro frontmatter and React islands
                'lucide-react',
                'class-variance-authority',
                'clsx',
                'tailwind-merge',
                // Radix primitives that ship CJS
                '@radix-ui/react-accordion',
                '@radix-ui/react-avatar',
                '@radix-ui/react-navigation-menu',
                '@radix-ui/react-scroll-area',
                '@radix-ui/react-separator',
                '@radix-ui/react-slot',
                '@radix-ui/react-tabs',
                // Other transitive CJS deps that surface during SSR
                'astro-navbar',
                'nanostores',
                '@nanostores/persistent',
              ],
            },
          }
        },
      },
    ],
    build: {
      target: 'esnext',
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('react')) return 'react-vendor'
              if (id.includes('@radix-ui')) return 'ui'
            }
          },
        },
      },
    },
    optimizeDeps: {
      include: ['react', 'react-dom'],
      exclude: ['@astrojs/cloudflare'],
    },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
})
