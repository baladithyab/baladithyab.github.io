# codeseys.io

Personal website (portfolio + repo-owned blog) built with Astro and deployed to **Cloudflare Workers** (Workers Static Assets — Cloudflare's modern successor to Pages).

## Stack

- Astro 7 (`output: "server"`) with the first-party `@astrojs/cloudflare` v14 adapter
- React 19 islands (`@astrojs/react`)
- Tailwind CSS v4 via `@tailwindcss/vite` (no PostCSS config)
- TypeScript 6
- Cloudflare Workers runtime + Static Assets (`wrangler.jsonc`)

## Local Development

Requirements:

- Node 22.23.4 or newer (see `.nvmrc` and `package.json`; CI reads `.nvmrc`)
- Bun (verified with 1.4.4)

Commands:

```bash
bun install
bunx playwright install chromium --only-shell # required after Playwright updates for Mermaid rendering
bun run dev          # astro dev (see runtime notes below)
bun run build        # production build to dist/
bun run preview      # local Workers preview via Miniflare
bun run test:worker  # build first; starts an isolated Worker and checks dynamic OG PNGs
bun run astro check  # types + content validation
bun run deploy       # wrangler deploy to Cloudflare Workers
```

Development runtime notes:

- Astro 7.4.7, `@astrojs/cloudflare` 14.4.6, MDX 8.1.3, Vite 8.3.6, and React integration 7.1.4 are resolved together. React/DOM remain exactly 19.3.1; React uses the integration's default Oxc transform, without its experimental compiler.
- Markdown and MDX share Astro's explicit unified processor (`@astrojs/markdown-remark`) so Mermaid rendering and SVG normalization remain in order. Mermaid 12 uses explicit classic/Dagre settings; scoped dependency overrides are documented in the audit below.
- Keep the SSR dependency optimizer workaround for [withastro/astro#16248](https://github.com/withastro/astro/issues/16248). When changing it, test the first request with a cold optimizer cache as well as a restart; warm-cache success alone is insufficient.
- Use `bun run build && bun run preview` for production-runtime verification. Successful dev checks do not replace a successful production build.
- Dynamic social cards use a typed React component and `takumi-js/response` on Workers, not generated page HTML. `/api/og.png` retains its query parameters, PNG format, and edge cache.
- See [Astro 7 migration verification](docs/migrations/astro-7.md) for the original migration and the [PR #44 audit follow-up](docs/security/dep-audits/2026-11-05-site.md#pr-44-follow-up) for the current dependency graph and compatibility exceptions.

## Professional profile content

`src/lib/profile.json` is the reviewed website source for the current role,
bio, skills, experience, education, and contact/profile links. The homepage,
Profile page, footer, and default SEO/social-card descriptions read this file.
Projects and blog posts keep their existing sources.

Experience and project entries use explicit `bullets` arrays. Keep each
complete bullet in one array item; do not split prose on periods, which
would break versions such as `SAM 2.1` and abbreviations.

To reconcile future changes:

1. Use the offline resume as the baseline for historical details, with
   user-confirmed corrections for changes newer than that resume. Compare
   LinkedIn manually; do not assume an older resume's "Present" is current.
   Keep exports and original resumes outside the repository.
2. Review the wording and edit `src/lib/profile.json`. Keep the approved
   narrative paragraphs in `about` and the approved display line in `headline`.
   Do not publish customer spend, contract commitments, or security-clearance
   details without explicit review.
3. Update the resume's editable source separately after reviewing the same
   changes. This repository does not generate or overwrite resume PDFs.
4. Run `bun run astro check`, `bun run astro build`, and `bun run test`.
   Check `/` and `/profile` in the production preview at desktop and mobile
   widths, including the Experience/Projects tabs and Scholar links.

No LinkedIn or Scholar scraping runs during builds or page requests.
Scholar is a direct profile link, not a cached citation-count widget.
LinkedIn account edits remain manual.

### Reconciliation on November 5, 2026

- The approved headline is `Solutions Architect @ Baseten | ex-AWS | MSCS @ USC | designing scalable & distributed systems`.
  The four-paragraph About preserves the original research and education
  background while describing Baseten as current and AWS as previous work.
- [LinkedIn experience](https://www.linkedin.com/in/baladithyabalamurugan/details/experience/)
  and the website retain Baseten, Solutions Architect, September 2026 to
  present, and one AWS entry, Solutions Architect, GenAI — Industries,
  July 2022 to August 2026. The user confirmed August as the AWS end month.
  Do not add a separate Associate entry or a promotion line; both were
  deliberately omitted from the approved display.
- The June 17, 2026 resume predates Baseten and still marks AWS as current.
  Its historical role titles and internship end dates were used for the
  approved LinkedIn and website updates: UCSC Genomics Institute,
  Software Developer, July 2021 to June 2022; APL, Research Intern,
  June 2021 to June 2022, remote. The earlier June/August discrepancy is
  resolved in favor of the resume.
- NJIT retains Research Assistant, March to June 2019, with the resume's
  magnetometer-network and augmented-reality description. The iD Tech
  role remains unchanged.
- The user declined LinkedIn project entries. No projects were published
  there; existing website projects retain their previous content.
- [LinkedIn education](https://www.linkedin.com/in/baladithyabalamurugan/details/education/)
  starts USC in August 2022; the previous website said September 2022.
  The website now shows completion dates supported by the resume.
- The resume lists AWS certifications earned in 2022 and 2023, but does not
  establish their current validity. The old generic "AWS Certified" label
  was omitted rather than asserting active certification without renewal
  evidence.
- [Google Scholar](https://scholar.google.com/citations?user=oEH5nmYAAAAJ&hl=en)
  matches the full name and shows an Amazon affiliation and verified
  `amazon.com` email. That affiliation still differs from the current
  LinkedIn employer; no Scholar account settings were changed.

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
- Entrypoint: `@astrojs/cloudflare/entrypoints/server` (unified server entry).
- Build output: `dist/server/` for the Worker and `dist/client/` for static assets. The adapter generates the Wrangler deployment config from `wrangler.jsonc`.
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

Auth (OIDC, disabled until configured):

- `GET /api/auth/login` (503 when disabled)
- `GET /api/auth/callback` (503 when disabled)
- `GET /api/auth/logout` (302 to `/` when disabled)
- `GET /api/auth/session` (200 with `configured: false` when disabled)

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
