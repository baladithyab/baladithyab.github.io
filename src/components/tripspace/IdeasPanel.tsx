import { useState } from 'react'
import { CalendarPlus, ExternalLink, Plus, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { addIdea, ideasOf, scheduleIdea, setInterest, setReservation, unscheduleIdea } from '@/lib/tripspace/actions'
import { formatDate, formatDay, isIsoDate } from '@/lib/tripspace/dates'
import { audience, chosenOption, interestScore, type Interest, type Item } from '@/lib/tripspace/model'

import { Field, inputClass, People, Person, Section, Segmented } from './parts'
import type { PanelProps } from './types'

const newId = () => crypto.randomUUID()

const BUCKETS: { value: Interest; label: string; hint: string }[] = [
  { value: 'reserve', label: 'Reservation needed', hint: 'A must, and it has to be booked ahead' },
  { value: 'want', label: 'Want to do', hint: 'Would be sad to miss it' },
  { value: 'like', label: 'Would like to do', hint: 'Good if there is time' },
]
const AUDIENCE_LABEL = { group: 'Group activity', breakout: 'Breakout', solo: 'Solo' } as const

function IdeaCard({ trip, me, item, update }: Pick<PanelProps, 'trip' | 'me' | 'update'> & { item: Item }) {
  const option = chosenOption(trip)
  const [date, setDate] = useState(item.startDate ?? option?.depart ?? '')
  const [time, setTime] = useState(item.detail.kind === 'activity' ? (item.detail.time ?? '') : '')
  const [bookBy, setBookBy] = useState(item.bookBy ?? '')
  const mine = item.participants.find((p) => p.memberId === me.id)?.interest ?? null
  const needsBooking = item.participants.some((p) => p.interest === 'reserve')
  const scheduled = item.startDate !== null
  const detail = item.detail.kind === 'activity' ? item.detail : null

  return (
    <li className="bg-card space-y-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="text-muted-foreground text-sm">
            {detail?.place ?? 'No place given'}
            {detail?.link ? (
              <>
                {' '}
                <a className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-4" href={detail.link} target="_blank" rel="noreferrer">
                  link <ExternalLink className="size-3" aria-hidden />
                </a>
              </>
            ) : null}
          </p>
        </div>
        <span className="rounded-full border px-2.5 py-0.5 text-xs tabular-nums" title="3 per reservation needed, 2 per want, 1 per would like">
          Score {interestScore(item)}
        </span>
      </div>

      <dl className="grid gap-1 text-sm">
        {BUCKETS.map((b) => {
          const who = item.participants.filter((p) => p.interest === b.value).map((p) => p.memberId)
          return who.length > 0 ? (
            <div key={b.value} className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{b.label}:</dt>
              <dd>
                <People trip={trip} memberIds={who} />
              </dd>
            </div>
          ) : null
        })}
      </dl>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">For you</p>
        <Segmented
          label={`Your bucket for ${item.title}`}
          options={[...BUCKETS.map((b) => ({ value: b.value, label: b.label })), { value: 'none' as const, label: 'Not for me' }]}
          value={mine ?? 'none'}
          onChange={(value) => update((t) => setInterest(t, item.id, me.id, value === 'none' ? null : value))}
        />
      </div>

      {scheduled ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            <span className="font-medium">{formatDay(item.startDate ?? '')}</span>
            {detail?.time ? ` at ${detail.time}` : ''}. {AUDIENCE_LABEL[audience(trip, item)]} for <People trip={trip} memberIds={item.participants.map((p) => p.memberId)} />.
          </span>
          {item.status !== 'booked' ? (
            <Button size="sm" variant="ghost" onClick={() => update((t) => unscheduleIdea(t, item.id))}>
              <Undo2 aria-hidden /> Unschedule
            </Button>
          ) : null}
        </div>
      ) : option ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (isIsoDate(date)) update((t) => scheduleIdea(t, item.id, { date, time: /^\d{2}:\d{2}$/.test(time) ? time : null }))
          }}
        >
          <Field label="Day">
            <input type="date" className={inputClass} value={date} min={option.depart} max={option.return} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time, optional">
            <input type="time" className={inputClass} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!isIsoDate(date) || item.participants.length === 0}>
            <CalendarPlus aria-hidden /> Schedule for those interested
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">Scheduling opens once a destination is locked.</p>
      )}

      {needsBooking ? (
        <div className="bg-muted/40 space-y-3 rounded-md border p-3 text-sm">
          <p>
            Needs booking ahead
            {item.bookBy ? `, by ${formatDate(item.bookBy)}` : ''}.{' '}
            {item.leadMemberId ? (
              <>
                <Person trip={trip} memberId={item.leadMemberId} /> is booking it.
              </>
            ) : (
              'Nobody is booking it yet.'
            )}
          </p>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              update((t) => setReservation(t, item.id, { bookBy: isIsoDate(bookBy) ? bookBy : null, leadMemberId: item.leadMemberId ?? me.id, quotedMinor: item.quotedMinor }))
            }}
          >
            <Field label="Book by">
              <input type="date" className={inputClass} value={bookBy} onChange={(e) => setBookBy(e.target.value)} />
            </Field>
            <Button type="submit" size="sm" variant="secondary">
              {item.leadMemberId ? 'Save date' : 'I will book it'}
            </Button>
          </form>
        </div>
      ) : null}
    </li>
  )
}

