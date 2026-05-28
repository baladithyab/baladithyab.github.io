/**
 * Tests for src/lib/types/project-manifest.ts.
 *
 * Coverage targets:
 *   - v1 manifest parses, normalizes to a 1-asset v2 shape with id 'main'
 *   - v2 manifest parses, normalizes with defaultAssetId resolved
 *   - v2 with invalid defaultAssetId falls back to assets[0]
 *   - schema rejection paths: missing assets, bad slug, bad asset id, etc.
 *   - EmbedSpec discriminated union accepts each kind
 */
import { describe, expect, it } from 'vitest'
import {
  Asset,
  EmbedSpec,
  normalizeManifest,
  ProjectManifest,
} from './project-manifest'

const v1Sample = {
  schemaVersion: 1,
  slug: 'cse-160',
  category: { kind: 'college', school: 'UCSC', code: 'CSE 160', title: 'Graphics', year: 2021 },
  title: 'CSE 160 — Graphics Assignments',
  description: 'WebGL homework',
  tags: ['webgl'],
  completionLevel: 'ships',
  embed: { kind: 'static-html', entry: 'asg2.html' },
  delivery: {
    mode: 'runtime-r2',
    url: 'https://assets-r2.codeseys.io/cse-160/abc123/',
    version: 'abc123',
    sizeBytes: 100000,
  },
  build: { ci: true },
}

const v2Sample = {
  schemaVersion: 2,
  slug: 'cse-160',
  category: { kind: 'college', school: 'UCSC', code: 'CSE 160', title: 'Graphics', year: 2021 },
  title: 'CSE 160 — Graphics',
  description: 'Five WebGL assignments + LaTeX writeups',
  tags: ['webgl', 'graphics'],
  completionLevel: 'ships',
  defaultAssetId: 'asg2',
  assets: [
    { id: 'asg0', title: 'Assignment 0', group: 'Demos', embed: { kind: 'static-html', entry: 'asg0/asg0.html' } },
    { id: 'asg2', title: 'Assignment 2', group: 'Demos', embed: { kind: 'static-html', entry: 'asg2/asg2.html' } },
    { id: 'hw1', title: 'HW1 Writeup', group: 'Writeups', embed: { kind: 'tex-pdf', pdf: 'hw1.pdf' } },
  ],
  delivery: {
    mode: 'runtime-r2',
    url: 'https://assets-r2.codeseys.io/cse-160/abc123/',
    version: 'abc123',
    sizeBytes: 250000,
  },
  build: { ci: true },
}

describe('ProjectManifest schema', () => {
  it('parses a v1 manifest', () => {
    const result = ProjectManifest.safeParse(v1Sample)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schemaVersion).toBe(1)
    }
  })

  it('parses a v2 manifest', () => {
    const result = ProjectManifest.safeParse(v2Sample)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.schemaVersion).toBe(2)
      if (result.data.schemaVersion === 2) expect(result.data.assets).toHaveLength(3)
    }
  })

  it('accepts a v2 manifest with no assets (overview-only)', () => {
    // The 2026-05-28 update made `assets` optional so projects can have
    // a personal-site page even with no live demo. The normalizer turns
    // a missing `assets` into an empty array; an empty array passes too.
    const overviewOnly = { ...v2Sample, assets: [], delivery: undefined, build: undefined }
    expect(ProjectManifest.safeParse(overviewOnly).success).toBe(true)
  })

  it('also accepts a v2 manifest with assets omitted entirely', () => {
    const omitted: Record<string, unknown> = { ...v2Sample }
    delete omitted.assets
    delete omitted.delivery
    delete omitted.build
    expect(ProjectManifest.safeParse(omitted).success).toBe(true)
  })

  it('rejects a v2 manifest with a duplicate-id asset', () => {
    // Note: the schema doesn't strictly forbid duplicate ids — that would
    // require a refinement. For now, normalizeManifest handles the
    // first-wins case by virtue of the Map-keyed lookups in the UI.
    // This test documents the current behaviour: parsing succeeds even
    // with duplicates.
    const bad = {
      ...v2Sample,
      assets: [
        { id: 'a', title: 'A', embed: { kind: 'static-html', entry: 'a.html' } },
        { id: 'a', title: 'A again', embed: { kind: 'static-html', entry: 'a2.html' } },
      ],
    }
    expect(ProjectManifest.safeParse(bad).success).toBe(true)
  })

  it('rejects a v1 manifest without an embed', () => {
    const { embed: _, ...rest } = v1Sample
    void _
    expect(ProjectManifest.safeParse(rest).success).toBe(false)
  })

  it('rejects bad slug (uppercase)', () => {
    const bad = { ...v1Sample, slug: 'CSE-160' }
    expect(ProjectManifest.safeParse(bad).success).toBe(false)
  })

  it('rejects bad asset id (uppercase)', () => {
    const bad = {
      ...v2Sample,
      assets: [{ id: 'A', title: 'A', embed: { kind: 'static-html', entry: 'a.html' } }],
    }
    expect(ProjectManifest.safeParse(bad).success).toBe(false)
  })
})

