# Changelog

## [2026-05-20] (continued, 3) Dynamic per-page Open Graph image generator

Replaced the leftover Astro shadcn/ui template `og-image.png` (the one that
made every link unfurl as a tiny "44" triangle) with a Workers-native
runtime PNG generator at `/api/og.png`. Every page now gets a tailored
1200×630 social preview that mirrors the page's actual title, description,
section badge, and accent colour — built fresh from the URL's query
params, then cached at the edge for 1 day.

### `src/pages/api/og.png.ts` (NEW)

- Backed by **`@cf-wasm/og`** (Workers-friendly Satori + Resvg bundle).
  We initially wired up `satori` + `@resvg/resvg-wasm` directly — that
  combination requires runtime `WebAssembly.instantiate()`, which the
  Workers sandbox blocks for security. `@cf-wasm/og` ships pre-bound wasm
  modules that work inside `workerd`.
- Query params: `title`, `subtitle`, `description`, `tag`, `accent`,
  `debug=1` (surface the render error as plain text instead of redirecting
  to the fallback PNG — handy when iterating).
- Render output: 1200×630 PNG, ~110KB, end-to-end render in 300–900ms.
- Edge-cached in `caches.default` keyed on the full query string with
  `Cache-Control: public, max-age=86400, immutable`. First share warms the
  unfurl for everyone after.
- Defensive fallback: if rendering throws, redirect to the static
  `/og-image-fallback.png` so social unfurls don't 500 even on a regression.

### `src/components/HeadSEO.astro`

- Default `og:image` now points at `/api/og.png?title=…&description=…`
  with the page's title and description threaded through, plus optional
  `?tag=…&accent=…` from the layout.
- Added `og:image:width`, `og:image:height`, `og:image:alt`, and
  `twitter:image:alt` meta — required by Twitter for proper "summary
  large image" cards.
- `BaseLayout` accepts new `ogTag` and `ogAccent` props and forwards them
  through; pages can opt into a custom badge / accent colour without
  pre-rendering an image.

### Per-page accents and tags

| Page | Tag | Accent |
|---|---|---|
| `/` | `Home` | violet `#a78bfa` |
| `/blog` | `Blog` | cyan `#22d3ee` |
| `/blog/[slug]` | `Post` | cyan `#22d3ee` |
| `/profile` | `Profile` | orange `#f97316` |
| `/status` | `Status` | green `#34d399` |

### Cleanup

- Renamed the legacy template `public/og-image.png` →
  `public/og-image-fallback.png` so the fallback path still has a target,
  but the default `og:image` no longer shows the "Astro shadcn/ui" template.

### Verification

- `bun run astro check`: ✅ 0 / 0 / 0 (47 files)
- `bun run test`: ✅ 53 / 53
- `bun run build`: ✅ green (~37s)
- `bun run astro preview` (workerd, port 4322):
  - `GET /api/og.png` → 200, 1200×630 PNG, 113 KB, 315 ms
  - `GET /api/og.png?title=…&tag=Blog&accent=%2322d3ee` → 200, 105 KB, 892 ms
  - `GET /api/og.png?title=Server+Status&tag=Status&accent=%2334d399` → 200, 112 KB, 671 ms
  - All three vision-verified: clean layout, no overflow, accent colour
    propagates to logo block / tag border / footer accent bar.
  - `og:image` meta on each page points at the correct dynamic URL with
    the right title/description/tag/accent params.

## [2026-05-20] (continued) Bento+filter rollout to /blog and /profile

Extended the card-grid bento + interactive filter pattern from `/status` to
the two other content-heavy pages. All three now share the same UX vocabulary
(`auto-fill, minmax(...)` grid, search + sort + chip filters, SSR-safe
relative timestamps) so the site reads as one cohesive experience.

### `/blog`

- **`src/components/BlogGrid.tsx`** (NEW) — React island. Per-post cards, 4
  cols at 1600px reflowing to 1 on mobile.
  - Search filters across title, description, and tags.
  - Sort: Recent / Title.
  - Tag-filter chips with live counts (auto-hidden if no tags exist on any
    post — currently the case post Notion-import).
  - SSR pre-renders rich-text previews via `getRichPreview()` and passes the
    HTML string into the React tree; mounted via `dangerouslySetInnerHTML`
    so crawlers and noscript users still see formatted previews.
