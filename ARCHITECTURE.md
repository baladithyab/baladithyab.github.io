# Architecture

This repo is a **Cloudflare Workers** deployment of an Astro 7 SSR site (portfolio + repo-owned blog + GitHub showcase).

## High-Level Design

- Astro 7 SSR: `astro.config.ts` uses `output: "server"` + `@astrojs/cloudflare` v14 adapter (Cloudflare's first-party adapter, post-acquisition).
- Cloudflare Workers runtime: `wrangler.jsonc` declares a Workers project with the unified Astro entrypoint `@astrojs/cloudflare/entrypoints/server`. The adapter generates `dist/server/wrangler.json` pointing at the built `entry.mjs` and `../client` static assets (`ASSETS` binding); `.wrangler/deploy/config.json` selects that generated config.
- React 19 islands: the homepage experience/projects tabs use Astro `client:visible` with a 200px pre-hydration margin and useful SSR content. Immediately interactive grids retain `client:load`.
- Tailwind v4 via `@tailwindcss/vite` (no PostCSS config file).
- External integrations:
  - GitHub: REST API via `fetch()` with optional Cloudflare cache and optional token.
  - Auth: OIDC skeleton for Auth0/Keycloak (disabled unless configured).
  - Meeting point: browser-side Photon address/city lookup and bounded Overpass walking-network downloads; build-time `PUBLIC_MEETING_*` endpoint overrides. Typed queries/area bias and requested bounds go to those providers, not a site-server geocoding proxy.

## Runtime Data Flows

Blog:

- `src/content.config.ts` defines the `blog` content collection (glob loader on `src/content/blog/**/*.md`, zod schema).
- `src/content/blog/*.md` holds the published posts with frontmatter metadata.
- `src/pages/blog/index.astro` lists posts from `getCollection('blog')`.
- `src/pages/blog/[slug].astro` renders individual posts with clean slugs **and** falls back to a legacy Notion-id 301 redirect (looks up `sourceNotionId` in the same collection) so old URLs keep working.

Social cards:

- Astro's `/api/og.png` endpoint passes query values to `OpenGraphCard.tsx` through React, then renders a 1200×630 PNG with `takumi-js/response` and its precompiled Workers WASM backend.
- Await `ImageResponse.ready` before caching or returning so a failed render follows the existing debug/fallback response contract. Takumi shares its default renderer and caches; the route's public one-day edge cache remains unchanged.
- The renderer's `isEmojiImageUrl` helper restricts image fetching to known emoji assets. Public query values cannot enable arbitrary background-image requests.

GitHub showcase:

- `src/pages/profile.astro` calls `src/lib/github.ts` (server-side).
- `src/pages/api/github/summary.ts` exposes the same summary data for debugging.
- Caching uses `caches.default` when available.
- Optional env: `GITHUB_TOKEN`.

Auth (OIDC skeleton):

- Login flow: `/api/auth/login` -> IdP -> `/api/auth/callback` -> signed cookie session.
- `src/middleware.ts` hydrates `Astro.locals.user/session` from the signed cookie when configured.
- The feature is inert unless `AUTH_SESSION_SECRET` + OIDC settings exist.

Rust + WebAssembly lab (exploration):

- `crates/energy-ring` is a Rust crate compiled to WebAssembly by `bun run build:wasm` (wasm-pack, `--target web`). Its output in `crates/energy-ring/pkg/` is generated and gitignored.
- `src/pages/lab/energy-ring.astro` loads `src/scripts/energy-ring.ts`, which imports the generated ES module. Vite emits the `.wasm` as a hashed static asset; nothing from the crate runs in the Worker.
- `src/lib/audio-bus.ts` routes each `<audio>`/`<video>` element through one shared `AnalyserNode` when it starts playing. The crate reads that analyser, runs the spectrum analysis and beat detection, and issues every WebGL2 call. JavaScript keeps the frame loop, canvas sizing, and audio graph.
- Pipeline details, measurements, and limits: `docs/RUST_WASM.md`.

Deep Brush lab (exploration):

- `crates/deep-brush` runs Depth Anything V2 Small as WGSL compute shaders through wgpu (WebGPU backend only on the web; Vulkan/DX12/Metal natively for its examples), then paints on the surfaces it reconstructs. Strokes stay off whatever stands in front of the starting surface through a port of the Adobe preview's smart mask (`mask.rs`, evaluated per pixel in `stamp.wgsl`). `bun run build:wasm` builds it beside `energy-ring`.
- `src/pages/lab/deep-brush.astro` (unlisted, `noindex`) loads `src/scripts/deep-brush.ts`. The script downloads the 99 MB weights from Hugging Face on request (pinned revision, kept in Cache Storage); nothing is served from the Worker except the page, the bundle and `public/lab/deep-brush/sample.jpg`.
- Design, how Adobe's preview works, parity measurements, limits, and how to build and test it: `docs/DEEP_BRUSH.md`.

Meeting point lab (exploration):

- `src/pages/lab/meeting-point.astro` loads the React meeting-point island and bundled `public/lab/meeting-point/sf.json` preset. Other towns use real, bounded 4/8/12 km Overpass study squares, not hardcoded city graphs.
- A retained `meeting-point.worker.ts` owns loading, normalization, compact graph preparation, JavaScript shortest-path trees and collision contacts. Cancellation terminates active work; completed trees are reused for objective changes.
- The browser caches up to three validated live graphs for seven days. Autocomplete cancels stale Photon lookups; provider failures remain explicit, with no fabricated graph fallback.
- Canvas2D renders traversal, contact pings, routes and candidates. The measured Rust/WASM experiment failed its frozen promotion gate and remains archived, not shipped.
- User controls, privacy/provider limits and configuration: [README](README.md). Contracts, measurements, rejected prototype and restoration: [meeting-point acceleration evidence](docs/MEETING_POINT_WASM.md).

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
- Vite 8.3.6 and React integration 7.1.4 use their default Rolldown/Oxc transforms and automatic chunks. There is no custom vendor grouping, global Vite override, or experimental React compiler.
- Markdown/MDX: Astro's explicit `unified()` processor runs `rehype-mermaid` before SVG normalization. Mermaid 12 retains neutral/classic/Dagre rendering; scoped overrides replace the old Mermaid/KaTeX graph. Shiki excludes Mermaid fences, and `compressHTML: true` retains HTML-aware whitespace.
- SSR `optimizeDeps`: `astro.config.ts` includes a custom Vite plugin that pre-bundles app deps (React, Radix, lucide-react, astro-navbar, etc.) for the workerd SSR environment so the adapter doesn't have to discover them at runtime (avoids cascading "program reload" errors — [withastro/astro#16248](https://github.com/withastro/astro/issues/16248)).

## Local Verification

- Build: `bun run build`
- WebAssembly only: `bun run build:wasm` (requires Rust stable and wasm-pack). `bun run build` runs it; `bun run dev` and `bun run astro check` need it run once first.
- Type/content check: `bun run astro check`
- Local Workers preview: `bun run preview` (runs the same workerd runtime that production uses)
- Built Worker regression: `bun run test:worker` after the build. Astro's preview API starts and stops the runtime. A unique per-run subtitle prevents persisted cache hits. CI checks two fully decoded PNGs, query-dependent pixels, and zero requests to a local image trap.
- Local dev: `bun run dev` (include a cold optimizer cache and a restart when verifying SSR dependency changes)
- Wrangler dry-run deploy: `bun run deploy.dryrun`
