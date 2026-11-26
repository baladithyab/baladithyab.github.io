import { useEffect, useRef, useState } from 'react'
import type { Listing } from '../lib/site-study-listings'
import {
  floodSource,
  parcelSource,
  type PropertyEvidence,
} from '../lib/site-study-property-evidence'
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

const storageKey = 'real-estate-due-diligence:reports:v1'
const reportTtl = 24 * 60 * 60 * 1000
const savedLimit = 8
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

function readSaved(): SavedReport[] {
  const entries: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry?.key && entry.expiresAt > Date.now())
    .slice(0, savedLimit)
}

function PropertyReport({ report }: { report: Report }) {
  const { listing, evidence } = report
  const { parcel, flood } = evidence
  const isRental = listing.status.toLowerCase() === 'for rent'
  return (
    <article className="study-report">
      <header>
        <h3>{listing.address}</h3>
        <p>Report created {formattedDate(report.createdAt)}</p>
      </header>
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
          </dl>
          <p>
            {report.listingCheckedAt ? (
              <>
                HomeHarvest sample checked{' '}
                {formattedDate(report.listingCheckedAt)}.{' '}
              </>
            ) : (
              'Source: imported CSV. '
            )}
            {listing.sourceUrl && (
              <a href={listing.sourceUrl}>View source listing</a>
            )}
          </p>
        </section>
        <section>
          <h4>Drive to your destinations</h4>
          <p>
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
          <p>
            <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>{' '}
            snapshot {report.roadDate}. Estimates use a 250 m grid and modeled
            speeds.{' '}
            {report.clipped &&
              'The drive area reaches the edge of the study data.'}
          </p>
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
                <ul>
                  {parcel.matches.map(({ apn, jurisdiction }) => (
                    <li key={`${apn}:${jurisdiction}`}>
                      APN {apn}
                      {jurisdiction && ` · ${jurisdiction}`}
                    </li>
                  ))}
                </ul>
              )}
              {parcel.truncated && (
                <p>More candidates may exist at this coordinate.</p>
              )}
              <p>Confirm the parcel and unit against the county record.</p>
            </>
          )}
          <p>
            <a href={parcelSource}>Santa Clara County parcel layer</a>
            {parcel && ` · Checked ${formattedDate(parcel.checkedAt)}`}
          </p>
        </section>
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
                <ul>
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
              {flood.truncated && (
                <p>More mapped zones may exist at this coordinate.</p>
              )}
            </>
          )}
          <p>
            <a href={floodSource}>San José’s FEMA flood hazard layer</a>
            {flood && ` · Checked ${formattedDate(flood.checkedAt)}`}
          </p>
        </section>
      </div>
      <section>
        <h4>Open checks</h4>
        <p>
          {isRental
            ? 'Confirm lease terms, fees, deposits, and comparable rents.'
            : 'Confirm closed sales, tax history, title and liens, and inspection costs.'}{' '}
          Verify zoning and permits with the parcel’s jurisdiction.
        </p>
      </section>
    </article>
  )
}

export default function SiteStudyPropertyReport({
  input,
}: {
  input?: PropertyReportInput
}) {
  const [saved, setSaved] = useState<SavedReport[]>([])
  const [recent, setRecent] = useState<Report>()
  const [opened, setOpened] = useState<string>()
  const [pendingKey, setPendingKey] = useState<string>()
  const [storageMessage, setStorageMessage] = useState('')
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    try {
      const entries = readSaved()
      setSaved(entries)
      localStorage.setItem(storageKey, JSON.stringify(entries))
    } catch {
      // Storage may be blocked in private sessions.
    }
    return () => request.current?.abort()
  }, [])

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
      },
      Math.max(0, expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [saved])

  const key =
    input &&
    JSON.stringify([
      input.listing,
      input.listingCheckedAt === null,
      input.drives,
      input.limit,
      input.mode,
      input.roadDate,
      input.clipped,
    ])
  const savedReport = saved.find(
    (entry) => entry.key === (opened ?? key) && entry.expiresAt > Date.now(),
  )
  const report = !opened && recent?.key === key ? recent : savedReport
  const current =
    savedReport?.createdAt === report?.createdAt ? savedReport : undefined
  const canRetry =
    report?.key === key &&
    !!report &&
    (!report.evidence.parcel || !report.evidence.flood)
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
            AbortSignal.timeout(10_000),
          ]),
        },
      )
      if (response.ok) evidence = (await response.json()) as PropertyEvidence
    } catch {
      // Listing and modeled drives can still be reported when the lookups fail.
    }
    if (controller.signal.aborted) return
    setRecent({ ...input, key, evidence, createdAt: new Date().toISOString() })
    setPendingKey(undefined)
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
      setSaved(entries)
      setRecent((previous) =>
        previous?.key === report.key ? undefined : previous,
      )
      setStorageMessage('Report saved in this browser.')
    } catch {
      setStorageMessage('This browser could not save the report.')
    }
  }

  if (!input && !report && saved.length === 0) return null
  return (
    <section
      className="study-report-panel"
      aria-labelledby="study-report-title"
    >
      <h2 id="study-report-title">Property due diligence</h2>
      {input && (!report || report.key !== key || canRetry) && (
        <div>
          <p>
            The parcel and flood checks use the selected listing’s coordinates.
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
        <p role="status">Checking county parcels and city flood zones.</p>
      )}
      {report && (
        <>
          <PropertyReport report={report} />
          {current ? (
            <p>
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
        </>
      )}
      {storageMessage && <p role="status">{storageMessage}</p>}
      {saved.length > 0 && (
        <details>
          <summary>Saved reports ({saved.length})</summary>
          <ul className="study-listings">
            {saved.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
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
