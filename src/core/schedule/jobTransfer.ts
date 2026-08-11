/**
 * Moving reminders between installs.
 *
 * The point is a new machine, a reinstall, or a backup taken before doing
 * something risky. Three decisions shape the format:
 *
 * **No credentials, ever.** A job references an account by id; the account
 * itself — host, username, and the pointer to a password in the OS keystore —
 * is not exported. A file of reminders should be safe to email to yourself,
 * and one that carried a mail password would not be. The import side asks
 * which local account to attach the incoming jobs to.
 *
 * **Attachments are references, not contents.** A reminder can carry 25 MB of
 * files; a hundred of them would make an "export my schedule" button produce a
 * gigabyte. Paths travel, bytes do not — and the import reports which files
 * are missing on this machine rather than letting them fail silently at send
 * time, which is the whole failure mode this application exists to avoid.
 *
 * **Bookkeeping is reset.** `runCount`, `lastRunAt` and `lastResult` describe
 * what happened on the machine that ran them. Carrying them across would make
 * an imported job claim a history it does not have — and, worse, an "after N
 * sends" rule would arrive already spent.
 *
 * **The working calendar travels with them.** A job can carry
 * `recurrence.workdayPolicy`, which is a pointer into `Settings.workCalendar` —
 * and that used to stay behind. The reminder landed on the new machine still
 * saying "only on working days" and quietly meaning a different set of days, or
 * none. It is carried, but never applied without the caller deciding: see
 * `diffCalendars` in `core/workCalendar.ts`.
 */

import { migrateSkipWeekends } from './schedule'
import {
  diffCalendars,
  DEFAULT_WORK_CALENDAR,
  type CalendarDiff,
  type WorkCalendar,
} from './workCalendar'
import { defaultRecurrence, DEFAULT_RETRY, type MessageDraft, type ScheduledJob } from '../types'

/** Bumped only for a change that an older importer would read *wrongly*. */
export const TRANSFER_VERSION = 1

export interface TransferFile {
  format: 'aevistle.jobs'
  version: number
  exportedAt: number
  /** Purely informational; never used to decide anything on import. */
  appVersion?: string
  jobs: TransferJob[]
  /**
   * The exporting install's working calendar, when any job in the file actually
   * depends on one. Never applied on import without being asked about.
   *
   * Not a version bump: an older importer ignores the extra key and gets the
   * behaviour it already had. A newer importer reading an older file sees
   * `undefined` and says the calendar is missing, which it is.
   */
  workCalendar?: WorkCalendar
}

/** A job stripped of everything local to one install. */
export interface TransferJob {
  name: string
  enabled: boolean
  recurrence: ScheduledJob['recurrence']
  retry: ScheduledJob['retry']
  burst?: ScheduledJob['burst']
  conditions?: ScheduledJob['conditions']
  draft: Omit<MessageDraft, 'accountId'> & { accountId?: undefined }
  /** Attachment paths as they were on the exporting machine. */
  attachmentPaths: string[]
}

/** True when at least one of these jobs would read the working calendar. */
export function needsCalendar(
  jobs: Array<{ recurrence: Pick<ScheduledJob['recurrence'], 'workdayPolicy' | 'skipWeekends'> }>,
): boolean {
  return jobs.some(
    (j) => (j.recurrence.workdayPolicy ?? 'off') !== 'off' || j.recurrence.skipWeekends === true,
  )
}

export function exportJobs(
  jobs: ScheduledJob[],
  appVersion?: string,
  now = Date.now(),
  /**
   * This install's calendar. Included only when a job in the file would read
   * it — an export of three plain daily reminders has no business carrying
   * somebody's list of public holidays.
   */
  calendar?: WorkCalendar,
): TransferFile {
  return {
    format: 'aevistle.jobs',
    version: TRANSFER_VERSION,
    exportedAt: now,
    appVersion,
    workCalendar: calendar && needsCalendar(jobs) ? calendar : undefined,
    jobs: jobs.map((job) => {
      // `accountId` is dropped rather than blanked: an id from another install
      // means nothing here, and leaving it in place would let an import silently
      // attach jobs to whichever local account happened to share the id.
      const { accountId: _drop, attachments, ...draft } = job.draft
      return {
        name: job.name,
        enabled: job.enabled,
        recurrence: job.recurrence,
        retry: job.retry,
        burst: job.burst,
        conditions: job.conditions,
        draft: { ...draft, accountId: undefined, attachments: [] },
        attachmentPaths: attachments.map((a) => a.path).filter((p): p is string => Boolean(p)),
      }
    }),
  }
}

