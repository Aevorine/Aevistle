/**
 * A rolling record of what the notification path decided, and why.
 *
 * The question this exists to answer is the one four releases in a row could
 * not: "it didn't tell me about that email — why not?". Every part of the
 * answer already existed in pieces. `explainArrivals` counts which rule ate
 * which arrival; `notifyPolicy` counts which of the survivors the user's own
 * settings dropped; the activity log records both as prose. What was missing
 * was somewhere to add them up, so that the Settings screen can say
 *
 *     Last 24 hours: 12 arrived, 3 announced, 9 held back
 *     · 6 already read on another device
 *     · 2 older than the window
 *     · 1 sender not on your list
 *
 * instead of the user having to read a log and do arithmetic. A number they
 * can see is also the only way a wrong *setting* is distinguishable from a
 * broken *feature*, which is the confusion this app has shipped into three
 * times.
 *
 * Entries carry counts and a timestamp. No sender, no subject, no snippet,
 * no message id — this rides in `AppState` and therefore into the backup file
 * and the sync payload, and a diagnostic that leaks the mailbox it diagnoses
 * is not worth having.
 */

/** One sync's worth of decisions, per account. */
export interface NotifyLedgerEntry {
  /** When the sync landed. Epoch ms. */
  at: number
  /** Which account. Kept so the board can break the totals down per account. */
  accountId: string
  /** How many messages the sync brought back at all. */
  examined: number
  /** Of those, how many were new to this device. */
  fresh: number
  /** How many notifications were actually raised. */
  announced: number
  /** Fresh, but already read somewhere else — `newMail.ts` rule 2. */
  readElsewhere: number
  /** Fresh and unread, but older than the recency cutoff — rule 3. */
  tooOld: number
  /** Dropped because the account is muted — `notifyPolicy` rule 1. */
  accountMuted: number
  /** Dropped because the sender is not on the allowlist — rule 2. */
  senderNotListed: number
  /** Announced only because a keyword forced them past something — rule 3. */
  forced: number
  /** Held back by the nightly quiet window. */
  quiet: number
  /** Held back because the master new-mail switch is off. */
  switchedOff: number
}

/**
 * How long an entry is worth keeping.
 *
 * Twenty-four hours, which is what the Settings line promises and is also the
 * longest window in which "why didn't it tell me?" is still a live question.
 * Past that the user is not debugging a notification, they are reading
 * statistics, and this is not a statistics feature.
 */
export const LEDGER_WINDOW_MS = 24 * 60 * 60_000

/**
 * A hard ceiling on rows, whatever their age.
 *
 * Five accounts syncing every five minutes is 1,440 entries a day, and this
 * is persisted state that gets written on every sync. The cap is what stops a
 * diagnostic from becoming a performance problem — the same reasoning as
 * `logMaxEntries`, and the same shape: whichever limit bites first wins.
 */
export const LEDGER_MAX_ENTRIES = 600

/**
 * Drop what is too old or too numerous.
 *
 * Newest kept, oldest discarded. Returns the same array instance when nothing
 * needed dropping, so the reducer can skip the state update entirely on the
 * overwhelmingly common tick where nothing has expired.
 */
export function pruneLedger(
  entries: readonly NotifyLedgerEntry[],
  now: number,
  windowMs: number = LEDGER_WINDOW_MS,
  maxEntries: number = LEDGER_MAX_ENTRIES,
): NotifyLedgerEntry[] {
  const cutoff = now - windowMs
  let kept = entries.filter((e) => e.at >= cutoff)
  if (kept.length > maxEntries) kept = kept.slice(kept.length - maxEntries)
  return kept.length === entries.length ? (entries as NotifyLedgerEntry[]) : kept
}

/** Add one entry and prune in the same pass. */
export function appendLedger(
  entries: readonly NotifyLedgerEntry[],
  entry: NotifyLedgerEntry,
  now: number = entry.at,
): NotifyLedgerEntry[] {
  return pruneLedger([...entries, entry], now)
}

