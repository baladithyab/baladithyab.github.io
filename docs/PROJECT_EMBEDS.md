# Project Embeds Architecture

> How `codeseys.io` discovers and embeds interactable versions of any project
> (college, side, hackathon, work — anything that reaches a "works" state)
> without ever building those projects in the personal-site repo.

This document is the **canonical reference** when adding a new embeddable
project to the site. Read this first before you start wiring up CI for a
project — most of the work has been done; you just have to give your repo
the right shape.

---

## TL;DR

1. Tag your project repo on GitHub with the topic **`codeseys-embed`**.
2. Drop a **`web.codeseys.json`** manifest at the repo root.
3. Pick a **delivery mode** (build-time bundle, R2 runtime, or foreign-origin
   runtime — see [Delivery modes](#delivery-modes)) and ship a CI workflow
   that produces the artifact and publishes it to that location.
4. The personal site picks the project up automatically on its next build:
   it appears in `/projects`, gets its own page at `/projects/<slug>`, and
   shows up as a `ProjectDemo` card in the bento grid.

No submodules. No monorepo. No personal-site PR per project.

---

## Why this design

The naive way to embed projects on a personal site is to add each one as a
git submodule and have the personal site build them all. That tightly
couples site deploys to project changes, makes auth painful for any
private project, and inflates the Worker bundle past Cloudflare's free
limits within a handful of additions.

The architecture below decouples the two concerns:

- **Each project owns its own build.** It compiles itself to a web-deployable
  artifact (WASM, static HTML, rendered notebook, browser-DB seed, etc.)
  and publishes that artifact to a stable public URL.
- **The personal site only owns discovery and rendering.** It enumerates
  repos by topic, fetches their manifests, validates them, and renders one
  page per manifest. Pages mount a small embed component that loads the
  artifact at the URL the manifest declares — or, for build-time-bundled
  projects, at a same-origin path the site copied the artifact into during
  its own build.

The result: adding a new project to `codeseys.io` is a self-service action
that lives entirely in the project's own repo.

---

## Architecture overview

```
                          GitHub
                            │
                            │ list repos with topic:codeseys-embed
                            ▼
              ┌────────────────────────────┐
              │ sync-project-manifests.ts  │  prebuild step in this repo
              │  (runs in personal-site CI)│
              └─────────────┬──────────────┘
                            │ for each repo:
                            │   GET raw.githubusercontent.com/<repo>/HEAD/web.codeseys.json
                            │   validate against zod schema
                            │   if delivery.mode === 'bundle':
                            │     fetch artifact, stage into dist/projects/<slug>/
                            │     rewrite delivery.url to same-origin path
                            │   write src/content/projects/<slug>.json
                            ▼
                   ┌──────────────────┐
                   │ Astro content    │
                   │   collection     │
                   │   `projects`     │
                   └────────┬─────────┘
                            │
                ┌───────────┴────────────┐
                ▼                        ▼
        /projects/index.astro      /projects/[slug].astro
                                          │
                                          ▼
                                  <EmbedRouter manifest={...} />
                                          │
                                  switches on manifest.embed.kind
                                          │
                  ┌────────────────┬──────┴──────┬───────────────┐
                  ▼                ▼             ▼               ▼
            <WasmEmbed>     <IframeEmbed>  <NotebookEmbed>  <PGliteEmbed>  ...
                                          │
                                          │ fetch(manifest.delivery.url)
                                          ▼
                            artifact loads from same-origin (bundled)
                            or assets-r2.codeseys.io (R2 runtime)
                            or external origin (foreign runtime)
```

The personal site's only direct dependency on each project is **the URL of
the artifact**. Project repos can be public or private; only the artifact
has to be reachable at that URL.

---

## The manifest: `web.codeseys.json`

Every embeddable project repo has this file at the repo root. The schema
is enforced by zod (see [`src/lib/types/project-manifest.ts`](../src/lib/types/project-manifest.ts)).

```json
{
  "schemaVersion": 1,
  "slug": "example-bigint-calculator",
  "category": { "kind": "college", "school": "UCSC", "code": "CSE 111", "title": "Compiler Design", "year": 2022 },
  "title": "BigInt arbitrary-precision calculator",
  "description": "Type expressions, see them parsed and evaluated in WebAssembly.",
  "tags": ["compilers", "c++", "wasm"],
  "thumbnail": "thumb.png",
  "completionLevel": "ships",

  "embed": {
    "kind": "wasm-emscripten",
    "entry": "bigint.js",
    "memory": "16MB"
  },

  "delivery": {
    "mode": "runtime-r2",
    "url": "https://assets-r2.codeseys.io/example-bigint-calculator/abc1234/",
    "version": "abc1234",
    "sizeBytes": 412800
  },

  "build": {
    "ci": true,
    "workflow": ".github/workflows/build-web-asset.yml"
  }
}
```

### Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | `1` | yes | Bumped when the schema breaks compat. |
| `slug` | `string` (`[a-z0-9-]+`) | yes | URL slug. Must be globally unique. The site's route is `/projects/<slug>`. |
| `category` | object | yes | See **Categories** below. |
| `title` | `string` | yes | Card and page title. |
| `description` | `string` | yes | One- or two-sentence pitch. Shown on the card and as the page intro. |
| `tags` | `string[]` | no | Free-form. Used by the `/projects` filter. |
| `thumbnail` | `string` | no | Path or URL of a card image. Resolved relative to `delivery.url` if not absolute. |
| `completionLevel` | enum | yes | `wip` \| `works` \| `ships`. The site filters out `wip` from the homepage and only surfaces it on `/projects?show=wip`. |
| `embed` | object | yes | Discriminated union by `kind`. See **Embed kinds** below. |
| `delivery` | object | yes | How the site acquires and serves the artifact. See **Delivery modes** below. |
| `build.ci` | `boolean` | yes | `true` if a CI workflow produces the artifact. `false` only for hand-published artifacts (legacy / one-offs). |
| `build.workflow` | `string` | no | Path to the workflow file in the project repo, used for "view CI" links. |

### Categories

The `category` field tags the project by life-stage so the `/projects`
page can group them sensibly:

```ts
type Category =
  | { kind: 'college'; school: 'UCSC' | 'USC'; code: string; title: string; year: number }
  | { kind: 'hackathon'; event: string; year: number }
  | { kind: 'side'; year: number }                  // personal projects
  | { kind: 'work'; org?: string; year: number }    // employer-permitted artifacts
  | { kind: 'research'; venue?: string; year: number }
```

This deliberately replaces the original "college projects only" framing —
the site's project section is for **anything I built that reaches a working
state**, regardless of context.

---

## Embed kinds

`embed.kind` is the contract between the artifact and the site's renderer.
Each kind has a matching React component in `src/components/embeds/`.

| `kind` | Use when… | Build target | Renderer component |
|---|---|---|---|
| `static-html` | The project is already a web page or SPA. | `dist/` of any static-site build (e.g. `vite build`) | `<IframeEmbed>` (sandboxed iframe) |
| `wasm-emscripten` | C/C++/Rust-via-emcc that should run in browser. | `emcc` produces `*.js` + `*.wasm` | `<WasmEmbed>` |
| `wasm-rust` | Rust that should run in browser. | `wasm-pack build --target web` | `<WasmEmbed>` (same component, different loader path) |
| `pyodide` | Python algorithms (game agents, sims) that should be playable. | Python source + dependency list bundled with Pyodide loader | `<PyodideEmbed>` |
| `notebook-html` | Jupyter notebook is the deliverable. | `jupyter nbconvert --to html` | `<NotebookEmbed>` (iframe of rendered HTML) |
| `pglite-db` | DB project — schema, queries, optionally seed data. | A `schema.sql` and optional `seed.sql` are bundled. | `<PGliteEmbed>` (Postgres in browser via PGlite, includes a query runner) |
| `tex-pdf` | LaTeX writeup — proofs, papers. | `latexmk` produces a PDF | `<PdfEmbed>` (PDF.js viewer) |
| `external-app` | Project requires a server (a real DB, ML model, etc.). | Project deploys itself to Fly/Railway/etc. | `<IframeEmbed>` of the remote URL |

Adding a new kind means: add a discriminant branch in the zod schema, add
a renderer component, register it in `<EmbedRouter>`. That's it.

### Why these eight cover almost everything

- **`static-html`** absorbs every WebGL/Vue/React/Svelte assignment.
- **`wasm-emscripten` + `wasm-rust`** absorb every native-code project that
  doesn't talk to a real OS — algorithms, compilers, parsers, sims,
  graphics, audio.
- **`pyodide`** absorbs Python projects light enough to run client-side.
  Game-playing agents are the killer use case.
- **`notebook-html`** absorbs every "I have a Jupyter notebook" project at
  the cost of being read-only. That's fine — recruiters mostly want to
  see the code and the plots, not run the code.
- **`pglite-db`** absorbs DB-class projects (full Postgres in WASM via
  ElectricSQL's PGlite, including PostGIS).
- **`tex-pdf`** absorbs theory writeups so you can list them next to code.
- **`external-app`** is the escape hatch for anything too big to run in
  the browser. Your project deploys itself; the site just iframes it.

---

## Delivery modes

`delivery.mode` decouples **when** the site acquires the artifact from
**where** it's served. Three modes, picked per project:

| Mode | Acquired | Served from | Set `delivery.url` to |
|---|---|---|---|
| `bundle` | site CI at build time | same origin (`codeseys.io/projects/<slug>/`) | absolute URL the site fetches **once at build**; the site rewrites this to the same-origin path before writing the content entry |
| `runtime-r2` ⭐ default | visitor at view time | `assets-r2.codeseys.io/<slug>/<version>/` | the public R2 URL that the project's CI uploaded to |
| `runtime-foreign` | visitor at view time | wherever the project hosts it (gh-pages, Fly, the project's own Worker) | the public URL of the foreign deployment |

### When to use each

**`runtime-r2` — the default.** Use unless you have a specific reason not
to. R2 is on the same root domain as the site (no per-project Pages
config), versioned by SHA in the URL path (`<slug>/<version>/`), free
storage at portfolio scale, and zero egress charges. The project's CI
uploads to `s3://assets-r2/<slug>/<sha>/` via R2's S3-compatible API; the
manifest's `delivery.url` points at the same SHA path. Atomic rollback =
repoint the manifest at a previous SHA.

**`bundle` — for small, safety-critical, or fully-offline-capable
artifacts.** The site's prebuild step fetches the declared `delivery.url`
once, copies the contents into `dist/projects/<slug>/`, and rewrites the
content entry's URL to a same-origin path. Use when:

- Artifact is small (< ~1 MB compressed). Anything bigger inflates the
  Cloudflare Workers static-assets quota.
- The project must work even if R2 / GitHub / external hosts are down
  (true same-origin static asset).
- You want zero runtime fetches — the artifact ships with the page.
- CORS would otherwise be a hassle (e.g. WASM workers across origins).

**`runtime-foreign` — escape hatch.** Use when the project already has a
live deployment you'd rather embed than mirror, or when the project
exposes a real server (Fly, Railway, Modal). The `external-app` embed
kind almost always pairs with this delivery mode.

> **Why R2 over per-repo gh-pages**: gh-pages was tempting (free, zero
> setup) but it splits artifact hosting across `*.github.io` URLs you
> don't control, breaks if Pages config drifts, has no per-version path
> convention, and adds a third origin to the trust boundary. R2 with a
> custom subdomain on the same eTLD+1 as the site is cleaner end-to-end.
> `runtime-foreign` keeps gh-pages available for cases where it actually
> fits (an external-app project that already deploys there).

### Behavior in the personal-site discovery script

```ts
// pseudocode in src/scripts/sync-project-manifests.ts
switch (manifest.delivery.mode) {
  case 'bundle':
    await fetchAndStage(manifest.delivery.url, `dist/projects/${manifest.slug}/`)
    manifest.delivery.url = `/projects/${manifest.slug}/`  // rewrite to same-origin
    break
  case 'runtime-r2':
  case 'runtime-foreign':
    // leave url as-is; the embed component will fetch at view time
    break
}
await writeContentEntry(manifest)
```

The renderer components are mode-agnostic: they take a `url` prop and
load from it. The site doesn't care whether that URL is same-origin
(because it was bundled) or external (because it's served live).

---

## Setting up `assets-r2.codeseys.io` (one-time)

The R2 bucket and custom subdomain are shared across all projects. Set
up once, used forever.

1. **Create the bucket.** Cloudflare Dashboard → R2 → Create bucket →
   name: `assets-r2`, location: auto.
2. **Attach the custom domain.** In the bucket's **Settings** tab →
   **Public access** → **Connect Domain** → `assets-r2.codeseys.io`.
   Cloudflare auto-creates the CNAME because the apex (`codeseys.io`) is
   already on Cloudflare DNS.
3. **CORS rule on the bucket** (R2 → bucket → Settings → CORS Policy):
   ```json
   [
     {
       "AllowedOrigins": ["https://codeseys.io", "https://*.codeseys.io", "https://baladithyab.github.io", "http://localhost:4321"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. **Generate an R2 API token** scoped to this bucket only, with
   `Object Read & Write` permissions. Save the access key ID and secret
   access key.
5. **Store the credentials as GitHub organization secrets**, not per-repo,
   so any project can use them. Add to all three orgs/users that host
   embeddable projects (e.g. `Codeseys`, `Codeseys-Labs`, `baladithyab`):
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ENDPOINT_URL` (`https://<account_id>.r2.cloudflarestorage.com`)
   - `R2_BUCKET` (`assets-r2`)
6. **Test once** by uploading a hello-world artifact via `aws s3 cp` with
   the R2 endpoint, then `curl https://assets-r2.codeseys.io/hello/index.html`
   to confirm it serves with permissive CORS.

After this, every project that wants `runtime-r2` delivery just calls
the shared upload step in its CI; no per-project R2 setup needed.

### Versioning convention

Always upload to `<slug>/<git-sha>/`. Never to `<slug>/`. This means:

- Two pushes to the same project don't race each other.
- The manifest's `delivery.version` field unambiguously names which
  artifact the manifest is referencing.
- Rollback is a single-line manifest edit.
- A "latest" alias can be done via a tiny redirect rule on the bucket if
  ever needed, but most projects shouldn't bother — the site already
  pins to a SHA per build.

### Garbage collection

R2 storage is cheap but not free. A monthly cron in this repo's CI
(`scripts/r2-gc.ts`) lists `assets-r2/` prefixes, cross-references
against the active manifest set, and deletes anything that's older than
90 days **and** isn't referenced by any current manifest. Run it as a
scheduled GitHub Action.

---

## Hosting summary

The site ships from two domains, both first-class:

- Primary: `codeseys.io` (Cloudflare Worker, see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md))
- Backup: `baladithyab.github.io` (GitHub Pages mirror)

Embeds must work on either domain. That means:

- **No hardcoded `codeseys.io` URLs** in renderers — relative paths and
  `Astro.url.origin` only.
- The R2 CORS rule whitelists both domains.
- For `bundle` mode, both site builds copy the artifact into their own
  `dist/projects/<slug>/`, so same-origin loading works on both.

---

## Private repos

A private project repo can still publish a public artifact:

- For **`runtime-r2`** mode: the private repo's CI pushes to the shared
  R2 bucket using the org-secret credentials. The R2 URL is public; the
  source stays private.
- For **`bundle`** mode: same as above — the private repo's CI uploads
  to R2, then the personal site's CI fetches from R2 at build time. The
  R2 URL is the staging area whether you bundle or not.
- For **`runtime-foreign`** + GitHub Pages: requires GitHub Pro for
  public Pages on a private repo, or use a separate public mirror repo
  (`<project>-public-artifacts`) whose only content is the built bundle.

In every case, only the *behavior* of the project is exposed; the source
code remains private.

---

## Discovery flow in the personal site

Discovery runs at **build time** in this repo. The implementation lives
in [`src/scripts/sync-project-manifests.ts`](../src/scripts/sync-project-manifests.ts)
and is wired into `package.json` as a `prebuild` script.

It:

1. Lists repos under the configured GitHub accounts (`Codeseys`,
   `Codeseys-Labs`, `baladithyab`) that have the topic `codeseys-embed`.
2. For each repo, fetches the manifest from
   `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/web.codeseys.json`.
   For private repos, it falls back to fetching the manifest from R2
   (the project's CI uploads the manifest alongside the artifact).
3. Validates each manifest against the zod schema. Invalid manifests are
   skipped and logged (the build does not fail — a bad manifest in one
   project should never block a site deploy).
4. **For `bundle` mode**: fetches `delivery.url`, copies the contents
   into `dist/projects/<slug>/`, rewrites `delivery.url` to the
   same-origin path. Validates against `delivery.sizeBytes` to catch
   surprise blowouts.
5. Writes `src/content/projects/<slug>.json` for each valid manifest.

Astro's content collection (`projects`, defined in
[`src/content.config.ts`](../src/content.config.ts)) picks these up and
exposes them to pages at build time.

If you ever want **runtime** discovery (manifest changes appear on the
site without a redeploy), the same script can run inside the Worker on a
cron and write to KV — but build-time is the default.

---

## Adding a new project: end-to-end checklist

1. **Get your project to a "works" state.** It doesn't need to be polished;
   `completionLevel: "works"` is a valid state. `wip` is also allowed but
   hidden by default.
2. **Pick the embed kind.** Look at the table above. If your project
   doesn't fit any of them, ask whether you really need a new kind or
   whether `external-app` (deploy somewhere, iframe it) is enough.
3. **Pick the delivery mode.** `runtime-r2` for almost everything,
   `bundle` for small fully-offline-capable artifacts, `runtime-foreign`
   for projects with their own existing live deployment.
4. **Author `web.codeseys.json`** at the repo root. Validate it locally
   with the schema (you can run the personal-site script against it via
   `bun run scripts/sync-project-manifests.ts --local <path>`).
5. **Write the build workflow** in your project repo. Reusable workflows
   live at `Codeseys-Labs/web-embed-workflows/.github/workflows/`. Your
   workflow is typically 10 lines:
   ```yaml
   on:
     push: { branches: [main] }
     workflow_dispatch:
   jobs:
     build:
       uses: Codeseys-Labs/web-embed-workflows/.github/workflows/wasm-emscripten.yml@main
       with:
         manifest: web.codeseys.json
       secrets: inherit  # picks up R2_* org secrets for upload
   ```
6. **Verify the artifact**. Push, watch CI, confirm:
   - `runtime-r2`: `curl https://assets-r2.codeseys.io/<slug>/<sha>/` returns the entrypoint.
   - `bundle`: same as above (R2 is the staging area for bundle mode too).
   - `runtime-foreign`: the foreign URL is reachable and CORS-permissive.
7. **Add the GitHub topic `codeseys-embed`** to the repo. Until you do
   this, the personal site will never discover it.
8. **Trigger a personal-site rebuild** (push any change, or run the
   "redeploy" workflow). The new project appears at `/projects/<slug>`.

If anything is missing or wrong, the personal-site build logs will name
the project and the failing field. The build does not break.

---

## Constraints, pitfalls, and policies

- **No project source bundled into this repo.** The personal site never
  takes a build dependency on a project's source. If you find yourself
  importing from a project repo, stop and put a manifest there instead.
- **Cloudflare Worker bundle stays small.** Embeds load artifacts via
  `<script src>` / `<iframe src>` from R2 or external URLs at runtime;
  nothing bigger than the small embed components is bundled into the
  Worker. `bundle` mode artifacts go into `dist/` (Workers static
  assets), which has its own quota — keep individual bundles under
  ~1 MB.
- **Slugs are global and immutable once published.** Renaming a slug
  breaks any external link to `/projects/<old-slug>`. Add an alias in the
  manifest (`legacySlugs`) instead — coming in `schemaVersion: 2`.
- **Manifests must validate or they're silently skipped.** This is
  intentional. The site never fails to deploy because a project repo has
  a typo in its manifest.
- **Sandbox iframes by default.** All `<IframeEmbed>` instances apply
  `sandbox="allow-scripts allow-same-origin"`. Loosen on a per-kind basis
  only when necessary.
- **Academic-integrity audit before flipping repos public.** Some
  university courses prohibit publicly posting submitted work. The
  artifact-only path (private source, public R2 artifact) sidesteps this:
  visitors can use the project but can't fork the source.
- **Always pin to a SHA in the R2 path.** Never overwrite `<slug>/` directly.
  Versioned paths make rollback a one-line manifest edit.
- **CORS lockdown matters.** The bucket whitelists `codeseys.io`,
  `*.codeseys.io`, `baladithyab.github.io`, and `localhost:4321` only.
  Don't open it to `*` — the bucket is for this site's embeds, not for
  general public hotlinking.

---

## Reference

- Manifest schema: [`src/lib/types/project-manifest.ts`](../src/lib/types/project-manifest.ts)
- Discovery script: [`src/scripts/sync-project-manifests.ts`](../src/scripts/sync-project-manifests.ts)
- R2 garbage-collection script: [`src/scripts/r2-gc.ts`](../src/scripts/r2-gc.ts)
- Embed components: [`src/components/embeds/`](../src/components/embeds/)
- Routes: [`src/pages/projects/index.astro`](../src/pages/projects/index.astro), [`src/pages/projects/[slug].astro`](../src/pages/projects/[slug].astro)
- Reusable CI workflows: [Codeseys-Labs/web-embed-workflows](https://github.com/Codeseys-Labs/web-embed-workflows)
- Companion blog post: [`/blog/build-anything-make-it-playable-an-architecture-for-discoverable-project-embeds`](../src/content/blog/build-anything-make-it-playable-an-architecture-for-discoverable-project-embeds.mdx)
