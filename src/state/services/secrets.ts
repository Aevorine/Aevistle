/**
 * Delete a batch of stored credentials and report, in one string, whichever
 * ones refused to go.
 *
 * Every caller here deletes secrets as the last step of removing something the
 * user can see, so a rejected promise has no natural place to surface: the row
 * is already gone. Returning the failures instead of swallowing them lets the
 * caller say so, and the empty case stays cheap — `null` means "all clear".
 *
 * Moved out of `AppState.tsx` unchanged — a pure helper over `PlatformBridge`
 * with no dependency on component state, shared by `useAccountActions`,
 * `usePairingActions`, and `AppState.tsx`'s own `resetEverything`.
 */

import type { PlatformBridge } from '../../core/platform/bridge'
import type { SecretKind } from '../../core/types'

export async function forgetSecrets(
  bridge: PlatformBridge | null,
  targets: Array<[accountId: string, kind?: SecretKind]>,
): Promise<string | null> {
  if (!bridge) return null
  const failures: string[] = []
  for (const [accountId, kind] of targets) {
    try {
      await bridge.deleteSecret(accountId, kind)
    } catch (e) {
      failures.push(`${accountId}${kind ? `/${kind}` : ''}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return failures.length ? failures.join('; ') : null
}
