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
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  defaultInboxAccountState,
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
  type SecretKind,
  type SendResult,
  type Settings,
  type Template,
} from '../core/types'
import {
  getBridge,
  type DataFolderChange,
  type InboxMessageBody,
  type JobEvent,
  type JobRun,
  type PlatformBridge,
} from '../core/bridge'
// Type-only: a value import would pull the Capacitor runtime into the desktop
// and web bundles for the sake of three methods that do not exist there.
import type { AndroidPermissionApi } from '../core/bridge-android'
import type { PermissionSnapshot } from '../core/health'
import { pruneLogs } from '../core/logRetention'
import {
  applyQuietHours,
  computeOccurrences,
  migrateSkipWeekends,
  rearm,
  type QuietHours,
} from '../core/schedule'
import {
  applyWorkCalendarDetailed,
  calendarWarning,
  DEFAULT_WORK_CALENDAR,
  type CalendarWarning,
} from '../core/workCalendar'
import { buildMergeMessages } from '../core/mergeVars'
import { captureSnapshot, type SnapshotReason } from '../core/snapshots'
import {
  mergeHits,
  recordRecipients as recordRecipientUse,
  type NewHit,
} from '../core/codeHistory'
import {
  afterAttempt,
  dueItems,
  isQueueable,
  OUTBOX_CAP,
  probablyOnline,
  queueItem,
  type OutboxItem,
} from '../core/outbox'
import { evaluateConditions } from '../core/conditions'
import { applyRun } from '../core/jobRun'
import { forTransport } from '../core/markdown'
import { mergeRemoved, rememberRemoved, restoreRemoved, withoutRemoved } from '../core/inboxRemoval'
import { executeControl } from './controlExecutor'
import type { ControlRequest } from '../core/control'
import { createI18n, detectLocale, localeMeta, type I18n } from '../i18n'

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
): { occurrences: number[]; warning?: CalendarWarning } {
  const calendar = settings.workCalendar ?? DEFAULT_WORK_CALENDAR
  const { occurrences: shaped, adjustment } = applyWorkCalendarDetailed(
    occurrences,
    job.recurrence.workdayPolicy ?? 'off',
    calendar,
  )
  return {
    occurrences: applyQuietHours(shaped, quietFrom(settings)),
    warning: calendarWarning(adjustment, now),
  }
}

/**
 * Recompute one job's list from its *rule*, not from its stored list.
 *
 * Stored occurrences have already been shifted. Re-shaping them would apply
 * the calendar twice, and — worse — the original time is not recoverable from
 * them, so a user who removed a holiday could never get the reminder back on
 * the day they had first asked for.
 */
