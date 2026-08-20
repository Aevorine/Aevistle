/**
 * Which of the arrivals `newMail.ts` produced are actually worth a notification
 * *for this user, on this account*.
 *
 * `newMail.ts` answers a question about the mail: is this message new, unseen
 * and recent? That question has one right answer and no preferences in it. This
 * file answers the question after it — the user's own — and the two are kept
 * apart deliberately, because mixing them is how "tell me about new mail"
 * became unusable in both directions at once.
 *
 * The reported shape of the problem was a mailbox that rings for recruitment
 * spam all day and stays silent for the one message that mattered. Turning
 * notifications off fixes the first half and makes the second half permanent,
 * which is the choice this app kept offering. Three rules replace it, and each
 * one is a different answer to "which mail is worth interrupting me for":
 *
 *   1. **By account.** The junk account never rings; the work account always
 *      does. This is the coarse control and the one most people only ever need
 *      — it is a single switch per account, and an account with no entry keeps
 *      the global behaviour, so an install that never opens this screen is
 *      unaffected.
 *
 *   2. **By sender.** Once a list exists, *only* the people on it ring. This
 *      is the strictest rule in the file and it is opt-in for that reason: an
 *      empty list means "everyone", never "no one". A list that silently meant
 *      silence would be indistinguishable from the bug this whole feature
 *      exists to fix.
 *
 *   3. **By keyword.** A subject carrying "verification code", "invoice" or
 *      "interview" rings *regardless* of the two rules above and regardless of
 *      rule 2 in `newMail.ts` (already read elsewhere) and of quiet hours.
 *      This is the escape hatch: the rules above are about ordinary mail, and
 *      the whole point of ordinary is that some mail is not.
 *
 * Everything here is pure and platform-free, for the same reason `newMail.ts`
 * is: the decision is the part that is easy to get subtly wrong, and a decision
 * that can only be tested by waiting for mail to arrive is not tested at all.
 * `check-notify-policy.mjs` runs it against the cases below.
 *
 * What comes back is never a bare boolean. Every suppression names the rule
 * that made it, because the failure mode this replaces was a notification that
 * did not happen with nothing anywhere to say why.
 */

import type { InboxMessage } from '../types'

/** Why an arrival that survived `newMail.ts` still raised nothing. */
export type PolicySuppression =
  /** The user turned this account's notifications off. Rule 1. */
  | 'accountMuted'
  /** A sender list exists and this sender is not on it. Rule 2. */
  | 'senderNotListed'

/** Why an arrival rings even though something else would have stopped it. */
export type PolicyOverride =
  /** A keyword in the subject. Rule 3 — outranks everything below the master switch. */
  'keyword'

export interface PolicyDecision {
  /** Whether to raise a notification for this message. */
  notify: boolean
  /** Set when `notify` is false: which of the three rules stopped it. */
  suppressed?: PolicySuppression
  /** Set when `notify` is true *because* a rule forced it past a suppression. */
  override?: PolicyOverride
  /**
   * Whether this decision outranks quiet hours and the read-elsewhere rule.
   *
   * Only ever true alongside `override: 'keyword'`. Read by the caller *before*
   * it applies its own gates, which is the only way rule 3 can mean what it
   * says: a decision made after quiet hours have already returned early is a
   * decision about nothing.
   */
  urgent: boolean
}

/**
 * The user's answers, as stored in settings.
 *
 * Every field is optional and every absent field means "no opinion", so the
 * whole of this reads as the behaviour that shipped before it existed. That is
 * not politeness about upgrades; it is what makes the module safe to call
 * unconditionally from the notification path.
 */
export interface NotifyPolicy {
  /**
   * Per-account override, keyed by `accountId`. Absent key = follow the global
   * switch. `false` = this account never raises new-mail notifications.
   */
  accounts?: Record<string, boolean>
  /**
   * Addresses (or bare domains) that may ring. Empty or absent = everyone may.
   *
   * Matched against the message's `from` case-insensitively. An entry
   * containing `@` matches the address; an entry without one matches any
   * address whose domain ends with it, so `example.com` covers the whole
   * company without thirty rows.
   */
  senders?: string[]
  /**
   * Words that force a notification. Matched case-insensitively against the
   * subject and against the sender's display name.
   *
   * Deliberately substring rather than word-boundary matching: the list is
   * written by a person for their own mailbox, the languages it has to work in
   * include ones with no spaces between words, and a Chinese user typing
   * 验证码 expects it to match 您的验证码是 — which a word-boundary regex would
   * not.
   */
  keywords?: string[]
}

/** Lower-cased, trimmed, empties dropped — the shape every rule below wants. */
function clean(list: readonly string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const v = raw.trim().toLowerCase()
    if (v) out.push(v)
  }
  return out
}

/**
 * The bare address out of a `From` header.
 *
 * `"Alex Chen" <alex@example.com>` becomes `alex@example.com`; a header that is
 * already a bare address is returned as-is. Lower-cased, because addresses are
 * compared and never displayed from here.
 */
export function fromAddress(from: string): string {
  const angled = /<([^>]*)>/.exec(from)
  return (angled?.[1] ?? from).trim().toLowerCase()
}

/**
 * Does this sender appear on an allowlist?
 *
 * An entry with `@` in it is an address and must match in full — a substring
 * test would make `a@b.com` match `evil-a@b.com.attacker.net`. An entry without
 * `@` is a domain and matches the address's own domain or any subdomain of it,
 * anchored at the right, so `example.com` matches `mail.example.com` and never
 * `notexample.com`.
 */
