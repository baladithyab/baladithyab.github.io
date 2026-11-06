import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import type { BlogGridPost } from './BlogGrid'

const post: BlogGridPost = {
  id: 'fixture',
  href: '/blog/fixture',
  title: 'Engineering notes',
  description: 'An article with a linked preview.',
  previewHtml: '<p>Continue with the <a href="/blog/earlier">earlier article</a>.</p>',
  publishedAt: '2026-05-27',
  publishedAtDisplay: 'May 27, 2026',
  updatedAt: null,
  updatedAtDisplay: null,
  tags: ['engineering'],
}

describe('BlogGrid browser navigation', () => {
  let server: ViteDevServer
  let browser: Browser
  let BlogGrid: ComponentType<{ posts: BlogGridPost[] }>

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
      oxc: { jsx: { runtime: 'automatic' } },
    })
    const component = await server.ssrLoadModule('/src/components/BlogGrid.tsx')
    BlogGrid = component.default
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it('keeps one primary article link and an independently usable preview link after HTML parsing', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(renderToString(createElement(BlogGrid, { posts: [post] })))
      const article = page.getByRole('link', { name: post.title, exact: true })
      expect(await article.count()).toBe(1)
      expect(await article.getAttribute('href')).toBe(post.href)
      expect(await page.locator(`a[href="${post.href}"]`).count()).toBe(1)
      expect(await page.getByRole('link', { name: 'earlier article', exact: true }).getAttribute('href'))
        .toBe('/blog/earlier')
    } finally {
      await page.close()
    }
  })
})
