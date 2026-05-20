/**
 * OIDC Auth Skeleton (Auth0 / Keycloak)
 *
 * Goals:
 * - External IdP (Auth0/Keycloak) is the source of truth.
 * - No database. Session is a signed cookie containing minimal user/session info.
 * - Cloudflare Workers compatible (fetch + WebCrypto).
 * - Entire feature is inert unless configuration env vars are present.
 */

export interface AuthEnv {
  // Generic OIDC
  OIDC_ISSUER?: string
  OIDC_CLIENT_ID?: string
  OIDC_CLIENT_SECRET?: string
  OIDC_REDIRECT_URI?: string
  OIDC_LOGOUT_REDIRECT_URI?: string

  // Session signing secret (separate from OIDC client secret)
  AUTH_SESSION_SECRET?: string

  // Auth0 compatibility
  AUTH0_DOMAIN?: string
  AUTH0_CLIENT_ID?: string
  AUTH0_CLIENT_SECRET?: string
  AUTH0_REDIRECT_URI?: string

  // Keycloak compatibility
  KEYCLOAK_ISSUER?: string
  KEYCLOAK_CLIENT_ID?: string
  KEYCLOAK_CLIENT_SECRET?: string
  KEYCLOAK_REDIRECT_URI?: string
}

export type AuthUser = {
  id: string
  name?: string
  email?: string
  image?: string
}

export type AuthSession = {
  id: string
  userId: string
  expiresAt: Date
}

type OidcConfig = {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  logoutRedirectUri?: string
  sessionSecret: string
}

type OidcDiscovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint?: string
}

type JwtHeader = { alg: string; kid?: string; typ?: string }
type JwtClaims = Record<string, any> & {
  iss?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  sub?: string
  email?: string
  name?: string
  preferred_username?: string
  picture?: string
}

const SESSION_COOKIE = 'codeseys_session'
const OIDC_STATE_COOKIE = 'codeseys_oidc_state'
const OIDC_VERIFIER_COOKIE = 'codeseys_oidc_verifier'

export function isAuthConfigured(runtimeEnv?: AuthEnv) {
  return Boolean(getOidcConfig(runtimeEnv))
}

export function getOidcConfig(runtimeEnv?: AuthEnv): OidcConfig | null {
  if (!runtimeEnv) return null

  const sessionSecret = runtimeEnv.AUTH_SESSION_SECRET
  if (!sessionSecret) return null

  const issuer =
    runtimeEnv.OIDC_ISSUER ||
    runtimeEnv.KEYCLOAK_ISSUER ||
    (runtimeEnv.AUTH0_DOMAIN ? `https://${runtimeEnv.AUTH0_DOMAIN.replace(/^https?:\/\//, '')}/` : undefined)

  const clientId = runtimeEnv.OIDC_CLIENT_ID || runtimeEnv.KEYCLOAK_CLIENT_ID || runtimeEnv.AUTH0_CLIENT_ID
  const clientSecret =
    runtimeEnv.OIDC_CLIENT_SECRET || runtimeEnv.KEYCLOAK_CLIENT_SECRET || runtimeEnv.AUTH0_CLIENT_SECRET
  const redirectUri = runtimeEnv.OIDC_REDIRECT_URI || runtimeEnv.KEYCLOAK_REDIRECT_URI || runtimeEnv.AUTH0_REDIRECT_URI
  const logoutRedirectUri = runtimeEnv.OIDC_LOGOUT_REDIRECT_URI

  if (!issuer || !clientId || !clientSecret || !redirectUri) return null

  return {
    issuer: ensureTrailingSlash(issuer),
    clientId,
    clientSecret,
    redirectUri,
    logoutRedirectUri,
    sessionSecret,
  }
}

export async function getDiscovery(config: OidcConfig): Promise<OidcDiscovery> {
  const cacheKey = new Request(`${config.issuer}.well-known/openid-configuration`)
  if (typeof caches !== 'undefined' && 'default' in caches) {
    const cache = (caches as any).default
    const cached = await cache.match(cacheKey)
    if (cached) return cached.json()
  }

  const res = await fetch(cacheKey.url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const discovery = (await res.json()) as OidcDiscovery

  if (typeof caches !== 'undefined' && 'default' in caches) {
    const cache = (caches as any).default
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(discovery), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      })
    )
  }

  return discovery
}

