/**
 * What the working calendar and the schedule, together, are about to do wrong.
 *
 * Each of these is a state the app can already reach today and cannot currently
 * report. They are not stylistic warnings — every one of them means a message
 * arrives at a time nobody asked for, or does not arrive at all.
 *
 *   - **`sameMinute`** — several reminders land on the same minute. Inside one
 *     job the de-duplication nudge in `workCalendar.ts` already spreads these;
 *     *across* jobs nothing does, and a public holiday that shifts four
 *     different reminders onto the following Monday at 09:00 sends four
 *     messages at once. Usually mail; occasionally a provider's rate limiter.
 *   - **`allSkipped`** — a job whose every occurrence in the window is removed.
 *     `workdayPolicy: 'skip'` on a rule that only ever fires on a Saturday is
 *     a reminder that is switched on, shows as armed, and will never send.
 *   - **`nowhereToGo`** — `shiftToWorkingDay` searched a month in the requested
 *     direction and found no working day. The occurrence is dropped. This is
 *     the failure `CalendarAdjustment.dropped` exists to record.
 *   - **`crowded`** — the nudge hit its cap and left occurrences sharing an
 *     instant anyway.
 *   - **`spread`** — the nudge moved something far enough from the time the
 *     user chose to be worth saying so.
 *
 * Computed from the *rule*, never from the stored occurrence list: the stored
 * list has already been shifted, so it cannot show what was dropped on the way.
 */

import { computeOccurrences } from '../schedule/schedule'
import {
  applyWorkCalendarDetailed,
  toIsoDate,
  type IsoDate,
  type WorkCalendar,
} from '../schedule/workCalendar'
import type { ScheduledJob } from '../types'

export type ConflictKind = 'sameMinute' | 'allSkipped' | 'nowhereToGo' | 'crowded' | 'spread'

export interface Conflict {
  kind: ConflictKind
  /** `error` — a send will not happen, or will happen at an unasked-for time. */
  severity: 'error' | 'warning'
  /** Jobs involved, in the order they appear in the schedule. */
  jobIds: string[]
  /** The instant this is about, where there is a single one. */
  at?: number
  /** The date this is about — always set, so the calendar can mark the square. */
  date?: IsoDate
  /** How many sends/jobs the conflict covers; the number the message quotes. */
  count: number
  /** For `spread`, how far the worst nudge moved something. */
  ms?: number
}

export interface ConflictScan {
  conflicts: Conflict[]
  /** Dates with at least one conflict, for marking the grid. */
  byDate: Map<IsoDate, Conflict[]>
  /** How far ahead this looked. */
  days: number
}

/** The default horizon. A month is the span the rest of the app previews. */
export const CONFLICT_DAYS = 60

/**
 * How many reminders on one minute is a problem.
 *
 * Two is not a mistake — two reminders at 09:00 is a thing people set up on
 * purpose. Flagging it would make this whole panel noise, and a panel of noise
 * is a panel nobody reads on the day it is right.
 */
export const SAME_MINUTE_THRESHOLD = 3

export function findConflicts(
  jobs: ScheduledJob[],
  calendar: WorkCalendar,
  opts: { now?: number; days?: number; sampleLimit?: number } = {},
): ConflictScan {
  const now = opts.now ?? Date.now()
  const days = opts.days ?? CONFLICT_DAYS
  const until = now + days * 86_400_000
  const sampleLimit = opts.sampleLimit ?? 200
  const conflicts: Conflict[] = []

  /** minute → job ids landing on it (a job counted once per minute). */
  const minutes = new Map<number, Set<string>>()

  for (const job of jobs) {
    if (!job.enabled) continue
    const policy = job.recurrence.workdayPolicy ?? 'off'
    // `until` as well as `count`: the filter below used to be the only bound,
    // so a weekly rule generated 200 occurrences — about four years — to keep
    // the nine that fall inside a 60-day window. Measured over 300 jobs that
    // was 263.7 ms of the work calendar's 392 ms first render.
    //
    // The filter stays. `computeOccurrences` stops at the first occurrence
    // past `until`, and a shifted occurrence can land past it afterwards.
    const raw = computeOccurrences(job.recurrence, {
      after: now,
      until,
      count: sampleLimit,
      runsSoFar: job.runCount,
      calendar,
    }).filter((at) => at <= until)

    const { occurrences, adjustment } = applyWorkCalendarDetailed(raw, policy, calendar)

    if (adjustment.dropped.length > 0) {
      conflicts.push({
        kind: 'nowhereToGo',
        severity: 'error',
        jobIds: [job.id],
        at: adjustment.dropped[0],
        date: toIsoDate(adjustment.dropped[0]),
        count: adjustment.dropped.length,
      })
    }

    if (adjustment.crowded.length > 0) {
      conflicts.push({
        kind: 'crowded',
        severity: 'warning',
        jobIds: [job.id],
        at: adjustment.crowded[0],
        date: toIsoDate(adjustment.crowded[0]),
        count: adjustment.crowded.length,
      })
    }

    const worstSpread = adjustment.spread.reduce((max, s) => Math.max(max, s.byMs), 0)
    if (worstSpread >= 5 * 60_000) {
      const worst = adjustment.spread.find((s) => s.byMs === worstSpread)!
      conflicts.push({
        kind: 'spread',
        severity: 'warning',
        jobIds: [job.id],
        at: worst.at,
        date: toIsoDate(worst.at),
        count: adjustment.spread.length,
        ms: worstSpread,
      })
    }

    // "Everything was removed" — but only when there was something to remove.
    // A job that has simply run out of future occurrences is finished, not
    // broken, and saying otherwise would put a red banner on every completed
    // reminder in the list.
    if (raw.length > 0 && occurrences.length === 0) {
      conflicts.push({
        kind: 'allSkipped',
        severity: 'error',
        jobIds: [job.id],
        at: raw[0],
        date: toIsoDate(raw[0]),
        count: raw.length,
      })
    }

    for (const at of occurrences) {
      const minute = Math.floor(at / 60_000)
      const set = minutes.get(minute)
      if (set) set.add(job.id)
      else minutes.set(minute, new Set([job.id]))
    }
  }

  for (const [minute, ids] of [...minutes.entries()].sort((a, b) => a[0] - b[0])) {
    if (ids.size < SAME_MINUTE_THRESHOLD) continue
    const at = minute * 60_000
    conflicts.push({
      kind: 'sameMinute',
      severity: 'warning',
      // Ordered by the schedule, not by Set insertion, so the message reads the
      // same twice running.
      jobIds: jobs.filter((j) => ids.has(j.id)).map((j) => j.id),
      at,
      date: toIsoDate(at),
      count: ids.size,
    })
  }

  const byDate = new Map<IsoDate, Conflict[]>()
  for (const conflict of conflicts) {
    if (!conflict.date) continue
    const list = byDate.get(conflict.date)
    if (list) list.push(conflict)
    else byDate.set(conflict.date, [conflict])
  }

  // Errors first, then by when they bite. A panel sorted by job id makes the
  // reader find the important one.
  conflicts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    return (a.at ?? 0) - (b.at ?? 0)
  })

  return { conflicts, byDate, days }
}

/** True when the scan found something that stops a send outright. */
export function hasBlockingConflict(scan: ConflictScan): boolean {
  return scan.conflicts.some((c) => c.severity === 'error')
}
