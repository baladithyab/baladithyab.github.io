/**
 * The longest single element (in UTF-16 code units) accepted from the road
 * provider. A real way is at most tens of kilobytes; this stops one endless
 * string from exhausting memory.
 */
const MAX_ELEMENT_CHARS = 1 << 20
/** Overpass puts a few hundred bytes around its `elements` array. */
const MAX_OUTSIDE_CHARS = 64 * 1024

const invalidJson =
  'The road provider returned invalid or incomplete JSON. Choose a smaller study area or try again later.'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d

function whitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09
}

/** Where the reader is: outside the elements array, between elements, or inside one. */
const OUTSIDE = 0
const BETWEEN = 1
const INSIDE = 2

/**
 * Splits a streamed Overpass JSON response into its top-level `elements`
 * without holding the whole text or the whole array. Each element is parsed on
 * its own and handed to `onElement` as soon as its last byte arrives. Text
 * outside the array (header and trailer) is kept, bounded, and parsed by
 * `end()` with the array replaced by `[]`, so a trailing `remark` is seen.
 * Works for any valid JSON layout and any chunk boundaries.
 */
export class OverpassElementReader {
  #onElement: (element: unknown) => void
  // Fatal: a corrupt byte fails the load instead of becoming U+FFFD in a cached name.
  #decoder = new TextDecoder('utf-8', { fatal: true })
  #mode = OUTSIDE
  #outside = ''
  #sawElements = false
  // Outside the array: nesting depth and string state of the top-level text.
  #depth = 0
  #inString = false
  #escaped = false
  #topIsObject = false
  /** Last structural character directly inside the top-level object. */
  #previous = 0
  /** Offset in `#outside` of a top-level key being read, or -1. */
  #keyStart = -1
  #key: string | undefined
  #afterColon = false
  // Between elements.
  #expectElement = true
  #mayClose = true
  // Inside one element.
  #pieces: string[] = []
  #length = 0
  #primitive = false
  #elementDepth = 0
  #elementInString = false
  #elementEscaped = false

  constructor(onElement: (element: unknown) => void) {
    this.#onElement = onElement
  }

  write(chunk: Uint8Array): void {
    this.#scan(this.#decode(chunk))
  }

