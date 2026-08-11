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
 * **Passwords, unless you ask for them.** They are never in application state
 * to begin with — they live in the OS keystore, encrypted against your user
 * account, and are useless on another machine even if copied. A plain backup
 * restores an account complete except for its password, and says so rather
 * than restoring something that looks configured and fails at 3am.
 *
 * Opting in seals them instead of leaving them out: `sealBackupSecrets` asks
 * the trusted main-process/native layer to encrypt every account's password
 * under a freshly generated, one-time "recovery key" — 256 random bits this
 * file never sees in the clear, shown to the user exactly once and never
 * written to disk by this app. `openBackupSecrets` is the same trip in
 * reverse: given that key back, the trusted layer decrypts and writes
 * straight to the new machine's keystore. Neither function, nor this file,
 * nor the renderer at any point holds a plaintext password — see
 * `core/secretTransport.ts`, which both reuse rather than duplicate.
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
  newId,
  type AppState,
  type Contact,
  type MailAccount,
  type ScheduledJob,
  type Settings,
  type Template,
} from '../types'
import { bytesToBase64, randomToken, type PairingEnvelope } from '../sync/pairingCrypto'
import type { SealedAccountSecrets } from '../sync/syncLoop'

/**
 * The narrow slice of `PlatformBridge` sealing and opening backup secrets
 * needs — declared here rather than importing the whole interface from
 * `core/bridge`, which would pull the desktop/Android bridge machinery into
 * every module that only ever wants to build or read a `BackupFile`.
 */
export interface BackupSecretBridge {
  setSecret(accountId: string, secret: string, kind?: 'smtp' | 'imap' | 'sync'): Promise<void>
  deleteSecret(accountId: string, kind?: 'smtp' | 'imap' | 'sync'): Promise<void>
  sealAccountSecrets?(keyRef: string, accountIds: string[]): Promise<SealedAccountSecrets | null>
  openAccountSecrets?(keyRef: string, envelope: PairingEnvelope): Promise<string[]>
}

export const BACKUP_KIND = 'aevistle.backup'
export const BACKUP_VERSION = 1

/**
 * The account fields safe to hand to anything outside this machine — every
 * persisted field except a live secret, which only the OS keystore can keep.
 * `hasSecret` is cleared rather than carried: it describes *this* machine's
 * keystore, and a `true` arriving anywhere else would claim a password exists
 * that does not.
 *
 * Exported so `core/syncScope.ts` shapes the sync-scoped 'accounts' payload
 * the same way rather than re-deriving "safe to export" on its own — the one
 * place that payload is allowed to differ (a live pairing session may attach
 * an actual secret) still starts from this shape and adds to it, never
 * reimplements it.
 */
export function accountFields(accounts: MailAccount[]): MailAccount[] {
  return accounts.map((account) => ({ ...account, hasSecret: false }))
}

/** Everything in `Settings` that is purely "how the app looks", not "how it behaves". */
export type AppearanceSettings = Pick<
  Settings,
  'themeMode' | 'visualStyle' | 'accent' | 'accentBase' | 'accentCyber' | 'themeIntensity' | 'density' | 'listDensity'
>

/**
 * The settings subset a sync 'appearance' scope means — not the whole
 * `Settings` object, which also holds the data folder, quiet hours, retention
 * policy and a dozen other decisions nobody asking to "match my theme on the
 * other device" meant to send along.
 */
export function appearanceSettings(settings: Settings): AppearanceSettings {
  return {
    themeMode: settings.themeMode,
    visualStyle: settings.visualStyle,
    accent: settings.accent,
    accentBase: settings.accentBase,
    accentCyber: settings.accentCyber,
    themeIntensity: settings.themeIntensity,
    density: settings.density,
    listDensity: settings.listDensity,
  }
}

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
  /**
   * Present only when the person exporting chose to include passwords.
   * `envelope` opens to nothing without the recovery key shown once at
   * export time — this file carries no key material of its own. See
   * `sealBackupSecrets`/`openBackupSecrets` below.
   */
  secrets?: {
    accountIds: string[]
    envelope: PairingEnvelope
  }
}

