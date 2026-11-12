// The trail shows every road whose nearest-reached distance is below a moving
// cutoff. Buckets are in ABSOLUTE metres, shared by every candidate meeting
// spot, so choosing another result only moves the cutoff; it never regroups
// the graph's edges.
export const TRAVERSAL_STEPS = 180
const MAX_BUCKETS = TRAVERSAL_STEPS * 4
const UNREACHED = 0xffff
const CHUNK = 32768

export type TraversalPlan = {
  /** Metres covered by one bucket. */
  width: number
  /** Number of buckets; 0 when there are no candidates. */
  count: number
  /** Edges at or beyond this distance never appear for any candidate. */
  extent: number
}

/** Edge indices grouped by bucket: bucket k owns edges[offsets[k]..offsets[k+1]). */
export type TraversalBuckets = { offsets: Uint32Array; edges: Int32Array }

const span = (longest: number) => Math.max(longest, 1)

/**
 * One bucket size for every candidate: fine enough for the smallest positive
 * candidate's cutoff steps, never more than a few multiples of the playback
 * step count. Zero and coincident-start candidates share the 1 m floor used by
 * the playback cutoff.
 */
export function planTraversal(longest: readonly number[]): TraversalPlan {
  let largest = 0
  let smallest = Infinity
  for (const value of longest) {
    if (!Number.isFinite(value)) continue
    largest = Math.max(largest, span(value))
    if (value > 0) smallest = Math.min(smallest, span(value))
  }
  if (largest === 0) return { width: 1, count: 0, extent: 0 }
  const extent = (largest * (TRAVERSAL_STEPS + 1)) / TRAVERSAL_STEPS
  const finest = Number.isFinite(smallest)
    ? smallest / (TRAVERSAL_STEPS * 2)
    : extent
  const width = Math.max(extent / MAX_BUCKETS, finest)
  return {
    width,
    extent,
    count: Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(extent / width))),
  }
}

/**
 * Buckets to paint for a candidate at the given explored fraction: every bucket
 * that starts below the candidate's cutoff, so all edges the cutoff covers are
 * included and at most one bucket of extra road shows. Always at least one
 * bucket (the starts themselves) while any candidate exists.
 */
export function traversalCutoff(
  plan: TraversalPlan,
  longest: number,
  explored: number,
): number {
  if (plan.count === 0) return 0
  const step = Math.floor(Math.max(0, Math.min(1, explored)) * TRAVERSAL_STEPS)
  const cutoff = ((step + 1) * span(longest)) / TRAVERSAL_STEPS
  return Math.max(1, Math.min(plan.count, Math.ceil(cutoff / plan.width)))
}

/**
 * Counting-sorts one source's edges by their nearer endpoint's distance. Yields
 * between chunks so callers can frame-budget it; `scratch` must hold one entry
 * per edge and may be reused across sources.
 */
export function* bucketTraversal(
  distances: Float64Array,
  from: Int32Array,
  to: Int32Array,
  plan: TraversalPlan,
  scratch: Uint16Array,
): Generator<void, TraversalBuckets, void> {
  const total = from.length
  const offsets = new Uint32Array(plan.count + 1)
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(total, start + CHUNK)
    for (let edge = start; edge < end; edge++) {
      const near = Math.min(distances[from[edge]], distances[to[edge]])
      if (near < plan.extent) {
        const bucket = Math.min(plan.count - 1, Math.floor(near / plan.width))
        scratch[edge] = bucket
        offsets[bucket + 1]++
      } else scratch[edge] = UNREACHED
    }
    yield
  }
  for (let bucket = 0; bucket < plan.count; bucket++)
    offsets[bucket + 1] += offsets[bucket]
  const edges = new Int32Array(offsets[plan.count])
  const next = offsets.slice(0, plan.count)
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(total, start + CHUNK)
    for (let edge = start; edge < end; edge++) {
      const bucket = scratch[edge]
      if (bucket !== UNREACHED) edges[next[bucket]++] = edge
    }
    yield
  }
  return { offsets, edges }
}
