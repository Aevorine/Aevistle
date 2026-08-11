/**
 * Which freshly synced messages are worth interrupting someone for.
 *
 * Until this file existed, ordinary mail arriving raised nothing at all on
 * either platform. The only notifications the app had ever produced were a
 * scheduled send's result and a verification code — so a mailbox this app is
 * actively watching could take delivery of anything else in complete silence,
 * and the user's own description of it ("收到邮件的显示通知不够好") was, on
 * inspection, generous: there was no notification to be unhappy with.
 *
 * The decision is kept here, away from React and away from both platform
 * layers, because it is the part that is easy to get subtly wrong and easy to
 * test. Three rules do the work, and each one exists because of a specific way
 * a naive "tell me about new mail" fires when it should not:
 *
 *   1. **Not before the app is primed.** The first sync after launch discovers
 *      the entire mailbox. Every message in it is "new" to a process that has
 *      only just started, and announcing them would mean opening the app to a
 *      burst of notifications about mail you read yesterday. `primed` is the
 *      caller's promise that a baseline exists.
 *
 *   2. **Only what is genuinely unseen.** A message already flagged `\Seen` was
 *      read somewhere else — a phone, a webmail tab — and arriving at this
 *      device is not an event in the user's life. This also covers the case of
 *      an account being re-added: the server hands back read mail, and none of
 *      it should ring.
 *
 *   3. **Only what is genuinely recent.** A folder that has been offline for a
 *      week catches up in one sync. Those messages are new *to the cache* and
 *      old to the world, so the window is checked against the message's own
 *      date rather than against when we happened to hear about it.
 *
 * What comes back is a decision, not a sentence: the count, the newest arrival
 * and whether it stands alone. Wording is the view layer's job in six
 * languages, and the Android background worker — which cannot reach any of
 * them — builds its own from the same three rules reimplemented in Java, with
 * `check-new-mail.mjs` holding the two to the same numbers.
 */

import type { InboxMessage } from '../types'

/**
 * How recent a message has to be to be worth announcing.
 *
 * Thirty minutes, which is deliberately wider than a sync interval (five
 * minutes by default, fifteen on Android's WorkManager floor) and far narrower
 * than a working day. Wide enough that a phone which woke up late still tells
 * you; narrow enough that a laptop opened after lunch does not recite the
 * morning.
 */
export const NEW_MAIL_WINDOW_MS = 30 * 60_000

/**
 * How many arrivals are named individually before the announcement collapses
 * into a count.
 *
 * One. Two notifications are not twice as useful as one and five are worse
 * than one — the value of "you have mail" saturates immediately, and the
 * screen is right there for the detail. So a single arrival gets the sender
 * and the subject, and anything more gets a number and the newest sender.
 */
export const NEW_MAIL_NAMED_LIMIT = 1

export interface NewMailAnnouncement {
  /** How many arrivals this covers. Always at least one. */
  count: number
  /** The most recent of them — what the notification is actually about. */
  newest: InboxMessage
}

/**
 * The arrivals worth announcing, newest first.
 *
 * `before` is the set of message ids known *before* this sync. Passing an
 * empty set with `primed: true` therefore means "everything here is new",
 * which is true for an account that genuinely had nothing — and is why
 * `primed` is a separate flag rather than being inferred from the set being
 * empty.
 */
export function newArrivals(opts: {
  before: ReadonlySet<string>
  after: readonly InboxMessage[]
  now: number
  primed: boolean
}): InboxMessage[] {
  if (!opts.primed) return []
  const cutoff = opts.now - NEW_MAIL_WINDOW_MS
  return opts.after
    .filter((m) => !opts.before.has(m.id) && !m.seen && m.date >= cutoff)
    .sort((a, b) => b.date - a.date)
}

/**
 * Collapse a run of arrivals into the one thing to say about them.
 *
 * `null` for an empty run, so the caller's guard is a single truthiness check
 * rather than a length test it can forget to write.
 */
export function announcementFor(arrivals: readonly InboxMessage[]): NewMailAnnouncement | null {
  if (arrivals.length === 0) return null
  // `newArrivals` sorts, but this is called from the notification path and a
  // caller that assembled its own list must not be able to announce the wrong
  // message by handing them over unsorted.
  const newest = arrivals.reduce((a, b) => (b.date > a.date ? b : a))
  return { count: arrivals.length, newest }
}

/**
 * A sender as a person rather than as a header.
 *
 * `"Alex Chen" <alex@example.com>` becomes `Alex Chen`; a bare address is left
 * alone. A notification has one line for this and the quoted display name is
 * both what the user recognises and what fits.
 */
export function senderName(from: string): string {
  const named = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from)
  const name = named?.[1]?.trim()
  return name || from.trim()
}

/**
 * The body line of a new-mail notification: the subject, then as much of the
 * snippet as is worth carrying.
 *
 * Trimmed to `limit` characters because both platforms truncate anyway and
 * they truncate differently — doing it here means the same text on both, and
 * means the ellipsis lands on a boundary we chose rather than mid-word at
 * whatever width the shade happens to be.
 */
export function previewLine(message: InboxMessage, limit = 120): string {
  const snippet = message.snippet.replace(/\s+/g, ' ').trim()
  if (!snippet) return ''
  return snippet.length > limit ? `${snippet.slice(0, limit - 1).trimEnd()}…` : snippet
}
