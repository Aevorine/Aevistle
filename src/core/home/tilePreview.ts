/**
 * What a Home tile says about itself before you open it.
 *
 * The Home grid is eleven doors with a word and a glyph on each. That is enough
 * to find a screen you already know you want, and nothing at all when the
 * question is "is there anything in there worth opening" — which is the
 * question a hub screen is actually asked. Answering it used to cost a full
 * screen transition, a look, and a press to come back; on a phone that is four
 * seconds to learn a number.
 *
 * ## Why this is a module and not a `switch` inside the view
 *
 * Three reasons, in the order they will matter.
 *
 * It is pure. `buildTilePreview(id, state, now)` is a function of data, so the
 * arithmetic behind every figure can be checked without a browser, a render or
 * a fixture DOM — `scripts/check-tile-preview.mjs` does exactly that, which is
 * the only way a claim like "3 个定时待发" is ever more than a hopeful string.
 *
 * It returns translation *keys*, not sentences. Core has no `t`, and a module
 * that formatted its own English would be a module that can only ever be read
 * in English — this app ships in six languages and one of them is right to
 * left.
 *
 * And it is one case per tile. Adding a twelfth destination to the grid is a
 * case here and nothing else; forgetting to add one is a tile with no preview,
 * which is the harmless failure. The alternative — figures computed in the view
 * beside the tiles that show them — is how the three counts in the hero came to
 * be computed twice with two different predicates before this round.
 *
 * ## What a preview is allowed to be
 *
 * At most three lines. A preview longer than the thing it previews is a screen,
 * and this one already exists one press away. Each line is a fact with a
 * number in it, not a description of what the screen is for — the label on the
 * tile already said that.
 */

import type { AppState } from '../types'
import type { TranslationKey } from '../../i18n'
import type { DestId } from '../nav'

/** How a line reads at a glance, before any of its words are. */
export type PreviewTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface PreviewLine {
  key: TranslationKey
  values?: Record<string, string | number>
  tone?: PreviewTone
}

export interface TilePreview {
  lines: PreviewLine[]
  /**
   * True when every line is the zero case — nothing scheduled, no contacts, no
   * problems. The caller draws these more quietly: a preview that shouts three
   * zeroes at you is worse than no preview, and "nothing here" is still worth
   * knowing before you spend a screen transition finding out.
   */
  empty: boolean
}

const MS_PER_DAY = 86_400_000

/** Local calendar days between two instants — not `(b - a) / 86400000`, which is wrong across a DST change. */
function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/**
 * The soonest future occurrence across every enabled job, or `null`.
 *
 * `occurrences` is precomputed and ascending, so this is a scan for the first
 * entry at or after `now` per job — no recurrence arithmetic happens here, and
 * deliberately so: a preview that recomputed the schedule could disagree with
 * the screen it previews, and the version with the smaller sample would be the
 * one believed because it is the one on screen first.
 */
function nextSendAt(state: AppState, now: number): number | null {
  let soonest: number | null = null
  for (const job of state.jobs) {
    if (!job.enabled) continue
    const at = job.occurrences.find((o) => o >= now)
    if (at === undefined) continue
    if (soonest === null || at < soonest) soonest = at
  }
  return soonest
}

function armedToday(state: AppState, now: number): number {
  return state.jobs.filter((j) => {
    if (!j.enabled) return false
    const at = j.occurrences.find((o) => o >= now)
    return at !== undefined && sameLocalDay(at, now)
  }).length
}

const empty: TilePreview = { lines: [], empty: true }

/**
 * The preview for one tile.
 *
 * Returns `{ lines: [], empty: true }` for anything without a case — an id
 * added to the grid before its preview was written, which draws no panel at
 * all rather than an empty one.
 */
