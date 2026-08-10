/**
 * Desktop scheduler.
 *
 * A plain 15-second tick rather than one timer per job. Timers are the obvious
 * design and the wrong one here: `setTimeout` does not survive sleep/hibernate
 * predictably, drifts over long horizons, and silently caps out past ~24 days.
 * Recomputing "is anything due?" from absolute timestamps is immune to all
 * three, and 15 seconds of granularity is far below what a reminder needs.
 */

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { evaluateConditions, inboundKey } from '../src/core/conditions'
import { applyJitter, computeOccurrences, rearm } from '../src/core/schedule'
import {
  mintMessageId,
  resolveLedgerEntryOnRestart,
  spliceForcedResends,
  type DispatchLedgerEntry,
} from '../src/core/dispatchLedger'
import { MAX_BURST_COUNT } from '../src/core/types'
import type { MailAccount, ScheduledJob, SendResult } from '../src/core/types'
import type { JobRun } from '../src/core/bridge'
import { sendMail } from './mailer'
import {
  claimLedgerEntry,
  deleteLedgerEntry,
  getSecret,
  loadDispatchLedger,
  markLedgerAccepted,
  markLedgerSending,
} from './store'

const TICK_MS = 15_000
/**
 * Upper bound for the extra precise timer below. Kept short deliberately:
 * anything farther out than this will be picked up by the next 15-second poll
 * or the next `sync()` anyway, so there is no reason to let a long-lived timer
 * go stale while jobs are edited underneath it.
 */
const PRECISE_WINDOW_MS = 30_000

export interface SchedulerEvents {
  jobEvent: (payload: { jobId: string; at: number; result: SendResult; run: JobRun }) => void
  jobUpdated: (job: ScheduledJob) => void
}

/**
 * The bookkeeping a run leaves behind, packed for the renderer.
 *
 * Built here rather than left for `main.ts` to scrape off the job, because
 * this is the only place that knows the run finished — and because the
 * previous arrangement (mutate the job, emit `jobUpdated`, hope someone is
 * listening) had nobody listening at all.
 */
function runOf(job: ScheduledJob): JobRun {
  return {
    runCount: job.runCount,
    lastRunAt: job.lastRunAt ?? Date.now(),
    lastResult: job.lastResult,
    lastError: job.lastError,
    status: job.status,
    occurrences: job.occurrences,
  }
}

export class Scheduler extends EventEmitter {
  private jobs: ScheduledJob[] = []
  private accounts: MailAccount[] = []
  /**
   * The renderer's inbox index, for `noReplySince`. Empty and `false` until the
   * first `sync()` carries one, which is the honest starting state: not
   * "nobody has replied" but "this process has not been told".
   */
  private latestInbound: Record<string, number> = {}
  private inboxKnown = false
  /**
   * This process's own `Settings.localDeviceId`, from the last `sync()` —
   * see `isMyJob`. `undefined` until the first `sync()` call, which matches
   * every job being armable by default until told otherwise: a device that
   * has not yet heard from the renderer has no basis to refuse anything.
   */
  private localDeviceId: string | undefined
  private timer: NodeJS.Timeout | null = null
  private preciseTimer: NodeJS.Timeout | null = null
  private running = new Set<string>()
  /**
   * `${jobId}:${instant}` for every occurrence this process has dispatched.
   *
   * `sync()` puts a missed occurrence back into the working set so `tick()`
   * can pay it — see the comment there — and `sync()` is called again on every
   * renderer state change. Without this the renderer's copy of the job, which
   * still lists that instant until the run finishes and the update round-trips
   * back to it, would resurrect the same catch-up on the next `sync()` and
   * send it twice. Pruned in `tick()` so a long-running process does not carry
   * every send it has ever made.
   *
   * In-memory only — this guards *this* process against sending the same
   * occurrence twice. `store.ts`'s dispatch ledger is the durable half that
   * guards the *next* process, after a crash, against the same thing — but
   * only for occurrences the ledger has positive proof were actually sent;
   * see `restoreDispatchLedger` for how the two meet at startup, and
   * `src/core/dispatchLedger.ts` for why an *unconfirmed* send is deliberately
   * left out of this set instead of added to it.
   */
  private fired = new Set<string>()

