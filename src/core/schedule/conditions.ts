/**
 * Conditional sending — checks made at fire time, not at scheduling time.
 *
 * The point of this feature is the reminder that *should not* go out: the
 * weekly nag whose attachment was deleted, the follow-up to someone who
 * already replied, the escalation that is only wanted if the earlier stage
 * failed. Sending those anyway is the failure mode people remember.
 *
 * Two rules the design follows throughout:
 *
 * - **A condition that cannot be evaluated does not block the send.** If the
 *   inbox has never synced we do not know whether anyone replied, and holding
 *   mail back on the strength of a guess turns a convenience into a silent
 *   drop. Every evaluator says so explicitly via `undecidable`.
 * - **A skip is an event, not a silence.** Skipping writes a log line with the
 *   reason, exactly like a failure does. "It didn't send and nothing said why"
 *   is the single worst outcome this application can produce.
 */

import type { MessageDraft } from '../types'

export type ConditionKind =
  /** Every attachment still exists on disk. */
  | 'attachmentsPresent'
  /** A specific file exists (a report that a nightly job is supposed to produce). */
  | 'fileExists'
  /** A specific file does *not* exist (a lock/"done" marker written by something else). */
  | 'fileMissing'
  /** No inbound mail from any recipient since the last run of this job. */
  | 'noReplySince'
  /** Only inside a time-of-day window, local clock. */
  | 'timeWindow'
  /** Only when the previous run of this job failed — escalation stages. */
  | 'previousRunFailed'

export interface SendCondition {
  kind: ConditionKind
  /** For `fileExists` / `fileMissing`. */
  path?: string
  /** For `timeWindow`, `HH:mm` local. */
  from?: string
  to?: string
}

/**
 * What the evaluator is allowed to look at.
 *
 * Everything is a plain value or a synchronous predicate so the same function
 * runs in the renderer, in the Electron main process and (via the same core
 * bundle) on Android. The caller decides how to answer; this file decides what
 * the answers mean.
 */
export interface ConditionContext {
  now: number
  /** Absolute paths that exist. Callers that cannot check pass `undefined`. */
  fileExists?: (path: string) => boolean
  /** Most recent inbound message from this address, epoch ms, if known. */
  latestInboundFrom?: (address: string) => number | undefined
  /** True when the inbox has synced at least once — see `undecidable` below. */
  inboxKnown?: boolean
  lastRunAt?: number
  /**
   * When the job was first armed, epoch ms — the window's opening edge for a
   * job that has never run. Callers that cannot supply it may omit it; `now`
   * is the fallback, which is strictly safer than the epoch. See the
   * `noReplySince` branch for what the epoch cost.
   */
  armedAt?: number
  lastResult?: 'ok' | 'failed'
}

/**
 * The one rule for turning a `From:` header into a comparison key.
 *
 * `"Ada Lovelace" <ada@example.com>` and `ada@Example.com` are the same person
 * asking the same question, and `noReplySince` is worthless if the two spellings
 * miss each other. Exported because three places need to agree on it: the
 * renderer builds the index for a manual run, the desktop scheduler is handed
 * the same index for an automatic one, and the address being looked up comes
 * from the draft rather than from a header. Two private copies of this is how
 * the condition ends up answering "nobody has replied" to a mailbox that has.
 */
export function inboundKey(address: string): string {
  return (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase()
}

/**
 * Latest inbound message per sender, epoch ms, from synced inbox folders.
 *
 * A plain object rather than a `Map` on purpose: this crosses the IPC boundary
 * to the main process, where a `Map` arrives as `{}`.
 */
export function latestInboundIndex(
  inboxAccounts: Array<{ messages: Array<{ from: string; date: number }> }>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const inbox of inboxAccounts) {
    for (const m of inbox.messages) {
      const key = inboundKey(m.from)
      if (out[key] === undefined || m.date > out[key]) out[key] = m.date
    }
  }
  return out
}

export interface ConditionVerdict {
  send: boolean
  /** Translation key explaining a block. Absent when `send` is true. */
  reasonKey?: string
  /** Interpolations for `reasonKey`. */
  reasonValues?: Record<string, string | number>
  /**
   * True when the condition could not be answered with the information
   * available. These never block — see the file header — but they are reported
   * so the log can say "sent anyway, could not check".
   */
  undecidable?: boolean
}

const PASS: ConditionVerdict = { send: true }

