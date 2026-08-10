/**
 * The dispatch ledger — durable per-occurrence send state.
 *
 * Replaces the old boolean "fired-occurrences" claim (a flat set of
 * `${jobId}:${occurrenceMs}` strings meaning only "this was claimed, ever").
 * That file answered one question — "did we start sending this?" — and on
 * restart treated "yes" as "never touch it again", even when "yes" was all
 * that survived a crash mid-send. A crash between the SMTP server accepting a
 * message and `state.json` catching up looked exactly like a crash *before*
 * anything was sent, and both were resolved the same way: silence. The
 * comments in the old code called this a deliberate choice — "duplicate is
 * worse than a miss" — but that is not this application's actual tradeoff.
 * Aevistle's whole premise is that a reminder which quietly never arrives is
 * the worst outcome a scheduler can produce, and a duplicate is at least
 * visible.
 *
 * So this ledger records *where in the send an occurrence got to*, not just
 * whether it started, and restart recovery (`resolveLedgerEntryOnRestart`)
 * resolves anything short of positive proof of acceptance towards resending.
 * The convention mirrors `core/outbox.ts`'s `OutboxStatus` — "a crash mid-send
 * is resolved towards sending, not towards silence" — applied one level
 * earlier, to the claim that happens *before* the outbox or a direct send is
 * even attempted.
 *
 * One entry per occurrence, keyed by `claimKey` (`${jobId}:${occurrenceMs}`,
 * the same identity the old claim file used). Three states, not four —
 * there is no `'committed'` state, because a *missing* entry already means
 * "fully done": the entry is deleted once the job's own bookkeeping
 * (runCount / lastRunAt / status / occurrences) has recorded the outcome, and
 * "not present" is a state a JSON file gets for free. See
 * `resolveLedgerEntryOnRestart` for what each surviving state means on
 * restart, and `electron/store.ts` / `electron/scheduler.ts` for where the
 * entries actually get written, one transition at a time, each awaited
 * before the next step of the send proceeds.
 */

export type DispatchLedgerState = 'claimed' | 'sending' | 'accepted'

export interface DispatchLedgerEntry {
  /** `${jobId}:${occurrenceMs}` — identical identity to the old claim key. */
  claimKey: string
  jobId: string
  occurrenceMs: number
  /**
   * - `'claimed'`  — the occurrence has been picked to fire; no SMTP attempt
   *   has started yet (still evaluating send conditions, resolving the
   *   account, etc).
   * - `'sending'`  — an SMTP attempt is in flight right now. Written
   *   immediately before the call that could crash mid-transaction, exactly
   *   where the old claim file was written before the whole run.
   * - `'accepted'` — the SMTP server accepted the message. This is the only
   *   state with positive proof delivery was handed off; everything short of
   *   it means "resend, just in case" on restart.
   */
  state: DispatchLedgerState
  /**
   * Minted once, at claim time, and reused for every later attempt at the
   * same claimKey (a durable-write failure, a transient SMTP error, a crash
   * recovery resend all share it). Passed into `sendMail`/`MailSender.send`
   * so the *message itself* carries it as `Message-Id`, instead of the mail
   * library minting a fresh one per attempt.
   *
   * This is best-effort duplicate hinting for the recipient's mail system,
   * not a deduplication guarantee — most mail servers and clients do not
   * dedupe on `Message-Id` at all, and the ones that do are under no
   * obligation to. It exists so that *if* a resend and the original both
   * arrive, a mail client that does look at `Message-Id` has the option of
   * noticing. It is not, and must not be documented as, a promise that a
   * resend can never be seen twice.
   */
  messageId: string
  claimedAt: number
  sendingAt?: number
  acceptedAt?: number
  /**
   * How many times this claimKey has reached `claimOccurrence`/the
   * `'claimed'` write — across restarts, not across `sendOnce`'s in-process
   * retries. A fresh occurrence starts at 1; a claim that survives a crash
   * and gets resent increments it. `sendOnce`'s own retry loop writes
   * `'sending'` again per attempt without touching this counter — that loop
   * is a single claim's business, not a new claim.
   */
  attempts: number
}

