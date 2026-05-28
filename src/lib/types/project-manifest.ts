/**
 * Project-embed manifest schema (zod).
 *
 * The single source of truth for what `web.codeseys.json` looks like.
 * Mirrored verbatim in `baladithyab/web-embed-workflows::scripts/validate-manifest.ts`
 * so the personal site and the reusable CI workflow agree byte-for-byte on
 * what's accepted.
 *
 * If you change anything here, change it there too.
 *
 * Schema versions
 * ---------------
 * - `schemaVersion: 1` — single-asset manifest. Top-level `embed` field is
 *   the project's only renderable artifact.
 * - `schemaVersion: 2` — multi-asset manifest. `assets[]` carries N
 *   independently-renderable artifacts (HTML demo + PDF writeup + WASM
 *   harness, etc.); the project page renders a tab strip to switch
 *   between them. Top-level `embed` becomes optional and, when set, is
 *   treated as the default asset (synthesized into `assets[0]` at parse
 *   time).
 *
 * v1 and v2 manifests are both valid; v1 is upgraded internally to a
 * v2-shaped `ProjectEntry` so consumers (UI, discovery, content
 * collection) only have to handle one shape. See `normalizeManifest`.
 *
 * See {@link ../../../docs/PROJECT_EMBEDS.md} for the architecture.
 */

import { z } from 'astro/zod'

/**
 * Embed renderer flavor. The discriminated union maps 1:1 to the
 * `<EmbedRouter>` switch in `src/components/embeds/EmbedRouter.tsx`.
 *
 * Each variant carries the minimum it needs to construct an artifact URL
 * or spawn a runtime — nothing more.
 */
export const EmbedSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('static-html'), entry: z.string() }),
  z.object({
    kind: z.literal('wasm-emscripten'),
    entry: z.string(),
    /** e.g. "256mb" — passed to Emscripten's TOTAL_MEMORY at runtime. */
    memory: z.string().optional(),
  }),
  z.object({ kind: z.literal('wasm-rust'), entry: z.string() }),
  z.object({
    kind: z.literal('pyodide'),
    entry: z.string(),
    packages: z.array(z.string()).default([]),
  }),
  z.object({ kind: z.literal('notebook-html'), notebook: z.string() }),
  z.object({ kind: z.literal('pglite-db'), schema: z.string(), seed: z.string().optional() }),
  z.object({ kind: z.literal('tex-pdf'), pdf: z.string() }),
  z.object({ kind: z.literal('external-app'), url: z.url() }),
])
export type EmbedSpec = z.infer<typeof EmbedSpec>

/**
 * Project category — informs presentation (school + course code chip,
 * hackathon banner, work-org tag, etc.) without constraining the embed
 * kind.
 */
export const Category = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('college'),
    school: z.enum(['UCSC', 'USC']),
    code: z.string(),
    title: z.string(),
    year: z.number().int().min(2014).max(2030),
  }),
  z.object({ kind: z.literal('hackathon'), event: z.string(), year: z.number().int() }),
  z.object({ kind: z.literal('side'), year: z.number().int() }),
  z.object({ kind: z.literal('work'), org: z.string().optional(), year: z.number().int() }),
  z.object({ kind: z.literal('research'), venue: z.string().optional(), year: z.number().int() }),
])
export type Category = z.infer<typeof Category>

/**
 * Delivery mode — decouples *when* the site acquires the artifact (build-
 * time or view-time) from *where* the artifact is served from (same-
 * origin, `assets-r2.codeseys.io`, or external).
 *
 * For multi-asset projects, `delivery.url` is the **shared prefix**
 * under which every asset's `entry` is resolved. CI always uploads the
 * whole bundle to `<slug>/<sha>/`; individual assets use relative paths
 * inside that.
 */
export const Delivery = z.object({
  mode: z.enum(['bundle', 'runtime-r2', 'runtime-foreign']),
  /** Absolute URL where the artifact root lives. Bundle mode rewrites
   *  this to a same-origin path during the personal-site prebuild. */
  url: z.url(),
  /** Git SHA or version tag. Used in R2 paths and for "what version is
   *  rendered?" UI. */
  version: z.string().min(1),
  /** Total bytes of the upload. Drives the badge that warns about
   *  download size on slow connections. */
  sizeBytes: z.number().int().min(0),
})
export type Delivery = z.infer<typeof Delivery>

/**
 * Build metadata. Kept in the manifest so the personal site can link
 * off to the source workflow file when a curious visitor asks "how is
 * this thing actually built?".
 *
 * Optional `script` field: when present, the reusable build workflow
 * runs `./<script>` BEFORE upload. The script's job is to transform
 * source → upload-ready artifacts (e.g. compile WASM, optimize media,
 * convert notebooks to HTML, run TypeScript build).
 *
 * The script runs in the repo root with the standard Actions ubuntu-24
 * runner. Anything in `apt-get install` from a prior step is available;
 * common tools (ffmpeg, jq, python3, node, bun, rustc) are pre-installed.
 *
 * Convention: write the build outputs into `${{ inputs.source-dir }}`
 * (default `.`), since that's what the upload step rsyncs from.
 */
