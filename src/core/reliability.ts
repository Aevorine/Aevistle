/**
 * The Reliability Center's triage logic — "will my scheduled reminders
 * actually go out?" answered from facts the app already keeps, without
 * opening a socket or asking a server anything.
 *
 * Four independent questions, four independent collectors: a job can be
 * wrong in more than one way at once (paused *and* pointed at a dead
 * account), so each collector returns every issue it finds rather than
 * stopping at the first. `views/ReliabilityView.tsx` composes them; nothing
 * in this file knows about React, i18n or the bridge, which is what makes
 * each one testable with a plain array of records — see
 * `scripts/check-reliability.mjs`.
 */

import type { MailAccount, ScheduledJob } from './types'
import type { PairedDevice } from './pairedDevices'
import {
  isLedgerEntryStuck,
  LEDGER_STUCK_THRESHOLD_MS,
  type DispatchLedgerEntry,
  type DispatchLedgerState,
} from './dispatchLedger'
import { needsStoredPassword } from './accounts'
import { classifyError } from './bridge'
import type { OAuthConnectionState } from './oauth'

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobIssueKind = 'paused' | 'failing' | 'retrying' | 'stuckSend' | 'executorUnsynced'

export interface UnhealthyJob {
  jobId: string
  jobName: string
  /** Every problem this job has right now, most cases carry exactly one. */
  kinds: JobIssueKind[]
  lastError?: string
  lastRunAt?: number
  /** Set only alongside `'executorUnsynced'` — who is actually meant to send this. */
  executorLabel?: string
  executorLastSyncedAt?: number
}

/**
 * How long a paired device may go without completing a sync cycle before a
 * job pinned to it (`ScheduledJob.executorDeviceId`) is flagged as "may not
 * actually fire".
 *
 * Sync only happens while both apps are open at once (see
 * `core/pairedDevices.ts`'s module doc), so an occasional multi-day gap
 * between two people's ordinary habits is expected and not a fault. Three
 * days absorbs "did not open my phone yesterday" without crying wolf, while
 * still flagging a device that has genuinely stopped syncing — lost, reset,
 * uninstalled — well before a week of missed reminders piles up silently on
 * a job nobody is watching from the device that owns it.
 */
export const DEVICE_STALE_MS = 3 * 24 * 60 * 60 * 1000

/** Every ledger entry for one job, whether or not it is stuck. */
function ledgerEntriesFor(jobId: string, entries: DispatchLedgerEntry[]): DispatchLedgerEntry[] {
  return entries.filter((e) => e.jobId === jobId)
}

/**
 * How much each kind matters, worst first — same idea as `health.ts`'s own
 * `rank` table. A job carrying more than one kind is ranked by the worst of
 * them, so a paused job that is *also* pointed at a wedged send surfaces
 * where the wedged send would put it, not where "paused" alone would.
 */
const JOB_KIND_RANK: Record<JobIssueKind, number> = {
  failing: 0,
  stuckSend: 0,
  executorUnsynced: 1,
  retrying: 2,
  paused: 3,
}

/**
 * Jobs with anything other than a healthy state: paused, failed on the last
 * run, an in-flight send or retry, a send that looks wedged, or pinned to an
 * executor device (`ScheduledJob.executorDeviceId`) that has not been seen
 * recently enough to trust.
 *
 * Silent about jobs that need no attention — enabled and clean — by design:
 * a triage list that includes everything is a list nobody reads.
 */
export function collectUnhealthyJobs(
  jobs: ScheduledJob[],
  pairedDevices: PairedDevice[],
  localDeviceId: string | undefined,
  ledgerEntries: DispatchLedgerEntry[],
  now = Date.now(),
): UnhealthyJob[] {
  const out: UnhealthyJob[] = []

  for (const job of jobs) {
    const kinds: JobIssueKind[] = []
    let executorLabel: string | undefined
    let executorLastSyncedAt: number | undefined

    if (!job.enabled) kinds.push('paused')
    if (job.enabled && job.lastResult === 'failed') kinds.push('failing')

    const entries = ledgerEntriesFor(job.id, ledgerEntries)
    if (entries.some((e) => !isLedgerEntryStuck(e, now))) kinds.push('retrying')
    if (entries.some((e) => isLedgerEntryStuck(e, now))) kinds.push('stuckSend')

    // Only worth asking while the job could actually fire on its own — a
    // paused job's executor is not going anywhere either way, and reporting
    // it would be noise on top of the 'paused' row already covering it.
    if (job.enabled && job.executorDeviceId && job.executorDeviceId !== localDeviceId) {
      const device = pairedDevices.find((d) => d.remoteDeviceId === job.executorDeviceId)
      const stale = !device || !device.lastSyncedAt || now - device.lastSyncedAt > DEVICE_STALE_MS
      if (stale) kinds.push('executorUnsynced')
      executorLabel = device?.label
      executorLastSyncedAt = device?.lastSyncedAt
    }

    if (kinds.length === 0) continue
    out.push({
      jobId: job.id,
      jobName: job.name,
      kinds,
      lastError: job.lastError,
      lastRunAt: job.lastRunAt,
      executorLabel,
      executorLastSyncedAt,
    })
  }

  return out.sort(
    (a, b) => Math.min(...a.kinds.map((k) => JOB_KIND_RANK[k])) - Math.min(...b.kinds.map((k) => JOB_KIND_RANK[k])),
  )
}