export interface BackupSummary {
  accounts: number
  jobs: number
  contacts: number
  templates: number
  /** Accounts that will need their password entering again even with the
   *  right recovery key — everyone else's is covered by `securedPasswords`. */
  needPassword: number
  /** Accounts whose password travels sealed in this file, pending the recovery key. */
  securedPasswords: number
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
    accounts: accountFields(state.accounts),
    jobs: state.jobs,
    contacts: state.contacts,
    templates: state.templates,
    settings: state.settings,
    schemaVersion: SCHEMA_VERSION,
  }
}

export function summarise(backup: BackupFile): BackupSummary {
  const securedPasswords = backup.secrets?.accountIds.length ?? 0
  return {
    accounts: backup.accounts.length,
    jobs: backup.jobs.length,
    contacts: backup.contacts.length,
    templates: backup.templates.length,
    needPassword: backup.accounts.length - securedPasswords,
    securedPasswords,
    jobsWithAttachments: backup.jobs.filter((job) => job.draft.attachments.length > 0).length,
    createdAt: backup.createdAt,
    app: backup.app,
  }
}

/**
 * Generate a fresh, one-time recovery key — 256 random bits, base64-encoded.
 *
 * Not derived from anything the user typed: there is no password here to
 * strengthen against guessing (see the long comment at the top of this
 * file), so the key just *is* the entropy, the same shape `pairingCrypto
 * .ts`'s own long-lived pairing key already takes. Shown to the user once,
 * at export time, and never stored by this app anywhere — losing it makes
 * the sealed passwords in that one backup file unrecoverable, same as losing
 * any other recovery key.
 */
export function generateRecoveryKey(): string {
  return bytesToBase64(randomToken())
}

/** Strips everything but the exact characters a recovery key can contain — the
 *  copy-paste whitespace and the display grouping both add, and a stray
 *  dash or newline should not turn a correct key into a wrong one. */
export function normalizeRecoveryKey(input: string): string {
  return input.replace(/[^A-Za-z0-9+/=]/g, '')
}

/**
 * Seal every account with a saved password under a fresh recovery key.
 *
 * The key is stashed in the OS keystore just long enough for the trusted
 * layer to read it back and use it — `setSecret`/`deleteSecret` are the same
 * two calls `DevicesCard.tsx` already uses to hand a pairing key across this
 * boundary, so this adds no new privileged surface, only a new caller of it.
 * `finally` deletes the stash even if sealing throws, so a failed export
 * never leaves a stray key sitting in the keystore under a throwaway id.
 *
 * Resolves `null` when the platform has no `sealAccountSecrets` (the web
 * build) or nothing came back sealed (no account here has a saved password).
 */
export async function sealBackupSecrets(
  bridge: BackupSecretBridge,
  accountIds: string[],
): Promise<{ recoveryKey: string; secrets: BackupFile['secrets'] } | null> {
  if (!bridge.sealAccountSecrets || accountIds.length === 0) return null
  const recoveryKey = generateRecoveryKey()
  const tempRef = `backup-export:${newId()}`
  await bridge.setSecret(tempRef, recoveryKey, 'sync')
  try {
    const sealed = await bridge.sealAccountSecrets(tempRef, accountIds)
    if (!sealed) return null
    return {
      recoveryKey,
      secrets: { accountIds: sealed.accountIds, envelope: sealed.envelope },
    }
  } finally {
    await bridge.deleteSecret(tempRef, 'sync')
  }
}

/**
 * The restore-side trip: open what `sealBackupSecrets` sealed and write it
 * straight to this machine's keystore, given the same recovery key back.
 *
 * Returns which account ids actually got a password written — never a
 * secret itself, the same posture `PlatformBridge.openAccountSecrets`
 * documents for the pairing path this reuses.
 */
