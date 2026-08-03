/**
 * "How many of these am I actually signing up for?"
 *
 * The send preview answers what one message will look like. It never answered
 * how many there will be — and a mistyped recurrence is silent in exactly the
 * way this application exists to prevent: "every 30 minutes" instead of "every
 * 30 days" produces a schedule that looks identical on the compose screen and
 * sends 1 440 messages a month.
 *
 * The window is a *count* over real occurrences, not arithmetic on the rule,
 * because the rule is not the whole story: quiet hours and the working
 * calendar both rewrite the list afterwards, and a "daily at 02:00" reminder
 * with quiet hours on does not fire at 02:00. Counting what the scheduler
 * would actually do is the only answer that stays true.
 */

import { applyQuietHours, computeOccurrences, type QuietHours } from './schedule'
import { applyWorkCalendar, toIsoDate, type WorkCalendar } from './workCalendar'
import type { Recurrence } from './types'

/** Default horizon. A month is the span people plan reminders over. */
export const UPCOMING_DAYS = 30

export interface UpcomingDay {
  /** `YYYY-MM-DD`, local. */
  date: string
  /** Fire times on that date, ascending. */
  times: number[]
}

export interface Upcoming {
  /** Everything inside the window, ascending. */
  occurrences: number[]
  /** The same, grouped by local date. */
  days: UpcomingDay[]
  /**
   * True when the rule produces more than the sampler asked for, so the count
   * is a floor rather than a total.
   *
   * Distinguished rather than hidden: telling someone "60 sends in 30 days"
   * when the real answer is 1 440 would be worse than saying nothing, because
   * they would believe it.
   */
  truncated: boolean
  /** How far ahead this looked. */
  days_ahead: number
}

/**
 * Occurrences in the next `days`, after quiet hours and the working calendar.
 *
 * `sampleLimit` bounds the work: an every-minute rule over 30 days is 43 200
 * timestamps, and the caller only ever renders a few dozen. Hitting the limit
 * sets `truncated`, which the UI must say out loud.
 */
export function upcoming(
  recurrence: Recurrence,
  opts: {
    now?: number
    days?: number
    quiet?: QuietHours
    calendar?: WorkCalendar
    sampleLimit?: number
  } = {},
): Upcoming {
  const now = opts.now ?? Date.now()
  const daysAhead = opts.days ?? UPCOMING_DAYS
  const sampleLimit = opts.sampleLimit ?? 500
  const until = now + daysAhead * 86_400_000

  const raw = computeOccurrences(recurrence, { after: now, count: sampleLimit })
  const shaped = opts.calendar
    ? applyWorkCalendar(raw, recurrence.workdayPolicy ?? 'off', opts.calendar)
    : raw
  const final = opts.quiet ? applyQuietHours(shaped, opts.quiet) : shaped

  const inWindow = final.filter((at) => at >= now && at <= until).sort((a, b) => a - b)

  // Truncated only when the sampler ran out *and* everything it produced still
  // fits inside the window — if the last sample is past `until`, the rule was
  // exhausted for this window and the count is exact.
  const truncated = raw.length >= sampleLimit && (final[final.length - 1] ?? 0) <= until

  const byDate = new Map<string, number[]>()
  for (const at of inWindow) {
    const key = toIsoDate(at)
    const list = byDate.get(key)
    if (list) list.push(at)
    else byDate.set(key, [at])
  }

  return {
    occurrences: inWindow,
    days: [...byDate.entries()].map(([date, times]) => ({ date, times })),
    truncated,
    days_ahead: daysAhead,
  }
}

/**
 * How the count should be phrased: exact, or "at least".
 *
 * A separate function so the UI cannot forget the distinction — the difference
 * between "60 sends" and "at least 60 sends" is the difference between a
 * number someone can rely on and one they cannot.
 */
export function countLabel(u: Upcoming): { n: number; atLeast: boolean } {
  return { n: u.occurrences.length, atLeast: u.truncated }
}
