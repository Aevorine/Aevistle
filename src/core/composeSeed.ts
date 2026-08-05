/**
 * "New reminder — on *that* day."
 *
 * Double-clicking an empty square on the working calendar is supposed to open
 * the compose screen with the date already filled in. The date has to survive
 * exactly one screen change, and there was nowhere to put it:
 *
 *   - `state.draft` carries the message (recipients, subject, body) and is the
 *     right home for a prefilled *message*. It has no send time; the schedule a
 *     draft is about to get is local state inside the compose screen, seeded
 *     once on mount.
 *   - the compose screen seeds that state from `nextWholeHour(Date.now())`,
 *     which is the single point every new reminder's start time comes through.
 *
 * So this module is that point's one input. `seedComposeDate` leaves a date
 * here, the next seed picks it up, and it is gone again — a reminder created
 * from the calendar on the 15th starts on the 15th, and the *next* one, created
 * from the compose screen itself, starts today like it always did.
 *
 * ## Why it clears on the next tick rather than on read
 *
 * The consumer is a `useState` initialiser. React's StrictMode invokes those
 * **twice** in development and keeps one of the two results, and which one is
 * not something a caller may rely on. Clearing synchronously would hand the two
 * invocations different answers — the date would land or not depending on an
 * implementation detail of the development build, which is the worst possible
 * place for a bug to live. Clearing on the next macrotask means every read
 * inside one render pass agrees, and the seed is still spent before anybody can
 * navigate anywhere.
 */

import { parseIsoDate, toIsoDate, type IsoDate } from './workCalendar'

/**
 * The hour a reminder created from a calendar square starts at.
 *
 * Nine, not "one hour from now": the day being pointed at is usually not today,
 * and carrying 14:37 across to next Tuesday means a reminder that fires at a
 * minute nobody chose — the exact complaint `nextWholeHour` was written to fix.
 */
export const SEEDED_HOUR = 9

let pending: number | null = null
let clearScheduled = false

/** Defers the clear past the render pass that reads the seed. Injectable for tests. */
type Defer = (fn: () => void) => void
const deferToNextTick: Defer = (fn) => {
  setTimeout(fn, 0)
}

/**
 * Remember which day the next new reminder is for.
 *
 * Returns false — and remembers nothing — for anything that is not a real
 * `YYYY-MM-DD`. A seed that silently became `NaN` would show up as a compose
 * screen with an empty send time, which reads as the feature not working.
 */
export function seedComposeDate(iso: IsoDate): boolean {
  const day = parseIsoDate(iso)
  if (Number.isNaN(day.getTime())) return false
  pending = day.getTime()
  clearScheduled = false
  return true
}

/** What is waiting, without spending it. For assertions and for the caller's own checks. */
export function peekComposeSeed(): IsoDate | null {
  return pending === null ? null : toIsoDate(pending)
}

/** Drop the seed. Used when the navigation that would have consumed it did not happen. */
export function clearComposeSeed(): void {
  pending = null
  clearScheduled = false
}

/**
 * The seed, spent. Returns the same value to every caller inside one render
 * pass, and null to everyone after that.
 */
export function takeComposeSeed(defer: Defer = deferToNextTick): number | null {
  if (pending === null) return null
  const value = pending
  if (!clearScheduled) {
    clearScheduled = true
    defer(() => {
      pending = null
      clearScheduled = false
    })
  }
  return value
}

// ---------------------------------------------------------------------------
// Several dates at once — the working calendar's gap-compose
// ---------------------------------------------------------------------------
//
// A second, independent queue rather than an array stuffed into `pending`
// above: the single-date seed is *consumed by the initial render* of the
// recurrence editor (`nextComposeStart`, called from a `useState` initialiser),
// while this one is read at *submit time* by `ComposeView`'s confirm handler.
// Those are different moments in the same screen's life, so folding them into
// one slot would mean whichever fired first silently ate the other's seed.

let pendingDates: number[] | null = null
let clearScheduledDatesTick = false

/**
 * Remember which days a batch of new reminders is for.
 *
 * Same refusal as `seedComposeDate`: anything that is not a full list of real
 * `YYYY-MM-DD`s leaves nothing behind, rather than scheduling a partial batch
 * silently short of the dates that were actually picked.
 */
export function seedComposeDates(isos: IsoDate[]): boolean {
  const days = isos.map((iso) => parseIsoDate(iso).getTime())
  if (days.length === 0 || days.some((d) => Number.isNaN(d))) return false
  pendingDates = days
  clearScheduledDatesTick = false
  return true
}

/** What is waiting, without spending it. */
export function peekComposeDatesSeed(): IsoDate[] | null {
  return pendingDates === null ? null : pendingDates.map(toIsoDate)
}

/** Drop the seed. Used when the navigation that would have consumed it did not happen. */
export function clearComposeDatesSeed(): void {
  pendingDates = null
  clearScheduledDatesTick = false
}

/**
 * The seed, spent — the same next-tick discipline as `takeComposeSeed`, for
 * the same StrictMode reason: every read inside one render pass must see the
 * same answer, so the clear is deferred past it rather than happening on read.
 */
export function takeComposeDates(defer: Defer = deferToNextTick): number[] | null {
  if (pendingDates === null) return null
  const value = pendingDates
  if (!clearScheduledDatesTick) {
    clearScheduledDatesTick = true
    defer(() => {
      pendingDates = null
      clearScheduledDatesTick = false
    })
  }
  return value
}

/**
 * When a brand-new reminder should start.
 *
 * With no seed this is the next whole hour — unchanged, and still the reason
 * the compose screen never shows `14:37` under a label reading "send time".
 * With a seed it is `SEEDED_HOUR` on the day that was double-clicked, except
 * when that day is today and nine o'clock has already gone, in which case the
 * next whole hour is both later and the same day, so it is used instead.
 *
 * Never returns an instant in the past for a seed of today or later; a seeded
 * day that is already over is the caller's job to refuse, because "you cannot
 * schedule mail into last Tuesday" is a sentence, not a silently adjusted date.
 */
export function nextComposeStart(now: number, defer?: Defer): number {
  const hour = new Date(now)
  hour.setHours(hour.getHours() + 1, 0, 0, 0)

  const seed = takeComposeSeed(defer)
  if (seed === null) return hour.getTime()

  const start = new Date(seed)
  start.setHours(SEEDED_HOUR, 0, 0, 0)
  if (start.getTime() > now) return start.getTime()
  // Today, after nine. The next whole hour is the nearest time on this day that
  // a person would have picked, and it is what the compose screen would have
  // shown anyway.
  return hour.getTime()
}
