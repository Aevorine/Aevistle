/**
 * "Reset everything": forgets every account's stored secrets, clears the
 * remote-image cache, then wipes the state document — moved out of
 * `AppState.tsx`'s `AppProvider` unchanged, see that file for how this is
 * wired in.
 */

import { useCallback } from 'react'
import type { LogEntry, MailAccount, SecretKind } from '../../core/types'
import type { PlatformBridge } from '../../core/platform/bridge'
import { forgetSecrets } from '../services/secrets'

/** The action shape this hook dispatches — see `AppState.tsx`'s `Action` union for the source of truth. */
type ResetDispatchAction = { type: 'reset' }

export function useResetEverything(
  bridge: PlatformBridge | null,
  accounts: MailAccount[],
  addLog: (entry: Omit<LogEntry, 'id' | 'at'>) => void,
  dispatch: (action: ResetDispatchAction) => void,
): () => Promise<void> {
  return useCallback(async () => {
    const failed = await forgetSecrets(
      bridge,
      accounts.flatMap((a) => [[a.id], [a.id, 'imap'] as [string, SecretKind]]),
    )
    // The cached copies of remote images live outside the state document, so
    // clearing state does not touch them. The pictures themselves were public
    // on someone else's server, but the folder of them is a record of which
    // mail was opened — and a reset that leaves it behind has not done what it
    // said. Failure is deliberately silent: unlike a password, nothing here is
    // a secret, and a stubborn cache file is not a reason to report a reset as
    // failed when the accounts and schedule really are gone.
    await bridge?.clearImageCache?.().catch(() => {})
    dispatch({ type: 'reset' })
    // "Reset everything" is the strongest promise in the app. If a password
    // outlived it, that has to be said out loud rather than covered by the
    // success toast the caller shows next.
    if (failed) {
      addLog({
        kind: 'security',
        level: 'warn',
        title: 'Reset finished, but some saved passwords could not be deleted',
        detail: failed,
      })
    }
  }, [bridge, accounts, addLog, dispatch])
}
