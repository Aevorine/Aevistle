/**
 * Draft history.
 *
 * A compose screen with no history has one failure mode that nothing else in
 * the application shares: the work is destroyed by *success*. Send, and the
 * form clears. Load a template over half-written text, and it is gone. Restore
 * a backup, and so is the draft. None of those are crashes, so nothing warns
 * you, and nothing can bring it back.
 *
 * So: keep the last few versions, automatically, and let one click go back.
 *
 * What is deliberately *not* here:
 * - **No attachment contents.** Snapshots carry the attachment list by
 *   reference, exactly like a scheduled job does. Restoring a snapshot whose
 *   file has since moved gives you a draft that says so, not a silent blank.
 * - **No timer-driven churn.** A snapshot is taken when the text meaningfully
 *   changes and at most once every `MIN_GAP_MS`, so an hour of typing leaves a
 *   readable handful of versions rather than four hundred.
 */

import { newId, type MessageDraft } from '../types'

/** How many versions to keep. Past this the oldest is dropped. */
export const SNAPSHOT_CAP = 20

/** Never take two automatic snapshots closer together than this. */
export const MIN_GAP_MS = 45_000

export type SnapshotReason =
  /** Periodic capture while editing. */
  | 'auto'
  /** The user pressed the button. */
  | 'manual'
  /** Taken immediately before something that would otherwise destroy the draft. */
  | 'beforeSend'
  | 'beforeTemplate'
  | 'beforeClear'
  | 'beforeRestore'

export interface DraftSnapshot {
  id: string
  at: number
  reason: SnapshotReason
  draft: MessageDraft
}

/** A short, comparable digest of the parts a person would call "the draft". */
export function draftFingerprint(draft: MessageDraft): string {
  return [
    draft.to.join(','),
    draft.cc.join(','),
    draft.bcc.join(','),
    draft.subject,
    draft.body,
    draft.attachments.map((a) => a.id).join(','),
    draft.accountId,
  ].join('')
}

/** Is there anything in this draft worth keeping? */
export function isDraftMeaningful(draft: MessageDraft): boolean {
  return (
    draft.subject.trim().length > 0 ||
    draft.body.trim().length > 0 ||
    draft.to.length > 0 ||
    draft.attachments.length > 0
  )
}

/**
 * Decide whether to record this draft.
 *
 * Returns the new list, or `null` when nothing should change — the caller uses
 * `null` to skip the dispatch entirely, which is what keeps typing from
 * re-rendering the whole tree once a second.
 */
export function captureSnapshot(
  history: DraftSnapshot[],
  draft: MessageDraft,
  reason: SnapshotReason,
  now = Date.now(),
): DraftSnapshot[] | null {
  if (!isDraftMeaningful(draft)) return null

  const latest = history[0]
  if (latest && draftFingerprint(latest.draft) === draftFingerprint(draft)) return null
  // Explicit captures always land; automatic ones respect the quiet period, so
  // a burst of typing produces one entry rather than one per keystroke.
  if (reason === 'auto' && latest && now - latest.at < MIN_GAP_MS) return null

  const entry: DraftSnapshot = {
    id: newId('snap'),
    at: now,
    reason,
    // A copy, not a reference: the draft object in state is replaced on every
    // edit, but the arrays inside it are shared, and a snapshot that mutates
    // along with the live draft is not a snapshot.
    draft: {
      ...draft,
      to: [...draft.to],
      cc: [...draft.cc],
      bcc: [...draft.bcc],
      attachments: draft.attachments.map((a) => ({ ...a })),
    },
  }

  return [entry, ...history].slice(0, SNAPSHOT_CAP)
}

/** A one-line description for the history list: subject, or the first words of the body. */
export function snapshotPreview(snapshot: DraftSnapshot, max = 60): string {
  const text =
    snapshot.draft.subject.trim() ||
    snapshot.draft.body.trim().replace(/\s+/g, ' ') ||
    snapshot.draft.to.join(', ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
