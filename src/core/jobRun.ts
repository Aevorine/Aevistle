/**
 * Writing a completed run back onto the job the user looks at.
 *
 * A pure function rather than four lines inside the reducer, for one reason:
 * the bug this exists to fix was invisible precisely because nothing could be
 * pointed at and tested. The scheduler updated its own copy, the renderer wrote
 * a log line, and no single place could be asked "does a finished send reach
 * the schedule row?" — so nobody noticed for four releases that the answer was
 * no. `npm run check:job-status` asks that question of this function.
 */

import type { JobRun } from './bridge'
import type { ScheduledJob } from './types'

/**
 * Merge a run report into a job.
 *
 * Deliberately absolute, not incremental: `runCount` is assigned, never
 * `+= 1`. Android queues these reports while the app is closed and redelivers
 * them if it crashes between handing them over and clearing the queue, so an
 * incremental merge would double-count exactly the reminder that fired while
 * nobody was watching.
 *
 * `updatedAt` is left alone on purpose. It feeds the signature that decides
 * whether to re-arm the platform scheduler; bumping it here would make every
 * completed send tear down and rebuild the alarm that had just fired.
 */
export function applyRun(job: ScheduledJob, run: JobRun): ScheduledJob {
  return {
    ...job,
    runCount: run.runCount,
    lastRunAt: run.lastRunAt,
    lastResult: run.lastResult,
    lastError: run.lastError,
    status: run.status,
    occurrences: run.occurrences,
  }
}

/**
 * Has this job finished for good?
 *
 * Used by the schedule screen to move a one-off into its "completed" section
 * instead of leaving it in the list looking like it is still going to fire.
 * A repeating job with an empty occurrence list is *not* finished — the list is
 * refilled lazily, and treating "nothing queued right now" as "over" would
 * archive a daily reminder the moment its buffer ran dry.
 */
export function isFinished(job: Pick<ScheduledJob, 'status'>): boolean {
  return job.status === 'done'
}
