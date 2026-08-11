/**
 * Grouping for the sending-account list.
 *
 * Once someone has a work address, a personal one, and two for a side project,
 * a flat dropdown stops being a list and starts being a search. Groups are
 * free text on the account itself — no group registry, no management screen,
 * nothing to keep in sync — and this is the one place that decides how they
 * are ordered so every screen shows them the same way.
 */

import type { MailAccount } from '../types'

export interface AccountGroup {
  /** `null` for accounts with no group. Rendered under a neutral heading. */
  name: string | null
  accounts: MailAccount[]
}

/**
 * The key that decides which accounts may be reordered against each other.
 *
 * Groups are rendered as contiguous blocks in a fixed alphabetical sequence,
 * so a row dragged out of its own block would land somewhere the next render
 * cannot draw it and snap straight back. Rather than let that happen and then
 * explain it, a drop is refused unless both rows answer this the same way.
 * Ungrouped accounts collapse to the empty string, which is a group of its
 * own — they are reorderable among themselves and nowhere else.
 */
export function accountGroupKey(account: MailAccount | undefined): string {
  return account?.group?.trim() || ''
}

/**
 * Put the hand-arranged accounts in the arrangement, and leave the rest alone.
 *
 * The contract on `MailAccount.order` is the whole reason this is a function
 * and not a `.sort((a, b) => a.order - b.order)`: the field is absent on every
 * account written before drag-ordering existed, and `undefined - 3` is `NaN`,
 * which a comparator reads as "these two are equal" — so the naive version
 * would have shuffled an untouched store into an arbitrary order the first
 * time anybody opened Settings after upgrading.
 *
 * So: accounts that carry an `order` come first, in it; accounts that do not
 * follow, in exactly the array order they already had. A store nobody has
 * dragged in has no `order` anywhere, every account falls into the second
 * bucket, and the list is byte-for-byte what it was yesterday. The moment one
 * drag happens the reducer stamps *every* account with a dense `order`, so the
 * mixed case only exists for the instant between upgrading and the first drag.
 *
 * `index` is carried through the sort rather than trusting `Array.sort` to be
 * stable. It is, since ES2019 — but "stable" is a property of the sort, not of
 * the comparator, and a comparator that returns 0 for two rows the caller can
 * tell apart is a comparator that will eventually be wrong somewhere it is
 * reused. Saying which one comes first is cheaper than remembering why it did.
 */
function byManualOrder(accounts: MailAccount[]): MailAccount[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => {
      const left = a.account.order
      const right = b.account.order
      const leftSet = typeof left === 'number' && Number.isFinite(left)
      const rightSet = typeof right === 'number' && Number.isFinite(right)
      if (leftSet && rightSet) return left - right || a.index - b.index
      if (leftSet !== rightSet) return leftSet ? -1 : 1
      return a.index - b.index
    })
    .map((entry) => entry.account)
}

/**
 * Group, then sort: named groups alphabetically, ungrouped accounts last,
 * and within each group whatever arrangement the user dragged them into.
 *
 * Ungrouped goes last rather than first on purpose. Someone who has started
 * grouping has told us the named ones are the organised part; putting the
 * leftovers at the top would push their own structure below the fold.
 *
 * The group sequence itself is deliberately *not* draggable. A group is free
 * text on the account — there is no group record to hang a position on, and
 * inventing one would mean a registry to keep in sync with a field people
 * retype by hand. Alphabetical is a rule anyone can predict; the arrangement
 * that matters is the one inside a group, and that is the one they get.
 */
export function groupAccounts(accounts: MailAccount[]): AccountGroup[] {
  const groups = new Map<string, MailAccount[]>()
  const loose: MailAccount[] = []

  for (const account of accounts) {
    const name = account.group?.trim()
    if (!name) {
      loose.push(account)
      continue
    }
    const bucket = groups.get(name)
    if (bucket) bucket.push(account)
    else groups.set(name, [account])
  }

  const out: AccountGroup[] = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, list]) => ({ name, accounts: byManualOrder(list) }))

  if (loose.length > 0) out.push({ name: null, accounts: byManualOrder(loose) })
  return out
}

/**
 * The one sequence every screen that lists accounts has to agree on.
 *
 * Settings draws `state.accounts` and the inbox draws `state.inboxAccounts`,
 * two arrays that are appended to by different code paths at different times —
 * enabling a mailbox pushes an inbox row, adding an account pushes an account
 * row, and nothing has ever made the two agree. That was not a cosmetic
 * mismatch: the same four mailboxes could read work / personal / client / spare
 * in Settings and personal / spare / work / client one tab away, which makes
 * the tab strip something you have to re-read every time instead of something
 * you learn the shape of.
 *
 * Flattening the grouped list — rather than sorting `state.accounts` directly —
 * is what makes "the same order" true top-to-bottom and not merely "sorted by
 * the same field". The nth tab in the inbox is the nth row in Settings,
 * including the way grouping rearranges them.
 */
export function orderedAccounts(accounts: MailAccount[]): MailAccount[] {
  return groupAccounts(accounts).flatMap((group) => group.accounts)
}

/** Every group name in use, for the completion list in the account dialog. */
export function knownGroups(accounts: MailAccount[]): string[] {
  return [
    ...new Set(
      accounts
        .map((a) => a.group?.trim())
        .filter((g): g is string => !!g),
    ),
  ].sort((a, b) => a.localeCompare(b))
}

/** How an account is labelled wherever it is listed. One definition, six screens. */
export function accountLabel(account: MailAccount): string {
  return account.label?.trim() || account.fromAddress
}

/**
 * Does this account still owe us a stored password?
 *
 * One definition because there were three, and they disagreed. `health.ts`
 * asked `!hasSecret` and nothing else; `preflight.ts` excluded `authMethod:
 * 'none'` but not `'oauth2'`; the Settings row excluded neither. So an account
 * signed in perfectly well with OAuth2 — where `hasSecret` is false by design,
 * because the refresh token lives under its own keystore kind and is deliberately
 * not one of these — produced a red **danger** banner reading "no stored
 * password", a preflight warning before every send, and "password: none" beside
 * its own name. Everything worked. Every screen said it was broken.
 *
 * That is the worst version of this class of bug: not a feature that silently
 * does nothing, but a *diagnosis* that is silently wrong, on the screens a user
 * consults precisely when they are trying to find out what is wrong. It also
 * trains people to ignore the one banner that would matter when a password
 * really did go missing.
 *
 * `'none'` is an internal relay that authenticates by IP and never had a
 * password to store. `'oauth2'` has a grant instead, whose health is reported
 * by `oauthState` and the self-check, not here.
 */
export function needsStoredPassword(account: Pick<MailAccount, 'authMethod' | 'hasSecret'>): boolean {
  return account.authMethod === 'password' && !account.hasSecret
}
