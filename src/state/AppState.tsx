/**
 * Application state: one store, one persistence path, one place that talks to
 * the platform bridge.
 *
 * Persistence is debounced and always writes the whole document. The state is
 * small (kilobytes) and a whole-document write is atomic from the renderer's
 * point of view, which removes a class of bugs where a crash mid-update leaves
 * accounts and jobs disagreeing about which account exists.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ATMOSPHERE_MOTION_MIN,
  DEFAULT_RETRY,
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  defaultInboxAccountState,
  defaultRecurrence,
  emptyDraft,
  newId,
  type AppState,
  type Attachment,
  type Contact,
  type InboxAccountState,
  type InboxMessage,
  type InboxTag,
  type LogEntry,
  type MailAccount,
  type MessageDraft,
  type ScheduledJob,
  type SendResult,
  type Settings,
  type Template,
} from '../core/types'
import {
  DesktopBridgeMissingError,
  getBridge,
  type DataFolderChange,
  type InboxMessageBody,
  type JobEvent,
  type JobRun,
  type PlatformBridge,
} from '../core/platform/bridge'
import type { PermissionSnapshot } from '../core/ops/health'
import { pruneLogs } from '../core/ops/logRetention'
import {
  applyQuietHours,
  computeOccurrences,
  isQuiet,
  migrateSkipWeekends,
  rearm,
  type QuietHours,
} from '../core/schedule/schedule'
import type { ArrivalReport } from '../core/mail/newMail'
import { announcementFor, explainArrivals, previewLine, restoredBaseline, senderName } from '../core/mail/newMail'
import {
  applyPolicy,
  keywordHit,
  type NotifyPolicy,
  type PolicyOutcome,
} from '../core/mail/notifyPolicy'
import { appendLedger, type NotifyLedgerEntry } from '../core/ops/notifyLedger'
import {
  markAlerted,
  recordSync,
  shouldAlert,
  type FailureRun,
} from '../core/ops/syncHealth'
import { runLimited } from '../core/mail/syncLimit'
import {
  applyWorkCalendarDetailed,
  calendarWarning,
  DEFAULT_WORK_CALENDAR,
  type CalendarWarning,
} from '../core/schedule/workCalendar'
import { buildMergeMessages } from '../core/mail/mergeVars'
import { applyDeliveryWindows, type DeliveryWindow } from '../core/schedule/deliveryWindow'
// Not a component — a pure module that happens to live beside the one screen
// that needed it first. Imported here so the scheduler and the compose preview
// answer "whose window counts?" with the same code, not the same intention.
import { windowsForRecipients, windowsOf } from '../components/deliveryPreview'
import { buildDigest, DIGEST_JOB_ID } from '../core/mail/digest'
import { renderDigestBody, renderDigestSubject } from '../core/mail/digestText'
import { greetingYears, holidayNameMap } from '../core/mail/greetings'
import type { SnapshotReason } from '../core/sync/snapshots'
import type { NewHit } from '../core/ops/codeHistory'
import {
  afterAttempt,
  dueItems,
  isQueueable,
  probablyOnline,
  queueItem,
  type OutboxItem,
} from '../core/ops/outbox'
import { evaluateConditions, inboundKey, latestInboundIndex } from '../core/schedule/conditions'
import { applyRun } from '../core/schedule/jobRun'
import { forTransport } from '../core/mail/markdown'
import { mergeRemoved, rememberRemoved, restoreRemoved, withoutRemoved } from '../core/mail/inboxRemoval'
import { applyCodeHistoryAction } from './services/codeHistoryReducer'
import { applyOutboxAction } from './services/outboxReducer'
import { applyJobAction } from './services/jobReducer'
import { applyContactAction } from './services/contactsReducer'
import { applyTemplateAction } from './services/templatesReducer'
import { applyLogAction } from './services/logsReducer'
import { applyAttachmentAction } from './services/attachmentsReducer'
import { applyDraftAction } from './services/draftReducer'
import { applyAccountAction } from './services/accountsReducer'
import { useUndo } from './hooks/useUndo'
import { useAccountActions } from './hooks/useAccountActions'
import { usePairingActions } from './hooks/usePairingActions'
import { useAndroidPermissions } from './hooks/useAndroidPermissions'
import { useResetEverything } from './hooks/useResetEverything'
import { useRelocateData } from './hooks/useRelocateData'
import { executeControl } from './controlExecutor'
import { effectiveControlScopes, type ControlRequest } from '../core/sync/control'
import { createI18n, detectLocale, localeMeta, useLocaleReady, type I18n, type TranslationKey } from '../i18n'
import { findPairedDevice, recordSyncSeq, touchSynced, type PairedDevice } from '../core/sync/pairedDevices'
import { pushConflictSnapshots, type ConflictSnapshot } from '../core/sync/syncConflict'
import { applySyncAction } from './services/syncReducer'
import { parseAddress } from '../core/sync/lanAddress'
import { registerSyncLoop } from '../core/sync/activeSyncLoop'
import {
  respondToSyncRequest,
  SyncLoop,
  SYNC_SERVER_PORT,
  type PerformExchangeResult,
  type SyncApplyPatch,
  type SyncListenerStatus,
  type SyncSecretTransport,
  type SyncServerRequest,
} from '../core/sync/syncLoop'

/** Headers only — mirrors the log cap's role of keeping `state.json` small; bodies live on disk, see `inboxStore.ts`. */
const INBOX_MESSAGE_CAP = 1000

/** The nightly hold window, in the shape `src/core/schedule` expects. */
function quietFrom(settings: Settings): QuietHours {
  return {
    enabled: settings.quietHoursEnabled,
    start: settings.quietStart,
    end: settings.quietEnd,
  }
}

/**
 * Every calendar rewrite an occurrence list goes through, in one place.
 *
 * Order is not arbitrary. The working-day policy decides *which day* a
 * reminder belongs on, and quiet hours then decide *what time* it may leave —
 * running them the other way round would move a 02:00 fire to 07:00 and only
 * then notice it was a public holiday, moving it again to a time nobody chose.
 */
function shapeOccurrences(
  occurrences: number[],
  job: Pick<ScheduledJob, 'recurrence'>,
  settings: Settings,
  now = Date.now(),
  /**
   * The recipients' delivery windows, when any of them has one.
   *
   * Applied last, and it wins. The order is the whole point: the working
   * calendar and quiet hours are both about the *sender* — which days they
   * work, when they are asleep — and a delivery window is about the
   * *recipient's* day. Re-applying quiet hours afterwards would push the send
   * straight back out of the window every time, which would reduce this
   * feature to a no-op while looking like it worked. The consequence is
   * accepted deliberately: a send released into the recipient's morning may
   * sit inside the sender's night, and it should, because nobody is being
   * woken by it.
   */
  windows: DeliveryWindow[] = [],
): { occurrences: number[]; warning?: CalendarWarning } {
  const calendar = settings.workCalendar ?? DEFAULT_WORK_CALENDAR
  /*
   * `now` is passed as the floor, which is the point of this function existing.
   *
   * `applyWorkCalendarDetailed` takes `notBefore` as opt-in because several of
   * its callers walk historical dates on purpose — the conflict scan and the
   * calendar screen's month view both do. This one never does: every path that
   * reaches here is arming a real reminder. Without the floor a `'before'`
   * shift off a holiday could land in the past, and the two platforms then
   * disagreed about a send the preview had already promised would not happen —
   * the desktop's `tick()` fired it immediately, Android dropped it and left
   * the row showing a next-send time that never advanced. `upcoming()` passed
   * the floor from the day it was added; this is the path that actually arms.
   *
   * The catch-up instants are deliberately not subject to it: `rearm`'s
   * `dueNow` is prepended by the caller, after this, precisely because a past
   * instant there is being *paid*, not placed.
   */
  const { occurrences: shaped, adjustment } = applyWorkCalendarDetailed(
    occurrences,
    job.recurrence.workdayPolicy ?? 'off',
    calendar,
    now,
  )
  const quieted = applyQuietHours(shaped, quietFrom(settings))
  return {
    occurrences:
      windows.length === 0
        ? quieted
        // `applyDeliveryWindows` never drops an occurrence: an unsatisfiable
        // set of windows returns the original instant and reports why, because
        // a late message is a nuisance and a missing one is the failure this
        // application exists to prevent.
        : quieted.map((at) => applyDeliveryWindows(at, windows).at),
    warning: calendarWarning(adjustment, now),
  }
}

/**
 * The windows belonging to a message's recipients, in `to` order.
 *
 * Cc and Bcc are deliberately not consulted: a window says when someone should
 * be *reached*, and letting a carbon copy hold up the actual recipient's mail
 * would be the tail wagging the dog.
 *
 * Deliberately **not** a second implementation of that rule. This started as a
 * private copy here with a twin in `deliveryPreview.ts` — the compose screen
 * needs the same answer to say "this will actually go out at 16:00 for Alice",
 * and it cannot reach into the reducer for it. Two copies of one rule is the
 * shape this codebase has been caught by before: the moment they disagree, the
 * compose screen promises a send time the scheduler does not use, and nothing
 * on either side looks wrong. One function, called from both.
 */
function windowsForDraft(to: string[], contacts: Contact[]): DeliveryWindow[] {
  return windowsOf(windowsForRecipients(to, contacts))
}

/**
 * Recompute one job's list from its *rule*, not from its stored list.
 *
 * Stored occurrences have already been shifted. Re-shaping them would apply
 * the calendar twice, and — worse — the original time is not recoverable from
 * them, so a user who removed a holiday could never get the reminder back on
 * the day they had first asked for.
 */
function rebuildJob(
  job: ScheduledJob,
  settings: Settings,
  now = Date.now(),
  /** Absent means "no contact list to consult", not "no windows" — see `windowsForDraft`. */
  contacts: Contact[] = [],
): ScheduledJob {
  const recurrence = migrateSkipWeekends(job.recurrence)
  const raw = computeOccurrences(recurrence, {
    runsSoFar: job.runCount,
    count: 24,
    after: now,
    calendar: settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
  })
  const { occurrences, warning } = shapeOccurrences(
    raw,
    { recurrence },
    settings,
    now,
    windowsForDraft(job.draft.to, contacts),
  )
  return {
    ...job,
    recurrence,
    occurrences,
    calendarWarning: warning,
    rawOccurrences: raw,
    rawOccurrencesRunCount: job.runCount,
  }
}

/**
 * `rebuildJob`'s cheap half — re-shape a job from its cached raw occurrence
 * list instead of re-running the day-by-day search that built it.
 *
 * The search inside `computeOccurrences` is what makes a full rebuild cost
 * anything: for a sparse rule (monthly, yearly, a tight cron) it can walk
 * hundreds of candidate days per occurrence. None of that depends on the
 * working calendar or quiet hours — only `shapeOccurrences`, which is a
 * single pass over at most 24 numbers, does. So when the raw list is still
 * good, only the cheap half needs to run again.
 *
 * "Still good" is two checks, and either one failing means something changed
 * the job out from under the cache without telling it, so this falls back to
 * a full `rebuildJob` — always correct, just not always fast:
 *
 *   - `rawOccurrencesRunCount` must match the live `runCount`. A run can end
 *     an `afterCount` rule — or simply advance which occurrence is "next" —
 *     on a day nothing about the calendar changed, and a cache computed
 *     before that run does not know it happened.
 *   - The cached list's first entry must still be in the future. It is
 *     ascending, so if the first entry has not yet passed, none of them has —
 *     and if it has, the cache is exactly as stale as a job whose reminder
 *     already went out while nobody re-armed it.
 */
function reshapeJob(job: ScheduledJob, settings: Settings, now: number, contacts: Contact[]): ScheduledJob {
  const raw = job.rawOccurrences
  const cacheValid =
    raw !== undefined &&
    job.rawOccurrencesRunCount === job.runCount &&
    (raw.length === 0 || raw[0] > now)
  if (!cacheValid) return rebuildJob(job, settings, now, contacts)

  const { occurrences, warning } = shapeOccurrences(
    raw,
    { recurrence: job.recurrence },
    settings,
    now,
    windowsForDraft(job.draft.to, contacts),
  )
  return { ...job, occurrences, calendarWarning: warning }
}

// ---------------------------------------------------------------------------
// The daily digest
// ---------------------------------------------------------------------------

/**
 * The digest's mail, composed from the schedule as it stands right now.
 *
 * This is the whole mechanism, and it is deliberately not a mechanism. There is
 * no digest timer, no digest sender and no digest branch in either native
 * scheduler: the digest is an ordinary daily `ScheduledJob`, budgeted by the
 * same recurrence engine, shaped by the same quiet hours and working calendar,
 * and handed over in the same `bridge.syncJobs` call as everything else. The
 * only thing that is special about it is that its *body* is generated on the
 * way out instead of being typed once and stored — the same place, and for the
 * same reason, that `forTransport` renders Markdown on the way out: the process
 * that finally sends this has no idea how to compute a schedule summary and
 * never will.
 *
 * The consequence is honest and is stated in the mail itself: the body is as
 * fresh as the last time the schedule was armed, and `digest.generatedAt`
 * records exactly when that was.
 */
function withDigestBody(job: ScheduledJob, live: AppState, i18n: I18n): ScheduledJob {
  const digest = buildDigest(live.jobs, {
    quiet: quietFrom(live.settings),
    calendar: live.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
    // Otherwise the digest opens every morning by reporting itself.
    excludeJobIds: [DIGEST_JOB_ID],
  })
  const names = new Map(live.jobs.map((j) => [j.id, j.name]))
  const ctx = {
    t: i18n.t,
    formatDateTime: i18n.formatDateTime,
    jobName: (id: string) => names.get(id) ?? id,
  }
  return {
    ...job,
    draft: {
      ...job.draft,
      subject: renderDigestSubject(digest, ctx),
      body: renderDigestBody(digest, ctx),
      bodyFormat: 'plain',
    },
  }
}

