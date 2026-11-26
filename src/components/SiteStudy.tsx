import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type SubmitEvent,
  type MouseEvent,
} from 'react'
import {
  cellIndex,
  minutes,
  project,
  sites,
  type SiteResult,
} from '../lib/site-study'
import { drawBase, drawOverlay, mapCoordinate } from '../lib/site-study-map'
import { parseListings, type Listing } from '../lib/site-study-listings'
import type { StudyRequest, StudyResponse } from '../scripts/site-study.worker'
import './site-study.css'

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const estimatedCount = (value: number) =>
  whole.format(value >= 1000 ? Number(value.toPrecision(3)) : value)
const percentage = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 0,
})
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
type Site = (typeof sites)[number]
type StudyMap = Extract<StudyResponse, { kind: 'map' }>

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const darkTheme = () => document.documentElement.classList.contains('dark')
const defaultTheme = () => false

export default function SiteStudy() {
  const worker = useRef<Worker | null>(null)
  const pending = useRef({ id: 1, site: sites[0] })
  const importId = useRef(0)
  const frame = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const isDark = useSyncExternalStore(subscribeToTheme, darkTheme, defaultTheme)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [map, setMap] = useState<StudyMap>()
  const [report, setReport] = useState<{ site: Site; result: SiteResult }>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [active, setActive] = useState(1)
  const [wide, setWide] = useState(false)
  const [listings, setListings] = useState<Listing[]>()
  const [importError, setImportError] = useState('')

  useEffect(() => {
    const runner = new Worker(
      new URL('../scripts/site-study.worker.ts', import.meta.url),
      { type: 'module' },
    )
    worker.current = runner
    runner.onmessage = ({ data }: MessageEvent<StudyResponse>) => {
      if (data.kind === 'map') {
        setMap(data)
        return
      }
      if (data.id !== pending.current.id) return
      setBusy(false)
      if (data.kind === 'error') setError(data.message)
      else setReport({ site: pending.current.site, result: data.result })
    }
    runner.onerror = () => {
      setBusy(false)
      setError('The drive study could not start. Reload to try again.')
    }
    const { id, site } = pending.current
    runner.postMessage({
      id,
      coordinate: site.coordinate,
    } satisfies StudyRequest)
    return () => {
      worker.current = null
      runner.terminate()
    }
  }, [])

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })
    if (frame.current) observer.observe(frame.current)
    return () => observer.disconnect()
  }, [])

  const site = report?.site ?? sites[0]
  const result = report?.result
  const matching = useMemo(
    () =>
      map && result && listings
        ? listings.filter((listing) => {
            const index = cellIndex(map.census, project(listing.coordinate))
            return index >= 0 && result.times[index] <= minutes[active] * 60
          })
        : [],
    [map, result, listings, active],
  )

  useEffect(() => {
    if (base.current && map && size.width && size.height)
      drawBase(
        base.current,
        size.width,
        size.height,
        map.roads,
        map.census,
        wide,
        isDark,
      )
  }, [map, size, wide, isDark])

  useEffect(() => {
    if (overlay.current && map && size.width && size.height)
      drawOverlay(
        overlay.current,
        size.width,
        size.height,
        map.census,
        result,
        site.coordinate,
        active,
        matching,
        wide,
        isDark,
      )
  }, [map, size, result, site, active, matching, wide, isDark])

  const select = (next: Site) => {
    const id = pending.current.id + 1
    pending.current = { id, site: next }
    setBusy(true)
    setError('')
    worker.current?.postMessage({
      id,
      coordinate: next.coordinate,
    } satisfies StudyRequest)
  }

  const selectPoint = (event: MouseEvent<HTMLCanvasElement>) => {
    const { left, top, width, height } =
      event.currentTarget.getBoundingClientRect()
    select({
      name: 'Custom site',
      coordinate: mapCoordinate(
        width,
        height,
        event.clientX - left,
        event.clientY - top,
        wide,
      ),
    })
  }

  const selectCoordinates = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    select({
      name: 'Custom site',
      coordinate: [
        Number(values.get('longitude')),
        Number(values.get('latitude')),
      ],
    })
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    const id = ++importId.current
    setImportError('')
    try {
      if (file.size > 1024 * 1024)
        throw new Error('Choose a CSV file up to 1 MB.')
      const rows = parseListings(await file.text())
      if (id === importId.current) setListings(rows)
    } catch (failure) {
      if (id === importId.current)
        setImportError(
          failure instanceof Error
            ? failure.message
            : 'The CSV could not be read.',
        )
    }
  }

  const stats = result?.stats[active]
  const total = result?.stats[2].residents ?? 0
  return (
    <section className="site-study">
      <header className="site-study-heading">
        <div>
          <p className="study-region">San José, California</p>
          <h1>Real Estate Due Diligence</h1>
          <p>See who lives within a 5-, 10-, or 15-minute drive of a site.</p>
        </div>
        <p className="study-caption">
          Drive-time analysis <span>·</span> Maps lab
        </p>
      </header>

      <div className="study-board">
        <div className="study-map" ref={frame}>
          <canvas ref={base} aria-hidden="true" />
          <canvas
            className="study-map-interactive"
            ref={overlay}
            onClick={map ? selectPoint : undefined}
            aria-hidden="true"
          />
          <p className="study-map-instruction">
            Click inside the dashed boundary to set a site
          </p>
          {!map && (
            <p className="study-map-placeholder">
              {error || 'Loading the San José road network…'}
            </p>
          )}
          <div className="study-map-tools">
            <button
              type="button"
              onClick={() => setWide(!wide)}
              disabled={!map}
            >
              {wide ? 'Focus on San José' : 'Show wider area'}
            </button>
            <a href="https://www.openstreetmap.org/copyright">
              © OpenStreetMap contributors
            </a>
          </div>
          <div className="study-map-key" aria-hidden="true">
            {minutes.map((minute, index) => (
              <span key={minute}>
                <i className={`study-band-${index}`} />
                {minute} min
              </span>
            ))}
          </div>
        </div>

        <aside
          className="study-sidebar"
          aria-label="Drive study controls and results"
        >
          <div className="study-origin">
            <div className="study-origin-label">
              <span className="study-origin-dot" aria-hidden="true" /> Selected
              site
            </div>
            <h2>{site.name}</h2>
            <p className="study-coordinates">
              {site.coordinate[1].toFixed(4)}°, {site.coordinate[0].toFixed(4)}°
            </p>
            <div className="study-presets" aria-label="Example sites">
              {sites.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  disabled={!map}
                  aria-pressed={site === preset}
                  onClick={() => select(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <details className="study-custom">
              <summary>Enter coordinates</summary>
              <form onSubmit={selectCoordinates}>
                <label>
                  Latitude{' '}
                  <input
                    name="latitude"
                    type="number"
                    required
                    step="any"
                    placeholder="37.3388"
                  />
                </label>
                <label>
                  Longitude{' '}
                  <input
                    name="longitude"
                    type="number"
                    required
                    step="any"
                    placeholder="-121.8863"
                  />
                </label>
                <button type="submit" disabled={!map}>
                  Analyze site
                </button>
              </form>
            </details>
          </div>

          <div className="study-results" aria-busy={busy}>
            <h3>Within a drive of</h3>
            <div className="study-times" role="group" aria-label="Drive time">
              {minutes.map((minute, index) => (
                <button
                  key={minute}
                  type="button"
                  aria-pressed={active === index}
                  onClick={() => setActive(index)}
                >
                  <i className={`study-band-${index}`} aria-hidden="true" />
                  {minute} min
                </button>
              ))}
            </div>
            <div className="study-metrics" aria-live="polite">
              <div className="study-residents">
                <p>Estimated residents</p>
                <strong>{stats ? estimatedCount(stats.residents) : '—'}</strong>
              </div>
              <dl>
                <div>
                  <dt>Households</dt>
                  <dd>{stats ? estimatedCount(stats.households) : '—'}</dd>
                </div>
                <div>
                  <dt>Renter households</dt>
                  <dd>
                    {stats && stats.households > 0
                      ? percentage.format(stats.renters / stats.households)
                      : '—'}
                  </dd>
                </div>
              </dl>
            </div>
            <div
              className="study-comparison"
              aria-label="Estimated residents by drive time"
            >
              {minutes.map((minute, index) => {
                const residents = result?.stats[index].residents ?? 0
                return (
                  <div key={minute} data-active={active === index}>
                    <span>{minute} min</span>
                    <span className="study-bar" aria-hidden="true">
                      <i
                        className={`study-band-${index}`}
                        style={{
                          width: `${total ? (100 * residents) / total : 0}%`,
                        }}
                      />
                    </span>
                    <span>{result ? estimatedCount(residents) : '—'}</span>
                  </div>
                )
              })}
            </div>
          </div>
          {busy && (
            <p className="study-status" role="status">
              Calculating drive areas…
            </p>
          )}
          {map && error && (
            <p className="study-status study-alert" role="alert">
              {error}
            </p>
          )}
          {result?.clipped && (
            <p className="study-status">
              The 15-minute drive reaches the edge of the road snapshot. Counts
              may be low.
            </p>
          )}
        </aside>
      </div>

      <div className="study-bottom">
        <section aria-labelledby="study-properties">
          <h2 id="study-properties">Property listings</h2>
          <p>
            Import a HomeHarvest-style CSV with latitude and longitude. The file
            stays in this tab.
          </p>
          <label className="study-file">
            Choose listings CSV
            <input type="file" accept=".csv,text/csv" onChange={importFile} />
          </label>
          {importError && (
            <p role="alert" className="study-alert">
              {importError}
            </p>
          )}
          {listings && (
            <>
              <p role="status">
                {listings.length} loaded.{' '}
                {result
                  ? `${matching.length} within the ${minutes[active]}-minute area.`
                  : 'Run a study to see matches.'}
              </p>
              {matching.length > 0 && (
                <ul className="study-listings">
                  {matching.slice(0, 8).map((listing, index) => (
                    <li key={index}>
                      <span>{listing.address}</span>
                      <span>
                        {[
                          listing.price === null
                            ? ''
                            : dollars.format(listing.price),
                          listing.status,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {matching.length > 8 && (
                <p>
                  Showing the first 8 listings. Use the wider map to see matches
                  beyond the default view.
                </p>
              )}
              <button
                type="button"
                className="study-remove"
                onClick={() => {
                  importId.current++
                  setListings(undefined)
                  setImportError('')
                }}
              >
                Clear listings
              </button>
            </>
          )}
        </section>
        <section aria-labelledby="study-method">
          <h2 id="study-method">How it’s estimated</h2>
          <p>
            Drive areas use modeled speeds on{' '}
            <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>{' '}
            roads{map ? ` (${map.roads.date})` : ''} and a 250 m grid. They
            don’t account for traffic or turn restrictions.
          </p>
          <p>
            Counts are rounded estimates using area-weighted{' '}
            <a href="https://www.census.gov/topics/research/guidance/planning-databases.html">
              2020–2024 ACS
            </a>{' '}
            tract data. Each time window includes the shorter windows.
          </p>
          <p>
            Inspired by{' '}
            <a href="https://www.instagram.com/yehya_cre/reel/DgNtEF-pEcp/">
              Yehya’s site-selection reel
            </a>
            .
          </p>
        </section>
      </div>
    </section>
  )
}
