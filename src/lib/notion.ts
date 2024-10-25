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
        const { results } = await notion.blocks.children.list({ block_id: pageId })
        const firstTextBlock = results.find((block): block is BlockObjectResponse =>
            'type' in block &&
            block.type === 'paragraph' &&
            block.paragraph.rich_text.length > 0
        )

        if (firstTextBlock && firstTextBlock.type === 'paragraph') {
            return renderRichText(firstTextBlock.paragraph.rich_text)
        }

        return ''
    } catch (error) {
        console.error('Error fetching first text block:', error)
        return ''
    }
}

export async function getBlogPosts(): Promise<BlogPost[]> {
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            sorts: [
                {
                    timestamp: 'created_time',
                    direction: 'descending',
                },
            ],
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

        return posts
    } catch (error) {
        console.error('Error fetching blog posts:', error)
        return []
    }
}

export async function getPost(pageId: string): Promise<BlogPostPage> {
    try {
        const page = await notion.pages.retrieve({ page_id: pageId }) as PageObjectResponse
        const blocks = await notion.blocks.children.list({ block_id: pageId })

        const content = await renderBlocks(blocks.results as BlockObjectResponse[])

        return {
            id: page.id,
            title: getTitleFromPage(page),
            content,
            createdTime: page.created_time,
            lastEditedTime: page.last_edited_time,
        }
    } catch (error) {
        console.error('Error fetching post:', error)
        throw error
    }
}

async function renderBlocks(blocks: BlockObjectResponse[]): Promise<string> {
    let html = ''

    for (const block of blocks) {
        switch (block.type) {
            case 'paragraph':
                html += `<p>${renderRichText(block.paragraph.rich_text)}</p>`
                break
            case 'heading_1':
                html += `<h1>${renderRichText(block.heading_1.rich_text)}</h1>`
                break
            case 'heading_2':
                html += `<h2>${renderRichText(block.heading_2.rich_text)}</h2>`
                break
            case 'heading_3':
                html += `<h3>${renderRichText(block.heading_3.rich_text)}</h3>`
                break
            case 'bulleted_list_item':
                html += `<ul><li>${renderRichText(block.bulleted_list_item.rich_text)}</li></ul>`
                break
            case 'numbered_list_item':
                html += `<ol><li>${renderRichText(block.numbered_list_item.rich_text)}</li></ol>`
                break
            case 'code':
                html += `<pre><code class="language-${block.code.language}">${renderRichText(block.code.rich_text)}</code></pre>`
                break
            case 'image':
                const imageUrl = block.image.type === 'external' ? block.image.external.url : block.image.file.url
                const caption = block.image.caption?.length ? renderRichText(block.image.caption) : ''
                html += `<figure><img src="${imageUrl}" alt="${caption}" />${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
                break
            case 'divider':
                html += '<hr />'
                break
            case 'quote':
                html += `<blockquote>${renderRichText(block.quote.rich_text)}</blockquote>`
                break
        }
    }

    return html
}

function renderRichText(richText: Array<RichTextItemResponse>): string {
    if (!richText) return ''

    return richText.map(text => {
        let content = text.plain_text

        if (text.annotations.bold) content = `<strong>${content}</strong>`
        if (text.annotations.italic) content = `<em>${content}</em>`
        if (text.annotations.strikethrough) content = `<del>${content}</del>`
        if (text.annotations.underline) content = `<u>${content}</u>`
        if (text.annotations.code) content = `<code>${content}</code>`

        if (text.href) content = `<a href="${text.href}" target="_blank" rel="noopener noreferrer">${content}</a>`

        return content
    }).join('')
}
