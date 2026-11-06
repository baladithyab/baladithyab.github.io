# Astro 7 migration verification

Verified 2026-11-05 (America/Los_Angeles), from base
`bd836ef4a9f0de7cc6f5af1b193482d08a0b4ed4`, in the isolated
`t3/astro-7-migration` worktree. Local tools: Node **24.15.0**, Bun **1.4.4**,
Windows x64. The declared minimum and all three CI jobs use Node **22.23.4**;
that exact Node release was not exercised locally. No machine-global tool
changes were made.

## Package and configuration decisions

Registry engine and peer metadata was checked before installation:

| Package | Resolved version | Compatibility |
| --- | --- | --- |
| Astro | 7.4.7 | Node >=22.23.4; Vite ^8.3.5; markdown-remark ^7.3.0 |
| Cloudflare adapter | 14.4.6 | Astro ^7.4.0; Wrangler ^4.125.0 |
| React integration | 6.0.6 | React/DOM 19 supported; integration 7 migration deferred |
| MDX | 8.1.3 | Astro ^7.2.10; markdown-remark ^7.3.0 |
| markdown-remark | 7.3.6 | Explicit unified processor |
| React / React DOM | 19.3.1 / 19.3.1 | Exact existing pins retained |
| Vite | 8.3.6 | Single resolved version, including Vitest and plugin peers |
| Sharp | 0.35.5 | Single resolved version, including Astro and both Miniflare paths |
| WASM OG | 0.5.0 | Resolves @cf-wasm/satori 0.4.2 / Satori 0.32.0 |
| Wrangler (direct) | 4.158.0 | Workers types ^5.20261104.1 peer |
| Workers types | 5.20261106.1 | Compatible v5 peer; replaces the incompatible v4 declaration |

TypeScript 6.0.3, Vitest/coverage 4.1.12, and Tailwind 4.3.4 remain.
The Cloudflare Vite plugin also brings Wrangler 4.156.1 and Miniflare
5.20261101.0-beta; direct Wrangler uses Miniflare 5.20261104.0-beta.
Both Miniflare paths resolve Sharp 0.35.5.

The Vite 7 global override is removed. The existing chunk function moves to
`build.rolldownOptions`; function-form `manualChunks` remains supported but
deprecated in Vite 8. It is not the removed object form. The explicit esbuild
minifier is removed in favor of the Vite 8 default. Chunk redesign is deferred.

Markdown and MDX share `markdown.processor = unified({ rehypePlugins: [...] })`.
Shiki still excludes Mermaid, and `rehype-mermaid` runs before normalization.
MDX inherits the processor without duplicate legacy plugin options.
`compressHTML: true` retains HTML-aware whitespace handling. The SSR dependency
optimizer workaround and LRU session driver remain. No application template
fix was required by the compiler or checks.