/**
 * What restart recovery should do with a ledger entry that survived a crash.
 *
 * - `'resend'` — no confirmed evidence the SMTP call this entry describes
 *   ever completed. Covers both `'claimed'` (never even got as far as an
 *   attempt) and `'sending'` (an attempt was in flight when the process
 *   died — it may have succeeded, failed, or never reached the server; there
 *   is no way to tell, and the new policy resolves that ambiguity towards
 *   resending rather than towards silence).
 * - `'complete-bookkeeping-only'` — the entry reached `'accepted'`, which is
 *   only ever written after the SMTP server confirmed it took the message.
 *   Positive proof delivery happened; resending would produce a guaranteed
 *   duplicate for no benefit, so this occurrence's job bookkeeping
 *   (runCount / lastRunAt / status / occurrences) is completed as if the
 *   send had just now succeeded, without re-attempting it and without
 *   re-evaluating send conditions (the send already genuinely happened —
 *   conditions decide *whether* to send, and that question is moot).
 *
 * Pure and exported specifically so this decision table can be tested on its
 * own, adversarially, without standing up a scheduler or a filesystem — see
 * `scripts/check-dispatch-ledger.mjs`.
 */
export type RestartResolution = 'resend' | 'complete-bookkeeping-only'

export function resolveLedgerEntryOnRestart(entry: DispatchLedgerEntry): RestartResolution {
  return entry.state === 'accepted' ? 'complete-bookkeeping-only' : 'resend'
}

/**
 * `<${claimKey}.${randomHex}@aevistle.local>` — shaped like an RFC 5322
 * `msg-id`, not validated as one. `claimKey` itself (`jobId:occurrenceMs`)
 * carries a `:`, which is outside `dot-atom-text`'s `atext` alphabet; real
 * mail servers accept it in practice (nodemailer/JavaMail both pass whatever
 * string they are given straight into the `Message-Id:` header), and keeping
 * the claim key legible inside the id — rather than hashing it away — is what
 * makes a stray `Message-Id` in a bug report or a mail header dump
 * recognisable as "this app, this job, this occurrence" on sight.
 *
 * The random suffix is what makes two *different* claimKeys' ids
 * uncollidable; the deterministic prefix is what makes every resend of the
 * *same* claimKey (once `electron/store.ts` reuses the entry's existing
 * `messageId` instead of calling this again) carry the same id on purpose.
 */
export function mintMessageId(claimKey: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `<${claimKey}.${hex}@aevistle.local>`
}

/**
 * Force a pending resend back into a job's freshly-rearmed occurrences,
 * overriding whatever the job's own catch-up policy just computed.
 *
 * This exists because `rearm()` (`core/schedule.ts`) treats every missed
 * occurrence the same way regardless of *why* it was missed — and for a
 * `catchUp: 'skip'` recurrence, "missed" means "drop it, don't fire it".
 * That is the right behaviour for an occurrence nothing ever attempted (the
 * app was closed, or asleep). It is the wrong behaviour for one this
 * function's caller already tried and lost the outcome of to a crash: the
 * `'resend'` resolution in `resolveLedgerEntryOnRestart` exists specifically
 * so that class of occurrence is retried regardless of catch-up policy — a
 * `catchUp: 'skip'` job silently dropping it here would reintroduce the
 * exact silent miss the dispatch ledger exists to close, for that one
 * policy alone. See `Scheduler.pendingResend`'s doc for the full context.
 */
export function spliceForcedResends(
  occurrences: number[],
  jobId: string,
  pending: Iterable<Pick<DispatchLedgerEntry, 'jobId' | 'occurrenceMs'>>,
): number[] {
  let next = occurrences
  for (const entry of pending) {
    if (entry.jobId === jobId && !next.includes(entry.occurrenceMs)) {
      next = [entry.occurrenceMs, ...next]
    }
  }
  return next
}