/** The digest job as the settings currently describe it, occurrences and all. */
function digestJobFor(
  existing: ScheduledJob | undefined,
  opts: { accountId: string; to: string; time: string; name: string },
  settings: Settings,
  now = Date.now(),
): ScheduledJob {
  return rebuildJob(
    {
      id: DIGEST_JOB_ID,
      name: opts.name,
      enabled: true,
      draft: {
        ...emptyDraft(opts.accountId),
        to: [opts.to],
        subject: opts.name,
        bodyFormat: 'plain',
      },
      recurrence: {
        ...defaultRecurrence(now),
        kind: 'daily',
        startAt: now,
        timeOfDay: opts.time,
      },
      occurrences: [],
      runCount: existing?.runCount ?? 0,
      retry: DEFAULT_RETRY,
      status: 'armed',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    settings,
    now,
  )
}

/**
 * Would writing this change anything the user can see?
 *
 * The effect that maintains the digest runs whenever an account is edited, and
 * an unconditional dispatch there would bump `updatedAt` — which is half the
 * signature that decides whether to tear down and rebuild every alarm on the
 * device.
 */
function sameDigestJob(a: ScheduledJob, b: ScheduledJob): boolean {
  return (
    a.enabled === b.enabled &&
    a.name === b.name &&
    a.recurrence.timeOfDay === b.recurrence.timeOfDay &&
    a.draft.accountId === b.draft.accountId &&
    a.draft.to.join(',') === b.draft.to.join(',')
  )
}

/** Two occurrence lists that would arm the same alarms. */
function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

/**
 * "N reminders have no working day to move to" — as an activity entry, because
 * a dropped send is otherwise indistinguishable from a send that has not
 * happened yet.
 */
function droppedLog(job: ScheduledJob, warning: CalendarWarning): LogEntry | null {
  if (warning.dropped.length === 0) return null
  return {
    id: newId('log'),
    at: warning.at,
    kind: 'schedule',
    level: 'error',
    title: `Will not be sent: ${job.name}`,
    detail:
      `${warning.dropped.length} fire time(s) fall on days the working calendar has no ` +
      `working day near — first ${new Date(warning.dropped[0]).toLocaleString()}.`,
    jobId: job.id,
  }
}

/** The `Settings` keys `core/backup.ts`'s `AppearanceSettings` picks — kept as a runtime list so `patchSettings` can tell "did this touch appearance" without re-typing the field list. */
const APPEARANCE_KEYS: readonly (keyof Settings)[] = [
  'themeMode',
  'visualStyle',
  'accent',
  'accentBase',
  'accentCyber',
  'themeIntensity',
  'density',
  'listDensity',
  'textScale',
  'oneHand',
]

/**
 * Re-derive every enabled job's occurrences against a calendar/quiet-hours
 * settings that just changed — the one place both a local edit
 * (`patchSettings`) and an incoming sync patch (`applySyncResult`) go
 * through, so a calendar that arrives over device sync rearms the scheduler
 * exactly the way editing it locally already does, instead of leaving
 * `job.occurrences` computed against the calendar the UI no longer shows.
 */
function recomputeJobsForCalendar(
  jobs: ScheduledJob[],
  logs: LogEntry[],
  settings: Settings,
  contacts: Contact[],
  touchesQuiet: boolean,
): { jobs: ScheduledJob[]; logs: LogEntry[] } {
  const now = Date.now()
  const fresh: LogEntry[] = []
  const nextJobs = jobs.map((job) => {
    // Quiet hours apply to every armed job; the calendar only reaches the
    // ones that opted in, so the rest are left strictly untouched — no new
    // `updatedAt`, no re-arm, no churn on the device.
    if (!job.enabled) return job
    if (!touchesQuiet && (job.recurrence.workdayPolicy ?? 'off') === 'off') return job
    const next = reshapeJob(job, settings, now, contacts)
    if (
      sameList(next.occurrences, job.occurrences) &&
      next.recurrence === job.recurrence &&
      next.calendarWarning === undefined &&
      job.calendarWarning === undefined
    ) {
      // The visible answer did not change, so this must not bump
      // `updatedAt` or touch anything the scheduler-sync signature watches.
      return job.rawOccurrences === next.rawOccurrences && job.rawOccurrencesRunCount === next.rawOccurrencesRunCount
        ? job
        : { ...job, rawOccurrences: next.rawOccurrences, rawOccurrencesRunCount: next.rawOccurrencesRunCount }
    }
    // `updatedAt` is what the scheduler-sync signature watches. Without
    // bumping it, a change that moved only the *later* occurrences would
    // leave the device holding the old alarms.
    if (next.calendarWarning) {
      const entry = droppedLog(next, next.calendarWarning)
      if (entry) fresh.push(entry)
    }
    return { ...next, updatedAt: now }
  })
  return { jobs: nextJobs, logs: fresh.length > 0 ? pruneLogs([...fresh, ...logs], settings) : logs }
}

/**
 * Does a bridge call's return value *say* it failed?
 *
 * `PlatformBridge.setMessageFlags` is declared `Promise<void>`, and both
 * implementations behind it have resolved whether or not the server actually
 * agreed — which is how a `\Seen` push could fail while the screen went on
 * showing the message as read. The two platform sides are being taught to
 * report the truth, and this reads whatever they end up returning without
 * pinning the renderer to one field name:
 *
 *   - `false`                                → failed
 *   - `{ ok: false }` / `{ success: false }` → failed
 *   - `{ failed: true }`                     → failed
 *   - `{ error: <anything non-empty> }`      → failed, whatever else it carries
 *   - anything else, `undefined` included    → not known to have failed
 *
 * The default is optimistic on purpose. `undefined` is exactly what today's
 * `Promise<void>` signature resolves to, so reading "this platform told us
 * nothing" as a failure would queue every message the user opens for retry
 * forever, on every platform that never reports anything. A queue that never
 * drains is worse than no queue at all: it also pins read state that ought to
 * be free to follow the server again. Guessing optimistically and being wrong
 * costs one lost push, and `mergeSeenFlags` rule 2 below still keeps the local
 * "read" from being undone.
 */
function looksFailed(result: unknown): boolean {
  if (result === false) return true
  if (typeof result !== 'object' || result === null) return false
  const r = result as Record<string, unknown>
  if (r.ok === false || r.success === false || r.failed === true) return true
  if (typeof r.error === 'string') return r.error.length > 0
  return r.error !== undefined && r.error !== null
}

function initialState(): AppState {
  return {
    accounts: [],
    jobs: [],
    contacts: [],
    templates: [],
    logs: [],
    // Minted once, here — `useReducer(reducer, undefined, initialState)` calls
    // this exactly once per install (lazy init), and `case 'reset'` reusing it
    // is correct too: a reset device has no paired devices left either, so a
    // fresh identity is the right thing for it to present next time it pairs.
    settings: { ...DEFAULT_SETTINGS, localDeviceId: newId('device') },
    draft: emptyDraft(),
    inboxAccounts: [],
    draftSnapshots: [],
    outbox: [],
    codeHits: [],
    recentRecipients: [],
    pairedDevices: [],
    syncConflicts: [],
    deletedJobs: [],
    notifyLedger: [],
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * A `\Seen` change this device has already applied locally and has not yet had
 * the server confirm.
 *
 * Handed to the reducer on the action rather than read out of a module-level
 * variable, so `reducer` stays a pure function of `(state, action)`. The
 * `scripts/check-*.mjs` gates drive it directly, and a hidden mutable input is
 * precisely what lets such a gate stay green while the app misbehaves.
 *
 * `uidValidity` travels with the entry because `InboxMessage.id` is only
 * `accountId:folderPath:uid` (see `messageRowId` in `electron/imap.ts`) — the
 * very same string names a *different* message once the server rolls
 * UIDVALIDITY, which `InboxFolder.uidValidity` explains. Matching on the id
 * alone would pin one message's read state onto whatever later took its uid.
 */
type PendingSeenPush = {
  /** `InboxMessage.id`, which is what the queue is keyed by. */
  id: string
  folderPath: string
  uid: number
  uidValidity: number
  /** What this device believes the server should end up holding. */
  seen: boolean
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { type: 'hydrate'; state: AppState }
  | { type: 'patchSettings'; patch: Partial<Settings> }
  | { type: 'setDraft'; patch: Partial<MessageDraft> }
  | { type: 'resetDraft'; accountId?: string }
  | { type: 'upsertAccount'; account: MailAccount }
  | { type: 'reorderAccounts'; ids: string[] }
  | { type: 'removeAccount'; id: string }
  | { type: 'upsertJob'; job: ScheduledJob }
  | { type: 'jobRan'; jobId: string; run: JobRun }
  | { type: 'removeJob'; id: string }
  | { type: 'upsertContact'; contact: Contact }
  | { type: 'removeContact'; id: string }
  | { type: 'upsertTemplate'; template: Template }
  | { type: 'removeTemplate'; id: string }
  | { type: 'log'; entry: LogEntry }
  /**
   * One sync's worth of new-mail decisions, counts only.
   *
   * Separate from `log` rather than folded into it because the two are read by
   * different people for different reasons: the activity log is a human-
   * readable record someone scrolls, and this is arithmetic a screen adds up.
   * Putting the counts in prose would mean the Settings summary had to parse
   * its own log messages back out of six languages.
   */
  | { type: 'recordNotifyDecision'; entry: NotifyLedgerEntry }
  | { type: 'clearLogs' }
  /**
   * One row off the activity log.
   *
   * `clearLogs` was the only way to remove anything, which is all-or-nothing on
   * the single screen that answers "did my reminders actually go out" — so
   * clearing one row you had dealt with meant destroying the evidence for every
   * other. This is the per-row half of the same control.
   */
  | { type: 'removeLog'; id: string }
  | { type: 'rebaseAttachments'; from: string; to: string }
  // `pendingSeen` is only meaningful alongside `origin: 'sync'` — it is the
  // `\Seen` pushes still unconfirmed when the result landed (see
  // `mergeSeenFlags`). Kept on one line with the rest: `check-inbox-removal.mjs`
  // asserts this member's exact text to prove a sync still identifies itself.
  | { type: 'upsertInboxAccount'; inbox: InboxAccountState; origin?: 'sync'; pendingSeen?: readonly PendingSeenPush[] }
  | { type: 'removeInboxAccount'; accountId: string }
  | {
      type: 'patchInboxMessages'
      accountId: string
      ids: string[]
      patch: Partial<Pick<InboxAccountState['messages'][number], 'seen' | 'tag' | 'bodyCached'>>
    }
  | { type: 'removeInboxMessages'; accountId: string; ids: string[]; purge?: boolean }
  | { type: 'restoreInboxMessages'; accountId: string; keys: string[] }
  | { type: 'clearRemovedMessages'; accountId?: string }
  | { type: 'snapshotDraft'; reason: SnapshotReason }
  | { type: 'restoreSnapshot'; id: string }
  | { type: 'clearSnapshots' }
  | { type: 'enqueue'; item: OutboxItem }
  | { type: 'patchOutbox'; id: string; patch: Partial<OutboxItem> }
  | { type: 'dequeue'; id: string }
  | { type: 'clearOutbox' }
  | { type: 'recordCodes'; hits: NewHit[] }
  | { type: 'markCodeCopied'; id: string }
  | { type: 'markCodeRead'; id: string }
  | { type: 'markAllCodesRead' }
  | { type: 'clearCodeHits' }
  | { type: 'recordRecipients'; addresses: string[]; names?: Record<string, string> }
  | { type: 'upsertPairedDevice'; device: PairedDevice }
  | { type: 'removePairedDevice'; id: string }
  | {
      type: 'applySyncResult'
      deviceId: string
      patch: SyncApplyPatch
      conflicts: ConflictSnapshot[]
      syncedAt: number
    }
  /**
   * Advance a peer's replay-protection high-water mark, and nothing else —
   * deliberately not folded into `applySyncResult`, which also touches
   * `lastSyncedAt` via `touchSynced`. This fires *before* an exchange has
   * finished (see `syncResponder.current`'s `commitAcceptedSeq` hook), so
   * marking the device "just synced" at that point would be premature — the
   * exchange might still fail to save.
   */
  | { type: 'commitSyncSeq'; deviceId: string; seq: number }
  | { type: 'restoreSyncConflict'; id: string }
  | { type: 'reset' }

/**
 * Decide each incoming message's `seen` flag from what this device already
 * knew and what it is still trying to tell the server.
 *
 * This exists because read state was the one mailbox field this app changes
 * *first* and reports *afterwards*, while `upsertInboxAccount` replaced the
 * message list wholesale. The optimistic write lands in `patchInboxMessages`
 * the instant a message is opened; the `\Seen` push leaves behind it; and syncs
 * fire on a five-minute timer, on every IMAP IDLE push, and on every
 * `visibilitychange` back to the foreground. A sync that started before the
 * push arrived comes back carrying the server's pre-push answer, and writing
 * that list in unchanged put the stale `false` back over the user's read. The
 * symptom, reported on desktop and Android alike: "I read it, and a while later
 * it was bold again."
 *
 * The failure path has the same shape: `syncInboxAccount`'s catch branch writes
 * back `{...config}`, and `config` is the message list this closure captured
 * when the sync *started* — older still than anything the server said.
 *
 * Two rules, in order:
 *
 *   1. A push the server has not confirmed wins outright, in both directions.
 *      Its value is newer than anything a sync can be reporting, because the
 *      server has not been told yet. Both directions, not just "read": a
 *      deliberate mark-as-*unread* is undone by rule 2 for as long as its push
 *      is in flight, and that is the same bug wearing the other hat.
 *   2. Otherwise `seen` only ever moves from false to true. A server that says
 *      "unread" about a message this device has locally read is, far more often
 *      than not, answering from before a push it has not processed yet.
 *
 * The price of rule 2, stated plainly rather than discovered later: marking a
 * message back to *unread* somewhere else — webmail, a phone's stock mail app —
 * no longer reaches this device, which keeps showing it as read until the row
 * ages out of the list. That is a rare, deliberate act whose loss is visible
 * and undone with one click, traded against a frequent, silent one that made
 * the read state untrustworthy. If the trade ever needs revisiting, the honest
 * fix is a per-message "the server told us this at time T" stamp so the two
 * answers can be ordered — not deleting this rule and going back to whichever
 * reply happened to land last.
 *
 * Alignment is by `(folderPath, uid, uidValidity)`. A folder whose UIDVALIDITY
 * changed has no comparable rows at all, so nothing is carried forward for it
 * and the server's answer stands — the alternative is pinning one message's
 * read state onto a different message that now holds the same uid, which is the
 * exact hazard `InboxFolder.uidValidity` is documented against.
 *
 * Takes the whole action, and owns the `origin` test itself, so that the call
 * site inside the reducer stays one short expression: `check-inbox-removal.mjs`
 * measures the *characters* between `case 'upsertInboxAccount'` and
 * `withoutRemoved(`, and that budget was already nearly spent before this
 * existed. The explanation lives here, where it costs nothing.
 */
function mergeSeenFlags(
  action: Extract<Action, { type: 'upsertInboxAccount' }>,
  prior: InboxAccountState | undefined,
): InboxMessage[] {
  const incoming = action.inbox.messages
  // A non-sync write is left alone: a settings edit or an image-policy toggle
  // carries the message list straight out of current state, so there is nothing
  // older for it to overwrite and nothing to merge against.
  if (action.origin !== 'sync') return [...incoming]
  const priorMessages = prior?.messages
  const pending = action.pendingSeen
  if (!priorMessages?.length && !pending?.length) return [...incoming]
  // The same NUL separator `removalKey` joins its parts with, written as an
  // escape rather than as the raw byte: identical at runtime, and it keeps the
  // largest source file here from making every `grep` answer "binary file".
  const key = (folderPath: string, uid: number, uidValidity: number): string =>
    `${folderPath}\u0000${uid}\u0000${uidValidity}`
  const readHere = new Set<string>()
  for (const m of priorMessages ?? []) {
    if (m.seen) readHere.add(key(m.folderPath, m.uid, m.uidValidity))
  }
  const inFlight = new Map<string, boolean>()
  for (const p of pending ?? []) inFlight.set(key(p.folderPath, p.uid, p.uidValidity), p.seen)
  return incoming.map((m) => {
    const k = key(m.folderPath, m.uid, m.uidValidity)
    const queued = inFlight.get(k)
    // `??`, not `||`: a queued mark-as-unread is `false` and must still win.
    const seen = queued ?? (m.seen || readHere.has(k))
    // Same row back when nothing moved, for the same reason
    // `patchInboxMessages` does it — a needless new identity here is a needless
    // re-render of the most expensive list in the app.
    return seen === m.seen ? m : { ...m, seen }
  })
}

/**
 * Exported for `scripts/check-work-calendar.mjs`, which drives `patchSettings`
 * directly. The alternative was asserting that the *source* contains a
 * recompute, which is exactly the kind of guard that passes while the behaviour
 * is broken. Nothing in the app imports it.
 */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    /*
     * Pruned on the way in, not only on the way out.
     *
     * A state file written before the limits existed — or written on a machine
     * where they were looser — arrives with entries the current policy says
     * should be gone. Applying it at load is what makes "records older than N
     * days are deleted" survive a restart instead of being re-read every time.
     */
    case 'hydrate':
      return { ...action.state, logs: pruneLogs(action.state.logs, action.state.settings) }

    /*
     * Lowering a limit has to take effect now, not at the next log line. Left
     * to the `log` case, someone who set retention to 1 day would still be
     * carrying a month of recipients on disk until the next send happened.
     */
    /*
     * ...and so does moving a holiday.
     *
     * The working calendar and the quiet window are not display preferences:
     * they are inputs to `job.occurrences`, which is the list the platform
     * scheduler is actually holding. Left to be picked up "next time", editing
     * the calendar changed what the preview drew and nothing about what would
     * fire — until the next restart, or until each job happened to be saved or
     * toggled by hand. Marking 1 October a holiday and watching the reminder go
     * out on 1 October anyway is precisely the silent failure this application
     * exists to prevent.
     *
     * Recomputed here, inside the reducer, on purpose. The obvious place was a
     * callback that dispatches and then reads the calendar back out of state —
     * which is the bug `saveInboxAccount` already shipped once, because
     * `dispatch` is not synchronous and the read returns the *previous* value.
     * The reducer is the one place that holds the new settings and the old jobs
     * at the same time, so there is nothing to read back.
     */
    case 'patchSettings': {
      const touchesCalendar = action.patch.workCalendar !== undefined
      const touchesAppearance = APPEARANCE_KEYS.some((key) => key in action.patch)
      const now = Date.now()
      const settings = {
        ...state.settings,
        ...action.patch,
        // Stamped here, centrally, rather than at every caller that can
        // change a theme or calendar field — see `Settings.workCalendarUpdatedAt`
        // / `appearanceUpdatedAt` for why device sync needs this.
        ...(touchesCalendar ? { workCalendarUpdatedAt: now } : {}),
        ...(touchesAppearance ? { appearanceUpdatedAt: now } : {}),
      }
      const touchesRetention =
        action.patch.logRetentionDays !== undefined || action.patch.logMaxEntries !== undefined
      const touchesQuiet =
        action.patch.quietHoursEnabled !== undefined ||
        action.patch.quietStart !== undefined ||
        action.patch.quietEnd !== undefined

      let jobs = state.jobs
      let logs = state.logs
      if (touchesCalendar || touchesQuiet) {
        ;({ jobs, logs } = recomputeJobsForCalendar(state.jobs, state.logs, settings, state.contacts, touchesQuiet))
      }

      return {
        ...state,
        settings,
        jobs,
        logs: touchesRetention ? pruneLogs(logs, settings) : logs,
      }
    }

    // The compose draft and its autosave history — see
    // `services/draftReducer.ts` for the case-by-case logic, moved there
    // unchanged.
    case 'setDraft':
    case 'resetDraft':
      return applyDraftAction(state, action)

    // Mail-account add/edit, reorder, and delete — see
    // `services/accountsReducer.ts` for the case-by-case logic, moved there
    // unchanged.
    case 'upsertAccount':
    case 'reorderAccounts':
    case 'removeAccount':
      return applyAccountAction(state, action)

    // Job creation/replacement and deletion — see `services/jobReducer.ts`
    // for the case-by-case logic, moved there unchanged. `jobRan` (just
    // below) stays here rather than joining them: `scripts/check-job-status.mjs`
    // greps this file's own source for `case 'jobRan'` followed by an
    // `applyRun(` call close by, so that one case's body has to stay put.
    case 'upsertJob':
      return applyJobAction(state, action)

    /**
     * A run finished on the platform scheduler; write what it did back onto
     * the job the user actually looks at.
     *
     * `updatedAt` is deliberately *not* touched. It feeds the signature that
     * decides whether to re-arm the platform scheduler, and re-arming on the
     * scheduler's own report would have every send trigger a fresh sync — a
     * loop whose only symptom would be alarms being torn down and rebuilt
     * every time one fired.
     */
    case 'jobRan':
      return {
        ...state,
        jobs: state.jobs.map((j) => (j.id === action.jobId ? applyRun(j, action.run) : j)),
      }

    case 'removeJob':
      return applyJobAction(state, action)

    // Contact add/edit/remove — see `services/contactsReducer.ts` for the
    // case-by-case logic, moved there unchanged.
    case 'upsertContact':
    case 'removeContact':
      return applyContactAction(state, action)

    // Template add/edit/remove — see `services/templatesReducer.ts` for the
    // case-by-case logic, moved there unchanged.
    case 'upsertTemplate':
    case 'removeTemplate':
      return applyTemplateAction(state, action)

    // Activity log append/clear/remove — see `services/logsReducer.ts` for
    // the case-by-case logic, moved there unchanged.
    case 'log':
    case 'clearLogs':
    case 'removeLog':
      return applyLogAction(state, action)

    /*
     * Counts only, pruned to a day on the way in — see `ops/notifyLedger.ts`.
     * `appendLedger` returns the same array when nothing expired, but a new
     * entry always means a new array, so there is no identity shortcut to take
     * here the way `removeLog` takes one.
     */
    case 'recordNotifyDecision':
      return {
        ...state,
        notifyLedger: appendLedger(state.notifyLedger ?? [], action.entry),
      }

    // Data-folder-move path repair — see `services/attachmentsReducer.ts`
    // for the logic, moved there unchanged.
    case 'rebaseAttachments':
      return applyAttachmentAction(state, action)

    case 'upsertInboxAccount': {
      // Belt and braces: `syncInboxAccount` already refuses to dispatch this
      // for a deleted account, but that guard lives at the call site, and a
      // call site is exactly what a future caller forgets to copy. An id
      // `state.accounts` no longer holds has nothing left to belong to, so
      // the reducer refuses the write itself rather than trust every caller.
      if (!state.accounts.some((a) => a.id === action.inbox.accountId)) return state
      const exists = state.inboxAccounts.some((i) => i.accountId === action.inbox.accountId)
      // The tombstone list belongs to the app, not to the sync result: a sync
      // reports what the server holds and knows nothing about what the user
      // has removed. Carrying the prior list forward here is what stops a
      // sync from quietly clearing it — and clearing it would resurrect every
      // removed message on the very next poll, which is the bug this exists
      // to fix.
      const prior = state.inboxAccounts.find((i) => i.accountId === action.inbox.accountId)
      const removed = mergeRemoved(prior?.removed, action.inbox.removed, Date.now())
      // Same reasoning as `removed`, for the same reason, on the fields the
      // user owns rather than the server: a sync captures its config in a
      // closure, then awaits IMAP for however long that takes. Flip the
      // remote-image switch while one is in flight and the reply lands
      // afterwards carrying the value from before the flip — writing 'never'
      // back over the 'always' the user just chose. Poll interval defaults to
      // five minutes and IDLE can push at any moment, so the window is not
      // theoretical. A sync result is authoritative about the mailbox and
      // about nothing else.
      const preferences =
        action.origin === 'sync' && prior
          ? { showRemoteImages: prior.showRemoteImages, imageAllowlist: prior.imageAllowlist }
          : {}
      // Cap message rows here, not in the caller — every writer of this
      // action (a fresh sync, a future push-update) gets the ceiling for free.
      // `seen` is merged, not replaced: `mergeSeenFlags` holds that rule.
      const inbox: InboxAccountState = {
        ...action.inbox,
        ...preferences,
        removed,
        messages: withoutRemoved(mergeSeenFlags(action, prior), removed)
          .sort((a, b) => b.date - a.date)
          .slice(0, INBOX_MESSAGE_CAP),
      }
      const inboxAccounts = exists
        ? state.inboxAccounts.map((i) => (i.accountId === inbox.accountId ? inbox : i))
        : [...state.inboxAccounts, inbox]
      return { ...state, inboxAccounts }
    }

    case 'removeInboxAccount':
      return {
        ...state,
        inboxAccounts: state.inboxAccounts.filter((i) => i.accountId !== action.accountId),
      }

    case 'patchInboxMessages': {
      /*
       * Returns the *same* state when the patch changes nothing.
       *
       * It used to allocate a new account list, a new message list and a new
       * message object regardless, so marking an already-cached body as
       * cached — which the code watcher does for every message it looks at —
       * produced a brand-new `inboxAccounts` identity. The watcher's own
       * effect depends on that identity, so it re-ran, cancelled itself before
       * it could record which messages it had already examined, and fetched
       * them all again. A quiet loop that burned IPC and re-rendered the tree
       * on a timer, with nothing visibly wrong.
       */
      const idSet = new Set(action.ids)
      const keys = Object.keys(action.patch) as Array<keyof typeof action.patch>
      let touched = false
      const inboxAccounts = state.inboxAccounts.map((i) => {
        if (i.accountId !== action.accountId) return i
        let accountTouched = false
        const messages = i.messages.map((m) => {
          if (!idSet.has(m.id)) return m
          if (keys.every((k) => m[k] === action.patch[k])) return m
          accountTouched = true
          return { ...m, ...action.patch }
        })
        if (!accountTouched) return i
        touched = true
        return { ...i, messages }
      })
      return touched ? { ...state, inboxAccounts } : state
    }

    /**
     * Remove from this app, and write down that it happened.
     *
     * The tombstone is the whole point. Filtering the list alone is what the
     * old version did, and the next sync put every one of them back.
     */
    case 'removeInboxMessages': {
      const idSet = new Set(action.ids)
      const now = Date.now()
      const inboxAccounts = state.inboxAccounts.map((i) => {
        if (i.accountId !== action.accountId) return i
        const going = i.messages.filter((m) => idSet.has(m.id))
        return {
          ...i,
          messages: i.messages.filter((m) => !idSet.has(m.id)),
          // `purge` means the message is being destroyed on the server too, so
          // there is nothing to restore it from and no reason to offer.
          removed: action.purge ? i.removed : rememberRemoved(i.removed, going, now),
        }
      })
      return { ...state, inboxAccounts }
    }

    /** Take messages back out of the recycle bin and straight into the list. */
    case 'restoreInboxMessages': {
      const inboxAccounts = state.inboxAccounts.map((i) => {
        if (i.accountId !== action.accountId) return i
        const { removed, restored } = restoreRemoved(i.removed, action.keys)
        return {
          ...i,
          removed,
          messages: [...restored, ...i.messages]
            .sort((a, b) => b.date - a.date)
            .slice(0, INBOX_MESSAGE_CAP),
        }
      })
      return { ...state, inboxAccounts }
    }

    /** Empty the recycle bin for one account, or for all of them. */
    case 'clearRemovedMessages':
      return {
        ...state,
        inboxAccounts: state.inboxAccounts.map((i) =>
          action.accountId && i.accountId !== action.accountId ? i : { ...i, removed: [] },
        ),
      }

    // The draft autosave history — see `services/draftReducer.ts` for the
    // case-by-case logic, moved there unchanged (same domain as `setDraft`/
    // `resetDraft` above, kept as one file).
    case 'snapshotDraft':
    case 'restoreSnapshot':
    case 'clearSnapshots':
      return applyDraftAction(state, action)

    // The offline send queue's own array in state — see
    // `services/outboxReducer.ts`'s doc comment for what stayed behind here
    // (`sendDraftNow`, `flushOutbox`, and everything that decides *when* to
    // queue or retry).
    case 'enqueue':
    case 'patchOutbox':
    case 'dequeue':
    case 'clearOutbox':
      return applyOutboxAction(state, action)

    // Verification-code hits and the recent-recipient tally — see
    // `services/codeHistoryReducer.ts` for the case-by-case logic, moved
    // there unchanged.
    case 'recordCodes':
    case 'markCodeCopied':
    case 'markCodeRead':
    case 'markAllCodesRead':
    case 'clearCodeHits':
    case 'recordRecipients':
      return applyCodeHistoryAction(state, action)

    // Device pairing — see `services/syncReducer.ts` for the case-by-case
    // logic, moved there unchanged.
    case 'upsertPairedDevice':
    case 'removePairedDevice':
      return applySyncAction(state, action)

    /**
     * One sync cycle's worth of change, landed in one dispatch — see
     * `core/syncLoop.ts`'s `performExchange`. `patch` only ever names arrays
     * that actually changed (an untouched scope is `undefined`, not an empty
     * array), so every field here falls back to what was already there.
     */
    case 'applySyncResult': {
      const { patch, conflicts, deviceId, syncedAt } = action
      // `syncLoop.ts` already gated `patch.appearance`/`patch.workCalendar` on
      // being newer than what this device held when the exchange started —
      // re-checked here against *current* state too, in case a local edit
      // landed while the exchange was still in flight.
      const adoptAppearance =
        patch.appearance !== undefined && (patch.appearanceUpdatedAt ?? 0) > (state.settings.appearanceUpdatedAt ?? 0)
      const adoptCalendar =
        patch.workCalendar !== undefined &&
        (patch.workCalendarUpdatedAt ?? 0) > (state.settings.workCalendarUpdatedAt ?? 0)

      const settings =
        adoptAppearance || adoptCalendar
          ? {
              ...state.settings,
              ...(adoptAppearance ? { ...patch.appearance, appearanceUpdatedAt: patch.appearanceUpdatedAt } : {}),
              ...(adoptCalendar
                ? { workCalendar: patch.workCalendar, workCalendarUpdatedAt: patch.workCalendarUpdatedAt }
                : {}),
            }
          : state.settings

      let jobs = patch.jobs ?? state.jobs
      let logs = state.logs
      if (adoptCalendar) {
        // Mirrors `patchSettings`'s own rearm — a calendar that arrived over
        // sync must recompute occurrences the same way editing it locally
        // does, or the UI shows the new calendar while the scheduler keeps
        // firing against the old one.
        const recomputed = recomputeJobsForCalendar(jobs, state.logs, settings, state.contacts, false)
        jobs = recomputed.jobs
        logs = recomputed.logs
      }

      return {
        ...state,
        accounts: patch.accounts ?? state.accounts,
        jobs,
        logs,
        contacts: patch.contacts ?? state.contacts,
        templates: patch.templates ?? state.templates,
        settings,
        // `recordSyncSeq` after `touchSynced`, not folded into it: it merges
        // `outgoingSeq`/`lastAcceptedSeq` forward with `Math.max` rather than
        // overwriting, which is what keeps a racing exchange with this same
        // device (see `syncLoop.ts`'s module doc) from regressing either
        // counter — see `recordSyncSeq`'s own doc for why that matters.
        pairedDevices: recordSyncSeq(
          // `patch.remoteAddress` is set only when the peer announced an
          // address that differs from the one on file — see `performExchange`.
          // Passing `undefined` here, which is what this did, is why a pairing
          // died for good the first time a router handed the other device a
          // different lease: nothing ever wrote the new address down.
          touchSynced(
            state.pairedDevices,
            deviceId,
            syncedAt,
            patch.remoteAddress,
            patch.remoteDeviceId,
          ),
          deviceId,
          { outgoingSeq: patch.outgoingSeq, lastAcceptedSeq: patch.lastAcceptedSeq },
        ),
        syncConflicts: pushConflictSnapshots(state.syncConflicts, conflicts),
        // The full updated tombstone set, not a merge — `syncLoop.ts` already
        // computed the union of what this device knew plus what the peer
        // just sent before handing it back.
        deletedJobs: patch.deletedJobs ?? state.deletedJobs,
      }
    }

    // Replay-protection bookkeeping and "keep mine instead" conflict
    // rollback — see `services/syncReducer.ts` for the case-by-case logic,
    // moved there unchanged.
    case 'commitSyncSeq':
    case 'restoreSyncConflict':
      return applySyncAction(state, action)

    case 'reset':
      return initialState()

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * What one inbox refresh actually did, handed back to whoever asked for it.
 *
 * `lastSyncError` on the account is the durable record; this is the answer to
 * "what happened just now", which is a different question and the only one a
 * button press can honestly report on.
 */
export interface SyncOutcome {
  ok: boolean
  error?: string
  inbox?: InboxAccountState
}

export interface AppApi {
  state: AppState
  ready: boolean
  bridge: PlatformBridge | null
  i18n: I18n
  dispatch: (action: Action) => void
  /**
   * Why start-up stopped, when it did. `ready` stays false in that case, so
   * without this the UI has no way to tell "still loading" from "gave up".
   *
   * A key and a detail rather than a finished sentence. The three messages
   * this used to hold were written in English at the point they were thrown,
   * so the one screen a user sees when the app will not open — the screen
   * where being able to read it matters most — printed a Chinese title, an
   * English paragraph and a Chinese hint, in that order, in every locale but
   * one. `detail` is the engine's own words and stays untranslated, because
   * it is the part that gets pasted into a bug report.
   */
  bootError: { key: TranslationKey; detail?: string } | null

  /**
   * Ids of jobs boot had to disable because their stored record could not be
   * rebuilt. Empty on every healthy start. See the hydrate guard in `boot`.
   */
  repairedJobs: string[]
  /**
   * True when handing the schedule to the platform scheduler last failed.
   *
   * Nothing else can tell: the jobs are still in state, still enabled, still
   * showing a next-send time — the alarms behind them just do not exist. This
   * is the app's whole promise failing with the UI unchanged, so it has to be
   * reported rather than retried in silence.
   */
  schedulerUnreachable: boolean

  /**
   * Two consecutive failures to write the document to disk.
   *
   * Same category as `schedulerUnreachable` and for the same reason: nothing
   * on screen changes when a save fails, so everything the user has done this
   * session looks saved and is not. The strip is where that gets said.
   */
  saveFailing: boolean

  /**
   * What Android currently permits. `null` on desktop and web, where neither
   * question exists, and until the first read comes back.
   *
   * Re-read when the window becomes visible again, because the only way to
   * change either of these is to leave for a system settings screen and come
   * back — and nothing tells the page that happened.
   */
  permissions: PermissionSnapshot | null
  /**
   * Raise the notification dialog, or open the settings screen for it.
   *
   * The union is restated here rather than imported from
   * `AndroidPermissionsApi`, which is how it drifted: adding
   * `openAutoStartSettings` to the hook left this copy behind, and the only
   * reason it was caught is that the call site is typed. Kept in step by hand
   * — a mismatch is a compile error, not a silent no-op.
   */
  fixPermission: (
    what:
      | 'requestNotifications'
      | 'openNotificationSettings'
      | 'openExactAlarmSettings'
      | 'openBatteryOptimizationSettings'
      | 'openAutoStartSettings',
  ) => Promise<void>

  addLog: (entry: Omit<LogEntry, 'id' | 'at'>) => void
  saveAccount: (account: MailAccount, secret?: string) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  /**
   * `queue: false` opts out of the offline queue — used by the queue's own retry.
   * `jobId`, when this send is a scheduled reminder firing, names it — carried
   * onto the log line and, if the send has to be queued, onto the outbox item,
   * which is what lets the working calendar answer "did that one arrive".
   */
  sendDraftNow: (draft: MessageDraft, opts?: { queue?: boolean; jobId?: string }) => Promise<SendResult>
  scheduleDraft: (job: ScheduledJob) => Promise<void>
  toggleJob: (id: string, enabled: boolean) => Promise<void>
  deleteJob: (id: string) => Promise<void>
  runJobNow: (id: string) => Promise<SendResult | null>
  resetEverything: () => Promise<void>
  /** Repair stored attachment paths after the data folder has been moved. */
  relocateData: (change: DataFolderChange, previousPath: string) => Promise<void>

  /** Save IMAP config (and optionally a new password), then sync if enabled. */
  saveInboxAccount: (config: InboxAccountState, secret?: string) => Promise<void>

  /**
   * Connect and refresh one account's inbox. Records the error in state rather
   * than throwing, so a bad password shows up as a banner, not a crash.
   *
   * `override` exists because a caller that has *just* produced a new config
   * cannot rely on reading it back out of state — see the comment on the
   * implementation.
   */
  syncInboxAccount: (
    accountId: string,
    override?: InboxAccountState,
  ) => Promise<SyncOutcome | undefined>
  /** Probe the IMAP endpoint without saving anything. */
  testInboxAccount: (config: InboxAccountState, secret?: string) => Promise<SendResult>
  /** Fetches and caches a body on demand — Phase 1's sync only prefetches the most recent few messages. */
  getInboxMessageBody: (message: InboxMessage) => Promise<InboxMessageBody>
  /**
   * The same attachment, guaranteed to have a local path.
   *
   * Returns it unchanged where the platform already downloads attachments
   * with the body (the desktop), so callers never have to ask which platform
   * they are on — they ask for a usable attachment and get one.
   */
  ensureInboxAttachment: (message: InboxMessage, attachment: Attachment) => Promise<Attachment>
  markInboxMessagesRead: (accountId: string, ids: string[], seen: boolean) => Promise<void>
  /** Local-only — see `InboxTag`, never touches the server. */
  tagInboxMessages: (accountId: string, ids: string[], tag: InboxTag) => void
  /** Remove from this app only. Reversible from the recycle bin; mailbox untouched. */
  deleteInboxMessages: (accountId: string, ids: string[]) => Promise<void>
  /** Delete on the server. Not reversible, and it reports failure instead of pretending. */
  purgeInboxMessages: (accountId: string, ids: string[]) => Promise<{ ok: boolean; error?: string }>
  restoreInboxMessages: (accountId: string, keys: string[]) => void
  clearRemovedMessages: (accountId?: string) => void

  /** Record the current draft in the history strip. */
  snapshotDraft: (reason?: SnapshotReason) => void
  /** Put a past version of the draft back on screen. */
  restoreSnapshot: (id: string) => void
  /** Park a draft in the outbox without attempting to send it. */
  queueDraft: (draft: MessageDraft) => void
  /** Try every queued send whose backoff has elapsed. Safe to call at any time. */
  flushOutbox: () => Promise<void>

  /**
   * Record how to put something back, before taking it away.
   *
   * Stored as the *inverse actions*, not as a copy of the whole state: undoing
   * a deleted contact should not also roll back the four unrelated things that
   * happened while the toast was on screen.
   */
  pushUndo: (label: string, actions: Action[]) => void
  /** Apply the most recent inverse. Returns its label, or null if there is none. */
  undo: () => string | null
  /** What the next undo would put back, for the menu item and the toast. */
  undoLabel: string | null

  /**
   * "This device will be asked to re-pair next time it tries to sync" — see
   * `devices.revokeConfirm`. Deletes the record and its keystore entry; the
   * other device's next `SyncLoop` cycle simply fails to decrypt, which is
   * the whole mechanism, not a special case of it.
   */
  revokePairedDevice: (id: string) => Promise<void>
  /** "Keep mine instead" on one flagged sync conflict. See `core/syncConflict.ts`. */
  restoreSyncConflict: (id: string) => void
  /**
   * How the LAN sync listener actually got on, or `null` where nothing has
   * asked for one — no 'ongoing' pairing, or a platform that cannot host.
   * `DevicesCard` is where a bind that failed gets explained.
   */
  syncListener: SyncListenerStatus | null
}

const AppContext = createContext<AppApi | null>(null)

export function useApp(): AppApi {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  /**
   * The current state, readable from callbacks that must not be re-created
   * when it changes. Timers and long-lived subscriptions depend on those
   * callbacks; rebuilding one mid-flight cancels the very retry it was running.
   */
  const liveRef = useRef(state)
  liveRef.current = state
  const [bridge, setBridge] = useState<PlatformBridge | null>(null)
  const [ready, setReady] = useState(false)
  const [schedulerUnreachable, setSchedulerUnreachable] = useState(false)
  /**
   * The document could not be written, and the retry could not either.
   *
   * Surfaced rather than logged because of what it means: everything the user
   * has done this session is on screen and none of it is on disk. An
   * unwritable data folder produced exactly this and said nothing — the app
   * fell back to the default folder at startup, every later write threw, and
   * the only trace was a line in a console with no window.
   */
  const [saveFailing, setSaveFailing] = useState(false)
  const [bootError, setBootError] = useState<AppApi['bootError']>(null)
  /**
   * Jobs that boot could not rebuild and therefore disabled.
   *
   * Separate from `bootError` on purpose: that one replaces the entire window
   * with a failure screen, which is right for "the document is unreadable" and
   * badly wrong for "one of your forty reminders is damaged". This is the
   * quieter channel — the app opens normally and `health.ts` reports what it
   * had to switch off, so the failure is visible without being fatal.
   */
  const [repairedJobs, setRepairedJobs] = useState<string[]>([])
  const hydrated = useRef(false)

  /**
   * The language actually on screen.
   *
   * `settings.locale` records the *preference*, which may be `'system'`; every
   * consumer wants the resolved value, so the resolution happens once, here.
   */
  const locale = useMemo(
    () => (state.settings.locale === 'system' ? detectLocale() : state.settings.locale),
    [state.settings.locale],
  )
  /**
   * Every locale but English is its own chunk (see `src/i18n/index.ts`), so
   * this one starts fetching it and flips from `false` to `true` once it
   * lands. Until then `createI18n` below already reads whichever table is in
   * memory — English — so the screen never shows a blank or a raw key, just
   * the fallback language for what is normally a frame or two.
   *
   * `localeReady` has to sit in the `i18n` memo's own dependency array, not
   * just be called for its re-render side effect: several screens read
   * `useI18n()` through a memoized component, and a memoized consumer only
   * re-renders on a Context value it can tell changed. Recomputing `i18n`
   * with a new object identity once the table lands is what actually reaches
   * those; re-rendering `AppState` alone left every memoized child showing
   * English forever, because the `I18nContext.Provider` value it received
   * was — by reference — the exact same object as before.
   */
  const localeReady = useLocaleReady(locale)
  const i18n = useMemo(() => createI18n(locale), [locale, localeReady])
  /**
   * The translator, reachable from long-lived subscriptions — same mechanism
   * and same reason as `liveRef` above.
   *
   * The platform's job-event subscription writes translated activity rows.
   * Naming `i18n` in that effect's dependencies would tear the subscription
   * down and build it back up every time the language changed, and whichever
   * send reported itself in the gap would go unrecorded. A ref keeps one
   * subscription for the life of the window and still reads the current
   * language.
   */
  const i18nRef = useRef(i18n)
  i18nRef.current = i18n

  /**
   * Keep the tray menu in the same language as the window.
   *
   * The main process builds the tray before any window exists, so it starts
   * from the OS locale on its own; this is what makes an explicit in-app choice
   * reach it afterwards.
   */
  useEffect(() => {
    void bridge?.setUiLocale?.(locale)
  }, [bridge, locale])

  /**
   * Push the two switches whose effect is outside the window.
   *
   * Both were dead controls until now: the settings screen wrote them into
   * state, nothing in the main process ever read them, and closing the window
   * went to the tray regardless of what the user had chosen. Deliberately
   * depends on the two booleans rather than on `state.settings`, which changes
   * on almost every keystroke somewhere in the app.
   */
  const {
    minimiseToTray,
    launchAtLogin,
    notifyOnSuccess,
    notifyOnFailure,
    keepReceivingWhenClosed,
    toggleShortcut,
  } = state.settings
  useEffect(() => {
    void bridge?.setDesktopPrefs?.({
      minimiseToTray,
      launchAtLogin,
      // The same story as the two above, found later. `notifyOnSuccess` was
      // read only by the compose screen's own send button, and
      // `notifyOnFailure` was read by nothing anywhere — so a *scheduled*
      // send, which is what this application exists to do, notified on
      // failure whatever the switch said and never notified on success at all.
      // The scheduler lives in the main process, so this is the only route
      // those two settings have to it.
      notifyOnSuccess,
      notifyOnFailure,
      // `=== true` rather than `!== false`, unlike its neighbours: the default
      // for this one is off, so an older saved document with the field absent
      // must stay off rather than quietly acquiring a scheduled task.
      keepReceivingWhenClosed: keepReceivingWhenClosed === true,
      // `undefined` means "this document predates the field", and the main
      // process turns that into the built-in default rather than into "off".
      // Passing `null` here would be the user saying no; the two are not the
      // same answer and must not collapse into one on the way out.
      toggleShortcut,
    })
    /*
     * Every value this effect sends is in the dependency list, and that is a
     * fix rather than housekeeping.
     *
     * `keepReceivingWhenClosed` was read above and left out of the list below,
     * so React never re-ran this when it changed: turning "keep receiving after
     * I quit" on pushed nothing to the main process and registered no scheduled
     * task. It appeared to work only because the effect also runs on mount —
     * so the switch took effect at the *next launch*, and flipping it and
     * watching for something to happen showed nothing at all. A second,
     * completely independent reason that feature did not work, found while
     * adding the shortcut beside it.
     */
  }, [
    bridge,
    minimiseToTray,
    launchAtLogin,
    notifyOnSuccess,
    notifyOnFailure,
    keepReceivingWhenClosed,
    toggleShortcut,
  ])

  // --- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    void (async () => {
      // Boot has to report its own failures. `ready` gates the whole UI, so a
      // throw anywhere below used to leave the app sitting on its loading
      // skeleton indefinitely — no error, no content, nothing to act on, and
      // nothing in the window to suggest it was not simply still loading.
      let b: PlatformBridge
      try {
        b = await getBridge()
      } catch (err) {
        if (!cancelled) {
          setBootError({
            key: err instanceof DesktopBridgeMissingError ? 'boot.failedBridge' : 'boot.failedGeneric',
            detail: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }
      if (cancelled) return
      setBridge(b)

      let stored: Awaited<ReturnType<PlatformBridge['loadState']>>
      try {
        stored = await b.loadState()
      } catch (err) {
        if (!cancelled) {
          setBootError({
            key: 'boot.failedRead',
            detail: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }
      if (cancelled) return

      // The rest of boot is guarded as one unit. The comment above is only
      // half-true without this: `getBridge` and `loadState` were wrapped, but
      // the migration *below* them was not, and that is where the throws
      // actually come from — it is the only part of boot that reads the shape
      // of individual stored records rather than the document as a whole.
      //
      // Reproduced: one job whose `recurrence` is missing (a record merged in
      // from a paired device on a different build, or restored from an older
      // backup) threw inside `migrateSkipWeekends`, `setReady(true)` never
      // ran, and every screen in the app stayed on its loading skeleton
      // forever — navigation still worked, nothing reported an error, and the
      // user's accounts, jobs and mail all appeared to be gone. Silently
      // showing someone an empty app that still has all their data on disk is
      // the worst outcome available here, and it was reachable from a single
      // malformed field.
      try {
        if (stored) {
        const merged: AppState = {
          ...initialState(),
          ...stored,
          settings: {
            ...DEFAULT_SETTINGS,
            ...(stored.settings ?? {}),
            // An install from before this field existed reads as `undefined`
            // here — mint it once, now, rather than leaving executor
            // assignment permanently unavailable for whichever device
            // happens to still be running an old state.json.
            localDeviceId: stored.settings?.localDeviceId ?? newId('device'),
          },
          draft: { ...emptyDraft(), ...(stored.draft ?? {}) },
          draftSnapshots: stored.draftSnapshots ?? [],
          outbox: stored.outbox ?? [],
          codeHits: stored.codeHits ?? [],
          recentRecipients: stored.recentRecipients ?? [],
          pairedDevices: stored.pairedDevices ?? [],
          syncConflicts: stored.syncConflicts ?? [],
          deletedJobs: stored.deletedJobs ?? [],
          schemaVersion: SCHEMA_VERSION,
        }

        // Re-derive occurrence lists on every boot. Timestamps computed weeks
        // ago may be stale after a timezone change, a DST shift, or the device
        // simply being off past several fire times — and the holiday calendar
        // may have gained dates since they were last computed.
        //
        // Also where the legacy `skipWeekends` flag is retired. It runs on
        // every boot and is idempotent by construction (it clears the flag it
        // reads), so the migration needs no version marker and cannot half-run.
        //
        // `rawOccurrences` is dropped rather than carried over for the same
        // reason the occurrence list itself is re-derived: a timezone change
        // can leave a cached raw timestamp numerically in the future while
        // meaning the wrong wall-clock time, and `reshapeJob`'s cache check
        // has no way to tell that apart from a cache that is still good. One
        // full rebuild the first time a calendar or quiet-hours edit lands in
        // a new session re-establishes it; every edit after that is cheap
        // again. See `reshapeJob`.
        const calendar = merged.settings.workCalendar ?? DEFAULT_WORK_CALENDAR

        // Rebuilt one record at a time, because the blast radius of a bad one
        // has to *be* one record. A single `.map` that throws loses all of
        // them plus every other screen in the app; the same throw contained
        // here costs the user one job that stops re-arming and says so.
        //
        // A job that cannot be rebuilt is disabled rather than dropped. It is
        // the only honest option: the record is damaged, so it cannot be
        // trusted to fire at the right time, but deleting someone's reminder
        // because this build could not parse it would destroy the very thing
        // they are here to keep. Disabled, it survives to be looked at, and
        // `health.ts` has something to report.
        const damaged: string[] = []
        merged.jobs = (Array.isArray(merged.jobs) ? merged.jobs : []).map((job) => {
          try {
            const recurrence = migrateSkipWeekends(job.recurrence)
            if (!job.enabled) {
              if (recurrence === job.recurrence && job.rawOccurrences === undefined) return job
              return { ...job, recurrence, rawOccurrences: undefined, rawOccurrencesRunCount: undefined }
            }
            const { dueNow, upcoming } = rearm(recurrence, job.occurrences ?? [], {
              runsSoFar: job.runCount,
              calendar,
            })
            const shaped = shapeOccurrences(
              upcoming,
              { recurrence },
              merged.settings,
              Date.now(),
              windowsForDraft(job.draft.to, merged.contacts),
            )
            return {
              ...job,
              recurrence,
              /*
               * `dueNow` first, unshaped.
               *
               * This is the whole of the catch-up promise. `rearm` collapses
               * everything missed while the machine was off into at most one
               * instant — and both call sites, here and `electron/scheduler`,
               * destructured only `upcoming` and let it fall on the floor. The
               * default policy is `fireOnce`; what it actually did was nothing,
               * for every reminder, on every launch after a night with the
               * laptop shut. Nothing failed: the row simply showed its next
               * future run, as if the missed one had never been due.
               *
               * Kept out of `shapeOccurrences` on purpose. Quiet hours, the
               * delivery window and the working calendar all decide *when to
               * place* a send in the future; an instant that is already past
               * is not being placed, it is being paid. The desktop scheduler's
               * `tick()` already knows how to fire a past occurrence exactly
               * once — putting it back in the list is all it ever needed.
               */
              occurrences: [...dueNow, ...shaped.occurrences],
              calendarWarning: shaped.warning,
              rawOccurrences: undefined,
              rawOccurrencesRunCount: undefined,
            }
          } catch (err) {
            damaged.push(job?.id ?? '(no id)')
            console.error('[boot] job could not be rebuilt, disabling it:', job?.id, err)
            // Quarantined, but *structurally complete*. Handing the rest of the
            // app a job whose `recurrence` is still missing only moves the
            // throw downstream: the schedule list reads `.timeOfDay` off it,
            // the working-calendar screen reads `.workdayPolicy`, and each one
            // fails in turn. One valid placeholder here is what keeps a single
            // damaged record from being three broken screens.
            //
            // Disabled and with no occurrences, so the placeholder can never
            // cause a send — it exists to be displayed and edited, not to run.
            return {
              ...job,
              enabled: false,
              occurrences: [],
              recurrence: {
                ...defaultRecurrence(),
                ...(job?.recurrence ?? {}),
              },
            }
          }
        })
        if (damaged.length) setRepairedJobs(damaged)

        // Anything left mid-flight by a crash or a quit is waiting again, not
        // sending. Without this an item stuck in `sending` is never retried and
        // never reported — the queue's own silent failure.
        merged.outbox = (Array.isArray(merged.outbox) ? merged.outbox : []).map((i) =>
          i.status === 'sending' ? { ...i, status: 'waiting' as const } : i,
        )

        // A phantom inbox account, swept before anything downstream can see it.
        //
        // `syncInboxAccount` captures its config in a closure and then awaits an
        // IMAP round trip that can run up to 20 seconds; `deleteAccount` does not
        // wait for that to finish, because nothing should have to. Before the
        // dispatch-site and reducer guards next to `upsertInboxAccount` existed, a
        // reply landing after the account was gone resurrected an `inboxAccounts`
        // row for an id `state.accounts` no longer held, and the debounced
        // whole-state save wrote it to disk. Those guards stop a *new* one from
        // being created; they do nothing for someone who already has one sitting
        // in a file from before this build. This is the one path all state
        // travels on the way in, so it is where that existing row gets cleaned —
        // once, here, rather than everyone who ever reads `inboxAccounts` having
        // to remember to check `accounts` first. `InboxView`'s account label and
        // filter tabs would otherwise be the only place the phantom ever surfaced,
        // as the raw `acct_...` id nobody recognises.
        const accountIds = new Set(
          (Array.isArray(merged.accounts) ? merged.accounts : []).map((a) => a.id),
        )
        merged.inboxAccounts = (Array.isArray(merged.inboxAccounts) ? merged.inboxAccounts : []).filter(
          (i) => accountIds.has(i.accountId),
        )

        dispatch({ type: 'hydrate', state: merged })
        }
      } catch (err) {
        // Last resort. Everything above is already guarded per record, so
        // reaching here means the document itself is unusable rather than one
        // row in it — and an explicit failure the user can read and report
        // beats the indefinite skeleton this replaced.
        if (!cancelled) {
          setBootError({
            key: 'boot.failedPrepare',
            detail: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      hydrated.current = true
      setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // --- persistence (debounced, and adaptively so) -------------------------
  //
  // Every write serialises the whole document and sends it across the IPC
  // boundary. That is the right shape — a partial write that crashed halfway
  // would leave accounts and jobs disagreeing about which account exists — but
  // the document carries up to a thousand cached message rows, and typing one
  // sentence into the compose box used to trigger a dozen full round trips of
  // it.
  //
  // So the interval depends on what changed. A draft edit is worth persisting
  // (it survives a restart) but it is not worth persisting *now*: nothing else
  // reads it, and the next keystroke is 200 ms away. Anything else — a saved
  // account, a scheduled job, a synced mailbox — keeps the original latency,
  // because those are what the main process and the platform scheduler read
  // back.

  const DRAFT_ONLY_DELAY = 1_500
  const NORMAL_DELAY = 350
  const SAVE_RETRY_DELAY = 3_000
  const lastSaved = useRef<AppState | null>(null)
  /** Identifies the most recent save, so a slow earlier one cannot claim it. */
  const saveToken = useRef(0)

  useEffect(() => {
    if (!bridge || !hydrated.current) return

    const previous = lastSaved.current
    const draftOnly =
      previous !== null &&
      previous.draft !== state.draft &&
      previous.accounts === state.accounts &&
      previous.jobs === state.jobs &&
      previous.contacts === state.contacts &&
      previous.templates === state.templates &&
      previous.logs === state.logs &&
      previous.settings === state.settings &&
      previous.inboxAccounts === state.inboxAccounts &&
      previous.outbox === state.outbox &&
      previous.draftSnapshots === state.draftSnapshots &&
      previous.codeHits === state.codeHits &&
      previous.recentRecipients === state.recentRecipients

    const timer = window.setTimeout(
      () => {
        // Record the save only once it has actually happened. Marking it before
        // awaiting looked harmless — "the next change retries" — but it is only
        // true when a next change comes. Stop typing right after a failed write
        // and the work is gone at restart, with nothing on screen having
        // suggested anything went wrong. Worse, `lastSaved` claiming success
        // made the pagehide flush below skip the very write that had failed.
        const attempt = ++saveToken.current
        void bridge
          .saveState(state)
          .then(() => {
            // A newer save may have been issued while this one was in flight;
            // letting a stale success win would mark newer edits as persisted.
            if (attempt === saveToken.current) {
              lastSaved.current = state
              setSaveFailing(false)
            }
          })
          .catch((err) => {
            console.error('[aevistle] could not save state:', err)
            // Leave `lastSaved` alone so any later change — or the flush on the
            // way out — tries again, and retry once unprompted in case there is
            // no later change to ride along with.
            window.setTimeout(() => {
              if (attempt !== saveToken.current) return
              void bridge
                .saveState(state)
                .then(() => {
                  if (attempt === saveToken.current) {
                    lastSaved.current = state
                    setSaveFailing(false)
                  }
                })
                // Two failures in a row is not a blip. Say so on the health
                // strip; the console is not somewhere anyone is looking.
                .catch(() => setSaveFailing(true))
            }, SAVE_RETRY_DELAY)
          })
      },
      draftOnly ? DRAFT_ONLY_DELAY : NORMAL_DELAY,
    )
    return () => window.clearTimeout(timer)
  }, [state, bridge])

  /**
   * Flush whatever the debounce is still holding when the window goes away.
   *
   * Without this the longer draft interval would be paid for with lost work:
   * closing the app 900 ms after the last keystroke would discard it. `pagehide`
   * rather than `beforeunload` because the latter is unreliable on mobile
   * WebViews, and `visibilitychange` covers the Android case where the process
   * is backgrounded and may never be told it is closing.
   */
  useEffect(() => {
    if (!bridge) return
    const flush = () => {
      if (!hydrated.current || lastSaved.current === liveRef.current) return
      const pending = liveRef.current
      const attempt = ++saveToken.current
      void bridge
        .saveState(pending)
        .then(() => {
          if (attempt === saveToken.current) {
            lastSaved.current = pending
            setSaveFailing(false)
          }
        })
        // Same reasoning as the debounced save: only a write that landed counts
        // as saved. On `visibilitychange` the app is backgrounded rather than
        // closing, so a flush that failed here must stay retryable — claiming
        // success would make every later flush skip it.
        .catch((err) => {
          console.error('[aevistle] could not flush state:', err)
          setSaveFailing(true)
        })
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [bridge])

  // --- keep the platform scheduler in step -------------------------------
  const jobSignature = useMemo(
    () =>
      JSON.stringify(
        state.jobs.map((j) => [j.id, j.enabled, j.updatedAt, j.occurrences[0] ?? 0]),
      ),
    [state.jobs],
  )
  const accountSignature = useMemo(
    () => JSON.stringify(state.accounts.map((a) => [a.id, a.updatedAt])),
    [state.accounts],
  )
  /**
   * Does any armed job actually ask about replies?
   *
   * Only then does newly-arrived mail change what the scheduler would decide,
   * and only then is it worth re-arming for. Everyone else pays nothing for
   * this — which matters because re-arming on Android rewrites the job store
   * and every alarm on the device, and mail arrives far more often than a
   * schedule changes.
   */
  const watchesReplies = useMemo(
    () => state.jobs.some((j) => j.enabled && j.conditions?.some((c) => c.kind === 'noReplySince')),
    [state.jobs],
  )
  /**
   * Enough of the mailbox to notice a reply landing.
   *
   * Not the messages themselves: this only has to change when the answer to
   * "has anyone written since" might have changed, and a sync that brought
   * nothing new must not re-arm anything. Constant when no job asks, so the
   * effect below does not re-run at all in that case.
   */
  const replyWatchSignature = useMemo(
    () =>
      watchesReplies
        ? JSON.stringify(
            state.inboxAccounts.map((i) => [i.accountId, i.enabled, i.lastSyncAt ?? 0, i.messages.length]),
          )
        : '',
    [watchesReplies, state.inboxAccounts],
  )

  useEffect(() => {
    if (!bridge || !ready) return
    let cancelled = false
    /**
     * Arm the platform scheduler, and say so when that fails.
     *
     * This used to swallow the error. Everything downstream then agreed the
     * schedule was live — the job list, the "next send" time, the tray tooltip
     * — while no alarm existed on the device at all. On Android that is the
     * ordinary outcome of exact-alarm permission being refused, so the failure
     * mode was not exotic. One retry covers a transient IPC hiccup; past that
     * the health strip says it out loud.
     */
    const arm = async (attemptsLeft: number): Promise<void> => {
      try {
        await bridge.syncJobs(
          /*
           * Rendered on the way out, not in storage.
           *
           * The platform scheduler keeps its own copy of every job and fires it
           * with no UI attached — on Android, from a Java worker that has no
           * Markdown renderer and never will. Converting here means the stored
           * job already carries HTML by the time anything native reads it,
           * while application state keeps the Markdown the user typed.
           */
          state.jobs
            .filter((j) => j.enabled)
            // The digest's body is composed here, at the same moment and for
            // the same reason the Markdown is rendered: this is the last point
            // that still has the schedule, the calendar and a language.
            .map((j) => (j.id === DIGEST_JOB_ID ? withDigestBody(j, liveRef.current, i18n) : j))
            .map((j) => ({ ...j, draft: forTransport(j.draft) })),
          state.accounts,
          // What a scheduler with no UI attached cannot ask for itself: the two
          // notification switches, which Android's worker read off the job
          // before — a field jobs do not have — and the inbox index, which is
          // the only way `noReplySince` means anything away from this process.
          // See `syncJobs` in `core/bridge.ts`.
          {
            notifyOnSuccess: liveRef.current.settings.notifyOnSuccess,
            notifyOnFailure: liveRef.current.settings.notifyOnFailure,
            inboxKnown: liveRef.current.inboxAccounts.some(
              (i) => i.enabled && i.lastSyncAt !== undefined,
            ),
            latestInbound: latestInboundIndex(liveRef.current.inboxAccounts),
            localDeviceId: liveRef.current.settings.localDeviceId,
          },
        )
        if (!cancelled) setSchedulerUnreachable(false)
      } catch (err) {
        if (cancelled) return
        if (attemptsLeft > 0) {
          window.setTimeout(() => void arm(attemptsLeft - 1), 2_000)
          return
        }
        console.error('[aevistle] could not arm the scheduler:', err)
        setSchedulerUnreachable(true)
      }
    }
    void arm(1)
    return () => {
      cancelled = true
    }
    // Signatures, not the arrays themselves — otherwise every keystroke in a
    // draft would re-arm every alarm on the device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, ready, jobSignature, accountSignature, replyWatchSignature, i18n])

  /**
   * Keep the digest reminder in step with its switch.
   *
   * This is bookkeeping, not scheduling — it writes one job and stops. What
   * makes the digest arrive is the same machinery that makes every other
   * reminder arrive, which is the point: adding a second timer here would give
   * the app two answers to "when does something happen", and the one thing the
   * shared recurrence engine exists to guarantee is that there is only one.
   *
   * Depends on the settings and on the account list, never on `state.jobs` —
   * a dependency on the jobs it writes is a loop. `sameDigestJob` makes the
   * repeat dispatches from an account edit into no-ops.
   */
  const { digestEnabled, digestTime, digestAccountId, digestTo } = state.settings
  useEffect(() => {
    if (!ready) return
    const live = liveRef.current
    const existing = live.jobs.find((j) => j.id === DIGEST_JOB_ID)

    if (!digestEnabled) {
      if (existing) dispatch({ type: 'removeJob', id: DIGEST_JOB_ID })
      return
    }

    const accountId = digestAccountId || live.settings.defaultAccountId || live.accounts[0]?.id
    const account = live.accounts.find((a) => a.id === accountId)
    // No account means no digest, and the settings card says so out loud rather
    // than leaving a switch that reads as on and does nothing.
    if (!account) return
    const to = (digestTo || account.fromAddress).trim()
    if (!to) return

    const wanted = digestJobFor(
      existing,
      { accountId: account.id, to, time: digestTime, name: i18n.t('digest.jobName') },
      live.settings,
    )
    if (existing && sameDigestJob(existing, wanted)) return
    dispatch({ type: 'upsertJob', job: wanted })
    // `liveRef` supplies the jobs; listing them would make this effect rewrite
    // the job it had just written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, digestEnabled, digestTime, digestAccountId, digestTo, accountSignature, i18n])

  // --- theme, style, accent, density, direction --------------------------
  useEffect(() => {
    const root = document.documentElement
    const {
      themeMode,
      visualStyle,
      accent,
      accentBase,
      accentCyber,
      themeIntensity,
      density,
      listDensity,
      textScale,
      oneHand,
    } = state.settings
    if (themeMode === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', themeMode)
    root.setAttribute('data-style', visualStyle ?? 'aurora')
    root.setAttribute('data-accent', accent)
    // runecircuit's own two-axis accent (A10) — set unconditionally, same as
    // `data-accent` above; theme.css's selectors are what actually gate these
    // to `[data-style="runecircuit"]`, so setting them for every other style
    // too is inert rather than wrong.
    root.setAttribute('data-accent-base', accentBase ?? 'ink')
    root.setAttribute('data-accent-cyber', accentCyber ?? 'cyan')
    // The ceremonial-layer dial (A8). A *global* CSS var — see the comment
    // beside `--intensity`'s declaration in theme.css for why that is safe —
    // and an inline style property, which always outranks a stylesheet rule
    // regardless of which style block last touched `:root`.
    const intensity = themeIntensity ?? 60
    root.style.setProperty('--intensity', String(intensity / 100))
    root.setAttribute('data-atmosphere-motion', intensity >= ATMOSPHERE_MOTION_MIN ? 'on' : 'off')
    root.setAttribute('data-density', density)
    root.setAttribute('data-list-density', listDensity ?? 'standard')
    // Read by a root `font-size` rule in theme.css, which the whole rem-based
    // type and spacing scale then follows. Set on `:root` and not on `body`
    // for exactly that reason: `rem` resolves against the root element.
    root.setAttribute('data-text-scale', textScale ?? 'standard')
    // Paired with `data-shell` in the stylesheet — see `20-short.css`. Written
    // unconditionally here, as `data-accent-*` above are, because the selector
    // is what gates it and a desktop window simply never matches.
    root.setAttribute('data-reach', oneHand ? 'on' : 'off')
    const localeInfo = localeMeta(locale)
    root.setAttribute('lang', localeInfo.intlTag)
    root.setAttribute('dir', localeInfo.dir)
    // The window chrome follows the page. index.html ships two static
    // `theme-color` tags as the pre-JS fallback, and they are copies of one
    // theme's `--bg` — with six styles they are right in one case out of six,
    // so the live value is read back off the element that was just relabelled
    // and put in a tag ahead of them (the browser takes the first that matches).
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
    if (bg) {
      const head = document.head
      let tag = head.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-live]')
      if (!tag) {
        tag = document.createElement('meta')
        tag.setAttribute('name', 'theme-color')
        tag.setAttribute('data-live', '')
        head.insertBefore(tag, head.querySelector('meta[name="theme-color"]'))
      }
      tag.setAttribute('content', bg)

      // Android's status bar is the same "window chrome the page cannot
      // reach" as the meta tag just above, so it is kept in step off the
      // same live value. `bridge` is undefined until boot resolves and the
      // method is undefined on every platform but Android — both are no-ops
      // through the optional chain, not a branch to maintain here.
      const dark =
        themeMode === 'dark' ||
        (themeMode === 'system' &&
          window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
      void bridge?.syncStatusBar?.({ dark, background: bg })
    }
  }, [state.settings, locale, bridge])

  // --- events from the platform scheduler --------------------------------
  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'at'>) => {
    dispatch({ type: 'log', entry: { ...entry, id: newId('log'), at: Date.now() } })
  }, [])

  useEffect(() => {
    if (!bridge) return
    return bridge.onJobEvent((event: JobEvent) => {
      // The status/run counters first, then the log line. This used to be the
      // log line and nothing else, which is why a schedule that had genuinely
      // sent still read "waiting to send" — the send result reached the
      // activity list and never reached the job.
      if (event.run) dispatch({ type: 'jobRan', jobId: event.jobId, run: event.run })
      /*
       * The subject and the message id, the same two the manual-send path
       * has always written.
       *
       * Without them, bounce and read-receipt tracking was dead for every
       * scheduled send — which is to say for the app's primary feature.
       * `receipts.sendsFromLogs` reads `subject: l.title`, so it was handed
       * the literal string 'Scheduled send completed' for every send ever
       * made, with `messageId: undefined`; `reportMatches` then needed a
       * bounce whose subject contained "scheduledsendcompleted" to match
       * anything. It never did. The Logs screen reported "0 bounced" for a
       * mailbox full of bounces, and no read receipt was ever attributed.
       */
      const t = i18nRef.current.t
      const subject =
        liveRef.current.jobs.find((j) => j.id === event.jobId)?.draft.subject ||
        t('inbox.noSubject')
      /*
       * A skip is not a failure, and it is the only outcome that has to explain
       * itself.
       *
       * `result.ok` is false for a skip, so branching on it alone put "a
       * condition said no" through the failure arm: a red row reading
       * "Scheduled send failed", with an empty detail — because a skip carries
       * `skipReasonKey`, never `error`. The reason, which is the single thing
       * the user needs, was thrown away. `runNow` in ScheduleView already
       * reports the same event correctly; this is the path that matters more,
       * because it is the one that runs when nobody is watching.
       *
       * `kind: 'schedule'` rather than `'send'` on purpose: nothing was sent,
       * and `receipts.sendsFromLogs` reads send-kind rows as deliveries to
       * correlate bounces against. Filing a skip as a send would have it
       * hunting for a bounce to a message that was never written.
       */
      if (event.result.skipped) {
        addLog({
          kind: 'schedule',
          level: 'warn',
          title: `${t('toast.skipped')} — ${subject}`,
          detail: event.result.skipReasonKey
            ? t(event.result.skipReasonKey as TranslationKey, event.result.skipReasonValues)
            : undefined,
          jobId: event.jobId,
        })
        return
      }
      addLog({
        kind: 'send',
        level: event.result.ok ? 'info' : 'error',
        title: event.result.ok ? subject : `${t('toast.sendFailed')} — ${subject}`,
        detail: event.result.error,
        jobId: event.jobId,
        recipients: event.result.accepted.length,
        durationMs: event.result.durationMs,
        messageId: event.result.messageId,
      })
    })
  }, [bridge, addLog])

  /**
   * Catch up on sends that happened while there was no UI to tell.
   *
   * On Android an alarm fires into a worker with the WebView long gone, so the
   * live event above reaches nobody; the native side queues the report instead.
   * Drained on open and again whenever the app comes back to the foreground —
   * the second one matters because an app left running in the background for a
   * week never re-mounts.
   */
  useEffect(() => {
    if (!bridge?.pullJobRuns || !ready) return
    const pull = bridge.pullJobRuns.bind(bridge)
    let cancelled = false

    const drain = async () => {
      try {
        const runs = await pull()
        if (cancelled) return
        const t = i18nRef.current.t
        for (const { jobId, ...run } of runs) {
          dispatch({ type: 'jobRan', jobId, run })
          /*
           * A skip that happened with nobody watching still has to be
           * accounted for.
           *
           * This loop only ever moved the row, so on Android — where the alarm
           * fires into a worker hours after the app was last open, which is the
           * ordinary case rather than the exception — a reminder held back by a
           * condition produced no activity line whatsoever. The next-send time
           * advanced and nothing said why the send had not happened. The live
           * desktop path reports the same outcome through `onJobEvent` above;
           * these are the runs that never reach it.
           */
          if (run.skipReasonKey) {
            const name = liveRef.current.jobs.find((j) => j.id === jobId)?.draft.subject
            addLog({
              kind: 'schedule',
              level: 'warn',
              title: `${t('toast.skipped')} — ${name || t('inbox.noSubject')}`,
              detail: t(run.skipReasonKey as TranslationKey, run.skipReasonValues),
              jobId,
            })
          }
        }
      } catch (err) {
        // A failure here costs a stale row, not a lost send — the mail already
        // went out and the queue is only cleared once we have the data.
        console.error('[aevistle] could not read missed runs:', err)
      }
    }

    void drain()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void drain()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [bridge, ready, addLog])

  // --- undo -----------------------------------------------------------------
  // See `hooks/useUndo.ts` — moved out unchanged.
  const { undoStack, pushUndo, undo } = useUndo<Action>(dispatch)

  // --- actions ------------------------------------------------------------
  // Mail-account effects — see `hooks/useAccountActions.ts`, moved out
  // unchanged.
  const { saveAccount, deleteAccount } = useAccountActions(bridge, addLog, dispatch)

  // Paired-device effects — see `hooks/usePairingActions.ts`, moved out
  // unchanged.
  const { revokePairedDevice, restoreSyncConflict } = usePairingActions(bridge, addLog, dispatch)

  /**
   * Send one draft.
   *
   * Two things happen here that the transport deliberately knows nothing
   * about: a mail merge is expanded into one message per recipient (so the
   * mailer keeps seeing ordinary drafts), and a failure that a retry could fix
   * is handed to the offline queue instead of being lost.
   *
   * `contacts` and `settings` are read through a ref rather than closed over,
   * so this callback keeps a stable identity — it is a dependency of the
   * outbox timer, and re-creating it on every contact edit would restart that
   * timer mid-retry.
   */
  const sendDraftNow = useCallback(
    async (draft: MessageDraft, opts: { queue?: boolean; jobId?: string } = {}): Promise<SendResult> => {
      const live = liveRef.current
      const account = live.accounts.find((a) => a.id === draft.accountId)
      if (!bridge || !account) {
        return {
          ok: false,
          accepted: [],
          rejected: [],
          durationMs: 0,
          error: 'No account selected',
          errorKind: 'config',
        }
      }

      const merge = draft.mergeEnabled === true && draft.to.length > 0
      const parts = merge
        ? buildMergeMessages(draft, live.contacts, {
            enabled: true,
            locale,
            // So `{{nextWorkday}}` and friends answer from the same calendar
            // that decided when this is being sent. Without it the calendar
            // can move a reminder to Monday while its text still says
            // "tomorrow".
            calendar: live.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
            // Was `statutoryNames()` alone, which named Chinese dates and
            // nothing else — so `{{holiday}}` in a greeting to a French or
            // Spanish contact rendered as an empty string and "Happy " went out
            // the door. The Chinese tables still win every date they cover; the
            // presets only fill the gaps. See `core/greetings.holidayNameMap`.
            holidayNames: holidayNameMap({
              years: greetingYears(),
              prefer: live.settings.greetingCountry,
            }),
          })
        : [{ address: '', draft, missing: [] }]

      let result: SendResult
      if (parts.length === 1) {
        result = await bridge.sendNow(forTransport(parts[0].draft), account)
      } else {
        // One send per recipient, sequential on purpose: `mailer.ts` keeps a
        // warm authenticated connection per account, so serial sends reuse it,
        // while forty parallel ones would open forty and trip the provider's
        // concurrency limit before its rate limit.
        const accepted: string[] = []
        const rejected: string[] = []
        let durationMs = 0
        let firstFailure: SendResult | null = null
        for (const part of parts) {
          const one = await bridge.sendNow(forTransport(part.draft), account)
          durationMs += one.durationMs
          accepted.push(...one.accepted)
          rejected.push(...one.rejected)
          if (!one.ok) firstFailure ??= one
        }
        result = {
          ok: firstFailure === null,
          accepted,
          rejected,
          durationMs,
          error: firstFailure?.error,
          errorKind: firstFailure?.errorKind,
          diagnostics: firstFailure?.diagnostics,
        }
      }

      const queued =
        opts.queue !== false &&
        live.settings.offlineQueueEnabled !== false &&
        isQueueable(result)
      if (queued) {
        dispatch({ type: 'enqueue', item: queueItem(draft, result, undefined, opts.jobId) })
      }

      /**
       * Remember who this went to, for the compose screen's quick picks.
       *
       * Only on an accepted send: an address the server rejected is the last
       * one that should be promoted to the top of a one-click list, and a
       * typo recorded here would be offered back for months. Names come from
       * the contact book where it knows one, so the picks can read
       * "Wei Chen · wei@example.com" rather than an address on its own.
       */
      if (result.accepted.length > 0) {
        const names: Record<string, string> = {}
        for (const c of live.contacts) if (c.name) names[c.address.toLowerCase()] = c.name
        dispatch({ type: 'recordRecipients', addresses: result.accepted, names })
      }

      addLog({
        kind: 'send',
        level: result.ok ? 'info' : queued ? 'warn' : 'error',
        title: result.ok
          ? draft.subject || '(no subject)'
          : queued
            ? `Queued: ${draft.subject || '(no subject)'}`
            : 'Send failed',
        detail: result.error,
        jobId: opts.jobId,
        recipients: result.ok ? result.accepted.length : undefined,
        durationMs: result.durationMs,
        messageId: result.messageId,
      })
      return result
    },
    // `liveRef` keeps this identity stable — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge, addLog, locale],
  )

  const scheduleDraft = useCallback(
    async (job: ScheduledJob) => {
      let finalJob = job

      if (state.settings.snapshotAttachments && bridge && job.draft.attachments.length > 0) {
        try {
          const snapshotted = await bridge.snapshotAttachments(job.draft.attachments, job.id)
          finalJob = { ...job, draft: { ...job.draft, attachments: snapshotted } }
        } catch {
          // Snapshotting is a convenience; the original paths still work as
          // long as nothing moves, so a failure here is a warning not a stop.
          addLog({
            kind: 'schedule',
            level: 'warn',
            title: 'Could not copy attachments',
            detail: 'The schedule was saved, but it now depends on the original files staying put.',
            jobId: job.id,
          })
        }
      }

      // Saving is also a migration point: the editor still writes the legacy
      // flag for jobs that had it, and a job saved with both it and a policy
      // used to be shifted twice.
      finalJob = { ...finalJob, recurrence: migrateSkipWeekends(finalJob.recurrence) }
      const rawOccurrences = computeOccurrences(finalJob.recurrence, {
        runsSoFar: finalJob.runCount,
        count: 24,
        calendar: state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
      })
      const { occurrences, warning } = shapeOccurrences(
        rawOccurrences,
        finalJob,
        state.settings,
        Date.now(),
        windowsForDraft(finalJob.draft.to, state.contacts),
      )
      finalJob = {
        ...finalJob,
        occurrences,
        calendarWarning: warning,
        updatedAt: Date.now(),
        // Keeps `patchSettings`'s fast path warm — see `reshapeJob`. Set here
        // rather than left stale, because this is also where `recurrence` can
        // change, and a cache computed against the *previous* rule must never
        // survive that.
        rawOccurrences,
        rawOccurrencesRunCount: finalJob.runCount,
      }

      dispatch({ type: 'upsertJob', job: finalJob })
      if (warning && warning.dropped.length > 0) {
        addLog({
          kind: 'schedule',
          level: 'error',
          title: `Will not be sent: ${finalJob.name}`,
          detail:
            `${warning.dropped.length} fire time(s) have no working day to move to — ` +
            `first ${new Date(warning.dropped[0]).toLocaleString()}.`,
          jobId: finalJob.id,
        })
      }
      addLog({
        kind: 'schedule',
        level: 'info',
        title: `Scheduled: ${finalJob.name}`,
        detail: occurrences[0] ? new Date(occurrences[0]).toLocaleString() : undefined,
        jobId: finalJob.id,
      })
    },
    [bridge, state.settings, addLog],
  )

  const toggleJob = useCallback(
    async (id: string, enabled: boolean) => {
      const job = state.jobs.find((j) => j.id === id)
      if (!job) return
      const rebuilt = enabled ? rebuildJob(job, state.settings, Date.now(), state.contacts) : null
      dispatch({
        type: 'upsertJob',
        job: {
          ...job,
          ...(rebuilt ?? {}),
          enabled,
          status: enabled ? 'armed' : 'paused',
          // A paused job's warning describes a list that no longer exists.
          ...(enabled
            ? {}
            : { occurrences: [], calendarWarning: undefined, rawOccurrences: undefined, rawOccurrencesRunCount: undefined }),
          updatedAt: Date.now(),
        },
      })
    },
    [state.jobs, state.settings],
  )

  const deleteJob = useCallback(
    async (id: string) => {
      const job = liveRef.current.jobs.find((j) => j.id === id)
      // Recorded before the removal, so the inverse carries the job exactly as
      // it was — including its occurrence list, which would otherwise be
      // recomputed on re-add and silently move the next fire time.
      if (job) pushUndo(job.name, [{ type: 'upsertJob', job }])
      dispatch({ type: 'removeJob', id })
    },
    [pushUndo],
  )

  /**
   * What the condition evaluator is allowed to know, on this side of the
   * bridge.
   *
   * `fileExists` is deliberately absent: the renderer has no filesystem, and a
   * condition it cannot answer must not block a send (see `core/conditions`).
   * The desktop scheduler supplies a real one in the main process, which is
   * where a scheduled run is actually decided.
   */
  const conditionContext = useCallback(() => {
    const live = liveRef.current
    /*
     * Built by `core/conditions`, not here.
     *
     * This was a private loop with its own `From:`-header parse, and the lookup
     * below normalised the draft address by a second, shorter rule. The two
     * agree today only because `draft.to` holds bare addresses — the display
     * name lives on the contact, not in the stored string. The desktop
     * scheduler now needs the same index for an automatic run, which would have
     * made that two near-copies of one rule in different processes, so the rule
     * is stated once and both sides call it.
     */
    const inbound = latestInboundIndex(live.inboxAccounts)
    return {
      now: Date.now(),
      inboxKnown: live.inboxAccounts.some((i) => i.enabled && i.lastSyncAt !== undefined),
      latestInboundFrom: (address: string) => inbound[inboundKey(address)],
    }
  }, [])

  const runJobNow = useCallback(
    async (id: string) => {
      const job = state.jobs.find((j) => j.id === id)
      if (!job) return null

      const verdict = evaluateConditions(job.conditions, job.draft, {
        ...conditionContext(),
        lastRunAt: job.lastRunAt,
        // The opening edge of "since I last chased them" for a job that has
        // never run. Without it `noReplySince` reached back to the epoch.
        armedAt: job.createdAt,
        lastResult: job.lastResult,
      })
      if (!verdict.send) {
        // A skip is an event. Logging it is the difference between "it decided
        // not to" and "it silently did nothing".
        addLog({
          kind: 'schedule',
          level: 'info',
          title: `Skipped: ${job.name}`,
          detail: verdict.reasonKey,
          jobId: job.id,
        })
        return {
          ok: false,
          skipped: true,
          skipReasonKey: verdict.reasonKey,
          skipReasonValues: verdict.reasonValues,
          accepted: [],
          rejected: [],
          durationMs: 0,
        } satisfies SendResult
      }

      // "Send now" on the digest must compose it now, not resend whatever body
      // was last handed to the scheduler.
      const outgoing =
        job.id === DIGEST_JOB_ID ? withDigestBody(job, liveRef.current, i18n) : job
      const result = await sendDraftNow(outgoing.draft, { jobId: job.id })
      dispatch({
        type: 'upsertJob',
        job: {
          ...job,
          runCount: job.runCount + 1,
          lastRunAt: Date.now(),
          lastResult: result.ok ? 'ok' : 'failed',
          lastError: result.error,
          updatedAt: Date.now(),
        },
      })
      return result
    },
    [state.jobs, sendDraftNow, conditionContext, addLog, i18n],
  )

  // Android's own permission strip (read + fix) — see
  // `hooks/useAndroidPermissions.ts`, moved out unchanged.
  const { permissions, fixPermission } = useAndroidPermissions(bridge)

  // "Reset everything" — see `hooks/useResetEverything.ts`, moved out
  // unchanged.
  const resetEverything = useResetEverything(bridge, state.accounts, addLog, dispatch)

  // Data-folder relocation — see `hooks/useRelocateData.ts`, moved out
  // unchanged.
  const relocateData = useRelocateData(bridge, state.jobs, state.accounts, state.settings, addLog, dispatch)

  /**
   * The message ids each account was known to hold before the sync now
   * running, and whether that baseline is trustworthy yet.
   *
   * A ref rather than state on purpose. This is read and written inside
   * `syncInboxAccount`, which already captures `state` as of when it was
   * *created*; comparing against a closed-over message list would compare the
   * new mail against whatever the account looked like several syncs ago and
   * announce the same arrivals repeatedly.
   *
   * `primed` starts false per account and is set by that account's first
   * completed sync. Without it, opening the app announces the whole mailbox:
   * every message is new to a process that has just started. See
   * `core/newMail.ts`, which owns the rule and is where the other two live.
   *
   * Empty at startup, and deliberately: the baseline for an account's *first*
   * sync of the session comes from the saved account row instead, via
   * `restoredBaseline`. Seeding this map from disk up front would need an
   * effect ordered ahead of the first sync, and getting that order wrong is
   * silent in the direction that matters — the account looks unprimed, the
   * arrivals are dropped, and nothing says so.
   */
  const seenInboxIds = useRef(new Map<string, { ids: Set<string>; primed: boolean; since?: number }>())

  /**
   * Write down what a sync decided about announcing, and why.
   *
   * The receiving side had no record of its own decisions at all, and that is
   * the reason "new mail raises nothing" survived four consecutive releases
   * that each shipped a fix for it: every one of those fixes could only be
   * checked by waiting for real mail and watching a corner of the screen. When
   * nothing happened there was no way to tell which of six possible causes it
   * was, so the next release guessed again.
   *
   * Deliberately quiet. A sync that found nothing new writes nothing — with a
   * one-minute interval and five accounts, logging every tick would be seven
   * thousand rows a day and would push the sends this log exists for off the
   * end of the retention window. A row appears only when there was something to
   * decide: an arrival announced, or an arrival a rule swallowed.
   *
   * Counts only, never subjects or senders. This log is exportable as CSV and
   * the sync trace must not be the thing that turns that export into a copy of
   * the mailbox.
   */
  const traceDelivery = useCallback(
    (
      accountId: string,
      report: ArrivalReport,
      withheld: 'off' | 'quiet' | null,
      announced: number,
      /**
       * What the user's own three rules did to the survivors.
       *
       * Optional so a caller that has no policy — there is none today, and the
       * parameter exists so that adding one later is not a signature change —
       * still produces the trace it always did.
       */
      policy?: PolicyOutcome,
    ) => {
      const suppressed =
        report.readElsewhere +
        report.tooOld +
        (policy?.accountMuted ?? 0) +
        (policy?.senderNotListed ?? 0)
      const unprimed = !report.primed && report.fresh > 0
      // Nothing decided, nothing to say. This is the overwhelming majority of
      // syncs and it must stay free.
      if (announced === 0 && suppressed === 0 && !unprimed) return

      const label =
        liveRef.current.accounts.find((a) => a.id === accountId)?.label ??
        liveRef.current.inboxAccounts.find((i) => i.accountId === accountId)?.imapUsername ??
        accountId

      const parts: string[] = []
      if (announced > 0) parts.push(i18n.t('inbox.trace.announced', { n: announced }))
      if (report.readElsewhere > 0)
        parts.push(i18n.t('inbox.trace.readElsewhere', { n: report.readElsewhere }))
      if (report.tooOld > 0) parts.push(i18n.t('inbox.trace.tooOld', { n: report.tooOld }))
      if (policy && policy.accountMuted > 0)
        parts.push(i18n.t('inbox.trace.accountMuted', { n: policy.accountMuted }))
      if (policy && policy.senderNotListed > 0)
        parts.push(i18n.t('inbox.trace.senderNotListed', { n: policy.senderNotListed }))
      if (announced > 0 && policy && policy.forced > 0)
        parts.push(i18n.t('inbox.trace.forced', { n: policy.forced }))
      if (unprimed) parts.push(i18n.t('inbox.trace.notPrimed', { n: report.fresh }))
      if (withheld === 'off') parts.push(i18n.t('inbox.trace.off'))
      if (withheld === 'quiet') parts.push(i18n.t('inbox.trace.quiet'))

      addLog({
        kind: 'inbox',
        // Not `warn` when something was suppressed: a rule doing its job is not
        // a fault, and a log that cries wolf about every read newsletter is one
        // nobody reads. The row itself is the signal.
        level: 'info',
        title: i18n.t('inbox.trace.title', { account: label }),
        detail: parts.join(i18n.t('inbox.trace.join')),
      })
    },
    [addLog, i18n],
  )

  /**
   * Tell the user that mail arrived, if it did and if they want to know.
   *
   * Reads `liveRef` rather than `state` for the settings, for the same reason
   * the delete-race guard below does: this runs when a sync *lands*, and the
   * only settings that matter are the ones in force then.
   */
  const announceNewMail = useCallback(
    (accountId: string, messages: readonly InboxMessage[], saved?: InboxAccountState) => {
      // The in-memory entry wins whenever there is one: it is this session's
      // own record and is always fresher than the saved row. `saved` only ever
      // decides the very first sync of the session, which is the one the saved
      // row is a correct baseline for.
      const previous = seenInboxIds.current.get(accountId) ?? restoredBaseline(saved)
      const ids = new Set(messages.map((m) => m.id))
      seenInboxIds.current.set(accountId, { ids, primed: true })

      const settings = liveRef.current.settings

      /*
       * Computed before the two gates below, not after them.
       *
       * The gates used to return first, which cost nothing at the time and
       * cost a great deal later: when someone reports "it never tells me about
       * mail", there is no way to tell a mailbox with nothing new in it from a
       * setting that is off, from a quiet window, from an arrival that every
       * rule silently ate. Four releases were spent guessing between those.
       * Deciding first and *then* gating means the trace below can name which
       * one it was, and the cost is one filter over at most fifty rows.
       */
      /*
       * The user's own three rules, read once for this sync — see
       * `core/mail/notifyPolicy.ts`. All three are absent on an install that
       * has never opened the control, and an absent rule is not a rule, so
       * everything below reduces to what shipped before them.
       */
      const policy: NotifyPolicy = {
        accounts: settings.notifyAccounts,
        senders: settings.notifySenders,
        keywords: settings.notifyKeywords,
      }
      const now = Date.now()

      const report = explainArrivals({
        before: previous?.ids ?? new Set<string>(),
        after: messages,
        now,
        primed: previous?.primed ?? false,
        // Only ever set on a restored baseline, so this widens the recency
        // window for the first sync after a restart and for no other sync.
        since: previous?.since,
        includeRead: settings.notifyReadElsewhere === true,
        /*
         * The keyword rule, reaching back into the two rules above it.
         *
         * A subject with 验证码 in it has to survive "already read on the
         * phone" and "older than half an hour", because both of those are
         * routine for exactly the mail someone is sitting there waiting for.
         * Only the keyword rule forces; a muted account or an unlisted sender
         * is handled below, where it can be counted separately.
         */
        force: (m) => keywordHit(m, policy.keywords ?? []),
      })

      const outcome = applyPolicy(report.arrivals, accountId, policy)

      /*
       * Quiet hours hold this back, unlike a verification code. Someone
       * waiting for a code at 02:00 is waiting on purpose; a newsletter at
       * 02:00 is precisely what a nightly window exists to keep off the
       * screen. Both remain on the Inbox screen either way — nothing is lost,
       * only deferred to when it is looked at.
       *
       * `outcome.urgent` is the one thing that reaches through it, and it is
       * the user's own word doing the reaching: a keyword they typed is them
       * saying in advance which mail is worth the exception. Without this the
       * keyword rule would be silently void for nine hours a night — which is
       * when the mail it exists for tends to arrive.
       */
      const withheld: 'off' | 'quiet' | null =
        settings.notifyOnNewMail === false
          ? 'off'
          : !outcome.urgent && isQuiet(now, quietFrom(settings))
            ? 'quiet'
            : null

      const announcement = withheld ? null : announcementFor(outcome.keep)
      traceDelivery(accountId, report, withheld, announcement?.count ?? 0, outcome)

      /*
       * Written whatever the outcome, including "nothing arrived".
       *
       * A ledger that only records the interesting syncs cannot answer the
       * question it exists for: "it has told me nothing all day — is it
       * broken?" is answered by *twelve quiet syncs* just as much as by a
       * suppression count, and an empty ledger is indistinguishable from an
       * app that never ran.
       */
      dispatch({
        type: 'recordNotifyDecision',
        entry: {
          at: now,
          accountId,
          examined: report.examined,
          fresh: report.fresh,
          announced: announcement?.count ?? 0,
          readElsewhere: report.readElsewhere,
          tooOld: report.tooOld,
          accountMuted: outcome.accountMuted,
          senderNotListed: outcome.senderNotListed,
          forced: announcement ? outcome.forced : 0,
          quiet: withheld === 'quiet' ? outcome.keep.length : 0,
          switchedOff: withheld === 'off' ? outcome.keep.length : 0,
        },
      })

      if (!announcement) return

      const { count, newest } = announcement
      const from = senderName(newest.from)
      const subject = newest.subject || i18n.t('inbox.noSubject')
      const preview = previewLine(newest)
      void bridge
        ?.notify(
          count > 1
            ? i18n.t('notify.newMailMany', { n: count, from })
            : i18n.t('notify.newMailOne', { from }),
          // The subject is the line that decides whether this is worth
          // interrupting for, so it leads; the snippet follows only when
          // there is one, rather than leaving a trailing separator.
          preview ? `${subject} — ${preview}` : subject,
          {
            messageId: newest.id,
            accountId,
            // Android's Mark-as-read notification action; ignored on every
            // other platform. Reuses the same label the Inbox row's own
            // context-menu action already carries — one word, one key,
            // rather than a near-duplicate translation for a button that
            // does exactly the same thing.
            markReadLabel: i18n.t('inbox.markRead'),
          },
        )
        .catch(() => {
          /* A refused notification must not take the sync down with it. */
        })
    },
    [bridge, i18n, traceDelivery, dispatch],
  )

  /**
   * Every `\Seen` change this device has made and not yet had the server
   * confirm, per account, keyed by message id.
   *
   * A ref rather than state, for the same reason `seenInboxIds` above is one:
   * this changes every time a message is opened, nothing on screen renders from
   * it, and putting it through the reducer would re-render the whole tree — the
   * inbox list included — for bookkeeping the user never sees.
   *
   * Entries leave on a confirmed push and stay on a failed one, which is what
   * makes them worth keeping: while an entry is here, `mergeSeenFlags` refuses
   * to let a sync move that message's `seen` at all. An entry whose push never
   * succeeds therefore stays for the life of the process — deliberately, since
   * the local value is the only correct one until the server accepts it. It is
   * memory only and never persisted, so a restart clears it and rule 2 of
   * `mergeSeenFlags` carries on protecting the "read" direction by itself.
   */
  const pendingSeenPushes = useRef(new Map<string, Map<string, PendingSeenPush>>())

  /** The queue as the reducer needs to see it: one plain array, snapshotted now. */
  const pendingSeenFor = useCallback(
    (accountId: string): PendingSeenPush[] => [
      ...(pendingSeenPushes.current.get(accountId)?.values() ?? []),
    ],
    [],
  )

  /**
   * Try the queued `\Seen` pushes once more, and wait for the answer.
   *
   * Called immediately before a sync, which is the one moment the retry is
   * worth anything: a push that lands first means the sync reads back the value
   * this device already believes, and the queue empties instead of pinning the
   * flag forever. Awaited rather than detached for that same ordering — a
   * detached retry racing the sync it was meant to precede is the original bug
   * with extra steps.
   *
   * Reads `liveRef` rather than the closed-over `state` because this runs at
   * sync time, which can be many minutes after the callback was created, and
   * the account config it hands to the bridge has to be the current one.
   */
  const flushPendingSeen = useCallback(
    async (accountId: string): Promise<void> => {
      const queue = pendingSeenPushes.current.get(accountId)
      const push = bridge?.setMessageFlags
      if (!push || !queue || queue.size === 0) return
      const inbox = liveRef.current.inboxAccounts.find((i) => i.accountId === accountId)
      if (!inbox) return
      await Promise.all(
        [...queue.values()].map(async (entry) => {
          const folder = inbox.folders.find((f) => f.path === entry.folderPath)
          if (folder && folder.uidValidity !== entry.uidValidity) {
            // The folder was renumbered while this sat in the queue, so
            // `entry.uid` now names a different message or none at all.
            // Retrying would set `\Seen` on whatever took its place — a wrong
            // write to someone's mailbox, which is worse than the lost flag.
            // Drop it; see `InboxFolder.uidValidity`.
            queue.delete(entry.id)
            return
          }
          try {
            const result: unknown = await push(inbox, entry.folderPath, entry.uid, {
              seen: entry.seen,
            })
            if (looksFailed(result)) {
              console.warn(
                `[inbox] retry of \\Seen=${entry.seen} was refused for ${entry.id}:`,
                result,
              )
              return
            }
            // Identity, not equality: a newer mark on the same message may have
            // replaced this entry while the request was out, and deleting that
            // one because an older push finally succeeded would drop the
            // protection the newer value still needs.
            if (queue.get(entry.id) === entry) queue.delete(entry.id)
          } catch (e) {
            console.warn(`[inbox] retry of \\Seen=${entry.seen} failed for ${entry.id}:`, e)
          }
        }),
      )
    },
    [bridge],
  )

  /**
   * The accounts whose sync has been asked for and has not answered yet.
   *
   * This exists because of a mailbox that took longer to sync than the gap
   * between syncs, and the failure that produces is not "a slow account" — it
   * is a slow account that never succeeds again.
   *
   * Measured on the reporting user's install. One Gmail account needed 152 s
   * for a full sync (the server itself is slow to authenticate: 36.7 s against
   * 1-5 s for four other accounts on the same host). The sync timer was set to
   * one minute. So a second sync started while the first was still connecting,
   * then a third, each opening its own connections to the same mailbox — and a
   * provider that is already slow answers a growing pile of simultaneous
   * connections more slowly still. The account's own retries were what kept it
   * failing: the app pushed the connect time past even the ninety-second
   * patient budget that had just been added for it, and the recorded error
   * changed from "within 10 seconds" to "within 90 seconds" while getting no
   * closer to working.
   *
   * A ref, not state: nothing renders from it, and it must be readable and
   * writable inside the same turn a sync starts in.
   */
  const syncInFlight = useRef(new Set<string>())

  /**
   * How many syncs in a row each account has failed, and when it last said so.
   *
   * A ref rather than state for the reason `seenInboxIds` is one: it changes on
   * every sync of every account, nothing on screen renders from it, and putting
   * it through the reducer would re-render the tree for bookkeeping. Losing it
   * on restart is correct too — a fresh process has no evidence of a *run*, and
   * inventing one from `lastSyncError` would fire the alert on the first failed
   * sync after every launch.
   */
  const failureRuns = useRef(new Map<string, FailureRun>())

  /**
   * Fold one sync's outcome into that account's run, and say something if the
   * run has gone on long enough.
   *
   * The red line on the Inbox screen is the right amount of noise for a failure
   * you are watching happen. It is the wrong amount for the failure that
   * actually costs mail: an account whose app password was revoked three weeks
   * ago, failing every five minutes, on a screen nobody has opened. See
   * `core/ops/syncHealth.ts` for the threshold and the cooldown, and why both
   * are needed rather than either alone.
   *
   * `notifyOnFailure` governs it — the same switch that governs a failed
   * *send*, deliberately, because "tell me when something I asked for did not
   * happen" is one preference and not two.
   */
  const noteSyncOutcome = useCallback(
    (accountId: string, ok: boolean, error?: string) => {
      const run = recordSync(failureRuns.current.get(accountId), ok)
      failureRuns.current.set(accountId, run)
      if (ok) return
      const now = Date.now()
      if (!liveRef.current.settings.notifyOnFailure) return
      if (!shouldAlert(run, now)) return
      failureRuns.current.set(accountId, markAlerted(run, now))

      const label =
        liveRef.current.accounts.find((a) => a.id === accountId)?.label ??
        liveRef.current.inboxAccounts.find((i) => i.accountId === accountId)?.imapUsername ??
        accountId
      addLog({
        kind: 'inbox',
        // `warn`, unlike the delivery trace: a rule suppressing a newsletter is
        // the app working, and a mailbox unreachable for a quarter of an hour
        // is not.
        level: 'warn',
        title: i18n.t('inbox.failRun.title', { account: label, n: run.count }),
        detail: error ?? '',
      })
      void bridge
        ?.notify(
          i18n.t('inbox.failRun.title', { account: label, n: run.count }),
          i18n.t('inbox.failRun.body'),
        )
        .catch(() => {
          /* A refused notification must not take the sync down with it. */
        })
    },
    [addLog, bridge, i18n],
  )

  const syncInboxAccount = useCallback(
    async (accountId: string, override?: InboxAccountState) => {
      if (!bridge?.syncInbox) return
      /*
       * Already asking. Say nothing and let the answer in flight be the
       * answer — starting a second one cannot produce fresher mail than the
       * first is already fetching, and on a slow mailbox it actively prevents
       * the first from finishing.
       *
       * `override` is the exception, and the only one: it means the account's
       * settings have just changed, so the sync already running is asking the
       * wrong question with the wrong credentials. That one must go through.
       */
      if (!override && syncInFlight.current.has(accountId)) return
      /**
       * `override` wins over the lookup, and that is not an optimisation — it
       * is the whole reason this parameter exists.
       *
       * `dispatch` does not update `state` synchronously, so a caller that
       * saved a config and then asked for a sync used to send the *previous*
       * config over the bridge. For a freshly enabled account that previous
       * config is `{enabled:false, imapHost:''}`, `syncInbox()` returns it
       * untouched (it no-ops when disabled), and the reducer then wrote that
       * stale copy back over the settings the user had just typed in. The
       * observable symptom was "I turned receiving on, saved, and nothing
       * happened" — with the account silently reverted to off and blank.
       */
      const config =
        override ??
        state.inboxAccounts.find((i) => i.accountId === accountId) ??
        defaultInboxAccountState(accountId)
      /*
       * Marked before the first `await`, released in the `finally` at the far
       * end of both branches. Anything less than that — marking after the
       * flush, or releasing only on success — leaves the window this guard
       * exists to close, or leaves an account permanently marked busy after
       * one failure, which is the same outage wearing the opposite mask.
       */
      syncInFlight.current.add(accountId)
      try {
        // Drain what we still owe the server before asking it what it holds.
        // Without this a push that failed once was never retried at all, and
        // the server's answer stayed permanently one flag behind what the user
        // saw.
        //
        // Inside the `try`, and moved there with the guard above: outside it,
        // a throw from the flush would skip the `finally` and leave the
        // account marked as syncing for the life of the process — no more
        // syncs, no more mail, no error anyone could see.
        await flushPendingSeen(accountId)
        const result = await bridge.syncInbox(config)
        /*
         * `deleteAccount` can land while this `await` is still out — a full
         * IMAP connect, login and header fetch, up to 20 seconds — and it does
         * not wait, because nothing should have to hold up deleting an account
         * for a sync that may never come back at all. Dispatching anyway would
         * resurrect an `inboxAccounts` row for an id `removeAccount` already
         * pruned from `state.accounts`, and the debounced whole-state save
         * would persist it: a phantom account with no matching row, showing
         * its raw `acct_...` id because there is nothing left to look it up
         * against.
         *
         * `liveRef` rather than `state.accounts`, on purpose. `state` is the
         * value this closure captured when the sync *started*; only the state
         * at the moment the reply *lands* can say whether the account is still
         * there, and reading the closed-over value is precisely the staleness
         * this guard exists to stop.
         */
        if (!liveRef.current.accounts.some((a) => a.id === accountId)) {
          return { ok: !result.lastSyncError, error: result.lastSyncError, inbox: result }
        }
        noteSyncOutcome(accountId, !result.lastSyncError, result.lastSyncError)
        // The queue is snapshotted here, not when the sync started: what
        // matters is what is still unconfirmed at the moment the reply lands.
        dispatch({
          type: 'upsertInboxAccount',
          inbox: result,
          origin: 'sync',
          pendingSeen: pendingSeenFor(accountId),
        })
        /*
         * After the dispatch, and only on the path where the account still
         * exists. Every inbox refresh in the app funnels through here — the
         * push watcher, the timer, the Check now button and the receive test —
         * so this is the one place that sees both what was known before and
         * what came back, which is exactly what deciding "is this new" needs.
         * Announcing from the individual callers instead would have meant four
         * copies of the rule and four chances for a message to be announced
         * twice.
         */
        /*
         * `config` goes with it, and that is not belt-and-braces: it is the
         * account row as it stood when this sync *started*, which on the first
         * sync of a session is the copy restored from disk. That copy is the
         * only record of what the mailbox held while the app was closed, so it
         * is the baseline that decides whether last night's mail is announced
         * or silently absorbed. `announceNewMail` ignores it from the second
         * sync onwards, where its own in-memory record is fresher.
         */
        if (!result.lastSyncError) announceNewMail(accountId, result.messages ?? [], config)
        /*
         * Handed back as well as dispatched. A caller that pressed a button and
         * is waiting to say what happened cannot read the answer out of `state`
         * — `dispatch` has not landed yet — and the alternative, polling the
         * account for a `lastSyncError` that may be left over from the previous
         * attempt, is how "check now" ends up reporting a stale failure as if it
         * had just occurred.
         */
        return { ok: !result.lastSyncError, error: result.lastSyncError, inbox: result }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        // Same race, the failure path. An account deleted mid-flight has
        // nothing left to attach `lastSyncError` to — see the success branch
        // above.
        if (liveRef.current.accounts.some((a) => a.id === accountId)) {
          /*
           * The *live* row, not the closed-over `config`, with only the error
           * written onto it.
           *
           * This branch used to dispatch `{ ...config, lastSyncError }`, and
           * that was a data-loss bug, observed rather than theorised. On the
           * reporting user's install, one slow account synced successfully at
           * 17:43:03 — 29 cached messages became 42, error cleared — and at
           * 17:45:32 the row was back to 29 messages with `lastSyncAt` reset to
           * three days earlier, because a sync that had started before that
           * success finally failed and wrote its own stale snapshot over it.
           *
           * `config` is stale by construction here. The sync timer holds one
           * `syncInboxAccount` closure across many ticks (see its effect's
           * dependency list), so `state.inboxAccounts` inside it is whatever it
           * was when that closure was built — which can be many minutes and
           * several successful syncs ago. Writing it back is not "the staler of
           * the two", it is throwing away mail that has already been fetched
           * and, with it, any chance of the account looking healthy again.
           *
           * A failure knows exactly one new fact: that it failed. So that is
           * the only field it is allowed to write.
           */
          const live =
            liveRef.current.inboxAccounts.find((i) => i.accountId === accountId) ?? config
          dispatch({
            type: 'upsertInboxAccount',
            inbox: { ...live, lastSyncError: error },
            origin: 'sync',
            pendingSeen: pendingSeenFor(accountId),
          })
        }
        // Outside the "account still exists" guard on purpose: a run of
        // failures is a fact about the account whether or not there is still a
        // row to write a red line onto, and `recordSync` is the only thing
        // that ever clears the counter.
        noteSyncOutcome(accountId, false, error)
        return { ok: false, error }
      } finally {
        // Both branches, always. A guard that is only released on success
        // turns one failed sync into an account that never syncs again — a
        // quieter version of exactly the outage it was written to prevent.
        syncInFlight.current.delete(accountId)
      }
    },
    [bridge, state.inboxAccounts, flushPendingSeen, pendingSeenFor, noteSyncOutcome],
  )

  const saveInboxAccount = useCallback(
    async (config: InboxAccountState, secret?: string) => {
      if (!bridge) return
      if (secret) await bridge.setSecret(config.accountId, secret, 'imap')
      dispatch({ type: 'upsertInboxAccount', inbox: config })

      /*
       * The sync runs behind the user, not in front of them.
       *
       * It is a full IMAP connect, login, mailbox open and header fetch — up
       * to 50 headers and 15 bodies on a first run. Awaiting it here is what
       * "saving an account takes ages" was: the dialog stayed open with the
       * button spinning for however long the server took, having already
       * written everything the user typed.
       *
       * Safe to detach because it is not the thing being saved. The dispatch
       * above is the save, and it has already happened. And it cannot become a
       * sync that silently never ran: `syncInboxAccount` catches its own
       * failures and writes `lastSyncError` into the account, which the inbox
       * UI and the health board both read — so a failure is still reported,
       * just not by holding a dialog open.
       *
       * Still called when disabling: `syncInbox()` no-ops for a disabled
       * config everywhere, but a platform with a native background sync
       * (Android) needs the round trip to learn the account turned off.
       */
      void syncInboxAccount(config.accountId, config)
    },
    [bridge, syncInboxAccount],
  )

  const testInboxAccount = useCallback(
    async (config: InboxAccountState, secret?: string): Promise<SendResult> => {
      if (!bridge?.testInbox) {
        return {
          ok: false,
          accepted: [],
          rejected: [],
          durationMs: 0,
          error: 'Receiving is not available on this platform',
          errorKind: 'config',
        }
      }
      return bridge.testInbox(config, secret)
    },
    [bridge],
  )

  const getInboxMessageBody = useCallback(
    async (message: InboxMessage): Promise<InboxMessageBody> => {
      if (!bridge?.getMessageBody) throw new Error('Inbox is not available on this platform')
      const config =
        state.inboxAccounts.find((i) => i.accountId === message.accountId) ??
        defaultInboxAccountState(message.accountId)
      const body = await bridge.getMessageBody(config, message.folderPath, message.uid)
      dispatch({
        type: 'patchInboxMessages',
        accountId: message.accountId,
        ids: [message.id],
        patch: { bodyCached: true },
      })
      return body
    },
    [bridge, state.inboxAccounts],
  )

  const ensureInboxAttachment = useCallback(
    async (message: InboxMessage, attachment: Attachment): Promise<Attachment> => {
      // Nothing to do where the body fetch already wrote the file out, which
      // is every platform except Android — see `PlatformBridge.ensureAttachment`.
      if (attachment.path || !bridge?.ensureAttachment) return attachment
      const config =
        state.inboxAccounts.find((i) => i.accountId === message.accountId) ??
        defaultInboxAccountState(message.accountId)
      return bridge.ensureAttachment(config, message.folderPath, message.uid, attachment)
    },
    [bridge, state.inboxAccounts],
  )

  /**
   * Mark read (or unread) here first, then tell the server.
   *
   * The local write stays optimistic — waiting on IMAP before the row stops
   * being bold would make opening a message feel broken on a slow connection.
   * What changed is everything after it. The pushes used to be fired into a
   * bare `.catch(() => {})`, with the platform sides swallowing their own
   * failures underneath, so a refused `\Seen` was invisible at every layer and
   * was never retried; the next sync then reported the server's untouched
   * `false` and the row went bold again. Now each message goes out on its own
   * request, an unconfirmed one stays queued in `pendingSeenPushes` — which
   * `mergeSeenFlags` treats as the newer truth and `flushPendingSeen` retries
   * before the next sync — and a failure is at least written somewhere a
   * console can be asked about it.
   */
  const markInboxMessagesRead = useCallback(
    async (accountId: string, ids: string[], seen: boolean) => {
      dispatch({ type: 'patchInboxMessages', accountId, ids, patch: { seen } })
      const push = bridge?.setMessageFlags
      // Nothing queued where there is no way to push at all: the entry could
      // never clear, and rule 2 of `mergeSeenFlags` already keeps a local read
      // from being undone on such a platform.
      if (!push) return
      const inbox = state.inboxAccounts.find((i) => i.accountId === accountId)
      if (!inbox) return
      const targets = inbox.messages.filter((m) => ids.includes(m.id))
      if (targets.length === 0) return
      let queue = pendingSeenPushes.current.get(accountId)
      if (!queue) {
        queue = new Map<string, PendingSeenPush>()
        pendingSeenPushes.current.set(accountId, queue)
      }
      const pending = queue
      await Promise.all(
        targets.map(async (m) => {
          // Queued *before* the request goes out, not after it fails: a sync
          // can land while this is still in flight, and that window is exactly
          // the one the queue exists to cover.
          const entry: PendingSeenPush = {
            id: m.id,
            folderPath: m.folderPath,
            uid: m.uid,
            uidValidity: m.uidValidity,
            seen,
          }
          pending.set(m.id, entry)
          try {
            const result: unknown = await push(inbox, m.folderPath, m.uid, { seen })
            if (looksFailed(result)) {
              console.warn(`[inbox] server refused \\Seen=${seen} for ${m.id}:`, result)
              return
            }
            // Identity, not equality — see `flushPendingSeen`.
            if (pending.get(m.id) === entry) pending.delete(m.id)
          } catch (e) {
            console.warn(`[inbox] could not push \\Seen=${seen} for ${m.id}:`, e)
          }
        }),
      )
    },
    [bridge, state.inboxAccounts],
  )

  const tagInboxMessages = useCallback((accountId: string, ids: string[], tag: InboxTag) => {
    dispatch({ type: 'patchInboxMessages', accountId, ids, patch: { tag } })
  }, [])

  /**
   * "Remove from Aevistle" — reversible, and the mailbox is not touched.
   *
   * Drops the row, drops the cached body and attachments, and writes a
   * tombstone so the next sync does not fetch the same message back. That last
   * part is what makes this do anything at all: without it the row reappeared
   * within five minutes and the delete button was decoration.
   */
  const deleteInboxMessages = useCallback(
    async (accountId: string, ids: string[]) => {
      const inbox = state.inboxAccounts.find((i) => i.accountId === accountId)
      const targets = inbox?.messages.filter((m) => ids.includes(m.id)) ?? []
      dispatch({ type: 'removeInboxMessages', accountId, ids })
      if (!bridge?.deleteInboxMessages || targets.length === 0) return
      await bridge
        .deleteInboxMessages(
          accountId,
          targets.map((m) => ({ folderPath: m.folderPath, uid: m.uid })),
        )
        .catch(() => {
          /* the message is already gone from local state; a stale cache file left behind is harmless */
        })
    },
    [bridge, state.inboxAccounts],
  )

  /**
   * "Delete from the mailbox" — the real one, on the server, not undoable.
   *
   * No tombstone is written: there will be nothing left to filter out and
   * nothing to restore from, and offering a recycle-bin entry for a message
   * that no longer exists would be a lie the first time someone tried it.
   *
   * A server failure is reported rather than swallowed. The rows are already
   * gone locally, so a silent failure here reads as "deleted" while the mail
   * is still sitting in the mailbox — and the user would only find out from
   * another mail client, weeks later.
   */
  const purgeInboxMessages = useCallback(
    async (accountId: string, ids: string[]): Promise<{ ok: boolean; error?: string }> => {
      const inbox = state.inboxAccounts.find((i) => i.accountId === accountId)
      const targets = inbox?.messages.filter((m) => ids.includes(m.id)) ?? []
      if (targets.length === 0) return { ok: true }
      if (!bridge?.purgeInboxMessages || !inbox) {
        return { ok: false, error: 'This platform cannot delete on the server yet' }
      }
      try {
        await bridge.purgeInboxMessages(
          inbox,
          targets.map((m) => ({ folderPath: m.folderPath, uid: m.uid })),
        )
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      dispatch({ type: 'removeInboxMessages', accountId, ids, purge: true })
      return { ok: true }
    },
    [bridge, state.inboxAccounts],
  )

  /** Put removed messages back into the list, straight from the recycle bin. */
  const restoreInboxMessages = useCallback((accountId: string, keys: string[]) => {
    dispatch({ type: 'restoreInboxMessages', accountId, keys })
  }, [])

  const clearRemovedMessages = useCallback((accountId?: string) => {
    dispatch({ type: 'clearRemovedMessages', accountId })
  }, [])

  /**
   * Periodic receive.
   *
   * Without this the inbox only ever filled when someone pressed refresh,
   * which for a "put the verification code on screen" feature is the same as
   * not working. It lives here rather than in the main process because the
   * account list and its cached messages are renderer state — a second copy
   * in the main process would be a second thing to keep in sync, and the two
   * would disagree the first time a save raced a timer.
   *
   * The signature, not the array, is the dependency: `inboxAccounts` gets a
   * new identity on every sync (it carries the messages), so depending on it
   * directly would tear down and restart the timer on each tick.
   */
  const inboxSignature = state.inboxAccounts
    .filter((i) => i.enabled)
    .map((i) => `${i.accountId}:${i.imapHost}:${i.imapPort}`)
    .join('|')
  const syncMinutes = state.settings.inboxSyncMinutes ?? 5
  const pushEnabled = state.settings.inboxPush !== false

  /**
   * Push: let the server tell us, instead of asking on a timer.
   *
   * The timer below is deliberately left running. A held-open connection can
   * be dropped by a proxy, a sleeping laptop or a provider that never
   * advertised IDLE at all, and none of those announce themselves — so push
   * is an optimisation layered over a working poll, never a replacement for
   * it. Worst case the two agree and the second sync is a no-op.
   */
  useEffect(() => {
    if (!ready || !bridge?.watchInbox) return
    const configs = pushEnabled ? state.inboxAccounts.filter((i) => i.enabled) : []
    void bridge.watchInbox(configs).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bridge, inboxSignature, pushEnabled])

  useEffect(() => {
    if (!bridge?.onInboxEvent) return
    return bridge.onInboxEvent((event) => {
      void syncInboxAccount(event.accountId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, inboxSignature])

  useEffect(() => {
    if (!ready || !bridge?.syncInbox || !inboxSignature || syncMinutes <= 0) return
    const ids = inboxSignature.split('|').map((s) => s.split(':')[0])
    let stopped = false

    /*
     * At most three mailboxes at a time — see `core/mail/syncLimit.ts`.
     *
     * This used to start every account in the same tick. With one or two that
     * is right and the limiter changes nothing; with five it is why "check
     * now" took as long as the worst mailbox and the interface stuttered while
     * it did. Five TLS handshakes, five IMAP logins and five mailbox scans
     * beginning together are not five times faster than three at a time — they
     * queue inside the runtime's own socket limits anyway, and the healthy
     * accounts finish late for no reason but having been started alongside the
     * slow one. Measured case: a 36.7-second connect against a 10-second
     * budget, with four fine accounts stuck behind it.
     *
     * `stopped` is re-checked inside each task rather than only before the
     * batch: a queued account must not sync after the effect has torn down.
     */
    const runAll = () => {
      void runLimited(
        ids.map((id) => async () => {
          if (stopped) return
          await syncInboxAccount(id)
        }),
      )
    }

    // One immediate pass so a just-launched app shows today's mail, then the
    // interval. `visibilitychange` catches the laptop-was-asleep case, where
    // an interval that should have fired an hour ago fires once, late.
    const first = window.setTimeout(runAll, 1_500)
    const timer = window.setInterval(runAll, syncMinutes * 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') runAll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      window.clearTimeout(first)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // syncInboxAccount changes identity whenever inboxAccounts does, which is
    // every sync — including it here would restart the timer on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bridge, inboxSignature, syncMinutes])

  // --- control interface --------------------------------------------------
  //
  // Requests arrive from the main process (HTTP, the drop folder, or the CLI)
  // and are answered here so they go through the same code a click does. The
  // handler is kept in a ref and the listener registered once: re-subscribing
  // on every state change would drop a request that landed mid-swap.

  const controlHandler = useRef<(request: ControlRequest) => void>(() => {})
  controlHandler.current = (request: ControlRequest) => {
    void executeControl(request, {
      state,
      appVersion: __APP_VERSION__,
      allowSending: state.settings.controlAllowSending === true,
      scopes: effectiveControlScopes(state.settings),
      scheduleDraft,
      sendDraftNow,
      toggleJob,
      deleteJob,
    }).then((response) => {
      addLog({
        kind: 'system',
        level: response.ok ? 'info' : 'warn',
        title: `control · ${request.op} · ${request.via}`,
        detail: response.ok ? undefined : response.error,
      })
      void bridge?.respondToControl?.(response)
    })
  }

  useEffect(() => {
    if (!bridge?.onControlRequest) return
    return bridge.onControlRequest((request) => controlHandler.current(request))
  }, [bridge])

  // Start or stop the loopback server whenever any of the three switches move.
  const controlEnabled = state.settings.controlEnabled === true
  const controlAllowSending = state.settings.controlAllowSending === true
  const calendarSubscribeEnabled = state.settings.calendarSubscribeEnabled === true
  useEffect(() => {
    if (!ready || !bridge?.applyControl) return
    void bridge
      .applyControl({ enabled: controlEnabled, allowSending: controlAllowSending, calendarSubscribeEnabled })
      .catch(() => {
        /* A port that will not open is reported by the settings card, which
           reads the endpoint back rather than trusting this call. */
      })
  }, [ready, bridge, controlEnabled, controlAllowSending, calendarSubscribeEnabled])

  // --- ongoing sync ---------------------------------------------------------
  //
  // Two halves, matching `core/syncLoop.ts`'s "symmetric exchange" doc: this
  // device *asking* (`SyncLoop`, a foreground timer) and this device
  // *answering* (`onSyncServerRequest`, desktop only — see `bridge.ts`). Both
  // land the same way once an exchange completes: an `applySyncResult`
  // dispatch, any account secrets written through `setSecret` exactly as an
  // ordinary account save would, and a log line for the audit trail the
  // module doc on `pairedDevices.ts` promises.

  /**
   * The trusted layer's half of a sync cycle, per device.
   *
   * `undefined` on a build with no handlers behind it (the browser preview),
   * which `core/syncLoop.ts` treats as "sync everything except the passwords"
   * rather than as a reason to stop. Bound per device because the key
   * credentials are sealed under belongs to one pairing — see
   * `SyncSecretTransport`.
   */
  const secretsFor = useCallback(
    (device: PairedDevice): SyncSecretTransport | undefined => {
      const seal = bridge?.sealAccountSecrets
      const open = bridge?.openAccountSecrets
      if (!seal || !open) return undefined
      return {
        seal: (accountIds) => seal(device.keyRef, [...accountIds]),
        open: (envelope) => open(device.keyRef, envelope),
      }
    },
    [bridge],
  )

  /** The secret-write and activity-log side effects common to both directions of an exchange — split out so the responder path below can run them around its own save/ACK ordering instead of `applyExchangeOutcome`'s. */
  const logExchangeOutcome = useCallback(
    (deviceLabel: string, result: Pick<PerformExchangeResult, 'patch' | 'conflicts' | 'accountSecrets'>) => {
      for (const s of result.accountSecrets) void bridge?.setSecret(s.accountId, s.secret, 'smtp')
      const changedCount =
        (result.patch.accounts?.length ?? 0) +
        (result.patch.jobs?.length ?? 0) +
        (result.patch.contacts?.length ?? 0) +
        (result.patch.templates?.length ?? 0)
      if (changedCount > 0 || result.conflicts.length > 0) {
        addLog({
          kind: 'system',
          level: 'info',
          title: `Synced with ${deviceLabel}`,
          detail:
            result.conflicts.length > 0
              ? `${changedCount} record(s) updated, ${result.conflicts.length} conflict(s) resolved automatically`
              : `${changedCount} record(s) updated`,
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge, addLog],
  )

  const applyExchangeOutcome = useCallback(
    (deviceLabel: string, deviceId: string, result: PerformExchangeResult, at: number) => {
      const action = {
        type: 'applySyncResult' as const,
        deviceId,
        patch: result.patch,
        conflicts: result.conflicts,
        syncedAt: at,
      }
      // Same reasoning as the responder path's own `liveRef.current` write
      // (see `syncResponder.current` above): this device may simultaneously
      // be answering a request from the very peer it just finished syncing
      // with as the initiator, and that responder call reads `liveRef
      // .current` to check and allocate its own replay-protection counters.
      liveRef.current = reducer(liveRef.current, action)
      dispatch(action)
      logExchangeOutcome(deviceLabel, result)
    },
    [logExchangeOutcome],
  )

  // The listener is not opened by the main process on launch — see
  // `electron/syncServer.ts`. This is the side that knows whether there is
  // anything to answer for, so it is the side that asks, and a returning user
  // with an 'ongoing' pairing gets their listener back the moment their state
  // has loaded.
  const [syncListener, setSyncListener] = useState<SyncListenerStatus | null>(null)
  /**
   * The same status, reachable from the two long-lived sync effects — same
   * mechanism and same reason as `liveRef`.
   *
   * Reading `syncListener` directly inside them would pin it at `null` for the
   * life of the app: both depend on `[ready, bridge]`, so their closures are
   * built once, before anything has bound to an interface. A device that never
   * announces where it is listening is a device the other side can never call
   * back — which is the whole point of the announcement.
   */
  const syncListenerRef = useRef<SyncListenerStatus | null>(null)
  syncListenerRef.current = syncListener
  const wantsSyncListener = state.pairedDevices.some((d) => d.mode === 'ongoing')

  useEffect(() => {
    if (!ready || !bridge?.applySyncListener) return
    const apply = bridge.applySyncListener
    let cancelled = false
    const run = () => {
      void apply(wantsSyncListener).then(
        (status) => {
          if (!cancelled) setSyncListener(wantsSyncListener ? status : null)
        },
        () => {
          if (!cancelled) setSyncListener(wantsSyncListener ? { listening: false, error: 'failed' } : null)
        },
      )
    }
    run()
    // A machine whose state loaded before its Wi-Fi came up has no interface to
    // bind, and would otherwise stay unreachable until the app was restarted.
    window.addEventListener('online', run)
    return () => {
      cancelled = true
      window.removeEventListener('online', run)
    }
  }, [ready, bridge, wantsSyncListener])

  const syncResponder = useRef<(request: SyncServerRequest) => void>(() => {})
  syncResponder.current = (request) => {
    void (async () => {
      const b = bridge
      if (!b?.respondToSyncServer) return
      if (!b.getSyncSecret) {
        void b.respondToSyncServer({ id: request.id, ok: false, error: 'not ready' })
        return
      }
      const outcome = await respondToSyncRequest(
        {
          findDevice: (pairId) => findPairedDevice(liveRef.current.pairedDevices, pairId),
          getSecret: (keyRef) => b.getSyncSecret!(keyRef),
          getState: () => liveRef.current,
          getCalendar: () => liveRef.current.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
          now: () => Date.now(),
          // Answering is also the moment to say where we are listening. Before
          // this, a pairing was one-directional by accident: the joiner learned
          // the host's address from the QR code, the host learned nothing, and
          // so only the joiner could ever start a sync.
          selfAddress: () => parseAddress(syncListenerRef.current?.address, SYNC_SERVER_PORT),
          secrets: secretsFor,
          // Written to `liveRef.current` synchronously, the instant the
          // freshness check passes — not batched with the rest of this
          // exchange's outcome below, which only lands after the full
          // exchange (keystore IPC, conflict resolution, sealing the reply)
          // completes. See `RespondHooks.commitAcceptedSeq`'s doc.
          commitAcceptedSeq: (pairId, seq) => {
            const action = { type: 'commitSyncSeq' as const, deviceId: pairId, seq }
            liveRef.current = reducer(liveRef.current, action)
            dispatch(action)
          },
        },
        request.pairId,
        request.envelope,
      )
      if ('error' in outcome) {
        void b.respondToSyncServer({ id: request.id, ok: false, error: outcome.error })
        return
      }

      const { device, patch, conflicts } = outcome.outcome
      const action = {
        type: 'applySyncResult' as const,
        deviceId: device.id,
        patch,
        conflicts,
        syncedAt: Date.now(),
      }
      // Computed synchronously against the same snapshot `respondToSyncRequest`
      // itself read, so what reaches disk below and what `dispatch` renders
      // agree — see `reducer`'s export note for why calling it directly here
      // is sanctioned rather than reimplementing the merge.
      const nextState = reducer(liveRef.current, action)
      // Written back immediately, ahead of React's own re-render (which would
      // only update `liveRef.current` on its own schedule): a second sync
      // exchange with this same peer — see `syncLoop.ts`'s module doc on two
      // paired devices polling each other within the same window — reads
      // `liveRef.current` via `findDevice` to check and allocate its own
      // replay-protection counters, and must see this exchange's result
      // rather than a stale pre-exchange snapshot.
      liveRef.current = nextState
      dispatch(action)
      logExchangeOutcome(device.label, outcome.outcome)

      // Only ACK success once the patch this device is about to tell the peer
      // it has is actually durable — not merely applied in memory and due to
      // be written on the next debounced save. Before this, a crash between
      // the ACK below and that debounce tick left the peer believing this
      // device had the data when state.json was never touched.
      try {
        await b.saveState(nextState)
        void b.respondToSyncServer({ id: request.id, ok: true, envelope: outcome.envelope })
      } catch (err) {
        void b.respondToSyncServer({
          id: request.id,
          ok: false,
          error: err instanceof Error ? err.message : 'could not save',
        })
      }
    })()
  }

  useEffect(() => {
    if (!bridge?.onSyncServerRequest) return
    return bridge.onSyncServerRequest((request) => syncResponder.current(request))
  }, [bridge])

  useEffect(() => {
    if (!ready || !bridge?.syncRequest || !bridge?.getSyncSecret) return
    const b = bridge
    const loop = new SyncLoop({
      now: () => Date.now(),
      getState: () => liveRef.current,
      getCalendar: () => liveRef.current.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
      getPairedDevices: () => liveRef.current.pairedDevices,
      selfAddress: () => parseAddress(syncListenerRef.current?.address, SYNC_SERVER_PORT),
      getSecret: (keyRef) => b.getSyncSecret!(keyRef),
      transport: { postJson: (url, body) => b.syncRequest!(url, body) },
      secrets: secretsFor,
      onSynced: (device, result, at) => applyExchangeOutcome(device.label, device.id, result, at),
      onError: (device, message) => {
        addLog({ kind: 'error', level: 'warn', title: `Could not sync with ${device.label}`, detail: message })
      },
    })
    loop.start()
    // How the "sync now" button reaches this loop. It must not build one of its
    // own: a second loop would race this one for the same device's replay
    // counter, and would have no `secrets`, so a hand-triggered sync would
    // quietly stop carrying mailbox passwords across.
    registerSyncLoop(loop)
    return () => {
      // Deregister first. A press landing in the gap would otherwise drive a
      // loop already on its way out.
      registerSyncLoop(null)
      loop.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bridge])

  // --- offline queue ------------------------------------------------------
  //
  // One pass every 20 seconds, plus one the moment the OS says the network is
  // back. The timer is not redundant with the `online` event: a captive portal
  // or a VPN reconnecting never fires it, and a queue that only drains on an
  // event nobody sends is a queue that never drains.

  const flushing = useRef(false)

  const flushOutbox = useCallback(async () => {
    if (flushing.current) return
    const live = liveRef.current
    if (live.settings.offlineQueueEnabled === false) return
    if (!probablyOnline()) return
    const due = dueItems(live.outbox)
    if (due.length === 0) return

    flushing.current = true
    try {
      for (const item of due) {
        dispatch({ type: 'patchOutbox', id: item.id, patch: { status: 'sending' } })
        // `queue: false` — a retry that failed must update this item, not
        // enqueue a second copy of it.
        const result = await sendDraftNow(item.draft, { queue: false, jobId: item.jobId })
        if (result.ok) {
          dispatch({ type: 'dequeue', id: item.id })
        } else {
          const next = afterAttempt(item, result)
          if (next) dispatch({ type: 'patchOutbox', id: item.id, patch: next })
        }
      }
    } finally {
      flushing.current = false
    }
  }, [sendDraftNow])

  useEffect(() => {
    if (!ready || !bridge) return
    const run = () => void flushOutbox()
    const timer = window.setInterval(run, 20_000)
    window.addEventListener('online', run)
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisible)
    run()
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', run)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ready, bridge, flushOutbox])

  // --- draft history ------------------------------------------------------
  //
  // Sampled rather than triggered on change: `captureSnapshot` already refuses
  // duplicates and enforces a minimum gap, so the only thing a timer adds is a
  // bound on how much unrecorded typing can exist at any moment.

  useEffect(() => {
    if (!ready || state.settings.draftHistoryEnabled === false) return
    const timer = window.setInterval(() => dispatch({ type: 'snapshotDraft', reason: 'auto' }), 20_000)
    return () => window.clearInterval(timer)
  }, [ready, state.settings.draftHistoryEnabled])

  const snapshotDraft = useCallback((reason: SnapshotReason = 'manual') => {
    dispatch({ type: 'snapshotDraft', reason })
  }, [])

  const restoreSnapshot = useCallback((id: string) => {
    dispatch({ type: 'restoreSnapshot', id })
  }, [])

  const queueDraft = useCallback((draft: MessageDraft) => {
    dispatch({ type: 'enqueue', item: queueItem(draft) })
  }, [])

  // --- undo ---------------------------------------------------------------
  //
  // Deliberately *not* persisted. An undo offered after a restart would claim
  // to restore something from a session whose other half is gone — and the
  // things worth undoing here (a deleted reminder, a cleared log) are decisions
  // people reverse within seconds, not next Tuesday.


  /**
   * Memoised because this object *is* the context value.
   *
   * Built as a fresh literal, it was a new identity on every render of the
   * provider — so every component calling `useApp()` re-rendered on every
   * state change anywhere, whether or not it read the part that changed. One
   * character typed into the message body re-rendered the whole tree,
   * including the command palette (which stays mounted and rebuilds a list of
   * every contact, template and job) and whichever windowed list was on
   * screen. The actions below are all `useCallback`s already; only the values
   * genuinely move.
   */
  const undoLabel = undoStack[0]?.label ?? null
  const api = useMemo<AppApi>(
    () => ({
      state,
      ready,
      bridge,
      i18n,
      dispatch,
      bootError,
      repairedJobs,
      schedulerUnreachable,
      saveFailing,
      permissions,
      fixPermission,
      addLog,
      saveAccount,
      deleteAccount,
      sendDraftNow,
      scheduleDraft,
      toggleJob,
      deleteJob,
      runJobNow,
      resetEverything,
      relocateData,
      saveInboxAccount,
      syncInboxAccount,
      testInboxAccount,
      getInboxMessageBody,
      ensureInboxAttachment,
      markInboxMessagesRead,
      tagInboxMessages,
      deleteInboxMessages,
      purgeInboxMessages,
      restoreInboxMessages,
      clearRemovedMessages,
      snapshotDraft,
      restoreSnapshot,
      queueDraft,
      flushOutbox,
      pushUndo,
      undo,
      undoLabel,
      revokePairedDevice,
      restoreSyncConflict,
      syncListener,
    }),
    [
      state,
      ready,
      bridge,
      i18n,
      bootError,
      repairedJobs,
      schedulerUnreachable,
      saveFailing,
      permissions,
      fixPermission,
      addLog,
      saveAccount,
      deleteAccount,
      sendDraftNow,
      scheduleDraft,
      toggleJob,
      deleteJob,
      runJobNow,
      resetEverything,
      relocateData,
      saveInboxAccount,
      syncInboxAccount,
      testInboxAccount,
      getInboxMessageBody,
      ensureInboxAttachment,
      markInboxMessagesRead,
      tagInboxMessages,
      deleteInboxMessages,
      purgeInboxMessages,
      restoreInboxMessages,
      clearRemovedMessages,
      snapshotDraft,
      restoreSnapshot,
      queueDraft,
      flushOutbox,
      pushUndo,
      undo,
      undoLabel,
      revokePairedDevice,
      restoreSyncConflict,
      syncListener,
    ],
  )

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>
}
