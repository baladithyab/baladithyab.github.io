import { Client } from '@notionhq/client'
import type {
    BlockObjectResponse,
    PageObjectResponse,
    RichTextItemResponse,
} from '@notionhq/client/build/src/api-endpoints'

const NOTION_API_KEY = import.meta.env.NOTION_API_KEY
const NOTION_DATABASE_ID = import.meta.env.NOTION_DATABASE_ID

if (!NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is required')
}

if (!NOTION_DATABASE_ID) {
    throw new Error('NOTION_DATABASE_ID is required')
}

export const notion = new Client({
    auth: NOTION_API_KEY,
})

export interface BlogPost {
    id: string
    title: string
    description: string
    createdTime: string
    lastEditedTime: string
}

export interface BlogPostPage {
    id: string
    title: string
    content: string
    createdTime: string
    lastEditedTime: string
}

function getTitleFromPage(page: PageObjectResponse): string {
    const titleProp = Object.values(page.properties).find(
        (prop: any) => prop.type === 'title'
    ) as { type: 'title'; title: Array<RichTextItemResponse> } | undefined

    return titleProp?.title[0]?.plain_text || 'Untitled'
}

async function getFirstTextBlock(pageId: string): Promise<string> {
    try {
        // Get more blocks to find a good preview
        const { results } = await notion.blocks.children.list({
            block_id: pageId,
            page_size: 10 // Get more blocks to find a good preview
        })

        // Look for paragraphs with content for the main preview
        const textBlocks = results.filter((block): block is BlockObjectResponse & { type: 'paragraph' } =>
            'type' in block &&
            block.type === 'paragraph' &&
            block.paragraph.rich_text.length > 0
        )

        // If we found any paragraphs, use the first one with enough content
        if (textBlocks.length > 0) {
            // Find the first paragraph with at least 100 characters or use the first one
            const goodBlock = textBlocks.find(block => {
                const text = block.paragraph.rich_text.map((t: RichTextItemResponse) => t.plain_text).join('')
                return text.length >= 100
            }) || textBlocks[0]

            // Render the rich text with proper formatting, specifying this is for a preview
            return renderRichText(goodBlock.paragraph.rich_text, true)
        }

        // If no paragraphs, look for list items
        const bulletedListBlocks = results.filter((block): block is BlockObjectResponse & { type: 'bulleted_list_item' } =>
            'type' in block && block.type === 'bulleted_list_item' && block.bulleted_list_item.rich_text.length > 0
        )

        const numberedListBlocks = results.filter((block): block is BlockObjectResponse & { type: 'numbered_list_item' } =>
            'type' in block && block.type === 'numbered_list_item' && block.numbered_list_item.rich_text.length > 0
        )

        // Check for bulleted list items first
        if (bulletedListBlocks.length > 0) {
            const firstListBlock = bulletedListBlocks[0]
            return renderRichText(firstListBlock.bulleted_list_item.rich_text, true)
        }

        // Then check for numbered list items
        if (numberedListBlocks.length > 0) {
            const firstListBlock = numberedListBlocks[0]
            return renderRichText(firstListBlock.numbered_list_item.rich_text, true)
        }

        return ''
    } catch (error) {
        console.error('Error fetching first text block:', error)
        return ''
    }
}

export async function getBlogPosts(): Promise<BlogPost[]> {
    try {
        // Check if caches is available (Cloudflare environment)
        let cachedResponse: Response | undefined;
        if (typeof caches !== 'undefined' && 'default' in caches) {
            // Create cache key for blog posts
            const cacheKey = new Request('https://codeseys.io/api/blog-posts')
            const cache = (caches as any).default

            // Try to get from cache first
            cachedResponse = await cache.match(cacheKey)
            if (cachedResponse) {
                return cachedResponse.json()
            }
        }

        // If not in cache, fetch from Notion
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            sorts: [
                {
                    timestamp: 'created_time',
                    direction: 'descending',
                },
            ],
            page_size: 100
        })

        const posts = await Promise.all(
            response.results
                .filter((page): page is PageObjectResponse => 'properties' in page)
                .map(async (page) => ({
                    id: page.id,
                    title: getTitleFromPage(page),
                    description: await getFirstTextBlock(page.id),
                    createdTime: page.created_time,
                    lastEditedTime: page.last_edited_time,
                }))
        )

        // Create response with cache headers if caches is available
        if (typeof caches !== 'undefined' && 'default' in caches) {
            const cacheKey = new Request('https://codeseys.io/api/blog-posts')
            const cache = (caches as any).default

            const newResponse = new Response(JSON.stringify(posts), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
                    'ETag': `"${Date.now()}"` // Add ETag for cache validation
                }
            })

            // Store in cache
            await cache.put(cacheKey, newResponse.clone())
        }

        return posts
    } catch (error) {
        console.error('Error fetching blog posts:', error)
        return []
    }
}

