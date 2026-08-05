/**
 * What one device offers another, and how to tell "the same thing twice" from
 * "two different things".
 *
 * Splits into two halves that share this file only because they operate on
 * the same field shapes:
 *
 * **Scope.** A sync exchange rarely means "everything" — someone pairing a
 * phone wants the schedule, not their desktop's whole contact book. `SyncScopeKey`
 * enumerates what can be offered on its own, and `buildScopePayload` slices
 * `AppState` the same way `buildBackup` in `core/backup.ts` already does,
 * reusing its `accountFields`/`appearanceSettings` helpers rather than
 * re-deriving "safe to export" here.
 *
 * One deliberate departure from `backup.ts`: the 'accounts' scope here *may*
 * carry an actual password, where a backup file never does. A backup is a
 * file that can end up anywhere — attached to an email, sitting in a cloud
 * drive folder, found on an old USB stick years later. This payload is not a
 * file at all; it exists only inside `core/pairing.ts`'s ECDH/AES-GCM session
 * between two devices a person is holding at the same time, and it stops
 * existing the moment that session ends. `syncScope.ts` itself never reads a
 * keystore — it is platform-agnostic core code, and a keystore is not — so a
 * secret only appears here if the caller already resolved one and handed it
 * in through `BuildScopeOptions.accountSecrets`. Leave that unset and an
 * account travels exactly as it would in a backup: `hasSecret: false`, no
 * secret field, so the other device is never told a password exists that did
 * not actually arrive.
 *
 * **Dedupe.** Two devices that have been pairing for months accumulate the
 * same reminder, contact or template on both sides — created independently,
 * or synced back and forth until the id diverged. `hashRecord` is a stable
 * content hash per record type, deliberately excluding the same kind of
 * volatile bookkeeping `jobTransfer.ts` already strips on export (`runCount`,
 * `lastRunAt`, ids, timestamps): two records that mean the same thing hash
 * the same, regardless of which device minted which id first.
 * `dedupeAgainstLocal` uses that to separate "already have this exact thing"
 * (dropped silently, counted) from "same id, different content" (left alone
 * — that is chunk-09's conflict-resolution path to decide, not this one's to
 * guess at). Exact match only, on purpose: a fuzzy "looks similar" pass would
 * eventually drop two contacts who happen to share a name.
 */

import { accountFields, appearanceSettings, type AppearanceSettings } from './backup'
import type { AppState, Contact, MailAccount, ScheduledJob, Template } from './types'
import type { WorkCalendar } from './workCalendar'

export type SyncScopeKey = 'accounts' | 'schedule' | 'contacts' | 'templates' | 'appearance'

export const SYNC_SCOPE_KEYS: readonly SyncScopeKey[] = [
  'accounts',
  'schedule',
  'contacts',
  'templates',
  'appearance',
]

// ---------------------------------------------------------------------------
// Scope payload
// ---------------------------------------------------------------------------

export interface SchedulePayload {
  jobs: ScheduledJob[]
  workCalendar: WorkCalendar
}

/** An account as it may travel inside a *live* pairing session only — see the module doc for why. */
export type SyncAccount = MailAccount & { secret?: string }

export interface ScopePayload {
  accounts?: SyncAccount[]
  schedule?: SchedulePayload
  contacts?: Contact[]
  templates?: Template[]
  appearance?: AppearanceSettings
}

export interface BuildScopeOptions {
  /**
   * Secrets already resolved by whatever layer can reach the OS keystore,
   * keyed by account id. See the module doc — `syncScope.ts` never fetches
   * one itself.
   */
  accountSecrets?: Partial<Record<string, string>>
}

export function buildScopePayload(
  state: AppState,
  calendar: WorkCalendar,
  scopes: readonly SyncScopeKey[],
  options: BuildScopeOptions = {},
): ScopePayload {
  const want = new Set(scopes)
  const payload: ScopePayload = {}

  if (want.has('accounts')) {
    payload.accounts = accountFields(state.accounts).map((account) => {
      const secret = options.accountSecrets?.[account.id]
      return secret ? { ...account, hasSecret: true, secret } : account
    })
  }
  if (want.has('schedule')) {
    payload.schedule = { jobs: state.jobs, workCalendar: calendar }
  }
  if (want.has('contacts')) {
    payload.contacts = state.contacts
  }
  if (want.has('templates')) {
    payload.templates = state.templates
  }
  if (want.has('appearance')) {
    payload.appearance = appearanceSettings(state.settings)
  }

  return payload
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export type HashableKind = 'job' | 'contact' | 'template' | 'account'

/** The subset of a `MessageDraft`-shaped object that means "the same message", stripped of anything minted per install. */
function draftForHash(draft: Record<string, unknown>): unknown {
  // `accountId` is never part of what makes two reminders "the same
  // reminder" — it names a local account that means nothing on the other
  // device, the same reasoning `jobTransfer.ts`'s `exportJobs` already uses.
  const { accountId: _drop, attachments, ...rest } = draft as {
    accountId?: unknown
    attachments?: Array<Record<string, unknown>>
  } & Record<string, unknown>
  return {
    ...rest,
    // `id`, `path` and `addedAt` are minted per install the same way a job id
    // is — kept out for the same reason `runCount`/`lastRunAt` are: bookkeeping,
    // not content.
    attachments: (attachments ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      mime: a.mime,
      inline: a.inline,
      cid: a.cid,
    })),
  }
}

