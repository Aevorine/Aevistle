/**
 * The `AppState` reducer's attachment-snapshot domain: `rebaseAttachments`,
 * dispatched after the user moves the data folder so every job's copied
 * attachment path still points at a file that exists.
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 */

import type { AppState } from '../../core/types'

/** The action shape this domain's case handles — see `AppState.tsx`'s `Action` union for the source of truth. */
export type AttachmentAction = { type: 'rebaseAttachments'; from: string; to: string }

/**
 * Apply this domain's action. Called from `AppState.tsx`'s main switch for
 * the case label above, unchanged from what lived inline in `AppState.tsx`
 * before the move.
 *
 * The data folder moved, so every snapshot path saved inside a job now
 * points at a file that is no longer there. Without this, a reminder
 * scheduled last week would fire and quietly send with nothing attached.
 */
export function applyAttachmentAction(state: AppState, action: AttachmentAction): AppState {
  const { from, to } = action
  if (!from || !to || from === to) return state
  const rebase = (p: string): string => (p.startsWith(from) ? to + p.slice(from.length) : p)
  return {
    ...state,
    jobs: state.jobs.map((job) => ({
      ...job,
      draft: {
        ...job.draft,
        attachments: job.draft.attachments.map((a) => (a.source === 'copy' ? { ...a, path: rebase(a.path) } : a)),
      },
    })),
    draft: {
      ...state.draft,
      attachments: state.draft.attachments.map((a) => (a.source === 'copy' ? { ...a, path: rebase(a.path) } : a)),
    },
  }
}