function minutesOfDay(hhmm: string | undefined): number | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function evaluateOne(
  cond: SendCondition,
  draft: MessageDraft,
  ctx: ConditionContext,
): ConditionVerdict {
  switch (cond.kind) {
    case 'attachmentsPresent': {
      if (!ctx.fileExists) return { send: true, undecidable: true }
      const missing = draft.attachments.filter((a) => !ctx.fileExists!(a.path))
      if (missing.length === 0) return PASS
      return {
        send: false,
        reasonKey: 'condition.blocked.attachments',
        reasonValues: { names: missing.map((a) => a.name).join('、') },
      }
    }

    case 'fileExists': {
      if (!cond.path) return PASS
      if (!ctx.fileExists) return { send: true, undecidable: true }
      return ctx.fileExists(cond.path)
        ? PASS
        : { send: false, reasonKey: 'condition.blocked.fileMissing', reasonValues: { path: cond.path } }
    }

    case 'fileMissing': {
      if (!cond.path) return PASS
      if (!ctx.fileExists) return { send: true, undecidable: true }
      return ctx.fileExists(cond.path)
        ? { send: false, reasonKey: 'condition.blocked.filePresent', reasonValues: { path: cond.path } }
        : PASS
    }

    case 'noReplySince': {
      if (!ctx.latestInboundFrom || ctx.inboxKnown !== true) {
        return { send: true, undecidable: true }
      }
      /*
       * The window opens at the last run, or at the job's first arming if it
       * has never run — "have they replied since I last chased them".
       *
       * That is what the sentence above always said and what the code below
       * never did: the fallback was `0`, the epoch, so a job that had not run
       * yet asked "have they ever written to me, in the whole history of this
       * mailbox". A reminder to chase someone who last mailed you in 2019 was
       * blocked on its very first arming and never sent — visible only as a
       * "Skipped" line nobody was looking for.
       */
      const since = ctx.lastRunAt ?? ctx.armedAt ?? ctx.now
      const recipients = [...draft.to, ...draft.cc]
      for (const address of recipients) {
        const at = ctx.latestInboundFrom(address)
        if (at !== undefined && at > since) {
          return {
            send: false,
            reasonKey: 'condition.blocked.replied',
            reasonValues: { who: address },
          }
        }
      }
      return PASS
    }

    case 'timeWindow': {
      const from = minutesOfDay(cond.from)
      const to = minutesOfDay(cond.to)
      // An unparseable window must never hold mail back — same failing-open
      // rule quiet hours uses.
      if (from === null || to === null || from === to) return PASS
      const d = new Date(ctx.now)
      const at = d.getHours() * 60 + d.getMinutes()
      const inside = from < to ? at >= from && at < to : at >= from || at < to
      return inside
        ? PASS
        : {
            send: false,
            reasonKey: 'condition.blocked.outsideWindow',
            reasonValues: { from: cond.from ?? '', to: cond.to ?? '' },
          }
    }

    case 'previousRunFailed': {
      if (ctx.lastResult === undefined) {
        // Never run before, so there is no earlier failure to escalate from.
        return { send: false, reasonKey: 'condition.blocked.noPreviousRun' }
      }
      return ctx.lastResult === 'failed'
        ? PASS
        : { send: false, reasonKey: 'condition.blocked.previousOk' }
    }

    default:
      return PASS
  }
}

/**
 * All conditions must pass. The first block wins and is the one reported —
 * listing five reasons a message did not go out is not more helpful than one.
 */
export function evaluateConditions(
  conditions: SendCondition[] | undefined,
  draft: MessageDraft,
  ctx: ConditionContext,
): ConditionVerdict {
  if (!conditions || conditions.length === 0) return PASS
  let undecidable = false
  for (const cond of conditions) {
    const verdict = evaluateOne(cond, draft, ctx)
    if (!verdict.send) return verdict
    if (verdict.undecidable) undecidable = true
  }
  return undecidable ? { send: true, undecidable: true } : PASS
}

/** Label key for the condition picker, so the UI never hard-codes wording. */
export function conditionLabelKey(kind: ConditionKind): string {
  return `condition.kind.${kind}`
}

export const CONDITION_KINDS: ConditionKind[] = [
  'attachmentsPresent',
  'noReplySince',
  'fileExists',
  'fileMissing',
  'timeWindow',
  'previousRunFailed',
]
