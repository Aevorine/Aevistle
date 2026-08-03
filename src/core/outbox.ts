/**
 * The offline queue.
 *
 * A send that fails because the laptop is on a train has nothing wrong with
 * it. Before this existed the only options were "retype it later" or "leave
 * the window open and remember" — and the second one is how a message gets
 * lost, because the window does not stay open.
 *
 * The rules that make a queue safe rather than alarming:
 *
 * - **Only queue what a retry can fix.** A wrong password or a malformed
 *   address fails identically forever; queueing it produces a message that
 *   sits there being retried until someone notices. Those are reported, not
 *   queued. See `isQueueable`.
 * - **A crash mid-send is resolved towards sending, not towards silence.** An
 *   item is marked `sending` while the attempt is in flight, and anything
 *   still marked `sending` at the next launch goes back to `waiting`. The
 *   window is small but real: a crash between the server accepting and the
 *   state being written produces a duplicate. That is the deliberate choice —
 *   this application's whole premise is that a reminder which quietly does not
 *   arrive is the worst outcome, and a duplicate is at least visible.
 * - **Give up out loud.** After `MAX_ATTEMPTS` an item stops retrying and is
 *   marked failed, still on screen, with its last error. A queue that retries
 *   forever is a queue nobody reads.
 */

import { newId, type ErrorKind, type MessageDraft, type SendResult } from './types'

export const MAX_ATTEMPTS = 8
/** Cap on queue length. Beyond this something is wrong that retrying will not fix. */
export const OUTBOX_CAP = 100

/**
 * Backoff, in ms, for attempt number `n` (1-based): 30 s, 1 m, 2 m, 4 m …
 * capped at an hour. Long enough not to hammer a server that is down, short
 * enough that reconnecting a laptop does not mean waiting for the next hour.
 */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000)
}

/** Failures a later attempt could plausibly fix. */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'network',
  'timeout',
  'tls',
  'quota',
  'unknown',
])

export function isQueueable(result: SendResult): boolean {
  if (result.ok) return false
  return RETRYABLE.has(result.errorKind ?? 'unknown')
}

export type OutboxStatus = 'waiting' | 'sending' | 'failed'

export interface OutboxItem {
  id: string
  draft: MessageDraft
  queuedAt: number
  attempts: number
  /** Earliest instant a retry is allowed — `queuedAt` plus the backoff. */
  nextAttemptAt: number
  lastError?: string
  lastErrorKind?: ErrorKind
  status: OutboxStatus
}

export function queueItem(draft: MessageDraft, result?: SendResult, now = Date.now()): OutboxItem {
  return {
    id: newId('out'),
    draft: {
      ...draft,
      to: [...draft.to],
      cc: [...draft.cc],
      bcc: [...draft.bcc],
      attachments: draft.attachments.map((a) => ({ ...a })),
    },
    queuedAt: now,
    attempts: result ? 1 : 0,
    nextAttemptAt: now + (result ? backoffMs(1) : 0),
    lastError: result?.error,
    lastErrorKind: result?.errorKind,
    status: 'waiting',
  }
}

/** Items whose backoff has elapsed and which have not given up. */
export function dueItems(outbox: OutboxItem[], now = Date.now()): OutboxItem[] {
  return outbox.filter(
    (i) => i.status === 'waiting' && i.nextAttemptAt <= now && i.attempts < MAX_ATTEMPTS,
  )
}

/** Apply the result of one attempt. Returns the item, or `null` when it succeeded and should be dropped. */
export function afterAttempt(
  item: OutboxItem,
  result: SendResult,
  now = Date.now(),
): OutboxItem | null {
  if (result.ok) return null
  const attempts = item.attempts + 1
  const givenUp = attempts >= MAX_ATTEMPTS || !isQueueable(result)
  return {
    ...item,
    attempts,
    nextAttemptAt: now + backoffMs(attempts),
    lastError: result.error,
    lastErrorKind: result.errorKind,
    status: givenUp ? 'failed' : 'waiting',
  }
}

export interface OutboxSummary {
  waiting: number
  failed: number
  /** Soonest retry across the queue, or `undefined` when nothing is waiting. */
  nextAttemptAt?: number
}

export function summarise(outbox: OutboxItem[]): OutboxSummary {
  const waiting = outbox.filter((i) => i.status !== 'failed')
  const times = waiting.map((i) => i.nextAttemptAt).sort((a, b) => a - b)
  return {
    waiting: waiting.length,
    failed: outbox.filter((i) => i.status === 'failed').length,
    nextAttemptAt: times[0],
  }
}

/**
 * Is the device on a network at all?
 *
 * `navigator.onLine` is famously optimistic — it reports "online" for a
 * captive-portal Wi-Fi that routes nowhere. It is used here only in the
 * direction it is reliable in: `false` genuinely means there is no point
 * trying, and `true` only means "go ahead and find out".
 */
export function probablyOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}
