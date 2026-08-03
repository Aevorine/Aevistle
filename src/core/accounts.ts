/**
 * Grouping for the sending-account list.
 *
 * Once someone has a work address, a personal one, and two for a side project,
 * a flat dropdown stops being a list and starts being a search. Groups are
 * free text on the account itself — no group registry, no management screen,
 * nothing to keep in sync — and this is the one place that decides how they
 * are ordered so every screen shows them the same way.
 */

import type { MailAccount } from './types'

export interface AccountGroup {
  /** `null` for accounts with no group. Rendered under a neutral heading. */
  name: string | null
  accounts: MailAccount[]
}

/**
 * Group, then sort: named groups alphabetically, ungrouped accounts last.
 *
 * Ungrouped goes last rather than first on purpose. Someone who has started
 * grouping has told us the named ones are the organised part; putting the
 * leftovers at the top would push their own structure below the fold.
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
    .map(([name, list]) => ({ name, accounts: list }))

  if (loose.length > 0) out.push({ name: null, accounts: loose })
  return out
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
