import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { fetchRenderedOverview, stripFirstH1 } from './project-overview'

describe('stripFirstH1', () => {
  it('drops a leading H1', () => {
    const r = stripFirstH1('# CSE 101\n\nWelcome to CSE 101.\n')
    expect(r).toBe('Welcome to CSE 101.\n')
  })
  it('keeps subsequent H1s', () => {
    const r = stripFirstH1('# Top\n\nbody\n# Another\n')
    expect(r).toContain('# Another')
    expect(r).not.toMatch(/^# Top/)
  })
  it('passes through if no leading H1', () => {
    const r = stripFirstH1('Welcome\n\n## Subsection')
    expect(r).toBe('Welcome\n\n## Subsection')
  })
  it('tolerates leading whitespace before H1', () => {
    const r = stripFirstH1('   \n# Title\n\nbody')
    expect(r).toBe('body')
  })
})

describe('fetchRenderedOverview', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects bogus source format', async () => {
    const r = await fetchRenderedOverview({
      source: 'not a slash path',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid source/)
  })

  it('rejects path traversal', async () => {
    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: '../../etc/passwd',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid path/)
  })

  it('rejects absolute paths', async () => {
    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: '/README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid path/)
  })

  it('renders fetched markdown to HTML', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('# Title\n\nHello **world**.\n\n```js\nconst x = 1\n```', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    ) as unknown as typeof fetch

    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // skipFirstHeading dropped the H1
      expect(r.html).not.toContain('<h1>Title</h1>')
      expect(r.html).toContain('<strong>world</strong>')
      expect(r.html).toMatch(/<code[^>]*>const x = 1/)
    }
  })

  it('keeps the first H1 when skipFirstHeading is false', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('# Title\n\nbody', { status: 200 })
    ) as unknown as typeof fetch

    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: false,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.html).toContain('<h1>Title</h1>')
  })

  it('reports HTTP errors as {ok: false}', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Not Found', { status: 404 })
    ) as unknown as typeof fetch

    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/HTTP 404/)
  })

  it('rejects empty content', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch

    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/empty/)
  })

  it('rejects oversized content (>256KB)', async () => {
    const big = 'x'.repeat(257 * 1024)
    globalThis.fetch = vi.fn(async () => new Response(big, { status: 200 })) as unknown as typeof fetch

    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/exceeds/)
  })

  it('handles fetch throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const r = await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'main',
      path: 'README.md',
      skipFirstHeading: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/fetch failed/)
  })

  it('uses raw.githubusercontent.com URL with the right ref + path', async () => {
    let calledUrl: string | URL = ''
    globalThis.fetch = vi.fn(async (url) => {
      calledUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url
      return new Response('# X\nbody', { status: 200 })
    }) as unknown as typeof fetch

    await fetchRenderedOverview({
      source: 'baladithyab/UCSC-CSE-160-W21',
      ref: 'master',
      path: 'docs/OVERVIEW.md',
      skipFirstHeading: true,
    })
    expect(String(calledUrl)).toBe(
      'https://raw.githubusercontent.com/baladithyab/UCSC-CSE-160-W21/master/docs/OVERVIEW.md'
    )
  })
})
