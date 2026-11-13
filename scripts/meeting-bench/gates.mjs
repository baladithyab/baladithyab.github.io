// Counts are completed minima across every required group/objective case and
// engine, not requested sample counts. Missing cases must contribute zero.
export function assessCoverage({
  smoke,
  groups,
  objectives,
  warmSamples,
  warmLaunches,
  coldSamples,
}) {
  const reasons = []
  if (smoke) reasons.push('smoke')
  for (const size of [4, 16])
    if (!groups.includes(size)) reasons.push(`missing-group-${size}`)
  for (const objective of ['fair', 'total'])
    if (!objectives.includes(objective))
      reasons.push(`missing-objective-${objective}`)
  let invalidCounts = false
  for (const [count, minimum, reason] of [
    [warmSamples, 100, 'warm-samples'],
    [warmLaunches, 3, 'warm-launches'],
    [coldSamples, 20, 'cold-samples'],
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) invalidCounts = true
    else if (count < minimum) reasons.push(reason)
  }
  if (invalidCounts) reasons.push('invalid-counts')
  return { eligible: reasons.length === 0, reasons }
}
