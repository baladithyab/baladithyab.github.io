/**
 * Local persistence for the Tripspace prototype. Trips live in this browser's
 * localStorage until the shared backend in docs/TRIPSPACE.md exists. What is
 * read back is parsed with the trip schema; anything that fails is set aside,
 * never half-loaded.
 */
import { z } from 'astro/zod'

import { tripSchema } from './model'

const KEY = 'tripspace:v1'

export const storedSchema = z.object({
  version: z.literal(1),
  trips: z.array(tripSchema),
  activeTripId: z.string().nullable(),
  /** Which member this browser is acting as, per trip. */
  actingAs: z.record(z.string(), z.string()),
})
export type Stored = z.infer<typeof storedSchema>

export type LoadResult =
  | { kind: 'empty' }
  | { kind: 'loaded'; stored: Stored }
  | { kind: 'unreadable'; raw: string }

export function loadStored(storage: Storage): LoadResult {
  const raw = storage.getItem(KEY)
  if (raw === null) return { kind: 'empty' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { kind: 'unreadable', raw }
  }
  const parsed = storedSchema.safeParse(json)
  return parsed.success
    ? { kind: 'loaded', stored: parsed.data }
    : { kind: 'unreadable', raw }
}

/** False when the browser refused to store it (private mode, quota). */
export function saveStored(storage: Storage, stored: Stored): boolean {
  try {
    storage.setItem(KEY, JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}

/** Keep an unreadable copy aside instead of overwriting it. */
export function setAside(storage: Storage, raw: string, now: number): void {
  try {
    storage.setItem(`${KEY}:unreadable:${now}`, raw)
  } catch {
    // Nothing more can be done if storage is full; the live key is replaced next save.
  }
}
