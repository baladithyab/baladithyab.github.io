import type { CollectionEntry } from 'astro:content'
import { render } from 'astro:content'
import { extractRichPreview, basicMarkdownToHtml } from './blog-preview'

export type BlogEntry = CollectionEntry<'blog'>

// Re-export pure helpers for callers that already import from this module.
export { extractRichPreview, basicMarkdownToHtml }

export function sortBlogPosts(posts: BlogEntry[]): BlogEntry[] {
  return [...posts].sort(
    (a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime(),
  )
}

export function filterPublishedPosts(posts: BlogEntry[]): BlogEntry[] {
  return posts.filter((post) => !post.data.draft)
}

export function formatBlogDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function formatBlogCardDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * SSR-time helper: given a blog entry, produce a balanced HTML preview
 * fragment (~`maxChars` visible chars) that preserves inline formatting from
 * the post body. Returns `null` if rendering fails so callers can fall back to
 * `post.data.description`.
 *
 * Strategy: `await render(post)` warms Astro's content pipeline (and could be
 * used to drive `<Content />`), then we render `post.body` (the raw markdown)
 * to HTML via `marked` and trim it via `extractRichPreview`. We don't go
 * through the AstroContainer API because that API expects a real Astro
 * runtime manifest which isn't present at request-time inside SSR.
 *
 * The HTML extraction is implemented in `./blog-preview` so it can be unit
 * tested without pulling in Astro's virtual `astro:content` module.
 */
export async function getRichPreview(
  post: BlogEntry,
  maxChars = 220,
): Promise<string | null> {
  try {
    // Warm the content pipeline so any frontmatter/remark plugins fire.
    await render(post)

    // Astro v6 content-layer entries expose the raw markdown body on `body`.
    const body = (post as unknown as { body?: string }).body
    if (typeof body !== 'string' || body.length === 0) return null

    // Lazy-import marked so the test bundle stays light (and so Vitest doesn't
    // have to resolve it for the pure-helper test files).
    const { marked } = await import('marked')
    marked.use({ async: false, gfm: true, breaks: false })
    const fullHtml = marked.parse(body) as string
    if (!fullHtml) return null

    return extractRichPreview(fullHtml, maxChars) || null
  } catch (err) {
    console.error('getRichPreview failed:', err)
    return null
  }
}