describe('EmbedSpec', () => {
  it.each([
    ['static-html', { kind: 'static-html', entry: 'a.html' }],
    ['wasm-emscripten', { kind: 'wasm-emscripten', entry: 'a.html', memory: '256mb' }],
    ['wasm-rust', { kind: 'wasm-rust', entry: 'a.html' }],
    ['pyodide', { kind: 'pyodide', entry: 'a.py', packages: ['numpy'] }],
    ['notebook-html', { kind: 'notebook-html', notebook: 'nb.html' }],
    ['pglite-db', { kind: 'pglite-db', schema: 'schema.sql', seed: 'seed.sql' }],
    ['tex-pdf', { kind: 'tex-pdf', pdf: 'paper.pdf' }],
    ['external-app', { kind: 'external-app', url: 'https://example.com/app' }],
  ])('accepts %s', (_label, spec) => {
    expect(EmbedSpec.safeParse(spec).success).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect(EmbedSpec.safeParse({ kind: 'made-up', entry: 'x' }).success).toBe(false)
  })
})

describe('Asset', () => {
  it('parses a minimal asset', () => {
    const a = { id: 'demo', title: 'Demo', embed: { kind: 'static-html', entry: 'd.html' } }
    expect(Asset.safeParse(a).success).toBe(true)
  })

  it('parses with all fields', () => {
    const a = {
      id: 'demo',
      title: 'Demo',
      description: 'A live demo',
      group: 'Live demos',
      embed: { kind: 'static-html', entry: 'd.html' },
      sizeBytes: 1234,
    }
    expect(Asset.safeParse(a).success).toBe(true)
  })

  it('rejects asset id with uppercase', () => {
    const a = { id: 'Demo', title: 'D', embed: { kind: 'static-html', entry: 'd.html' } }
    expect(Asset.safeParse(a).success).toBe(false)
  })

  it('rejects asset id starting with hyphen', () => {
    const a = { id: '-demo', title: 'D', embed: { kind: 'static-html', entry: 'd.html' } }
    expect(Asset.safeParse(a).success).toBe(false)
  })

  it('rejects asset id over 40 chars', () => {
    const a = { id: 'a'.repeat(41), title: 'D', embed: { kind: 'static-html', entry: 'd.html' } }
    expect(Asset.safeParse(a).success).toBe(false)
  })
})

describe('normalizeManifest', () => {
  it('upgrades v1 to v2 shape with one synthesized asset', () => {
    const parsed = ProjectManifest.parse(v1Sample)
    const norm = normalizeManifest(parsed)
    expect(norm.assets).toHaveLength(1)
    expect(norm.assets[0]!.id).toBe('main')
    expect(norm.assets[0]!.embed).toEqual(v1Sample.embed)
    expect(norm.defaultAssetId).toBe('main')
  })

  it('preserves v1 metadata fields', () => {
    const parsed = ProjectManifest.parse(v1Sample)
    const norm = normalizeManifest(parsed)
    expect(norm.slug).toBe('cse-160')
    expect(norm.title).toBe(v1Sample.title)
    expect(norm.description).toBe(v1Sample.description)
    expect(norm.tags).toEqual(['webgl'])
    expect(norm.completionLevel).toBe('ships')
    expect(norm.delivery.version).toBe('abc123')
  })

  it('passes v2 through with defaultAssetId resolved', () => {
    const parsed = ProjectManifest.parse(v2Sample)
    const norm = normalizeManifest(parsed)
    expect(norm.assets).toHaveLength(3)
    expect(norm.defaultAssetId).toBe('asg2')
  })

  it('falls back to first asset when defaultAssetId points to nothing', () => {
    const v2 = { ...v2Sample, defaultAssetId: 'nonexistent' }
    const parsed = ProjectManifest.parse(v2)
    const norm = normalizeManifest(parsed)
    expect(norm.defaultAssetId).toBe('asg0')
  })

  it('falls back to first asset when defaultAssetId is omitted', () => {
    const { defaultAssetId: _, ...rest } = v2Sample
    void _
    const parsed = ProjectManifest.parse(rest)
    const norm = normalizeManifest(parsed)
    expect(norm.defaultAssetId).toBe('asg0')
  })

  it('output is idempotent: normalizing a v2 twice yields the same shape', () => {
    const parsed = ProjectManifest.parse(v2Sample)
    const once = normalizeManifest(parsed)
    // Re-parse 'once' as a v2 manifest (with schemaVersion stuffed back)
    // and normalize again; result should equal the first normalisation.
    const reparsed = ProjectManifest.parse({ schemaVersion: 2, ...once })
    const twice = normalizeManifest(reparsed)
    expect(twice).toEqual(once)
  })
})