export const Build = z.object({
  ci: z.boolean(),
  workflow: z.string().optional(),
  /** Optional pre-upload transform script, e.g. `scripts/build-embeds.sh`. */
  script: z.string().optional(),
  /** Optional list of apt packages to install before running the script. */
  aptPackages: z.array(z.string()).optional(),
})
export type Build = z.infer<typeof Build>

/* ─────────────────────── Asset shape (v2) ─────────────────────── */

/**
 * A single renderable artifact within a project. Used in v2 manifests'
 * `assets[]`.
 *
 * `id` is what shows up in the URL (`?asset=<id>`) and as the tab key.
 * Must be unique within a project. Shape mirrors a slug: lowercase,
 * hyphens, ≤40 chars. The empty-default-asset case (a project with one
 * artifact and no tabs) uses `id: 'main'` by convention.
 */
export const Asset = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'asset id must be lowercase alphanumeric with hyphens, ≤40 chars'),
  title: z.string().min(1),
  description: z.string().optional(),
  /** Optional category tag for grouping ("Demo", "Writeup", "Source", etc.) */
  group: z.string().optional(),
  embed: EmbedSpec,
  /** Bytes for this individual asset (subset of delivery.sizeBytes). */
  sizeBytes: z.number().int().min(0).optional(),
})
export type Asset = z.infer<typeof Asset>

/* ─────────────────────── Top-level manifest ─────────────────────── */

/**
 * v1 — single-asset manifest. Treated as a v2 manifest with one synthesized
 * asset internally; v1 source files stay valid and don't need migration.
 */
const ProjectManifestV1 = z.object({
  schemaVersion: z.literal(1),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase, hyphen-separated, ≤64 chars'),
  category: Category,
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  thumbnail: z.string().optional(),
  completionLevel: z.enum(['wip', 'works', 'ships']),
  embed: EmbedSpec,
  delivery: Delivery,
  build: Build,
})
type ProjectManifestV1 = z.infer<typeof ProjectManifestV1>

/**
 * Optional overview source pointer. Lets the project page render a
 * narrative section above the embed (or in place of it for projects
 * with no live demo).
 *
 * If absent, the personal site falls back to `README.md` from the
 * source repo. If present, it overrides that default.
 *
 * `skipFirstHeading` drops the leading `# Title` since the page already
 * shows the manifest's title — avoids visual duplication.
 */
const OverviewSource = z.object({
  /** Path within the source repo, e.g. `README.md` or `docs/OVERVIEW.md`. */
  path: z.string().min(1).default('README.md'),
  /** Drop the first H1 if present, since the page already renders the title. */
  skipFirstHeading: z.boolean().default(true),
})

/**
 * v2 — multi-asset manifest. The `assets[]` field carries N
 * independently-rendered artifacts. Top-level `embed` becomes optional;
 * when present, it's the default asset.
 *
 * `defaultAssetId` is optional and falls back to `assets[0].id`.
 *
 * **`assets`, `delivery`, and `build` became optional** in the
 * 2026-05-28 update so a project can have a personal-site page even
 * with no live demo (just an overview + GitHub link). Projects that
 * declare no assets render an "Overview" view with the README as
 * centerpiece and no embed sandbox.
 */
const ProjectManifestV2 = z.object({
  schemaVersion: z.literal(2),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase, hyphen-separated, ≤64 chars'),
  category: Category,
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  thumbnail: z.string().optional(),
  completionLevel: z.enum(['wip', 'works', 'ships']),
  /** Optional. When omitted, the project page renders overview-only. */
  assets: z.array(Asset).optional(),
  /** Which asset is shown when the visitor lands on /projects/<slug>
   *  with no `?asset` query param. Defaults to the first asset's id.
   *  Ignored when assets is empty. */
  defaultAssetId: z.string().optional(),
  /** Optional unless `assets` is non-empty (where do the assets live?). */
  delivery: Delivery.optional(),
  build: Build.optional(),
  /** Where the long-form project narrative lives (defaults to README.md). */
  overview: OverviewSource.optional(),
})
type ProjectManifestV2 = z.infer<typeof ProjectManifestV2>

/**
 * Discriminated union accepting either v1 or v2 manifests. Use
 * `ProjectManifest.safeParse` to validate raw JSON; downstream code
 * should use `normalizeManifest` to collapse both into a single shape.
 */
export const ProjectManifest = z.discriminatedUnion('schemaVersion', [
  ProjectManifestV1,
  ProjectManifestV2,
])
export type ProjectManifest = z.infer<typeof ProjectManifest>

/* ─────────────────────── Normalised v2 entry ─────────────────────── */

