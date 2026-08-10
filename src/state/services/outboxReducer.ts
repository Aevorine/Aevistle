/**
 * The `AppState` reducer's outbox domain: the offline send queue's own
 * array in state (enqueue/patch/dequeue/clear).
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 * `sendDraftNow` and `flushOutbox` — the code that decides *when* to queue
 * and *when* to retry, backed by `probablyOnline`/`dueItems`/`afterAttempt`/
 * `queueItem` from `core/outbox.ts` — stay in `AppState.tsx`'s `AppProvider`
 * untouched; only the four reducer cases that mutate `state.outbox` move
 * here.
 */

import type { AppState } from '../../core/types'
import { OUTBOX_CAP, type OutboxItem } from '../../core/outbox'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type OutboxAction =
  | { type: 'enqueue'; item: OutboxItem }
  | { type: 'patchOutbox'; id: string; patch: Partial<OutboxItem> }
  | { type: 'dequeue'; id: string }
  | { type: 'clearOutbox' }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the four case labels above, grouped onto one shared
 * case body — the switch here still has one branch per action, unchanged
 * from what lived inline in `AppState.tsx` before the move.
 */
export function applyOutboxAction(state: AppState, action: OutboxAction): AppState {
  switch (action.type) {
    case 'enqueue':
      return { ...state, outbox: [...state.outbox, action.item].slice(-OUTBOX_CAP) }

    case 'patchOutbox':
      return {
        ...state,
        outbox: state.outbox.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i)),
      }

    case 'dequeue':
      return { ...state, outbox: state.outbox.filter((i) => i.id !== action.id) }

    case 'clearOutbox':
      return { ...state, outbox: [] }
  }
}
