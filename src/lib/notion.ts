// Type definitions for Notion API responses (using REST API directly for Cloudflare Workers compatibility)
// The @notionhq/client SDK doesn't work in edge runtimes, so we use fetch() directly.

interface RichTextItemResponse {
    type: string
    plain_text: string
    href: string | null
    annotations: {
        bold: boolean
        italic: boolean
        strikethrough: boolean
        underline: boolean
        code: boolean
        color: string
    }
}

interface BlockObjectResponse {
    id: string
    type: string
    paragraph?: { rich_text: RichTextItemResponse[] }
    heading_1?: { rich_text: RichTextItemResponse[] }
    heading_2?: { rich_text: RichTextItemResponse[] }
    heading_3?: { rich_text: RichTextItemResponse[] }
    bulleted_list_item?: { rich_text: RichTextItemResponse[] }
    numbered_list_item?: { rich_text: RichTextItemResponse[] }
    code?: { rich_text: RichTextItemResponse[]; language: string }
    image?: {
        type: 'external' | 'file'
        external?: { url: string }
        file?: { url: string }
        caption?: RichTextItemResponse[]
    }
    quote?: { rich_text: RichTextItemResponse[] }
}

interface PageObjectResponse {
    id: string
    created_time: string
    last_edited_time: string
    properties: Record<string, any>
}

// Build-time environment variables (fallback)
const BUILD_TIME_API_KEY = import.meta.env.NOTION_API_KEY
const BUILD_TIME_DATABASE_ID = import.meta.env.NOTION_DATABASE_ID

// Runtime environment interface (from Cloudflare Workers)
export interface NotionEnv {
    NOTION_API_KEY?: string
    NOTION_DATABASE_ID?: string
}

// Get environment variables from runtime or build-time
function getEnvVars(runtimeEnv?: NotionEnv) {
    const apiKey = runtimeEnv?.NOTION_API_KEY || BUILD_TIME_API_KEY
    const databaseId = runtimeEnv?.NOTION_DATABASE_ID || BUILD_TIME_DATABASE_ID
    return { apiKey, databaseId }
}

// Notion REST API helper
const NOTION_API_BASE = 'https://api.notion.com/v1'

async function notionFetch(endpoint: string, apiKey: string, options: RequestInit = {}) {
    const response = await fetch(`${NOTION_API_BASE}${endpoint}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
            ...options.headers,
        },
    })

    if (!response.ok) {
        const error = await response.text()
        throw new Error(`Notion API error: ${response.status} - ${error}`)
    }

    return response.json()
}

// Legacy exports for backward compatibility
export const notion = null
export const isNotionConfigured = Boolean(BUILD_TIME_API_KEY && BUILD_TIME_DATABASE_ID)

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

async function getFirstTextBlock(pageId: string, apiKey: string): Promise<string> {
    try {
        // Get more blocks to find a good preview
        const data = await notionFetch(`/blocks/${pageId}/children?page_size=10`, apiKey)
        const results = data.results as BlockObjectResponse[]

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

export async function getBlogPosts(runtimeEnv?: NotionEnv): Promise<BlogPost[]> {
    // Get environment variables (runtime or build-time)
    const { apiKey, databaseId } = getEnvVars(runtimeEnv)

    // Return empty if Notion is not configured
    if (!apiKey || !databaseId) {
        console.warn('Notion is not configured. Skipping blog posts fetch.')
        return []
    }

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

        // Fetch from Notion using REST API
        const response = await notionFetch(`/databases/${databaseId}/query`, apiKey, {
            method: 'POST',
            body: JSON.stringify({
                sorts: [
                    {
                        timestamp: 'created_time',
                        direction: 'descending',
                    },
                ],
                page_size: 100
            })
        })

        const posts = await Promise.all(
            (response.results as PageObjectResponse[])
                .filter((page): page is PageObjectResponse => 'properties' in page)
                .map(async (page) => ({
                    id: page.id,
                    title: getTitleFromPage(page),
                    description: await getFirstTextBlock(page.id, apiKey),
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

export async function getPost(pageId: string, runtimeEnv?: NotionEnv): Promise<BlogPostPage> {
    // Get environment variables (runtime or build-time)
    const { apiKey } = getEnvVars(runtimeEnv)

    // Check if Notion is configured
    if (!apiKey) {
        throw new Error('Notion is not configured')
    }

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

        // Fetch from Notion using REST API
        const [page, blocksData] = await Promise.all([
            notionFetch(`/pages/${pageId}`, apiKey) as Promise<PageObjectResponse>,
            notionFetch(`/blocks/${pageId}/children?page_size=100`, apiKey)
        ])

        const content = await renderBlocks(blocksData.results as BlockObjectResponse[])

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
