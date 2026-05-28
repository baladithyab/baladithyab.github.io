#!/usr/bin/env bun
/**
 * sync-project-manifests.ts — pull every `web.codeseys.json` from public
 * repos tagged `codeseys-embed`, validate, and write the result into the
 * `projects` content collection.
 *
 * Runs as a personal-site prebuild step. CI gets a token from
 * `GITHUB_TOKEN`; local dev falls back to `gh auth token`. Anonymous fetch
 * works too but eats a 60 req/h rate limit fast.
 *
 * Failure modes:
 * - GitHub search down → exits non-zero, build fails, easy to spot.
 * - One manifest fails validation → that project is logged + skipped, build
 *   continues. This is intentional — one project's typo never breaks the
 *   site.
 * - Slug collisions across repos → first writer wins, subsequent ones are
 *   logged + skipped.
 *
 * See {@link ../../docs/PROJECT_EMBEDS.md} for the architecture.
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ProjectManifest, normalizeManifest } from '../lib/types/project-manifest.ts'

const TOPIC = 'codeseys-embed'
/**
 * GitHub user/org whose repos are eligible to appear in the personal
 * site. Without this scope, anyone in the world adding the
 * `codeseys-embed` topic would surface on /projects.
 *
 * Defense in depth: even if a stranger sets the topic, manifest
 * validation + the OIDC upload path together mean the worst case is a
 * `pending/` placeholder card with a manifest from someone else; no
 * artifact upload would actually succeed.
 */
const ALLOWED_OWNER = 'baladithyab'
const OUT_DIR = resolve(process.cwd(), 'src/content/projects')
const MANIFEST_FILE = 'web.codeseys.json'

/* ────────────────────────────── auth ────────────────────────────── */

async function resolveToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  // Fall back to `gh auth token` for local dev.
  try {
    const proc = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'inherit' })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code === 0 && out.trim()) return out.trim()
  } catch {
    /* gh not installed; fall through to anonymous */
  }
  return undefined
}

/* ────────────────────────── github search ─────────────────────────── */

interface SearchRepo {
  full_name: string
  default_branch: string
  visibility: 'public' | 'private'
  archived: boolean
}

async function listEmbedRepos(token: string | undefined): Promise<SearchRepo[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'codeseys-io-embed-discovery',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  // Paginate just in case there are >100 — yes, it's portfolio scale, but
  // assuming "I'll never have >100" tends to age badly.
  const repos: SearchRepo[] = []
  let page = 1
  /* eslint-disable no-constant-condition */
  while (true) {
    const url = new URL('https://api.github.com/search/repositories')
    url.searchParams.set('q', `topic:${TOPIC} user:${ALLOWED_OWNER}`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))

    const res = await fetch(url, { headers })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GitHub search failed: ${res.status} ${res.statusText}\n${body.slice(0, 500)}`)
    }
    const data = (await res.json()) as { total_count: number; items: SearchRepo[] }
    repos.push(...data.items)
    if (data.items.length < 100) break
    if (page >= 5) break // Hard ceiling: 500 repos. Bump if life ever gets that good.
    page += 1
  }
  return repos.filter(r => !r.archived)
}

/* ────────────────────── manifest fetch + validation ────────────────────── */

interface FetchedManifest {
  source: string
  ref: string
  raw: string
}

async function fetchManifest(repo: SearchRepo, token: string | undefined): Promise<FetchedManifest | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'codeseys-io-embed-discovery',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  // Use the contents API (not raw.githubusercontent.com) so we get a 404 if
  // the file's missing instead of accidentally hitting a private repo's
  // 404-as-html page. Also works on private repos when the token has access.
  const url = `https://api.github.com/repos/${repo.full_name}/contents/${MANIFEST_FILE}?ref=${repo.default_branch}`
  const res = await fetch(url, { headers })
  if (res.status === 404) {
    console.warn(`  · ${repo.full_name}: no ${MANIFEST_FILE} on ${repo.default_branch} — skipped`)
    return null
  }
  if (!res.ok) {
    console.warn(`  · ${repo.full_name}: HTTP ${res.status} fetching manifest — skipped`)
    return null
  }
  const raw = await res.text()
  return { source: repo.full_name, ref: repo.default_branch, raw }
}