export async function buildLoginRedirect(request: Request, config: OidcConfig) {
  const discovery = await getDiscovery(config)
  const url = new URL(discovery.authorization_endpoint)

  const state = randomBase64Url(32)
  const verifier = randomBase64Url(64)
  const challenge = await pkceChallengeS256(verifier)

  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri || deriveCallbackUrl(request))
  url.searchParams.set('scope', 'openid profile email')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  const headers = new Headers()
  headers.append('Set-Cookie', serializeCookie(OIDC_STATE_COOKIE, state, cookieOpts(request, 10 * 60)))
  headers.append('Set-Cookie', serializeCookie(OIDC_VERIFIER_COOKIE, verifier, cookieOpts(request, 10 * 60)))
  headers.set('Location', url.toString())

  return new Response(null, { status: 302, headers })
}

export async function handleCallback(request: Request, config: OidcConfig) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code || !state) return jsonError(400, 'Missing code/state')

  const cookies = parseCookies(request.headers.get('Cookie') || '')
  const expectedState = cookies[OIDC_STATE_COOKIE]
  const verifier = cookies[OIDC_VERIFIER_COOKIE]
  if (!expectedState || !verifier || expectedState !== state) return jsonError(400, 'Invalid state')

  const discovery = await getDiscovery(config)

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri || deriveCallbackUrl(request),
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    }).toString(),
  })

  if (!tokenRes.ok) return jsonError(502, `Token exchange failed: ${tokenRes.status}`)
  const tokenJson = (await tokenRes.json()) as { id_token?: string; access_token?: string; expires_in?: number }
  if (!tokenJson.id_token) return jsonError(502, 'Missing id_token')

  const claims = await verifyIdToken(tokenJson.id_token, config, discovery)
  const user = claimsToUser(claims)
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 60 * 60 * 1000

  const session: { user: AuthUser; session: { id: string; userId: string; expiresAt: number } } = {
    user,
    session: {
      id: randomBase64Url(18),
      userId: user.id,
      expiresAt: exp,
    },
  }

  const signed = await signSession(session, config.sessionSecret)

  const headers = new Headers()
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, signed, cookieOpts(request, 30 * 24 * 60 * 60)))
  headers.append('Set-Cookie', serializeCookie(OIDC_STATE_COOKIE, '', cookieOpts(request, 0)))
  headers.append('Set-Cookie', serializeCookie(OIDC_VERIFIER_COOKIE, '', cookieOpts(request, 0)))
  headers.set('Location', '/profile')

  return new Response(null, { status: 302, headers })
}

export async function handleLogout(request: Request, config: OidcConfig) {
  const headers = new Headers()
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', cookieOpts(request, 0)))

  try {
    const discovery = await getDiscovery(config)
    if (discovery.end_session_endpoint && config.logoutRedirectUri) {
      const u = new URL(discovery.end_session_endpoint)
      u.searchParams.set('post_logout_redirect_uri', config.logoutRedirectUri)
      headers.set('Location', u.toString())
      return new Response(null, { status: 302, headers })
    }
  } catch {
    // ignore; local logout is still fine
  }

  headers.set('Location', '/')
  return new Response(null, { status: 302, headers })
}

export async function getSessionFromRequest(request: Request, config: OidcConfig) {
  const cookies = parseCookies(request.headers.get('Cookie') || '')
  const token = cookies[SESSION_COOKIE]
  if (!token) return null

  const parsed = await verifySession(token, config.sessionSecret)
  if (!parsed) return null

  if (Date.now() >= parsed.session.expiresAt) return null

  const session: AuthSession = {
    id: parsed.session.id,
    userId: parsed.session.userId,
    expiresAt: new Date(parsed.session.expiresAt),
  }
  return { user: parsed.user, session }
}

function claimsToUser(claims: JwtClaims): AuthUser {
  return {
    id: String(claims.sub || ''),
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name:
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : undefined,
    image: typeof claims.picture === 'string' ? claims.picture : undefined,
  }
}

