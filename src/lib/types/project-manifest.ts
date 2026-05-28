/**
 * Project-embed manifest schema (zod).
 *
 * The single source of truth for what `web.codeseys.json` looks like. Mirrored
 * verbatim from the validator in baladithyab/web-embed-workflows so the
 * personal site and the reusable CI workflow agree byte-for-byte on what's
 * accepted.
 *
 * If you change anything here, change it there too.
 *
 * See {@link ../../../docs/PROJECT_EMBEDS.md} for the architecture.
 */

import { z } from 'astro/zod'

/**
 * Embed renderer flavor. The discriminated union maps 1:1 to the
 * `<EmbedRouter>` switch in `src/components/embeds/EmbedRouter.tsx`.
 *
 * Each variant carries the minimum it needs to construct an artifact URL or
 * spawn a runtime — nothing more.
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
 * hackathon banner, work-org tag, etc.) without constraining the embed kind.
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
 * Delivery mode — decouples *when* the site acquires the artifact (build-time
 * or view-time) from *where* the artifact is served from (same-origin,
 * `assets-r2.codeseys.io`, or external).
 *
 * Renderers don't care which mode is in play; they take a URL prop. The
 * discovery step handles the build-time-vs-runtime distinction.
 */
export const Delivery = z.object({
  mode: z.enum(['bundle', 'runtime-r2', 'runtime-foreign']),
  /** Absolute URL where the artifact lives. Bundle mode rewrites this to a
   *  same-origin path during the personal-site prebuild. */
  url: z.url(),
  /** Git SHA or version tag. Used in R2 paths and for "what version is
   *  rendered?" UI. */
  version: z.string().min(1),
  /** Reported by the project's CI. Drives the badge that warns about
   *  download size on slow connections. */
  sizeBytes: z.number().int().min(0),
})
export type Delivery = z.infer<typeof Delivery>

/**
 * Build metadata. Kept in the manifest so the personal site can link off to
 * the source workflow file when a curious visitor asks "how is this thing
 * actually built?".
 */
export const Build = z.object({
  ci: z.boolean(),
  workflow: z.string().optional(),
})
export type Build = z.infer<typeof Build>

/**
 * Top-level manifest — the contract every embeddable project commits to.
 *
 * Slug regex matches the regex enforced by the upload Worker — anything
 * accepted here is acceptable as an upload prefix.
 */
export const ProjectManifest = z.object({
  schemaVersion: z.literal(1),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase, hyphen-separated, ≤64 chars'),
  category: Category,
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Optional thumbnail path *relative to the artifact root*. Resolved against
   *  `delivery.url` at render time so the site doesn't have to mirror it. */
  thumbnail: z.string().optional(),
  completionLevel: z.enum(['wip', 'works', 'ships']),
  embed: EmbedSpec,
  delivery: Delivery,
  build: Build,
})
export type ProjectManifest = z.infer<typeof ProjectManifest>

/**
 * Discovery metadata that the personal site adds to a manifest *after* it
 * fetches it — never written by the project repo. Tracks which GitHub repo a
 * manifest came from and when we last synced it. Lets the listing page show
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
 * The full content-entry shape: manifest + discovery metadata. This is what
 * Astro's `getCollection('projects')` returns.
 */
export const ProjectEntry = ProjectManifest.extend({
  discovery: DiscoveryMetadata,
})
export type ProjectEntry = z.infer<typeof ProjectEntry>
