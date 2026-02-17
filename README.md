# codeseys.io

Personal website (portfolio + Notion-backed blog) built with Astro and deployed to Cloudflare Pages.

## Stack

- Astro (`output: "server"`) + `@astrojs/cloudflare` adapter
- React islands (`@astrojs/react`)
- Tailwind CSS v3 (`@astrojs/tailwind`)
- Cloudflare Pages runtime via Wrangler

## Local Development

Requirements:

- Node 20 (see `.nvmrc`)
- Bun

Commands:

```bash
bun install
bun run dev
```

Preview with the Cloudflare Pages runtime:

```bash
bun run build
bun run preview.wrangler
```

## Environment Variables

Used for the Notion blog integration:

- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`

Optional, to improve GitHub API reliability:

- `GITHUB_TOKEN` (fine-grained PAT recommended; avoids unauthenticated rate limits)

Auth (OIDC): Auth0 or Keycloak. This is implemented as an OIDC skeleton and is disabled unless configured.

Potential variables (depending on provider):

- Required for sessions: `AUTH_SESSION_SECRET`
- Generic OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_LOGOUT_REDIRECT_URI`
- Auth0 compatibility: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_REDIRECT_URI`
- Keycloak compatibility: `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_REDIRECT_URI`

Notes:

- Locally these can come from `.env`.
- On Cloudflare Pages they should be configured as runtime secrets/vars.

## Cloudflare Pages

- Output directory: `dist` (see `wrangler.toml`)
- GitHub Actions deploy workflow: `.github/workflows/cloudflare-pages-deploy.yml`

## Endpoints

GitHub:

- `GET /api/github/summary`: JSON used by the Profile page (cached)

Auth (OIDC skeleton):

- `GET /api/auth/login`
- `GET /api/auth/callback`
- `GET /api/auth/logout`
- `GET /api/auth/session` (debug)

## Cloudflare Setup Checklist

GitHub (optional but recommended):

1. Create a fine-grained GitHub PAT with read-only access to public repositories.
1. Add it to Cloudflare Pages as a secret named `GITHUB_TOKEN`.

Notion:

1. Add `NOTION_API_KEY` as a Pages secret.
1. Add `NOTION_DATABASE_ID` as a Pages environment variable or secret.

Auth (Auth0/Keycloak OIDC):

1. Stand up your IdP (Auth0 or Keycloak) and create an OIDC client.
1. Decide the callback URLs you want under this site (reserved paths):
   - Login: `https://codeseys.io/api/auth/login`
   - Callback: `https://codeseys.io/api/auth/callback`
   - Logout: `https://codeseys.io/api/auth/logout`
1. Set Cloudflare Pages secrets/vars:
   - `AUTH_SESSION_SECRET` (generate with `openssl rand -base64 32`)
   - OIDC config (generic or Auth0/Keycloak compatibility vars)
1. Debug endpoints:
   - `GET /api/auth/session` (shows whether auth is configured + current cookie session)

## Sessions (Cloudflare)

The Cloudflare adapter can auto-configure Astro sessions backed by a KV binding named `SESSION`.
This project does not currently use Astro sessions, so `astro.config.ts` pins sessions to the
in-memory driver to avoid requiring KV setup.
