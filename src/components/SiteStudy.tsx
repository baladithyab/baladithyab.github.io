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
  isStudyOrigin,
  maxStudyPoints,
  minutes,
  originBounds,
  project,
  sites,
  type MatchMode,
  type StudyResult,
} from '../lib/site-study'
import { distanceBetween } from '../lib/meeting-point'
import { searchMeetingPlaces, type MeetingPlace } from '../lib/meeting-geocoder'
import {
  drawBase,
  drawOverlay,
  mapCoordinate,
  mapPixel,
} from '../lib/site-study-map'
import {
  matchesListingFilters,
  parseListings,
  type Listing,
  type ListingFilters,
  type LiveListingSnapshot,
} from '../lib/site-study-listings'
import type { StudyRequest, StudyResponse } from '../scripts/site-study.worker'
import SiteStudyPropertyReport from './SiteStudyPropertyReport'
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
type Selection = { sites: Site[]; mode: MatchMode }
const initialSelection: Selection = { sites: [sites[0]], mode: 'all' }
const initialFilters: ListingFilters = {
  kind: 'all',
  maxPrice: '',
  minBeds: '',
  minSqft: '',
}

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const darkTheme = () => document.documentElement.classList.contains('dark')
const defaultTheme = () => false

export default function SiteStudy() {
  const worker = useRef<Worker | null>(null)
  const pending = useRef({ id: 1, selection: initialSelection })
  const settled = useRef(initialSelection)
  const search = useRef<AbortController | null>(null)
  const listingsRequestId = useRef(0)
  const liveRequest = useRef<AbortController | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const isDark = useSyncExternalStore(subscribeToTheme, darkTheme, defaultTheme)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [map, setMap] = useState<StudyMap>()
  const [selection, setSelection] = useState(initialSelection)
  const [report, setReport] = useState<{
    selection: Selection
    result: StudyResult
  }>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [active, setActive] = useState(1)
  const [wide, setWide] = useState(false)
  const [listings, setListings] = useState<Listing[]>()
  const [listingError, setListingError] = useState('')
  const [loadingLive, setLoadingLive] = useState(false)
  const [liveSnapshot, setLiveSnapshot] = useState<LiveListingSnapshot>()
  const [filters, setFilters] = useState(initialFilters)
  const [chosenListing, setChosenListing] = useState<Listing>()
  const [places, setPlaces] = useState<MeetingPlace[]>()
  const [addressStatus, setAddressStatus] = useState('')

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
      if (data.kind === 'error') {
        setError(data.message)
        pending.current.selection = settled.current
        setSelection(settled.current)
      } else {
        settled.current = pending.current.selection
        setReport({ selection: settled.current, result: data.result })
      }
    }
    runner.onerror = () => {
      setBusy(false)
      setError('The drive study could not start. Reload to try again.')
    }
    const { id, selection } = pending.current
    runner.postMessage({
      id,
      coordinates: selection.sites.map((site) => site.coordinate),
      mode: selection.mode,
    } satisfies StudyRequest)
    return () => {
      worker.current = null
      runner.terminate()
      search.current?.abort()
      liveRequest.current?.abort()
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

  const result = report?.result
  const points = useMemo(
    () =>
      report?.selection === selection
        ? report.result.points
        : selection.sites.map((site) => project(site.coordinate)),
    [report, selection],
  )
  const matching = useMemo(
    () =>
      map && result && listings
        ? listings.filter((listing) => {
            const index = cellIndex(map.census, project(listing.coordinate))
            return (
              index >= 0 &&
              result.times[index] <= minutes[active] * 60 &&
              matchesListingFilters(listing, filters)
            )
          })
        : [],
    [map, result, listings, active, filters],
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
        points,
        active,
        matching,
        wide,
        isDark,
      )
  }, [map, size, result, points, active, matching, wide, isDark])

  const analyze = (next: Selection) => {
    const id = pending.current.id + 1
    pending.current = { id, selection: next }
    setSelection(next)
    setError('')
    if (!next.sites.length) {
      settled.current = next
      setReport(undefined)
      setBusy(false)
      return
    }
    setBusy(true)
    worker.current?.postMessage({
      id,
      coordinates: next.sites.map((site) => site.coordinate),
      mode: next.mode,
    } satisfies StudyRequest)
  }

  const addSite = (site: Site) => {
    const current = pending.current.selection
    if (!isStudyOrigin(site.coordinate))
      return setError('Choose a point inside the dashed study boundary.')
    if (current.sites.length >= maxStudyPoints)
      return setError(
        `Remove a point to add another. The limit is ${maxStudyPoints}.`,
      )
    if (
      current.sites.some(
        (existing) =>
          distanceBetween(existing.coordinate, site.coordinate) < 25,
      )
    )
      return setError('A point is already selected there.')
    analyze({ ...current, sites: [...current.sites, site] })
  }

  const removeSite = (index: number) => {
    const current = pending.current.selection
    analyze({ ...current, sites: current.sites.filter((_, i) => i !== index) })
  }

  const selectPoint = (event: MouseEvent<HTMLCanvasElement>) => {
    const { left, top, width, height } =
      event.currentTarget.getBoundingClientRect()
    addSite({
      name: 'Map point',
      coordinate: mapCoordinate(
        width,
        height,
        event.clientX - left,
        event.clientY - top,
        wide,
      ),
    })
  }

  const removeMapPoint = (event: MouseEvent<HTMLCanvasElement>) => {
    const { left, top, width, height } =
      event.currentTarget.getBoundingClientRect()
    let best = 18
    let nearest = -1
    points.forEach((point, index) => {
      const [x, y] = mapPixel(width, height, point, wide)
      const distance = Math.hypot(
        x - (event.clientX - left),
        y - (event.clientY - top),
      )
      if (distance >= best) return
      best = distance
      nearest = index
    })
    if (nearest < 0) return
    event.preventDefault()
    removeSite(nearest)
  }

  const selectCoordinates = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    addSite({
      name: 'Coordinate point',
      coordinate: [
        Number(values.get('longitude')),
        Number(values.get('latitude')),
      ],
    })
  }

  const findAddress = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const query = String(
      new FormData(event.currentTarget).get('address') ?? '',
    ).trim()
    search.current?.abort()
    setPlaces(undefined)
    if (query.length < 3)
      return setAddressStatus('Enter at least three characters.')
    const controller = new AbortController()
    search.current = controller
    setAddressStatus('Searching San José…')
    try {
      const found = await searchMeetingPlaces({
        query,
        mode: 'place',
        bounds: [...originBounds],
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setPlaces(found)
      setAddressStatus(
        found.length ? '' : 'No addresses or places found in the study area.',
      )
    } catch (failure) {
      if (!controller.signal.aborted)
        setAddressStatus(
          failure instanceof Error
            ? failure.message
            : 'Address search is unavailable.',
        )
    }
  }

  const loadLiveListings = async () => {
    const id = ++listingsRequestId.current
    liveRequest.current?.abort()
    const controller = new AbortController()
    liveRequest.current = controller
    setLoadingLive(true)
    setListingError('')
    try {
      const response = await fetch(
        '/api/lab/real-estate-due-diligence/listings',
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(22_000),
          ]),
        },
      )
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? 'Live listings are busy. Try again in a minute.'
            : 'Live listings could not be loaded. Try again, or import a CSV.',
        )
      const snapshot = (await response.json()) as LiveListingSnapshot
      if (id !== listingsRequestId.current || controller.signal.aborted) return
      setChosenListing(undefined)
      setListings(snapshot.listings)
      setLiveSnapshot(snapshot)
    } catch (failure) {
      if (id === listingsRequestId.current && !controller.signal.aborted) {
        setListingError(
          failure instanceof Error && failure.name === 'Error'
            ? failure.message
            : 'Live listings could not be loaded. Try again, or import a CSV.',
        )
      }
    } finally {
      if (id === listingsRequestId.current && !controller.signal.aborted)
        setLoadingLive(false)
    }
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    const id = ++listingsRequestId.current
    liveRequest.current?.abort()
    setLoadingLive(false)
    setListingError('')
    try {
      if (file.size > 1024 * 1024)
        throw new Error('Choose a CSV file up to 1 MB.')
      const rows = parseListings(await file.text())
      if (id === listingsRequestId.current) {
        setChosenListing(undefined)
        setListings(rows)
        setLiveSnapshot(undefined)
      }
    } catch (failure) {
      if (id === listingsRequestId.current)
        setListingError(
          failure instanceof Error
            ? failure.message
            : 'The CSV could not be read.',
        )
    }
  }

  const stats = result?.stats[active]
  const total = result?.stats[2].residents ?? 0
  const selectedListing =
    chosenListing && matching.includes(chosenListing)
      ? chosenListing
      : undefined
  const selectedCell =
    selectedListing && map
      ? cellIndex(map.census, project(selectedListing.coordinate))
      : -1
  const selectedDrives = report?.selection.sites.map((site, index) => {
    const seconds = report.result.pointTimes[index][selectedCell]
    return {
      ...site,
      minutes:
        Number.isFinite(seconds) && seconds <= minutes[2] * 60
          ? Math.ceil(seconds / 60)
          : null,
    }
  })
  const reportInput =
    selectedListing &&
    selectedDrives &&
    report &&
    map &&
    !busy &&
    report.selection === selection
      ? {
          listing: selectedListing,
          listingCheckedAt: liveSnapshot?.checkedAt ?? null,
          drives: selectedDrives,
          limit: minutes[active],
          mode: report.selection.mode,
          roadDate: map.roads.date,
          clipped: report.result.clipped,
        }
      : undefined
  return (
    <section className="site-study">
      <header className="site-study-heading">
        <div>
          <p className="study-region">San José, California</p>
          <h1>Real Estate Due Diligence</h1>
          <p>
            Find properties within a 5-, 10-, or 15-minute drive of the places
            you choose.
          </p>
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
            onContextMenu={map ? removeMapPoint : undefined}
            aria-hidden="true"
          />
          <p className="study-map-instruction">
            Click inside the boundary to add a point. Right-click a pin to
            remove it.
          </p>
          {map && busy && (
            <p className="study-map-progress" role="status">
              Calculating drive areas…
            </p>
          )}
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
              <span className="study-origin-dot" aria-hidden="true" />{' '}
              Destinations
            </div>
            <h2>Points of interest</h2>
            {selection.sites.length ? (
              <ol className="study-points">
                {selection.sites.map((site, index) => (
                  <li key={site.coordinate.join(',')}>
                    <span className="study-pin-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div>
                      <strong>{site.name}</strong>
                      <p className="study-coordinates">
                        {site.coordinate[1].toFixed(4)}°,{' '}
                        {site.coordinate[0].toFixed(4)}°
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove point ${index + 1}: ${site.name}`}
                      onClick={() => removeSite(index)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="study-coordinates">
                Add a map pin, example, or address.
              </p>
            )}
            <div className="study-presets" aria-label="Example sites">
              {sites.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  disabled={
                    !map ||
                    selection.sites.length >= maxStudyPoints ||
                    selection.sites.includes(preset)
                  }
                  onClick={() => addSite(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <form className="study-address" onSubmit={findAddress}>
              <label htmlFor="study-address-query">
                Add an address or place
              </label>
              <div>
                <input
                  id="study-address-query"
                  name="address"
                  type="search"
                  placeholder="Library, station, or address"
                  minLength={3}
                  maxLength={200}
                  required
                  onChange={() => {
                    search.current?.abort()
                    setPlaces(undefined)
                    setAddressStatus('')
                  }}
                />
                <button
                  type="submit"
                  disabled={!map || selection.sites.length >= maxStudyPoints}
                >
                  Find
                </button>
              </div>
            </form>
            {addressStatus && (
              <p className="study-coordinates" role="status">
                {addressStatus}
              </p>
            )}
            {places?.length ? (
              <ul
                className="study-address-results"
                aria-label="Address search results"
              >
                {places.map((place) => (
                  <li key={place.id}>
                    <button
                      type="button"
                      disabled={selection.sites.length >= maxStudyPoints}
                      onClick={() => {
                        addSite(place)
                        setPlaces(undefined)
                      }}
                    >
                      {place.name}
                      {place.context ? <span>{place.context}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
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
                  Add point
                </button>
              </form>
            </details>
          </div>

          <div className="study-results" aria-busy={busy}>
            <h3>Drive to selected points</h3>
            {selection.sites.length > 1 && (
              <div
                className="study-mode"
                role="group"
                aria-label="Match destinations"
              >
                {(['all', 'any'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selection.mode === mode}
                    onClick={() =>
                      analyze({ ...pending.current.selection, mode })
                    }
                  >
                    {mode === 'all' ? 'All points' : 'Any point'}
                  </button>
                ))}
              </div>
            )}
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
          {map && error && (
            <p className="study-status study-alert" role="alert">
              {error}
            </p>
          )}
          {result?.clipped && (
            <p className="study-status">
              A 15-minute drive reaches the edge of the road snapshot. Counts
              may be low.
            </p>
          )}
        </aside>
      </div>

      <div className="study-bottom">
        <section aria-labelledby="study-properties">
          <h2 id="study-properties">Property listings</h2>
          <p>
            Load a sample of homes for sale and rent in San José. The map
            filters the listings by drive time.
          </p>
          <button
            className="study-load-listings"
            type="button"
            onClick={loadLiveListings}
            disabled={loadingLive}
          >
            {loadingLive
              ? 'Loading live listings…'
              : liveSnapshot
                ? 'Reload live listings'
                : 'Load live listings'}
          </button>
          <details className="study-listing-import">
            <summary>Import your own CSV</summary>
            <label className="study-file">
              Choose listings CSV
              <input type="file" accept=".csv,text/csv" onChange={importFile} />
            </label>
            <p>Include latitude and longitude. The file stays in this tab.</p>
          </details>
          {listingError && (
            <p role="alert" className="study-alert">
              {listingError}
            </p>
          )}
          {liveSnapshot && (
            <p role="status">
              HomeHarvest · Up to 40 listings per type · Checked{' '}
              {new Date(liveSnapshot.checkedAt).toLocaleString()}
              {liveSnapshot.unavailable.length
                ? ` · ${liveSnapshot.unavailable.map((kind) => (kind === 'for_sale' ? 'Sale' : 'Rental')).join(' and ')} listings temporarily unavailable.`
                : ''}
            </p>
          )}
          {listings && (
            <>
              <div
                className="study-filters"
                aria-label="Listing filters"
                role="group"
              >
                <label>
                  Listing type
                  <select
                    value={filters.kind}
                    onChange={(event) =>
                      setFilters({
                        ...filters,
                        kind: event.target.value as ListingFilters['kind'],
                      })
                    }
                  >
                    <option value="all">All listings</option>
                    <option value="for sale">For sale</option>
                    <option value="for rent">For rent</option>
                  </select>
                </label>
                <label>
                  Maximum price or rent
                  <input
                    type="number"
                    min="0"
                    value={filters.maxPrice}
                    onChange={(event) =>
                      setFilters({ ...filters, maxPrice: event.target.value })
                    }
                  />
                </label>
                <label>
                  Minimum beds
                  <input
                    type="number"
                    min="0"
                    value={filters.minBeds}
                    onChange={(event) =>
                      setFilters({ ...filters, minBeds: event.target.value })
                    }
                  />
                </label>
                <label>
                  Minimum square feet
                  <input
                    type="number"
                    min="0"
                    value={filters.minSqft}
                    onChange={(event) =>
                      setFilters({ ...filters, minSqft: event.target.value })
                    }
                  />
                </label>
              </div>
              <p role="status">
                {listings.length} loaded.{' '}
                {result
                  ? `${matching.length} match your filters within the ${minutes[active]}-minute area.`
                  : 'Run a study to see matches.'}
              </p>
              {matching.length > 0 && (
                <ul className="study-listings">
                  {matching.map((listing, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        aria-pressed={selectedListing === listing}
                        onClick={() => setChosenListing(listing)}
                      >
                        {listing.address}
                      </button>
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
              {selectedListing && report && (
                <section
                  className="study-property-detail"
                  aria-label="Selected property"
                >
                  <h3>{selectedListing.address}</h3>
                  {selectedListing.sourceUrl && (
                    <p>
                      <a href={selectedListing.sourceUrl}>
                        View source listing
                      </a>
                    </p>
                  )}
                  <p>Estimated drive from this property</p>
                  <dl>
                    {selectedDrives?.map((site) => (
                      <div key={site.coordinate.join(',')}>
                        <dt>{site.name}</dt>
                        <dd>
                          {site.minutes === null
                            ? 'Beyond modeled 15 min'
                            : `≈ ${site.minutes} min`}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {reportInput && (
                    <p>
                      <a href="#study-report-title">Open due diligence</a>
                    </p>
                  )}
                </section>
              )}
              <button
                type="button"
                className="study-remove"
                onClick={() => {
                  listingsRequestId.current++
                  liveRequest.current?.abort()
                  setLoadingLive(false)
                  setListings(undefined)
                  setLiveSnapshot(undefined)
                  setChosenListing(undefined)
                  setFilters(initialFilters)
                  setListingError('')
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
      <SiteStudyPropertyReport input={reportInput} />
    </section>
  )
}
