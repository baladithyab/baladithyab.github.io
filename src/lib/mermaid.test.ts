import { createMarkdownProcessor } from '@astrojs/markdown-remark'
import rehypeMermaid from 'rehype-mermaid'
import { describe, expect, it } from 'vitest'

describe('Astro Mermaid rendering', () => {
  it('preserves accessible diagram labels and renders mathematical labels', async () => {
    const processor = await createMarkdownProcessor({
      syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
      rehypePlugins: [[rehypeMermaid, {
        strategy: 'inline-svg',
        mermaidConfig: { theme: 'neutral', layout: 'dagre', look: 'classic' },
      }]],
    })
    const { code } = await processor.render([
      '```mermaid',
      'flowchart LR',
      'accTitle: Mathematical calculation',
      'A["$$x^2$$"] --> B["Calculated result"]',
      '```',
    ].join('\n'))

    expect(code).toContain('<svg')
    expect(code).toContain('aria-labelledby=')
    expect(code).toContain('Mathematical calculation</title>')
    expect(code).toContain('Calculated result')
    expect(code).toContain('<math')
    expect(code).toContain('<msup>')
  }, 30_000)
})