export default function IdeasPanel({ trip, me, update }: PanelProps) {
  const [title, setTitle] = useState('')
  const [place, setPlace] = useState('')
  const [link, setLink] = useState('')
  const [bucket, setBucket] = useState<Interest>('want')
  const ideas = ideasOf(trip).sort((a, b) => interestScore(b) - interestScore(a) || a.title.localeCompare(b.title))
  const myMusts = ideas.filter((i) => i.participants.some((p) => p.memberId === me.id && p.interest === 'reserve'))
  const validLink = link.trim() === '' || /^https?:\/\//.test(link.trim())

  return (
    <div className="space-y-12">
      <Section
        title="Your buckets"
        description={
          myMusts.length > 0
            ? `${myMusts.filter((i) => i.startDate !== null).length} of your ${myMusts.length} reservation-needed ${myMusts.length === 1 ? 'idea is' : 'ideas are'} scheduled.`
            : 'Sort every idea into one of three buckets. Your buckets are yours: the same dinner can be a must for you and filler for someone else.'
        }
      >
        <div className="grid gap-4 md:grid-cols-3">
          {BUCKETS.map((b) => {
            const inBucket = ideas.filter((i) => i.participants.some((p) => p.memberId === me.id && p.interest === b.value))
            return (
              <div key={b.value} className="rounded-lg border p-4">
                <h3 className="font-medium">{b.label}</h3>
                <p className="text-muted-foreground mb-3 text-xs">{b.hint}</p>
                {inBucket.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nothing here.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {inBucket.map((i) => (
                      <li key={i.id}>
                        {i.title}
                        {i.startDate ? <span className="text-muted-foreground">, {formatDay(i.startDate)}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="Add an idea" description="Anything someone wants to do there. Paste a link if it came from a post or a review.">
        <form
          className="bg-card grid gap-4 rounded-lg border p-4 lg:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!title.trim() || !validLink) return
            update((t) => addIdea(t, { title: title.trim(), place: place.trim() || null, link: link.trim() || null, interest: bucket, by: me.id, newId }))
            setTitle('')
            setPlace('')
            setLink('')
          }}
        >
          <Field label="What">
            <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sunset at Miradouro da Senhora do Monte" maxLength={120} />
          </Field>
          <Field label="Where, optional">
            <input className={inputClass} value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Graça" />
          </Field>
          <Field label="Link, optional">
            <input className={inputClass} value={link} aria-invalid={!validLink} onChange={(e) => setLink(e.target.value)} placeholder="https://" inputMode="url" />
          </Field>
          <div className="space-y-1.5 text-sm">
            <span className="font-medium">Your bucket</span>
            <div>
              <Segmented label="Your bucket for the new idea" options={BUCKETS.map((b) => ({ value: b.value, label: b.label }))} value={bucket} onChange={setBucket} />
            </div>
          </div>
          <Button type="submit" className="lg:col-span-2 lg:justify-self-start" disabled={!title.trim() || !validLink}>
            <Plus aria-hidden /> Add idea
          </Button>
        </form>
      </Section>

      <Section
        title="Everyone's ideas"
        description="Ranked by how many people care and how much. Scheduling an idea puts everyone interested on it: all of the group is a group activity, some is a breakout, one is solo."
      >
        {ideas.length === 0 ? (
          <p className="text-muted-foreground text-sm">No ideas yet.</p>
        ) : (
          <ul className="grid gap-4 xl:grid-cols-2">
            {ideas.map((item) => (
              <IdeaCard key={item.id} trip={trip} me={me} item={item} update={update} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
