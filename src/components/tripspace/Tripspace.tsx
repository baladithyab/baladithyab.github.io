import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, RotateCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { createTrip, recordSearch } from '@/lib/tripspace/actions'
import { sampleTrip } from '@/lib/tripspace/demo'
import { stageOf, type Stage, type Trip, type Watch } from '@/lib/tripspace/model'
import { searchEach } from '@/lib/tripspace/search'
import { loadStored, saveStored, setAside, type Stored } from '@/lib/tripspace/store'

import DecidePanel from './DecidePanel'
import HomePanel from './HomePanel'
import IdeasPanel from './IdeasPanel'
import PeoplePanel from './PeoplePanel'
import PlanPanel from './PlanPanel'
import PricesPanel from './PricesPanel'
import { Field, inputClass, Notice, Person, Segmented } from './parts'
import type { Tab } from './types'

const newId = () => crypto.randomUUID()

const STAGES: { stage: Stage; label: string }[] = [
  { stage: 'idea', label: 'Idea' },
  { stage: 'shortlist', label: 'Shortlist' },
  { stage: 'plan', label: 'Plan' },
  { stage: 'booked', label: 'Booked' },
]

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'home', label: 'Home' },
  { tab: 'people', label: 'People' },
  { tab: 'decide', label: 'Decide' },
  { tab: 'plan', label: 'Plan' },
  { tab: 'ideas', label: 'Ideas' },
  { tab: 'prices', label: 'Prices' },
]

function withSample(stored: Stored | null): Stored {
  const trip = sampleTrip({ newId, now: Date.now() })
  const owner = trip.members[0]
  return {
    version: 1,
    trips: [...(stored?.trips ?? []), trip],
    activeTripId: trip.id,
    actingAs: { ...(stored?.actingAs ?? {}), ...(owner ? { [trip.id]: owner.id } : {}) },
  }
}

