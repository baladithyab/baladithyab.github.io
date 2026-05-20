/**
 * Pure HTML preview-extraction helpers — extracted from blog.ts so they can be
 * unit-tested in plain Node (no Astro virtual-module dependency).
 *
 * Generates a balanced HTML fragment from rendered blog body content,
 * preserving inline formatting (bold/italic/code/links) while clipping at a
 * target visible-character budget.
 *
 * Pure standard library — no external HTML parser needed for this scope.
 */

/** Tags whose entire subtree we drop from the preview. */
const BLOCK_TAGS_TO_STRIP = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'figure',
  'img',
  'iframe',
  'video',
  'audio',
  'table',
  'aside',
  'nav',
  'footer',
])

/** Inline tags we keep verbatim in the preview. */
const INLINE_TAGS_TO_KEEP = new Set([
  'a',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'span',
  'mark',
  'small',
  'sup',
  'sub',
  'u',
  'del',
  'ins',
])

/** Block tags we treat as paragraph boundaries (kept as <p>). */
const PARAGRAPH_TAGS = new Set(['p', 'li', 'blockquote', 'div'])

/**
 * Extract the first ~`maxChars` visible characters of HTML body content as a
 * balanced HTML fragment, preserving inline formatting.
 *
 * @param html  Rendered HTML body (typically from `<Content />` SSR or a
 *              dedicated render pass).
 * @param maxChars  Approximate target length of visible (non-tag) text.
 * @returns      Balanced HTML fragment, or empty string if no usable text was found.
 */
export function extractRichPreview(html: string, maxChars = 220): string {
  if (!html) return ''

  const tokens = tokenizeHtml(html)
  const stack: string[] = []
  const out: string[] = []
  let visibleCount = 0
  let inSkipped = 0
  let skippedTag = ''
  let paragraphsEmitted = 0

  for (const tok of tokens) {
    // Hard stop: once we've hit the visible-char cap, drop everything except
    // close tags for already-open elements. This prevents trailing empty
    // <strong></strong>, <em></em>, <a></a> pairs from littering the preview.
    const capped = visibleCount >= maxChars

    if (tok.type === 'open') {
      if (capped) continue
      if (BLOCK_TAGS_TO_STRIP.has(tok.tag) || tok.tag === 'script' || tok.tag === 'style') {
        if (!tok.selfClosing) {
          inSkipped++
          if (!skippedTag) skippedTag = tok.tag
        }
        continue
      }
      if (inSkipped > 0) continue
      if (INLINE_TAGS_TO_KEEP.has(tok.tag)) {
        const attrs = filterAttrs(tok.tag, tok.attrs)
        out.push(`<${tok.tag}${attrs}>`)
        if (!tok.selfClosing) stack.push(tok.tag)
      } else if (PARAGRAPH_TAGS.has(tok.tag)) {
        if (paragraphsEmitted >= 3) continue
        out.push('<p>')
        stack.push('p')
      }
      continue
    }

    if (tok.type === 'close') {
      if (inSkipped > 0) {
        if (tok.tag === skippedTag) {
          inSkipped--
          if (inSkipped === 0) skippedTag = ''
        }
        continue
      }
      const target = stack.lastIndexOf(tok.tag === 'p' ? 'p' : tok.tag)
      if (target >= 0) {
        while (stack.length > target) {
          const t = stack.pop()!
          out.push(`</${t}>`)
          if (t === 'p') paragraphsEmitted++
        }
      }
      continue
    }

    if (tok.type === 'text') {
      if (inSkipped > 0) continue
      const remaining = maxChars - visibleCount
      if (remaining <= 0) continue
      const trimmed = tok.text.replace(/\s+/g, ' ')
      if (trimmed.length <= remaining) {
        out.push(escapeHtml(trimmed))
        visibleCount += trimmed.length
      } else {
        let cut = remaining
        const lastSpace = trimmed.lastIndexOf(' ', remaining)
        if (lastSpace >= remaining - 30 && lastSpace > 0) cut = lastSpace
        out.push(escapeHtml(trimmed.slice(0, cut)) + '…')
        visibleCount = maxChars
      }
    }
  }

  while (stack.length) {
    const t = stack.pop()!
    out.push(`</${t}>`)
    if (t === 'p') paragraphsEmitted++
  }

  return out
    .join('')
    .replace(/<p>\s*<\/p>/g, '')
    // Drop empty inline pairs introduced by truncation edge cases.
    .replace(/<(strong|em|b|i|code|span|mark|small|sup|sub|u|del|ins|a)\b[^>]*>\s*<\/\1>/g, '')
    .replace(/^<p>\s*$/, '')
    .trim()
}

/**
 * Render markdown source to a minimal HTML body — used as a fallback when
 * Astro's content-layer `rendered.html` isn't available (e.g. during a fresh
 * dev session). Handles paragraphs, **bold**, *italic*, `code`, and links.
 */
export function basicMarkdownToHtml(md: string): string {
  let s = md.replace(/^---[\s\S]*?\n---\s*\n/, '')
  s = s.replace(/```[\s\S]*?```/g, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  s = s.replace(/^#{1,6}\s.*$/gm, '')
  const paragraphs = s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return paragraphs.map((p) => `<p>${p.replace(/\n/g, ' ')}</p>`).join('\n')
}

/* --------------------------- internals --------------------------------- */

type Token =
  | { type: 'open'; tag: string; attrs: string; selfClosing: boolean }
  | { type: 'close'; tag: string }
  | { type: 'text'; text: string }

const TAG_REGEX = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g

function tokenizeHtml(html: string): Token[] {
  const tokens: Token[] = []
  let lastIndex = 0
  for (const match of html.matchAll(TAG_REGEX)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) {
      const text = decodeHtmlEntities(html.slice(lastIndex, idx))
      if (text) tokens.push({ type: 'text', text })
    }
    const full = match[0]
    const tag = match[1].toLowerCase()
    const isClose = full.startsWith('</')
    const selfClosing = full.endsWith('/>') || isVoidElement(tag)
    if (isClose) {
      tokens.push({ type: 'close', tag })
    } else {
      tokens.push({ type: 'open', tag, attrs: match[2] || '', selfClosing })
    }
    lastIndex = idx + full.length
  }
  if (lastIndex < html.length) {
    const text = decodeHtmlEntities(html.slice(lastIndex))
    if (text) tokens.push({ type: 'text', text })
  }
  return tokens
}

const VOID_ELEMENTS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'param',
  'source',
  'track',
  'wbr',
])

function isVoidElement(tag: string): boolean {
  return VOID_ELEMENTS.has(tag)
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ref) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const cp = parseInt(ref.slice(2), 16)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    if (ref.startsWith('#')) {
      const cp = parseInt(ref.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[ref] ?? m
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const HREF_RE = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i

function filterAttrs(tag: string, attrs: string): string {
  if (tag !== 'a') return ''
  const m = HREF_RE.exec(attrs)
  if (!m) return ''
  const href = (m[2] ?? m[3] ?? '').trim()
  if (!href) return ''
  if (!/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(href) || /^javascript:/i.test(href)) {
    return ''
  }
  return ` href="${escapeAttr(href)}" rel="noopener noreferrer"`
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;')
}
