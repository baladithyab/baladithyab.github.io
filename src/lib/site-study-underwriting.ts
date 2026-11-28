export interface UnderwritingInputs {
  askingPrice: number
  monthlyRent: number
  downPaymentPct: number
  interestRatePct: number
  loanTermYears: number
  propertyTaxRatePct: number
  insuranceRatePct: number
  vacancyPct: number
  maintenancePct: number
  managementPct: number
  hoaMonthly: number
  closingCostsPct: number
  targetCashOnCashPct: number
}

export interface UnderwritingResult {
  loanAmount: number
  downPayment: number
  closingCosts: number
  totalCashInvested: number
  monthlyMortgagePI: number
  monthlyPropertyTax: number
  monthlyInsurance: number
  monthlyPITI: number
  grossAnnualRent: number
  effectiveGrossIncome: number
  annualOperatingExpenses: number
  annualNOI: number
  annualDebtService: number
  annualCashFlow: number
  monthlyCashFlow: number
  capRatePct: number
  cashOnCashPct: number
  dscr: number | null
  targetOfferPrice: number | null
  targetOfferDelta: number | null
  targetOfferDeltaPct: number | null
}

export function defaultUnderwritingInputs(
  askingPrice: number | null,
  monthlyRent?: number | null,
  tractMedianHomeValue?: number | null,
): UnderwritingInputs {
  const price =
    askingPrice && askingPrice > 0
      ? askingPrice
      : tractMedianHomeValue && tractMedianHomeValue > 0
        ? tractMedianHomeValue
        : 1_000_000
  // Conservative San José gross rent heuristic (~0.42% monthly of purchase price) when no rent comp is supplied.
  const rent =
    monthlyRent && monthlyRent > 0
      ? monthlyRent
      : Math.round((price * 0.0042) / 50) * 50
  return {
    askingPrice: price,
    monthlyRent: rent,
    downPaymentPct: 20,
    interestRatePct: 6.5,
    loanTermYears: 30,
    propertyTaxRatePct: 1.18,
    insuranceRatePct: 0.35,
    vacancyPct: 5,
    maintenancePct: 8,
    managementPct: 0,
    hoaMonthly: 0,
    closingCostsPct: 2.5,
    targetCashOnCashPct: 6,
  }
}

/** Monthly principal & interest payment factor per $1 of loan. */
export function monthlyMortgageFactor(
  annualRatePct: number,
  termYears: number,
): number {
  const n = Math.max(1, Math.round(termYears * 12))
  const r = Math.max(0, annualRatePct) / 100 / 12
  if (r === 0) return 1 / n
  const factor = Math.pow(1 + r, n)
  return (r * factor) / (factor - 1)
}

export function computeUnderwriting(
  inputs: UnderwritingInputs,
): UnderwritingResult {
  const price = Math.max(0, inputs.askingPrice)
  const downFrac = Math.min(1, Math.max(0, inputs.downPaymentPct / 100))
  const ltv = 1 - downFrac
  const closingFrac = Math.max(0, inputs.closingCostsPct / 100)
  const taxFrac = Math.max(0, inputs.propertyTaxRatePct / 100)
  const insFrac = Math.max(0, inputs.insuranceRatePct / 100)
  const vacFrac = Math.min(0.95, Math.max(0, inputs.vacancyPct / 100))
  const maintFrac = Math.max(0, inputs.maintenancePct / 100)
  const mgmtFrac = Math.max(0, inputs.managementPct / 100)
  const annualHoa = Math.max(0, inputs.hoaMonthly) * 12

  const loanAmount = price * ltv
  const downPayment = price * downFrac
  const closingCosts = price * closingFrac
  const totalCashInvested = downPayment + closingCosts

  const mFactor = monthlyMortgageFactor(
    inputs.interestRatePct,
    inputs.loanTermYears,
  )
  const annualDebtFactor = mFactor * 12
  const monthlyMortgagePI = loanAmount * mFactor
  const annualDebtService = loanAmount * annualDebtFactor

  const annualPropertyTax = price * taxFrac
  const annualInsurance = price * insFrac
  const monthlyPropertyTax = annualPropertyTax / 12
  const monthlyInsurance = annualInsurance / 12
  const monthlyPITI =
    monthlyMortgagePI + monthlyPropertyTax + monthlyInsurance + inputs.hoaMonthly

  const grossAnnualRent = Math.max(0, inputs.monthlyRent) * 12
  const effectiveGrossIncome = grossAnnualRent * (1 - vacFrac)
  const variableOpEx = effectiveGrossIncome * (maintFrac + mgmtFrac)
  const annualOperatingExpenses =
    annualPropertyTax + annualInsurance + annualHoa + variableOpEx

  const annualNOI = effectiveGrossIncome - annualOperatingExpenses
  const annualCashFlow = annualNOI - annualDebtService
  const monthlyCashFlow = annualCashFlow / 12

  const capRatePct = price > 0 ? (annualNOI / price) * 100 : 0
  const cashOnCashPct =
    totalCashInvested > 0 ? (annualCashFlow / totalCashInvested) * 100 : 0
  const dscr = annualDebtService > 0 ? annualNOI / annualDebtService : null

  // Closed-form reverse target offer price solving:
  // (EGI - variableOpEx - annualHoa - P*(taxFrac + insFrac + ltv*annualDebtFactor)) / (P*(downFrac + closingFrac)) = targetCoC
  // => P = (EGI - variableOpEx - annualHoa) / (taxFrac + insFrac + ltv*annualDebtFactor + targetCoC*(downFrac + closingFrac))
  const netRentBeforePriceCosts =
    effectiveGrossIncome - variableOpEx - annualHoa
  const targetFrac = inputs.targetCashOnCashPct / 100
  const denominator =
    taxFrac +
    insFrac +
    ltv * annualDebtFactor +
    targetFrac * (downFrac + closingFrac)

  const targetOfferPrice =
    netRentBeforePriceCosts > 0 && denominator > 0
      ? Math.round(netRentBeforePriceCosts / denominator)
      : null
  const targetOfferDelta =
    targetOfferPrice !== null && price > 0 ? targetOfferPrice - price : null
  const targetOfferDeltaPct =
    targetOfferDelta !== null && price > 0
      ? (targetOfferDelta / price) * 100
      : null

  return {
    loanAmount,
    downPayment,
    closingCosts,
    totalCashInvested,
    monthlyMortgagePI,
    monthlyPropertyTax,
    monthlyInsurance,
    monthlyPITI,
    grossAnnualRent,
    effectiveGrossIncome,
    annualOperatingExpenses,
    annualNOI,
    annualDebtService,
    annualCashFlow,
    monthlyCashFlow,
    capRatePct,
    cashOnCashPct,
    dscr,
    targetOfferPrice,
    targetOfferDelta,
    targetOfferDeltaPct,
  }
}

