/**
 * The `AppState` reducer's job-lifecycle domain: creating/replacing a job
 * (`upsertJob`) and deleting one (`removeJob`), moved out of `AppState.tsx`'s
 * main switch, case for case, with no behaviour change — see that file's
 * reducer for how this is wired in.
 *
 * `jobRan` deliberately stays behind in `AppState.tsx`, not here:
 * `scripts/check-job-status.mjs` greps `AppState.tsx`'s own source for
 * `case 'jobRan'` followed by an `applyRun(` call within 400 characters, so
 * moving that one case's body out from under it — even behind an import —
 * would fail a check whose whole point is guarding this exact seam.
 *
 * The occurrence/recurrence recomputation this domain otherwise touches
 * (`rebuildJob`, `reshapeJob`, `recomputeJobsForCalendar`, `shapeOccurrences`,
 * `windowsForDraft`) stays in `AppState.tsx` too, and not by omission: they
 * are called directly from `AppProvider`'s own `scheduleDraft`/`toggleJob`/
 * boot effect and from the digest's `digestJobFor` — none of which this
 * extraction is allowed to touch — and `windowsForDraft` is additionally
 * pinned there by `scripts/check-delivery-ui.mjs`, which greps `AppState.tsx`
 * for its own `windowsForRecipients` import line and `windowsOf(windowsForRecipients(`
 * call. Moving the recompute helpers here would need either a circular import
 * back into `AppState.tsx` for `windowsForDraft`, or editing those untouchable
 * call sites — both worse than leaving a genuinely entangled cluster in place.
 */

import { JOB_TOMBSTONE_MAX_AGE_MS, type AppState, type JobTombstone, type ScheduledJob } from '../../core/types'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type JobAction = { type: 'upsertJob'; job: ScheduledJob } | { type: 'removeJob'; id: string }

/**
 * Record that a job was deleted, so device sync can tell a peer "this was
 * cancelled" — see `AppState.deletedJobs` and `core/syncLoop.ts`'s handling
 * of `SchedulePayload.deletedJobs`. One entry per id: a job deleted twice
 * (rare, but re-adding via undo and deleting again is exactly that) only
 * needs its cancellation known once, at the latest time it happened.
 */
function addJobTombstone(existing: JobTombstone[], id: string, deletedAt: number): JobTombstone[] {
  const cutoff = deletedAt - JOB_TOMBSTONE_MAX_AGE_MS
  const kept = existing.filter((t) => t.id !== id && t.deletedAt >= cutoff)
  return [...kept, { id, deletedAt }]
}

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the two case labels above, grouped onto one shared case
 * body — the switch here still has one branch per action, unchanged from
 * what lived inline in `AppState.tsx` before the move.
 */
export function applyJobAction(state: AppState, action: JobAction): AppState {
  switch (action.type) {
    case 'upsertJob': {
      const exists = state.jobs.some((j) => j.id === action.job.id)
      const jobs = exists
        ? state.jobs.map((j) => (j.id === action.job.id ? action.job : j))
        : [...state.jobs, action.job]
      return { ...state, jobs }
    }

    case 'removeJob':
      return {
        ...state,
        jobs: state.jobs.filter((j) => j.id !== action.id),
        // Recorded even if `action.id` did not actually match a job — the
        // caller (e.g. `deleteJob`) already resolved a real one before
        // dispatching, and a no-op tombstone for an id that never synced
        // anywhere is harmless.
        deletedJobs: addJobTombstone(state.deletedJobs, action.id, Date.now()),
      }
  }
}
