/**
 * The `AppState` reducer's mail-account domain: adding/editing
 * (`upsertAccount`), reordering (`reorderAccounts`), and deleting
 * (`removeAccount`) an entry in `state.accounts`.
 *
 * Extracted out of `AppState.tsx`'s main switch, case for case, with no
 * behaviour change — see that file's reducer for how this is wired in.
 */

import type { AppState, MailAccount } from '../../core/types'

/** The action shapes this domain's cases handle — see `AppState.tsx`'s `Action` union for the source of truth. */
export type AccountAction =
  | { type: 'upsertAccount'; account: MailAccount }
  | { type: 'reorderAccounts'; ids: string[] }
  | { type: 'removeAccount'; id: string }

/**
 * Apply one of this domain's actions. Called from `AppState.tsx`'s main
 * switch for exactly the three case labels above, grouped onto one shared
 * case body — the switch here still has one branch per action, unchanged
 * from what lived inline in `AppState.tsx` before the move.
 */
export function applyAccountAction(state: AppState, action: AccountAction): AppState {
  switch (action.type) {
    case 'upsertAccount': {
      const exists = state.accounts.some((a) => a.id === action.account.id)
      const accounts = exists
        ? state.accounts.map((a) => (a.id === action.account.id ? action.account : a))
        : [...state.accounts, action.account]
      // A configured default wins; otherwise the first account added becomes
      // the draft's sender automatically.
      const draft =
        state.draft.accountId || exists
          ? state.draft
          : { ...state.draft, accountId: state.settings.defaultAccountId || action.account.id }
      return { ...state, accounts, draft }
    }

    /*
     * The user dragged an account somewhere, and this is where it sticks.
     *
     * The action carries the *whole* intended sequence of ids rather than
     * "move X above Y". A move instruction has to be replayed against
     * whatever the array happens to look like when it lands, and the two
     * screens that send these do not read the array — they read the
     * grouped, sorted view of it. Sending the finished sequence means the
     * reducer never has to reconstruct which of several possible starting
     * states the drag was aimed at; there is exactly one answer and the
     * caller already computed it.
     *
     * Two pieces of paranoia, both cheap:
     *
     *   - ids that name nothing, and ids named twice, are dropped. The list
     *     is assembled from a rendered view, and a render that raced a
     *     deletion would otherwise resurrect an account here by putting its
     *     id back into `accounts` — with `byId.get` returning `undefined`
     *     and the array growing a hole that every later `a.id` read would
     *     throw on.
     *   - accounts the caller did not mention are appended, keeping their
     *     relative order. The inbox strip only lists mailboxes with syncing
     *     switched on, so it *cannot* name every account; without this, one
     *     drag in the inbox would delete every account that has no inbox.
     *
     * Then every account is renumbered densely from zero — not just the
     * ones that moved. Reusing the old numbers and only patching the moved
     * row is how ties accumulate: two accounts on `order: 3` sort by array
     * position, which is the thing the user just overrode. A dense renumber
     * has no ties to accumulate, and it is also what converts a store that
     * predates the field: after the first drag every account carries an
     * `order`, so the "absent sorts last" branch in `core/accounts` stops
     * being reachable.
     *
     * Returning `state` untouched when nothing actually moved matters more
     * here than it looks. A new `accounts` array identity is what the save
     * effect watches, and `dragover` fires on every pixel of pointer travel
     * — a commit that changed nothing would still rewrite the whole
     * document to disk, and on Android that is a real write to real
     * storage.
     */
    case 'reorderAccounts': {
      const byId = new Map(state.accounts.map((a) => [a.id, a]))
      const taken = new Set<string>()
      const sequence: MailAccount[] = []
      for (const id of action.ids) {
        const account = byId.get(id)
        if (!account || taken.has(id)) continue
        taken.add(id)
        sequence.push(account)
      }
      for (const account of state.accounts) {
        if (!taken.has(account.id)) sequence.push(account)
      }

      const accounts = sequence.map((account, index) =>
        account.order === index ? account : { ...account, order: index },
      )
      const settled = accounts.every((account, index) => state.accounts[index] === account)
      return settled ? state : { ...state, accounts }
    }

    case 'removeAccount': {
      const accounts = state.accounts.filter((a) => a.id !== action.id)
      // Any job pointing at the deleted account is disabled rather than
      // silently retargeted — sending from a different address without
      // saying so would be worse than not sending.
      const jobs = state.jobs.map((j) =>
        j.draft.accountId === action.id ? { ...j, enabled: false, status: 'paused' as const } : j,
      )
      /*
       * A default pointing at a now-deleted account is dead state, not a
       * preference — clear it so the next account falls back cleanly.
       *
       * All three of them. `defaultAccountId` was the only one cleared, and
       * the other two are read the same way: `digestAccountId ||
       * defaultAccountId || accounts[0]`. A dangling id short-circuits that
       * chain, `find` returns undefined, and the sender gives up at its
       * `if (!account) return`. Delete the account the daily digest was
       * using and the digest switch still reads ON, the "no account" notice
       * stays hidden because there IS an account, and no digest is ever
       * sent again — with nothing anywhere saying so. Same for holiday
       * greetings.
       */
      const settings =
        state.settings.defaultAccountId === action.id ||
        state.settings.digestAccountId === action.id ||
        state.settings.greetingAccountId === action.id
          ? {
              ...state.settings,
              defaultAccountId:
                state.settings.defaultAccountId === action.id ? undefined : state.settings.defaultAccountId,
              digestAccountId:
                state.settings.digestAccountId === action.id ? undefined : state.settings.digestAccountId,
              greetingAccountId:
                state.settings.greetingAccountId === action.id ? undefined : state.settings.greetingAccountId,
            }
          : state.settings
      const draft =
        state.draft.accountId === action.id
          ? { ...state.draft, accountId: settings.defaultAccountId || accounts[0]?.id || '' }
          : state.draft
      // An inbox for a deleted account is dead state, not a paused feature —
      // there is no credential left to sync it with.
      const inboxAccounts = state.inboxAccounts.filter((i) => i.accountId !== action.id)
      return { ...state, accounts, jobs, draft, inboxAccounts, settings }
    }
  }
}
