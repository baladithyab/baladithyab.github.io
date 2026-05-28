/**
 * Pure helpers for joining GitHub repo lists with the embedded-project
 * content collection.
 *
 * Kept separate from `src/lib/github.ts` and `astro:content` so vitest can
 * exercise the join logic without needing to resolve Astro's virtual
 * modules. The thin glue that calls `getCollection('projects')` lives in
 * `src/pages/profile.astro` itself.
 */

/** Minimal shape of a project content entry needed for the join. */
export interface ProjectEntryLike {
  data: {
    slug: string
    discovery: {
      /** GitHub `<owner>/<name>` of the source repo. */
      source: string
    }
  }
}

/** Minimal shape of a GitHub repo needed for the join. */
export interface RepoLike {
  /** Bare repo name (no owner). */
  name: string
  /** Canonical GitHub URL — used to recover the owner. */
  html_url: string
}

/**
 * Build a map from `<owner>/<name>` (lowercased) to project slug.
 *
 * GitHub URLs are normalised by stripping a trailing slash and `.git`
 * suffix, then lowercasing — `Source` field comparisons stay
 * case-insensitive so a manifest pointing at `BalaDithyaB/UCSC-CSE-160-W21`
 * still joins against the API's `baladithyab/UCSC-CSE-160-W21` URL. The
 * map is the join key; callers do `map.get(repoFullName(repo))`.
 *
 * If two manifests claim the same source repo (shouldn't happen in
 * practice — slug collisions are rejected upstream by
 * `sync-project-manifests.ts`), first one wins. We log to console at
 * call-time, not here, so this stays a pure function.
 */
export function buildEmbedSlugMap(entries: ProjectEntryLike[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of entries) {
    const key = entry.data.discovery.source.toLowerCase()
    if (!map.has(key)) map.set(key, entry.data.slug)
  }
  return map
}

/**
 * Recover `<owner>/<name>` from a GitHub html_url. Returns lowercase to
 * match the map keys built by `buildEmbedSlugMap`.
 *
 * Examples:
 * - `https://github.com/baladithyab/UCSC-CSE-160-W21` → `baladithyab/ucsc-cse-160-w21`
 * - `https://github.com/baladithyab/UCSC-CSE-160-W21/` → same
 * - `https://github.com/Baladithyab/UCSC-CSE-160-W21.git` → same
 * - `https://github.com/baladithyab` (no /repo) → `null`
 */
export function repoFullNameFromUrl(htmlUrl: string): string | null {
  let url: URL
  try {
    url = new URL(htmlUrl)
  } catch {
    return null
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  // Strip leading slash, trailing slash, optional `.git`.
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = path.split('/')
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`.toLowerCase()
}

/**
 * Augment a list of repos with `embedSlug` where one matches the project
 * entry collection. Pure function — same inputs always yield same outputs.
 *
 * Callers stay simple:
 *
 * ```ts
 * const projects = await getCollection('projects')
 * const repos = (summary?.topRepos ?? []).map(r => annotateWithEmbedSlug(r, buildEmbedSlugMap(projects)))
 * ```
 */
export function annotateWithEmbedSlug<R extends RepoLike & { embedSlug?: string }>(
  repo: R,
  slugMap: Map<string, string>,
): R {
  const fullName = repoFullNameFromUrl(repo.html_url)
  if (!fullName) return repo
  const slug = slugMap.get(fullName)
  if (!slug) return repo
  return { ...repo, embedSlug: slug }
}
