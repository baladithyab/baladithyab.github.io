# codeseys.io

Personal website (portfolio + repo-owned blog) built with Astro and deployed to **Cloudflare Workers** (Workers Static Assets — Cloudflare's modern successor to Pages).

## Stack

- Astro 6 (`output: "server"`) with the first-party `@astrojs/cloudflare` v13 adapter
- React 19 islands (`@astrojs/react`)
- Tailwind CSS v4 via `@tailwindcss/vite` (no PostCSS config)
- TypeScript 6
- Cloudflare Workers runtime + Static Assets (`wrangler.jsonc`)

## Local Development

Requirements:

- Node 20 (see `.nvmrc`)
- Bun

Commands:

```bash
bun install
bun run dev          # astro dev (see "Known dev limitation" below)
bun run build        # production build to dist/
bun run preview      # local Workers preview via Miniflare
bun run astro check  # types + content validation
bun run deploy       # wrangler deploy to Cloudflare Workers
```

> **Known dev limitation:** As of Astro 6.3.5 + `@astrojs/cloudflare` 13.5.2, `astro dev` may throw `"Astro is not defined"` on first request in some setups. This is a known upstream issue (see [withastro/astro#16248](https://github.com/withastro/astro/issues/16248) and related). Use `bun run build && bun run preview` for end-to-end local verification — it runs the same workerd runtime that production uses.

## Environment Variables

The blog is stored in-repo as Astro content collection entries under `src/content/blog/*.md`, so it does **not** require runtime CMS credentials.

Optional, to improve GitHub API reliability:

- `GITHUB_TOKEN` (fine-grained PAT recommended; avoids unauthenticated rate limits)

Auth (OIDC): Auth0 or Keycloak. This is implemented as an OIDC skeleton and is disabled unless configured.

Potential variables (depending on provider):

- Required for sessions: `AUTH_SESSION_SECRET`
- Generic OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_LOGOUT_REDIRECT_URI`
- Auth0 compatibility: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_REDIRECT_URI`
- Keycloak compatibility: `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_REDIRECT_URI`

Reading env vars in code:

```ts
import { getRuntimeEnv } from '@/lib/runtime-env'
import type { GitHubEnv } from '@/lib/github'

const runtimeEnv = getRuntimeEnv<GitHubEnv>()
const token = runtimeEnv.GITHUB_TOKEN // typed
```

The shim wraps `import { env } from 'cloudflare:workers'` (the Astro 6 replacement for the removed `Astro.locals.runtime.env`).

Notes:

- Locally these can come from `.env` (or `.dev.vars` for Wrangler).
- On Cloudflare Workers they should be configured as Worker secrets/vars (`wrangler secret put VAR_NAME`).

## Cloudflare Workers

- Config: `wrangler.jsonc` (Workers project type, with `assets.binding = "ASSETS"`).
- Entrypoint: `@astrojs/cloudflare/entrypoints/server` (Astro 6 unified server entry).
- Static assets directory: `./dist` (built by `bun run build`).
- GitHub Actions deploy workflow: `.github/workflows/cloudflare-deploy.yml` (`wrangler deploy`).

Manual deploy:

```bash
bun run build
bun run deploy        # wrangler deploy
# or:
bun run deploy.dryrun # wrangler deploy --dry-run
```

## Endpoints

GitHub:

- `GET /api/github/summary`: JSON used by the Profile page (cached, 5 min `Cache-Control`).

Auth (OIDC skeleton, returns 503 until configured):

- `GET /api/auth/login`
- `GET /api/auth/callback`
- `GET /api/auth/logout`
- `GET /api/auth/session` (debug)

Legacy redirects:

- Old Notion-id URLs `/blog/<uuid>` 301-redirect to the new slug routes via `[slug].astro` (looks up `sourceNotionId` in the content collection).

## Cloudflare Setup Checklist

GitHub (optional but recommended):

1. Create a fine-grained GitHub PAT with read-only access to public repositories.
1. Add it as a Worker secret: `wrangler secret put GITHUB_TOKEN`.

Blog:

1. Add or edit Markdown posts in `src/content/blog/`.
1. Run `bun run astro check` and `bun run build` before deploying.

Auth (Auth0/Keycloak OIDC):

1. Stand up your IdP (Auth0 or Keycloak) and create an OIDC client.
1. Decide the callback URLs you want under this site (reserved paths):
   - Login: `https://codeseys.io/api/auth/login`
   - Callback: `https://codeseys.io/api/auth/callback`
   - Logout: `https://codeseys.io/api/auth/logout`
1. Set Worker secrets:
   - `wrangler secret put AUTH_SESSION_SECRET` (generate with `openssl rand -base64 32`)
   - OIDC config secrets (generic or Auth0/Keycloak compatibility vars)
1. Debug endpoints:
   - `GET /api/auth/session` (shows whether auth is configured + current cookie session)

## Sessions

The Cloudflare adapter can auto-configure Astro sessions backed by a KV binding named `SESSION`. This project does not currently use Astro sessions, so `astro.config.ts` pins sessions to an in-memory LRU cache driver to avoid requiring KV setup. To enable real sessions, add a `kv_namespaces` block for `SESSION` in `wrangler.jsonc` and remove the `session` override in `astro.config.ts`.
