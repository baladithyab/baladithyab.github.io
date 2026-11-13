# codeseys.io

Personal website (portfolio + repo-owned blog) built with Astro and deployed to **Cloudflare Workers** (Workers Static Assets — Cloudflare's modern successor to Pages).

## Stack

- Astro 7 (`output: "server"`) with the first-party `@astrojs/cloudflare` v14 adapter
- React 19 islands (`@astrojs/react`)
- Tailwind CSS v4 via `@tailwindcss/vite` (no PostCSS config)
- TypeScript 6
- Cloudflare Workers runtime + Static Assets (`wrangler.jsonc`)
- Rust → WebAssembly for client-side experiments (`crates/`, built with wasm-pack; see [docs/RUST_WASM.md](docs/RUST_WASM.md))

## Local Development

Requirements:

- Node 22.23.4 or newer (see `.nvmrc` and `package.json`; CI reads `.nvmrc`)
- Bun (verified with 1.4.4)
- Rust stable via rustup, plus [wasm-pack](https://github.com/wasm-bindgen/wasm-pack) 0.12 or newer on `PATH` (`rust-toolchain.toml` adds the `wasm32-unknown-unknown` target)

Commands:

```bash
bun install
bunx playwright install chromium --only-shell # required after Playwright updates for Mermaid rendering
bun run build:wasm   # build energy-ring AND meeting-point bindings before dev, tests, or astro check
bun run dev          # astro dev (see runtime notes below)
bun run build        # production build to dist/ (runs build:wasm first)
bun run preview      # local Workers preview via Miniflare
bun run test:worker  # build first; starts an isolated Worker and checks dynamic OG PNGs
bun run test         # unit tests, including real meeting-point WASM bindings; build:wasm first
bun run astro check  # types + content validation
bun run deploy       # wrangler deploy to Cloudflare Workers
```

`build:wasm` runs `build:wasm:energy` and `build:wasm:meeting`. Rebuild after
Rust changes. Generated `crates/*/pkg/` bindings stay outside `src/` and are
gitignored; they are required locally even though meeting-point WASM remains
an experiment rather than the production routing implementation.

Development runtime notes:

- Astro 7.4.7, `@astrojs/cloudflare` 14.4.6, MDX 8.1.3, Vite 8.3.6, and React integration 7.1.4 are resolved together. React/DOM remain exactly 19.3.1; React uses the integration's default Oxc transform, without its experimental compiler.
- Markdown and MDX share Astro's explicit unified processor (`@astrojs/markdown-remark`) so Mermaid rendering and SVG normalization remain in order. Mermaid 12 uses explicit classic/Dagre settings; scoped dependency overrides are documented in the audit below.
- Keep the SSR dependency optimizer workaround for [withastro/astro#16248](https://github.com/withastro/astro/issues/16248). When changing it, test the first request with a cold optimizer cache as well as a restart; warm-cache success alone is insufficient.
- Use `bun run build && bun run preview` for production-runtime verification. Successful dev checks do not replace a successful production build.
- Dynamic social cards use a typed React component and `takumi-js/response` on Workers, not generated page HTML. `/api/og.png` retains its query parameters, PNG format, and edge cache.
- See [Astro 7 migration verification](docs/migrations/astro-7.md) for the original migration and the [PR #44 audit follow-up](docs/security/dep-audits/2026-11-05-site.md#pr-44-follow-up) for the current dependency graph and compatibility exceptions.

## Meeting point lab

`/lab/meeting-point` is unlisted and `noindex`, like `/lab/energy-ring`.
Add any number of starts using live address/landmark autocomplete, the loaded
network's intersection suggestions, or a letter followed by a map click.
Two selected starts are required. SF opens with the four defaults from
[The Map World's reel](https://www.instagram.com/reel/DfkWNDNlHTM/).
Search a city or town, choose a suggestion, then click **Load walking network**.
This loads real OSM streets and resets starts/results. Live areas begin with two
blank starts; the SF reel preset remains available without a live road request.
Choose an up-to 4, 8, or 12 km square around the city center. This is not the
city's administrative boundary. Candidates and paths are restricted to the
loaded graph, so results are not a whole-city/global optimum.
Replay, pause, scrub, change playback speed, or skip directly to routes.
Reduced-motion preferences skip automatic animation.

Each pair's first road-network contact triggers a two-color ping at the midpoint
of a shortest road path between the starts, including contacts inside an edge.
The last 14% of playback eases from traversal into the final results: the colored
network dims gradually, shortest routes draw toward the selected point, and
candidate markers fade and scale in with the selected spot first. The larger
convergence pulse fades in rather than flashing on; a segmented halo remains.
This is convergence at the chosen named intersection, not a claim to find the
earliest continuous all-front intersection. Pings use playback progress, not
wall-clock timers, so pause, reverse scrubbing, speed changes, and replay agree.
Reduced motion suppresses expanding rings and keeps the static final halo.

Compared with the reel, the lab recreates the four SF landmark starts, colored
road-distance floods, meeting-point selection, and per-person routes/distances.
It adds editable groups and ranked alternatives. It does not recreate the
sequential-versus-simultaneous search comparison or its road-check counters and
speedup: independent full Dijkstra searches are replayed together. The neon
palette, coastline outline, person icons/name callouts, bright moving frontier,
traveling avatars, meeting-pin choreography, and audio are not exact replicas.

The lab returns up to ten named intersections, separated by at least 400 m.
Choose minimum longest journey (minimax, total distance breaks ties), or minimum
combined distance (longest journey breaks ties). Select a result to compare every
person's distance and draw their shortest road routes. These are intersections,
not venue recommendations; results do not promise the reel's precise answer or
road-check counts.

`src/lib/meeting-point.ts` owns the region-independent Dijkstra search, ranking,
and network parser. One retained Web Worker retrieves/normalizes the graph,
snaps saved landmarks, and prepares compact adjacency data once. Later searches
send only origin node IDs and the objective; distance/parent buffers are
transferred back. The last completed group's trees and collision contacts are
reused for repeat searches and objective changes without rerunning Dijkstra.
Editing during an active search terminates that worker; the next uncached
search reattaches the current graph. Region changes cancel pending work, clear
old node IDs, and never reuse SF landmarks with another graph. Normalization in
`meeting-network.ts` remains shared with the CLI importer.

The canvas uses typed world-space geometry and absolute-distance edge buckets
shared by all candidate results, rather than rebuilding traversal paths on every
selection. Geometry preparation yields between chunks, trail painting is
budgeted across frames, and automatic playback waits for its matching data.
Routes have a separate selected-result cache. The playback clock is isolated
from the location form and results list, so they do not rerender every frame.

`meeting-geocoder.ts` uses [Photon](https://github.com/komoot/photon) for real
address, landmark and city lookup. Autocomplete waits 500 ms after editing,
requires three characters, cancels stale requests, and restricts start searches
to the loaded bounds. A selected location must be within 200 m of a connected
path. Unselected text is never treated as a valid start.

Typed queries and area bias are sent directly to Photon; live road bounds go
directly to [Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).
Route calculations remain local. The lab does not persist starting locations
or typed query history. Up to 64 successful autocomplete queries are cached in
tab memory for five minutes. At most three normalized public road graphs are
cached on the device for seven days where Cache API storage is available.

Loading the already active area reuses its in-memory graph and resets starts
without another download or parse. Other live loads validate their requested
cache entry; expiration/capacity cleanup runs when writing a graph rather than
scanning all entries before every hit. Download progress reports decoded MiB,
not a misleading percentage based on a potentially compressed Content-Length.

No API keys are needed for the lab defaults. Photon permits reasonable demo
usage without an availability guarantee; public Overpass is not a sustainable
production application backend. Requests are manual, bounded and cached, with
no automatic retries or fake graph fallback. Busy/unavailable providers are
reported explicitly. For sustained/public production use, configure suitable
self-hosted or managed providers rather than relying on these public services:

```sh
PUBLIC_MEETING_GEOCODER_URL=https://your-photon-host.example/api/
PUBLIC_MEETING_OVERPASS_URL=https://your-overpass-host.example/api/interpreter
```

These are build-time, client-visible endpoint URLs, not secret storage.
Providers must support browser CORS and the respective Photon/Overpass APIs.
Never put secret credentials in `PUBLIC_*` configuration.

Live downloads have a 24 MiB decoded response cap, source-element/graph limits,
a 60-second server query budget and a 90-second client deadline. Dense regions
may need a smaller study area. SF's bundled graph is about 5.4 MB before
compression and does not depend on a live Overpass request. Generated network
JSON is excluded from Prettier to preserve compact output.

The bundled `public/lab/meeting-point/sf.json` database is derived from
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and is
licensed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), separately
from the site's code license. It contains a simplified, largest-connected walking
component, with two-way distance weights, paths, and stairs. It excludes
motorways, explicitly private/no-access ways, and disconnected components.
It does not model elevation, transit, accessibility, closures, or opening hours.
Starting locations snap to connected graph nodes. Coordinates outside the
loaded bounds, or more than 200 m from a connected path, are rejected instead
of being silently moved across town. Photon address coverage depends on OSM;
it does not guarantee every house number or business is indexed.

To refresh the SF snapshot, run `node scripts/import-meeting-network.mjs`
(fetches Overpass), or pass a cached Overpass JSON file. The CLI accepts up to
64 MiB of raw input so the existing full SF import remains supported; this is
separate from the smaller interactive browser limit. It shares normalization
with live retrieval. No region-specific algorithm changes or hardcoded city
list are needed for the runtime picker.

Verify routing, collision geometry, traversal cutoffs, geocoding boundaries and
graph normalization:
`bun run test src/lib/meeting-point.test.ts src/lib/meeting-collisions.test.ts src/lib/meeting-map-traversal.test.ts src/lib/meeting-geocoder.test.ts src/lib/meeting-network.test.ts`.

Production routing still uses the JavaScript worker. The separate
`crates/meeting-point` Rust crate is used by the prototype worker at
`scripts/meeting-bench/wasm.worker.ts`, with real generated bindings covered by
`src/lib/meeting-search.test.ts`. This is not a production WASM promotion or
a GPU implementation. See [the meeting-point experiment and promotion gates](docs/MEETING_POINT_WASM.md)
for the recorded JavaScript baseline and remaining gates, not an assumed speedup.

With the local prerequisites above installed, run the focused native and
real-binding tests:

```bash
bun run test:meeting:native # cargo test -p meeting-point; no generated bindings needed
bun run build:wasm         # generate both crates' bindings before binding-dependent tests
bun run test src/lib/meeting-search.test.ts
```

## Professional profile content

`src/lib/profile.json` is the reviewed website source for the current role,
bio, skills, experience, education, and contact/profile links. The homepage,
Profile page, footer, and default SEO/social-card descriptions read this file.
Projects and blog posts keep their existing sources.

The homepage About card shows `summary` initially. A native Show more /
Show less disclosure reveals every `about` paragraph without JavaScript
or a nested scrollbar; keep the full bio in the data file.

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
4. Run `bun run build:wasm` before `bun run astro check` and `bun run test`;
   run `bun run build` for the production build.
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
1. Run `bun run build:wasm`, `bun run astro check`, and `bun run build` before deploying.

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