// ---------------------------------------------------------------------------
// Dispatch ledger
// ---------------------------------------------------------------------------

export interface StuckSend {
  claimKey: string
  jobId: string
  /** The job's own name, or the bare id when the job has since been deleted. */
  jobName: string
  occurrenceMs: number
  state: DispatchLedgerState
  /** How long it has sat in that state, in ms. */
  ageMs: number
  attempts: number
}

/**
 * Ledger entries stuck long enough to be worth a human's attention (see
 * `isLedgerEntryStuck`), matched up with the job name a bare `jobId` cannot
 * show on its own. Oldest first, since that is the one most likely to be a
 * genuine crash rather than a slow retry chain still under way.
 */
export function collectStuckSends(
  ledgerEntries: DispatchLedgerEntry[],
  jobs: ScheduledJob[],
  now = Date.now(),
  thresholdMs = LEDGER_STUCK_THRESHOLD_MS,
): StuckSend[] {
  return ledgerEntries
    .filter((e) => isLedgerEntryStuck(e, now, thresholdMs))
    .map((e) => ({
      claimKey: e.claimKey,
      jobId: e.jobId,
      jobName: jobs.find((j) => j.id === e.jobId)?.name ?? e.jobId,
      occurrenceMs: e.occurrenceMs,
      state: e.state,
      ageMs: now - (e.state === 'sending' ? (e.sendingAt ?? e.claimedAt) : e.claimedAt),
      attempts: e.attempts,
    }))
    .sort((a, b) => b.ageMs - a.ageMs)
}

// ---------------------------------------------------------------------------
// Accounts / credentials
// ---------------------------------------------------------------------------

export type AccountIssueKind =
  | 'noSecret'
  | 'oauthDisconnected'
  | 'oauthNeedsConsent'
  | 'oauthUnconfigured'
  | 'authFailure'

export interface AccountIssue {
  accountId: string
  accountLabel: string
  kind: AccountIssueKind
  /** The server's own words, for `'authFailure'` — see `classifyError`. */
  detail?: string
}

/**
 * Account/credential trouble, from facts the app already keeps: no password
 * has ever been stored, an OAuth2 account has never completed sign-in, its
 * grant needs re-consent, this build has no client id configured for it at
 * all, or the most recent job against this account failed for a reason that
 * looks like the server refusing the sign-in.
 *
 * Deliberately does not open a connection to find out — see the module doc;
 * that live probe already exists, on demand, as `components/SelfCheckPanel`.
 * `oauthStatuses` is supplied by the caller because reading it is an async
 * keystore call (`PlatformBridge.oauthStatus`), not something a pure
 * function can do for itself.
 */
export function collectAccountIssues(
  accounts: MailAccount[],
  jobs: ScheduledJob[],
  oauthStatuses: Record<string, OAuthConnectionState>,
): AccountIssue[] {
  const out: AccountIssue[] = []

  for (const account of accounts) {
    const label = account.label?.trim() || account.fromAddress

    if (needsStoredPassword(account)) {
      out.push({ accountId: account.id, accountLabel: label, kind: 'noSecret' })
    }

    if (account.authMethod === 'oauth2') {
      const state = oauthStatuses[account.id]
      if (state === 'disconnected') {
        out.push({ accountId: account.id, accountLabel: label, kind: 'oauthDisconnected' })
      } else if (state === 'needsConsent') {
        out.push({ accountId: account.id, accountLabel: label, kind: 'oauthNeedsConsent' })
      } else if (state === 'unconfigured') {
        out.push({ accountId: account.id, accountLabel: label, kind: 'oauthUnconfigured' })
      }
    }

    const authFailure = jobs.find(
      (j) =>
        j.draft.accountId === account.id &&
        j.lastResult === 'failed' &&
        classifyError(j.lastError ?? '') === 'auth',
    )
    if (authFailure) {
      out.push({
        accountId: account.id,
        accountLabel: label,
        kind: 'authFailure',
        detail: authFailure.lastError,
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Paired devices
// ---------------------------------------------------------------------------

export interface DeviceSyncIssue {
  deviceId: string
  deviceLabel: string
  /** Undefined for a device that has never completed a sync cycle at all. */
  lastSyncedAt?: number
}

/**
 * `'ongoing'` pairings that have gone quiet — see `DEVICE_STALE_MS`. A
 * `'once'` pairing keeps no ongoing sync history to judge and is never
 * reported here.
 */
export function collectDeviceSyncIssues(
  devices: PairedDevice[],
  now = Date.now(),
  thresholdMs = DEVICE_STALE_MS,
): DeviceSyncIssue[] {
  return devices
    .filter((d) => d.mode === 'ongoing')
    .filter((d) => !d.lastSyncedAt || now - d.lastSyncedAt > thresholdMs)
    .map((d) => ({ deviceId: d.id, deviceLabel: d.label, lastSyncedAt: d.lastSyncedAt }))
}
