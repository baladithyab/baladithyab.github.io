import { useEffect, useMemo, useRef, useState } from 'react'
import type { Listing } from '../lib/site-study-listings'
import {
  activePermitsSource,
  calEnviroSource,
  floodSource,
  parcelSource,
  policeBeatSource,
  seismicSource,
  spotCrimeMapUrl,
  wildfireSource,
  zoningSource,
  type PropertyEvidence,
} from '../lib/site-study-property-evidence'
import {
  buildUnderwritingCsv,
  computeUnderwriting,
  defaultUnderwritingInputs,
  type UnderwritingInputs,
} from '../lib/site-study-underwriting'
import type { MatchMode } from '../lib/site-study'

type Drive = {
  name: string
  coordinate: [number, number]
  minutes: number | null
}

export type PropertyReportInput = {
  listing: Listing
  listingCheckedAt: string | null
  drives: Drive[]
  limit: number
  mode: MatchMode
  roadDate: string
  clipped: boolean
}

type Report = PropertyReportInput & {
  key: string
  createdAt: string
  evidence: PropertyEvidence
}
type SavedReport = Report & { expiresAt: number }
type ReportSubTab = 'overview' | 'hazards' | 'zoning' | 'safety' | 'underwrite'

const storageKey = 'real-estate-due-diligence:reports:v1'
const reportTtl = 24 * 60 * 60 * 1000
const savedLimit = 8
const sessionReports = new Map<string, Report>()
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function formattedDate(value: string | number) {
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? dateTime.format(time) : 'Unavailable'
}

export function propertyReportKey(input: PropertyReportInput): string {
  return JSON.stringify([
    input.listing,
    input.listingCheckedAt === null,
    input.drives,
    input.limit,
    input.mode,
    input.roadDate,
    input.clipped,
  ])
}

function readSaved(): SavedReport[] {
  if (typeof localStorage === 'undefined') return []
  const entries: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry?.key && entry.expiresAt > Date.now())
    .slice(0, savedLimit)
}

export function findSavedPropertyReport(
  key: string | undefined,
): SavedReport | undefined {
  if (!key) return undefined
  try {
    return readSaved().find(
      (entry) => entry.key === key && entry.expiresAt > Date.now(),
    )
  } catch {
    return undefined
  }
}

export function hasSessionOrSavedReport(key: string | undefined): {
  saved: SavedReport | undefined
  session: Report | undefined
} {
  if (!key) return { saved: undefined, session: undefined }
  return {
    saved: findSavedPropertyReport(key),
    session: sessionReports.get(key),
  }
}

