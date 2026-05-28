/**
 * Unit tests for the GitHub Actions OIDC verifier.
 *
 * Approach: generate an RSA keypair locally, sign a synthesized JWT with
 * GitHub-shaped claims, monkey-patch `getGithubJwks` (via a stubbed module)
 * to return our public key under the kid we used for signing, and run
 * verify. Covers happy path + every rejection branch.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  ALLOWED_OWNER,
  EXPECTED_AUDIENCE,
  authorizeForEmbedUpload,
  verifyGithubOidc,
  type GithubOidcClaims,
} from './github-oidc'

// ----------------------------- helpers ----------------------------------

const TEST_KID = 'test-kid-1'

let testKeyPair: CryptoKeyPair
let testJwk: { kid: string; kty: string; n: string; e: string; alg: string }

async function makeTestKeys(): Promise<void> {
  testKeyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )
  const jwk = await crypto.subtle.exportKey('jwk', testKeyPair.publicKey)
  testJwk = {
    kid: TEST_KID,
    kty: jwk.kty as string,
    n: jwk.n as string,
    e: jwk.e as string,
    alg: 'RS256',
  }
}

function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlEncodeJson(obj: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(obj)))
}

async function signTestJwt(
  payload: object,
  opts: { alg?: string; kid?: string; corruptSig?: boolean } = {}
): Promise<string> {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? TEST_KID }
  const encodedHeader = base64urlEncodeJson(header)
  const encodedPayload = base64urlEncodeJson(payload)
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)

  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    testKeyPair.privateKey,
    signingInput
  )
  const sigBytes = opts.corruptSig
    ? (() => {
        const u = new Uint8Array(sig)
        u[0] ^= 0xff
        return u.buffer
      })()
    : sig
  const encodedSig = base64urlEncode(sigBytes)
  return `${encodedHeader}.${encodedPayload}.${encodedSig}`
}

function makeClaims(overrides: Partial<GithubOidcClaims> = {}): GithubOidcClaims {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://token.actions.githubusercontent.com',
    aud: EXPECTED_AUDIENCE,
    sub: 'repo:baladithyab/UCSC-CSE-101-W20:ref:refs/heads/master',
    iat: nowSec,
    nbf: nowSec,
    exp: nowSec + 600,
    repository: 'baladithyab/UCSC-CSE-101-W20',
    repository_owner: ALLOWED_OWNER,
    repository_id: '236258028',
    repository_owner_id: '15759113',
    workflow: 'build web embed',
    workflow_ref: 'baladithyab/UCSC-CSE-101-W20/.github/workflows/build-web-asset.yml@refs/heads/master',
    job_workflow_ref: 'baladithyab/web-embed-workflows/.github/workflows/static-passthrough.yml@refs/heads/main',
    ref: 'refs/heads/master',
    ref_type: 'branch',
    sha: '7321682d39ab2bda7af0bd1bb1bc0db8a02a73eb',
    actor: 'baladithyab',
    actor_id: '15759113',
    event_name: 'push',
    run_id: '999999999',
    run_number: '1',
    run_attempt: '1',
    ...overrides,
  }
}

// Fake the global `fetch` for the JWKS endpoint.
let originalFetch: typeof globalThis.fetch
beforeEach(async () => {
  if (!testKeyPair) await makeTestKeys()
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://token.actions.githubusercontent.com/.well-known/jwks')) {
      return new Response(JSON.stringify({ keys: [testJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not mocked', { status: 404 })
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  // Reset module-level JWKS cache between tests by re-importing — but since
  // verifyGithubOidc swallows and re-fetches on cache miss, force-refresh
  // is exercised inside specific tests.
})

// ----------------------------- tests ------------------------------------

describe('verifyGithubOidc', () => {
  it('accepts a well-formed token from our owner', async () => {
    const jwt = await signTestJwt(makeClaims())
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.claims.repository_owner).toBe(ALLOWED_OWNER)
      expect(r.claims.repository).toBe('baladithyab/UCSC-CSE-101-W20')
    }
  })

  it('rejects a malformed (non-JWS-Compact) token', async () => {
    const r = await verifyGithubOidc('not.a.token.at.all')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('rejects a token with two segments', async () => {
    const r = await verifyGithubOidc('only.two')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/JWS-Compact/)
  })

  it('rejects a token whose alg is not RS256', async () => {
    const jwt = await signTestJwt(makeClaims(), { alg: 'HS256' })
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/alg/i)
  })

  it('rejects a token without kid in header', async () => {
    // Manually craft a header without kid.
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = makeClaims()
    const eh = base64urlEncodeJson(header)
    const ep = base64urlEncodeJson(payload)
    const sig = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      testKeyPair.privateKey,
      new TextEncoder().encode(`${eh}.${ep}`)
    )
    const r = await verifyGithubOidc(`${eh}.${ep}.${base64urlEncode(sig)}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/kid/i)
  })

  it('rejects a token from a wrong issuer', async () => {
    const jwt = await signTestJwt(makeClaims({ iss: 'https://evil.example.com' }))
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/Issuer/i)
  })

  it('rejects a token whose audience does not match', async () => {
    const jwt = await signTestJwt(makeClaims({ aud: 'https://other-site.example' }))
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/Audience/i)
  })

  it('accepts when audience is in an array', async () => {
    const jwt = await signTestJwt(
      makeClaims({ aud: ['https://other.example', EXPECTED_AUDIENCE] })
    )
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(true)
  })

  it('accepts any audience when expectedAud is null', async () => {
    const jwt = await signTestJwt(makeClaims({ aud: 'https://random.example' }))
    const r = await verifyGithubOidc(jwt, null)
    expect(r.ok).toBe(true)
  })

  it('rejects an expired token', async () => {
    const oldNow = Math.floor(Date.now() / 1000) - 7200
    const jwt = await signTestJwt(
      makeClaims({ iat: oldNow, nbf: oldNow, exp: oldNow + 600 })
    )
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/expired/i)
  })

  it('rejects a token before its nbf', async () => {
    const futureNow = Math.floor(Date.now() / 1000) + 7200
    const jwt = await signTestJwt(
      makeClaims({ iat: futureNow, nbf: futureNow, exp: futureNow + 600 })
    )
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/not yet valid/i)
  })

  it('rejects a token with a corrupted signature', async () => {
    const jwt = await signTestJwt(makeClaims(), { corruptSig: true })
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/Signature/i)
  })

  it('rejects a token whose kid is not in JWKS even after refresh', async () => {
    const jwt = await signTestJwt(makeClaims(), { kid: 'unknown-kid' })
    const r = await verifyGithubOidc(jwt)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(503)
      expect(r.message).toMatch(/not in GitHub JWKS/i)
    }
  })
})

describe('authorizeForEmbedUpload', () => {
  it('accepts our owner with the right job_workflow_ref', () => {
    const r = authorizeForEmbedUpload(makeClaims())
    expect(r.ok).toBe(true)
  })

  it('rejects another owner', () => {
    const r = authorizeForEmbedUpload(makeClaims({ repository_owner: 'someone-else' }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.message).toMatch(/repository_owner/)
    }
  })

  it('rejects a missing owner', () => {
    const claims = makeClaims()
    delete claims.repository_owner
    const r = authorizeForEmbedUpload(claims)
    expect(r.ok).toBe(false)
  })

  it('rejects when job_workflow_ref is missing', () => {
    const claims = makeClaims()
    delete claims.job_workflow_ref
    const r = authorizeForEmbedUpload(claims)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.message).toMatch(/job_workflow_ref/)
    }
  })

  it('rejects when job_workflow_ref points to a different reusable workflow', () => {
    const r = authorizeForEmbedUpload(
      makeClaims({
        job_workflow_ref: 'baladithyab/some-other-repo/.github/workflows/evil.yml@refs/heads/main',
      })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.message).toMatch(/not from the allowed reusable workflow/)
    }
  })

  it('rejects when job_workflow_ref names a different workflow file in our repo', () => {
    const r = authorizeForEmbedUpload(
      makeClaims({
        job_workflow_ref:
          'baladithyab/web-embed-workflows/.github/workflows/some-other.yml@refs/heads/main',
      })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/not from the allowed reusable workflow/)
  })

  it('accepts when job_workflow_ref pins to a SHA instead of a branch', () => {
    const r = authorizeForEmbedUpload(
      makeClaims({
        job_workflow_ref:
          'baladithyab/web-embed-workflows/.github/workflows/static-passthrough.yml@deadbeefcafebabe1234567890abcdef',
      })
    )
    expect(r.ok).toBe(true)
  })

  it('accepts when job_workflow_ref pins to a tag', () => {
    const r = authorizeForEmbedUpload(
      makeClaims({
        job_workflow_ref:
          'baladithyab/web-embed-workflows/.github/workflows/static-passthrough.yml@refs/tags/v1.0.0',
      })
    )
    expect(r.ok).toBe(true)
  })

  it('rejects a forged job_workflow_ref that starts with our prefix as a substring', () => {
    // Defense against e.g. 'evil-baladithyab/web-embed-workflows/...'.
    // startsWith() catches this — but document it.
    const r = authorizeForEmbedUpload(
      makeClaims({
        job_workflow_ref:
          'evil-prefix-baladithyab/web-embed-workflows/.github/workflows/static-passthrough.yml@refs/heads/main',
      })
    )
    expect(r.ok).toBe(false)
  })
})