async function verifyIdToken(idToken: string, config: OidcConfig, discovery: OidcDiscovery): Promise<JwtClaims> {
  const { header, payload, signingInput, signature } = decodeJwt(idToken)

  if (header.alg !== 'RS256') {
    // Keep this strict until you need other algorithms.
    throw new Error(`Unsupported JWT alg: ${header.alg}`)
  }

  const jwks = await fetchJwks(discovery.jwks_uri)
  const jwk = selectJwk(jwks, header.kid)
  if (!jwk) throw new Error('No matching JWK')

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as any,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )

  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature,
    new TextEncoder().encode(signingInput)
  )
  if (!ok) throw new Error('Invalid JWT signature')

  // Basic claim checks
  if (payload.iss && ensureTrailingSlash(payload.iss) !== ensureTrailingSlash(config.issuer)) {
    throw new Error('Invalid iss')
  }
  if (!audContains(payload.aud, config.clientId)) {
    throw new Error('Invalid aud')
  }
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.nbf === 'number' && now < payload.nbf) throw new Error('Token not active')
  if (typeof payload.exp === 'number' && now >= payload.exp) throw new Error('Token expired')
  if (!payload.sub) throw new Error('Missing sub')

  return payload
}

async function fetchJwks(jwksUri: string): Promise<{ keys: any[] }> {
  const cacheKey = new Request(jwksUri)
  if (typeof caches !== 'undefined' && 'default' in caches) {
    const cache = (caches as any).default
    const cached = await cache.match(cacheKey)
    if (cached) return cached.json()
  }

  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const jwks = (await res.json()) as { keys: any[] }

  if (typeof caches !== 'undefined' && 'default' in caches) {
    const cache = (caches as any).default
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(jwks), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      })
    )
  }

  return jwks
}

function selectJwk(jwks: { keys: any[] }, kid?: string) {
  if (!jwks?.keys?.length) return null
  if (!kid) return jwks.keys[0]
  return jwks.keys.find((k) => k.kid === kid) || null
}

function decodeJwt(jwt: string): {
  header: JwtHeader
  payload: JwtClaims
  signingInput: string
  signature: ArrayBuffer
} {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  const [h, p, s] = parts
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h))) as JwtHeader
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p))) as JwtClaims
  const signature = base64UrlDecodeToArrayBuffer(s)
  return { header, payload, signingInput: `${h}.${p}`, signature }
}

function audContains(aud: unknown, clientId: string) {
  if (typeof aud === 'string') return aud === clientId
  if (Array.isArray(aud)) return aud.includes(clientId)
  return false
}

async function pkceChallengeS256(verifier: string) {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}

async function signSession(payload: unknown, secret: string) {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await hmacSha256(body, secret)
  return `${body}.${sig}`
}

async function verifySession(token: string, secret: string) {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = await hmacSha256(body, secret)
  if (!timingSafeEqual(sig, expected)) return null
  const json = new TextDecoder().decode(base64UrlDecode(body))
  return JSON.parse(json) as any
}

async function hmacSha256(input: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))
  return base64UrlEncode(new Uint8Array(sig))
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

function cookieOpts(request: Request, maxAgeSeconds: number) {
  const isHttps = new URL(request.url).protocol === 'https:'
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

function serializeCookie(name: string, value: string, opts: { httpOnly: boolean; secure: boolean; sameSite: 'Lax'; path: string; maxAge: number }) {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${opts.path}`)
  parts.push(`Max-Age=${opts.maxAge}`)
  parts.push(`SameSite=${opts.sameSite}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

function parseCookies(cookieHeader: string) {
  const out: Record<string, string> = {}
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  }
  return out
}

function randomBase64Url(bytes: number) {
  const u8 = new Uint8Array(bytes)
  crypto.getRandomValues(u8)
  return base64UrlEncode(u8)
}

function base64UrlEncode(u8: Uint8Array) {
  // Prefer Buffer in Node (astro dev/build) and fall back to btoa in Workers.
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(u8).toString('base64')
      : btoa(String.fromCharCode(...u8))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(input: string) {
  const pad = '='.repeat((4 - (input.length % 4)) % 4)
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

function base64UrlDecodeToArrayBuffer(input: string) {
  return base64UrlDecode(input).buffer
}

function ensureTrailingSlash(s: string) {
  return s.endsWith('/') ? s : `${s}/`
}

function deriveCallbackUrl(request: Request) {
  const u = new URL(request.url)
  return `${u.origin}/api/auth/callback`
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
