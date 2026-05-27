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
#
# Configuration (env-overridable):
#   R2_BUCKET           default: assets-r2
#   R2_PUBLIC_HOST      default: assets-r2.codeseys.io
#   R2_ZONE_ID          default: 9ed23f69a6ff0763a5bce7aa3ff570f9 (codeseys.io zone)
#   R2_MIN_TLS          default: 1.2

set -euo pipefail

BUCKET="${R2_BUCKET:-assets-r2}"
PUBLIC_HOST="${R2_PUBLIC_HOST:-assets-r2.codeseys.io}"
ZONE_ID="${R2_ZONE_ID:-9ed23f69a6ff0763a5bce7aa3ff570f9}"
MIN_TLS="${R2_MIN_TLS:-1.2}"

echo "→ Creating R2 bucket '${BUCKET}' (skip if exists)..."
if bunx wrangler r2 bucket info "${BUCKET}" >/dev/null 2>&1; then
  echo "  bucket exists; skipping create"
else
  echo "no" | bunx wrangler r2 bucket create "${BUCKET}" || true
fi

echo "→ Setting CORS rules..."
CORS_FILE="$(mktemp)"
cat > "${CORS_FILE}" <<'JSON'
{
  "rules": [
    {
      "allowed": {
        "origins": [
          "https://codeseys.io",
          "https://www.codeseys.io",
          "https://baladithyab.github.io",
          "http://localhost:4321",
          "http://localhost:8787"
        ],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "exposeHeaders": ["ETag", "Content-Length", "Content-Type"],
      "maxAgeSeconds": 3600
    }
  ]
}
JSON
bunx wrangler r2 bucket cors set "${BUCKET}" --file "${CORS_FILE}"
rm "${CORS_FILE}"

echo "→ Attaching custom domain '${PUBLIC_HOST}'..."
if bunx wrangler r2 bucket domain list "${BUCKET}" 2>/dev/null | grep -q "${PUBLIC_HOST}"; then
  echo "  custom domain exists; skipping"
else
  bunx wrangler r2 bucket domain add "${BUCKET}" \
    --domain "${PUBLIC_HOST}" \
    --zone-id "${ZONE_ID}" \
    --min-tls "${MIN_TLS}" \
    --force
fi

echo
echo "═══════════════════════════════════════════════════════════════"
echo " Bucket '${BUCKET}' bootstrapped:"
echo "   • CORS:   GET/HEAD from codeseys.io + baladithyab.github.io + localhost"
echo "   • Domain: https://${PUBLIC_HOST}"
echo
echo " Wait ~1-15 minutes for SSL provisioning. Check with:"
echo "   bunx wrangler r2 bucket domain get ${BUCKET} --domain ${PUBLIC_HOST}"
echo
echo " Manual step remaining (one-time, dashboard-only):"
echo "   Generate an R2 API token (NOT user tokens):"
echo "     → R2 dashboard → Manage API Tokens → Create API Token"
echo "     → permissions: Object Read & Write, scoped to bucket '${BUCKET}'"
echo "     → save: Access Key ID, Secret Access Key, Endpoint URL"
echo
echo "   Then save the credentials as GitHub user-level secrets so any"
echo "   baladithyab/* repo picks them up automatically:"
echo
echo "     gh secret set R2_ACCESS_KEY_ID    --user --body '<key id>'"
echo "     gh secret set R2_SECRET_ACCESS_KEY --user --body '<secret>'"
echo "     gh secret set R2_ENDPOINT_URL      --user --body 'https://<account-id>.r2.cloudflarestorage.com'"
echo "     gh secret set R2_BUCKET            --user --body '${BUCKET}'"
echo "═══════════════════════════════════════════════════════════════"
