/**
 * The `AppState` reducer's code-history domain: verification-code hits and
 * the recent-recipient tally the compose screen's quick picks read.
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in. Kept
 * as one function per the domain's actions, mirroring the shape
 * `core/codeHistory.ts` already gives the merge itself: the reducer cases
 * were thin glue around it before this move, and remain exactly that glue,
 * just relocated.
 */

import type { AppState } from '../../core/types'
import { mergeHits, recordRecipients as recordRecipientUse, type NewHit } from '../../core/ops/codeHistory'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type CodeHistoryAction =
  | { type: 'recordCodes'; hits: NewHit[] }
  | { type: 'markCodeCopied'; id: string }
  | { type: 'markCodeRead'; id: string }
  | { type: 'markAllCodesRead' }
  | { type: 'clearCodeHits' }
  | { type: 'recordRecipients'; addresses: string[]; names?: Record<string, string> }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the six case labels above, grouped onto one shared
 * case body — the switch here still has one branch per action, unchanged
 * from what lived inline in `AppState.tsx` before the move.
 */
export function applyCodeHistoryAction(state: AppState, action: CodeHistoryAction): AppState {
  switch (action.type) {
    /**
     * `mergeHits` returns the identical array when nothing is new, and the
     * identity check here turns that into an identical *state* object —
     * extraction re-runs every time a body lands in the cache, and without
     * this a sync of twenty messages would re-render the app twenty times to
     * arrive at the list it already had.
     */
    case 'recordCodes': {
      const codeHits = mergeHits(state.codeHits, action.hits)
      return codeHits === state.codeHits ? state : { ...state, codeHits }
    }

    case 'markCodeCopied': {
      let changed = false
      const codeHits = state.codeHits.map((h) => {
        if (h.id !== action.id || h.copiedAt) return h
        changed = true
        return { ...h, copiedAt: Date.now() }
      })
      return changed ? { ...state, codeHits } : state
    }

    /* Reading is what the click means; copying is what it also happens to do.
       Kept as its own action so the mark survives a clipboard failure. */
    case 'markCodeRead': {
      let changed = false
      const codeHits = state.codeHits.map((h) => {
        if (h.id !== action.id || h.readAt) return h
        changed = true
        return { ...h, readAt: Date.now() }
      })
      return changed ? { ...state, codeHits } : state
    }

    case 'markAllCodesRead': {
      const now = Date.now()
      let changed = false
      const codeHits = state.codeHits.map((h) => {
        if (h.readAt) return h
        changed = true
        return { ...h, readAt: now }
      })
      return changed ? { ...state, codeHits } : state
    }

    case 'clearCodeHits':
      return { ...state, codeHits: [] }

    case 'recordRecipients': {
      const recentRecipients = recordRecipientUse(
        state.recentRecipients,
        action.addresses,
        action.names,
      )
      return recentRecipients === state.recentRecipients
        ? state
        : { ...state, recentRecipients }
    }
  }
}