export async function openBackupSecrets(
  bridge: BackupSecretBridge,
  recoveryKey: string,
  secrets: NonNullable<BackupFile['secrets']>,
): Promise<string[]> {
  if (!bridge.openAccountSecrets) return []
  const tempRef = `backup-import:${newId()}`
  await bridge.setSecret(tempRef, normalizeRecoveryKey(recoveryKey), 'sync')
  try {
    return await bridge.openAccountSecrets(tempRef, secrets.envelope)
  } finally {
    await bridge.deleteSecret(tempRef, 'sync')
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
    accounts: accountFields(asArray<MailAccount>(candidate.accounts)),
    jobs: asArray<ScheduledJob>(candidate.jobs),
    contacts: asArray<Contact>(candidate.contacts),
    templates: asArray<Template>(candidate.templates),
    // Defaults folded in first, so a backup written before a setting existed
    // restores with that setting at its default rather than `undefined`.
    settings: { ...DEFAULT_SETTINGS, ...(candidate.settings ?? {}) },
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 1,
    secrets: readSecrets(candidate.secrets),
  }
}

/** Malformed rather than absent is treated the same as absent: a backup with
 *  a broken `secrets` block should still restore everything else, just
 *  without offering a recovery-key prompt for the part that did not parse. */
function readSecrets(value: unknown): BackupFile['secrets'] {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<NonNullable<BackupFile['secrets']>>
  const envelope = candidate.envelope
  if (
    !Array.isArray(candidate.accountIds) ||
    candidate.accountIds.length === 0 ||
    !envelope ||
    typeof envelope !== 'object' ||
    typeof (envelope as Partial<PairingEnvelope>).iv !== 'string' ||
    typeof (envelope as Partial<PairingEnvelope>).ciphertext !== 'string'
  ) {
    return undefined
  }
  return {
    accountIds: candidate.accountIds.filter((id): id is string => typeof id === 'string'),
    envelope: envelope as PairingEnvelope,
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
  /**
   * Exact-duplicate records to drop before merging, keyed by which array they
   * replace. Sync-only: hashing a record is async (`crypto.subtle.digest` in
   * `core/syncScope.ts`'s `hashRecord`) and this function has to stay
   * synchronous, so a caller that wants duplicates skipped runs
   * `syncScope.dedupeAgainstLocal` first and hands back whichever of
   * `backup`'s records survived that pass. The plain manual restore in
   * `BackupCard.tsx` never passes this, so its behaviour is unchanged.
   */
  deduped?: {
    accounts?: MailAccount[]
    jobs?: ScheduledJob[]
    contacts?: Contact[]
    templates?: Template[]
  },
): AppState {
  const accounts = deduped?.accounts ?? backup.accounts
  const jobs = deduped?.jobs ?? backup.jobs
  const contacts = deduped?.contacts ?? backup.contacts
  const templates = deduped?.templates ?? backup.templates

  if (mode === 'replace') {
    return {
      ...state,
      accounts,
      jobs,
      contacts,
      templates,
      settings: backup.settings,
    }
  }

  return {
    ...state,
    accounts: mergeById(state.accounts, accounts),
    jobs: mergeById(state.jobs, jobs),
    contacts: mergeById(state.contacts, contacts),
    templates: mergeById(state.templates, templates),
    // Settings are the user's current preferences on *this* machine — theme,
    // density, where the data folder is. Overwriting them from a file is
    // rarely what "merge my contacts back in" was meant to do.
    settings: state.settings,
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * Later id wins, earlier order otherwise preserved. Exported so
 * `core/syncLoop.ts` merges an incoming diff the same way a restored backup
 * does, rather than a second definition of "merge" drifting from this one.
 */
export function mergeById<T extends { id: string }>(mine: readonly T[], theirs: readonly T[]): T[] {
  const byId = new Map(mine.map((item) => [item.id, item]))
  for (const item of theirs) byId.set(item.id, item)
  return [...byId.values()]
}

/** `Aevistle-backup-2026-08-02.aevistle` — sorts by date and says what it is. */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Aevistle-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.aevistle`
}
