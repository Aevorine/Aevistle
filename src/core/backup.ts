/**
 * Taking your setup with you.
 *
 * A backup is one JSON file holding the things you built by hand — accounts,
 * reminders, contacts, templates, preferences. It exists for a new laptop, for
 * a reinstall, and for the moment before you try something that might go
 * wrong.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately not in it
 * ---------------------------------------------------------------------------
 * **Passwords.** They are never in application state to begin with — they live
 * in the OS keystore, encrypted against your user account, and are useless on
 * another machine even if copied. So a backup restores an account complete
 * except for its password, and says so rather than restoring something that
 * looks configured and fails at 3am.
 *
 * **Cached mail.** Received messages are a cache of what is on the server;
 * they can be re-fetched, they are the biggest thing in the file by an order
 * of magnitude, and a backup is a file people email to themselves.
 *
 * **The activity log.** Same reasoning inverted: it is history, not setup, and
 * it carries recipient addresses.
 *
 * **Attachment contents.** Attachments are referenced by path. On the same
 * machine those paths still resolve; on a different one they will not, so the
 * restore reports how many reminders carry attachments that need re-attaching
 * rather than pretending the file is self-contained.
 */

import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type AppState,
  type Contact,
  type MailAccount,
  type ScheduledJob,
  type Settings,
  type Template,
} from './types'

export const BACKUP_KIND = 'aevistle.backup'
export const BACKUP_VERSION = 1

export interface BackupFile {
  kind: typeof BACKUP_KIND
  version: number
  /** The app version that wrote it, for a human reading the file later. */
  app: string
  createdAt: number
  accounts: MailAccount[]
  jobs: ScheduledJob[]
  contacts: Contact[]
  templates: Template[]
  settings: Settings
  schemaVersion: number
}

export interface BackupSummary {
  accounts: number
  jobs: number
  contacts: number
  templates: number
  /** Accounts that will need their password entering again. */
  needPassword: number
  /** Reminders whose attachments are referenced by path, not carried. */
  jobsWithAttachments: number
  createdAt: number
  app: string
}

export function buildBackup(state: AppState, appVersion: string): BackupFile {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    app: appVersion,
    createdAt: Date.now(),
    // `hasSecret` is cleared on the way out: it describes this machine's
    // keystore, and carrying a true into a restore would make the app believe
    // a password exists that does not.
    accounts: state.accounts.map((account) => ({ ...account, hasSecret: false })),
    jobs: state.jobs,
    contacts: state.contacts,
    templates: state.templates,
    settings: state.settings,
    schemaVersion: SCHEMA_VERSION,
  }
}

export function summarise(backup: BackupFile): BackupSummary {
  return {
    accounts: backup.accounts.length,
    jobs: backup.jobs.length,
    contacts: backup.contacts.length,
    templates: backup.templates.length,
    needPassword: backup.accounts.length,
    jobsWithAttachments: backup.jobs.filter((job) => job.draft.attachments.length > 0).length,
    createdAt: backup.createdAt,
    app: backup.app,
  }
}

/**
 * Read a file the user picked.
 *
 * Strict about the envelope and forgiving about the contents: a missing
 * `kind` means this is not a backup and the user picked the wrong file, which
 * is worth stopping for. A missing `contacts` array just means they had none.
 *
 * Throws with a sentence a person can act on. This is reached by someone who
 * just chose a file in a dialog, and "Unexpected token < in JSON at position
 * 0" tells them nothing about which file to pick instead.
 */
export function readBackup(text: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('that file is not a backup — it is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('that file is not a backup')

  const candidate = parsed as Partial<BackupFile>
  if (candidate.kind !== BACKUP_KIND) {
    throw new Error('that file is not an Aevistle backup')
  }
  if (typeof candidate.version !== 'number' || candidate.version > BACKUP_VERSION) {
    throw new Error(
      `that backup was written by a newer version of Aevistle (format ${String(candidate.version)})`,
    )
  }

  return {
    kind: BACKUP_KIND,
    version: candidate.version,
    app: typeof candidate.app === 'string' ? candidate.app : 'unknown',
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    accounts: asArray<MailAccount>(candidate.accounts).map((a) => ({ ...a, hasSecret: false })),
    jobs: asArray<ScheduledJob>(candidate.jobs),
    contacts: asArray<Contact>(candidate.contacts),
    templates: asArray<Template>(candidate.templates),
    // Defaults folded in first, so a backup written before a setting existed
    // restores with that setting at its default rather than `undefined`.
    settings: { ...DEFAULT_SETTINGS, ...(candidate.settings ?? {}) },
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 1,
  }
}

/**
 * Fold a backup into the current state.
 *
 * Merge, not replace: someone restoring onto a machine they have already used
 * expects to end up with both, and a straight overwrite silently discards
 * whatever they did in the meantime. Entries with the same id are taken from
 * the backup — that is what "restore" means for something you already have.
 *
 * `mode: 'replace'` is offered for the other case, moving to a clean machine,
 * where merge would leave the sample data behind.
 */
export function applyBackup(
  state: AppState,
  backup: BackupFile,
  mode: 'merge' | 'replace',
): AppState {
  if (mode === 'replace') {
    return {
      ...state,
      accounts: backup.accounts,
      jobs: backup.jobs,
      contacts: backup.contacts,
      templates: backup.templates,
      settings: backup.settings,
    }
  }

  const mergeById = <T extends { id: string }>(mine: T[], theirs: T[]): T[] => {
    const byId = new Map(mine.map((item) => [item.id, item]))
    for (const item of theirs) byId.set(item.id, item)
    return [...byId.values()]
  }

  return {
    ...state,
    accounts: mergeById(state.accounts, backup.accounts),
    jobs: mergeById(state.jobs, backup.jobs),
    contacts: mergeById(state.contacts, backup.contacts),
    templates: mergeById(state.templates, backup.templates),
    // Settings are the user's current preferences on *this* machine — theme,
    // density, where the data folder is. Overwriting them from a file is
    // rarely what "merge my contacts back in" was meant to do.
    settings: state.settings,
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** `Aevistle-backup-2026-08-02.aevistle` — sorts by date and says what it is. */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Aevistle-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.aevistle`
}
