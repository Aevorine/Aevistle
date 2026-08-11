/**
 * What happens when both sides of an 'ongoing' pair changed the same record.
 *
 * Plain newer-wins is not a conflict — it is the ordinary case, and
 * `core/syncLoop.ts` handles it by simply merging (`backup.ts`'s `mergeById`,
 * later id wins). A conflict, in this file's sense, only exists when *both*
 * sides changed the *same* id since the last time they synced: neither
 * change is "the old one", so picking one automatically is a guess, and a
 * guess that silently discards work needs a way back.
 *
 * `detectConflicts` takes both sides' *already-known-changed* records — the
 * same "records with `updatedAt` after my last sync with this device" set
 * `core/syncLoop.ts` builds to send in the first place — so the "changed on
 * both sides" half of the definition is true by construction; this file only
 * has to add "and they disagree", via the same content hash
 * `core/syncScope.ts` already uses for dedupe.
 *
 * `resolveConflicts` still picks automatically (newer `updatedAt` wins, per
 * the module compared with `clockOffsetMs` — see `PairedDevice`'s doc for
 * why a raw cross-device timestamp comparison is not trusted on its own) —
 * this is a background sync, not an interactive merge tool, and a sync that
 * stops to ask a question every time two people touch the same reminder
 * would not be a background sync at all. What makes the guess safe to make
 * is `resolveConflicts` never actually discarding the losing side: it lands
 * in the same capped, restorable rollback shape `core/snapshots.ts` already
 * proved for draft history, one entry per losing record, so "keep mine
 * instead" is one click away in `SyncConflictList.tsx` for as long as the
 * cap allows.
 */

import type { HashableKind } from './syncScope'
import { hashRecord } from './syncScope'
import type { Contact, MailAccount, ScheduledJob, Template } from '../types'
import { newId } from '../types'

export type { HashableKind }

export interface ConflictPair<T> {
  kind: HashableKind
  id: string
  mine: T
  theirs: T
}

/**
 * Flags an id present in both lists whose content hash differs. Both lists
 * are expected to already be "changed since the last sync with this device"
 * — see the module doc — so nothing here re-derives that half of the
 * definition; it would need each side's own `since` threshold to do so, which
 * only `core/syncLoop.ts` (holding the `PairedDevice` record) actually has.
 */
export async function detectConflicts<T extends { id: string }>(
  kind: HashableKind,
  mineChanged: readonly T[],
  theirsChanged: readonly T[],
): Promise<ConflictPair<T>[]> {
  if (theirsChanged.length === 0 || mineChanged.length === 0) return []
  const mineById = new Map(mineChanged.map((r) => [r.id, r]))
  const out: ConflictPair<T>[] = []
  for (const theirs of theirsChanged) {
    const mine = mineById.get(theirs.id)
    if (!mine) continue
    const [mineHash, theirsHash] = await Promise.all([hashRecord(kind, mine), hashRecord(kind, theirs)])
    if (mineHash !== theirsHash) out.push({ kind, id: theirs.id, mine, theirs })
  }
  return out
}

/** A short, human line for the diff view — subject for jobs, from-address for accounts, name for contacts/templates, per the spec this file implements. */
export function conflictSummary(kind: HashableKind, record: unknown): string {
  switch (kind) {
    case 'job': {
      const job = record as ScheduledJob
      return job.draft?.subject?.trim() || job.name
    }
    case 'account':
      return (record as MailAccount).fromAddress
    case 'contact': {
      const c = record as Contact
      return c.name || c.address
    }
    case 'template':
      return (record as Template).name
  }
}

export interface ConflictSnapshot {
  id: string
  /** Groups every snapshot produced by one sync cycle, for `sync.conflict.summary`'s count and for a future "undo this whole sync" that never has to guess which entries belong together. */
  sessionId: string
  kind: HashableKind
  recordId: string
  at: number
  /** The record that lost automatic resolution — what "keep mine instead" restores. */
  losing: unknown
  winningSummary: string
  losingSummary: string
}

/** Mirrors `snapshots.ts`'s `SNAPSHOT_CAP` — same reasoning: a rollback bucket nobody prunes is a rollback bucket that eventually dwarfs the state file it protects. */
export const CONFLICT_SNAPSHOT_CAP = 50

export interface ResolvedConflicts<T> {
  /** The winning record for each conflict, in the same order as `conflicts`. */
  winners: T[]
  snapshots: ConflictSnapshot[]
}

/**
 * Newer `updatedAt` wins, `theirs` adjusted by `clockOffsetMs` first — see the
 * module doc and `PairedDevice.clockOffsetMs`'s doc for why a raw cross-device
 * comparison is not trusted on its own. A tie (after adjustment) keeps `mine`:
 * this device is the one about to write the result, so "no visible change"
 * beats "flip a coin" when there is truly nothing to go on.
 */
export function resolveConflicts<T extends { id: string; updatedAt?: number }>(
  conflicts: readonly ConflictPair<T>[],
  sessionId: string,
  clockOffsetMs = 0,
  now = Date.now(),
): ResolvedConflicts<T> {
  const winners: T[] = []
  const snapshots: ConflictSnapshot[] = []
  for (const conflict of conflicts) {
    const theirsAdjusted = (conflict.theirs.updatedAt ?? 0) - clockOffsetMs
    const mineWins = (conflict.mine.updatedAt ?? 0) >= theirsAdjusted
    const winner = mineWins ? conflict.mine : conflict.theirs
    const loser = mineWins ? conflict.theirs : conflict.mine
    winners.push(winner)
    snapshots.push({
      id: newId('conflict'),
      sessionId,
      kind: conflict.kind,
      recordId: conflict.id,
      at: now,
      losing: loser,
      winningSummary: conflictSummary(conflict.kind, winner),
      losingSummary: conflictSummary(conflict.kind, loser),
    })
  }
  return { winners, snapshots }
}

/** Prepend and cap — the same shape `captureSnapshot` uses in `snapshots.ts`. */
export function pushConflictSnapshots(
  history: readonly ConflictSnapshot[],
  fresh: readonly ConflictSnapshot[],
): ConflictSnapshot[] {
  if (fresh.length === 0) return [...history]
  return [...fresh, ...history].slice(0, CONFLICT_SNAPSHOT_CAP)
}

/** Everything from one sync cycle, newest first — what `SyncConflictList.tsx` renders as one sheet. */
export function conflictsForSession(
  history: readonly ConflictSnapshot[],
  sessionId: string,
): ConflictSnapshot[] {
  return history.filter((s) => s.sessionId === sessionId)
}