- **Removed**: the prior `.blog-card-container` 3D-hover effect (height
  expansion, perspective transform, drop shadow). The new card pattern
  trades that maximalist hover for uniform `auto-rows-fr` row heights and a
  subtle lift-and-glow on hover, matching the rest of the site.

### `/profile`

- **`src/components/RepoGrid.tsx`** (NEW) — React island. Per-repo cards, 5
  cols at 1600px.
  - Search filters across repo name, description, and language.
  - Sort: Recent / Stars / Name.
  - Language-filter chips with GitHub-style colour dots and live counts.
  - SSR-safe `Xmo ago` / `Xy ago` relative timestamps.
- **`src/lib/github.ts`**:
  - Bumped `topRepos` limit from 5 → 30 so the filter has data to work with.
  - Now also surfaces per-repo `language` and `stars` (already in the
    upstream API response, just dropped before).
  - Moved the `Repo` type definition here (was orphaned in
    `RepoAccordion.tsx`).
- **Removed**: `RepoAccordion.tsx` (replaced by `RepoGrid`).
- Page max-width widened from `max-w-4xl` to `max-w-[1600px]` to match
  `/status` and use lateral real-estate.

### Across all three grids

- **`auto-rows-fr` fix** — applied to ServiceGrid, RepoGrid, and BlogGrid so
  every card in the same row stretches to the tallest sibling's height.
  Empirically verified: each row's cards are pixel-identical in height.
- **Removed**: `ServiceGroupCard.astro` (orphaned after the bento migration
  on `/status` last commit).

### Verification

- `bun run astro check`: ✅ 0 / 0 / 0 (46 files)
- `bun run test`: ✅ 53 / 53 (3 files)
- `bun run build`: ✅ green (~44s)
- `bun run astro preview` (workerd, port 4322):
  - `/`, `/blog`, `/profile`, `/status` all HTTP 200
  - `/blog` renders 5 cards in 4 cols at 1600px; toolbar + sort + search wired
  - `/profile` renders 30 cards in 5 cols at 1600px; 13 language chips with
    counts (Python 9, TypeScript 7, Jupyter Notebook 3, Rust 2, Sass 1,
    Go 1, …); clicking "Python" → "Showing 9 of 30"
  - Console: 0 errors on either page

## [2026-05-20] Status page: cards-not-list bento + interactive filtering

Replaced the grouped-list layout on `/status` with an interactive card grid
that uses every available column of lateral screen real-estate, plus a
Gatus-UI-style filter/sort toolbar.

- **`src/components/ServiceGrid.tsx`** (NEW) — React island. One card per
  endpoint (51 total). CSS grid: `repeat(auto-fill, minmax(280px, 1fr))` so
  the layout reflows to 5 cols at 1600px → 4 → 3 → 2 → 1 as viewport shrinks.
  Each card shows: name, category, status icon, 30-bucket sparkline, uptime%,
  response time, HTTP code, last-seen relative timestamp, and direct link to
  the upstream app (when known) plus a Gatus history deep-link.
- **Toolbar**: search input (filters by name + category), 5 sort modes
  (Category, Name, Status, Response, Uptime), 3 status pills with live counts
  (All / Up / Down), and one chip per category with counts. Empty-state with
  a "Reset filters" button when no matches.
- **Hydration mismatch fix**: timestamps render as "just now" on the server
  and during the first client render, then update to real "Xm ago" after
  mount. Refreshes every 60s without page reload. Eliminates React error #418.
- **Removed**: the prior two-column `ServiceGroupCard` layout and its
  manual height-balancing comments. (`ServiceGroupCard.astro` is no longer
  imported from `status.astro` but kept on disk in case we want to reuse it
  elsewhere — flagged for cleanup in a follow-up.)
- **Categorization heuristic**: kept the prior split (Public Surface,
  Internal Services, Infrastructure, Media Stack, Apps & Tools) and now also
  honours an explicit Gatus group label when set to something user-friendly
  (was previously ignored).

