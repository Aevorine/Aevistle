/**
 * "Why this time?" — the adjustment chain for one occurrence, in structured
 * steps rather than a final number.
 *
 * `schedule.ts`, `workCalendar.ts` and `deliveryWindow.ts` each answer "what
 * does this rewrite produce", and `state/AppState.tsx`'s `shapeOccurrences`
 * already chains all three correctly — working calendar, then quiet hours,
 * then the recipient's delivery window, in that order, for the reasons its
 * own doc comment gives. None of the three returns *why* a single occurrence
 * ended up where it did in a form a screen can narrate, only the finished
 * list (or, for the calendar, a batch-level `CalendarAdjustment` that names
 * every moved occurrence in one pile, not "the next one, specifically").
 *
 * This file adds that narration without re-deriving any of the three rules
 * itself — every instant below comes from calling `computeOccurrences`,
 * `applyWorkCalendarDetailed`, `applyQuietHours` and `applyDeliveryWindows`
 * directly, in the same order `shapeOccurrences` uses, so an explanation
 * built from this module can never disagree with the job that actually gets
 * armed from the same rule, settings and recipients.
 *
 * Jitter is the one rewrite that is not in that list, on purpose:
 * `applyJitter` runs in `electron/scheduler.ts` at the moment a job actually
 * fires, not while its occurrence list is being built, because it exists to
 * scatter *sends*, not to move the alarm the scheduler wakes up for. So a
 * `jitter` step here never changes `to` — it is a note that the instant
 * reported as final is not quite the instant mail leaves, not one more
 * adjustment to the chain.
 */

import type { Recurrence } from './types'
import { applyQuietHours, computeOccurrences, type QuietHours } from './schedule'
import { applyWorkCalendarDetailed, DEFAULT_WORK_CALENDAR, type WorkCalendar } from './workCalendar'
import { applyDeliveryWindows, type DeliveryWindow } from './deliveryWindow'

/** No hold — the default for a caller that has not enabled quiet hours. */
const NO_QUIET: QuietHours = { enabled: false, start: '00:00', end: '00:00' }

/**
 * How many raw candidates `explainNextOccurrence` searches through to find
 * the one that survives the working calendar.
 *
 * Copied from `rebuildJob`'s own count rather than invented — the whole point
 * of this module is to agree with the job that actually gets armed, and a
 * different search depth here would mean the two could disagree on which
 * occurrence is "next" under `workdayPolicy: 'skip'` with a long holiday run.
 */
const SEARCH_COUNT = 24

export interface OccurrencePipelineOptions {
  /** Defaults to `Date.now()`. */
  now?: number
  /** Runs already completed — matters only for an `afterCount` end condition. */
  runsSoFar?: number
  calendar?: WorkCalendar
  quiet?: QuietHours
  /** The recipients' delivery windows, `To:` order. Empty means none apply. */
  windows?: DeliveryWindow[]
}

export type ExplainStepKind = 'workCalendar' | 'quietHours' | 'deliveryWindow' | 'jitter'

export interface OccurrenceExplainStep {
  kind: ExplainStepKind
  /** The instant entering this step. */
  from: number
  /**
   * The instant leaving this step. Equal to `from` for a `jitter` step — see
   * this file's header comment for why jitter does not move the alarm.
   */
  to: number
  /** Which entry in the `windows` array bound the move. `deliveryWindow` only. */
  recipientIndex?: number
  /** The configured ceiling, in seconds. `jitter` only. */
  jitterSeconds?: number
}

export interface OccurrenceExplanation {
  /**
   * False when the rule has nothing left to fire inside the search window —
   * an exhausted `once`, an `afterCount` already reached, an `endDate`
   * already past, or a working calendar that consumed every candidate this
   * function looked at. `originalAt` and `finalAt` are not meaningful then.
   */
  hasNext: boolean
  /** What the rule alone computes for this occurrence, before any rewrite. */
  originalAt: number
  /**
   * The instant that will actually be armed — matches
   * `ScheduledJob.occurrences[0]` for the same rule, settings and recipients.
   * Does not include jitter; see the `jitter` step for that.
   */
  finalAt: number
  /** In pipeline order. Empty means nothing about this occurrence moved. */
  steps: OccurrenceExplainStep[]
}

/**
 * The adjustment chain for the next occurrence of `rec`.
 *
 * Walks the same three rewrites `shapeOccurrences` applies to a whole
 * occurrence list, but keeps the intermediate instant after each one so a
 * screen can say which rule moved this particular send and to when — the list
 * functions only ever hand back the finished array.
 *
 * `originalAt` is the rule's own answer for *this* occurrence, not
 * necessarily the very first candidate `computeOccurrences` produced: under
 * `workdayPolicy: 'skip'` an earlier candidate can be dropped entirely before
 * this one is ever reached, and that drop is not part of the story of why
 * *this* time is what it is — it is why an earlier one is not the next
 * occurrence at all, a different question this function does not answer.
 */
export function explainNextOccurrence(
  rec: Recurrence,
  opts: OccurrencePipelineOptions = {},
): OccurrenceExplanation {
  const now = opts.now ?? Date.now()
  const calendar = opts.calendar ?? DEFAULT_WORK_CALENDAR
  const quiet = opts.quiet ?? NO_QUIET
  const windows = opts.windows ?? []

  const raw = computeOccurrences(rec, {
    runsSoFar: opts.runsSoFar,
    count: SEARCH_COUNT,
    after: now,
    calendar,
  })
  if (raw.length === 0) {
    return { hasNext: false, originalAt: now, finalAt: now, steps: [] }
  }

  const { occurrences: afterCalendarList, adjustment } = applyWorkCalendarDetailed(
    raw,
    rec.workdayPolicy ?? 'off',
    calendar,
    now,
  )
  if (afterCalendarList.length === 0) {
    // Every candidate this search looked at was skipped or dropped by the
    // calendar. Not necessarily "never fires again" — a wider search might
    // find one — but nothing here is a real send to explain.
    return { hasNext: false, originalAt: raw[0], finalAt: raw[0], steps: [] }
  }

  const afterCalendar = afterCalendarList[0]
  const movedEntry = adjustment.moved.find((m) => m.to === afterCalendar)
  const originalAt = movedEntry ? movedEntry.from : afterCalendar

  const steps: OccurrenceExplainStep[] = []
  if (movedEntry) {
    steps.push({ kind: 'workCalendar', from: movedEntry.from, to: movedEntry.to })
  }

  const [afterQuiet] = applyQuietHours([afterCalendar], quiet)
  if (afterQuiet !== afterCalendar) {
    steps.push({ kind: 'quietHours', from: afterCalendar, to: afterQuiet })
  }

  let afterDelivery = afterQuiet
  if (windows.length > 0) {
    const result = applyDeliveryWindows(afterQuiet, windows)
    if (result.outcome === 'moved' && result.at !== afterQuiet) {
      steps.push({
        kind: 'deliveryWindow',
        from: afterQuiet,
        to: result.at,
        recipientIndex: result.boundBy,
      })
      afterDelivery = result.at
    }
  }

  if (rec.jitterSeconds > 0) {
    steps.push({ kind: 'jitter', from: afterDelivery, to: afterDelivery, jitterSeconds: rec.jitterSeconds })
  }

  return { hasNext: true, originalAt, finalAt: afterDelivery, steps }
}