interface ValidEntry {
  source: string
  ref: string
  manifest: ReturnType<typeof ProjectManifest.parse>
}

function validate(entry: FetchedManifest): ValidEntry | null {
  // Defense in depth: even if the search query somehow returns a repo
  // outside ALLOWED_OWNER, refuse to write its manifest. `entry.source`
  // is the canonical `<owner>/<name>` from the search result.
  const slashIdx = entry.source.indexOf('/')
  if (slashIdx === -1) {
    console.warn(`  · ${entry.source}: malformed source (no slash); rejected`)
    return null
  }
  const owner = entry.source.slice(0, slashIdx)
  if (owner !== ALLOWED_OWNER) {
    console.warn(
      `  · ${entry.source}: owner '${owner}' is not the allowed owner '${ALLOWED_OWNER}'; rejected`
    )
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(entry.raw)
  } catch (err) {
    console.warn(`  · ${entry.source}: invalid JSON in ${MANIFEST_FILE} — ${(err as Error).message}`)
    return null
  }
  const result = ProjectManifest.safeParse(parsed)
  if (!result.success) {
    console.warn(`  · ${entry.source}: schema validation failed:`)
    for (const issue of result.error.issues) {
      console.warn(`      ${issue.path.join('.') || '<root>'}: ${issue.message}`)
    }
    return null
  }
  return { source: entry.source, ref: entry.ref, manifest: result.data }
}

/* ────────────────────────── write content entries ─────────────────────── */

async function clearExisting(): Promise<void> {
  if (!existsSync(OUT_DIR)) return
  for (const file of await readdir(OUT_DIR)) {
    if (file.endsWith('.json')) await rm(join(OUT_DIR, file))
  }
}

async function writeEntry(entry: ValidEntry): Promise<void> {
  // Normalise v1 → v2 shape before writing so the content collection only
  // ever holds v2-shaped entries. UI code never has to branch on
  // schemaVersion.
  const normalized = normalizeManifest(entry.manifest)
  const out = {
    ...normalized,
    discovery: {
      source: entry.source,
      ref: entry.ref,
      syncedAt: new Date().toISOString(),
    },
  }
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, `${normalized.slug}.json`), JSON.stringify(out, null, 2) + '\n')
}

/* ────────────────────────────── main ─────────────────────────────── */

async function main(): Promise<void> {
  console.log(`[sync-project-manifests] discovering repos tagged \`${TOPIC}\``)
  const token = await resolveToken()
  if (!token) {
    console.warn('[sync-project-manifests] no GITHUB_TOKEN / GH_TOKEN / gh-cli token — using anonymous (rate-limited) requests')
  }

  const repos = await listEmbedRepos(token)
  console.log(`[sync-project-manifests] found ${repos.length} candidate repo(s)`)

  await clearExisting()

  const seenSlugs = new Set<string>()
  let written = 0
  for (const repo of repos) {
    const fetched = await fetchManifest(repo, token)
    if (!fetched) continue
    const valid = validate(fetched)
    if (!valid) continue
    if (seenSlugs.has(valid.manifest.slug)) {
      console.warn(`  · ${valid.source}: slug "${valid.manifest.slug}" already taken — skipped`)
      continue
    }
    seenSlugs.add(valid.manifest.slug)
    await writeEntry(valid)
    console.log(`  · ${valid.source}: wrote src/content/projects/${valid.manifest.slug}.json`)
    written += 1
  }

  console.log(`[sync-project-manifests] wrote ${written} of ${repos.length} project manifest(s)`)
}

// Allow `bun run scripts/sync-project-manifests.ts` AND `import { main }` from
// tests without auto-execution.
if (import.meta.main) {
  await main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

export { main }
