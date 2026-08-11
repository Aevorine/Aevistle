/**
 * The `AppState` reducer's device-pairing and conflict-resolution domain:
 * `upsertPairedDevice`, `removePairedDevice`, `commitSyncSeq`, and
 * `restoreSyncConflict`, moved out of `AppState.tsx`'s main switch, case for
 * case, with no behaviour change — see that file's reducer for how this is
 * wired in.
 *
 * `applySyncResult` — the case that actually lands one sync cycle's worth of
 * change — deliberately stays behind in `AppState.tsx`, not here: it calls
 * `recomputeJobsForCalendar` when an incoming calendar patch is adopted, and
 * that function (together with `reshapeJob`/`shapeOccurrences`/
 * `windowsForDraft`) is the same job-recompute cluster `services/jobReducer.ts`'s
 * own doc comment already found pinned in `AppState.tsx` — `windowsForDraft`
 * is additionally grepped for by `scripts/check-delivery-ui.mjs` there, and
 * `recomputeJobsForCalendar` is also called from `patchSettings`, a case this
 * extraction has no reason to touch. Pulling `applySyncResult` out would mean
 * either a circular import back into `AppState.tsx` for
 * `recomputeJobsForCalendar`, or duplicating it — both worse than leaving a
 * genuinely entangled case in place.
 *
 * The sync-loop wiring `applySyncResult` is dispatched from —
 * `syncResponder`, `applyExchangeOutcome`, the `SyncLoop`'s `onSynced`
 * handler, and the `liveRef`-ordering they depend on to stay correct when an
 * initiator and a responder exchange race each other — is `AppProvider`
 * component wiring (hooks closing over `bridge`/`dispatch`/`addLog`/
 * `liveRef`), not reducer case blocks, and stays in `AppState.tsx` too.
 */

import { type AppState, type Contact, type MailAccount, type ScheduledJob, type Template } from '../../core/types'
import { recordSyncSeq, removePairedDevice, type PairedDevice } from '../../core/sync/pairedDevices'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type SyncAction =
  | { type: 'upsertPairedDevice'; device: PairedDevice }
  | { type: 'removePairedDevice'; id: string }
  | { type: 'commitSyncSeq'; deviceId: string; seq: number }
  | { type: 'restoreSyncConflict'; id: string }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the four case labels above, grouped onto one shared case
 * body — the switch here still has one branch per action, unchanged from
 * what lived inline in `AppState.tsx` before the move.
 */
export function applySyncAction(state: AppState, action: SyncAction): AppState {
  switch (action.type) {
    case 'upsertPairedDevice': {
      const exists = state.pairedDevices.some((d) => d.id === action.device.id)
      return {
        ...state,
        pairedDevices: exists
          ? state.pairedDevices.map((d) => (d.id === action.device.id ? action.device : d))
          : [...state.pairedDevices, action.device],
      }
    }

    case 'removePairedDevice':
      return { ...state, pairedDevices: removePairedDevice(state.pairedDevices, action.id) }

    case 'commitSyncSeq': {
      return {
        ...state,
        pairedDevices: recordSyncSeq(state.pairedDevices, action.deviceId, { lastAcceptedSeq: action.seq }),
      }
    }

    /** "Keep mine instead" — puts the losing record from `core/syncConflict.ts`'s rollback bucket back, then forgets the snapshot: restoring twice would mean the second press has nothing left to restore *from*. */
    case 'restoreSyncConflict': {
      const snapshot = state.syncConflicts.find((s) => s.id === action.id)
      if (!snapshot) return state
      const replaceById = <T extends { id: string }>(records: T[], record: T): T[] =>
        records.map((r) => (r.id === record.id ? record : r))
      let next = state
      switch (snapshot.kind) {
        case 'account':
          next = { ...next, accounts: replaceById(next.accounts, snapshot.losing as MailAccount) }
          break
        case 'job':
          next = { ...next, jobs: replaceById(next.jobs, snapshot.losing as ScheduledJob) }
          break
        case 'contact':
          next = { ...next, contacts: replaceById(next.contacts, snapshot.losing as Contact) }
          break
        case 'template':
          next = { ...next, templates: replaceById(next.templates, snapshot.losing as Template) }
          break
      }
      return { ...next, syncConflicts: next.syncConflicts.filter((s) => s.id !== action.id) }
    }
  }
}
