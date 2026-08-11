/**
 * "What is going out today, and is any of it broken?" — as numbers.
 *
 * The daily digest is one mail the app sends to its own user. Everything about
 * its *content* is computed here, and everything about its *wording* is not:
 * this module returns counts, per-job entries and the conflict list, and the
 * call site turns them into a sentence in whichever of the six languages the
 * user reads. A core module that returned "3 reminders today" would be a core
 * module that had picked a language.
 *
 * Nothing here counts occurrences by itself. `upcoming()` already walks the
 * recurrence engine through quiet hours and the working calendar and reports
 * `truncated` honestly, and `findConflicts()` already knows the five ways a
 * calendar can quietly not send something. Re-deriving either would produce a
 * digest that disagrees with the screens the user can check it against — and a
 * summary you cannot check is worse than no summary.
 *
 * Two honesty properties carried through rather than smoothed away:
 *
 *   - **`truncated` propagates.** If any job's count is a floor, the digest's
 *     total is a floor and says so. "12 sends today" when the real figure is
 *     1 440 would be believed.
 *   - **`generatedAt` is recorded.** The digest's body is built when the
 *     schedule is handed to the platform scheduler, and the platform scheduler
 *     may send it hours later with no UI running. Stamping the instant it was
 *     computed is the difference between a summary and a summary that might be
 *     yesterday's.
 */

import { CONFLICT_DAYS, findConflicts, type Conflict } from '../sync/conflicts'
import type { QuietHours } from '../schedule/schedule'
import { upcoming } from '../schedule/upcoming'
import { DEFAULT_WORK_CALENDAR, toIsoDate, type IsoDate, type WorkCalendar } from '../schedule/workCalendar'
import type { ScheduledJob } from '../types'

/** How far "this week" looks. Seven days, counted from now, not to Sunday. */
export const DIGEST_WEEK_DAYS = 7

/**
 * The digest's job id, fixed rather than minted.
 *
 * Fixed because there must be exactly one: the settings switch writes this job
 * and nothing else does, so turning the digest off and on again cannot leave a
 * second one behind quietly mailing you at the old time. It is a real entry in
 * `state.jobs`, so it appears on the Schedule screen and can be inspected,
 * paused and deleted like every other reminder — a summary of your schedule
 * that is not itself in your schedule would be exactly the hidden background
 * sender this application refuses to be.
 */
export const DIGEST_JOB_ID = 'job_digest'

export interface DigestEntry {
  jobId: string
  name: string
  /** Fire times falling on the digest's own local date, ascending. */
  times: number[]
  /** Addresses in `To`. Cc/Bcc are not people being reminded. */
  recipients: number
  /** Occurrences inside the week window, today's included. */
  weekCount: number
  /** True when this job's sampler ran out, so its two counts are floors. */
  truncated: boolean
}

export interface Digest {
  /** When this was computed — *not* when it was sent. See the file comment. */
  generatedAt: number
  /** The local date `todayCount` and `todayEntries` are about. */
  today: IsoDate
  /** Sends due today across every job considered. */
  todayCount: number
  /** One entry per job with something due today, earliest fire time first. */
  todayEntries: DigestEntry[]
  /** How far ahead `weekCount` looked, in days. */
  weekDays: number
  weekCount: number
  /** Enabled jobs actually looked at, after exclusions. */
  jobsConsidered: number
  /**
   * True when at least one job's count had to be sampled rather than
   * enumerated, which makes `todayCount` and `weekCount` floors.
   */
  truncated: boolean
  /** How far ahead the conflict scan looked, in days. */
  conflictDays: number
  conflicts: Conflict[]
  conflictCount: number
  /** Of those, the ones that stop a send outright rather than moving it. */
  conflictErrors: number
}

