# Architecture

This repo is a **Cloudflare Workers** deployment of an Astro 7 SSR site (portfolio + repo-owned blog + GitHub showcase).

## High-Level Design

- Astro 7 SSR: `astro.config.ts` uses `output: "server"` + `@astrojs/cloudflare` v14 adapter (Cloudflare's first-party adapter, post-acquisition).
- Cloudflare Workers runtime: `wrangler.jsonc` declares a Workers project with the unified Astro entrypoint `@astrojs/cloudflare/entrypoints/server`. The adapter generates `dist/server/wrangler.json` pointing at the built `entry.mjs` and `../client` static assets (`ASSETS` binding); `.wrangler/deploy/config.json` selects that generated config.
- React 19 islands: selective hydration for interactive components (`client:load`).
- Tailwind v4 via `@tailwindcss/vite` (no PostCSS config file).
- External integrations:
  - GitHub: REST API via `fetch()` with optional Cloudflare cache and optional token.
  - Auth: OIDC skeleton for Auth0/Keycloak (disabled unless configured).

## Runtime Data Flows

Blog:

- `src/content.config.ts` defines the `blog` content collection (glob loader on `src/content/blog/**/*.md`, zod schema).
- `src/content/blog/*.md` holds the published posts with frontmatter metadata.
- `src/pages/blog/index.astro` lists posts from `getCollection('blog')`.
- `src/pages/blog/[slug].astro` renders individual posts with clean slugs **and** falls back to a legacy Notion-id 301 redirect (looks up `sourceNotionId` in the same collection) so old URLs keep working.

GitHub showcase:

- `src/pages/profile.astro` calls `src/lib/github.ts` (server-side).
- `src/pages/api/github/summary.ts` exposes the same summary data for debugging.
- Caching uses `caches.default` when available.
- Optional env: `GITHUB_TOKEN`.

Auth (OIDC skeleton):

- Login flow: `/api/auth/login` -> IdP -> `/api/auth/callback` -> signed cookie session.
- `src/middleware.ts` hydrates `Astro.locals.user/session` from the signed cookie when configured.
- The feature is inert unless `AUTH_SESSION_SECRET` + OIDC settings exist.

## Runtime Env Access

Astro 6 + `@astrojs/cloudflare` 13 removed `Astro.locals.runtime.env`. Server code reads bindings/secrets/vars through:

```ts
import { getRuntimeEnv } from '@/lib/runtime-env'

// Optionally pass a generic for typing:
import type { GitHubEnv } from '@/lib/github'
const runtimeEnv = getRuntimeEnv<GitHubEnv>()
```

The shim wraps `import { env } from 'cloudflare:workers'` (resolved by `@cloudflare/vite-plugin` in dev/build, by workerd at runtime).

## Cloudflare Compatibility Notes

- Avoid Node-only APIs at runtime (fs, child_process). Server code uses `fetch` + WebCrypto.
- Image handling: adapter uses `imageService: { build: 'compile', runtime: 'cloudflare-binding' }`: Sharp 0.35.5 handles build-time images, and the Images binding handles runtime transforms.
- Session storage: Astro sessions are pinned to an in-memory LRU cache (`sessionDrivers.lruCache({ max: 500 })`) so no KV binding is required. To enable real sessions, add a `kv_namespaces` block for `SESSION` in `wrangler.jsonc` and remove the `session` override in `astro.config.ts`.
- Vite version: 8.3.6, without a global override. Vite 8 uses Rolldown/Oxc and its default minifier. `build.rolldownOptions` retains the existing function-form `manualChunks`, which is supported but deprecated; replacement with `codeSplitting` is deferred.
- Markdown/MDX: one explicit `unified()` processor runs `rehype-mermaid` before SVG normalization. Shiki excludes Mermaid fences. MDX inherits the processor without repeating legacy plugin options, and `compressHTML: true` retains HTML-aware whitespace.
- SSR `optimizeDeps`: `astro.config.ts` includes a custom Vite plugin that pre-bundles app deps (React, Radix, lucide-react, astro-navbar, etc.) for the workerd SSR environment so the adapter doesn't have to discover them at runtime (avoids cascading "program reload" errors — [withastro/astro#16248](https://github.com/withastro/astro/issues/16248)).

## Local Verification

- Build: `bun run build`
- Type/content check: `bun run astro check`
- Local Workers preview: `bun run preview` (runs the same workerd runtime that production uses)
- Local dev: `bun run dev` (include a cold optimizer cache and a restart when verifying SSR dependency changes)
- Wrangler dry-run deploy: `bun run deploy.dryrun`
