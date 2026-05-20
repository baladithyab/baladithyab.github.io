# Deployment (Cloudflare Workers)

The site deploys to **Cloudflare Workers** with Workers Static Assets (Cloudflare's modern successor to Cloudflare Pages, recommended for new Astro projects post-Cloudflare-acquisition).

## Build Output

- Output dir: `dist/` (built by `bun run build`)
- Astro SSR output: `astro.config.ts` uses `output: "server"` + `@astrojs/cloudflare` v13 adapter
- Worker entry: `@astrojs/cloudflare/entrypoints/server` (the unified Astro 6 entrypoint, declared as `main` in `wrangler.jsonc`)

## Wrangler Config

`wrangler.jsonc` (Workers project type):

```jsonc
{
  "name": "codeseys-personal-website",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "binding": "ASSETS", "directory": "./dist" },
  "observability": { "enabled": true }
}
```

## CI

Workflow: `.github/workflows/cloudflare-deploy.yml`

- Pull requests: build + type check only
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

If Wrangler fails to write logs due to home-directory permissions, you can try:

```bash
WRANGLER_HOME=/tmp/wrangler XDG_CONFIG_HOME=/tmp/xdg HOME=/tmp bun run preview
```

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