export function buildUnderwritingCsv(
  address: string,
  inputs: UnderwritingInputs,
  result: UnderwritingResult,
): string {
  const esc = (v: string | number | null) => {
    const str = v === null ? 'N/A' : String(v)
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
  }
  const rows: [string, string | number | null][] = [
    ['Property Address', address],
    ['Asking Price ($)', Math.round(inputs.askingPrice)],
    ['Estimated Monthly Rent ($)', Math.round(inputs.monthlyRent)],
    ['Down Payment (%)', inputs.downPaymentPct],
    ['Interest Rate (%)', inputs.interestRatePct],
    ['Loan Term (Years)', inputs.loanTermYears],
    ['Property Tax Rate (%)', inputs.propertyTaxRatePct],
    ['Insurance Rate (%)', inputs.insuranceRatePct],
    ['Vacancy (%)', inputs.vacancyPct],
    ['Maintenance (%)', inputs.maintenancePct],
    ['Management (%)', inputs.managementPct],
    ['HOA Monthly ($)', inputs.hoaMonthly],
    ['Closing Costs (%)', inputs.closingCostsPct],
    ['---', '---'],
    ['Loan Amount ($)', Math.round(result.loanAmount)],
    ['Total Cash Invested ($)', Math.round(result.totalCashInvested)],
    ['Monthly Mortgage P&I ($)', Math.round(result.monthlyMortgagePI)],
    ['Monthly Property Tax ($)', Math.round(result.monthlyPropertyTax)],
    ['Monthly Insurance ($)', Math.round(result.monthlyInsurance)],
    ['Total Monthly PITI + HOA ($)', Math.round(result.monthlyPITI)],
    ['Effective Gross Income ($/yr)', Math.round(result.effectiveGrossIncome)],
    ['Operating Expenses ($/yr)', Math.round(result.annualOperatingExpenses)],
    ['Net Operating Income ($/yr)', Math.round(result.annualNOI)],
    ['Annual Debt Service ($/yr)', Math.round(result.annualDebtService)],
    ['Annual Cash Flow ($/yr)', Math.round(result.annualCashFlow)],
    ['Cap Rate (%)', Number(result.capRatePct.toFixed(2))],
    ['Cash-on-Cash Return (%)', Number(result.cashOnCashPct.toFixed(2))],
    ['DSCR', result.dscr === null ? null : Number(result.dscr.toFixed(2))],
    ['Target Cash-on-Cash (%)', inputs.targetCashOnCashPct],
    ['Target Offer Price ($)', result.targetOfferPrice],
    ['Gap vs Asking ($)', result.targetOfferDelta],
  ]
  return ['Metric,Value', ...rows.map(([k, v]) => `${esc(k)},${esc(v)}`)].join(
    '\n',
  )
}