  /**
   * Ledger entries recovered at startup with positive proof the send already
   * happened (`resolveLedgerEntryOnRestart` returned `'complete-bookkeeping-only'`),
   * waiting for their job to become known. Restart recovery runs before the
   * renderer has synced any jobs in, so the bookkeeping these entries need —
   * `completeRun`, which mutates an actual `ScheduledJob` — cannot happen yet.
   * `sync()` drains this on every call once the matching job appears. Keyed by
   * claimKey so the same entry cannot be queued for completion twice.
   */
  private pendingLedgerRecovery = new Map<string, DispatchLedgerEntry>()

  /**
   * Ledger entries recovered at startup with NO confirmed evidence the send
   * ever happened (`resolveLedgerEntryOnRestart` returned `'resend'`),
   * waiting for their job to become known so the occurrence can be forced
   * back into its `occurrences` array.
   *
   * This has to be a separate pass from the ordinary `rearm()`/`owed`
   * computation in `sync()`: a job whose recurrence uses `catchUp: 'skip'`
   * has `rearm()` unconditionally drop every missed occurrence, including
   * one that was actively claimed (or mid-send) when the process died —
   * which would silently reintroduce the exact miss this whole file exists
   * to close, for that one policy. A resend recovered here overrides
   * whatever the catch-up policy computes for this specific occurrence,
   * because the app already committed to sending it before the crash; the
   * policy only ever meant to govern occurrences nothing had attempted yet.
   * Cleared, and the ledger entry deleted, once `sync()` confirms the
   * occurrence has actually landed back in the job's `occurrences`.
   */
  private pendingResend = new Map<string, DispatchLedgerEntry>()

  /**
   * Best-effort: clear the ledger entry for a claimKey whose occurrence has
   * finished being processed — sent, failed for good, skipped by a
   * condition, or recovered from a prior crash. A write failure here leaves
   * a stale entry behind (worst case: a spurious resend later, exactly the
   * trade this whole file leans towards), not a reason to fail the caller.
   */
  private async finishLedgerEntry(claimKey: string): Promise<void> {
    try {
      await deleteLedgerEntry(claimKey)
    } catch (e) {
      console.error('[aevistle] could not clear a completed dispatch-ledger entry:', claimKey, e)
    }
  }

  /**
   * Resolve every ledger entry left behind by the previous run, before the
   * first `tick()` can fire anything. Must be called — and awaited — before
   * `start()`; `main.ts` does this once, at launch.
   *
   * - No confirmed evidence the send completed (`'resend'`): the stale entry
   *   is dropped and the occurrence is left out of `fired` entirely, so it
   *   fires normally on the next tick — exactly as if it had never been
   *   claimed. This is the deliberate reversal from the old claim file, which
   *   put every claim into `fired` and thereby suppressed a resend even when
   *   nothing had actually gone out.
   * - Positive proof of acceptance (`'complete-bookkeeping-only'`): the
   *   occurrence *is* added to `fired`, so it is protected from being resent
   *   by `tick()` in the ordinary way, and the entry is parked in
   *   `pendingLedgerRecovery` until `sync()` can find the job it belongs to
   *   and complete its bookkeeping without re-sending.
   */
  async restoreDispatchLedger(): Promise<void> {
    for (const entry of await loadDispatchLedger()) {
      const resolution = resolveLedgerEntryOnRestart(entry)
      if (resolution === 'resend') {
        // Left on disk on purpose — see `pendingResend`. Deleting it here,
        // before `sync()` has actually spliced the occurrence back in, would
        // lose the resend entirely if the process crashed again before the
        // renderer ever connected.
        this.pendingResend.set(entry.claimKey, entry)
        continue
      }
      this.fired.add(entry.claimKey)
      this.pendingLedgerRecovery.set(entry.claimKey, entry)
    }
  }

