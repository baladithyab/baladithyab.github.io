#!/usr/bin/env bash
# scripts/r2-bootstrap.sh — one-time setup for the project-embed assets bucket.
#
# Idempotent: safe to run multiple times. Skips steps that are already done.
#
# Prerequisites:
#   1. R2 must be enabled on the Cloudflare account (one-click via the dashboard;
#      requires a billing method on file even at $0/mo on the free tier).
#   2. wrangler must be authenticated: `bunx wrangler whoami` should show the
#      'Internet of Codeseys' account.
#
# Usage:
#   bun run r2:bootstrap

set -euo pipefail

BUCKET="${R2_BUCKET:-assets-r2}"
PUBLIC_HOST="${R2_PUBLIC_HOST:-assets-r2.codeseys.io}"

echo "→ Creating R2 bucket '${BUCKET}' (skip if exists)..."
if bunx wrangler r2 bucket list 2>/dev/null | grep -q "name: ${BUCKET}"; then
  echo "  bucket exists; skipping create"
else
  bunx wrangler r2 bucket create "${BUCKET}"
fi

echo "→ Setting CORS rules..."
CORS_FILE="$(mktemp)"
cat > "${CORS_FILE}" <<'JSON'
[
  {
    "AllowedOrigins": [
      "https://codeseys.io",
      "https://www.codeseys.io",
      "https://baladithyab.github.io",
      "http://localhost:4321",
      "http://localhost:8787"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
JSON
bunx wrangler r2 bucket cors put "${BUCKET}" --file "${CORS_FILE}"
rm "${CORS_FILE}"

echo
echo "═══════════════════════════════════════════════════════════════"
echo " Bucket created and CORS set."
echo
echo " Manual steps remaining (one-time, dashboard):"
echo "   1. Attach custom domain ${PUBLIC_HOST} to the bucket:"
echo "      → R2 → ${BUCKET} → Settings → Public access → Connect Domain"
echo "      → enter '${PUBLIC_HOST}' (the apex codeseys.io is already on CF DNS)"
echo
echo "   2. Generate an R2 API token (Account API Tokens, NOT user tokens):"
echo "      → R2 → Manage API Tokens → Create API Token"
echo "      → permissions: Object Read & Write, scoped to bucket '${BUCKET}'"
echo "      → save: Access Key ID, Secret Access Key, Endpoint URL"
echo
echo "   3. Save credentials as GitHub user-level secrets so any baladithyab/* repo"
echo "      picks them up automatically:"
echo "        gh secret set R2_ACCESS_KEY_ID  --user --body '<key id>'"
echo "        gh secret set R2_SECRET_ACCESS_KEY --user --body '<secret>'"
echo "        gh secret set R2_ENDPOINT_URL --user --body 'https://<account-id>.r2.cloudflarestorage.com'"
echo "        gh secret set R2_BUCKET --user --body '${BUCKET}'"
echo "═══════════════════════════════════════════════════════════════"
