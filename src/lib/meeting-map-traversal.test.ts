import { describe, expect, it } from 'vitest'
import {
  bucketTraversal,
  pickMarker,
  planTraversal,
  traversalCutoff,
  TRAVERSAL_STEPS,
  type TraversalBuckets,
  type TraversalPlan,
} from './meeting-map-traversal'

function bucket(
  distances: number[],
  edges: [number, number][],
  plan: TraversalPlan,
): TraversalBuckets {
  const from = Int32Array.from(edges.map(([a]) => a))
  const to = Int32Array.from(edges.map(([, b]) => b))
  const task = bucketTraversal(
    Float64Array.from(distances),
    from,
    to,
    plan,
    new Uint16Array(edges.length),
  )
  for (;;) {
    const step = task.next()
    if (step.done) return step.value
  }
}

// Edges painted for one candidate at one explored fraction.
function painted(
  buckets: TraversalBuckets,
  plan: TraversalPlan,
  longest: number,
  explored: number,
) {
  const end = buckets.offsets[traversalCutoff(plan, longest, explored)]
  return new Set(buckets.edges.slice(0, end))
}

describe('meeting map traversal buckets', () => {
  const longest = [400, 1200, 5000, 80]
  const distances = Array.from({ length: 60 }, (_, i) => i * 97)
  const edges = distances.slice(1).map((_, i): [number, number] => [i, i + 1])
  const plan = planTraversal(longest)
  const buckets = bucket(distances, edges, plan)

  it('keeps one bounded bucket set for every candidate', () => {
    expect(plan.count).toBeGreaterThan(0)
    expect(plan.count).toBeLessThanOrEqual(TRAVERSAL_STEPS * 4)
    expect(buckets.offsets).toHaveLength(plan.count + 1)
  })

  it('paints every edge a candidate cutoff covers, with at most one bucket of extra road', () => {
    for (const candidate of longest)
      for (const explored of [0, 0.1, 0.5, 0.99, 1]) {
        const step = Math.floor(explored * TRAVERSAL_STEPS)
        const cutoff = ((step + 1) * Math.max(candidate, 1)) / TRAVERSAL_STEPS
        const shown = painted(buckets, plan, candidate, explored)
        edges.forEach(([a, b], edge) => {
          const near = Math.min(distances[a], distances[b])
          if (near < cutoff) expect(shown.has(edge)).toBe(true)
          if (near >= cutoff + plan.width) expect(shown.has(edge)).toBe(false)
        })
      }
  })

  it('grows monotonically as exploration progresses and shrinks when seeking back', () => {
    let previous = -1
    for (let i = 0; i <= 50; i++) {
      const size = painted(buckets, plan, 1200, i / 50).size
      expect(size).toBeGreaterThanOrEqual(previous)
      previous = size
    }
    expect(painted(buckets, plan, 1200, 0.2).size).toBeLessThan(
      painted(buckets, plan, 1200, 0.9).size,
    )
  })

  it('selecting a farther candidate shows more of the same fixed buckets', () => {
    expect(painted(buckets, plan, 5000, 0.5).size).toBeGreaterThan(
      painted(buckets, plan, 400, 0.5).size,
    )
  })

  it('excludes unreachable roads', () => {
    const unreachable = bucket(
      [0, 50, Infinity, Infinity],
      [
        [0, 1],
        [2, 3],
      ],
      planTraversal([100]),
    )
    expect([...unreachable.edges]).toEqual([0])
  })

  it('handles zero and coincident starts', () => {
    const flat = planTraversal([0, 0])
    expect(flat.count).toBe(1)
    const grouped = bucket(
      [0, 0, 0],
      [
        [0, 1],
        [1, 2],
      ],
      flat,
    )
    expect(painted(grouped, flat, 0, 0)).toEqual(new Set([0, 1]))
    expect(planTraversal([])).toMatchObject({ count: 0 })
    expect(traversalCutoff(planTraversal([]), 100, 1)).toBe(0)
  })

  it('keeps small candidates detailed when another is much larger', () => {
    const mixed = planTraversal([2, 100_000])
    expect(mixed.count).toBeLessThanOrEqual(TRAVERSAL_STEPS * 4)
    expect(traversalCutoff(mixed, 2, 1)).toBeLessThanOrEqual(mixed.count)
  })
})

describe('meeting map marker picking', () => {
  it('picks the higher-painted visible marker over an earlier selected marker', () => {
    const points: [number, number][] = [
      [0, 0],
      [100, 100],
      [200, 200],
      [300, 300],
      [400, 400],
      [15.97695, 0],
    ]
    const results = points.map((_, node) => ({ node }))
    const place = (node: number) => points[node]

    // Candidate 6's center sits inside candidate 1's expanded padding.
    expect(pickMarker(results, place, 0, 1, 15.97695, 0)).toBe(5)
    // Both actual footprints cover this point; candidate 6 paints last.
    expect(pickMarker(results, place, 0, 1, 8, 0)).toBe(5)
    // The same candidate stays ineligible until its reveal opacity reaches 0.5.
    expect(pickMarker(results, place, 0, 0.74, 15.97695, 0)).toBe(0)
    expect(pickMarker(results, place, 0, 0.75, 15.97695, 0)).toBe(5)
  })

  it('prioritizes a visible stroke over later padding, then falls back to paint order', () => {
    const points: [number, number][] = [
      [0, 0],
      [25, 0],
    ]
    const results = points.map((_, node) => ({ node }))
    const place = (node: number) => points[node]

    // Inside the selected marker's outer stroke, but only the later one's padding.
    expect(pickMarker(results, place, 0, 1, 13.5, 0)).toBe(0)
    // Neither actual footprint covers the gap, so the later padding wins.
    expect(pickMarker(results, place, 0, 1, 14.5, 0)).toBe(1)
  })
})
