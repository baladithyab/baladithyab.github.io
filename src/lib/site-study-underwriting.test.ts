import { describe, expect, it } from 'vitest'
import {
  buildUnderwritingCsv,
  computeUnderwriting,
  defaultUnderwritingInputs,
} from './site-study-underwriting'

describe('real estate underwriting calculator', () => {
  it('computes deterministic PITI, NOI, Cap Rate, DSCR, and reverse target offer price', () => {
    const inputs = {
      ...defaultUnderwritingInputs(1_000_000, 5_500),
      downPaymentPct: 20,
      interestRatePct: 6.5,
      loanTermYears: 30,
      propertyTaxRatePct: 1.18,
      insuranceRatePct: 0.35,
      vacancyPct: 5,
      maintenancePct: 8,
      managementPct: 8,
      hoaMonthly: 0,
      closingCostsPct: 2.5,
      targetCashOnCashPct: 8,
    }
    const result = computeUnderwriting(inputs)
    expect(result.loanAmount).toBe(800_000)
    expect(result.totalCashInvested).toBe(225_000)
    expect(result.monthlyMortgagePI).toBeCloseTo(5056.54, 1)
    expect(result.effectiveGrossIncome).toBeCloseTo(62_700, 1)
    expect(result.annualNOI).toBeGreaterThan(35_000)
    expect(result.capRatePct).toBeCloseTo((result.annualNOI / 1_000_000) * 100, 4)
    expect(result.dscr).not.toBeNull()
    expect(result.targetOfferPrice).not.toBeNull()

    // Plugging the reverse target offer price back in must yield ~targetCashOnCashPct.
    const check = computeUnderwriting({
      ...inputs,
      askingPrice: result.targetOfferPrice!,
    })
    expect(check.cashOnCashPct).toBeCloseTo(inputs.targetCashOnCashPct, 1)
  })

  it('builds valid CSV export rows', () => {
    const inputs = defaultUnderwritingInputs(850_000, 4_000)
    const result = computeUnderwriting(inputs)
    const csv = buildUnderwritingCsv('200 E Santa Clara St, San Jose, CA', inputs, result)
    expect(csv).toContain('"200 E Santa Clara St, San Jose, CA"')
    expect(csv).toContain('Target Offer Price ($)')
  })
})
