import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { searchMeetingPlaces, type MeetingPlace } from '@/lib/meeting-geocoder'
import type { MeetingNetwork } from '@/lib/meeting-point'

export type MeetingPlaceSearchProps = {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
  onSelect: (place: MeetingPlace) => void
  mode: 'city' | 'place'
  localPlaces: MeetingPlace[]
  bounds?: MeetingNetwork['bounds']
  placeholder: string
  onFocus?: () => void
  autoFocus?: boolean
  invalid?: boolean
  describedBy?: string
}

type RemoteState =
  | { kind: 'idle' }
  | { kind: 'waiting' | 'loading'; key: string }
  | { kind: 'ready'; key: string; places: MeetingPlace[] }
  | { kind: 'error'; key: string; message: string }

type Option = { place: MeetingPlace; source: 'local' | 'photon'; key: string }

export default function MeetingPlaceSearch({
  id,
  label,
  value,
  onValueChange,
  onSelect,
  mode,
  localPlaces,
  bounds,
  placeholder,
  onFocus,
  autoFocus,
  invalid,
  describedBy,
}: MeetingPlaceSearchProps) {
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<{ value: string; revision: number } | null>(
    null,
  )
  const [remote, setRemote] = useState<RemoteState>({ kind: 'idle' })
  const [highlight, setHighlight] = useState<string | null>(null)
  const revision = useRef(0)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const timer = useRef<number | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const query = value.trim()
  const west = bounds?.[0]
  const south = bounds?.[1]
  const east = bounds?.[2]
  const north = bounds?.[3]
  const requestKey = JSON.stringify([
    mode,
    west,
    south,
    east,
    north,
    query,
    edit?.revision,
  ])
  const eligible = open && edit?.value === value && query.length >= 3
  const currentRemote: RemoteState =
    eligible && remote.kind !== 'idle' && remote.key === requestKey
      ? remote
      : { kind: 'idle' }

  const cancelRequest = useCallback(() => {
    generation.current += 1
    controller.current?.abort()
    controller.current = null
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  useEffect(() => {
    if (!open || !edit || edit.value !== value || query.length < 3) return
    cancelRequest()
    const currentGeneration = generation.current
    setRemote({ kind: 'waiting', key: requestKey })
    timer.current = window.setTimeout(() => {
      timer.current = null
      const abort = new AbortController()
      controller.current = abort
      setRemote({ kind: 'loading', key: requestKey })
      const searchBounds: MeetingNetwork['bounds'] | undefined =
        west !== undefined &&
        south !== undefined &&
        east !== undefined &&
        north !== undefined
          ? [west, south, east, north]
          : undefined
      void searchMeetingPlaces({
        query,
        mode,
        bounds: searchBounds,
        signal: abort.signal,
      })
        .then((places) => {
          if (generation.current !== currentGeneration || abort.signal.aborted)
            return
          setRemote({ kind: 'ready', key: requestKey, places })
        })
        .catch((error: unknown) => {
          if (generation.current !== currentGeneration || abort.signal.aborted)
            return
          setRemote({
            kind: 'error',
            key: requestKey,
            message:
              error instanceof Error
                ? error.message
                : 'Address search is unavailable.',
          })
        })
    }, 500)
    return cancelRequest
  }, [
    open,
    edit,
    value,
    query,
    mode,
    west,
    south,
    east,
    north,
    requestKey,
    cancelRequest,
  ])

  // Also covers unmounts while no search effect is active.
  useEffect(() => cancelRequest, [cancelRequest])

  const options = useMemo(() => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const matches: Option[] = []
    const ids = new Set<string>()
    const locations = new Set<string>()
    const append = (place: MeetingPlace, source: Option['source']) => {
      const location = `${place.name.toLocaleLowerCase()}:${place.coordinate[0].toFixed(4)},${place.coordinate[1].toFixed(4)}`
      if (ids.has(place.id) || locations.has(location)) return
      ids.add(place.id)
      locations.add(location)
      matches.push({ place, source, key: `${source}:${place.id}` })
    }
    for (const place of localPlaces) {
      const searchable = `${place.name} ${place.context}`.toLocaleLowerCase()
      if (words.every((word) => searchable.includes(word)))
        append(place, 'local')
      if (matches.length === 7) break
    }
    if (currentRemote.kind === 'ready') {
      for (const place of currentRemote.places) {
        append(place, 'photon')
        if (matches.length === 12) break
      }
    }
    return matches
  }, [
    query,
    localPlaces,
    currentRemote.kind,
    currentRemote.kind === 'ready' ? currentRemote.places : null,
  ])
  const highlightedIndex = options.findIndex(
    (option) => option.key === highlight,
  )
  const activeIndex = options.length ? Math.max(0, highlightedIndex) : -1
  const activeOption = options[activeIndex]
  const activeId =
    open && activeOption
      ? `${id}-option-${encodeURIComponent(activeOption.key)}`
      : undefined
  const localCount = options.filter(
    (option) => option.source === 'local',
  ).length
  const localStatus = localCount
    ? `${localCount} local ${localCount === 1 ? 'suggestion remains' : 'suggestions remain'} available.`
    : 'No local matches.'
  let status: string
  if (!open) {
    status = ''
  } else if (query.length < 3) {
    status = `Type at least 3 characters to search ${mode === 'city' ? 'cities' : 'addresses and landmarks'}. ${localStatus}`
  } else if (
    currentRemote.kind === 'waiting' ||
    currentRemote.kind === 'loading'
  ) {
    status = `${currentRemote.kind === 'waiting' ? 'Waiting to search' : 'Searching'} ${mode === 'city' ? 'cities' : 'this area'}. ${localStatus}`
  } else if (currentRemote.kind === 'error') {
    status = `External search unavailable. ${currentRemote.message} ${localStatus}`
  } else if (currentRemote.kind === 'ready') {
    status = currentRemote.places.length
      ? `${options.length} ${options.length === 1 ? 'suggestion' : 'suggestions'} available. Use arrow keys, then Enter to choose.`
      : `No external matches${mode === 'place' ? ' in this area' : ''}. ${localStatus}`
  } else {
    status = `Edit to search ${mode === 'city' ? 'cities' : 'addresses and landmarks'}. ${localStatus}`
  }

  useEffect(() => {
    if (open && activeIndex >= 0)
      list.current?.children
        .item(activeIndex)
        ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId, activeIndex])

  const close = () => {
    cancelRequest()
    setOpen(false)
    setEdit(null)
    setRemote({ kind: 'idle' })
    setHighlight(null)
  }
  const choose = (place: MeetingPlace) => {
    close()
    onSelect(place)
  }

  return (
    <div className="relative min-w-0 flex-1">
      <label
        htmlFor={id}
        className="text-muted-foreground block text-[0.625rem] font-medium tracking-wider uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        className="focus-visible:ring-ring w-full min-w-0 bg-transparent py-1 text-sm outline-none focus-visible:rounded-sm focus-visible:ring-2"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined}
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        aria-describedby={[describedBy, `${id}-status`]
          .filter(Boolean)
          .join(' ')}
        value={value}
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={() => {
          setOpen(true)
          setHighlight(null)
          onFocus?.()
        }}
        onBlur={close}
        onChange={(event) => {
          const nextValue = event.target.value
          cancelRequest()
          revision.current += 1
          setRemote({ kind: 'idle' })
          setEdit({ value: nextValue, revision: revision.current })
          setOpen(true)
          setHighlight(null)
          onValueChange(nextValue)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            const nextIndex = !open
              ? event.key === 'ArrowDown'
                ? 0
                : options.length - 1
              : Math.max(
                  0,
                  Math.min(
                    options.length - 1,
                    activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
                  ),
                )
            setHighlight(options[nextIndex]?.key ?? null)
          } else if (open && (event.key === 'Home' || event.key === 'End')) {
            event.preventDefault()
            setHighlight(
              options[event.key === 'Home' ? 0 : options.length - 1]?.key ??
                null,
            )
          } else if (open && event.key === 'Enter') {
            // Submitting raw typed text never creates a selected location.
            event.preventDefault()
            if (activeOption) choose(activeOption.place)
          }
        }}
      />
      <div
        className={
          open
            ? 'bg-popover absolute top-full z-20 mt-1 max-h-72 w-full min-w-0 overflow-auto rounded-lg border p-1 shadow-lg'
            : 'sr-only'
        }
      >
        {open && (
          <ul
            id={`${id}-options`}
            ref={list}
            role="listbox"
            aria-label={`${label} suggestions`}
            aria-busy={currentRemote.kind === 'loading'}
          >
            {options.map((option, index) => (
              <li
                key={option.key}
                id={`${id}-option-${encodeURIComponent(option.key)}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`cursor-pointer rounded-md px-3 py-3 text-sm ${index === activeIndex ? 'bg-accent text-accent-foreground' : ''}`}
                onMouseDown={(event) => {
                  // Keep input focus without cancelling touch scrolling.
                  if (event.button === 0) event.preventDefault()
                }}
                onClick={() => choose(option.place)}
                onPointerMove={(event) => {
                  if (event.pointerType !== 'touch') setHighlight(option.key)
                }}
              >
                <span className="block break-words">{option.place.name}</span>
                {option.place.context && (
                  <span className="text-muted-foreground block text-xs break-words">
                    {option.place.context}
                  </span>
                )}
                <span className="text-muted-foreground block text-[0.625rem]">
                  {option.source === 'local'
                    ? 'Local network'
                    : 'Photon / OpenStreetMap'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p
          id={`${id}-status`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-muted-foreground px-3 py-2 text-xs"
        >
          {status}
        </p>
      </div>
    </div>
  )
}
