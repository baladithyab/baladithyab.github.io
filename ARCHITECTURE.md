# Architecture

This repo is a Cloudflare Pages deployment of an Astro SSR site (portfolio + Notion-backed blog + GitHub showcase).

## High-Level Design

- Astro SSR: `astro.config.ts` uses `output: "server"` + `@astrojs/cloudflare` adapter.
- Cloudflare Pages runtime: `wrangler.toml` points build output to `dist`.
- React islands: selective hydration for interactive components (`client:load`).
- External integrations:
  - Notion: REST API via `fetch()` with optional Cloudflare cache.
  - GitHub: REST API via `fetch()` with optional Cloudflare cache and optional token.
  - Auth: OIDC skeleton for Auth0/Keycloak (disabled unless configured).

## Runtime Data Flows

Notion blog:

- `src/pages/blog/index.astro` and `src/pages/blog/[id].astro` call `src/lib/notion.ts`.
- `src/lib/notion.ts` uses Notion REST endpoints and caches responses in `caches.default` when available.
- Env:
  - `NOTION_API_KEY`
  - `NOTION_DATABASE_ID`

GitHub showcase:

- `src/pages/profile.astro` calls `src/lib/github.ts` (server-side).
- `src/pages/api/github/summary.ts` exposes the same summary data for debugging.
- Caching uses `caches.default` when available.
- Optional env:
  - `GITHUB_TOKEN`

Auth (OIDC skeleton):

- Login flow: `/api/auth/login` -> IdP -> `/api/auth/callback` -> signed cookie session.
- `src/middleware.ts` hydrates `Astro.locals.user/session` from the signed cookie when configured.
- The feature is inert unless `AUTH_SESSION_SECRET` + OIDC settings exist.

## Cloudflare Compatibility Notes

- Avoid Node-only APIs at runtime (fs, child_process). Server code uses `fetch` + WebCrypto.
- Image handling: adapter uses `imageService: "compile"` to avoid sharp runtime constraints.
- Session storage: Astro sessions are pinned to `memory` in `astro.config.ts` (no KV binding required).

## Local Verification

- Build: `bun run build`
- Local dev: `bun run dev`
- Cloudflare runtime preview: `bun run preview.wrangler` (may require a working local network interface setup)