### Cloudflare adapter / Astro upgrade

Cloudflare acquired Astro in early 2025, and the adapter is now fully
Workers-first. Pulled the latest patch versions:

- `astro` 6.3.5 → **6.3.6**
- `@astrojs/cloudflare` 13.5.2 → **13.5.3**

Workers-native config (`wrangler.jsonc` with `main:
"@astrojs/cloudflare/entrypoints/server"` and `assets: { binding: "ASSETS",
directory: "./dist" }`) is unchanged — already on the modern path from the
Pages → Workers migration. CI deploys via `cloudflare/wrangler-action@v3`
with `command: deploy` (Workers).

### Verification

- `bun run astro check`: ✅ 0 / 0 / 0
- `bun run test`: ✅ 53 / 53 (3 files, ~800ms)
- `bun run build`: ✅ green (~45s)
- `bun run astro preview` (workerd, port 4322):
  - `/` `/blog` `/profile` `/status` → all HTTP 200
  - `/status` rendered 51 cards in 5 columns at 1600px
  - Console: 0 errors after hydration-mismatch fix
  - Filter + sort + search verified interactive (clicked "Down" → "Showing 0 of 51", reset → "Showing 51 of 51")

## [2026-05-19] (Workers migration)

Migrated from Cloudflare **Pages** to Cloudflare **Workers** (Workers Static Assets — Cloudflare's modern successor to Pages, post-Astro acquisition).

- **Wrangler config**: replaced Pages-style `wrangler.toml` (`pages_build_output_dir = "dist"`) with Workers-native `wrangler.jsonc`:
  - `main: "@astrojs/cloudflare/entrypoints/server"` (Astro 6 unified entrypoint).
  - `assets: { binding: "ASSETS", directory: "./dist" }` (Workers Static Assets, no longer reserved as in Pages).
  - `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`.
  - `observability.enabled: true`.
- **Adapter**: `@astrojs/cloudflare` 13.5.2 (latest, includes the May 18 SSR optimizeDeps fix from [withastro/astro#16708](https://github.com/withastro/astro/pull/16708)).
- **Vite pin**: added `package.json` `overrides: { "vite": "^7.3.1" }` to work around the Vite 7/8 split that breaks Astro 6 + Cloudflare adapter ([withastro/astro#16029](https://github.com/withastro/astro/issues/16029)).
- **SSR optimizeDeps**: added a custom Vite plugin in `astro.config.ts` that pre-bundles app deps (React, Radix, lucide-react, astro-navbar, nanostores, etc.) for the workerd SSR environment so the adapter doesn't have to discover them at runtime ([withastro/astro#16248](https://github.com/withastro/astro/issues/16248)).
- **Runtime env API**: `Astro.locals.runtime.env` was removed in Astro 6. Added `src/lib/runtime-env.ts` with a typed `getRuntimeEnv<T>()` helper that wraps `import { env } from 'cloudflare:workers'`. Migrated 8 call sites:
  - `src/middleware.ts`
  - `src/pages/{status,protected,profile}.astro`
  - `src/pages/api/auth/{login,logout,callback,session}.ts`
  - `src/pages/api/github/summary.ts`
- **Types**: cleaned `src/env.d.ts`. Removed dead `App.Locals.runtime?.env` declaration; added `<reference types="@cloudflare/workers-types" />`.
- **CI**: replaced `.github/workflows/cloudflare-pages-deploy.yml` with `cloudflare-deploy.yml`. Now runs `wrangler deploy` (Workers) and adds a type-check step in the build job. Dropped legacy `NOTION_API_KEY` / `NOTION_DATABASE_ID` env wiring (no longer used).
- **Scripts**: dropped `preview.wrangler` / `preview.wrangler.pages`; added `deploy`, `deploy.dryrun`, `wrangler.types`.
- **Legacy URL redirects**: rewired so `/blog/<notion-uuid>` URLs 301 to the new slug routes via `[slug].astro`'s `sourceNotionId` lookup. Deleted the standalone `src/pages/blog/legacy/[id].astro` (now redundant).
- **Docs**: rewrote `README.md`, `ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/GITHUB.md` to reflect the Workers-first deployment model. Documented the typed `getRuntimeEnv()` API. Removed the dead `functions/` directory (Pages Functions, never used).
- **Status page**: updated CDN service description to `Cloudflare Workers`.

### Verification

- `bun run build`: ✅ clean (~70s, server entry via `@astrojs/cloudflare/entrypoints/server`).
- `bun run astro check`: ✅ 0 errors / 0 warnings / 0 hints (40 files).
- `bun run preview` (workerd via Miniflare) smoke test:
  - `/` `/blog` `/blog/<slug>` `/profile` `/status` `/protected` → all HTTP 200.
  - `/api/github/summary` → 200, `/api/auth/session` → 200, `/api/auth/login` → 503 (correct: OIDC not configured in this environment).
  - `/blog/<notion-uuid>` → 301 → `/blog/<slug>` (3/3 legacy IDs verified).
- `bun audit`: still 9 dev-tooling transitives (rollup, picomatch). No production runtime exposure.
- Source scan: no secrets, no `eval`, no `dangerouslySetInnerHTML`.

### Known limitation

- `astro dev` may throw `"Astro is not defined"` on first request in some setups (upstream issue, not introduced by this change). `astro preview` works correctly and runs the same workerd runtime as production.

## [2026-05-19] (continued)

- Tailwind CSS migrated from v3 to v4:
  - Replaced `@astrojs/tailwind` integration with `@tailwindcss/vite`.
  - Removed `tailwind.config.ts` and `postcss.config.js` (Tailwind 4 needs neither).
  - Rewrote `src/styles/globals.css` using v4-style `@import "tailwindcss"` and `@theme inline { ... }`, projecting all shadcn HSL design tokens (`--color-*`, `--radius-*`, `--font-sans`, animations).
  - Replaced `tailwindcss-animate` plugin with `tw-animate-css` CSS import.
  - Added explicit `border-color: hsl(var(--border))` reset for `*` to preserve the v3 default border behavior the markup relies on.
  - Replaced `@apply` directives in `globals.css` (`.gradient-text`, `.hover-card`, `.skill-badge`) with raw CSS (Tailwind 4 deprecates `@apply` in component layers in favor of CSS variables).
  - Updated `components.json` to drop the obsolete tailwind config path.
- TypeScript bumped 5.9 → 6.0.
- `prettier-plugin-tailwindcss` 0.7.4 → 0.8.0.

### Audit / health summary

- `bun audit`: 70 vulnerabilities → 9 (3 high / 6 moderate / 0 low). Remainder is dev-tooling-only via upstream Vite/Astro/Wrangler.
- `bun run build`: clean.
- `bun run astro check`: 0 errors, 0 warnings, 0 hints.

## [2026-05-19]

- Blog migrated from Notion CMS to repo-owned Astro content collection:
  - Added `src/content.config.ts` and imported all 5 published Notion posts to `src/content/blog/*.md`.
  - Replaced runtime Notion REST integration in `src/lib/notion.ts` with `getCollection('blog')` and `render()`.
  - Switched dynamic blog route from `/blog/[id]` to slug-based `/blog/[slug]`.
  - Added legacy redirect at `/blog/[id]` (under `legacy/`) so old Notion-id URLs forward via `sourceNotionId`.
  - Removed `NOTION_API_KEY` / `NOTION_DATABASE_ID` from runtime requirements; updated README, ARCHITECTURE, deployment docs, status page.
- Major Astro upgrade:
  - `astro` 5.17.2 → 6.3.5
  - `@astrojs/cloudflare` 12.6.12 → 13.5.2 (and removed deprecated `platformProxy` adapter option)
  - `@astrojs/react` 4.4.2 → 5.0.5
  - `@astrojs/mdx` added at 5.0.6
  - Migrated session config to v6 `sessionDrivers.lruCache` API.
- Other dependency updates:
  - `lucide-react` 0.564.0 → 1.16.0 (fixes broken barrel re-export)
  - `react`, `react-dom` → 19.2.6
  - `wrangler` 4.65 → 4.93
  - Updated dev tooling: `@cloudflare/workers-types`, `@iconify/json`, `@types/bun`, `@types/react*`, `prettier`, `prettier-plugin-tailwindcss`.
  - Added `@astrojs/check` for full type checking.
  - Refreshed `caniuse-lite`.
- Removed runtime bloat:
  - Dropped `astro-page-insight` + Lighthouse / Puppeteer dev chain.
  - Removed `src/lib/notion.ts`.
- Code-quality cleanups:
  - Replaced deprecated `React.ElementRef` with `React.ComponentRef` across UI primitives (accordion, avatar, tabs).
  - Removed deprecated `ViewTransitions` import from `BaseLayout.astro`.
  - Removed dead destructured `request` in `/api/hello/[name]`.
  - Fixed React hydration-incompatible inline style string (`Math.random()`) in `/status` skeleton.
  - Replaced deprecated `z.string().url()` with `z.url()` in content collection schema.
  - Build, typecheck, and Cloudflare adapter all green.

## [2026-02-17]

- Cloudflare-first cleanup:
  - Removed Netlify/Vercel config and unused patch files.
  - Split CI into PR build vs push deploy for Cloudflare Pages.
- Dependency maintenance:
  - Updated Astro, Wrangler, React, and related tooling.
  - Pinned Tailwind to v3 to avoid Tailwind v4 breaking changes.
- GitHub integration:
  - Removed dependency on third-party GitHub stats renderer.
  - Added server-side GitHub summary fetching with Cloudflare cache and optional `GITHUB_TOKEN`.
  - Added `/api/github/summary` and a status panel on `/status`.
- Auth:
  - Replaced previous auth placeholders with an OIDC (Auth0/Keycloak) skeleton:
    - `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`, `/api/auth/session`
  - Signed-cookie session hydration in middleware when configured.

## [2024-03-19]

- Cleaned up dependencies:
  - Removed unused packages: @playform/compress, astro-page-insight, teller-connect-react
  - Trusted @sentry/cli postinstall script for proper error monitoring setup
- Updated Cloudflare Pages configuration:
  - Added pages_build_output_dir to wrangler.toml
  - Set build output directory to "dist"
- Added custom scrollbar to blog card descriptions:
  - Implemented thin, minimal scrollbar design
  - Added smooth scrollbar transitions
  - Styled scrollbar for both light and dark themes
  - Limited description height to 150px with overflow scroll
- Enhanced blog card animations:
  - Increased hover elevation to 24px for more dramatic effect
  - Enlarged scale transform to 1.08 for better visibility
  - Improved shadow depth with 60px spread and higher opacity
  - Increased z-index to 20 for proper card overlapping
  - Replaced overlay-based description expansion with smooth max-height transition
  - Extended animation duration to 0.6s for smoother effect
- Optimized GitHub Actions workflow:
  - Migrated to wrangler-action@v3 from deprecated pages-action
  - Added proper Bun dependency caching
  - Improved environment variable handling
  - Streamlined deployment process with better error handling
  - Added branch-specific deployment triggers
  - Renamed workflow file to cloudflare-pages-deploy.yml for better clarity
- Redesigned blog card hover animations:
  - Added prominent floating effect with 16px elevation
  - Enhanced shadow animation for depth perception
  - Implemented smooth cubic-bezier transitions
  - Improved dark mode shadow handling
  - Optimized animation timing (0.5s duration)
- Added Notion CMS integration using @notionhq/client with proper type safety
- Created blog pages with TypeScript support
- Added blog navigation link to header
- Implemented static page generation from Notion content
- Added support for various Notion block types:
  - Paragraphs with rich text formatting
  - Headings (H1, H2, H3)
  - Lists (bulleted and numbered)
  - Code blocks with language support
  - Images with captions
  - Quotes and dividers
  - Links and text formatting
- Fixed title extraction from Notion pages
- Updated description to use first text block from page content
- Improved card design with consistent sizing
- Made blog post cards fully clickable with enhanced hover states
- Added proper TypeScript interfaces for blog posts and pages
- Improved error handling for missing properties

## Initial Release

- Base project setup
