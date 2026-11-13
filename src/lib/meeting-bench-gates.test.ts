import { describe, expect, it } from 'vitest'
import {
  assessCoverage,
  assessPromotionScope,
} from '../../scripts/meeting-bench/gates.mjs'

const complete = {
  smoke: false,
  groups: [4, 16],
  objectives: ['fair', 'total'],
  warmSamples: 100,
  warmLaunches: 3,
  coldSamples: 20,
}

function assess(overrides: Record<string, unknown> = {}) {
  return assessCoverage({ ...complete, ...overrides })
}

describe('assessCoverage promotion eligibility', () => {
  it('accepts exactly the minimum coverage', () => {
    expect(assess()).toEqual({ eligible: true, reasons: [] })
  })

  it('accepts extra groups/objectives in any order', () => {
    const result = assess({
      groups: [16, 8, 4, 2],
      objectives: ['total', 'other', 'fair'],
      warmSamples: 250,
      warmLaunches: 5,
      coldSamples: 40,
    })
    expect(result.eligible).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('accepts descending group order', () => {
    const result = assess({ groups: [16, 4] })
    expect(result.eligible).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('rejects smoke runs even with complete coverage', () => {
    const result = assess({ smoke: true })
    expect(result.eligible).toBe(false)
    expect(result.reasons).toContain('smoke')
  })

  it.each([
    ['missing-group-16', { groups: [4] }],
    ['missing-group-4', { groups: [16] }],
    ['missing-objective-total', { objectives: ['fair'] }],
    ['missing-objective-fair', { objectives: ['total'] }],
  ])('reports %s', (reason, overrides) => {
    const result = assess(overrides)
    expect(result.eligible).toBe(false)
    expect(result.reasons).toContain(reason)
  })

  it('does not report coverage reasons for coverage that is present', () => {
    const result = assess({ groups: [4], objectives: ['fair'] })
    expect(result.reasons).not.toContain('missing-group-4')
    expect(result.reasons).not.toContain('missing-objective-fair')
    expect(result.reasons).not.toContain('smoke')
  })

  it.each([
    ['warm-samples', { warmSamples: 99 }],
    ['warm-launches', { warmLaunches: 2 }],
    ['cold-samples', { coldSamples: 19 }],
  ])('rejects one below the threshold with %s', (reason, overrides) => {
    const result = assess(overrides)
    expect(result.eligible).toBe(false)
    expect(result.reasons).toEqual([reason])
  })

  it('rejects a required cross-product case with zero warm samples', () => {
    // Caller maps an absent (group, objective) case to a minimum of 0.
    const result = assess({ warmSamples: 0 })
    expect(result.eligible).toBe(false)
    expect(result.reasons).toContain('warm-samples')
  })

  it('emits every unmet semantic reason together', () => {
    const result = assess({
      smoke: true,
      groups: [],
      objectives: [],
      warmSamples: 0,
      warmLaunches: 0,
      coldSamples: 0,
    })
    expect(result.eligible).toBe(false)
    expect([...result.reasons].sort()).toEqual(
      [
        'smoke',
        'missing-group-4',
        'missing-group-16',
        'missing-objective-fair',
        'missing-objective-total',
        'warm-samples',
        'warm-launches',
        'cold-samples',
      ].sort(),
    )
  })

  it('reports independent shortfalls without masking each other', () => {
    const result = assess({ groups: [4], warmLaunches: 1, coldSamples: 5 })
    expect(result.eligible).toBe(false)
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'missing-group-16',
        'warm-launches',
        'cold-samples',
      ]),
    )
    expect(result.reasons).not.toContain('warm-samples')
  })
})

describe('assessCoverage invalid counts', () => {
  const badValues: [string, unknown][] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['fraction', 100.5],
    ['numeric string', '100'],
    ['unsafe integer', 2 ** 53],
  ]
  const fields = [
    ['warmSamples', 'warm-samples'],
    ['warmLaunches', 'warm-launches'],
    ['coldSamples', 'cold-samples'],
  ] as const

  for (const [field, thresholdReason] of fields) {
    it.each(badValues)(
      `${field} = %s is invalid, not eligible`,
      (_label, value) => {
        const result = assess({ [field]: value })
        expect(result.eligible).toBe(false)
        expect(result.reasons).toContain('invalid-counts')
        expect(result.reasons).not.toContain(thresholdReason)
      },
    )
  }

  it('does not let Infinity satisfy a threshold', () => {
    expect(assess({ warmSamples: Number.POSITIVE_INFINITY }).eligible).toBe(
      false,
    )
  })

  it('keeps other valid-field and coverage reasons alongside invalid-counts', () => {
    const result = assess({
      smoke: true,
      groups: [4],
      objectives: ['fair'],
      warmSamples: Number.NaN,
      warmLaunches: 2,
      coldSamples: 19,
    })
    expect(result.eligible).toBe(false)
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'invalid-counts',
        'smoke',
        'missing-group-16',
        'missing-objective-total',
        'warm-launches',
        'cold-samples',
      ]),
    )
    expect(result.reasons).not.toContain('warm-samples')
  })

  it('does not report invalid-counts for valid counts including zero', () => {
    const result = assess({ warmSamples: 0, warmLaunches: 0, coldSamples: 0 })
    expect(result.reasons).not.toContain('invalid-counts')
  })
})

describe('frozen promotion scope', () => {
  const primary = {
    fixtureSha256:
      '7558baa941100c83cca71059de9b5734bf87920e86680191e77e7b51d5d5369c',
    browser: 'chromium',
    profile: 'baseline',
    baselineEngine: 'scalar',
  }

  it('accepts the frozen fixture, browser, profile and selected baseline', () => {
    expect(assessPromotionScope(primary)).toEqual({
      eligible: true,
      reasons: [],
    })
  })

  const controls: [string, Partial<typeof primary>][] = [
    ['fixture-scope', { fixtureSha256: 'a'.repeat(64) }],
    ['browser-scope', { browser: 'firefox' }],
    ['browser-scope', { browser: 'webkit' }],
    ['profile-scope', { profile: 'cpu4' }],
    ['baseline-engine', { baselineEngine: 'current' }],
  ]
  it.each(controls)('keeps %s controls ineligible', (reason, override) => {
    expect(assessPromotionScope({ ...primary, ...override })).toEqual({
      eligible: false,
      reasons: [reason],
    })
  })

  it('reports every unsupported scope dimension without masking another', () => {
    expect(
      assessPromotionScope({
        fixtureSha256: 'a'.repeat(64),
        browser: 'firefox',
        profile: 'cpu4',
        baselineEngine: 'current',
      }),
    ).toEqual({
      eligible: false,
      reasons: [
        'fixture-scope',
        'browser-scope',
        'profile-scope',
        'baseline-engine',
      ],
    })
  })
})
