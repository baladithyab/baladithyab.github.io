import type { CollectionEntry } from 'astro:content'

export type BlogEntry = CollectionEntry<'blog'>

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
