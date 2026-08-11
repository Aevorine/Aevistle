/**
 * How long the activity log is kept, and how much of it.
 *
 * This lives in `core` rather than beside the reducer that calls it because it
 * is a privacy policy, not state plumbing: `state.json` records who was mailed
 * and when, and "records older than N days are deleted" is a promise the
 * Settings screen makes to the user. A promise worth keeping is worth being
 * able to test without mounting React, which is what `npm run check:retention`
 * does.
 *
 * What was here before was not this. The days setting was applied as a
 * `.filter()` inside the Logs *screen* — older entries were hidden from view
 * and left sitting on disk, so a control that read "keep for 30 days" deleted
 * nothing at all. The count limit was a hardcoded 500 in the reducer that no
 * setting reached. Both limits now apply to the list itself, on the way into
 * state, which is the copy that gets written to the data folder.
 */

import type { LogEntry, Settings } from '../types'

/**
 * Used when the setting is missing or unusable — an older `state.json` written
 * before `logMaxEntries` existed, or a hand-edited file. Not a policy: the
 * policy is whatever Settings says.
 */
export const LOG_CAP_FALLBACK = 500

/**
 * Ceiling on the ceiling. `state.json` is read and rewritten in full on every
 * save, so an unbounded log is a startup cost that grows forever; 10,000 send
 * records is already far past what anyone reads.
 */
export const LOG_CAP_MAX = 10_000

export function pruneLogs(
  logs: LogEntry[],
  settings: Pick<Settings, 'logRetentionDays' | 'logMaxEntries'>,
  now = Date.now(),
): LogEntry[] {
  const days = Number(settings.logRetentionDays)
  const max = Number(settings.logMaxEntries)

  /*
   * An unusable value falls back rather than being taken literally.
   *
   * `Number(undefined)` is `NaN`, and every comparison against `NaN` is false,
   * so a naive `entry.at >= now - days * 86400000` would drop *every* entry —
   * the whole activity log deleted because a settings field was absent. The
   * same goes for a zero from an emptied number input, which the browser
   * reports as `''` mid-edit.
   */
  const cutoff = Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : -Infinity
  const cap =
    Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), LOG_CAP_MAX) : LOG_CAP_FALLBACK

  // `logs` is newest-first everywhere it is built, so slicing keeps the newest.
  return logs.filter((entry) => entry.at >= cutoff).slice(0, cap)
}
