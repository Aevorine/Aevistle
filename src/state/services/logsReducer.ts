/**
 * The `AppState` reducer's activity-log domain: appending one entry (`log`),
 * wiping the log (`clearLogs`), and removing a single row (`removeLog`).
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 */

import type { AppState, LogEntry } from '../../core/types'
import { pruneLogs } from '../../core/ops/logRetention'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type LogAction =
  | { type: 'log'; entry: LogEntry }
  | { type: 'clearLogs' }
  | { type: 'removeLog'; id: string }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the three case labels above, grouped onto one shared
 * case body — the switch here still has one branch per action, unchanged
 * from what lived inline in `AppState.tsx` before the move.
 */
export function applyLogAction(state: AppState, action: LogAction): AppState {
  switch (action.type) {
    case 'log':
      return { ...state, logs: pruneLogs([action.entry, ...state.logs], state.settings) }

    case 'clearLogs':
      return { ...state, logs: [] }

    /*
     * Identity-checked rather than assumed: an id that is no longer present —
     * a row the retention sweep already dropped, or a second press of a
     * button whose row has re-rendered — returns the *same* state object
     * rather than a new one, so React bails out of the re-render instead of
     * reconciling the whole log for nothing.
     */
    case 'removeLog': {
      const logs = state.logs.filter((entry) => entry.id !== action.id)
      return logs.length === state.logs.length ? state : { ...state, logs }
    }
  }
}