/** Shapes a record down to the fields that define its *content*, per `HashableKind`. See the module doc for why each list is what it is. */
function shapeForHash(kind: HashableKind, record: unknown): unknown {
  switch (kind) {
    case 'job': {
      const job = record as {
        name: string
        recurrence: unknown
        draft: Record<string, unknown>
        retry: unknown
        conditions?: unknown
      }
      return {
        name: job.name,
        recurrence: job.recurrence,
        draft: draftForHash(job.draft ?? {}),
        retry: job.retry,
        conditions: job.conditions,
      }
    }
    case 'contact': {
      const c = record as Contact
      return { name: c.name, address: c.address, tags: c.tags, note: c.note, fields: c.fields }
    }
    case 'template': {
      const tpl = record as Template
      return { name: tpl.name, subject: tpl.subject, body: tpl.body }
    }
    case 'account': {
      // Never the password — see the module doc. Two accounts pointing at the
      // same mailbox are "the same account" whether or not either currently
      // has a secret saved.
      const a = record as MailAccount
      return { fromAddress: a.fromAddress, host: a.host, port: a.port, username: a.username }
    }
  }
}

/** Sorted-key JSON — the same object serialises identically regardless of which order its fields were written in. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      // Matches `JSON.stringify`'s own behaviour, but made explicit: a field
      // that is `undefined` must hash the same as a field that is absent, or
      // a later release adding an optional field with `?? undefined` would
      // silently change the hash of every record that predates it.
      if (v === undefined) continue
      out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function hashRecord(kind: HashableKind, record: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(shapeForHash(kind, record))))
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

export interface DedupeOutcome<T> {
  /** The incoming records that are not exact duplicates of one already here. */
  kept: T[]
  /** How many incoming records were dropped as exact content matches. */
  skippedCount: number
  /**
   * ids shared with a local record whose content hash differs. Not resolved
   * here — that is chunk-09's conflict-resolution path — but reported rather
   * than silently overwritten or silently dropped.
   */
  conflictIds: string[]
}

/**
 * Compare incoming records against what is already on this machine, by
 * content hash rather than by id.
 *
 * `local` and `incoming` are hashed with the same `kind`, so a job created
 * independently on two devices — different id, different `createdAt`, same
 * name/recurrence/draft/retry/conditions — comes back as a duplicate. A
 * record sharing an id with a local one but hashing differently is kept (an
 * exact-match-only dedupe must never silently drop something that changed)
 * and its id is also reported in `conflictIds`.
 */
export async function dedupeAgainstLocal<T extends { id?: string }>(
  kind: HashableKind,
  local: readonly T[],
  incoming: readonly T[],
): Promise<DedupeOutcome<T>> {
  const localHashes = new Set(await Promise.all(local.map((r) => hashRecord(kind, r))))
  const localById = new Map(local.filter((r) => r.id).map((r) => [r.id as string, r]))

  const kept: T[] = []
  const conflictIds: string[] = []
  let skippedCount = 0

  for (const record of incoming) {
    const hash = await hashRecord(kind, record)
    if (localHashes.has(hash)) {
      skippedCount++
      continue
    }
    if (record.id && localById.has(record.id)) conflictIds.push(record.id)
    kept.push(record)
  }

  return { kept, skippedCount, conflictIds }
}

/**
 * The same comparison as `dedupeAgainstLocal`, reported as indexes into
 * `incoming` rather than a filtered array — what `jobTransfer.ts`'s
 * `materialise` wants for its `duplicateIndexes` parameter, since a
 * `TransferJob` has no id of its own until `materialise` mints one.
 */
export async function dedupeIndexes<T extends { id?: string }>(
  kind: HashableKind,
  local: readonly T[],
  incoming: readonly T[],
): Promise<{ duplicateIndexes: Set<number>; skippedCount: number; conflictIds: string[] }> {
  const localHashes = new Set(await Promise.all(local.map((r) => hashRecord(kind, r))))
  const localById = new Map(local.filter((r) => r.id).map((r) => [r.id as string, r]))

  const duplicateIndexes = new Set<number>()
  const conflictIds: string[] = []
  let skippedCount = 0

  for (let i = 0; i < incoming.length; i++) {
    const record = incoming[i]
    const hash = await hashRecord(kind, record)
    if (localHashes.has(hash)) {
      duplicateIndexes.add(i)
      skippedCount++
      continue
    }
    if (record.id && localById.has(record.id)) conflictIds.push(record.id)
  }

  return { duplicateIndexes, skippedCount, conflictIds }
}
