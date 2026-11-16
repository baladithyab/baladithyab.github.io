/**
 * Calendar dates as `YYYY-MM-DD` strings. Arithmetic runs in UTC so a date
 * never shifts with the viewer's time zone.
 */

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

function toUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS)
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS)
}

/** Every date from `start` to `end`, both included. Empty when `end` is earlier. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = []
  for (let day = start; day <= end; day = addDays(day, 1)) out.push(day)
  return out
}

/** The nights of a stay from check-in to check-out: check-in included, check-out not. */
export function nightsOf(checkin: string, checkout: string): string[] {
  return checkout > checkin ? eachDay(checkin, addDays(checkout, -1)) : []
}

/**
 * The local calendar date of a timestamp written with its own UTC offset,
 * such as `2027-05-11T23:25:00+01:00`. The airport's date, not the viewer's.
 */
export function localDateOf(dateTime: string): string {
  return dateTime.slice(0, 10)
}

/** `HH:MM` of a timestamp written with its own UTC offset. */
export function localTimeOf(dateTime: string): string {
  return dateTime.slice(11, 16)
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Mon 10 May` */
export function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** `10 May`, or `10 May 2027` with the year. */
export function formatDate(date: string, withYear = false): string {
  const d = new Date(`${date}T00:00:00Z`)
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return withYear ? `${base} ${d.getUTCFullYear()}` : base
}

/** `10 to 17 May`, or `28 Apr to 3 May` across months. */
export function formatRange(start: string, end: string): string {
  const a = new Date(`${start}T00:00:00Z`)
  const b = new Date(`${end}T00:00:00Z`)
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${a.getUTCDate()} to ${formatDate(end)}`
  }
  return `${formatDate(start)} to ${formatDate(end)}`
}