export interface DigestOptions {
  now?: number
  /** The nightly hold window, so the times quoted are the ones that happen. */
  quiet?: QuietHours
  calendar?: WorkCalendar
  weekDays?: number
  conflictDays?: number
  sampleLimit?: number
  /**
   * Jobs to leave out.
   *
   * The digest itself is an ordinary scheduled reminder, so without this it
   * appears in its own list every morning — technically true and completely
   * useless.
   */
  excludeJobIds?: string[]
}

/**
 * The summary, from the same engine that decides when mail actually leaves.
 *
 * Disabled jobs are skipped: a paused reminder arms nothing, and listing it as
 * "going out today" would be a lie in the one direction this application
 * cannot afford.
 */
export function buildDigest(jobs: ScheduledJob[], opts: DigestOptions = {}): Digest {
  const now = opts.now ?? Date.now()
  const weekDays = opts.weekDays ?? DIGEST_WEEK_DAYS
  const conflictDays = opts.conflictDays ?? CONFLICT_DAYS
  const calendar = opts.calendar ?? DEFAULT_WORK_CALENDAR
  const exclude = new Set(opts.excludeJobIds ?? [])
  const today = toIsoDate(now)

  const considered = jobs.filter((job) => job.enabled && !exclude.has(job.id))

  const todayEntries: DigestEntry[] = []
  let todayCount = 0
  let weekCount = 0
  let truncated = false

  for (const job of considered) {
    const view = upcoming(job.recurrence, {
      now,
      days: weekDays,
      quiet: opts.quiet,
      calendar,
      sampleLimit: opts.sampleLimit,
    })

    /**
     * `upcoming()` answers about the *rule*; a job also has a history.
     *
     * A reminder set to stop after ten runs that has already run nine times has
     * exactly one send left, and the rule alone cannot know that. Without this
     * the digest would promise a week of mail from a schedule that retires
     * tomorrow.
     */
    const rec = job.recurrence
    const left =
      rec.endMode === 'afterCount' && rec.maxRuns !== undefined
        ? Math.max(0, rec.maxRuns - job.runCount)
        : Number.POSITIVE_INFINITY
    const occurrences = Number.isFinite(left) ? view.occurrences.slice(0, left) : view.occurrences
    if (occurrences.length === 0) continue

    // Only a job whose list was *not* cut short by its run cap can still be
    // truncated by the sampler: if the cap bit first, the count is exact.
    const jobTruncated = view.truncated && occurrences.length === view.occurrences.length

    weekCount += occurrences.length
    if (jobTruncated) truncated = true

    const times = occurrences.filter((at) => toIsoDate(at) === today)
    if (times.length === 0) continue

    todayCount += times.length
    todayEntries.push({
      jobId: job.id,
      name: job.name,
      times,
      recipients: job.draft.to.length,
      weekCount: occurrences.length,
      truncated: jobTruncated,
    })
  }

  // Earliest first: a digest read at breakfast should open with what happens
  // next, not with whichever job was created first.
  todayEntries.sort((a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0))

  // The same scan, over the same window, as the calendar screen — so the number
  // in the mail and the number on the screen can be compared.
  const scan = findConflicts(considered, calendar, { now, days: conflictDays })

  return {
    generatedAt: now,
    today,
    todayCount,
    todayEntries,
    weekDays,
    weekCount,
    jobsConsidered: considered.length,
    truncated,
    conflictDays,
    conflicts: scan.conflicts,
    conflictCount: scan.conflicts.length,
    conflictErrors: scan.conflicts.filter((c) => c.severity === 'error').length,
  }
}

/**
 * Is there anything worth saying?
 *
 * Separate from `buildDigest` so the decision "send nothing today" is one the
 * caller makes explicitly. It is deliberately *not* used to suppress the mail:
 * a digest that stops arriving is indistinguishable from a digest that broke,
 * and this application's whole promise is that silence never means "fine".
 */
export function digestIsEmpty(digest: Digest): boolean {
  return digest.todayCount === 0 && digest.weekCount === 0 && digest.conflictCount === 0
}