export async function getPost(pageId: string): Promise<BlogPostPage> {
    try {
        // Check if caches is available (Cloudflare environment)
        let cachedResponse: Response | undefined;
        if (typeof caches !== 'undefined' && 'default' in caches) {
            // Create cache key for individual post
            const cacheKey = new Request(`https://codeseys.io/api/blog-posts/${pageId}`)
            const cache = (caches as any).default

            // Try to get from cache first
            cachedResponse = await cache.match(cacheKey)
            if (cachedResponse) {
                return cachedResponse.json()
            }
        }

        // If not in cache, fetch from Notion
        const [page, blocks] = await Promise.all([
            notion.pages.retrieve({ page_id: pageId }) as Promise<PageObjectResponse>,
            notion.blocks.children.list({
                block_id: pageId,
                page_size: 100
            })
        ])

        const content = await renderBlocks(blocks.results as BlockObjectResponse[])

        const post = {
            id: page.id,
            title: getTitleFromPage(page),
            content,
            createdTime: page.created_time,
            lastEditedTime: page.last_edited_time,
        }

        // Create response with cache headers if caches is available
        if (typeof caches !== 'undefined' && 'default' in caches) {
            const cacheKey = new Request(`https://codeseys.io/api/blog-posts/${pageId}`)
            const cache = (caches as any).default

            const newResponse = new Response(JSON.stringify(post), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
                    'ETag': `"${Date.now()}"` // Add ETag for cache validation
                }
            })

            // Store in cache
            await cache.put(cacheKey, newResponse.clone())
        }

        return post
    } catch (error) {
        console.error('Error fetching post:', error)
        throw error
    }
}

async function renderBlocks(blocks: BlockObjectResponse[]): Promise<string> {
    const htmlChunks: string[] = []
    let currentListType: null | 'bulleted' | 'numbered' = null
    let listItems: string[] = []

    // Helper function to close any open list
    const closeCurrentList = () => {
        if (currentListType === 'bulleted' && listItems.length > 0) {
            htmlChunks.push(`<ul>${listItems.join('')}</ul>`)
            listItems = []
        } else if (currentListType === 'numbered' && listItems.length > 0) {
            htmlChunks.push(`<ol>${listItems.join('')}</ol>`)
            listItems = []
        }
        currentListType = null
    }

    for (const block of blocks) {
        // Handle list items specially to group them
        if (block.type === 'bulleted_list_item') {
            if (currentListType !== 'bulleted') {
                closeCurrentList()
                currentListType = 'bulleted'
            }
            listItems.push(`<li>${renderRichText(block.bulleted_list_item.rich_text)}</li>`)
            continue
        } else if (block.type === 'numbered_list_item') {
            if (currentListType !== 'numbered') {
                closeCurrentList()
                currentListType = 'numbered'
            }
            listItems.push(`<li>${renderRichText(block.numbered_list_item.rich_text)}</li>`)
            continue
        }

        // If we reach a non-list block, close any open list
        closeCurrentList()

        // Process other block types
        switch (block.type) {
            case 'paragraph':
                htmlChunks.push(`<p>${renderRichText(block.paragraph.rich_text)}</p>`)
                break
            case 'heading_1':
                htmlChunks.push(`<h1>${renderRichText(block.heading_1.rich_text)}</h1>`)
                break
            case 'heading_2':
                htmlChunks.push(`<h2>${renderRichText(block.heading_2.rich_text)}</h2>`)
                break
            case 'heading_3':
                htmlChunks.push(`<h3>${renderRichText(block.heading_3.rich_text)}</h3>`)
                break
            case 'code':
                htmlChunks.push(`<pre><code class="language-${block.code.language}">${renderRichText(block.code.rich_text)}</code></pre>`)
                break
            case 'image':
                const imageUrl = block.image.type === 'external' ? block.image.external.url : block.image.file.url
                const caption = block.image.caption?.length ? renderRichText(block.image.caption) : ''
                htmlChunks.push(`<figure><img src="${imageUrl}" alt="${caption}" loading="lazy" />${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`)
                break
            case 'divider':
                htmlChunks.push('<hr />')
                break
            case 'quote':
                htmlChunks.push(`<blockquote>${renderRichText(block.quote.rich_text)}</blockquote>`)
                break
        }
    }

    // Close any open list at the end of processing
    closeCurrentList()

    return htmlChunks.join('')
}

function renderRichText(richText: Array<RichTextItemResponse>, isPreview = false): string {
    if (!richText) return ''

    return richText.map(text => {
        let content = text.plain_text

        // Apply text formatting
        if (text.annotations.bold) content = `<strong>${content}</strong>`
        if (text.annotations.italic) content = `<em>${content}</em>`
        if (text.annotations.strikethrough) content = `<del>${content}</del>`
        if (text.annotations.underline) content = `<u>${content}</u>`
        if (text.annotations.code) content = `<code>${content}</code>`

        // Apply link formatting - always do this last to wrap the formatted content
        if (text.href) {
            if (isPreview) {
                // For previews, use a span with special styling instead of an anchor
                content = `<span class="notion-link-preview" data-href="${text.href}">${content}</span>`
            } else {
                // For regular content, use normal anchor tags
                content = `<a href="${text.href}" target="_blank" rel="noopener noreferrer" class="notion-link">${content}</a>`
            }
        }

        return content
    }).join('')
}