export interface ImportProblem {
  /** Index in the file, so a message can point at "the 3rd reminder". */
  index: number
  reason: 'not-an-object' | 'no-recurrence' | 'no-recipients'
}

export interface ParsedImport {
  jobs: TransferJob[]
  problems: ImportProblem[]
  /** Every attachment path mentioned, deduplicated, for an existence check. */
  attachmentPaths: string[]
  /** The calendar the file carried, if any. Not applied — see `calendar`. */
  workCalendar?: WorkCalendar
  /**
   * What the caller has to decide about the calendar before importing, or
   * `undefined` when there is nothing to decide.
   *
   * This module cannot show a dialog, so it answers the questions a dialog
   * would need to ask: does anything in this file depend on a calendar, is one
   * present, and what would taking it change here. The caller picks a
   * `CalendarMergeChoice` and calls `mergeCalendars`.
   */
  calendar?: CalendarDecision
}

export interface CalendarDecision {
  /** At least one incoming job has a `workdayPolicy` (or the legacy flag). */
  needed: boolean
  /**
   * The file depends on a calendar and did not bring one. The jobs will import
   * and fall back to this install's calendar, which is very likely not the one
   * they were written against — worth saying out loud rather than discovering
   * when a reminder moves to the wrong Monday.
   */
  missing: boolean
  /** What adopting the incoming calendar would change. Absent when none came. */
  diff?: CalendarDiff
}

/**
 * Read a file, rejecting what cannot be trusted and reporting what was dropped.
 *
 * Throws only for "this is not one of our files at all". Individual jobs that
 * do not survive validation are collected into `problems` rather than aborting
 * the import: someone restoring forty reminders after a reinstall should get
 * the thirty-nine good ones and be told about the one that was wrong, not lose
 * the lot to a single bad row.
 */
/**
 * Everything in the file is untrusted, and a calendar is the easiest part to
 * get wrong by hand: a weekday of `9`, a date of `"next friday"`, a string
 * where an array belongs. A malformed entry is dropped rather than allowed to
 * become a holiday that matches nothing and a weekend that matches everything.
 */
function readCalendar(raw: unknown): WorkCalendar | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as Partial<WorkCalendar>
  const weekend = Array.isArray(c.weekend)
    ? [...new Set(c.weekend.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : []
  const dates = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort() : []
  const holidays = dates(c.holidays)
  const workdays = dates(c.workdays)
  if (weekend.length === 0 && holidays.length === 0 && workdays.length === 0) return undefined
  return { weekend, holidays, workdays }
}

export function parseImport(
  text: string,
  /** This install's calendar, so the diff can be computed here rather than twice. */
  localCalendar: WorkCalendar = DEFAULT_WORK_CALENDAR,
): ParsedImport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('not-json')
  }
  const file = raw as Partial<TransferFile>
  if (!file || file.format !== 'aevistle.jobs') throw new Error('not-aevistle')
  // A *newer* file may contain fields this build would drop on the floor, so it
  // is refused rather than half-read. Older files are fine — nothing has been
  // removed from the format.
  if (typeof file.version !== 'number' || file.version > TRANSFER_VERSION) {
    throw new Error('too-new')
  }
  if (!Array.isArray(file.jobs)) throw new Error('no-jobs')

  const jobs: TransferJob[] = []
  const problems: ImportProblem[] = []
  const paths = new Set<string>()

  file.jobs.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      problems.push({ index, reason: 'not-an-object' })
      return
    }
    const job = entry as TransferJob
    if (!job.recurrence || typeof job.recurrence.kind !== 'string') {
      problems.push({ index, reason: 'no-recurrence' })
      return
    }
    const to = job.draft?.to
    if (!Array.isArray(to) || to.length === 0) {
      // A reminder with nobody to send to cannot be armed, and importing it
      // would put a permanently broken row in the schedule.
      problems.push({ index, reason: 'no-recipients' })
      return
    }
    for (const p of job.attachmentPaths ?? []) paths.add(p)
    jobs.push(job)
  })

  const workCalendar = readCalendar(file.workCalendar)
  const needed = needsCalendar(jobs)
  const diff = workCalendar ? diffCalendars(localCalendar, workCalendar) : undefined
  // Nothing to decide is reported as nothing, so a caller can branch on the
  // presence of `calendar` alone rather than on three booleans.
  const calendar: CalendarDecision | undefined =
    needed || (diff && !diff.identical)
      ? { needed, missing: needed && !workCalendar, diff }
      : undefined

  return { jobs, problems, attachmentPaths: [...paths], workCalendar, calendar }
}

