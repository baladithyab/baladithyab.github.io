# Deployment (Cloudflare Workers)

The site deploys to **Cloudflare Workers** with Workers Static Assets (Cloudflare's modern successor to Cloudflare Pages, recommended for new Astro projects post-Cloudflare-acquisition).

## Build Output

- Output dir: `dist/` (built by `bun run build`)
- Astro SSR output: `astro.config.ts` uses `output: "server"` + `@astrojs/cloudflare` v14 adapter
- Worker entry: `@astrojs/cloudflare/entrypoints/server` (the unified Astro entrypoint, declared as `main` in `wrangler.jsonc`)
- The adapter emits `dist/server/entry.mjs`, `dist/server/wrangler.json`, and static assets under `dist/client/`. `.wrangler/deploy/config.json` selects the generated config; use the normal project-root Wrangler commands after building.

## Wrangler Config

`wrangler.jsonc` (Workers project type):

```jsonc
{
  "name": "codeseys-personal-website",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2025-05-21",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "binding": "ASSETS", "directory": "./dist" },
  "observability": { "enabled": true }
}
```

## CI

Workflow: `.github/workflows/cloudflare-deploy.yml`

- All jobs use Node 22.23.4 from `.nvmrc` and frozen Bun installs.
- All jobs install the Rust toolchain from `rust-toolchain.toml` and wasm-pack, because `bun run build` compiles `crates/` to WebAssembly first (see `docs/RUST_WASM.md`).
- Pull requests: unit tests + type check + build, followed by the existing preview Worker version upload (no production traffic promotion).
- Push to `main`/`master`: build + `wrangler deploy` via `cloudflare/wrangler-action@v3`

Required GitHub repo secrets/vars:

- `secrets.CLOUDFLARE_API_TOKEN`
- `vars.CLOUDFLARE_ACCOUNT_ID`

## Runtime Secrets / Vars

Blog posts are repo-owned Astro Markdown content files under `src/content/blog/`; no CMS runtime secrets are required for blog rendering.

GitHub (optional):

- `GITHUB_TOKEN` (secret)

Auth (optional OIDC skeleton):

- `AUTH_SESSION_SECRET` (secret)
- OIDC vars (see `docs/AUTH_OIDC.md`)

Set them as Worker secrets:

```bash
wrangler secret put GITHUB_TOKEN
wrangler secret put AUTH_SESSION_SECRET
# ... etc
```

In code, read them via:

```ts
import { getRuntimeEnv } from '@/lib/runtime-env'
const runtimeEnv = getRuntimeEnv<{ GITHUB_TOKEN?: string }>()
```

## Local Workers Preview

`astro preview` runs the same workerd runtime that production uses, so it's the highest-fidelity local check:

```bash
bun run build
bun run preview
```

Smoke test against a few routes:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/blog
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/api/github/summary
```

Use a unique port when verifying alongside another checkout, for example
`bun run preview --host 127.0.0.1 --port 4341`. This runs the built Worker
locally without deploying. Do not treat a successful dev response as evidence
that the built Worker works. Verify complete HTML, Markdown and MDX Mermaid
SVGs, and a real 1200x630 PNG from `/api/og.png?debug=1` (a fallback redirect
is a failure). Local R2 starts empty; a successful empty versions response
does not verify production assets or uploads.

## Manual Deploy

```bash
bun run build
bun run deploy        # wrangler deploy
bun run deploy.dryrun # wrangler deploy --dry-run (validates wrangler.jsonc + bundle)
```

## Migration Note

This project was previously deployed to Cloudflare **Pages** with `pages_build_output_dir = "dist"` in `wrangler.toml`. As of the May 2026 modernization, it now deploys to Cloudflare **Workers** with Workers Static Assets:

- `wrangler.toml` (Pages-style) → `wrangler.jsonc` (Workers-style with `main` + `assets` block)
- `cloudflare/wrangler-action ... pages deploy ...` → `cloudflare/wrangler-action ... deploy`
- `Astro.locals.runtime.env` (removed in Astro 6) → `getRuntimeEnv()` helper wrapping `import { env } from 'cloudflare:workers'`

If you have a custom domain attached to the old Pages project, [migrate it to the new Worker](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) once the new deploy is healthy.
