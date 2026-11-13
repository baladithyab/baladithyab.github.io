// Complete-output fingerprints for meeting-session search replies, used for
// cross-engine parity outside measured intervals. Tree views are digested in
// place over their own byteOffset/byteLength, one view at a time, so origin-major
// subviews of a shared buffer hash like owned buffers and nothing is copied or
// kept. Metadata uses a canonical binary encoding (sorted object keys, exact
// UTF-16 code units, IEEE-754 bit patterns), so property insertion order cannot
// matter and Infinity, NaN and null stay distinct where JSON would collapse them.

export const OUTPUT_FINGERPRINT_SCHEME = 'sha256/meeting-output-v1'
export const OUTPUT_FINGERPRINT_PARTS = /** @type {const} */ ([
  'request',
  'shape',
  'distances',
  'parents',
  'results',
  'collisions',
])

/**
 * @typedef {(typeof OUTPUT_FINGERPRINT_PARTS)[number]} OutputPart
 * @typedef {{
 *   scheme: string
 *   digest: string
 *   parts: Record<OutputPart, string>
 *   originCount: number
 *   treeCount: number
 *   resultCount: number | null
 *   collisionCount: number | null
 *   viewBytes: number
 * }} OutputFingerprint
 */

const NULL = 0
const UNDEFINED = 1
const FALSE = 2
const TRUE = 3
const NUMBER = 4
const STRING = 5
const ARRAY = 6
const OBJECT = 7

class Encoder {
  bytes = new Uint8Array(256)
  view = new DataView(this.bytes.buffer)
  length = 0

  /** @param {number} count */
  reserve(count) {
    const needed = this.length + count
    if (needed <= this.bytes.length) return
    let size = this.bytes.length * 2
    while (size < needed) size *= 2
    const next = new Uint8Array(size)
    next.set(this.bytes.subarray(0, this.length))
    this.bytes = next
    this.view = new DataView(next.buffer)
  }

  /** @param {number} tag */
  tag(tag) {
    this.reserve(1)
    this.bytes[this.length++] = tag
  }

  /** @param {number} value */
  u32(value) {
    this.reserve(4)
    this.view.setUint32(this.length, value)
    this.length += 4
  }

  /** @param {number} value */
  f64(value) {
    this.reserve(8)
    this.view.setFloat64(this.length, value)
    this.length += 8
  }

  /** @param {string} value */
  string(value) {
    this.u32(value.length)
    this.reserve(value.length * 2)
    for (let i = 0; i < value.length; i++) {
      this.view.setUint16(this.length, value.charCodeAt(i))
      this.length += 2
    }
  }

  /** @param {Uint8Array} bytes */
  raw(bytes) {
    this.reserve(bytes.length)
    this.bytes.set(bytes, this.length)
    this.length += bytes.length
  }

  /** @param {unknown} value */
  value(value) {
    if (value === null) this.tag(NULL)
    else if (value === undefined) this.tag(UNDEFINED)
    else if (typeof value === 'boolean') this.tag(value ? TRUE : FALSE)
    else if (typeof value === 'number') {
      this.tag(NUMBER)
      this.f64(value)
    } else if (typeof value === 'string') {
      this.tag(STRING)
      this.string(value)
    } else if (Array.isArray(value)) {
      this.tag(ARRAY)
      this.u32(value.length)
      for (let i = 0; i < value.length; i++) this.value(value[i])
    } else if (
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    ) {
      const keys = Object.keys(value).sort()
      this.tag(OBJECT)
      this.u32(keys.length)
      for (const key of keys) {
        this.string(key)
        this.value(/** @type {Record<string, unknown>} */ (value)[key])
      }
    } else
      throw new TypeError(
        `Unsupported search-output metadata value: ${Object.prototype.toString.call(value)}`,
      )
  }

  finish() {
    return this.bytes.subarray(0, this.length)
  }
}

/** @param {Uint8Array} bytes */
const hex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * @param {SubtleCrypto} subtle
 * @param {BufferSource} data
 */
