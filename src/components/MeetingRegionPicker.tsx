import { useRef, useState } from 'react'
import { ArrowRight, LocateFixed, Plus, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { originColor } from '@/components/MeetingMap'
import MeetingPlaceSearch from '@/components/MeetingPlaceSearch'
import { areaFromPeople, boxCenter, MAX_PEOPLE } from '@/lib/meeting-area'
import type { MeetingPlace } from '@/lib/meeting-geocoder'
import { boundsSizeKm, MAX_LIVE_AREA_KM2 } from '@/lib/meeting-network'
import {
  regionBounds,
  type NetworkRequest,
  type StudySize,
} from '@/lib/meeting-network-loader'
import {
  sfRegion,
  type Coordinate,
  type MeetingNetwork,
} from '@/lib/meeting-point'
import type { Landmark } from '@/lib/meeting-session'

/** An area to load. Areas made from people's locations also carry them as starts, in order. */
export type Region = NetworkRequest & {
  id: string
  name: string
  starts?: Landmark[]
}

export type MeetingRegionPickerProps = {
  region: Region
  busy: boolean
  onLoad: (region: Region) => void
}

export const defaultRegion: Region = {
  kind: 'preset',
  id: 'sf',
  name: sfRegion.name,
  dataUrl: sfRegion.dataUrl,
}
const sfPlace: MeetingPlace = {
  id: 'preset:sf',
  name: sfRegion.name,
  context: 'California, United States (reel preset)',
  coordinate: [-122.4194, 37.7749],
}
const sfPlaces = [sfPlace]
const noPlaces: MeetingPlace[] = []
const deviceName = 'Your location'
// Above this, loading takes long enough to say so before it starts.
const LARGE_AREA_KM2 = 150
// The live-area limit as a square people can picture, to the nearest 10 km.
const MAX_SIDE_TEXT = Math.round(Math.sqrt(MAX_LIVE_AREA_KM2) / 10) * 10

type Method = 'city' | 'people'
type Person = {
  id: number
  query: string
  chosen: {
    name: string
    coordinate: Coordinate
    // Device positions never reach Photon, not even inside a search bias.
    device: boolean
    accuracy: number | null
  } | null
  // Token of the device-location request this row is waiting for.
  locating: number | null
  error: string
}

const blankPerson = (id: number): Person => ({
  id,
  query: '',
  chosen: null,
  locating: null,
  error: '',
})

function distanceText(km: number, fractionDigits: number): string {
  return km < 1
    ? `${Math.max(10, Math.round(km * 100) * 10)} m`
    : `${km.toLocaleString('en', { maximumFractionDigits: fractionDigits })} km`
}

/** Width × height of bounds as people read it: whole km from 10 km, else one decimal. */
export function sizeText(bounds: MeetingNetwork['bounds']): string {
  const { widthKm, heightKm } = boundsSizeKm(bounds)
  const km = (value: number) =>
    value.toLocaleString('en', { maximumFractionDigits: value < 10 ? 1 : 0 })
  return `${km(widthKm)} × ${km(heightKm)} km`
}

function CityChoice({
  region,
  busy,
  hidden,
  onLoad,
}: MeetingRegionPickerProps & { hidden: boolean }) {
  const [query, setQuery] = useState(sfPlace.name)
  const [chosen, setChosen] = useState<MeetingPlace | null>(sfPlace)
  const [sizeKm, setSizeKm] = useState<StudySize>(8)
  let target: Region | null = null
  let problem = ''
  if (chosen?.id === sfPlace.id) target = defaultRegion
  else if (chosen) {
    try {
      target = {
        kind: 'live',
        id: `${chosen.id}/${chosen.coordinate.join(',')}/${sizeKm}`,
        name: [chosen.name, chosen.context].filter(Boolean).join(', '),
        bounds: regionBounds(chosen.coordinate, sizeKm),
      }
    } catch (error) {
      // regionBounds refuses places beyond 85° north or south.
      problem =
        Math.abs(chosen.coordinate[1]) > 85
          ? `${chosen.name} is too far north or south for the map. Choose a place between 85° south and 85° north.`
          : String(error instanceof Error ? error.message : error)
    }
  }
  const loadingTarget = busy && target?.id === region.id
  return (
    <div hidden={hidden} className="space-y-4">
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="rounded-lg border p-3">
          <MeetingPlaceSearch
            id="meeting-city"
            label="City or town"
            value={query}
            mode="city"
            localPlaces={sfPlaces}
            placeholder="Search any city or town"
            onValueChange={(value) => {
              setQuery(value)
              setChosen(null)
            }}
            onSelect={(place) => {
              setQuery(place.name)
              setChosen(place)
            }}
          />
        </div>
        <Button
          disabled={!target || loadingTarget}
          aria-busy={loadingTarget}
          onClick={() => {
            if (target) onLoad(target)
          }}
        >
          {loadingTarget ? 'Loading area…' : 'Load walking network'}
          <ArrowRight />
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-sm">
          {problem}
        </p>
      )}
      {chosen && chosen.id !== sfPlace.id && (
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="mb-2 text-sm font-medium">Study area width</legend>
          {([4, 8, 12] satisfies StudySize[]).map((size) => (
            <label
              key={size}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${sizeKm === size ? 'border-foreground/50 bg-muted/50' : 'hover:bg-muted/30'}`}
            >
              <input
                type="radio"
                name="meeting-study-size"
                className="accent-foreground"
                checked={sizeKm === size}
                onChange={() => setSizeKm(size)}
              />
              {size} km
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">
        {chosen?.id === sfPlace.id
          ? 'The SF preset uses the bundled walking-network snapshot and original four starts.'
          : `Live areas cover up to ${sizeKm} × ${sizeKm} km around the selected city center, not its administrative boundary. Bigger and denser areas take longer to load.`}
      </p>
      <Button
        variant="outline"
        onClick={() => {
          setQuery(sfPlace.name)
          setChosen(sfPlace)
          onLoad(defaultRegion)
        }}
        disabled={busy && region.kind === 'preset'}
      >
        <RotateCcw />
        Use SF reel preset
      </Button>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Typed city, address and landmark queries go to Photon. Loading a live
        area sends its bounds to Overpass. These public services can be busy or
        unavailable. Road graphs are saved locally; autocomplete uses only a
        short-lived, in-memory cache, not saved search history.
      </p>
    </div>
  )
}

function PersonRow({
  person,
  index,
  near,
  removable,
  autoFocus,
  onQuery,
  onSelect,
  onLocate,
  onRemove,
}: {
  person: Person
  index: number
  near: Coordinate | undefined
  removable: boolean
  autoFocus: boolean
  onQuery: (value: string) => void
  onSelect: (place: MeetingPlace) => void
  onLocate: () => void
  onRemove: () => void
}) {
  const id = `meeting-person-${person.id}`
  const letter = String.fromCharCode(65 + index)
  const hint =
    person.locating !== null
      ? 'Finding this device’s location…'
      : person.error ||
        (person.chosen?.device
          ? `From this device${person.chosen.accuracy === null ? '' : `, accurate to about ${distanceText(person.chosen.accuracy / 1000, 1)}`}. It stays in this browser.`
          : !person.chosen && person.query.trim()
            ? 'Choose a suggestion, or use this device’s location.'
            : '')
  return (
    <li>
      <div className="bg-background flex items-center gap-2 rounded-lg border p-2">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-md border text-sm font-semibold"
          style={{ borderColor: originColor(index) }}
        >
          {letter}
        </span>
        <div className="min-w-0 flex-1">
          <MeetingPlaceSearch
            id={id}
            label={`Person ${letter}`}
            value={person.query}
            mode="anywhere"
            near={near}
            localPlaces={noPlaces}
            placeholder="Address or landmark"
            autoFocus={autoFocus}
            invalid={
              Boolean(person.error) ||
              (!person.chosen && person.query.trim().length > 0)
            }
            describedBy={hint ? `${id}-hint` : undefined}
            onValueChange={onQuery}
            onSelect={onSelect}
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={`Use this device’s location for person ${letter}`}
          aria-busy={person.locating !== null}
          disabled={person.locating !== null}
          onClick={onLocate}
        >
          <LocateFixed />
        </Button>
        <Button
          variant="destructive"
          size="icon"
          className="shrink-0"
          aria-label={`Remove person ${letter}`}
          disabled={!removable}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {hint && (
        <p
          id={`${id}-hint`}
          role={person.error ? 'alert' : undefined}
          className="text-muted-foreground mt-1 px-2 text-xs"
        >
          {hint}
        </p>
      )}
    </li>
  )
}

function PeopleChoice({
  region,
  busy,
  hidden,
  onLoad,
}: MeetingRegionPickerProps & { hidden: boolean }) {
  const [people, setPeople] = useState<Person[]>(() => [
    blankPerson(0),
    blankPerson(1),
  ])
  const [focusId, setFocusId] = useState<number | null>(null)
  const nextId = useRef(2)
  const nextLocate = useRef(0)
  const update = (id: number, change: (person: Person) => Person) =>
    setPeople((items) =>
      items.map((item) => (item.id === id ? change(item) : item)),
    )
  const chosen = people.flatMap((person, row) =>
    person.chosen ? [{ ...person.chosen, row }] : [],
  )
  // Bias searches toward places already found; device positions never go to Photon.
  const near =
    boxCenter(
      chosen.flatMap((choice) => (choice.device ? [] : [choice.coordinate])),
    ) ?? undefined
  const unfinished = people.length - chosen.length
  const area = areaFromPeople(chosen.map((choice) => choice.coordinate))
  const target: Region | null =
    area.kind === 'area' && unfinished === 0
      ? {
          kind: 'live',
          id: `people/${chosen.map((choice) => choice.coordinate.join(',')).join(';')}`,
          name: `Area around ${chosen.length} people`,
          bounds: area.bounds,
          starts: chosen.map(({ name, coordinate }) => ({ name, coordinate })),
        }
      : null
  const loadingTarget = busy && target?.id === region.id
  let summary: string
  if (area.kind === 'too-few') {
    summary =
      area.count === 0
        ? 'Choose where at least two people are starting to see which area will load.'
        : 'Choose one more location to see which area will load.'
  } else if (area.kind === 'invalid') {
    const letter = String.fromCharCode(65 + chosen[area.index].row)
    summary = `Person ${letter} is too far north or south for the map. Choose a place between 85° south and 85° north.`
  } else if (area.kind === 'too-large') {
    summary = `The locations spread across about ${distanceText(area.spanKm, area.spanKm < 100 ? 1 : 0)}. The lab loads one area of up to about ${MAX_LIVE_AREA_KM2.toLocaleString('en')} km² (roughly ${MAX_SIDE_TEXT} × ${MAX_SIDE_TEXT} km). Check that each address is the right one, or choose the area by city instead.`
  } else {
    summary = `The locations spread across about ${distanceText(area.spanKm, 1)}, so the lab will load about ${sizeText(area.bounds)} around everyone.`
    if (area.widthKm * area.heightKm > LARGE_AREA_KM2)
      summary += ' A large area can take a few minutes to load.'
    if (unfinished)
      summary += ` ${unfinished === 1 ? 'One row still needs' : `${unfinished} rows still need`} a chosen location before loading.`
  }

  const locate = (id: number) => {
    const token = ++nextLocate.current
    const fail = (message: string) =>
      setPeople((items) =>
        items.map((item) =>
          item.id === id && item.locating === token
            ? { ...item, locating: null, error: message }
            : item,
        ),
      )
    update(id, (person) => ({ ...person, locating: token, error: '' }))
    if (!navigator.geolocation) {
      fail('This browser can’t share its location. Search for the address instead.')
      return
    }
    try {
      navigator.geolocation.getCurrentPosition(
        ({ coords: { longitude, latitude, accuracy } }) => {
          if (
            !Number.isFinite(longitude) ||
            !Number.isFinite(latitude) ||
            Math.abs(longitude) > 180 ||
            Math.abs(latitude) > 90
          ) {
            fail(
              'This device reported a location that can’t be used. Search for the address instead.',
            )
            return
          }
          // The device position is labelled locally, with no reverse lookup.
          setPeople((items) =>
            items.map((item) =>
              item.id === id && item.locating === token
                ? {
                    ...item,
                    query: deviceName,
                    chosen: {
                      name: deviceName,
                      coordinate: [longitude, latitude],
                      device: true,
                      accuracy:
                        Number.isFinite(accuracy) && accuracy >= 0
                          ? accuracy
                          : null,
                    },
                    locating: null,
                    error: '',
                  }
                : item,
            ),
          )
        },
        (error) =>
          fail(
            error.code === error.PERMISSION_DENIED
              ? 'Location access is blocked for this site. Allow it in your browser settings, or search for the address instead.'
              : error.code === error.TIMEOUT
                ? 'Finding this device’s location took more than 10 seconds. Try again, or search for the address instead.'
                : 'This device couldn’t work out where it is. Try again, or search for the address instead.',
          ),
        { enableHighAccuracy: false, timeout: 10_000 },
      )
    } catch {
      fail('This browser can’t share its location. Search for the address instead.')
    }
  }

  return (
    <div hidden={hidden} className="space-y-4">
      <ol className="space-y-2">
        {people.map((person, index) => (
          <PersonRow
            key={person.id}
            person={person}
            index={index}
            near={near}
            removable={people.length > 2}
            autoFocus={person.id === focusId}
            onQuery={(value) =>
              update(person.id, (item) => ({
                ...item,
                query: value,
                chosen: null,
                locating: null,
                error: '',
              }))
            }
            onSelect={(place) => {
              const name = [place.name, place.context]
                .filter(Boolean)
                .join(', ')
              update(person.id, (item) => ({
                ...item,
                query: name,
                chosen: {
                  name,
                  coordinate: place.coordinate,
                  device: false,
                  accuracy: null,
                },
                locating: null,
                error: '',
              }))
            }}
            onLocate={() => locate(person.id)}
            onRemove={() =>
              setPeople((items) =>
                items.filter((item) => item.id !== person.id),
              )
            }
          />
        ))}
      </ol>
      <Button
        variant="outline"
        className="w-full"
        disabled={people.length >= MAX_PEOPLE}
        onClick={() => {
          const id = nextId.current++
          setPeople((items) => [...items, blankPerson(id)])
          setFocusId(id)
        }}
      >
        <Plus />
        {people.length >= MAX_PEOPLE
          ? `Up to ${MAX_PEOPLE} people`
          : 'Add a person'}
      </Button>
      <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <p className="text-sm" role="status" aria-live="polite">
          {summary}
        </p>
        <Button
          disabled={!target || loadingTarget}
          aria-busy={loadingTarget}
          onClick={() => {
            if (target) onLoad(target)
          }}
        >
          {loadingTarget ? 'Loading area…' : 'Load walking network'}
          <ArrowRight />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Typed addresses and landmarks go to Photon, with the middle of places
        already found there so nearby results come first. Loading sends only
        the area’s bounds to Overpass. A location from this device stays in this
        browser; it only shapes those bounds. People and their locations are
        not saved; the area’s road map may be kept on this device for up to
        seven days, like any other area.
      </p>
    </div>
  )
}

/** Chooses the area to load: around a city (default) or around everyone's locations. */
export default function MeetingRegionPicker({
  region,
  busy,
  onLoad,
}: MeetingRegionPickerProps) {
  const [method, setMethod] = useState<Method>('city')
  return (
    <section
      className="bg-card space-y-4 rounded-xl border p-4 sm:p-5"
      aria-labelledby="meeting-area"
    >
      <div>
        <h2 id="meeting-area" className="text-lg font-semibold">
          Choose an area
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {method === 'city'
            ? 'Select a city or town, then load its walking network.'
            : 'Add where each person is starting. An area sized to fit everyone loads, and they become the starting points.'}{' '}
          Loading an area resets starting points and results.
        </p>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Base the area on</legend>
        <div className="flex flex-wrap gap-3">
          {(
            [
              { value: 'city', title: 'A city or town' },
              { value: 'people', title: 'Everyone’s locations' },
            ] satisfies { value: Method; title: string }[]
          ).map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${method === option.value ? 'border-foreground/50 bg-muted/50' : 'hover:bg-muted/30'}`}
            >
              <input
                type="radio"
                name="meeting-area-method"
                className="accent-foreground"
                checked={method === option.value}
                onChange={() => setMethod(option.value)}
              />
              {option.title}
            </label>
          ))}
        </div>
      </fieldset>
      <CityChoice
        region={region}
        busy={busy}
        hidden={method !== 'city'}
        onLoad={onLoad}
      />
      <PeopleChoice
        region={region}
        busy={busy}
        hidden={method !== 'people'}
        onLoad={onLoad}
      />
    </section>
  )
}