function UnderwritingView({ report }: { report: Report }) {
  const { listing, evidence } = report
  const isRental = listing.status.toLowerCase() === 'for rent'
  const [inputs, setInputs] = useState<UnderwritingInputs>(() =>
    defaultUnderwritingInputs(
      isRental ? null : listing.price,
      isRental ? listing.price : null,
      evidence.context?.tractMedianHomeValue ?? null,
    ),
  )

  useEffect(() => {
    setInputs(
      defaultUnderwritingInputs(
        isRental ? null : listing.price,
        isRental ? listing.price : null,
        evidence.context?.tractMedianHomeValue ?? null,
      ),
    )
  }, [
    report.key,
    isRental,
    listing.price,
    evidence.context?.tractMedianHomeValue,
  ])

  const result = useMemo(() => computeUnderwriting(inputs), [inputs])

  const updateNum = (field: keyof UnderwritingInputs, raw: string) => {
    const val = Number(raw)
    if (Number.isFinite(val)) setInputs((prev) => ({ ...prev, [field]: val }))
  }

  const downloadCsv = () => {
    const csv = buildUnderwritingCsv(listing.address, inputs, result)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `underwriting-${listing.address.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  return (
    <div className="study-report-sections">
      <section>
        <h4>Deterministic underwriting &amp; true cost</h4>
        <p className="study-report-footnote">
          Pure math over your assumptions (CA Prop 13 base tax default 1.18%).
          HOA dues, closing credits, and rehab costs remain open until verified
          against disclosures.
        </p>
        <div className="study-uw-grid">
          <label>
            Purchase price ($)
            <input
              type="number"
              min="0"
              step="10000"
              value={inputs.askingPrice}
              onChange={(e) => updateNum('askingPrice', e.target.value)}
            />
          </label>
          <label>
            Est. monthly rent ($)
            <input
              type="number"
              min="0"
              step="100"
              value={inputs.monthlyRent}
              onChange={(e) => updateNum('monthlyRent', e.target.value)}
            />
          </label>
          <label>
            Down payment (%)
            <input
              type="number"
              min="0"
              max="100"
              step="5"
              value={inputs.downPaymentPct}
              onChange={(e) => updateNum('downPaymentPct', e.target.value)}
            />
          </label>
          <label>
            Interest rate (%)
            <input
              type="number"
              min="0"
              max="20"
              step="0.125"
              value={inputs.interestRatePct}
              onChange={(e) => updateNum('interestRatePct', e.target.value)}
            />
          </label>
          <label>
            Prop tax rate (%)
            <input
              type="number"
              min="0"
              max="5"
              step="0.05"
              value={inputs.propertyTaxRatePct}
              onChange={(e) => updateNum('propertyTaxRatePct', e.target.value)}
            />
          </label>
          <label>
            HOA / month ($)
            <input
              type="number"
              min="0"
              step="25"
              value={inputs.hoaMonthly}
              onChange={(e) => updateNum('hoaMonthly', e.target.value)}
            />
          </label>
          <label>
            Mgmt fee (%)
            <input
              type="number"
              min="0"
              max="25"
              step="1"
              value={inputs.managementPct}
              onChange={(e) => updateNum('managementPct', e.target.value)}
            />
          </label>
          <label>
            Target Cash-on-Cash (%)
            <input
              type="number"
              min="0"
              max="30"
              step="0.5"
              value={inputs.targetCashOnCashPct}
              onChange={(e) => updateNum('targetCashOnCashPct', e.target.value)}
            />
          </label>
        </div>
      </section>

      <section>
        <h4>Monthly PITI &amp; operating returns</h4>
        <dl>
          <div>
            <dt>Mortgage P&amp;I</dt>
            <dd>{dollars.format(result.monthlyMortgagePI)}/mo</dd>
          </div>
          <div>
            <dt>Est. Prop 13 tax</dt>
            <dd>{dollars.format(result.monthlyPropertyTax)}/mo</dd>
          </div>
          <div>
            <dt>Est. insurance</dt>
            <dd>{dollars.format(result.monthlyInsurance)}/mo</dd>
          </div>
          <div>
            <dt>Total monthly PITI + HOA</dt>
            <dd>{dollars.format(result.monthlyPITI)}/mo</dd>
          </div>
          <div>
            <dt>Annual NOI</dt>
            <dd>{dollars.format(result.annualNOI)}</dd>
          </div>
          <div>
            <dt>Cap rate</dt>
            <dd>{result.capRatePct.toFixed(2)}%</dd>
          </div>
          <div>
            <dt>DSCR</dt>
            <dd>{result.dscr === null ? 'N/A' : `${result.dscr.toFixed(2)}×`}</dd>
          </div>
          <div>
            <dt>Cash-on-Cash</dt>
            <dd>{result.cashOnCashPct.toFixed(2)}%</dd>
          </div>
          <div>
            <dt>Est. monthly cash flow</dt>
            <dd>{dollars.format(result.monthlyCashFlow)}/mo</dd>
          </div>
        </dl>
      </section>

      <section className="study-uw-target">
        <h4>Reverse target-offer price</h4>
        <p className="study-uw-offer">
          {result.targetOfferPrice !== null
            ? dollars.format(result.targetOfferPrice)
            : 'Unavailable'}
        </p>
        <p className="study-report-footnote">
          Modeled offer price to achieve {inputs.targetCashOnCashPct}%
          Cash-on-Cash under these assumptions
          {result.targetOfferDelta !== null &&
          result.targetOfferDeltaPct !== null
            ? ` (${result.targetOfferDelta >= 0 ? '+' : ''}${dollars.format(result.targetOfferDelta)} / ${result.targetOfferDeltaPct >= 0 ? '+' : ''}${result.targetOfferDeltaPct.toFixed(1)}% vs asking).`
            : '.'}
        </p>
        <button
          type="button"
          className="study-primary-btn"
          onClick={downloadCsv}
        >
          Download underwriting CSV
        </button>
      </section>
    </div>
  )
}

function PropertyReport({ report }: { report: Report }) {
  const { listing, evidence } = report
  const { parcel, flood, zoning, permits, hazards, safety, context } = evidence
  const isRental = listing.status.toLowerCase() === 'for rent'
  const [subTab, setSubTab] = useState<ReportSubTab>('overview')

  const spotCrimeHref =
    safety?.spotCrimeUrl ??
    spotCrimeMapUrl(
      listing.coordinate[1],
      listing.coordinate[0],
      parcel?.matches[0]?.situsAddress ?? listing.address,
    )

  const coverageItems = [
    { label: 'Parcel & Lot', checked: Boolean(parcel) },
    { label: 'FEMA Flood', checked: Boolean(flood) },
    { label: 'Seismic / Fire / Env', checked: Boolean(hazards) },
    { label: 'Zoning & Dev', checked: Boolean(zoning) },
    { label: 'Permits & Code', checked: Boolean(permits) },
    { label: 'SJPD Safety', checked: Boolean(safety) },
    { label: 'Schools & Noise', checked: Boolean(context) },
    { label: 'Title & Liens', checked: false },
    { label: 'Closed Comps / 3-AVM', checked: false },
    { label: 'HOA Reserves', checked: false },
  ]

  return (
    <article className="study-report">
      <header className="study-report-header">
        <h3>{listing.address}</h3>
        <p className="study-coordinates">
          Report created {formattedDate(report.createdAt)}
        </p>
      </header>

      <div
        className="study-subtabs"
        role="tablist"
        aria-label="Due diligence dimensions"
      >
        {(
          [
            ['overview', 'Overview'],
            ['hazards', 'Hazards'],
            ['zoning', 'Zoning'],
            ['safety', 'Safety'],
            ['underwrite', 'Underwrite'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={subTab === id}
            className="study-subtab"
            onClick={() => setSubTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === 'overview' && (
        <div className="study-report-sections">
          <section>
            <h4>Listing</h4>
            <dl>
              <div>
                <dt>
                  {isRental
                    ? 'Asking rent'
                    : report.listingCheckedAt
                      ? 'Asking price'
                      : 'Price in CSV'}
                </dt>
                <dd>
                  {listing.price === null
                    ? 'Unavailable'
                    : dollars.format(listing.price)}
                </dd>
              </div>
              <div>
                <dt>Bedrooms</dt>
                <dd>{listing.beds ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Floor area</dt>
                <dd>
                  {listing.sqft === undefined
                    ? 'Unavailable'
                    : `${listing.sqft.toLocaleString('en-US')} sq ft`}
                </dd>
              </div>
              {context?.tractMedianHomeValue && (
                <div>
                  <dt>Tract median home value</dt>
                  <dd>{dollars.format(context.tractMedianHomeValue)}</dd>
                </div>
              )}
            </dl>
            <p className="study-report-footnote">
              {report.listingCheckedAt ? (
                <>
                  HomeHarvest sample checked{' '}
                  {formattedDate(report.listingCheckedAt)}.{' '}
                </>
              ) : (
                'Source: imported CSV. '
              )}
              {listing.sourceUrl && (
                <a
                  href={listing.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View source listing
                </a>
              )}
            </p>
          </section>

          <section>
            <h4>Drive to your destinations</h4>
            <p className="study-report-footnote">
              {report.limit}-minute limit for{' '}
              {report.mode === 'all' ? 'all' : 'any'} destinations.
            </p>
            <dl>
              {report.drives.map((drive) => (
                <div key={drive.coordinate.join(',')}>
                  <dt>{drive.name}</dt>
                  <dd>
                    {drive.minutes === null
                      ? 'Beyond modeled 15 min'
                      : `≈ ${drive.minutes} min`}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h4>Parcel candidates</h4>
            {parcel === null ? (
              <p>County lookup unavailable.</p>
            ) : (
              <>
                {parcel.matches.length === 0 ? (
                  <p>The listing coordinate did not match a county parcel.</p>
                ) : (
                  <ul className="study-report-list">
                    {parcel.matches.map((match) => (
                      <li key={`${match.apn}:${match.jurisdiction}`}>
                        <strong>APN {match.apn}</strong>
                        {match.jurisdiction && ` · ${match.jurisdiction}`}
                        {match.situsAddress && (
                          <div className="study-coordinates">
                            Situs: {match.situsAddress}
                          </div>
                        )}
                        {(match.lotSqft || match.taxRateArea) && (
                          <div className="study-coordinates">
                            {match.lotSqft
                              ? `Est. lot ${match.lotSqft.toLocaleString('en-US')} sq ft`
                              : ''}
                            {match.lotSqft && match.taxRateArea ? ' · ' : ''}
                            {match.taxRateArea
                              ? `Tax rate area ${match.taxRateArea}`
                              : ''}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {parcel.truncated && (
                  <p>More candidates may exist at this coordinate.</p>
                )}
                <p className="study-report-footnote">
                  Owner names are intentionally omitted (PII minimization).
                  Confirm parcel &amp; tax roll directly with the county.
                </p>
              </>
            )}
            <p className="study-report-footnote">
              <a href={parcelSource} target="_blank" rel="noopener noreferrer">
                Santa Clara County parcel layer
              </a>
              {parcel && ` · Checked ${formattedDate(parcel.checkedAt)}`}
            </p>
          </section>

          <section>
            <h4>Due diligence coverage ledger</h4>
            <div className="study-coverage-chips">
              {coverageItems.map((item) => (
                <span
                  key={item.label}
                  className="study-coverage-chip"
                  data-checked={item.checked}
                >
                  {item.checked ? '✓' : '○'} {item.label}
                </span>
              ))}
            </div>
            <p className="study-report-footnote">
              Open items (title/liens, closed comps, HOA reserves, physical
              inspection) require disclosures or dedicated paid/workflow checks.
            </p>
          </section>
        </div>
      )}

      {subTab === 'hazards' && (
        <div className="study-report-sections">
          <section>
            <h4>Flood map screening</h4>
            {flood === null ? (
              <p>City flood layer lookup unavailable.</p>
            ) : (
              <>
                {flood.matches.length === 0 ? (
                  <p>
                    No flood polygon matched this coordinate. Check map coverage
                    before drawing a conclusion.
                  </p>
                ) : (
                  <ul className="study-report-list">
                    {flood.matches.map(
                      ({ zone, description, specialFloodHazardArea }) => (
                        <li
                          key={`${zone}:${description}:${specialFloodHazardArea}`}
                        >
                          Zone {zone}
                          {description && ` · ${description}`}
                          {specialFloodHazardArea &&
                            ' · Special Flood Hazard Area'}
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </>
            )}
            <p className="study-report-footnote">
              <a href={floodSource} target="_blank" rel="noopener noreferrer">
                San José’s FEMA flood hazard layer
              </a>
              {flood && ` · Checked ${formattedDate(flood.checkedAt)}`}
            </p>
          </section>

          <section>
            <h4>Seismic, wildfire &amp; dam inundation</h4>
            {!hazards ? (
              <p>Hazard screening unavailable for this snapshot.</p>
            ) : (
              <dl>
                <div>
                  <dt>CGS seismic zones</dt>
                  <dd>
                    {hazards.seismicZones.length
                      ? hazards.seismicZones.join(', ')
                      : 'None mapped'}
                  </dd>
                </div>
                <div>
                  <dt>CAL FIRE 2025 FHSZ</dt>
                  <dd>{hazards.wildfireZone ?? 'Not mapped'}</dd>
                </div>
                <div>
                  <dt>Dam failure inundation</dt>
                  <dd>
                    {hazards.damInundation
                      ? 'Inside mapped inundation zone'
                      : 'Outside mapped zone'}
                  </dd>
                </div>
              </dl>
            )}
            <p className="study-report-footnote">
              <a href={seismicSource} target="_blank" rel="noopener noreferrer">
                CGS Seismic
              </a>{' '}
              ·{' '}
              <a
                href={wildfireSource}
                target="_blank"
                rel="noopener noreferrer"
              >
                CAL FIRE FHSZ
              </a>
              {hazards && ` · Checked ${formattedDate(hazards.checkedAt)}`}
            </p>
          </section>

          <section>
            <h4>Environmental &amp; pollution burden</h4>
            {!hazards ? (
              <p>Environmental screening unavailable.</p>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>CalEnviroScreen 5.0</dt>
                    <dd>
                      {hazards.calEnviroPercentile !== null
                        ? `${hazards.calEnviroPercentile.toFixed(1)}th pct`
                        : 'Unavailable'}
                    </dd>
                  </div>
                  <div>
                    <dt>Pollution burden</dt>
                    <dd>
                      {hazards.pollutionPercentile !== null
                        ? `${hazards.pollutionPercentile.toFixed(1)}th pct`
                        : 'Unavailable'}
                    </dd>
                  </div>
                  <div>
                    <dt>Groundwater threats</dt>
                    <dd>
                      {hazards.groundwaterPercentile !== null
                        ? `${hazards.groundwaterPercentile.toFixed(1)}th pct`
                        : 'Unavailable'}
                    </dd>
                  </div>
                  <div>
                    <dt>Cortese sites (400 m)</dt>
                    <dd>{hazards.corteseSitesNearby.length}</dd>
                  </div>
                </dl>
                {hazards.corteseSitesNearby.length > 0 && (
                  <ul className="study-report-list">
                    {hazards.corteseSitesNearby.map((site) => (
                      <li key={site.name}>
                        {site.name}
                        {site.status ? ` · ${site.status}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <p className="study-report-footnote">
              <a
                href={calEnviroSource}
                target="_blank"
                rel="noopener noreferrer"
              >
                OEHHA CalEnviroScreen 5.0
              </a>{' '}
              &amp; Cortese List
            </p>
          </section>
        </div>
      )}

      {subTab === 'zoning' && (
        <div className="study-report-sections">
          <section>
            <h4>Zoning &amp; development envelope</h4>
            {!zoning ? (
              <p>Zoning data unavailable (outside San José city limits or lookup failed).</p>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>Zoning district</dt>
                    <dd>{zoning.zoning ?? 'Unmapped'}</dd>
                  </div>
                  <div>
                    <dt>General Plan 2040</dt>
                    <dd>{zoning.generalPlan ?? 'Unmapped'}</dd>
                  </div>
                  <div>
                    <dt>Height limit</dt>
                    <dd>
                      {zoning.heightLimit ?? 'Base district'}
                      {zoning.heightCodeSection
                        ? ` (${zoning.heightCodeSection})`
                        : ''}
                    </dd>
                  </div>
                  {zoning.pdUse && (
                    <div>
                      <dt>PD use</dt>
                      <dd>{zoning.pdUse}</dd>
                    </div>
                  )}
                </dl>
                {zoning.zoningNotes && (
                  <p className="study-report-footnote">{zoning.zoningNotes}</p>
                )}
                {zoning.nearbyDevelopments.length > 0 && (
                  <div className="study-report-subblock">
                    <p className="study-coordinates">
                      <strong>Major projects within 400 m:</strong>
                    </p>
                    <ul className="study-report-list">
                      {zoning.nearbyDevelopments.map((dev) => (
                        <li key={dev.name}>
                          {dev.name}
                          {dev.status ? ` · ${dev.status}` : ''}
                          {dev.height ? ` · ${dev.height}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            <p className="study-report-footnote">
              <a href={zoningSource} target="_blank" rel="noopener noreferrer">
                San José Zoning &amp; General Plan GIS
              </a>
            </p>
          </section>

          <section>
            <h4>Permits, code enforcement &amp; historic</h4>
            {!permits ? (
              <p>Permit &amp; complaint lookup unavailable.</p>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>Active building permits</dt>
                    <dd>{permits.activePermits.length}</dd>
                  </div>
                  <div>
                    <dt>Expired building permits</dt>
                    <dd>{permits.expiredPermits.length}</dd>
                  </div>
                  <div>
                    <dt>Open code complaints (120 m)</dt>
                    <dd>{permits.openComplaints.length}</dd>
                  </div>
                  <div>
                    <dt>Historic inventory (35 m)</dt>
                    <dd>{permits.historicResources.length}</dd>
                  </div>
                </dl>
                {permits.activePermits.length > 0 && (
                  <div className="study-report-subblock">
                    <p className="study-coordinates">
                      <strong>Active permits:</strong>
                    </p>
                    <ul className="study-report-list">
                      {permits.activePermits.map((p) => (
                        <li key={p.folder}>
                          {p.folder}
                          {p.work ? ` · ${p.work}` : ''}
                          {p.value ? ` (${dollars.format(p.value)})` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {permits.expiredPermits.length > 0 && (
                  <div className="study-report-subblock">
                    <p className="study-coordinates">
                      <strong>Expired permits (verify final sign-off):</strong>
                    </p>
                    <ul className="study-report-list">
                      {permits.expiredPermits.map((p) => (
                        <li key={p.folder}>
                          {p.folder}
                          {p.work ? ` · ${p.work}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {permits.openComplaints.length > 0 && (
                  <div className="study-report-subblock">
                    <p className="study-coordinates">
                      <strong>Nearby open code complaints:</strong>
                    </p>
                    <ul className="study-report-list">
                      {permits.openComplaints.map((c) => (
                        <li key={c.caseNumber}>
                          Case {c.caseNumber}
                          {c.violationType ? ` · ${c.violationType}` : ''}
                          {c.disposition ? ` · ${c.disposition}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {permits.historicResources.length > 0 && (
                  <div className="study-report-subblock">
                    <p className="study-coordinates">
                      <strong>Historic resources nearby:</strong>
                    </p>
                    <ul className="study-report-list">
                      {permits.historicResources.map((h) => (
                        <li key={h.name}>
                          {h.name}
                          {h.year ? ` (${h.year})` : ''}
                          {h.millsAct === 'Yes' ? ' · Mills Act' : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            <p className="study-report-footnote">
              <a
                href={activePermitsSource}
                target="_blank"
                rel="noopener noreferrer"
              >
                San José Permits &amp; Complaints GIS
              </a>
            </p>
          </section>
        </div>
      )}

      {subTab === 'safety' && (
        <div className="study-report-sections">
          <section>
            <h4>Safety &amp; crime context (context only)</h4>
            <p className="study-report-footnote">
              Fair-housing guardrail: safety and neighborhood metrics are
              informational context only and never drive a pass/fail score.
            </p>
            <div className="study-report-subblock">
              <a
                href={spotCrimeHref}
                target="_blank"
                rel="noopener noreferrer"
                className="study-spotcrime-link"
              >
                Open this coordinate on SpotCrime ↗
              </a>
              <p className="study-report-footnote">
                SpotCrime’s JSON API requires a paid static-IP key; live in-app
                incidents below come from daily official SJPD Open Data.
              </p>
            </div>
            {safety ? (
              <>
                <dl>
                  <div>
                    <dt>SJPD Police Beat</dt>
                    <dd>
                      {safety.policeBeat
                        ? `${safety.policeBeat.beat} · ${safety.policeBeat.level ?? 'Unknown'}`
                        : 'Outside SJPD'}
                    </dd>
                  </div>
                  <div>
                    <dt>Traffic crashes (5 yr, 250 m)</dt>
                    <dd>
                      {safety.crashes5YrCount !== null
                        ? `${safety.crashes5YrCount} (${safety.severeCrashes5YrCount ?? 0} severe/fatal)`
                        : 'Unavailable'}
                    </dd>
                  </div>
                </dl>
                {safety.sjpdStreetQuery && (
                  <div className="study-report-subblock">
                    <p className="study-coordinates">
                      <strong>
                        Recent SJPD calls on {safety.sjpdStreetQuery}
                      </strong>
                      {safety.sjpdDatasetNote
                        ? ` (${safety.sjpdDatasetNote})`
                        : ''}
                      :
                    </p>
                    {safety.sjpdRecentCalls.length === 0 ? (
                      <p className="study-coordinates">
                        No recent street-level calls matched this corridor.
                      </p>
                    ) : (
                      <ul className="study-report-list">
                        {safety.sjpdRecentCalls.slice(0, 6).map((call, idx) => (
                          <li key={`${call.date}-${idx}`}>
                            <span>
                              {call.date ?? 'Recent'} · {call.type}
                            </span>
                            {call.address && (
                              <div className="study-coordinates">
                                {call.address}
                                {call.priority ? ` · P${call.priority}` : ''}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="study-report-footnote">
                      SJPD anonymizes call addresses to block ranges and
                      intersections; calls are along the same street corridor,
                      not necessarily this exact parcel.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p>Police beat and SJPD calls unavailable for this snapshot.</p>
            )}
            <p className="study-report-footnote">
              <a
                href={policeBeatSource}
                target="_blank"
                rel="noopener noreferrer"
              >
                SJ Police Beat GIS
              </a>{' '}
              ·{' '}
              <a
                href="https://data.sanjoseca.gov/dataset/police-calls-for-service-quarterly"
                target="_blank"
                rel="noopener noreferrer"
              >
                SJPD Open Data
              </a>
            </p>
          </section>

          <section>
            <h4>Neighborhood, schools, transit &amp; noise</h4>
            {!context ? (
              <p>Neighborhood context unavailable.</p>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>Neighborhood</dt>
                    <dd>{context.neighborhood ?? 'Unmapped'}</dd>
                  </div>
                  <div>
                    <dt>School district</dt>
                    <dd>{context.schoolDistrict ?? 'Unmapped'}</dd>
                  </div>
                  <div>
                    <dt>HQ transit ½-mi (AB 2097)</dt>
                    <dd>{context.highQualityTransit ? 'Yes' : 'No'}</dd>
                  </div>
                  <div>
                    <dt>Road noise contour</dt>
                    <dd>
                      {context.roadNoiseDba
                        ? `${context.roadNoiseDba} dBA`
                        : 'Outside major contour'}
                    </dd>
                  </div>
                  <div>
                    <dt>Airport CNEL noise</dt>
                    <dd>
                      {context.airportNoiseCnel !== null
                        ? `${context.airportNoiseCnel} dB CNEL`
                        : 'Outside SJC 60+ dB'}
                    </dd>
                  </div>
                  <div>
                    <dt>Within 500 ft of freeway</dt>
                    <dd>{context.nearFreeway500Ft ? 'Yes (air/noise check)' : 'No'}</dd>
                  </div>
                  {context.tractMedianIncome && (
                    <div>
                      <dt>Tract median income</dt>
                      <dd>{dollars.format(context.tractMedianIncome)}</dd>
                    </div>
                  )}
                </dl>
                {context.nearbySchools.length > 0 && (
                  <p className="study-report-footnote">
                    <strong>Schools (1.2 km):</strong>{' '}
                    {context.nearbySchools
                      .map((s) =>
                        s.grades ? `${s.name} (${s.grades})` : s.name,
                      )
                      .join(', ')}
                  </p>
                )}
                {context.nearbyParks.length > 0 && (
                  <p className="study-report-footnote">
                    <strong>Parks (600 m):</strong>{' '}
                    {context.nearbyParks.join(', ')}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {subTab === 'underwrite' && <UnderwritingView report={report} />}

      <section className="study-report-open-checks">
        <h4>Open checks</h4>
        <p>
          {isRental
            ? 'Confirm lease terms, fees, deposits, and comparable rents.'
            : 'Confirm closed sales, tax history, title and liens, HOA reserves, and inspection costs.'}{' '}
          Verify zoning and permits with the parcel’s jurisdiction.
        </p>
      </section>
    </article>
  )
}

export default function SiteStudyPropertyReport({
  input,
  layout = 'sidebar',
  syncVersion = 0,
  onBrowseListings,
  onSavedCountChange,
  onSavedChange,
}: {
  input?: PropertyReportInput
  layout?: 'sidebar' | 'modal'
  syncVersion?: number
  onBrowseListings?: () => void
  onSavedCountChange?: (count: number) => void
  onSavedChange?: () => void
}) {
  const [saved, setSaved] = useState<SavedReport[]>([])
  const [recent, setRecent] = useState<Report>()
  const [opened, setOpened] = useState<string>()
  const [pendingKey, setPendingKey] = useState<string>()
  const [storageMessage, setStorageMessage] = useState('')
  const request = useRef<AbortController | null>(null)
  const key = input ? propertyReportKey(input) : undefined

  useEffect(() => {
    try {
      const entries = readSaved()
      setSaved(entries)
      localStorage.setItem(storageKey, JSON.stringify(entries))
    } catch {
      // Storage may be blocked in private sessions.
    }
  }, [syncVersion])

  useEffect(() => {
    return () => request.current?.abort()
  }, [])

  useEffect(() => {
    setOpened(undefined)
    setStorageMessage('')
    if (key) {
      const cached = sessionReports.get(key)
      if (cached) setRecent(cached)
    }
  }, [key, syncVersion])

  useEffect(() => {
    onSavedCountChange?.(saved.length)
  }, [saved.length, onSavedCountChange])

  useEffect(() => {
    if (!saved.length) return
    const expiresAt = Math.min(...saved.map((entry) => entry.expiresAt))
    const timer = setTimeout(
      () => {
        try {
          const entries = readSaved()
          setSaved(entries)
          localStorage.setItem(storageKey, JSON.stringify(entries))
        } catch {
          setSaved((entries) =>
            entries.filter((entry) => entry.expiresAt > Date.now()),
          )
        }
        onSavedChange?.()
      },
      Math.max(0, expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [saved, onSavedChange])

  const savedReport = saved.find(
    (entry) => entry.key === (opened ?? key) && entry.expiresAt > Date.now(),
  )
  const sessionHit = !opened && key ? sessionReports.get(key) : undefined
  const activeRecent =
    !opened && recent?.key === key ? recent : sessionHit
  const report = activeRecent ?? savedReport
  const current =
    savedReport?.createdAt === report?.createdAt ? savedReport : undefined
  const canRetry =
    report?.key === key &&
    !!report &&
    (!report.evidence.parcel ||
      !report.evidence.flood ||
      report.evidence.zoning === null ||
      report.evidence.hazards === null ||
      report.evidence.safety === null)
  const loading = pendingKey !== undefined && pendingKey === key

  const generate = async () => {
    if (!input || !key) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setOpened(undefined)
    setPendingKey(key)
    setStorageMessage('')
    let evidence: PropertyEvidence = { parcel: null, flood: null }
    try {
      const [lng, lat] = input.listing.coordinate
      const query = new URLSearchParams({
        lng: lng.toFixed(6),
        lat: lat.toFixed(6),
      })
      const response = await fetch(
        `/api/lab/real-estate-due-diligence/evidence?${query}`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(14_000),
          ]),
        },
      )
      if (response.ok) evidence = (await response.json()) as PropertyEvidence
    } catch {
      // Listing and modeled drives can still be reported when the lookups fail.
    }
    if (controller.signal.aborted) return
    const nextReport: Report = {
      ...input,
      key,
      evidence,
      createdAt: new Date().toISOString(),
    }
    sessionReports.set(key, nextReport)
    setRecent(nextReport)
    setPendingKey(undefined)
    onSavedChange?.()
  }

  const save = () => {
    if (!report) return
    try {
      const entry = { ...report, expiresAt: Date.now() + reportTtl }
      const entries = [
        entry,
        ...readSaved().filter((old) => old.key !== report.key),
      ].slice(0, savedLimit)
      localStorage.setItem(storageKey, JSON.stringify(entries))
      sessionReports.delete(report.key)
      setSaved(entries)
      setRecent((previous) =>
        previous?.key === report.key ? undefined : previous,
      )
      setStorageMessage('Report saved in this browser.')
      onSavedChange?.()
    } catch {
      setStorageMessage('This browser could not save the report.')
    }
  }

  const titleId =
    layout === 'modal' ? 'study-report-modal-title' : 'study-report-title'

  return (
    <section
      className="study-report-panel"
      data-layout={layout}
      aria-labelledby={titleId}
    >
      <div className="study-panel-heading">
        <h2 id={titleId}>Property due diligence</h2>
        <p className="study-coordinates">
          Parcels, multi-hazards, zoning, permits, SJPD safety, SpotCrime link,
          and buyer underwriting.
        </p>
      </div>

      {!input && !report && (
        <div className="study-empty-card">
          <p>
            Select a property from the Listings tab or map to run county parcel,
            hazard, zoning, permit, safety, and underwriting checks.
          </p>
          {onBrowseListings && (
            <button
              type="button"
              className="study-primary-btn"
              onClick={onBrowseListings}
            >
              Browse listings
            </button>
          )}
        </div>
      )}

      {input && (!report || report.key !== key || canRetry) && (
        <div className="study-report-cta">
          <p className="study-report-selected-name">{input.listing.address}</p>
          <p className="study-coordinates">
            Queries Santa Clara County parcels, San José GIS hazards/zoning/permits,
            and daily SJPD public call records for this coordinate.
          </p>
          <button
            className="study-load-listings"
            type="button"
            disabled={loading}
            onClick={generate}
          >
            {loading
              ? 'Checking public records…'
              : canRetry
                ? 'Retry public records'
                : 'Generate property report'}
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="study-coordinates">
          Checking parcels, hazards, zoning, permits, and SJPD safety records…
        </p>
      )}
      {report && (
        <>
          <PropertyReport report={report} />
          <div className="study-report-actions">
            {current ? (
              <p className="study-coordinates">
                Saved in this browser until {formattedDate(current.expiresAt)}.
              </p>
            ) : (
              <button
                className="study-load-listings"
                type="button"
                onClick={save}
              >
                Save report for 24 hours
              </button>
            )}
          </div>
        </>
      )}
      {storageMessage && (
        <p role="status" className="study-coordinates">
          {storageMessage}
        </p>
      )}
      {layout !== 'modal' && saved.length > 0 && (
        <details className="study-saved-reports" open={!report && !input}>
          <summary>Saved reports ({saved.length})</summary>
          <ul className="study-listings">
            {saved.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  aria-pressed={report?.key === entry.key}
                  onClick={() => {
                    setOpened(entry.key)
                    setStorageMessage('')
                  }}
                >
                  {entry.listing.address}
                </button>
                <span>{formattedDate(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