/** The totals a summary line is built from. */
export interface NotifySummary {
  /** How many messages were looked at across every sync in the window. */
  examined: number
  /** How many were new to this device. */
  fresh: number
  /** How many notifications were raised. */
  announced: number
  /** Everything that was new and did not ring. */
  heldBack: number
  /** The breakdown of `heldBack`, largest first — see `reasons`. */
  readElsewhere: number
  tooOld: number
  accountMuted: number
  senderNotListed: number
  quiet: number
  switchedOff: number
  /** How many of the announcements only happened because of a keyword. */
  forced: number
  /** How many syncs the totals cover. Zero means "nothing has synced yet". */
  syncs: number
  /** The oldest entry the totals include, or 0 when there are none. */
  since: number
}

/**
 * Add up a window's entries.
 *
 * `accountId` narrows to one account; omitting it covers all of them. Prunes
 * as it reads rather than trusting the stored array to already be clean —
 * state loaded off disk can be a day stale before anything writes to it.
 */
export function summarise(
  entries: readonly NotifyLedgerEntry[],
  now: number,
  accountId?: string,
): NotifySummary {
  const live = pruneLedger(entries, now).filter((e) => !accountId || e.accountId === accountId)
  const out: NotifySummary = {
    examined: 0,
    fresh: 0,
    announced: 0,
    heldBack: 0,
    readElsewhere: 0,
    tooOld: 0,
    accountMuted: 0,
    senderNotListed: 0,
    quiet: 0,
    switchedOff: 0,
    forced: 0,
    syncs: live.length,
    since: 0,
  }
  for (const e of live) {
    out.examined += e.examined
    out.fresh += e.fresh
    out.announced += e.announced
    out.readElsewhere += e.readElsewhere
    out.tooOld += e.tooOld
    out.accountMuted += e.accountMuted
    out.senderNotListed += e.senderNotListed
    out.quiet += e.quiet
    out.switchedOff += e.switchedOff
    out.forced += e.forced
    if (out.since === 0 || e.at < out.since) out.since = e.at
  }
  out.heldBack =
    out.readElsewhere +
    out.tooOld +
    out.accountMuted +
    out.senderNotListed +
    out.quiet +
    out.switchedOff
  return out
}

/** One line of the "why not" breakdown. */
export interface NotifyReason {
  /** Which rule. Doubles as the i18n key suffix. */
  id: 'readElsewhere' | 'tooOld' | 'accountMuted' | 'senderNotListed' | 'quiet' | 'switchedOff'
  count: number
  /**
   * Where the switch that changes this behaviour lives, when there is one.
   *
   * A reason the user cannot act on is a reason not worth printing, so every
   * id above except `tooOld` names its own remedy. `tooOld` has none by
   * design: the window is not a preference, it is what stops a week offline
   * from arriving as a week of notifications.
   */
  fix?: 'notifyReadElsewhere' | 'notifyAccounts' | 'notifySenders' | 'quietHours' | 'notifyOnNewMail'
}

/**
 * The breakdown, biggest first, zeroes dropped.
 *
 * Sorted rather than fixed-order because the useful line is the dominant one:
 * "9 of your 12 were already read elsewhere" is a diagnosis, and the same six
 * reasons printed in a constant order with five zeroes among them is a table.
 */
export function reasons(summary: NotifySummary): NotifyReason[] {
  const all: NotifyReason[] = [
    { id: 'readElsewhere', count: summary.readElsewhere, fix: 'notifyReadElsewhere' },
    { id: 'tooOld', count: summary.tooOld },
    { id: 'accountMuted', count: summary.accountMuted, fix: 'notifyAccounts' },
    { id: 'senderNotListed', count: summary.senderNotListed, fix: 'notifySenders' },
    { id: 'quiet', count: summary.quiet, fix: 'quietHours' },
    { id: 'switchedOff', count: summary.switchedOff, fix: 'notifyOnNewMail' },
  ]
  return all.filter((r) => r.count > 0).sort((a, b) => b.count - a.count)
}
