/**
 * GitHub Actions OIDC verification for the project-embed upload endpoint.
 *
 * Replaces the static `PROJECT_EMBED_UPLOAD_TOKEN` shared bearer:
 * - any GitHub Actions workflow under our owner with `permissions: id-token: write`
 *   can mint an OIDC token (a short-lived JWT) and present it as the bearer.
 * - the Worker verifies the token's signature against GitHub's published JWKS
 *   and authorizes on `repository_owner === ALLOWED_OWNER`.
 *
 * Why this is the right answer:
 * - zero-secret per-repo: any new repo we create just inherits authority from
 *   the org/user-level OIDC trust relationship. No `gh secret set` step.
 * - tokens are minute-scope, so leakage windows are tiny.
 * - the audit trail is rich: the JWT carries `repository`, `ref`, `sha`,
 *   `actor`, `workflow`, `job_workflow_ref` — much better than "someone with
 *   the bearer".
 *
 * References:
 *   https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
 *   https://token.actions.githubusercontent.com/.well-known/openid-configuration
 */

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const GITHUB_OIDC_JWKS_URI = 'https://token.actions.githubusercontent.com/.well-known/jwks'

/**
 * Owner whose workflows are trusted to upload embeds.
 * Currently a single value; if we ever need multi-owner trust (e.g. orgs +
 * user repos), promote to a Set.
 */
export const ALLOWED_OWNER = 'baladithyab'

/**
 * Default audience the workflow should request when minting its OIDC token.
 * The workflow side can pick any string here; we just have to agree on it.
 * Using the public site origin keeps it self-documenting.
 */
export const EXPECTED_AUDIENCE = 'https://codeseys.io'

/** A clock-skew allowance for `nbf`/`iat`/`exp` checks (5 seconds). */
const CLOCK_SKEW_SEC = 5

/** Lifetime of in-memory JWKS cache (1 hour). GitHub rotates rarely. */
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000

// ----------------------------- types ------------------------------------

export type GithubOidcClaims = {
  iss: string
  aud: string | string[]
  sub: string
  iat: number
  nbf?: number
  exp: number
  // GitHub-specific claims (subset).
  repository?: string
  repository_owner?: string
  repository_id?: string
  repository_owner_id?: string
  workflow?: string
  workflow_ref?: string
  job_workflow_ref?: string
  ref?: string
  ref_type?: string
  sha?: string
  actor?: string
  actor_id?: string
  event_name?: string
  run_id?: string
  run_number?: string
  run_attempt?: string
  environment?: string
}

export type OidcVerifyResult =
  | { ok: true; claims: GithubOidcClaims }
  | { ok: false; status: 401 | 403 | 503; message: string; details?: unknown }

type Jwk = {
  kid: string
  kty: string
  use?: string
  alg?: string
  n?: string
  e?: string
}

type JwksDoc = { keys: Jwk[] }

// ----------------------------- JWKS cache ----------------------------

let jwksCache: { fetchedAt: number; doc: JwksDoc } | null = null

/**
 * Fetch GitHub's JWKS document, with a 1-hour in-memory cache.
 * Falls back to refreshing if the cache misses on a kid lookup later.
 */
export async function getGithubJwks(forceRefresh = false): Promise<JwksDoc> {
  if (
    !forceRefresh &&
    jwksCache !== null &&
    Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS
  ) {
    return jwksCache.doc
  }
  const resp = await fetch(GITHUB_OIDC_JWKS_URI, {
    // Keep this conservative: short timeout, no credentials.
    cf: { cacheTtl: 3600, cacheEverything: true },
    // @ts-expect-error -- `cf` is a CF-Workers extension to RequestInit.
    headers: { Accept: 'application/json' },
  })
  if (!resp.ok) {
    throw new Error(`JWKS fetch failed: HTTP ${resp.status}`)
  }
  const doc = (await resp.json()) as JwksDoc
  jwksCache = { fetchedAt: Date.now(), doc }
  return doc
}

// ----------------------------- low-level helpers ---------------------

/** base64url -> Uint8Array. */
function base64urlDecode(input: string): Uint8Array {
  // Pad out to base64.
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4)
  const padded = input + '='.repeat(pad)
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** UTF-8 decode bytes. */
function utf8Decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf)
}

/** Find the JWK whose kid matches the JWS header. */
function findKey(doc: JwksDoc, kid: string): Jwk | null {
  return doc.keys.find((k) => k.kid === kid) ?? null
}

/** Convert an RSA public JWK to a CryptoKey for RS256 verification. */
async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error('JWKS key is not an RSA public key')
  }
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'RSA',
      n: jwk.n,
      e: jwk.e,
      alg: 'RS256',
      ext: true,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    false,
    ['verify']
  )
}

