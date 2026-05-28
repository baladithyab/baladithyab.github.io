/**
 * Tests for src/lib/projects.ts.
 *
 * Pure helpers — no Astro / network needed. Verifies:
 *   - buildEmbedSlugMap aggregates entries, lowercases the key, and
 *     handles the duplicate-source edge case
 *   - repoFullNameFromUrl normalises trailing slashes, .git suffixes,
 *     and case
 *   - annotateWithEmbedSlug returns the repo unchanged when no manifest
 *     matches, and adds embedSlug when one does
 */
import { describe, expect, it } from 'vitest'

import {
  annotateWithEmbedSlug,
  buildEmbedSlugMap,
  repoFullNameFromUrl,
  type ProjectEntryLike,
  type RepoLike,
} from './projects'

function entry(slug: string, source: string): ProjectEntryLike {
  return { data: { slug, discovery: { source } } }
}

describe('repoFullNameFromUrl', () => {
  it('extracts owner/name from a canonical github url', () => {
    expect(repoFullNameFromUrl('https://github.com/baladithyab/UCSC-CSE-160-W21')).toBe(
      'baladithyab/ucsc-cse-160-w21',
    )
  })

  it('strips a trailing slash', () => {
    expect(repoFullNameFromUrl('https://github.com/foo/bar/')).toBe('foo/bar')
  })

  it('strips a .git suffix', () => {
    expect(repoFullNameFromUrl('https://github.com/foo/bar.git')).toBe('foo/bar')
    expect(repoFullNameFromUrl('https://github.com/foo/bar.GIT')).toBe('foo/bar')
  })

  it('lowercases the result so case-insensitive comparison Just Works', () => {
    expect(repoFullNameFromUrl('https://github.com/BalaDithyaB/UCSC-CSE-160-W21')).toBe(
      'baladithyab/ucsc-cse-160-w21',
    )
  })

  it('returns null for a profile URL (no repo)', () => {
    expect(repoFullNameFromUrl('https://github.com/baladithyab')).toBe(null)
  })

  it('returns null for non-github hosts', () => {
    expect(repoFullNameFromUrl('https://gitlab.com/foo/bar')).toBe(null)
  })

  it('returns null for malformed URLs', () => {
    expect(repoFullNameFromUrl('not a url at all')).toBe(null)
  })

  it('accepts www.github.com', () => {
    expect(repoFullNameFromUrl('https://www.github.com/foo/bar')).toBe('foo/bar')
  })

  it('ignores extra path segments after owner/name', () => {
    expect(repoFullNameFromUrl('https://github.com/foo/bar/tree/main/src')).toBe('foo/bar')
  })
})

describe('buildEmbedSlugMap', () => {
  it('produces an empty map for an empty list', () => {
    expect(buildEmbedSlugMap([])).toEqual(new Map())
  })

  it('keys by lowercase source', () => {
    const map = buildEmbedSlugMap([entry('cse-160-asg2', 'BalaDithyaB/UCSC-CSE-160-W21')])
    expect(map.get('baladithyab/ucsc-cse-160-w21')).toBe('cse-160-asg2')
    expect(map.get('BalaDithyaB/UCSC-CSE-160-W21')).toBeUndefined()
  })

  it('first writer wins on duplicate sources', () => {
    const map = buildEmbedSlugMap([
      entry('first', 'foo/bar'),
      entry('second', 'FOO/BAR'),
    ])
    expect(map.get('foo/bar')).toBe('first')
    expect(map.size).toBe(1)
  })

  it('handles multiple distinct entries', () => {
    const map = buildEmbedSlugMap([
      entry('cse-160-asg2', 'baladithyab/UCSC-CSE-160-W21'),
      entry('cse-101-bigint', 'baladithyab/UCSC-CSE-101-W22'),
    ])
    expect(map.size).toBe(2)
    expect(map.get('baladithyab/ucsc-cse-160-w21')).toBe('cse-160-asg2')
    expect(map.get('baladithyab/ucsc-cse-101-w22')).toBe('cse-101-bigint')
  })
})

describe('annotateWithEmbedSlug', () => {
  const slugMap = new Map<string, string>([
    ['baladithyab/ucsc-cse-160-w21', 'cse-160-asg2'],
  ])

  it('adds embedSlug when the repo matches a manifest', () => {
    const repo: RepoLike = {
      name: 'UCSC-CSE-160-W21',
      html_url: 'https://github.com/baladithyab/UCSC-CSE-160-W21',
    }
    const result = annotateWithEmbedSlug(repo, slugMap)
    expect((result as RepoLike & { embedSlug?: string }).embedSlug).toBe('cse-160-asg2')
  })

  it('returns repo unchanged when no manifest matches', () => {
    const repo: RepoLike = {
      name: 'unrelated',
      html_url: 'https://github.com/baladithyab/unrelated',
    }
    const result = annotateWithEmbedSlug(repo, slugMap)
    expect((result as RepoLike & { embedSlug?: string }).embedSlug).toBeUndefined()
    expect(result).toEqual(repo)
  })

  it('returns repo unchanged when html_url is unparseable', () => {
    const repo: RepoLike = { name: 'oops', html_url: 'gibberish' }
    expect(annotateWithEmbedSlug(repo, slugMap)).toEqual(repo)
  })

  it('preserves all other repo fields', () => {
    const repo: RepoLike & { description: string; stars: number } = {
      name: 'UCSC-CSE-160-W21',
      html_url: 'https://github.com/baladithyab/UCSC-CSE-160-W21',
      description: 'WebGL graphics assignments',
      stars: 3,
    }
    const result = annotateWithEmbedSlug(repo, slugMap)
    expect(result).toMatchObject({
      name: 'UCSC-CSE-160-W21',
      description: 'WebGL graphics assignments',
      stars: 3,
      embedSlug: 'cse-160-asg2',
    })
  })

  it('case-insensitive match against the html_url', () => {
    const repo: RepoLike = {
      name: 'UCSC-CSE-160-W21',
      html_url: 'https://github.com/BalaDithyaB/UCSC-CSE-160-W21',
    }
    const result = annotateWithEmbedSlug(repo, slugMap)
    expect((result as RepoLike & { embedSlug?: string }).embedSlug).toBe('cse-160-asg2')
  })
})
