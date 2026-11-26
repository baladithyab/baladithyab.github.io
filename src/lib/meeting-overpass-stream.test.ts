import { describe, expect, it } from 'vitest'
import { readOverpassEnvelope } from './meeting-network'
import { OverpassElementReader } from './meeting-overpass-stream'

const encoder = new TextEncoder()

/** Streams `chunks` through a reader and checks the top level like the loader does. */
function read(chunks: Uint8Array[]) {
  const elements: unknown[] = []
  const reader = new OverpassElementReader((element) => elements.push(element))
  for (const chunk of chunks) reader.write(chunk)
  return { elements, envelope: readOverpassEnvelope(reader.end()) }
}

const whole = (text: string) => [encoder.encode(text)]

/** Splits `bytes` at every given offset, including inside multi-byte characters. */
function split(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let from = 0
  for (const offset of offsets) {
    chunks.push(bytes.slice(from, offset))
    from = offset
  }
  chunks.push(bytes.slice(from))
  return chunks
}

const elements = [
  {
    type: 'way',
    id: 101,
    nodes: [1, 2],
    tags: {
      highway: 'residential',
      name: 'Say "Hi" Street \\ {Main} [North] Ñandú 🚶',
    },
  },
  { type: 'node', id: 1, lat: -37.5, lon: 1.25e-3 },
  { type: 'node', id: 2, lat: 0, lon: -122.4194155 },
]
const header = {
  version: 0.6,
  generator: 'Overpass API 0.7.62.11 87bfad18',
  osm3s: { copyright: 'Data {from} [OpenStreetMap] "contributors"' },
}
const pretty = JSON.stringify({ ...header, elements }, null, 2)
const compact = JSON.stringify({ ...header, elements })

describe('streaming Overpass reader', () => {
  it('reads pretty-printed and compact layouts as the same elements', () => {
    expect(read(whole(pretty)).elements).toEqual(elements)
    expect(read(whole(compact)).elements).toEqual(elements)
    expect(read(whole(` \n\t${compact}\r\n `)).elements).toEqual(elements)
  })

  it('gives the same elements for every chunk split, including inside escapes and multi-byte characters', () => {
    // Escapes and \u sequences as written by other JSON producers.
    const text = compact.replace('Ñandú', '\\u00d1and\\u00fa')
    const bytes = encoder.encode(text)
    for (let at = 0; at <= bytes.length; at++)
      expect(read(split(bytes, [at])).elements).toEqual(elements)
    expect(
      read(
        split(
          bytes,
          Array.from({ length: bytes.length }, (_, i) => i),
        ),
      ).elements,
    ).toEqual(elements)
    const prettyBytes = encoder.encode(pretty)
    for (let at = 0; at <= prettyBytes.length; at += 7)
      for (let next = at; next <= prettyBytes.length; next += 5)
        expect(read(split(prettyBytes, [at, next])).elements).toEqual(elements)
  })

  it('emits nested, string and number elements and ignores "elements" keys below the top level', () => {
    const text =
      '{"osm3s":{"elements":[9]},"elements":[{"a":[1,[2]]},[3],"s]",-1.5e3,true,null] ,"x":"elements"}'
    for (let at = 0; at <= text.length; at++)
      expect(read(split(encoder.encode(text), [at])).elements).toEqual([
        { a: [1, [2]] },
        [3],
        's]',
        -1500,
        true,
        null,
      ])
  })

  it('reports a trailing remark even though it arrives after the elements', () => {
    const remark =
      'runtime error: Query timed out in "query" at line 1 after 61 seconds.'
    const result = read(
      whole(JSON.stringify({ ...header, elements, remark }, null, 2)),
    )
    expect(result.elements).toEqual(elements)
    expect(result.envelope.remark).toBe(remark)
    expect(
      read(whole(JSON.stringify({ elements: [], error: 'out of memory' })))
        .envelope.remark,
    ).toBe('out of memory')
    expect(read(whole(compact)).envelope.remark).toBeUndefined()
  })

  it('rejects input cut off anywhere before the final brace', () => {
    const bytes = encoder.encode(pretty.trimEnd())
    for (let length = 0; length < bytes.length; length++)
      expect(() => read([bytes.slice(0, length)])).toThrow(Error)
  })

  it.each([
    ['an HTML error page', '<html><body>Gateway Timeout</body></html>'],
    ['an empty body', ''],
    ['a trailing comma', '{"elements":[{"type":"node"},]}'],
    ['a missing comma', '{"elements":[{"type":"node"} {"type":"node"}]}'],
    ['a broken element', '{"elements":[{"type":"node",}]}'],
    ['text after the document', '{"elements":[]} trailing'],
    ['a repeated elements array', '{"elements":[],"elements":[]}'],
    ['a top-level array', '[{"type":"node"}]'],
    ['no elements array', '{"version":0.6,"generator":"Overpass API"}'],
    ['elements that are not an array', '{"elements":{"type":"node"}}'],
  ])('rejects %s', (_case, text) => {
    expect(() => read(whole(text))).toThrow(Error)
  })

  it('rejects bytes that are not valid UTF-8 instead of replacing them', () => {
    const bytes = new Uint8Array([
      ...encoder.encode(
        '{"elements":[{"type":"way","id":1,"tags":{"name":"caf',
      ),
      0xe9,
      ...encoder.encode('"}}]}'),
    ])
    const bad = bytes.indexOf(0xe9)
    for (const chunks of [
      [bytes],
      split(bytes, [bad]),
      split(bytes, [bad + 1]),
    ])
      expect(() => read(chunks)).toThrow(
        'The road provider returned invalid or incomplete JSON.',
      )
  })

  it('rejects oversized text outside the elements and an oversized single element', () => {
    const padding = 'x'.repeat(1024 * 1024)
    expect(() =>
      read(whole(`{"generator":"${padding}","elements":[]}`)),
    ).toThrow(Error)
    expect(() => read(whole(`{"elements":[],"remark":"${padding}"}`))).toThrow(
      Error,
    )
    expect(() =>
      read(
        whole(
          `{"elements":[{"type":"node","id":1,"x":"${padding.repeat(2)}"}]}`,
        ),
      ),
    ).toThrow(Error)
  })

  it('does not keep whitespace between elements, however long', () => {
    const gap = new Uint8Array(1024 * 1024).fill(0x20)
    const chunks = [encoder.encode('{"elements":[')]
    for (const [i, element] of elements.entries()) {
      chunks.push(encoder.encode((i ? ',' : '') + JSON.stringify(element)))
      for (let j = 0; j < 8; j++) chunks.push(gap)
    }
    chunks.push(encoder.encode(']}'))
    expect(read(chunks).elements).toEqual(elements)
  })
})
