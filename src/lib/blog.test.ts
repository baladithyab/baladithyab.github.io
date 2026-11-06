/** Behavior tests for the public blog helpers and HTML preview extraction. */
import { describe, it, expect, vi } from 'vitest'
import {
  extractRichPreview,
  basicMarkdownToHtml,
  sortBlogPosts,
  filterPublishedPosts,
  getRichPreview,
  type BlogEntry,
} from './blog'

function makePost(opts: {
  id: string
  title?: string
  publishedAt: string
  draft?: boolean
  body?: string
}): BlogEntry {
  return {
    id: opts.id,
    collection: 'blog',
    body: opts.body,
    data: {
      title: opts.title ?? `Post ${opts.id}`,
      description: 'desc',
      publishedAt: new Date(opts.publishedAt),
      draft: opts.draft ?? false,
      tags: [],
      featured: false,
    },
  }
}

describe('sortBlogPosts', () => {
  it('orders newest first by publishedAt', () => {
    const posts = [
      makePost({ id: 'a', publishedAt: '2024-01-01' }),
      makePost({ id: 'b', publishedAt: '2025-06-15' }),
      makePost({ id: 'c', publishedAt: '2023-09-30' }),
    ]
    const sorted = sortBlogPosts(posts)
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate input', () => {
    const posts = [
      makePost({ id: 'a', publishedAt: '2024-01-01' }),
      makePost({ id: 'b', publishedAt: '2025-06-15' }),
    ]
    const original = [...posts]
    sortBlogPosts(posts)
    expect(posts).toEqual(original)
  })

  it('handles empty list', () => {
    expect(sortBlogPosts([])).toEqual([])
  })
})

describe('filterPublishedPosts', () => {
  it('drops drafts', () => {
    const posts = [
      makePost({ id: 'a', publishedAt: '2024-01-01', draft: false }),
      makePost({ id: 'b', publishedAt: '2024-01-02', draft: true }),
      makePost({ id: 'c', publishedAt: '2024-01-03', draft: false }),
    ]
    expect(filterPublishedPosts(posts).map((p) => p.id)).toEqual(['a', 'c'])
  })
})

