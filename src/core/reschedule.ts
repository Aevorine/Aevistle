/**
 * "Drag this reminder to Thursday" — and what that can honestly mean.
 *
 * Dragging a badge off one square and onto another is one gesture, but the
 * schedule it points at is a *rule*, not a list of dates. So there are two
 * different things the gesture could mean, and they are not interchangeable:
 *
 *   - **This one send.** Move Tuesday's message to Thursday and leave every
 *     other Tuesday alone.
 *   - **The whole rule.** Stop being a Tuesday reminder; be a Thursday one.
 *
 * A one-off has only the first meaning, and the two coincide. A repeating rule
 * has both, and **this application can only do the second one.** `Recurrence`
 * has no exception list and `ScheduledJob` has no per-occurrence overrides, so
 * there is nowhere to record "skip this Tuesday, send on that Thursday
 * instead". Adding one is a change to `core/types.ts`.
 *
 * That limit is the reason this module exists as a *plan* rather than as a
 * function that just mutates the job. `planReschedule` says which of the two it
 * would do, or refuses and says why, and the UI prints that sentence before the
 * user commits — because a drag that silently rewrote a weekly rule when the
 * user meant to move one message is exactly the kind of quiet wrongness this
 * codebase keeps paying for.
 */

import { pad2, type Recurrence, type ScheduledJob } from './types'
import { parseIsoDate, toIsoDate, type IsoDate } from './workCalendar'

const DAY_MS = 86_400_000

/** Whole local days between two dates. DST-safe: the rounding absorbs 23h/25h. */
export function dayDelta(fromIso: IsoDate, toIso: IsoDate): number {
  const from = parseIsoDate(fromIso)
  const to = parseIsoDate(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0
  return Math.round((to.getTime() - from.getTime()) / DAY_MS)
}

/** An instant moved by whole calendar days, keeping its wall-clock time. */
export function shiftInstantByDays(at: number, days: number): number {
  const d = new Date(at)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export type RescheduleOutcome =
  /** One send moves. The rule as a whole is unchanged (it only had one date). */
  | 'single'
  /** The rule itself moves, so every future send follows. */
  | 'series'
  /** Nothing sensible to do; `reasonKey` says what. */
  | 'refused'

export interface ReschedulePlan {
  outcome: RescheduleOutcome
  /** Translation key explaining a refusal, or describing what will change. */
  reasonKey: string
  /** Substitutions for `reasonKey`. */
  reasonValues?: Record<string, string | number>
  from: IsoDate
  to: IsoDate
  /** The rule to save. Absent when `outcome` is `'refused'`. */
  recurrence?: Recurrence
}

const WEEKDAY_KEYS = ['weekday.0', 'weekday.1', 'weekday.2', 'weekday.3', 'weekday.4', 'weekday.5', 'weekday.6']

/**
 * What dragging this job from `from` to `to` would do.
 *
 * Pure: it computes a new `Recurrence` and hands it back. Saving it — which
 * recomputes the occurrence list and re-arms the platform scheduler — is the
 * caller's job, through `scheduleDraft`.
 */
export function planReschedule(job: ScheduledJob, from: IsoDate, to: IsoDate): ReschedulePlan {
  const rec = job.recurrence
  const delta = dayDelta(from, to)
  const base: Pick<ReschedulePlan, 'from' | 'to'> = { from, to }

  if (delta === 0) {
    return { ...base, outcome: 'refused', reasonKey: 'cal.move.sameDay' }
  }

  const target = parseIsoDate(to)
  if (Number.isNaN(target.getTime())) {
    return { ...base, outcome: 'refused', reasonKey: 'cal.move.badDate' }
  }

  switch (rec.kind) {
    case 'once':
      return {
        ...base,
        outcome: 'single',
        reasonKey: 'cal.move.oneOff',
        recurrence: { ...rec, startAt: shiftInstantByDays(rec.startAt, delta) },
      }

    case 'weekly': {
      const fromDay = parseIsoDate(from).getDay()
      const toDay = target.getDay()
      const current =
        rec.weekdays && rec.weekdays.length > 0 ? rec.weekdays : [new Date(rec.startAt).getDay()]
      if (!current.includes(fromDay)) {
        // The badge was on a day the rule does not name — the working calendar
        // moved it there. Rewriting the rule from the *shifted* day would move
        // the reminder somewhere the user never chose.
        return { ...base, outcome: 'refused', reasonKey: 'cal.move.shiftedSource' }
      }
      const weekdays = [...new Set(current.map((d) => (d === fromDay ? toDay : d)))].sort()
      return {
        ...base,
        outcome: 'series',
        reasonKey: 'cal.move.weekly',
        reasonValues: { day: WEEKDAY_KEYS[toDay] },
        recurrence: { ...rec, weekdays, startAt: shiftInstantByDays(rec.startAt, delta) },
      }
    }

    case 'monthly':
      return {
        ...base,
        outcome: 'series',
        reasonKey: 'cal.move.monthly',
        reasonValues: { day: target.getDate() },
        recurrence: {
          ...rec,
          dayOfMonth: target.getDate(),
          startAt: shiftInstantByDays(rec.startAt, delta),
        },
      }

    case 'yearly':
      return {
        ...base,
        outcome: 'series',
        reasonKey: 'cal.move.yearly',
        reasonValues: { date: `${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}` },
        recurrence: {
          ...rec,
          month: target.getMonth(),
          dayOfMonth: target.getDate(),
          startAt: shiftInstantByDays(rec.startAt, delta),
        },
      }

    case 'interval': {
      const ms = rec.intervalMs ?? (rec.intervalMinutes ?? 0) * 60_000
      if (ms > 0 && ms % DAY_MS === 0) {
        // A whole-day cadence keeps its cadence; only the anchor moves.
        return {
          ...base,
          outcome: 'series',
          reasonKey: 'cal.move.intervalAnchor',
          reasonValues: { n: delta },
          recurrence: { ...rec, startAt: shiftInstantByDays(rec.startAt, delta) },
        }
      }
      // "Every 90 minutes" has no day to move. Shifting the anchor would change
      // the *time* of every send and land it on the same days as before.
      return { ...base, outcome: 'refused', reasonKey: 'cal.move.subDaily' }
    }

    case 'daily':
      // It already fires on the target day. Moving it could only mean changing
      // the time, which is not what dragging across the grid says.
      return { ...base, outcome: 'refused', reasonKey: 'cal.move.alreadyDaily' }

    case 'cron':
      return { ...base, outcome: 'refused', reasonKey: 'cal.move.cron' }
  }
}

/**
 * The one-line answer to "can just this send be moved?".
 *
 * Exported so the UI does not have to re-derive it, and so the answer stays in
 * one place if `types.ts` ever grows the exception list that would change it.
 */
export function canMoveSingleOccurrence(job: ScheduledJob): boolean {
  return job.recurrence.kind === 'once'
}

/** `HH:mm` of the occurrence being dragged, for the confirmation sentence. */
export function timeOfDayAt(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** The date an occurrence is currently on. */
export function dateOf(at: number): IsoDate {
  return toIsoDate(at)
}
