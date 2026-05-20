# Auth (OIDC) Skeleton

This repo includes an OIDC skeleton intended for Auth0 or Keycloak. It is **disabled by default** unless environment variables are set.

## Endpoints

- `GET /api/auth/login`
  - Starts Authorization Code + PKCE.
  - Sets short-lived cookies for `state` and PKCE `verifier`.
- `GET /api/auth/callback`
  - Validates `state`, exchanges `code` for tokens, verifies `id_token` via JWKS.
  - Issues a signed session cookie.
- `GET /api/auth/logout`
  - Clears the signed session cookie.
  - Optionally redirects to the IdP logout endpoint if available.
- `GET /api/auth/session`
  - Debug endpoint returning `{ configured, user, session }`.

## Session Model

- Cookie name: `codeseys_session`
- Format: `base64url(payload) + "." + base64url(hmac_sha256(payload, AUTH_SESSION_SECRET))`
- Payload includes minimal `user` and `session` metadata including expiry.

## Configuration

Required:

- `AUTH_SESSION_SECRET` (generate with `openssl rand -base64 32`)

Generic OIDC:

- `OIDC_ISSUER`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_REDIRECT_URI` (should be `https://<domain>/api/auth/callback`)
- Optional: `OIDC_LOGOUT_REDIRECT_URI`

Auth0 compatibility:

- `AUTH0_DOMAIN` (without protocol is fine)
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`
- `AUTH0_REDIRECT_URI`

Keycloak compatibility:

- `KEYCLOAK_ISSUER`
- `KEYCLOAK_CLIENT_ID`
- `KEYCLOAK_CLIENT_SECRET`
- `KEYCLOAK_REDIRECT_URI`

## Middleware

`src/middleware.ts` will hydrate `Astro.locals.user` and `Astro.locals.session` only when auth is configured.

## Notes / Caveats

- JWT verification is currently strict for `RS256`.
- Token refresh is not implemented (skeleton only).
- CORS is same-origin only to avoid cookie leakage.