References: [Astro 7 migration](https://docs.astro.build/en/guides/upgrade-to/v7/),
[unified API](https://docs.astro.build/en/reference/markdown-processors/unified/),
[MDX processor inheritance](https://docs.astro.build/en/guides/integrations-guide/mdx/#processor),
[Vite 8 migration](https://vite.dev/guide/migration),
[Astro engine metadata](https://registry.npmjs.org/astro/7.4.7),
[adapter peer metadata](https://registry.npmjs.org/@astrojs%2fcloudflare/14.4.6),
[Wrangler peer metadata](https://registry.npmjs.org/wrangler/4.158.0).

## Commands and results

| Command | Actual result |
| --- | --- |
| `bun install --no-env-file` | Passed; updated binary `bun.lockb`, 715 packages installed |
| `bun install --frozen-lockfile --no-env-file` | Passed; checked 733 installs across 832 packages, no changes |
| `bunx --no-install playwright install chromium --only-shell` | Passed; browser already available |
| `bun run test` | Passed: 8 files, 184 tests |
| `bun run astro check` | Passed: 64 files, 0 errors, 0 warnings, 0 hints |
| `bun --no-env-file run build` | Passed: discovered 5 real project manifests; production Worker built in 4.74 seconds |
| `bun run preview --host 127.0.0.1 --port 4341` | Real built-Worker smoke passed, results below |
| `bun run dev --host 127.0.0.1 --port 4341` | Cold first request and restart passed, results below |
| `bun why sharp`, `bun why vite`, `bun why satori`, `bun why katex` | Confirmed resolved paths and versions |
| Recursive installed-package inspection + native Sharp transform | One physical Sharp copy; synthetic PNG resized to 8x6 WebP successfully |
| `bun audit --no-env-file` | Exit 1: two advisories, 1 moderate + 1 low |
| `git diff --check` | Passed |

Vitest emitted a non-blocking warning that ESM syntax in `vitest.config.ts`
will need attention if a future Vite major changes the default config loader.
No warning suppression was added.

## Built Worker evidence

HTTP bodies were fully consumed, with footer and closing HTML checks for pages.
No browser or preview tool was used. Temporary Node smoke scripts were removed.

| Route / check | Result |
| --- | --- |
| `/` | 200 complete HTML, 40,590 bytes |
| `/blog` | 200 complete HTML, 69,011 bytes |
| `/blog/sota-ml-by-july-2025-from-explicit-features-to-implicit-world-models` (MD) | 200 complete HTML, 43,398 bytes |
| `/blog/visualizations-now-render-mermaid-and-images-on-the-blog` (MDX) | 200 complete HTML with Mermaid, 74,422 bytes |
| `/blog/mermaid-diagram-gallery` | 200 complete HTML, 243,237 bytes; six parsed SVGs matching six source fences |
| Gallery structure and styles | Six frame wrappers; intrinsic pixel dimensions and viewBoxes; no SVG width attribute or embedded style element; fetched CSS includes light/dark theme, toolbar and modal rules |
| `/profile` | 200 complete HTML, 102,130 bytes |
| `/api/github/summary` | 200 JSON, 9,647 bytes |
| `/projects` | 200 complete HTML with discovered projects |
| `/projects/cse-160` | 200 complete HTML; default iframe `https://assets-r2.codeseys.io/cse-160/33899fa/asg2/asg2.html` |
| Public default iframe asset | Read-only HEAD returned 200 `text/html` |
| `/projects/cse-160?asset=asg0` | 200; SSR retains default iframe; existing React asset selection happens after hydration |
| `/projects/cse-160?v=abcdef0` | 200; historical-version notice and iframe URL use `abcdef0` (HTML contract only; artifact not fetched) |
| `/api/embed-upload` GET | 200, service `project-embed-upload`; no upload attempted |
| `/api/projects/cse-160/versions` | 200, `{ "ok": true, "slug": "cse-160", "versions": [] }` against empty local R2 |
| `/api/og.png?debug=1&title=Astro%207%20migration` | 200 `image/png`, 108,474 bytes; signature `89504e470d0a1a0a`, IHDR 1200x630; no redirect/fallback |
| `/api/auth/login` | 503 JSON with auth disabled |
| `/api/auth/callback` | 503 with auth disabled |
| `/api/auth/session` | 200, `configured: false`, null user/session |
| `/api/auth/logout` | 302 to `/` with auth disabled |

Generated `dist/server/wrangler.json` retained compatibility date `2025-05-21`,
both compatibility flags, `codeseys.io` / `www.codeseys.io`, `PROJECT_ASSETS`
R2 and `IMAGES` bindings. Its built entry is `entry.mjs` and assets directory
is `../client`. No HTML caching was enabled.

Initial temporary harness assumptions were corrected from actual source:
`</html>` need not be the final bytes (Astro appends a page module script);
SVGs must be counted as parsed elements rather than raw SVG-like text; asset
selection happens in React after hydration; the real version parameter is `v`,
not `version`. The final checks passed without application behavior changes.

## Cold dev and restart

The first dev run began with a new dependency installation and no optimizer
cache. The first home request returned complete 200 HTML without a retry.
After Worker verification, the worktree's optimizer cache was moved aside
within ignored `node_modules` to repeat the cold run with parsed-SVG assertions.
The log confirmed dependency bundling. The server was then stopped/restarted
with the newly generated cache.

Both final runs returned complete 200 responses for home, blog, the MD post
above, and gallery. Each gallery contained exactly six parsed normalized SVGs
and frames. Cold/restart home responses were 118,576 bytes; the MD post
154,110 bytes; gallery 354,294 / 354,293 bytes. No React-hook, stale-module,
`Astro is not defined`, or other runtime errors appeared in the exercised
requests. This qualifies the retained workaround, not its removal. All local
servers were stopped after verification.

## Sharp and remaining risks

`bun why sharp` shows one version **0.35.5** for the direct dependency, Astro's
optional `^0.35.4`, and both Miniflare paths. A recursive installed-manifest
traversal found one physical copy, `node_modules/sharp`. Its native binary
reported Sharp 0.35.5 / libvips 8.18.7. A benign 16x12 synthetic RGBA image
was encoded as PNG, decoded, resized to 8x6, then encoded as a 68-byte WebP;
metadata verified dimensions and format. No exploit image was exercised.

The actual audit remains **two advisories**, so this is not a clean security
audit or production acceptance:

- **Satori 0.32.0, moderate**: `@cf-wasm/og@0.5.0` ->
  `@cf-wasm/satori@0.4.2` -> `satori@0.32.0`.
  [GHSA-wx4j-mvgx-mqwp](https://github.com/advisories/GHSA-wx4j-mvgx-mqwp)
  requires >=0.33.5. A real PNG response does not prove the advisory harmless.
  OG 0.5 does not guarantee patched Satori; no incompatible override was forced.
- **KaTeX 0.16.47, low**: Mermaid 11.17.2 (`^0.16.47`) and mermaid-isomorphic
  3.1.0 (`^0.16.0`) both resolve the affected version.
  [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7)
  requires >=0.18.2, outside both ranges. Diagram compilation uses repository
  content; exploitability was not tested. An upstream-compatible parent update
  is still needed.

Parent-owned browser visual/hydration review remains outstanding, including
asset-tab selection, theme toggling and Mermaid zoom. CSS/HTML checks do not
qualify those interactions. Local R2 was empty; no live R2 listing, uploads,
OIDC login, secret inspection or production deployment was performed. The
minimum Node release still requires CI evidence. Parent handles reviews,
integration and release.
