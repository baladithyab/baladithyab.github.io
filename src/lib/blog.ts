import type { CollectionEntry } from 'astro:content'
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
 * Parses the raw Markdown body with Marked and trims the result through
 * extractRichPreview, preserving inline formatting without compiling an
 * Astro content component.
 */
export async function getRichPreview(
  post: BlogEntry,
  maxChars = 220,
): Promise<string | null> {
  try {
    // Content-layer entries expose the raw Markdown body on `body`.
    const body = (post as unknown as { body?: string }).body
    if (typeof body !== 'string' || body.length === 0) return null

    // Load the Markdown parser only when a preview is requested.
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