  /**
   * Finish the bookkeeping for any recovered `'accepted'` ledger entry whose
   * job has just become known. Called at the end of every `sync()` — cheap
   * when `pendingLedgerRecovery` is empty, which is the common case.
   *
   * `rawJobs` is the renderer's actual current state (`sync()`'s own `jobs`
   * parameter, untouched), not `this.jobs` — see `completeAcceptedRecovery`
   * for why the distinction matters.
   */
  private resolvePendingLedgerRecovery(rawJobs: ScheduledJob[]): void {
    if (this.pendingLedgerRecovery.size === 0) return
    for (const entry of this.pendingLedgerRecovery.values()) {
      const job = this.jobs.find((j) => j.id === entry.jobId)
      const rawJob = rawJobs.find((j) => j.id === entry.jobId)
      if (!job || !rawJob) continue // Not synced in yet — try again on the next sync(). See the field doc for the (rare, undeleted-job) case this never resolves.
      this.pendingLedgerRecovery.delete(entry.claimKey)
      void this.completeAcceptedRecovery(job, rawJob, entry)
    }
  }

  /**
   * Apply the job bookkeeping for an occurrence the ledger has positive proof
   * was already sent, then clear the entry. No send is attempted and no send
   * condition is re-evaluated — the send already genuinely happened before
   * the crash; this only catches the job's own record-keeping up to that
   * fact, via the exact same `completeRun` the live send path uses.
   *
   * Checked against `rawJob` (the renderer's untouched state), not `job`
   * (this `sync()` call's own `this.jobs` entry): by the time this runs,
   * `job.occurrences` has already had this instant filtered out by the
   * `owed` computation above — because this entry's claimKey was added to
   * `fired` back in `restoreDispatchLedger`, precisely so `tick()` would not
   * also try to resend it. Checking `job` here would therefore always read
   * "already gone" and this bookkeeping would never run. `rawJob` still
   * reflects whatever the renderer's own state.json actually recorded, which
   * is the real question this check exists to answer: did state.json's
   * bookkeeping reach this occurrence before the crash, or not.
   */
  private async completeAcceptedRecovery(
    job: ScheduledJob,
    rawJob: ScheduledJob,
    entry: DispatchLedgerEntry,
  ): Promise<void> {
    if (rawJob.occurrences.includes(entry.occurrenceMs)) {
      const result: SendResult = {
        ok: true,
        messageId: entry.messageId,
        // Best-effort: the ledger does not record which individual
        // recipients were accepted, only that the SMTP transaction as a
        // whole was — see the caveat on `DispatchLedgerEntry.messageId`.
        accepted: [],
        rejected: [],
        durationMs: 0,
      }
      const remaining = job.occurrences.filter((t) => t !== entry.occurrenceMs)
      this.completeRun(job, remaining, result)
    }
    await this.finishLedgerEntry(entry.claimKey)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    // An immediate pass so a reminder that came due while the app was closed
    // goes out at launch rather than up to 15 seconds later.
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.preciseTimer) clearTimeout(this.preciseTimer)
    this.preciseTimer = null
  }

  /**
   * Force an immediate pass. Called after the OS reports the machine woke up
   * or the screen unlocked — otherwise a job due during sleep waits out
   * whatever is left of the current 15-second poll before anyone notices.
   */
  wake(): void {
    void this.tick()
  }

  /** Replace the whole working set. Called whenever the renderer changes anything. */
  sync(
    jobs: ScheduledJob[],
    accounts: MailAccount[],
    /**
     * The inbox index, so `noReplySince` can be answered here.
     *
     * See `PlatformBridge.syncJobs`. It arrives on this call rather than
     * through a channel of its own because it has to be as fresh as the jobs
     * it will be evaluated against, and this is the call the renderer already
     * makes on every state change — including every inbox sync.
     */
    headless?: { inboxKnown?: boolean; latestInbound?: Record<string, number> },
    /** See `isMyJob`. Threaded through separately from `headless` because `electron/main.ts`'s IPC handler destructures it off the same object the renderer sends, not because it means anything different. */
    localDeviceId?: string,
  ): void {
    this.accounts = accounts
    this.localDeviceId = localDeviceId
    if (headless) {
      this.inboxKnown = headless.inboxKnown === true
      this.latestInbound = headless.latestInbound ?? {}
    }
    this.jobs = jobs.map((job) => {
      const { dueNow, upcoming } = rearm(job.recurrence, job.occurrences ?? [], {
        runsSoFar: job.runCount,
      })
      /*
       * The missed occurrence goes back in front of the future ones.
       *
       * `tick()` below has always known how to pay a backlog — it filters
       * `t <= now` and fires the last one. It never found anything, because
       * this line handed it a list `rearm` had already stripped of everything
       * past. Waking the machine after a night produced no send and no sign
       * that one had been skipped.
       *
       * Filtered against `fired` so the same instant cannot be paid twice: the
       * renderer's copy of the job still carries it until the run completes
       * and the update round-trips, and `sync()` runs on every state change in
       * between.
       */
      const owed = dueNow.filter((t) => !this.fired.has(`${job.id}:${t}`))
      // See `pendingResend` and `spliceForcedResends`'s doc — a recovered,
      // unconfirmed send is forced back in even for a `catchUp: 'skip'` job
      // that `rearm()` above would otherwise have dropped it from.
      const occurrences = spliceForcedResends([...owed, ...upcoming], job.id, this.pendingResend.values())
      return { ...job, occurrences }
    })
    // Now that every pending resend has had a chance to land in `this.jobs`
    // above, clear whichever ones actually did — leaving the rest (their job
    // hasn't synced in yet) for the next `sync()` call to retry.
    for (const [claimKey, entry] of this.pendingResend) {
      const job = this.jobs.find((j) => j.id === entry.jobId)
      if (job?.occurrences.includes(entry.occurrenceMs)) {
        this.pendingResend.delete(claimKey)
        void this.finishLedgerEntry(claimKey)
      }
    }
    // Jobs are known now, so any `'accepted'` ledger entry recovered at
    // startup before the renderer had synced anything in can finally have
    // its bookkeeping completed. See `pendingLedgerRecovery`. `jobs` (the raw
    // argument, not `this.jobs`) is passed through deliberately — see
    // `completeAcceptedRecovery`.
    this.resolvePendingLedgerRecovery(jobs)
    this.armPrecise()
  }

  snapshot(): ScheduledJob[] {
    return this.jobs
  }

  /**
   * Whether *this* process is allowed to let `job` actually fire.
   *
   * Absent `executorDeviceId` — every job from before this field existed,
   * and every job on a device that has never paired a second one — means
   * "whoever has it enabled", unchanged from before. `localDeviceId` itself
   * being unset (no `sync()` call has happened yet) never blocks a job
   * either: a device that has not been told who it is has no basis to
   * refuse a job the renderer already armed.
   *
   * This only decides whether *this* device may send. It does not touch
   * `job.occurrences` on a device that is not the executor — the job stays
   * exactly as visible, editable and pausable as any other; it simply never
   * reaches `run()` here.
   */
  private isMyJob(job: ScheduledJob): boolean {
    return !job.executorDeviceId || !this.localDeviceId || job.executorDeviceId === this.localDeviceId
  }

  /**
   * The 15-second poll alone would make ms/second-level `intervalMs`
   * recurrences fire up to 15 seconds late — nowhere near what
   * millisecond-precision local dispatch is supposed to mean. This arms one
   * extra `setTimeout` for whichever occurrence (across all jobs) is soonest,
   * but only inside a short horizon: farther out and the next poll or the
   * next `sync()` will re-evaluate it anyway, same as before this existed.
   */
  private armPrecise(): void {
    if (this.preciseTimer) {
      clearTimeout(this.preciseTimer)
      this.preciseTimer = null
    }

    const now = Date.now()
    let soonest = Infinity
    for (const job of this.jobs) {
      if (!job.enabled || !this.isMyJob(job)) continue
      for (const t of job.occurrences) {
        if (t > now && t < soonest) soonest = t
      }
    }

    const delayMs = soonest - now
    if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > PRECISE_WINDOW_MS) return

    this.preciseTimer = setTimeout(() => {
      this.preciseTimer = null
      void this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    const now = Date.now()

    for (const job of this.jobs) {
      if (!job.enabled) continue
      if (this.running.has(job.id)) continue
      // Another device owns this job's occurrences — see `isMyJob`. Left
      // entirely untouched here, not drained: this device doing nothing to
      // it is the point.
      if (!this.isMyJob(job)) continue

      const due = job.occurrences.filter((t) => t <= now)
      if (due.length === 0) continue

      // Collapse a backlog into a single send. Waking a laptop after a week
      // should produce one reminder, not seven.
      const fireAt = job.recurrence.catchUp === 'skip' ? null : due[due.length - 1]
      const remaining = job.occurrences.filter((t) => t > now)

      if (fireAt === null) {
        job.occurrences = remaining
        this.emit('jobUpdated', job)
        continue
      }

      // Claimed before the send starts, so a `sync()` arriving mid-run cannot
      // put this instant back and have it paid a second time.
      const claimKey = `${job.id}:${fireAt}`
      this.fired.add(claimKey)
      this.running.add(job.id)
      void this.claimThenRun(job, remaining, claimKey, fireAt).finally(() => this.running.delete(job.id))
    }

    // A claim older than a day can no longer be resurrected by any `sync()` —
    // `rearm` would have to be handed an occurrence that old, and the renderer
    // pruned it long before. Keeps the set from growing for the life of the
    // process.
    if (this.fired.size > 512) {
      const cutoff = now - 24 * 60 * 60 * 1000
      for (const key of this.fired) {
        const at = Number(key.slice(key.lastIndexOf(':') + 1))
        if (Number.isFinite(at) && at < cutoff) this.fired.delete(key)
      }
    }

    this.armPrecise()
  }

  /**
   * Best-effort: a durable-write failure here is a reason the crash-safety
   * net has a hole for this one attempt, not a reason to hold up (or fail)
   * an actual send — same trade `claimThenRun` makes for the claim write.
   */
  private async markSending(claimKey: string): Promise<void> {
    try {
      await markLedgerSending(claimKey)
    } catch (e) {
      console.error('[aevistle] could not durably record a sending attempt:', claimKey, e)
    }
  }

  private async markAccepted(claimKey: string): Promise<void> {
    try {
      await markLedgerAccepted(claimKey)
    } catch (e) {
      console.error('[aevistle] could not durably record a send acceptance:', claimKey, e)
    }
  }

  /**
   * One send, with the existing retry-on-transient-failure policy.
   *
   * `claimKey`/`messageId` thread the dispatch ledger through: `'sending'` is
   * written durably immediately before every actual SMTP attempt below —
   * including retries, which is why the write sits inside this loop rather
   * than once around the whole call — and `'accepted'` immediately after one
   * succeeds. `messageId` is passed into `sendMail` so the message itself
   * carries the same `Message-Id` across every attempt at this claimKey. See
   * `src/core/dispatchLedger.ts`.
   */
  private async sendOnce(
    job: ScheduledJob,
    account: MailAccount,
    secret: string | null,
    claimKey: string,
    messageId: string,
  ): Promise<SendResult> {
    await this.markSending(claimKey)
    let result = await sendMail(job.draft, account, secret, undefined, messageId)
    if (result.ok) await this.markAccepted(claimKey)

    // Retry only failures that a retry could plausibly fix. A wrong password
    // or a malformed address will fail identically every time, and hammering
    // the server looks like a brute-force attempt.
    const retryable = new Set(['network', 'tls', 'quota', 'unknown'])
    let attempt = 1
    let waitSeconds = job.retry.backoffSeconds

    while (
      !result.ok &&
      attempt < job.retry.maxAttempts &&
      retryable.has(result.errorKind ?? 'unknown')
    ) {
      await delay(waitSeconds * 1000)
      await this.markSending(claimKey)
      result = await sendMail(job.draft, account, secret, undefined, messageId)
      if (result.ok) await this.markAccepted(claimKey)
      attempt++
      waitSeconds = Math.min(waitSeconds * job.retry.backoffFactor, 3600)
    }

    return result
  }

  /**
   * Top the occurrence list back up so the job stays armed for the next
   * horizon. Shared by the send path and the skip path — a skipped run must
   * re-arm exactly like a completed one, or a condition that blocks once
   * quietly retires the schedule.
   */
  private topUp(job: ScheduledJob, remaining: number[]): number[] {
    if (remaining.length >= 8) return remaining
    return [
      ...remaining,
      ...computeOccurrences(job.recurrence, {
        after: remaining[remaining.length - 1] ?? Date.now(),
        runsSoFar: job.runCount,
        count: 24 - remaining.length,
      }),
    ]
  }

  /**
   * Apply a finished run's outcome onto `job` and tell everyone about it —
   * shared between the live send path at the end of `run()` and
   * `completeAcceptedRecovery`, which reaches the exact same outcome for an
   * occurrence the ledger has positive proof was already sent before a
   * crash, without attempting the send again.
   */
  private completeRun(job: ScheduledJob, remaining: number[], result: SendResult): void {
    job.runCount += 1
    job.lastRunAt = Date.now()
    job.lastResult = result.ok ? 'ok' : 'failed'
    job.lastError = result.error
    job.status = result.ok ? 'armed' : 'failed'

    job.occurrences = this.topUp(job, remaining)

    if (job.occurrences.length === 0) job.status = 'done'

    this.emit('jobEvent', { jobId: job.id, at: job.lastRunAt, result, run: runOf(job) })
    this.emit('jobUpdated', job)
    this.armPrecise()
  }

  /**
   * The durable half of the claim, awaited before `run()` can reach the SMTP
   * call inside it. `this.fired.add` in `tick()` already guards this process
   * against firing the same occurrence twice; this guards the *next*
   * process, after a crash between "SMTP accepted" and "state.json caught
   * up", against the same thing.
   *
   * Mints a `messageId` up front so a send can proceed with *some* id even if
   * the durable claim write itself fails; `claimLedgerEntry` overrides it with
   * the entry's own id (freshly minted, or reused from a prior attempt at the
   * same claimKey) the moment it succeeds.
   */
  private async claimThenRun(
    job: ScheduledJob,
    remaining: number[],
    claimKey: string,
    occurrenceMs: number,
  ): Promise<void> {
    let messageId = mintMessageId(claimKey)
    try {
      const entry = await claimLedgerEntry(claimKey, job.id, occurrenceMs)
      messageId = entry.messageId
    } catch (e) {
      // A claim that failed to reach disk is a reason the crash-safety net
      // has a hole this one time, not a reason to skip a reminder the user is
      // waiting on — same trade `writeAtomic`'s best-effort fsync makes.
      console.error('[aevistle] could not durably claim occurrence before sending:', claimKey, e)
    }
    await this.run(job, remaining, claimKey, messageId)
  }

  private async run(
    job: ScheduledJob,
    remaining: number[],
    claimKey: string,
    messageId: string,
  ): Promise<void> {
    const jitterMs = applyJitter(0, job.recurrence.jitterSeconds)
    if (jitterMs > 0) await delay(jitterMs)

    /**
     * Send conditions, checked here because here is where a scheduled run is
     * actually decided — and because this process is the only one that can
     * answer the filesystem questions.
     *
     * `noReplySince` needs the inbox, which lives in the renderer. It used to
     * be left unanswered here, and an unanswered condition deliberately sends
     * rather than blocking — so "only send if they haven't replied" worked from
     * the Run now button and did nothing at all for a scheduled send, which is
     * the case it exists for. The renderer now hands the index over on
     * `syncJobs`; until it has done so once, `inboxKnown` is false and the old
     * undecidable-and-send behaviour still applies, which is the right answer
     * for a process that has genuinely not been told anything.
     */
    const verdict = evaluateConditions(job.conditions, job.draft, {
      now: Date.now(),
      fileExists: (p: string) => {
        try {
          return existsSync(p)
        } catch {
          // A path we cannot even stat (permissions, a disconnected drive) is
          // not proof of absence, so say "missing" only when we really looked.
          return true
        }
      },
      lastRunAt: job.lastRunAt,
      // The opening edge of "since I last chased them" for a job that has
      // never run. Without it `noReplySince` reached back to the epoch.
      armedAt: job.createdAt,
      lastResult: job.lastResult,
      inboxKnown: this.inboxKnown,
      latestInboundFrom: (address: string) => this.latestInbound[inboundKey(address)],
    })

    if (!verdict.send) {
      const skipped: SendResult = {
        ok: false,
        skipped: true,
        skipReasonKey: verdict.reasonKey,
        skipReasonValues: verdict.reasonValues,
        accepted: [],
        rejected: [],
        durationMs: 0,
      }
      // A skip still consumes the occurrence and still reports. Leaving the
      // timestamp in place would re-evaluate the same condition every 15
      // seconds until it changed, then fire late and unexpectedly.
      job.lastRunAt = Date.now()
      job.occurrences = this.topUp(job, remaining)
      if (job.occurrences.length === 0) job.status = 'done'
      this.emit('jobEvent', { jobId: job.id, at: job.lastRunAt, result: skipped, run: runOf(job) })
      this.emit('jobUpdated', job)
      this.armPrecise()
      // No SMTP attempt was ever made for this claimKey — the ledger entry
      // is still sitting in `'claimed'`. Cleared here rather than left for a
      // future restart to resolve, so a condition that skips every time
      // (e.g. a file that is simply never going to exist) does not leave a
      // ledger entry hanging around until the 24-hour prune.
      await this.finishLedgerEntry(claimKey)
      return
    }

    const account = this.accounts.find((a) => a.id === job.draft.accountId)
    let result: SendResult

    if (!account) {
      result = {
        ok: false,
        accepted: [],
        rejected: [],
        durationMs: 0,
        error: 'The account this schedule uses no longer exists',
        errorKind: 'config',
      }
    } else {
      const secret = await getSecret(account.id)
      const burst = job.burst?.enabled ? job.burst : null
      const repeats = burst ? Math.min(Math.max(1, Math.trunc(burst.count)), MAX_BURST_COUNT) : 1
      const pacingMs = burst ? Math.max(0, burst.pacingMs) : 0

      // No new pooling needed for the repeat case: mailer.ts already keeps a
      // warm, authenticated connection per account, so back-to-back sends to
      // the same account already skip the handshake after the first one.
      let okCount = 0
      let totalDuration = 0
      const accepted: string[] = []
      const rejected: string[] = []
      let firstFailure: SendResult | null = null
      let last: SendResult = { ok: false, accepted: [], rejected: [], durationMs: 0 }

      for (let i = 0; i < repeats; i++) {
        if (i > 0 && pacingMs > 0) await delay(pacingMs)
        last = await this.sendOnce(job, account, secret, claimKey, messageId)
        totalDuration += last.durationMs
        accepted.push(...last.accepted)
        rejected.push(...last.rejected)
        if (last.ok) okCount++
        else firstFailure ??= last
      }

      result =
        repeats === 1
          ? last
          : {
              ok: okCount === repeats,
              accepted,
              rejected,
              durationMs: totalDuration,
              error:
                okCount === repeats
                  ? undefined
                  : (firstFailure?.error ?? `${repeats - okCount}/${repeats} sends failed`),
              errorKind: okCount === repeats ? undefined : firstFailure?.errorKind,
            }
    }

    this.completeRun(job, remaining, result)
    // Whatever `result` turned out to be — sent, failed for good, or a
    // missing-account config error — the occurrence has finished being
    // processed and the ledger's job here is done. See `deleteLedgerEntry`'s
    // doc for why a missing entry means "fully done", not "fully sent".
    await this.finishLedgerEntry(claimKey)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
