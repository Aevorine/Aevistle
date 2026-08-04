/**
 * The digest, in words — supplied by whoever is calling.
 *
 * Kept apart from `digest.ts` on purpose. That module computes; this one only
 * arranges, and it owns not a single sentence: every line comes back from the
 * `t` it is handed, so the mail is written in the language the user reads and
 * not in the language this file happens to be commented in.
 *
 * It is here rather than inside a view because two call sites need the exact
 * same text — the schedule hand-off, which builds the body the platform
 * scheduler will send, and the settings screen, which shows a preview. A
 * preview that renders through different code is a preview of something else.
 *
 * The conflict lines reuse `cal.conflict.*`, the keys the calendar screen
 * already shows. A second set of wordings for the same five states is a second
 * set that can disagree with the first.
 */

import type { TranslationKey } from '../i18n'
import type { Conflict } from './conflicts'
import type { Digest } from './digest'

/** How many conflicts are spelled out before the rest become a count. */
const MAX_CONFLICT_LINES = 5

export interface DigestRenderContext {
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
  formatDateTime: (ms: number, opts?: Intl.DateTimeFormatOptions) => string
  /** A job's name, for the conflict lines. Falls back to the id. */
  jobName: (id: string) => string
}

function conflictLine(conflict: Conflict, ctx: DigestRenderContext): string {
  const names = conflict.jobIds.map((id) => ctx.jobName(id)).join(', ')
  return ctx.t(`cal.conflict.${conflict.kind}` as TranslationKey, {
    n: conflict.count,
    name: names,
    when: conflict.at ? ctx.formatDateTime(conflict.at) : (conflict.date ?? ''),
    min: Math.round((conflict.ms ?? 0) / 60_000),
  })
}

/** The subject line. Dated, so a week of digests does not collapse in a thread. */
export function renderDigestSubject(digest: Digest, ctx: DigestRenderContext): string {
  return ctx.t('digest.subject', {
    date: ctx.formatDateTime(digest.generatedAt, { dateStyle: 'medium', timeStyle: undefined }),
  })
}

/**
 * The body, as plain text.
 *
 * Plain on purpose: this mail is read on a phone lock screen as often as
 * anywhere, and it carries nothing that needs markup. It also means the body
 * cannot be mistaken for HTML by anything downstream.
 */
export function renderDigestBody(digest: Digest, ctx: DigestRenderContext): string {
  const { t } = ctx
  const lines: string[] = []

  // --- today ---------------------------------------------------------------
  lines.push(t('digest.todayHeading'))
  if (digest.todayCount === 0) {
    lines.push(t('digest.todayNone'))
  } else {
    lines.push(
      t(digest.truncated ? 'digest.todayCountAtLeast' : 'digest.todayCount', {
        n: digest.todayCount,
      }),
    )
    for (const entry of digest.todayEntries) {
      for (const at of entry.times) {
        lines.push(
          `  · ${t('digest.entry', {
            time: ctx.formatDateTime(at, { dateStyle: undefined, timeStyle: 'short' }),
            name: entry.name,
            recipients: entry.recipients,
          })}`,
        )
      }
    }
  }

  // --- the week ------------------------------------------------------------
  lines.push('')
  lines.push(t('digest.weekHeading', { days: digest.weekDays }))
  lines.push(
    t(digest.truncated ? 'digest.weekCountAtLeast' : 'digest.weekCount', {
      n: digest.weekCount,
      jobs: digest.jobsConsidered,
    }),
  )

  // --- conflicts -----------------------------------------------------------
  lines.push('')
  lines.push(t('digest.conflictHeading'))
  if (digest.conflictCount === 0) {
    lines.push(t('digest.conflictNone', { days: digest.conflictDays }))
  } else {
    lines.push(
      t('digest.conflictCount', {
        n: digest.conflictCount,
        days: digest.conflictDays,
        errors: digest.conflictErrors,
      }),
    )
    for (const conflict of digest.conflicts.slice(0, MAX_CONFLICT_LINES)) {
      lines.push(`  · ${conflictLine(conflict, ctx)}`)
    }
    if (digest.conflictCount > MAX_CONFLICT_LINES) {
      lines.push(`  · ${t('digest.moreConflicts', { n: digest.conflictCount - MAX_CONFLICT_LINES })}`)
    }
  }

  // --- provenance ----------------------------------------------------------
  //
  // Not decoration. The body is built when the schedule is armed and sent by
  // the platform scheduler, which on Android can be hours later with nothing
  // running. Without the stamp there is no way to tell a summary of this
  // morning from a summary of the last morning the app was open.
  lines.push('')
  lines.push(t('digest.generatedAt', { when: ctx.formatDateTime(digest.generatedAt) }))
  lines.push(t('digest.staleNote'))
  lines.push(t('digest.footer'))

  return lines.join('\n')
}
