/**
 * Paired-device side effects that reach the platform bridge: `revokePairedDevice`
 * (forgets the sync key before dropping the row) and `restoreSyncConflict`
 * (a thin dispatch wrapper for the "keep mine instead" button).
 *
 * Moved out of `AppState.tsx`'s `AppProvider` unchanged — see that file for
 * how this is wired in. `removePairedDevice`/`restoreSyncConflict`, the pure
 * state changes these dispatch into, live in `services/syncReducer.ts`.
 */

import { useCallback } from 'react'
import type { LogEntry } from '../../core/types'
import type { PlatformBridge } from '../../core/platform/bridge'
import { forgetSecrets } from '../services/secrets'

export interface PairingActionsApi {
  revokePairedDevice: (id: string) => Promise<void>
  restoreSyncConflict: (id: string) => void
}

/** The action shapes this hook dispatches — see `AppState.tsx`'s `Action` union for the source of truth. */
type PairingDispatchAction = { type: 'removePairedDevice'; id: string } | { type: 'restoreSyncConflict'; id: string }

export function usePairingActions(
  bridge: PlatformBridge | null,
  addLog: (entry: Omit<LogEntry, 'id' | 'at'>) => void,
  dispatch: (action: PairingDispatchAction) => void,
): PairingActionsApi {
  const revokePairedDevice = useCallback(
    async (id: string) => {
      const failed = bridge ? await forgetSecrets(bridge, [[id, 'sync']]) : null
      dispatch({ type: 'removePairedDevice', id })
      if (failed) {
        addLog({
          kind: 'security',
          level: 'warn',
          title: 'Device removed, but its sync key could not be deleted',
          detail: failed,
        })
      }
    },
    [bridge, addLog, dispatch],
  )

  const restoreSyncConflict = useCallback(
    (id: string) => {
      dispatch({ type: 'restoreSyncConflict', id })
    },
    [dispatch],
  )

  return { revokePairedDevice, restoreSyncConflict }
}
