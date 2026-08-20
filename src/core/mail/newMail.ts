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
 * Rules 1 and 3 share an assumption that quietly stopped holding the moment
 * "notify me with the app closed" became the point: that the previous look at
 * this mailbox was both *recent* and *in this process*. Neither is true after
 * the app has been shut, and between them the two rules threw away exactly the
 * mail the feature exists for — the first sync back only primed, and by the
 * second sync a night's post was hours old and outside the window. So the
 * baseline is now recovered from what was saved (`restoredBaseline`) and the
 * window is widened to the account's own last sync (`recencyCutoff`). Both are
 * bounded, and neither weakens rule 2: mail read on the phone still never
 * rings here.
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
 * The furthest back the window may ever be widened by `since`.
 *
 * Seven days, and it exists because `since` is only as trustworthy as the last
 * sync that wrote it. An account paused for a month, a laptop opened after a
 * holiday, a clock that jumped — each hands `recencyCutoff` a `since` from the
 * distant past, and without a floor the first sync back would treat a month of
 * mail as having "arrived while you were away". The count in a collapsed
 * announcement is meant to be a number someone can act on, not a mailbox
 * total. Past this the ordinary rule is the honest one: it is not news.
 */
export const MISSED_MAIL_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/**
 * The oldest a message may be and still count as an arrival.
 *
 * Ordinarily `NEW_MAIL_WINDOW_MS`, which assumes the previous look at this
 * mailbox was recent — true while the app is running and syncing on a timer,
 * and false in the one case this whole parameter exists for: the app was not
 * running. Mail that landed while the app was closed is hours old by the time
 * anything looks, so the plain window drops precisely the arrivals the user
 * most wanted to hear about, and the app comes back silent about a night's
 * post.
 *
 * `since` is when this account last completed a sync. Everything after that
 * moment is, by definition, something we have not looked at yet — so it is the
 * correct cutoff rather than a guess, and it never *narrows* the window: a
 * sync a minute ago still leaves the ordinary thirty minutes in force, because
 * a message can be older than the last sync and still be new to it (it was
 * unseen and off the end of the fetched page, or the server delivered it late).
 * `MISSED_MAIL_MAX_AGE_MS` bounds how far back a stale `since` can reach.
 *
 * Absent, zero or nonsense `since` means "no trustworthy last look" — an
 * account that has never synced — and falls back to the ordinary window.
 */
export function recencyCutoff(now: number, since?: number): number {
  const ordinary = now - NEW_MAIL_WINDOW_MS
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return ordinary
  return Math.max(now - MISSED_MAIL_MAX_AGE_MS, Math.min(ordinary, since))
}

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

/**
 * What an account was known to hold, and when that knowledge was last true.
 *
 * The shape `newArrivals` needs on the way in. Kept as a type rather than
 * three loose parameters because `restoredBaseline` builds one and the caller
 * passes it straight through.
 */
export interface MailBaseline {
  /** Message ids known before the sync now landing. */
  ids: Set<string>
  /** Whether those ids are a trustworthy record rather than an empty start. */
  primed: boolean
  /** When this account last completed a sync, if it ever has. */
  since?: number
}

/**
 * The baseline recovered from a saved account row, for the first sync of a
 * session.
 *
 * This is the whole of "the app was closed, mail came in, tell me about it".
 * An account's message list and `lastSyncAt` are persisted, so the row loaded
 * at startup is a real record of the mailbox as of the last time the app ran.
 * Treating that as an empty start — which is what a fresh in-memory map amounts
 * to — is what made a night's mail vanish: the first sync only "primed",
 * announced nothing, and by the second sync those messages were no longer new
 * to anyone. Nothing threw and nothing logged; the app simply came back quiet.
 *
 * `primed` turns on `lastSyncAt` rather than on the message list being
 * non-empty, because an account that genuinely held nothing last night is
 * still a trustworthy baseline, while an account that has never synced is not.
 * That second case is the burst of notifications `primed` exists to prevent,
 * and it is the only case that should reach the app as an empty start.
 *
 * Deliberately tolerant of a malformed row: this reads data that has been on
 * disk across upgrades, and the failure that matters is announcing a whole
 * mailbox, not throwing.
 */
export function restoredBaseline(saved: {
  messages?: readonly { id: string }[]
  lastSyncAt?: number
} | undefined): MailBaseline {
  const lastSyncAt = saved?.lastSyncAt
  if (typeof lastSyncAt !== 'number' || !Number.isFinite(lastSyncAt) || lastSyncAt <= 0) {
    return { ids: new Set<string>(), primed: false }
  }
  return {
    ids: new Set((saved?.messages ?? []).map((m) => m.id)),
    primed: true,
    since: lastSyncAt,
  }
}

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
 *
 * `since` is when this account last completed a sync, and is what makes the
 * first sync after a restart able to report mail that arrived while the app
 * was closed. See `recencyCutoff`. Omitting it keeps the ordinary window.
 */
