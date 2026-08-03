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
import { evaluateConditions } from '../src/core/conditions'
import { applyJitter, computeOccurrences, rearm } from '../src/core/schedule'
import { MAX_BURST_COUNT } from '../src/core/types'
import type { MailAccount, ScheduledJob, SendResult } from '../src/core/types'
import { sendMail } from './mailer'
import { getSecret } from './store'

const TICK_MS = 15_000
/**
 * Upper bound for the extra precise timer below. Kept short deliberately:
 * anything farther out than this will be picked up by the next 15-second poll
 * or the next `sync()` anyway, so there is no reason to let a long-lived timer
 * go stale while jobs are edited underneath it.
 */
const PRECISE_WINDOW_MS = 30_000

export interface SchedulerEvents {
  jobEvent: (payload: { jobId: string; at: number; result: SendResult }) => void
  jobUpdated: (job: ScheduledJob) => void
}

export class Scheduler extends EventEmitter {
  private jobs: ScheduledJob[] = []
  private accounts: MailAccount[] = []
  private timer: NodeJS.Timeout | null = null
  private preciseTimer: NodeJS.Timeout | null = null
  private running = new Set<string>()

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
  sync(jobs: ScheduledJob[], accounts: MailAccount[]): void {
    this.accounts = accounts
    this.jobs = jobs.map((job) => {
      const { upcoming } = rearm(job.recurrence, job.occurrences ?? [], {
        runsSoFar: job.runCount,
      })
      return { ...job, occurrences: upcoming }
    })
    this.armPrecise()
  }

  snapshot(): ScheduledJob[] {
    return this.jobs
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
      if (!job.enabled) continue
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

      this.running.add(job.id)
      void this.run(job, remaining).finally(() => this.running.delete(job.id))
    }

    this.armPrecise()
  }

  /** One send, with the existing retry-on-transient-failure policy. */
  private async sendOnce(
    job: ScheduledJob,
    account: MailAccount,
    secret: string | null,
  ): Promise<SendResult> {
    let result = await sendMail(job.draft, account, secret)

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
      result = await sendMail(job.draft, account, secret)
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

  private async run(job: ScheduledJob, remaining: number[]): Promise<void> {
    const jitterMs = applyJitter(0, job.recurrence.jitterSeconds)
    if (jitterMs > 0) await delay(jitterMs)

    /**
     * Send conditions, checked here because here is where a scheduled run is
     * actually decided — and because this process is the only one that can
     * answer the filesystem questions. `noReplySince` needs the inbox, which
     * lives in the renderer, so it reports as undecidable and does not block:
     * holding mail back on a question nobody answered is exactly the silent
     * failure this application exists to avoid.
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
      lastResult: job.lastResult,
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
      this.emit('jobEvent', { jobId: job.id, at: job.lastRunAt, result: skipped })
      this.emit('jobUpdated', job)
      this.armPrecise()
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
        last = await this.sendOnce(job, account, secret)
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

    job.runCount += 1
    job.lastRunAt = Date.now()
    job.lastResult = result.ok ? 'ok' : 'failed'
    job.lastError = result.error
    job.status = result.ok ? 'armed' : 'failed'

    job.occurrences = this.topUp(job, remaining)

    if (job.occurrences.length === 0) job.status = 'done'

    this.emit('jobEvent', { jobId: job.id, at: job.lastRunAt, result })
    this.emit('jobUpdated', job)
    this.armPrecise()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