/**
 * Turn parsed entries into jobs this install can arm.
 *
 * `accountId` comes from the caller because the file does not carry one, and
 * `missingPaths` decides which attachments are dropped — an attachment whose
 * file is not on this machine is left out and reported, rather than kept as a
 * reference that will fail at 07:00 on a Tuesday.
 */
export function materialise(
  parsed: ParsedImport,
  accountId: string,
  newId: (prefix: string) => string,
  missingPaths: Set<string> = new Set(),
  now = Date.now(),
  /**
   * Indexes into `parsed.jobs` that `syncScope.dedupeAgainstLocal` already
   * matched, by exact content hash, against a job already on this machine.
   * Sync-only, same reasoning as `backup.ts`'s `applyBackup`: the hash is
   * computed with `crypto.subtle.digest`, which is async, so this function
   * stays synchronous and only honours a decision made before it was called.
   * The plain reminder-file import in `ScheduleTransferCard.tsx` never passes
   * this, so its behaviour is unchanged.
   */
  duplicateIndexes: ReadonlySet<number> = new Set(),
): { jobs: ScheduledJob[]; droppedAttachments: number; duplicatesSkipped: number } {
  let droppedAttachments = 0
  let duplicatesSkipped = 0
  const jobs: ScheduledJob[] = []
  parsed.jobs.forEach((entry, i) => {
    if (duplicateIndexes.has(i)) {
      duplicatesSkipped++
      return
    }
    const kept = (entry.attachmentPaths ?? []).filter((p) => !missingPaths.has(p))
    droppedAttachments += (entry.attachmentPaths ?? []).length - kept.length
    jobs.push({
      id: newId('job'),
      name: entry.name || `Imported ${i + 1}`,
      enabled: entry.enabled !== false,
      // Migrated on the way in, not left for the next hydrate: a file written
      // by an older build carries the legacy `skipWeekends` flag, and importing
      // it unchanged would arm a job against a hard-coded Sat/Sun weekend on a
      // machine whose calendar may say otherwise.
      recurrence: migrateSkipWeekends(entry.recurrence ?? defaultRecurrence()),
      retry: entry.retry ?? DEFAULT_RETRY,
      burst: entry.burst,
      conditions: entry.conditions,
      draft: {
        ...entry.draft,
        accountId,
        attachments: kept.map((p, k) => ({
          id: newId(`att_${i}_${k}`),
          name: p.split(/[\\/]/).pop() ?? p,
          size: 0,
          mime: 'application/octet-stream',
          source: 'path' as const,
          path: p,
          addedAt: now,
          inline: false,
        })),
      },
      occurrences: [],
      // Reset, not carried: see the file header.
      runCount: 0,
      status: 'armed' as const,
      createdAt: now,
      updatedAt: now,
    } as ScheduledJob)
  })
  return { jobs, droppedAttachments, duplicatesSkipped }
}
