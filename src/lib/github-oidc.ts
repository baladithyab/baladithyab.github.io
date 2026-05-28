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
  // Wrap into a fresh ArrayBuffer to satisfy strict BufferSource typing
  // (Uint8Array<ArrayBufferLike> may be backed by SharedArrayBuffer per
  // recent lib.dom.d.ts; crypto.subtle.verify wants ArrayBuffer-backed).
  const sigBuf = signature.slice().buffer
  const inputBuf = signedInput.slice().buffer
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      sigBuf,
      inputBuf
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
 * Workflow pin: only OIDC tokens minted by this exact reusable workflow
 * are allowed to upload. Format matches the `job_workflow_ref` JWT claim:
 *
 *   <owner>/<repo>/.github/workflows/<file>@<ref>
 *
 * GitHub stamps `job_workflow_ref` with whatever ref the reusable
 * workflow was called from — branch (`refs/heads/main`), tag, or SHA.
 * We pin the prefix (everything before the `@`) so any ref of the
 * audited reusable workflow passes, but no other workflow does.
 *
 * Why this matters: without this pin, any caller workflow under
 * `repository_owner === ALLOWED_OWNER` with `id-token: write` could mint
 * a valid OIDC token and upload to any slug. With the pin, only our
 * reviewed reusable workflow can — even if some unrelated workflow in
 * one of our repos later sets `id-token: write` for some other purpose.
 */
export const ALLOWED_JOB_WORKFLOW_REF_PREFIX =
  'baladithyab/web-embed-workflows/.github/workflows/static-passthrough.yml@'

/**
 * Given verified claims, decide whether the workflow is authorized to
 * upload embeds. Layered checks:
 *   1. `repository_owner` must be ALLOWED_OWNER (we're the only ones
 *      whose workflows can upload).
 *   2. `job_workflow_ref` must start with the pinned prefix (only OUR
 *      reusable workflow can upload, not arbitrary workflows in our
 *      repos).
 *
 * Future hardening hooks (commented out for now):
 * - require `event_name === 'push'` or `'workflow_dispatch'` (block PRs
 *   from forks; today this is also covered by GitHub's own OIDC
 *   suppression on fork PRs)
 * - pin `job_workflow_ref` to a specific tag rather than the branch
 *   (e.g. `@refs/tags/v1.2.3`) once the reusable workflow has stable
 *   versioning
 */
export function authorizeForEmbedUpload(claims: GithubOidcClaims): OidcAuthzResult {
  if (claims.repository_owner !== ALLOWED_OWNER) {
    return {
      ok: false,
      status: 403,
      message: `repository_owner '${claims.repository_owner}' is not authorized`,
    }
  }
  // job_workflow_ref pin: must be from our audited reusable workflow.
  // GitHub spec says this claim is set whenever a reusable workflow is
  // called. If it's somehow missing, fail closed.
  const jwfr = claims.job_workflow_ref
  if (!jwfr) {
    return {
      ok: false,
      status: 403,
      message: 'OIDC token has no job_workflow_ref claim',
    }
  }
  if (!jwfr.startsWith(ALLOWED_JOB_WORKFLOW_REF_PREFIX)) {
    return {
      ok: false,
      status: 403,
      message: `job_workflow_ref '${jwfr}' is not from the allowed reusable workflow`,
    }
  }
  return { ok: true, claims }
}