function rebuildJob(job: ScheduledJob, settings: Settings, now = Date.now()): ScheduledJob {
  const recurrence = migrateSkipWeekends(job.recurrence)
  const { occurrences, warning } = shapeOccurrences(
    computeOccurrences(recurrence, {
      runsSoFar: job.runCount,
      count: 24,
      after: now,
      calendar: settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
    }),
    { recurrence },
    settings,
    now,
  )
  return { ...job, recurrence, occurrences, calendarWarning: warning }
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

/**
 * Delete a batch of stored credentials and report, in one string, whichever
 * ones refused to go.
 *
 * Every caller here deletes secrets as the last step of removing something the
 * user can see, so a rejected promise has no natural place to surface: the row
 * is already gone. Returning the failures instead of swallowing them lets the
 * caller say so, and the empty case stays cheap — `null` means "all clear".
 */
async function forgetSecrets(
  bridge: PlatformBridge | null,
  targets: Array<[accountId: string, kind?: SecretKind]>,
): Promise<string | null> {
  if (!bridge) return null
  const failures: string[] = []
  for (const [accountId, kind] of targets) {
    try {
      await bridge.deleteSecret(accountId, kind)
    } catch (e) {
      failures.push(`${accountId}${kind ? `/${kind}` : ''}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return failures.length ? failures.join('; ') : null
}

function initialState(): AppState {
  return {
    accounts: [],
    jobs: [],
    contacts: [],
    templates: [],
    logs: [],
    settings: { ...DEFAULT_SETTINGS },
    draft: emptyDraft(),
    inboxAccounts: [],
    draftSnapshots: [],
    outbox: [],
    codeHits: [],
    recentRecipients: [],
    schemaVersion: SCHEMA_VERSION,
  }
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
  | { type: 'removeAccount'; id: string }
  | { type: 'upsertJob'; job: ScheduledJob }
  | { type: 'jobRan'; jobId: string; run: JobRun }
  | { type: 'removeJob'; id: string }
  | { type: 'upsertContact'; contact: Contact }
  | { type: 'removeContact'; id: string }
  | { type: 'upsertTemplate'; template: Template }
  | { type: 'removeTemplate'; id: string }
  | { type: 'log'; entry: LogEntry }
  | { type: 'clearLogs' }
  | { type: 'rebaseAttachments'; from: string; to: string }
  | { type: 'upsertInboxAccount'; inbox: InboxAccountState; origin?: 'sync' }
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
  | { type: 'reset' }

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
      const settings = { ...state.settings, ...action.patch }
      const touchesRetention =
        action.patch.logRetentionDays !== undefined || action.patch.logMaxEntries !== undefined
      const touchesCalendar = action.patch.workCalendar !== undefined
      const touchesQuiet =
        action.patch.quietHoursEnabled !== undefined ||
        action.patch.quietStart !== undefined ||
        action.patch.quietEnd !== undefined

      let jobs = state.jobs
      let logs = state.logs
      if (touchesCalendar || touchesQuiet) {
        const now = Date.now()
        const fresh: LogEntry[] = []
        jobs = state.jobs.map((job) => {
          // Quiet hours apply to every armed job; the calendar only reaches the
          // ones that opted in, so the rest are left strictly untouched — no new
          // `updatedAt`, no re-arm, no churn on the device.
          if (!job.enabled) return job
          if (touchesCalendar && !touchesQuiet && (job.recurrence.workdayPolicy ?? 'off') === 'off') {
            return job
          }
          const next = rebuildJob(job, settings, now)
          if (
            sameList(next.occurrences, job.occurrences) &&
            next.recurrence === job.recurrence &&
            next.calendarWarning === undefined &&
            job.calendarWarning === undefined
          ) {
            return job
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
        if (fresh.length > 0) logs = pruneLogs([...fresh, ...logs], settings)
      }

      return {
        ...state,
        settings,
        jobs,
        logs: touchesRetention ? pruneLogs(logs, settings) : logs,
      }
    }

    case 'setDraft':
      return { ...state, draft: { ...state.draft, ...action.patch } }

    case 'resetDraft':
      return {
        ...state,
        draft: emptyDraft(action.accountId ?? state.draft.accountId),
      }

    case 'upsertAccount': {
      const exists = state.accounts.some((a) => a.id === action.account.id)
      const accounts = exists
        ? state.accounts.map((a) => (a.id === action.account.id ? action.account : a))
        : [...state.accounts, action.account]
      // A configured default wins; otherwise the first account added becomes
      // the draft's sender automatically.
      const draft =
        state.draft.accountId || exists
          ? state.draft
          : { ...state.draft, accountId: state.settings.defaultAccountId || action.account.id }
      return { ...state, accounts, draft }
    }

    case 'removeAccount': {
      const accounts = state.accounts.filter((a) => a.id !== action.id)
      // Any job pointing at the deleted account is disabled rather than
      // silently retargeted — sending from a different address without saying
      // so would be worse than not sending.
      const jobs = state.jobs.map((j) =>
        j.draft.accountId === action.id ? { ...j, enabled: false, status: 'paused' as const } : j,
      )
      // A default pointing at a now-deleted account is dead state, not a
      // preference — clear it so the next account falls back cleanly.
      const settings =
        state.settings.defaultAccountId === action.id
          ? { ...state.settings, defaultAccountId: undefined }
          : state.settings
      const draft =
        state.draft.accountId === action.id
          ? { ...state.draft, accountId: settings.defaultAccountId || accounts[0]?.id || '' }
          : state.draft
      // An inbox for a deleted account is dead state, not a paused feature —
      // there is no credential left to sync it with.
      const inboxAccounts = state.inboxAccounts.filter((i) => i.accountId !== action.id)
      return { ...state, accounts, jobs, draft, inboxAccounts, settings }
    }

    case 'upsertJob': {
      const exists = state.jobs.some((j) => j.id === action.job.id)
      const jobs = exists
        ? state.jobs.map((j) => (j.id === action.job.id ? action.job : j))
        : [...state.jobs, action.job]
      return { ...state, jobs }
    }

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
      return { ...state, jobs: state.jobs.filter((j) => j.id !== action.id) }

    case 'upsertContact': {
      const exists = state.contacts.some((c) => c.id === action.contact.id)
      return {
        ...state,
        contacts: exists
          ? state.contacts.map((c) => (c.id === action.contact.id ? action.contact : c))
          : [...state.contacts, action.contact],
      }
    }

    case 'removeContact':
      return { ...state, contacts: state.contacts.filter((c) => c.id !== action.id) }

    case 'upsertTemplate': {
      const exists = state.templates.some((t) => t.id === action.template.id)
      return {
        ...state,
        templates: exists
          ? state.templates.map((t) => (t.id === action.template.id ? action.template : t))
          : [...state.templates, action.template],
      }
    }

    case 'removeTemplate':
      return { ...state, templates: state.templates.filter((t) => t.id !== action.id) }

    case 'log':
      return { ...state, logs: pruneLogs([action.entry, ...state.logs], state.settings) }

    case 'clearLogs':
      return { ...state, logs: [] }

    /**
     * The data folder moved, so every snapshot path saved inside a job now
     * points at a file that is no longer there. Without this, a reminder
     * scheduled last week would fire and quietly send with nothing attached.
     */
    case 'rebaseAttachments': {
      const { from, to } = action
      if (!from || !to || from === to) return state
      const rebase = (p: string): string =>
        p.startsWith(from) ? to + p.slice(from.length) : p
      return {
        ...state,
        jobs: state.jobs.map((job) => ({
          ...job,
          draft: {
            ...job.draft,
            attachments: job.draft.attachments.map((a) =>
              a.source === 'copy' ? { ...a, path: rebase(a.path) } : a,
            ),
          },
        })),
        draft: {
          ...state.draft,
          attachments: state.draft.attachments.map((a) =>
            a.source === 'copy' ? { ...a, path: rebase(a.path) } : a,
          ),
        },
      }
    }

    case 'upsertInboxAccount': {
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
      const inbox: InboxAccountState = {
        ...action.inbox,
        ...preferences,
        removed,
        messages: withoutRemoved([...action.inbox.messages], removed)
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
      const idSet = new Set(action.ids)
      const inboxAccounts = state.inboxAccounts.map((i) =>
        i.accountId !== action.accountId
          ? i
          : {
              ...i,
              messages: i.messages.map((m) => (idSet.has(m.id) ? { ...m, ...action.patch } : m)),
            },
      )
      return { ...state, inboxAccounts }
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

    /**
     * Record the current draft, if it is worth recording. `captureSnapshot`
     * returns null for "nothing changed" and for "too soon", and returning the
     * identical state object in that case is what stops an autosave from
     * re-rendering the tree while someone is mid-sentence.
     */
    case 'snapshotDraft': {
      if (state.settings.draftHistoryEnabled === false) return state
      const next = captureSnapshot(state.draftSnapshots, state.draft, action.reason)
      return next ? { ...state, draftSnapshots: next } : state
    }

    /**
     * Put a past version back on screen — and snapshot what it replaces first,
     * so "restore" is itself undoable. Restoring over unsaved work and losing
     * it would reproduce, inside the recovery feature, the exact problem the
     * recovery feature exists to solve.
     */
    case 'restoreSnapshot': {
      const target = state.draftSnapshots.find((s) => s.id === action.id)
      if (!target) return state
      const preserved =
        captureSnapshot(state.draftSnapshots, state.draft, 'beforeRestore') ?? state.draftSnapshots
      return { ...state, draft: { ...target.draft }, draftSnapshots: preserved }
    }

    case 'clearSnapshots':
      return { ...state, draftSnapshots: [] }

    case 'enqueue':
      return { ...state, outbox: [...state.outbox, action.item].slice(-OUTBOX_CAP) }

    case 'patchOutbox':
      return {
        ...state,
        outbox: state.outbox.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i)),
      }

    case 'dequeue':
      return { ...state, outbox: state.outbox.filter((i) => i.id !== action.id) }

    case 'clearOutbox':
      return { ...state, outbox: [] }

    /**
     * `mergeHits` returns the identical array when nothing is new, and the
     * identity check here turns that into an identical *state* object —
     * extraction re-runs every time a body lands in the cache, and without
     * this a sync of twenty messages would re-render the app twenty times to
     * arrive at the list it already had.
     */
    case 'recordCodes': {
      const codeHits = mergeHits(state.codeHits, action.hits)
      return codeHits === state.codeHits ? state : { ...state, codeHits }
    }

    case 'markCodeCopied': {
      let changed = false
      const codeHits = state.codeHits.map((h) => {
        if (h.id !== action.id || h.copiedAt) return h
        changed = true
        return { ...h, copiedAt: Date.now() }
      })
      return changed ? { ...state, codeHits } : state
    }

    /* Reading is what the click means; copying is what it also happens to do.
       Kept as its own action so the mark survives a clipboard failure. */
    case 'markCodeRead': {
      let changed = false
      const codeHits = state.codeHits.map((h) => {
        if (h.id !== action.id || h.readAt) return h
        changed = true
        return { ...h, readAt: Date.now() }
      })
      return changed ? { ...state, codeHits } : state
    }

    case 'markAllCodesRead': {
      const now = Date.now()
      let changed = false
      const codeHits = state.codeHits.map((h) => {
        if (h.readAt) return h
        changed = true
        return { ...h, readAt: now }
      })
      return changed ? { ...state, codeHits } : state
    }

    case 'clearCodeHits':
      return { ...state, codeHits: [] }

    case 'recordRecipients': {
      const recentRecipients = recordRecipientUse(
        state.recentRecipients,
        action.addresses,
        action.names,
      )
      return recentRecipients === state.recentRecipients
        ? state
        : { ...state, recentRecipients }
    }

    case 'reset':
      return initialState()

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AppApi {
  state: AppState
  ready: boolean
  bridge: PlatformBridge | null
  i18n: I18n
  dispatch: (action: Action) => void
  /**
   * Why start-up stopped, when it did. `ready` stays false in that case, so
   * without this the UI has no way to tell "still loading" from "gave up".
   */
  bootError: string | null
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
   * What Android currently permits. `null` on desktop and web, where neither
   * question exists, and until the first read comes back.
   *
   * Re-read when the window becomes visible again, because the only way to
   * change either of these is to leave for a system settings screen and come
   * back — and nothing tells the page that happened.
   */
  permissions: PermissionSnapshot | null
  /** Raise the notification dialog, or open the settings screen for it. */
  fixPermission: (
    what: 'requestNotifications' | 'openNotificationSettings' | 'openExactAlarmSettings',
  ) => Promise<void>

  addLog: (entry: Omit<LogEntry, 'id' | 'at'>) => void
  saveAccount: (account: MailAccount, secret?: string) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  /** `queue: false` opts out of the offline queue — used by the queue's own retry. */
  sendDraftNow: (draft: MessageDraft, opts?: { queue?: boolean }) => Promise<SendResult>
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
  syncInboxAccount: (accountId: string, override?: InboxAccountState) => Promise<void>
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
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
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
  const i18n = useMemo(() => createI18n(locale), [locale])

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
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err))
        return
      }
      if (cancelled) return
      setBridge(b)

      let stored: Awaited<ReturnType<PlatformBridge['loadState']>>
      try {
        stored = await b.loadState()
      } catch (err) {
        if (!cancelled) {
          setBootError(
            `Your saved data could not be read (${
              err instanceof Error ? err.message : String(err)
            }).`,
          )
        }
        return
      }
      if (cancelled) return

      if (stored) {
        const merged: AppState = {
          ...initialState(),
          ...stored,
          settings: { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) },
          draft: { ...emptyDraft(), ...(stored.draft ?? {}) },
          draftSnapshots: stored.draftSnapshots ?? [],
          outbox: stored.outbox ?? [],
          codeHits: stored.codeHits ?? [],
          recentRecipients: stored.recentRecipients ?? [],
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
        const calendar = merged.settings.workCalendar ?? DEFAULT_WORK_CALENDAR
        merged.jobs = merged.jobs.map((job) => {
          const recurrence = migrateSkipWeekends(job.recurrence)
          if (!job.enabled) return recurrence === job.recurrence ? job : { ...job, recurrence }
          const { upcoming } = rearm(recurrence, job.occurrences ?? [], {
            runsSoFar: job.runCount,
            calendar,
          })
          const shaped = shapeOccurrences(upcoming, { recurrence }, merged.settings)
          return {
            ...job,
            recurrence,
            occurrences: shaped.occurrences,
            calendarWarning: shaped.warning,
          }
        })

        // Anything left mid-flight by a crash or a quit is waiting again, not
        // sending. Without this an item stuck in `sending` is never retried and
        // never reported — the queue's own silent failure.
        merged.outbox = merged.outbox.map((i) =>
          i.status === 'sending' ? { ...i, status: 'waiting' as const } : i,
        )

        dispatch({ type: 'hydrate', state: merged })
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
            if (attempt === saveToken.current) lastSaved.current = state
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
                  if (attempt === saveToken.current) lastSaved.current = state
                })
                .catch(() => {})
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
          if (attempt === saveToken.current) lastSaved.current = pending
        })
        // Same reasoning as the debounced save: only a write that landed counts
        // as saved. On `visibilitychange` the app is backgrounded rather than
        // closing, so a flush that failed here must stay retryable — claiming
        // success would make every later flush skip it.
        .catch((err) => {
          console.error('[aevistle] could not flush state:', err)
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
            .map((j) => ({ ...j, draft: forTransport(j.draft) })),
          state.accounts,
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
  }, [bridge, ready, jobSignature, accountSignature])

  // --- theme, accent, density, direction ---------------------------------
  useEffect(() => {
    const root = document.documentElement
    const { themeMode, accent, density, listDensity } = state.settings
    if (themeMode === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', themeMode)
    root.setAttribute('data-accent', accent)
    root.setAttribute('data-density', density)
    root.setAttribute('data-list-density', listDensity ?? 'standard')
    const meta = localeMeta(locale)
    root.setAttribute('lang', meta.intlTag)
    root.setAttribute('dir', meta.dir)
  }, [state.settings, locale])

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
      addLog({
        kind: 'send',
        level: event.result.ok ? 'info' : 'error',
        title: event.result.ok ? 'Scheduled send completed' : 'Scheduled send failed',
        detail: event.result.error,
        jobId: event.jobId,
        recipients: event.result.accepted.length,
        durationMs: event.result.durationMs,
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
        for (const { jobId, ...run } of runs) dispatch({ type: 'jobRan', jobId, run })
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
  }, [bridge, ready])

  // --- undo ---------------------------------------------------------------
  //
  // Deliberately *not* persisted. An undo offered after a restart would claim
  // to restore something from a session whose other half is gone — and the
  // things worth undoing here (a deleted reminder, a cleared log) are decisions
  // people reverse within seconds, not next Tuesday.
  //
  // Stored as the *inverse actions* rather than a snapshot of the whole state,
  // so undoing a deleted contact does not also roll back the four unrelated
  // things that happened while the toast was still on screen.

  type UndoEntry = { label: string; actions: Action[] }
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  /**
   * The same stack, readable synchronously.
   *
   * `undo()` has to return what it just restored so the caller can name it in
   * a toast, and a functional `setState` updater cannot be relied on to have
   * run by the time the call returns. The state copy exists only to re-render
   * whatever shows that an undo is available.
   */
  const undoRef = useRef<UndoEntry[]>([])

  const pushUndo = useCallback((label: string, actions: Action[]) => {
    undoRef.current = [{ label, actions }, ...undoRef.current].slice(0, 20)
    setUndoStack(undoRef.current)
  }, [])

  const undo = useCallback((): string | null => {
    const [top, ...rest] = undoRef.current
    if (!top) return null
    for (const action of top.actions) dispatch(action)
    undoRef.current = rest
    setUndoStack(rest)
    return top.label
  }, [])

  // --- actions ------------------------------------------------------------

  const saveAccount = useCallback(
    async (account: MailAccount, secret?: string) => {
      if (!bridge) return
      if (secret) {
        await bridge.setSecret(account.id, secret)
      }
      const hasSecret = await bridge.hasSecret(account.id)
      dispatch({
        type: 'upsertAccount',
        account: { ...account, hasSecret, updatedAt: Date.now() },
      })
    },
    [bridge],
  )

  const deleteAccount = useCallback(
    async (id: string) => {
      // A deleted account's IMAP credential and cached mail are dead weight —
      // there is no UI left that could ever ask for them again.
      const failed = await forgetSecrets(bridge, [[id], [id, 'imap']])
      dispatch({ type: 'removeAccount', id })
      // The row disappears either way, so a swallowed failure here reads as
      // "the password is gone" while it is still sitting in the OS credential
      // store. Logged after the dispatch so the entry survives it.
      if (failed) {
        addLog({
          kind: 'security',
          level: 'warn',
          title: 'Account removed, but its saved password could not be deleted',
          detail: failed,
        })
      }
    },
    [bridge, addLog],
  )

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
    async (draft: MessageDraft, opts: { queue?: boolean } = {}): Promise<SendResult> => {
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
        ? buildMergeMessages(draft, live.contacts, { enabled: true, locale })
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
        dispatch({ type: 'enqueue', item: queueItem(draft, result) })
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
      const { occurrences, warning } = shapeOccurrences(
        computeOccurrences(finalJob.recurrence, {
          runsSoFar: finalJob.runCount,
          count: 24,
          calendar: state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
        }),
        finalJob,
        state.settings,
      )
      finalJob = { ...finalJob, occurrences, calendarWarning: warning, updatedAt: Date.now() }

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
      const rebuilt = enabled ? rebuildJob(job, state.settings) : null
      dispatch({
        type: 'upsertJob',
        job: {
          ...job,
          ...(rebuilt ?? {}),
          enabled,
          status: enabled ? 'armed' : 'paused',
          // A paused job's warning describes a list that no longer exists.
          ...(enabled ? {} : { occurrences: [], calendarWarning: undefined }),
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
    const inbound = new Map<string, number>()
    for (const inbox of live.inboxAccounts) {
      for (const m of inbox.messages) {
        const key = (/<([^>]+)>/.exec(m.from)?.[1] ?? m.from).trim().toLowerCase()
        const prev = inbound.get(key)
        if (prev === undefined || m.date > prev) inbound.set(key, m.date)
      }
    }
    return {
      now: Date.now(),
      inboxKnown: live.inboxAccounts.some((i) => i.enabled && i.lastSyncAt !== undefined),
      latestInboundFrom: (address: string) => inbound.get(address.trim().toLowerCase()),
    }
  }, [])

  const runJobNow = useCallback(
    async (id: string) => {
      const job = state.jobs.find((j) => j.id === id)
      if (!job) return null

      const verdict = evaluateConditions(job.conditions, job.draft, {
        ...conditionContext(),
        lastRunAt: job.lastRunAt,
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

      const result = await sendDraftNow(job.draft)
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
    [state.jobs, sendDraftNow, conditionContext, addLog],
  )

  /**
   * Read Android's view of its own permissions, now and whenever the window
   * comes back to the foreground.
   *
   * The foreground check is the load-bearing half. Both of these are changed on
   * a system settings screen, which means leaving the app — so the only moment
   * the answer can have changed is the moment we return. Without it the strip
   * would keep saying "notifications are off" after the user had just turned
   * them on, which reads as the fix not working.
   */
  useEffect(() => {
    if (!bridge) return
    const android = bridge as Partial<AndroidPermissionApi>
    if (!android.permissionState) return
    let live = true
    const read = () => {
      android
        .permissionState?.()
        .then((s) => {
          if (live) setPermissions(s)
        })
        // A permission read that fails tells us nothing, and there is nothing
        // the user could do about it. Leaving the previous answer in place is
        // better than flapping the strip.
        .catch(() => {})
    }
    read()
    const onVisible = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [bridge])

  const fixPermission = useCallback(
    async (what: 'requestNotifications' | 'openNotificationSettings' | 'openExactAlarmSettings') => {
      const android = bridge as Partial<AndroidPermissionApi> | null
      if (!android) return
      try {
        if (what === 'requestNotifications') {
          const after = await android.requestNotificationPermission?.()
          if (after) setPermissions(after)
          return
        }
        // The two settings screens answer nothing themselves — the result
        // arrives via the visibility listener above, when the user comes back.
        if (what === 'openNotificationSettings') await android.openNotificationSettings?.()
        else await android.openExactAlarmSettings?.()
      } catch {
        // Same reasoning as the read: an OEM build with no such screen is not
        // something to throw a dialog about.
      }
    },
    [bridge],
  )

  const resetEverything = useCallback(async () => {
    const failed = await forgetSecrets(
      bridge,
      state.accounts.flatMap((a) => [[a.id], [a.id, 'imap'] as [string, SecretKind]]),
    )
    // The cached copies of remote images live outside the state document, so
    // clearing state does not touch them. The pictures themselves were public
    // on someone else's server, but the folder of them is a record of which
    // mail was opened — and a reset that leaves it behind has not done what it
    // said. Failure is deliberately silent: unlike a password, nothing here is
    // a secret, and a stubborn cache file is not a reason to report a reset as
    // failed when the accounts and schedule really are gone.
    await bridge?.clearImageCache?.().catch(() => {})
    dispatch({ type: 'reset' })
    // "Reset everything" is the strongest promise in the app. If a password
    // outlived it, that has to be said out loud rather than covered by the
    // success toast the caller shows next.
    if (failed) {
      addLog({
        kind: 'security',
        level: 'warn',
        title: 'Reset finished, but some saved passwords could not be deleted',
        detail: failed,
      })
    }
  }, [bridge, state.accounts, addLog])

  /**
   * Move the data folder and repair everything that pointed into the old one.
   *
   * The bridge only moves files. The paths recorded inside each scheduled job
   * are ours to fix, and the platform scheduler is holding a copy of those jobs
   * — so it is re-armed here explicitly rather than waiting for the signature
   * effect, which watches fire times and would not notice a path change.
   */
  const relocateData = useCallback(
    async (change: DataFolderChange, previousPath: string) => {
      if (!change.changed || !change.moved) return
      const from = previousPath
      const to = change.path
      if (!from || from === to) return

      dispatch({ type: 'rebaseAttachments', from, to })

      const rebase = (p: string) => (p.startsWith(from) ? to + p.slice(from.length) : p)
      const repaired = state.jobs
        .filter((j) => j.enabled)
        .map((job) => ({
          ...job,
          draft: {
            ...job.draft,
            attachments: job.draft.attachments.map((a) =>
              a.source === 'copy' ? { ...a, path: rebase(a.path) } : a,
            ),
          },
        }))
      try {
        await bridge?.syncJobs(repaired, state.accounts)
      } catch (e) {
        // The files did move, so the caller reports success and nothing else in
        // this flow would ever mention that the scheduler is still holding
        // paths into the old folder. Left silent, the first symptom is a
        // scheduled send going out hours later with a missing attachment.
        addLog({
          kind: 'schedule',
          level: 'error',
          title: 'Data folder moved, but reminders still point at the old one',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [bridge, state.jobs, state.accounts, addLog],
  )

  const syncInboxAccount = useCallback(
    async (accountId: string, override?: InboxAccountState) => {
      if (!bridge?.syncInbox) return
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
      try {
        const result = await bridge.syncInbox(config)
        dispatch({ type: 'upsertInboxAccount', inbox: result, origin: 'sync' })
      } catch (e) {
        dispatch({
          type: 'upsertInboxAccount',
          inbox: { ...config, lastSyncError: e instanceof Error ? e.message : String(e) },
          origin: 'sync',
        })
      }
    },
    [bridge, state.inboxAccounts],
  )

  const saveInboxAccount = useCallback(
    async (config: InboxAccountState, secret?: string) => {
      if (!bridge) return
      if (secret) await bridge.setSecret(config.accountId, secret, 'imap')
      dispatch({ type: 'upsertInboxAccount', inbox: config })
      // Called even when disabling: syncInbox() is a no-op for a disabled
      // config on every platform, but a platform with a native background
      // sync (Android) needs the round trip to learn the account turned off.
      await syncInboxAccount(config.accountId, config)
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

  const markInboxMessagesRead = useCallback(
    async (accountId: string, ids: string[], seen: boolean) => {
      dispatch({ type: 'patchInboxMessages', accountId, ids, patch: { seen } })
      if (!bridge?.setMessageFlags) return
      const inbox = state.inboxAccounts.find((i) => i.accountId === accountId)
      if (!inbox) return
      const targets = inbox.messages.filter((m) => ids.includes(m.id))
      await Promise.all(
        targets.map((m) => bridge.setMessageFlags!(inbox, m.folderPath, m.uid, { seen })),
      ).catch(() => {
        /* server mirror is best-effort — local state already changed above */
      })
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

    const runAll = () => {
      for (const id of ids) {
        if (!stopped) void syncInboxAccount(id)
      }
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

  // Start or stop the loopback server whenever either switch moves.
  const controlEnabled = state.settings.controlEnabled === true
  const controlAllowSending = state.settings.controlAllowSending === true
  useEffect(() => {
    if (!ready || !bridge?.applyControl) return
    void bridge
      .applyControl({ enabled: controlEnabled, allowSending: controlAllowSending })
      .catch(() => {
        /* A port that will not open is reported by the settings card, which
           reads the endpoint back rather than trusting this call. */
      })
  }, [ready, bridge, controlEnabled, controlAllowSending])

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
        const result = await sendDraftNow(item.draft, { queue: false })
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


  const api: AppApi = {
    state,
    ready,
    bridge,
    i18n,
    dispatch,
    bootError,
    schedulerUnreachable,
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
    undoLabel: undoStack[0]?.label ?? null,
  }

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>
}