async function sha256(subtle, data) {
  return new Uint8Array(await subtle.digest('SHA-256', data))
}

/**
 * @param {SubtleCrypto} subtle
 * @param {unknown} value
 */
async function canonicalDigest(subtle, value) {
  const encoder = new Encoder()
  encoder.value(value)
  return hex(await sha256(subtle, encoder.finish()))
}

/**
 * Digests every tree's `field` view bytes, including unreachable sentinels,
 * sequentially so at most one digest input is in flight.
 * @param {SubtleCrypto} subtle
 * @param {readonly unknown[]} trees
 * @param {'distances' | 'parents'} field
 * @param {Float64ArrayConstructor | Int32ArrayConstructor} Type
 */
async function viewDigest(subtle, trees, field, Type) {
  const encoder = new Encoder()
  encoder.string(field)
  encoder.u32(trees.length)
  const lengths = []
  let bytes = 0
  for (let index = 0; index < trees.length; index++) {
    const tree = trees[index]
    const view =
      typeof tree === 'object' && tree !== null
        ? /** @type {Record<string, unknown>} */ (tree)[field]
        : undefined
    if (!(view instanceof Type))
      throw new TypeError(`Search tree ${index} ${field} is not a ${Type.name}`)
    encoder.raw(
      await sha256(
        subtle,
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    )
    lengths.push(view.length)
    bytes += view.byteLength
  }
  return { digest: hex(await sha256(subtle, encoder.finish())), lengths, bytes }
}

/**
 * @param {{
 *   origins: readonly number[]
 *   objective: string
 *   output: { trees: readonly unknown[]; results: unknown }
 *   collisions: unknown
 * }} reply posted origins/objective plus the matched worker result reply
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<OutputFingerprint>}
 */
export async function fingerprintSearchOutput(
  { origins, objective, output, collisions },
  subtle = globalThis.crypto.subtle,
) {
  const { trees, results } = output
  if (!Array.isArray(trees))
    throw new TypeError('Search output trees must be an array')
  const distances = await viewDigest(subtle, trees, 'distances', Float64Array)
  const parents = await viewDigest(subtle, trees, 'parents', Int32Array)
  /** @type {Record<OutputPart, string>} */
  const parts = {
    request: await canonicalDigest(subtle, { origins, objective }),
    shape: await canonicalDigest(subtle, {
      originCount: origins.length,
      treeCount: trees.length,
      distances: distances.lengths,
      parents: parents.lengths,
    }),
    distances: distances.digest,
    parents: parents.digest,
    results: await canonicalDigest(subtle, results),
    collisions: await canonicalDigest(subtle, collisions),
  }
  const encoder = new Encoder()
  encoder.string(OUTPUT_FINGERPRINT_SCHEME)
  for (const part of OUTPUT_FINGERPRINT_PARTS) {
    encoder.string(part)
    encoder.string(parts[part])
  }
  return {
    scheme: OUTPUT_FINGERPRINT_SCHEME,
    digest: hex(await sha256(subtle, encoder.finish())),
    parts,
    originCount: origins.length,
    treeCount: trees.length,
    resultCount: Array.isArray(results) ? results.length : null,
    collisionCount: Array.isArray(collisions) ? collisions.length : null,
    viewBytes: distances.bytes + parents.bytes,
  }
}

/**
 * Output parts that differ from the reference; empty only for complete equality.
 * @param {OutputFingerprint | null | undefined} reference
 * @param {OutputFingerprint | null | undefined} candidate
 * @returns {string[]}
 */
export function outputDifferences(reference, candidate) {
  if (!reference || !candidate) return ['missing-fingerprint']
  if (reference.scheme !== candidate.scheme) return ['scheme']
  const differences = OUTPUT_FINGERPRINT_PARTS.filter(
    (part) => reference.parts[part] !== candidate.parts[part],
  )
  return differences.length || reference.digest === candidate.digest
    ? differences
    : ['digest']
}