describe('getRichPreview', () => {
  const previewPost = (body?: string) =>
    makePost({ id: 'preview', publishedAt: '2026-01-01', body })

  it('parses raw Markdown and preserves rich inline formatting', async () => {
    const post = previewPost(
      '# Heading to omit\n\nRead **bold**, *italic*, `fetch` and [docs](https://example.com).\n\n```js\nhiddenCode()\n```',
    )
    const preview = await getRichPreview(post, 200)
    expect(preview).toContain('<strong>bold</strong>')
    expect(preview).toContain('<em>italic</em>')
    expect(preview).toContain('<code>fetch</code>')
    expect(preview).toContain(
      '<a href="https://example.com" rel="noopener noreferrer">docs</a>',
    )
    expect(preview).not.toContain('Heading to omit')
    expect(preview).not.toContain('hiddenCode')
  })

  it('truncates a formatted preview at the requested budget and closes tags', async () => {
    const preview = await getRichPreview(
      previewPost('Start **alpha beta gamma delta epsilon zeta** trailing words.'),
      22,
    )
    expect(preview).toBe('<p>Start <strong>alpha beta gamma…</strong></p>')
  })

  it.each([undefined, '', '# Heading only', '```js\ncodeOnly()\n```'])(
    'returns null for an unavailable or unusable body (%s), enabling description fallback',
    async (body) => {
      const post = previewPost(body)
      const preview = await getRichPreview(post)
      expect(preview).toBeNull()
      expect(preview ?? post.data.description).toBe(post.data.description)
    },
  )

  it('returns null on failure so the caller can use the description', async () => {
    const post = previewPost('Body')
    const failure = new Error('Body unavailable')
    Object.defineProperty(post, 'body', {
      get() {
        throw failure
      },
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const preview = await getRichPreview(post)
      expect(preview).toBeNull()
      expect(preview ?? post.data.description).toBe('desc')
    } finally {
      errorLog.mockRestore()
    }
  })
})

describe('basicMarkdownToHtml', () => {
  it('wraps paragraphs in <p>', () => {
    expect(basicMarkdownToHtml('Hello world.\n\nSecond para.')).toContain(
      '<p>Hello world.</p>',
    )
  })

  it('renders **bold** and *italic*', () => {
    const out = basicMarkdownToHtml('This is **bold** and *italic*.')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
  })

  it('renders inline `code`', () => {
    expect(basicMarkdownToHtml('Use `fetch` here.')).toContain('<code>fetch</code>')
  })

  it('renders [link](url)', () => {
    const out = basicMarkdownToHtml('See [docs](https://example.com).')
    expect(out).toContain('<a href="https://example.com">docs</a>')
  })

  it('strips ATX-style headings', () => {
    const out = basicMarkdownToHtml('# Heading\n\nBody.')
    expect(out).not.toContain('Heading')
    expect(out).toContain('Body.')
  })

  it('strips fenced code blocks', () => {
    const out = basicMarkdownToHtml('Intro\n\n```\nconst x = 1\n```\n\nOutro')
    expect(out).not.toContain('const x = 1')
  })
})

describe('extractRichPreview', () => {
  it('returns empty string for empty input', () => {
    expect(extractRichPreview('')).toBe('')
  })

  it('preserves bold and italic inline tags', () => {
    const html = '<p>This is <strong>bold</strong> and <em>italic</em> text.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
    expect(out).toContain('<p>')
    expect(out).toContain('</p>')
  })

  it('preserves inline code', () => {
    const html = '<p>Use the <code>fetch</code> API.</p>'
    expect(extractRichPreview(html, 200)).toContain('<code>fetch</code>')
  })

  it('preserves safe href links and adds rel attribute', () => {
    const html =
      '<p>See <a href="https://example.com">the docs</a> for details.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('strips javascript: hrefs', () => {
    const html = '<p>Click <a href="javascript:alert(1)">here</a>.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('alert')
    expect(out).toContain('here')
  })

  it('strips headings entirely (block-level skip)', () => {
    const html = '<h1>Big Heading</h1><p>The actual paragraph content here.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).not.toContain('Big Heading')
    expect(out).toContain('The actual paragraph content')
  })

  it('strips fenced code blocks (<pre>)', () => {
    const html =
      '<p>Intro</p><pre><code>const x = 1</code></pre><p>Conclusion</p>'
    const out = extractRichPreview(html, 200)
    expect(out).not.toContain('const x = 1')
    expect(out).toContain('Intro')
    expect(out).toContain('Conclusion')
  })

  it('strips images and figures', () => {
    const html =
      '<figure><img src="/foo.png" alt="foo"/><figcaption>caption</figcaption></figure><p>Body.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).not.toContain('<img')
    expect(out).not.toContain('caption')
    expect(out).toContain('Body.')
  })

  it('clips at the visible-character budget with an ellipsis', () => {
    const longText = 'word '.repeat(100)
    const html = `<p>${longText.trim()}</p>`
    const out = extractRichPreview(html, 50)
    expect(out).toContain('…')
    const visibleText = out.replace(/<[^>]+>/g, '').replace('…', '')
    expect(visibleText.length).toBeLessThanOrEqual(60)
  })

  it('produces balanced HTML even when clipping mid-tag', () => {
    const html =
      '<p>Some <strong>very <em>nested italic <code>code</code> chunks</em></strong> in the body.</p>'
    const out = extractRichPreview(html, 30)
    const opens = (out.match(/<(strong|em|code|p)\b/g) || []).length
    const closes = (out.match(/<\/(strong|em|code|p)>/g) || []).length
    expect(opens).toBe(closes)
  })

  it('escapes special characters in text content', () => {
    const html = '<p>5 &lt; 10 &amp; 10 &gt; 5</p>'
    const out = extractRichPreview(html, 200)
    expect(out).toContain('&lt;')
    expect(out).toContain('&amp;')
    expect(out).toContain('&gt;')
  })

  it('decodes named HTML entities in source', () => {
    const html = '<p>Hello&nbsp;world &mdash; testing.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).toMatch(/Hello\s+world\s+—\s+testing/)
  })

  it('limits paragraphs to 3', () => {
    const html =
      '<p>One.</p><p>Two.</p><p>Three.</p><p>Four.</p><p>Five.</p>'
    const out = extractRichPreview(html, 1000)
    const pCount = (out.match(/<p>/g) || []).length
    expect(pCount).toBeLessThanOrEqual(3)
  })

  it('drops <script> and <style> entirely', () => {
    const html =
      '<script>alert(1)</script><style>p{color:red}</style><p>Visible body.</p>'
    const out = extractRichPreview(html, 200)
    expect(out).not.toContain('alert')
    expect(out).not.toContain('color:red')
    expect(out).toContain('Visible body.')
  })

  it('handles missing closing tags gracefully', () => {
    const html = '<p>Opening but no close <strong>strong text'
    const out = extractRichPreview(html, 200)
    expect(out).toContain('</strong>')
    expect(out).toContain('</p>')
  })

  it('does not emit empty inline pairs after the visible-char cap', () => {
    // Markdown-rendered posts often have many <strong>/<em>/<a> after the
    // first paragraph. Once our visible-char budget is hit we should suppress
    // further opening tags so empty <strong></strong> etc. don't litter the
    // preview.
    const html =
      '<p>Short intro paragraph that fits.</p>' +
      '<p>' +
      '<strong>bold-1</strong> text <em>em-1</em> more ' +
      '<strong>bold-2</strong> tail <a href="/x">link</a> end.' +
      '</p>'
    const out = extractRichPreview(html, 30)
    // No empty inline pairs.
    expect(out).not.toMatch(/<strong[^>]*>\s*<\/strong>/)
    expect(out).not.toMatch(/<em[^>]*>\s*<\/em>/)
    expect(out).not.toMatch(/<a[^>]*>\s*<\/a>/)
  })
})