export function buildTilePreview(id: DestId, state: AppState, now: number): TilePreview {
  const lines: PreviewLine[] = []

  switch (id) {
    case 'schedule': {
      const enabled = state.jobs.filter((j) => j.enabled).length
      const paused = state.jobs.length - enabled
      const today = armedToday(state, now)
      const next = nextSendAt(state, now)
      lines.push({
        key: 'preview.schedule.armed',
        values: { n: enabled },
        tone: enabled > 0 ? 'success' : 'neutral',
      })
      if (today > 0) lines.push({ key: 'preview.schedule.today', values: { n: today } })
      /* The next fire is the one fact worth a whole line, and only when there
         is one: "下一次 —" is a line that costs the same space as a real one
         and carries none of the information. */
      if (next !== null) {
        lines.push({ key: 'preview.schedule.next', values: { at: String(next) } })
      } else if (paused > 0) {
        lines.push({ key: 'preview.schedule.paused', values: { n: paused }, tone: 'warning' })
      }
      break
    }

    case 'contacts': {
      const withWindow = state.contacts.filter((c) => c.deliveryWindow !== undefined).length
      lines.push({ key: 'preview.contacts.total', values: { n: state.contacts.length } })
      if (withWindow > 0) {
        lines.push({ key: 'preview.contacts.windows', values: { n: withWindow } })
      }
      break
    }

    case 'templates': {
      lines.push({ key: 'preview.templates.total', values: { n: state.templates.length } })
      break
    }

    case 'logs': {
      const sent = state.logs.filter(
        (l) => l.kind === 'send' && l.level !== 'error' && sameLocalDay(l.at, now),
      ).length
      const failed = state.logs.filter(
        (l) => l.level === 'error' && sameLocalDay(l.at, now),
      ).length
      lines.push({ key: 'preview.logs.sentToday', values: { n: sent } })
      lines.push({
        key: 'preview.logs.failedToday',
        values: { n: failed },
        tone: failed > 0 ? 'danger' : 'neutral',
      })
      break
    }

    case 'workcal': {
      /*
       * A working calendar has no on/off switch — it is a set of dates — so the
       * honest figures are how many dates it carries and how many schedules
       * actually consult it. `workdayPolicy` absent reads as `'off'` (see
       * `Recurrence`), which is why the test is for a set value rather than for
       * the property existing.
       */
      const cal = state.settings.workCalendar
      const marked = (cal?.holidays.length ?? 0) + (cal?.workdays.length ?? 0)
      const users = state.jobs.filter(
        (j) => j.recurrence.workdayPolicy !== undefined && j.recurrence.workdayPolicy !== 'off',
      ).length
      lines.push({
        key: 'preview.workcal.marked',
        values: { n: marked },
        tone: marked > 0 ? 'success' : 'neutral',
      })
      lines.push({
        key: 'preview.workcal.users',
        values: { n: users },
        tone: users > 0 ? 'success' : 'neutral',
      })
      break
    }

    case 'reliability': {
      /*
       * Deliberately a count of *symptoms this module can see in the state*,
       * not a call into `core/ops/reliability`. That module's collectors take
       * live runtime handles (an OAuth connection map, a permission snapshot)
       * that a pure function of `AppState` does not have, and half an answer
       * presented as a whole one is the failure mode this whole screen exists
       * to prevent. So: the two conditions that are unambiguously *in* the
       * document — a paused job and a failed send today — and nothing implied
       * about the rest. The screen itself remains the complete answer.
       */
      const paused = state.jobs.filter((j) => !j.enabled).length
      const failedToday = state.logs.filter(
        (l) => l.level === 'error' && sameLocalDay(l.at, now),
      ).length
      const total = paused + failedToday
      lines.push({
        key: total === 0 ? 'preview.reliability.clear' : 'preview.reliability.issues',
        values: { n: total },
        tone: total === 0 ? 'success' : 'warning',
      })
      if (paused > 0) lines.push({ key: 'preview.reliability.paused', values: { n: paused } })
      break
    }

    case 'pairing': {
      const devices = state.pairedDevices.length
      lines.push({
        key: 'preview.pairing.devices',
        values: { n: devices },
        tone: devices > 0 ? 'success' : 'neutral',
      })
      if (state.syncConflicts.length > 0) {
        lines.push({
          key: 'preview.pairing.conflicts',
          values: { n: state.syncConflicts.length },
          tone: 'warning',
        })
      }
      break
    }

    case 'digest': {
      lines.push({
        key: state.settings.digestEnabled ? 'preview.digest.on' : 'preview.digest.off',
        tone: state.settings.digestEnabled ? 'success' : 'neutral',
      })
      break
    }

    case 'greetings': {
      lines.push({
        key: 'preview.greetings.country',
        values: { country: state.settings.greetingCountry },
      })
      break
    }

    case 'calendarsub': {
      const on = state.settings.calendarSubscribeEnabled === true
      lines.push({
        key: on ? 'preview.calendarsub.on' : 'preview.calendarsub.off',
        
        tone: on ? 'success' : 'neutral',
      })
      break
    }

    case 'selfcheck': {
      lines.push({ key: 'preview.selfcheck.hint' })
      break
    }

    default:
      return empty
  }

  if (lines.length === 0) return empty

  /*
   * "Everything is zero" is decided from the values, not from a flag each case
   * remembers to set — a per-case flag is a per-case chance to forget, and the
   * ones that would be forgotten are the tiles nobody looks at, which are
   * exactly the tiles whose preview is load-bearing.
   */
  const allZero = lines.every((l) => {
    const n = l.values?.n
    return typeof n === 'number' ? n === 0 : l.tone === 'neutral' || l.tone === undefined
  })
  return { lines: lines.slice(0, 3), empty: allZero }
}

/** Exported for the check script, which asserts the day boundary is calendar-based rather than `MS_PER_DAY` arithmetic. */
export const __test = { sameLocalDay, nextSendAt, armedToday, MS_PER_DAY }