export default function Tripspace() {
  const [stored, setStored] = useState<Stored | null>(null)
  const [storageNote, setStorageNote] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const storedRef = useRef<Stored | null>(null)
  storedRef.current = stored

  useEffect(() => {
    const result = loadStored(window.localStorage)
    if (result.kind === 'loaded' && result.stored.trips.length > 0) {
      setStored(result.stored)
      return
    }
    if (result.kind === 'unreadable') {
      setAside(window.localStorage, result.raw, Date.now())
      setStorageNote('A trip saved in this browser could not be read. It was kept aside and the sample trip opened instead.')
    }
    setStored(withSample(null))
  }, [])

  useEffect(() => {
    if (stored && !saveStored(window.localStorage, stored)) {
      setStorageNote('This browser did not let the page save. Changes will be lost when the tab closes.')
    }
  }, [stored])

  const updateTrip = useCallback((tripId: string, change: (trip: Trip) => Trip) => {
    setStored((prev) => (prev ? { ...prev, trips: prev.trips.map((t) => (t.id === tripId ? change(t) : t)) } : prev))
  }, [])

  const runWatches = useCallback(
    async (watches: Pick<Watch, 'id' | 'request'>[]) => {
      const tripId = storedRef.current?.activeTripId
      if (!tripId) return
      setBusy((prev) => new Set([...prev, ...watches.map((w) => w.id)]))
      await searchEach(
        watches.map((w) => ({ key: w.id, request: w.request })),
        (watchId, response) => {
          updateTrip(tripId, (t) => recordSearch(t, watchId, response, Date.now()))
          setBusy((prev) => new Set([...prev].filter((id) => id !== watchId)))
        },
      )
    },
    [updateTrip],
  )

  if (!stored) {
    return <p className="text-muted-foreground text-sm">Opening your trips.</p>
  }

  const trip = stored.trips.find((t) => t.id === stored.activeTripId) ?? stored.trips[0]
  if (!trip) return null
  const me = trip.members.find((m) => m.id === stored.actingAs[trip.id]) ?? trip.members[0]
  if (!me) return null
  const stage = stageOf(trip)
  const stageIndex = STAGES.findIndex((s) => s.stage === stage)

  const panelProps = {
    trip,
    me,
    update: (change: (t: Trip) => Trip) => updateTrip(trip.id, change),
    go: setTab,
    runWatches,
    busyWatches: busy,
  }

  return (
    <div className="space-y-8">
      {storageNote ? <Notice tone="error">{storageNote}</Notice> : null}

      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{trip.title}</h2>
            <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label="Trip stage">
              {STAGES.map((s, index) => (
                <li key={s.stage} className="flex items-center gap-2">
                  <span
                    aria-current={s.stage === stage ? 'step' : undefined}
                    className={cn(
                      'rounded-full px-2.5 py-0.5',
                      s.stage === stage ? 'bg-primary text-primary-foreground font-medium' : index < stageIndex ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                  {index < STAGES.length - 1 ? <span className="text-muted-foreground" aria-hidden>/</span> : null}
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
              <Plus aria-hidden /> New trip
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStored((prev) => withSample(prev))
                setTab('home')
              }}
            >
              <RotateCcw aria-hidden /> Open a fresh sample
            </Button>
          </div>
        </div>

        {creating ? (
          <NewTripForm
            onCreate={(title, ownerName) => {
              const created = createTrip({ title, ownerName, newId, now: Date.now() })
              setStored((prev) =>
                prev
                  ? {
                      ...prev,
                      trips: [...prev.trips, created],
                      activeTripId: created.id,
                      actingAs: { ...prev.actingAs, [created.id]: created.members[0]?.id ?? '' },
                    }
                  : prev,
              )
              setCreating(false)
              setTab('people')
            }}
          />
        ) : null}

        {stored.trips.length > 1 ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Trips in this browser</p>
            <Segmented
              label="Trip"
              options={stored.trips.map((t) => ({ value: t.id, label: t.title }))}
              value={trip.id}
              onChange={(tripId) => setStored((prev) => (prev ? { ...prev, activeTripId: tripId } : prev))}
            />
          </div>
        ) : null}

        <div className="bg-card space-y-2 rounded-lg border p-4">
          <p className="text-sm font-medium">You are acting as</p>
          <Segmented
            label="Acting as"
            options={trip.members.map((m) => ({ value: m.id, label: m.role === 'owner' ? `${m.name} (organizer)` : m.name }))}
            value={me.id}
            onChange={(memberId) => setStored((prev) => (prev ? { ...prev, actingAs: { ...prev.actingAs, [trip.id]: memberId } } : prev))}
          />
          <p className="text-muted-foreground text-xs">
            Everyone in a trip would open it from their own link. In this prototype the whole group shares one browser, so switch people here to answer, vote and
            choose as each of them. <Person trip={trip} memberId={me.id} className="text-foreground font-medium" /> sees what the trip needs from them.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(TABS.find((t) => t.tab === value)?.tab ?? 'home')}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.tab} value={t.tab} className="min-w-16">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="pt-6">
          <TabsContent value="home">
            <HomePanel {...panelProps} />
          </TabsContent>
          <TabsContent value="people">
            <PeoplePanel {...panelProps} />
          </TabsContent>
          <TabsContent value="decide">
            <DecidePanel {...panelProps} />
          </TabsContent>
          <TabsContent value="plan">
            <PlanPanel {...panelProps} />
          </TabsContent>
          <TabsContent value="ideas">
            <IdeasPanel {...panelProps} />
          </TabsContent>
          <TabsContent value="prices">
            <PricesPanel {...panelProps} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

function NewTripForm({ onCreate }: { onCreate: (title: string, ownerName: string) => void }) {
  const [title, setTitle] = useState('')
  const [name, setName] = useState('')
  const ready = title.trim().length > 0 && name.trim().length > 0
  return (
    <form
      className="bg-card grid gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onCreate(title.trim(), name.trim())
      }}
    >
      <Field label="Trip name">
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Somewhere warm in March" maxLength={80} />
      </Field>
      <Field label="Your name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Maya" maxLength={60} />
      </Field>
      <Button type="submit" disabled={!ready}>
        Create trip
      </Button>
    </form>
  )
}
