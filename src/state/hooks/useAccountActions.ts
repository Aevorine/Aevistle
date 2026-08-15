/**
 * Mail-account side effects that reach the platform bridge: `saveAccount`
 * (writes the secret, then the account row) and `deleteAccount` (forgets
 * every credential an account could have before removing the row).
 *
 * Moved out of `AppState.tsx`'s `AppProvider` unchanged — see that file for
 * how this is wired in. `upsertAccount`/`removeAccount`, the pure state
 * changes these dispatch into, live in `services/accountsReducer.ts`.
 */

import { useCallback } from 'react'
import type { LogEntry, MailAccount } from '../../core/types'
import type { PlatformBridge } from '../../core/platform/bridge'
import { forgetSecrets } from '../services/secrets'

export interface AccountActionsApi {
  saveAccount: (account: MailAccount, secret?: string) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
}

/** The action shapes this hook dispatches — see `AppState.tsx`'s `Action` union for the source of truth. */
type AccountDispatchAction =
  | { type: 'upsertAccount'; account: MailAccount }
  | { type: 'removeAccount'; id: string }

export function useAccountActions(
  bridge: PlatformBridge | null,
  addLog: (entry: Omit<LogEntry, 'id' | 'at'>) => void,
  dispatch: (action: AccountDispatchAction) => void,
): AccountActionsApi {
  const saveAccount = useCallback(
    async (account: MailAccount, secret?: string) => {
      if (!bridge) return
      if (secret) {
        await bridge.setSecret(account.id, secret)
      }
      const hasSecret = await bridge.hasSecret(account.id)
      dispatch({
        type: 'upsertAccount',
        account: { ...account, hasSecret, updatedAt: Date.now() },
      })
    },
    [bridge, dispatch],
  )

  const deleteAccount = useCallback(
    async (id: string) => {
      // A deleted account's IMAP credential and cached mail are dead weight —
      // there is no UI left that could ever ask for them again.
      const failed = await forgetSecrets(bridge, [[id], [id, 'imap']])

      /*
       * The OAuth2 grant, which `forgetSecrets` cannot reach and used to be
       * left behind.
       *
       * It is stored under its own keystore kinds — `oauth` for the refresh
       * token and `oauth-grant` for the record beside it — and those are not in
       * `SecretKind`, so there is no `deleteSecret` call that would remove
       * them. Deleting an account therefore took away the row, the password and
       * the IMAP credential, and quietly left a *long-lived refresh token* in
       * the OS keystore: a credential strictly more valuable than the password
       * next to it, because it mints new access tokens without anyone being
       * asked anything. Nothing errored, nothing was logged, and the user had
       * every reason to believe the account was gone.
       *
       * `oauthDisconnect` is the cleanup both platforms already implement —
       * Electron's `forgetOAuthAccount` even documents itself as "called when
       * it is deleted", which until now it was not. Called for every account
       * rather than only those currently marked `oauth2`: an account switched
       * back to a password keeps its grant until something clears it, and that
       * orphan is the one nobody would think to look for. The call is a no-op
       * when there is nothing stored.
       *
       * Failure is swallowed on purpose. The keystore write is best-effort
       * cleanup of something already unreachable, and a deletion that refuses
       * to complete because of it would leave the user with an account they
       * cannot remove — a worse outcome than a stale token, and one they could
       * do nothing about.
       */
      try {
        await bridge?.oauthDisconnect?.(id)
      } catch (e) {
        addLog({
          kind: 'security',
          level: 'warn',
          title: 'Account removed, but its sign-in grant could not be deleted',
          detail: e instanceof Error ? e.message : String(e),
        })
      }

      dispatch({ type: 'removeAccount', id })
      // The row disappears either way, so a swallowed failure here reads as
      // "the password is gone" while it is still sitting in the OS credential
      // store. Logged after the dispatch so the entry survives it.
      if (failed) {
        addLog({
          kind: 'security',
          level: 'warn',
          title: 'Account removed, but its saved password could not be deleted',
          detail: failed,
        })
      }
    },
    [bridge, addLog, dispatch],
  )

  return { saveAccount, deleteAccount }
}
