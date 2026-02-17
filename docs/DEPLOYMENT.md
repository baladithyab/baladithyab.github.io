# Deployment (Cloudflare Pages)

Cloudflare Pages is the primary deployment target.

## Build Output

- Output dir: `dist` (see `wrangler.toml`)
- Astro SSR output: `astro.config.ts` uses `output: "server"` + Cloudflare adapter

## CI

Workflow: `.github/workflows/cloudflare-pages-deploy.yml`

- Pull requests: build only
- Push to `main/master`: build + deploy via `cloudflare/wrangler-action`

## Runtime Secrets / Vars

Notion:

- `NOTION_API_KEY` (secret)
- `NOTION_DATABASE_ID` (var or secret)

GitHub (optional):

- `GITHUB_TOKEN` (secret)

Auth (optional OIDC skeleton):

- `AUTH_SESSION_SECRET` (secret)
- OIDC vars (see `docs/AUTH_OIDC.md`)

## Local Pages Preview

```bash
bun run build
bun run preview.wrangler
```

If Wrangler fails to write logs due to home-directory permissions, you can try:

```bash
WRANGLER_HOME=/tmp/wrangler XDG_CONFIG_HOME=/tmp/xdg HOME=/tmp bun run preview.wrangler.pages -- --port 8788
```

