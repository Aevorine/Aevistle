/**
 * The `AppState` reducer's compose-draft domain: the draft itself
 * (`setDraft`, `resetDraft`) and its autosave history
 * (`snapshotDraft`, `restoreSnapshot`, `clearSnapshots`).
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 */

import { emptyDraft, type AppState, type MessageDraft } from '../../core/types'
import { captureSnapshot, type SnapshotReason } from '../../core/sync/snapshots'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type DraftAction =
  | { type: 'setDraft'; patch: Partial<MessageDraft> }
  | { type: 'resetDraft'; accountId?: string }
  | { type: 'snapshotDraft'; reason: SnapshotReason }
  | { type: 'restoreSnapshot'; id: string }
  | { type: 'clearSnapshots' }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the five case labels above, grouped onto one shared
 * case body — the switch here still has one branch per action, unchanged
 * from what lived inline in `AppState.tsx` before the move.
 */
export function applyDraftAction(state: AppState, action: DraftAction): AppState {
  switch (action.type) {
    case 'setDraft':
      return { ...state, draft: { ...state.draft, ...action.patch } }

    case 'resetDraft':
      return {
        ...state,
        draft: emptyDraft(action.accountId ?? state.draft.accountId),
      }

    /*
     * Record the current draft, if it is worth recording. `captureSnapshot`
     * returns null for "nothing changed" and for "too soon", and returning
     * the identical state object in that case is what stops an autosave from
     * re-rendering the tree while someone is mid-sentence.
     */
    case 'snapshotDraft': {
      if (state.settings.draftHistoryEnabled === false) return state
      const next = captureSnapshot(state.draftSnapshots, state.draft, action.reason)
      return next ? { ...state, draftSnapshots: next } : state
    }

    /*
     * Put a past version back on screen — and snapshot what it replaces
     * first, so "restore" is itself undoable. Restoring over unsaved work
     * and losing it would reproduce, inside the recovery feature, the exact
     * problem the recovery feature exists to solve.
     */
    case 'restoreSnapshot': {
      const target = state.draftSnapshots.find((s) => s.id === action.id)
      if (!target) return state
      const preserved =
        captureSnapshot(state.draftSnapshots, state.draft, 'beforeRestore') ?? state.draftSnapshots
      return { ...state, draft: { ...target.draft }, draftSnapshots: preserved }
    }

    case 'clearSnapshots':
      return { ...state, draftSnapshots: [] }
  }
}