// ----------------------------- main verify --------------------------

/**
 * Verify a GitHub Actions OIDC ID token.
 *
 * @param idToken     Raw JWT (the value after `Authorization: Bearer `).
 * @param expectedAud Audience the calling workflow used (defaults to the
 *                    site origin). Pass `null` to accept any audience —
 *                    NOT recommended in production.
 * @param now         Optional clock injection for tests.
 */
export async function verifyGithubOidc(
  idToken: string,
  expectedAud: string | null = EXPECTED_AUDIENCE,
  now: number = Date.now()
): Promise<OidcVerifyResult> {
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    return { ok: false, status: 401, message: 'Token is not a JWS-Compact JWT' }
  }
  const [encodedHeader, encodedPayload, encodedSig] = parts

  // Decode header + payload.
  let header: { alg?: string; kid?: string; typ?: string }
  let claims: GithubOidcClaims
  try {
    header = JSON.parse(utf8Decode(base64urlDecode(encodedHeader)))
    claims = JSON.parse(utf8Decode(base64urlDecode(encodedPayload)))
  } catch (err) {
    return { ok: false, status: 401, message: 'Token header/payload is not valid JSON' }
  }

  if (header.alg !== 'RS256') {
    return { ok: false, status: 401, message: `Unexpected alg: ${header.alg}` }
  }
  if (!header.kid) {
    return { ok: false, status: 401, message: 'Missing kid in JWT header' }
  }

  // Issuer + audience checks.
  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    return { ok: false, status: 401, message: 'Issuer mismatch' }
  }
  if (expectedAud !== null) {
    const audOk = Array.isArray(claims.aud)
      ? claims.aud.includes(expectedAud)
      : claims.aud === expectedAud
    if (!audOk) {
      return { ok: false, status: 401, message: 'Audience mismatch' }
    }
  }

  // Time window.
  const nowSec = Math.floor(now / 1000)
  if (typeof claims.exp !== 'number' || nowSec > claims.exp + CLOCK_SKEW_SEC) {
    return { ok: false, status: 401, message: 'Token expired' }
  }
  if (typeof claims.nbf === 'number' && nowSec + CLOCK_SKEW_SEC < claims.nbf) {
    return { ok: false, status: 401, message: 'Token not yet valid' }
  }

  // Find the signing key.
  let jwks = await getGithubJwks(false)
  let jwk = findKey(jwks, header.kid)
  if (!jwk) {
    // Cache miss — refresh once before giving up.
    jwks = await getGithubJwks(true)
    jwk = findKey(jwks, header.kid)
  }
  if (!jwk) {
    return {
      ok: false,
      status: 503,
      message: `Signing key '${header.kid}' not in GitHub JWKS`,
    }
  }

  // Verify signature.
  let key: CryptoKey
  try {
    key = await importRsaKey(jwk)
  } catch (err) {
    return {
      ok: false,
      status: 503,
      message: 'Failed to import JWKS public key',
      details: err instanceof Error ? err.message : String(err),
    }
  }

  const signedInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const signature = base64urlDecode(encodedSig)
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signature,
      signedInput
    )
  } catch (err) {
    return {
      ok: false,
      status: 401,
      message: 'Signature verification threw',
      details: err instanceof Error ? err.message : String(err),
    }
  }
  if (!valid) {
    return { ok: false, status: 401, message: 'Signature verification failed' }
  }

  return { ok: true, claims }
}

// ----------------------------- authorization ------------------------

export type OidcAuthzResult =
  | { ok: true; claims: GithubOidcClaims }
  | { ok: false; status: 403; message: string }

/**
 * Given verified claims, decide whether the workflow is authorized to
 * upload embeds. Today: must be from `repository_owner === ALLOWED_OWNER`.
 *
 * Future hardening hooks (commented out for now):
 * - require `event_name === 'push'` or `'workflow_dispatch'` (block PRs from forks)
 * - require `ref === 'refs/heads/master'` or `'refs/heads/main'`
 * - require `job_workflow_ref` to start with `baladithyab/web-embed-workflows/`
 *   (so only OUR reusable workflow gets to upload, not arbitrary workflows
 *   in our repos)
 */
export function authorizeForEmbedUpload(claims: GithubOidcClaims): OidcAuthzResult {
  if (claims.repository_owner !== ALLOWED_OWNER) {
    return {
      ok: false,
      status: 403,
      message: `repository_owner '${claims.repository_owner}' is not authorized`,
    }
  }
  return { ok: true, claims }
}