  /** Checks the response is complete and returns its top level with `elements` emptied. */
  end(): unknown {
    this.#scan(this.#decode())
    if (this.#mode !== OUTSIDE) throw new Error(invalidJson)
    try {
      return JSON.parse(this.#outside)
    } catch {
      throw new Error(invalidJson)
    }
  }

  /** Decodes `chunk`, or flushes the decoder at the end when there is none. */
  #decode(chunk?: Uint8Array): string {
    try {
      return chunk
        ? this.#decoder.decode(chunk, { stream: true })
        : this.#decoder.decode()
    } catch (error) {
      if (error instanceof TypeError) throw new Error(invalidJson)
      throw error
    }
  }

  #scan(text: string): void {
    let at = 0
    while (at < text.length) {
      if (this.#mode === INSIDE) at = this.#scanElement(text, at)
      else if (this.#mode === BETWEEN) at = this.#scanBetween(text, at)
      else at = this.#scanOutside(text, at)
    }
  }

  #keep(text: string): void {
    this.#outside += text
    if (this.#outside.length > MAX_OUTSIDE_CHARS)
      throw new Error(
        'The road provider sent something other than road data. Try loading the area again later.',
      )
  }

  #scanOutside(text: string, from: number): number {
    let depth = this.#depth
    let inString = this.#inString
    let escaped = this.#escaped
    try {
      for (let i = from; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (inString) {
          if (escaped) escaped = false
          else if (code === BACKSLASH) escaped = true
          else if (code === QUOTE) {
            inString = false
            if (this.#keyStart >= 0) {
              const raw = (this.#outside + text.slice(from, i + 1)).slice(
                this.#keyStart,
              )
              this.#keyStart = -1
              try {
                this.#key = raw.length <= 64 ? JSON.parse(raw) : undefined
              } catch {
                this.#key = undefined
              }
            }
          }
          continue
        }
        if (whitespace(code)) continue
        if (depth === 1 && this.#topIsObject) {
          if (this.#afterColon) {
            this.#afterColon = false
            if (code === OPEN_BRACKET && this.#key === 'elements') {
              if (this.#sawElements) throw new Error(invalidJson)
              this.#sawElements = true
              this.#keep(text.slice(from, i + 1))
              this.#mode = BETWEEN
              this.#expectElement = true
              this.#mayClose = true
              return i + 1
            }
          }
          if (code === QUOTE)
            this.#keyStart =
              this.#previous === OPEN_BRACE || this.#previous === COMMA
                ? this.#outside.length + i - from
                : -1
          else if (code === COLON) this.#afterColon = true
          this.#previous = code
        } else if (depth === 0 && code === OPEN_BRACE) {
          this.#topIsObject = true
          this.#previous = code
        }
        if (code === QUOTE) inString = true
        else if (code === OPEN_BRACE || code === OPEN_BRACKET) depth++
        else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) depth--
      }
      this.#keep(text.slice(from))
      return text.length
    } finally {
      this.#depth = depth
      this.#inString = inString
      this.#escaped = escaped
    }
  }

  #scanBetween(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (whitespace(code)) continue
      if (code === CLOSE_BRACKET) {
        if (!this.#mayClose) throw new Error(invalidJson)
        this.#keep(']')
        this.#mode = OUTSIDE
        return i + 1
      }
      if (code === COMMA) {
        if (this.#expectElement) throw new Error(invalidJson)
        this.#expectElement = true
        this.#mayClose = false
        continue
      }
      if (!this.#expectElement) throw new Error(invalidJson)
      this.#mode = INSIDE
      this.#primitive =
        code !== OPEN_BRACE && code !== OPEN_BRACKET && code !== QUOTE
      this.#elementDepth = 0
      this.#elementInString = false
      this.#elementEscaped = false
      return i
    }
    return text.length
  }

  #scanElement(text: string, from: number): number {
    let end = -1
    let next = text.length
    if (this.#primitive) {
      // Numbers and literals end at the next delimiter, which stays unread.
      for (let i = from; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code === COMMA || code === CLOSE_BRACKET || whitespace(code)) {
          end = next = i
          break
        }
      }
    } else {
      let depth = this.#elementDepth
      let inString = this.#elementInString
      let escaped = this.#elementEscaped
      for (let i = from; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (inString) {
          if (escaped) escaped = false
          else if (code === BACKSLASH) escaped = true
          else if (code === QUOTE) {
            inString = false
            if (depth === 0) {
              end = next = i + 1
              break
            }
          }
        } else if (code === QUOTE) inString = true
        else if (code === OPEN_BRACE || code === OPEN_BRACKET) depth++
        else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
          if (--depth === 0) {
            end = next = i + 1
            break
          }
        }
      }
      this.#elementDepth = depth
      this.#elementInString = inString
      this.#elementEscaped = escaped
    }
    const piece = text.slice(from, end < 0 ? text.length : end)
    this.#length += piece.length
    if (this.#length > MAX_ELEMENT_CHARS)
      throw new Error(
        'The road provider sent an oversized road element. Try loading the area again later.',
      )
    if (end < 0) {
      this.#pieces.push(piece)
      return next
    }
    const source = this.#pieces.length ? this.#pieces.join('') + piece : piece
    this.#pieces = []
    this.#length = 0
    let element: unknown
    try {
      element = JSON.parse(source)
    } catch {
      throw new Error(invalidJson)
    }
    this.#mode = BETWEEN
    this.#expectElement = false
    this.#mayClose = true
    this.#onElement(element)
    return next
  }
}