export function newArrivals(opts: {
  before: ReadonlySet<string>
  after: readonly InboxMessage[]
  now: number
  primed: boolean
  since?: number
  /**
   * Announce mail another device has already read — rule 2, switched off.
   *
   * Off by default, because rule 2 is right for a mailbox where "unread" means
   * something. It is wrong for a mailbox where nothing is ever unread, and that
   * turns out not to be a corner case: a phone with a stock mail app polling
   * the same account reads everything within seconds, so by the time any other
   * device looks, every message is `\Seen` and this rule silently eats all of
   * them. The result is an app that has fetched the mail, listed the mail, and
   * says nothing about the mail — with nothing anywhere to say why.
   *
   * `explainArrivals` is the other half of the answer: the reason is now
   * recorded whether or not this is on, so the choice can be made from evidence
   * instead of from guessing.
   */
  includeRead?: boolean
}): InboxMessage[] {
  return explainArrivals(opts).arrivals
}

/** Why an arrival that the sync brought back was not worth announcing. */
export type SuppressionReason = 'alreadyKnown' | 'readElsewhere' | 'tooOld'

/**
 * What a sync brought back, what was announced, and what ate the rest.
 *
 * The counts, not the messages: this is written to the activity log, which is
 * exportable as CSV, so it carries no sender, no subject and no snippet.
 *
 * It exists because four releases in a row shipped a fix for "new mail raises
 * nothing" against a decision that logged nothing and rendered nothing. Every
 * one of those releases was verifiable only by waiting for mail to arrive and
 * seeing whether anything happened — which is not a test, it is a vigil. A
 * suppressed arrival now leaves a record naming the rule that suppressed it.
 */
export interface ArrivalReport {
  /** Announced, newest first. */
  arrivals: InboxMessage[]
  /** How many messages this sync brought back at all. */
  examined: number
  /** Of those, how many were new to this device. */
  fresh: number
  /** Fresh, but already read somewhere else. */
  readElsewhere: number
  /** Fresh and unread, but older than the cutoff. */
  tooOld: number
  /** False when there was no trustworthy baseline, so nothing could be announced. */
  primed: boolean
  /** The moment before which an arrival stops counting as news. */
  cutoff: number
}

/**
 * `newArrivals`, with the reasons kept rather than thrown away.
 *
 * The rules are applied in the order they are documented at the top of this
 * file and a message is attributed to the *first* one that drops it, so the
 * counts partition the fresh messages exactly and cannot double-count.
 */
export function explainArrivals(opts: {
  before: ReadonlySet<string>
  after: readonly InboxMessage[]
  now: number
  primed: boolean
  since?: number
  includeRead?: boolean
  /**
   * A message this must not drop, whatever rules 2 and 3 say about it.
   *
   * The escape hatch for `core/mail/notifyPolicy.ts`'s keyword rule: a subject
   * carrying 验证码 or "invoice" is the mail someone is actively waiting for,
   * and both of the rules above it are calibrated for mail nobody is waiting
   * for. Read elsewhere ten seconds ago on a phone, or landed an hour before
   * the laptop woke — either is ordinary for a code, and either silently ate
   * it before this existed.
   *
   * Rule 1 is deliberately *not* overridable. An unprimed baseline is not a
   * preference; it is the app admitting it does not know what was already in
   * the mailbox, and forcing past it would announce the whole inbox.
   *
   * Absent means nothing is forced, which is the behaviour that shipped
   * before it: the caller that has no policy passes no predicate.
   */
  force?: (message: InboxMessage) => boolean
}): ArrivalReport {
  const cutoff = recencyCutoff(opts.now, opts.since)
  const report: ArrivalReport = {
    arrivals: [],
    examined: opts.after.length,
    fresh: 0,
    readElsewhere: 0,
    tooOld: 0,
    primed: opts.primed,
    cutoff,
  }
  // Counted even when unprimed, so the first sync of a session can still say
  // "37 messages, no baseline yet" rather than looking like an empty mailbox.
  for (const m of opts.after) {
    if (opts.before.has(m.id)) continue
    report.fresh++
    // Evaluated once and before either rule, so a forced message is never
    // attributed to a rule that did not in fact drop it — the counts still
    // partition the fresh messages exactly.
    const forced = opts.force?.(m) === true
    if (!forced && m.seen && !opts.includeRead) {
      report.readElsewhere++
      continue
    }
    if (!forced && m.date < cutoff) {
      report.tooOld++
      continue
    }
    if (opts.primed) report.arrivals.push(m)
  }
  report.arrivals.sort((a, b) => b.date - a.date)
  return report
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