export function senderAllowed(from: string, allow: readonly string[]): boolean {
  const list = clean(allow)
  if (list.length === 0) return true
  const address = fromAddress(from)
  const domain = address.slice(address.lastIndexOf('@') + 1)
  for (const entry of list) {
    if (entry.includes('@')) {
      if (entry === address) return true
      continue
    }
    if (domain === entry || domain.endsWith(`.${entry}`)) return true
  }
  return false
}

/**
 * Does anything in the subject (or the sender's display name) force this
 * through?
 *
 * The display name is included because "面试" is as likely to be the recruiter's
 * name on the envelope as it is to be in the subject, and a rule that only
 * reads one of the two fields is a rule people report as broken.
 */
export function keywordHit(message: InboxMessage, keywords: readonly string[]): boolean {
  const list = clean(keywords)
  if (list.length === 0) return false
  const haystack = `${message.subject ?? ''} ${message.from ?? ''}`.toLowerCase()
  return list.some((k) => haystack.includes(k))
}

/**
 * Whether this account may raise new-mail notifications at all.
 *
 * Split out because the sync path wants to know this *before* doing the work
 * of building an announcement, and because the settings screen renders one
 * switch per account from the same answer.
 */
export function accountNotifies(accountId: string, policy: NotifyPolicy | undefined): boolean {
  const entry = policy?.accounts?.[accountId]
  return entry !== false
}

/**
 * The decision for one message.
 *
 * Order matters and is the order documented at the top of the file, with one
 * inversion: the keyword rule is evaluated *first* so that it can report an
 * override rather than merely surviving the other two. A message that would
 * have passed anyway reports no override, so `override` always means "this
 * would otherwise have been silent" — which is what makes it worth showing in
 * the log.
 */
export function decideNotification(
  message: InboxMessage,
  accountId: string,
  policy: NotifyPolicy | undefined,
): PolicyDecision {
  const urgent = keywordHit(message, policy?.keywords ?? [])

  // Rule 1. Muting an account is the user saying "never, from here" in as many
  // words, so it is the one thing a keyword does not talk its way past: the
  // alternative is a mute switch that does not mute, which is worse than no
  // switch at all.
  if (!accountNotifies(accountId, policy)) {
    return { notify: false, suppressed: 'accountMuted', urgent: false }
  }

  // Rule 2, unless rule 3 says otherwise.
  if (!senderAllowed(message.from ?? '', policy?.senders ?? [])) {
    return urgent
      ? { notify: true, override: 'keyword', urgent: true }
      : { notify: false, suppressed: 'senderNotListed', urgent: false }
  }

  return urgent ? { notify: true, override: 'keyword', urgent: true } : { notify: true, urgent: false }
}

/** What one sync's worth of decisions came to. */
export interface PolicyOutcome {
  /** The messages to announce, in the order they were given. */
  keep: InboxMessage[]
  /** How many were dropped because their account is muted. */
  accountMuted: number
  /** How many were dropped because their sender is not on the list. */
  senderNotListed: number
  /** How many rang only because a keyword forced them. */
  forced: number
  /**
   * True when at least one kept message was urgent.
   *
   * The caller uses this to decide whether quiet hours and the read-elsewhere
   * rule apply to this batch at all — see `urgent` on `PolicyDecision`.
   */
  urgent: boolean
}

/**
 * Apply the policy to a whole sync's arrivals.
 *
 * Returns counts rather than reasons per message for the same reason
 * `ArrivalReport` does: this is written to the activity log, which is
 * exportable, and a log carrying senders and subjects is a log that leaks.
 */
export function applyPolicy(
  messages: readonly InboxMessage[],
  accountId: string,
  policy: NotifyPolicy | undefined,
): PolicyOutcome {
  const out: PolicyOutcome = {
    keep: [],
    accountMuted: 0,
    senderNotListed: 0,
    forced: 0,
    urgent: false,
  }
  for (const m of messages) {
    const d = decideNotification(m, accountId, policy)
    if (d.notify) {
      out.keep.push(m)
      if (d.override === 'keyword') out.forced++
      if (d.urgent) out.urgent = true
      continue
    }
    if (d.suppressed === 'accountMuted') out.accountMuted++
    else if (d.suppressed === 'senderNotListed') out.senderNotListed++
  }
  return out
}

/**
 * The keywords a fresh install starts with — empty.
 *
 * Not the obvious "验证码, invoice, interview" seed, and the reason is rule 3's
 * own power: a keyword outranks quiet hours, so a seeded list would mean an
 * app that shipped with permission to wake someone at 03:00 for a word they
 * never typed. The Settings screen offers the same three as one-tap
 * suggestions instead, which is the same convenience with consent attached.
 */
export const DEFAULT_NOTIFY_KEYWORDS: readonly string[] = []

/**
 * The suggestions offered under the keyword field.
 *
 * i18n keys, not text: what counts as "invoice" in a Chinese mailbox is 发票,
 * and a suggestion list in English is a suggestion list for one of six
 * audiences.
 */
export const KEYWORD_SUGGESTION_KEYS: readonly string[] = [
  'settings.notifyKeywordCode',
  'settings.notifyKeywordInvoice',
  'settings.notifyKeywordInterview',
]