/**
 * The shape consumers (UI, content collection) actually work with.
 *
 * Always v2-shaped. v1 manifests are upgraded by `normalizeManifest`.
 *
 * `assets` may be empty — those are overview-only projects (a portfolio
 * page for a project with no playable demo). `delivery` and `build` are
 * present iff `assets` is non-empty.
 *
 * `overview` is always present as a NormalizedOverview — falls back to
 * `{ path: 'README.md', skipFirstHeading: true }` when the manifest
 * doesn't declare one.
 */
const NormalizedOverview = z.object({
  path: z.string(),
  skipFirstHeading: z.boolean(),
})
export type NormalizedOverview = z.infer<typeof NormalizedOverview>

export const NormalizedManifest = z.object({
  slug: z.string(),
  category: Category,
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  thumbnail: z.string().optional(),
  completionLevel: z.enum(['wip', 'works', 'ships']),
  /** May be empty for overview-only projects. */
  assets: z.array(Asset),
  /** Empty string when assets is empty. */
  defaultAssetId: z.string(),
  /** Undefined when assets is empty. */
  delivery: Delivery.optional(),
  /** Undefined when assets is empty. */
  build: Build.optional(),
  /** Always set; defaults to README.md / skipFirstHeading=true. */
  overview: NormalizedOverview,
})
export type NormalizedManifest = z.infer<typeof NormalizedManifest>

/** Default overview source when manifest doesn't specify one. */
export const DEFAULT_OVERVIEW: NormalizedOverview = {
  path: 'README.md',
  skipFirstHeading: true,
}

/**
 * Discovery metadata that the personal site adds to a manifest *after*
 * fetching it — never written by the project repo. Tracks the source
 * repo and last-sync timestamp so the listing page can show
 * "from baladithyab/UCSC-CSE-160-W21 · synced 2 hours ago".
 */
export const DiscoveryMetadata = z.object({
  /** The GitHub repo `<owner>/<name>` the manifest was fetched from. */
  source: z.string(),
  /** ISO timestamp of the last successful fetch. */
  syncedAt: z.iso.datetime(),
  /** Default branch the manifest was fetched from (usually `main`). */
  ref: z.string().default('main'),
})
export type DiscoveryMetadata = z.infer<typeof DiscoveryMetadata>

/**
 * Full content-entry shape: normalised v2 manifest + discovery metadata.
 * What `getCollection('projects')` returns.
 */
export const ProjectEntry = NormalizedManifest.extend({
  discovery: DiscoveryMetadata,
})
export type ProjectEntry = z.infer<typeof ProjectEntry>

/* ─────────────────────── Normaliser ─────────────────────── */

/**
 * Upgrade a v1 manifest to the v2-shaped `NormalizedManifest`. v2
 * manifests pass through with `defaultAssetId` resolved and `overview`
 * defaulted.
 *
 * v1 → v2 strategy: synthesize a single asset with id `'main'` from
 * the top-level `embed`. The asset takes its `title` from a heuristic:
 * for `static-html`/`tex-pdf`/etc., we use the project's title; the
 * embed kind is preserved verbatim.
 *
 * For overview-only v2 manifests (no `assets`), the result has empty
 * `assets`, empty `defaultAssetId`, and undefined `delivery` / `build`.
 *
 * This is a pure function; safe to call from the discovery script and
 * from any astro/vite consumer.
 */
export function normalizeManifest(m: ProjectManifest): NormalizedManifest {
  if (m.schemaVersion === 1) {
    const asset: Asset = {
      id: 'main',
      title: m.title,
      embed: m.embed,
      sizeBytes: m.delivery.sizeBytes,
    }
    return {
      slug: m.slug,
      category: m.category,
      title: m.title,
      description: m.description,
      tags: m.tags,
      thumbnail: m.thumbnail,
      completionLevel: m.completionLevel,
      assets: [asset],
      defaultAssetId: 'main',
      delivery: m.delivery,
      build: m.build,
      overview: DEFAULT_OVERVIEW,
    }
  }
  // v2: normalize.
  const assets = m.assets ?? []
  const defaultAssetId =
    assets.length === 0
      ? ''
      : (() => {
          const ids = new Set(assets.map((a) => a.id))
          const fallback = assets[0]!.id
          return m.defaultAssetId && ids.has(m.defaultAssetId) ? m.defaultAssetId : fallback
        })()
  const overview: NormalizedOverview = m.overview
    ? {
        path: m.overview.path,
        skipFirstHeading: m.overview.skipFirstHeading,
      }
    : DEFAULT_OVERVIEW
  return {
    slug: m.slug,
    category: m.category,
    title: m.title,
    description: m.description,
    tags: m.tags,
    thumbnail: m.thumbnail,
    completionLevel: m.completionLevel,
    assets,
    defaultAssetId,
    delivery: m.delivery,
    build: m.build,
    overview,
  }
}
