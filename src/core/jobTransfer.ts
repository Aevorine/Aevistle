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
 */

import { defaultRecurrence, DEFAULT_RETRY, type MessageDraft, type ScheduledJob } from './types'

/** Bumped only for a change that an older importer would read *wrongly*. */
export const TRANSFER_VERSION = 1

export interface TransferFile {
  format: 'aevistle.jobs'
  version: number
  exportedAt: number
  /** Purely informational; never used to decide anything on import. */
  appVersion?: string
  jobs: TransferJob[]
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

export function exportJobs(jobs: ScheduledJob[], appVersion?: string, now = Date.now()): TransferFile {
  return {
    format: 'aevistle.jobs',
    version: TRANSFER_VERSION,
    exportedAt: now,
    appVersion,
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
export function parseImport(text: string): ParsedImport {
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

  return { jobs, problems, attachmentPaths: [...paths] }
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
): { jobs: ScheduledJob[]; droppedAttachments: number } {
  let droppedAttachments = 0
  const jobs = parsed.jobs.map((entry, i) => {
    const kept = (entry.attachmentPaths ?? []).filter((p) => !missingPaths.has(p))
    droppedAttachments += (entry.attachmentPaths ?? []).length - kept.length
    return {
      id: newId('job'),
      name: entry.name || `Imported ${i + 1}`,
      enabled: entry.enabled !== false,
      recurrence: entry.recurrence ?? defaultRecurrence(),
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
    } as ScheduledJob
  })
  return { jobs, droppedAttachments }
}
