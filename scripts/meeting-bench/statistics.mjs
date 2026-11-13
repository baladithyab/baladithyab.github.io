/** Conventional median and nearest-rank p95; never substitute missing timings. */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0)
    throw new Error('Cannot summarize an empty sample set.')
  for (const value of samples) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Samples must contain only finite numbers.')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  let median = sorted[middle]
  if (sorted.length % 2 === 0) {
    const lower = sorted[middle - 1]
    const sum = lower + median
    median = Number.isFinite(sum) ? sum / 2 : lower / 2 + median / 2
  }
  return {
    median,
    p95: sorted[Math.ceil(0.95 * sorted.length) - 1],
  }
}

/** Chronological, non-overlapping windows; never manufacture drift for smoke runs. */
export function summarizeDrift(samples) {
  summarize(samples)
  if (samples.length < 20)
    return {
      status: 'unavailable',
      reason:
        'Requires at least 20 measured samples for disjoint first-10/last-10 windows.',
    }
  const first10 = summarize(samples.slice(0, 10))
  const last10 = summarize(samples.slice(-10))
  const medianDelta = last10.median - first10.median
  return {
    status: 'available',
    first10,
    last10,
    medianDelta,
    medianChangePercent:
      first10.median === 0 ? null : (medianDelta / first10.median) * 100,
    percentUnavailableReason:
      first10.median === 0 ? 'First-10 median is zero.' : null,
  }
}
