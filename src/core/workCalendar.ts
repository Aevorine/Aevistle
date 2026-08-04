/**
 * Working days, weekends and public holidays.
 *
 * This sits at the same place in the pipeline as quiet hours: it rewrites the
 * *occurrence list*, not the send. That is what lets it work on both platforms
 * without either native scheduler learning the feature exists — the desktop
 * tick and the Android alarm simply receive a different timestamp, or none.
 *
 * Two things it deliberately gets right:
 *
 * - **Make-up workdays.** In several countries a public holiday is paid for by
 *   working the Saturday before it. A calendar that only knows "weekends are
 *   off" is wrong on exactly the days people most need a reminder.
 * - **Skip is not the same as shift.** "Only on working days" can mean "not on
 *   the holiday, send the day before instead" or "not on the holiday, don't
 *   send at all". Guessing produces either a missed reminder or an unwanted
 *   one, so the policy is explicit.
 */

/** A local calendar date, `YYYY-MM-DD`. Deliberately not a timestamp: a holiday is a date, not an instant. */
export type IsoDate = string

export type WorkdayPolicy =
  /** The calendar is ignored entirely (default — nothing changes for existing jobs). */
  | 'off'
  /** Drop this occurrence; the next one is whenever the rule next matches. */
  | 'skip'
  /** Move it earlier, to the closest preceding working day, same time of day. */
  | 'before'
  /** Move it later, to the closest following working day, same time of day. */
  | 'after'

export interface WorkCalendar {
  /** Days of the week that are not worked. 0 = Sunday … 6 = Saturday. */
  weekend: number[]
  /** Dates that are off even though they are mid-week — public holidays. */
  holidays: IsoDate[]
  /** Dates that are worked even though they fall on a weekend — make-up days. */
  workdays: IsoDate[]
}

export const DEFAULT_WORK_CALENDAR: WorkCalendar = {
  weekend: [0, 6],
  holidays: [],
  workdays: [],
}

/** How far to search for a neighbouring working day before giving up. */
const MAX_SHIFT_DAYS = 31

/**
 * How far a de-duplication nudge may push a fire time, and by how much at a
 * time. See `applyWorkCalendarDetailed`.
 */
const NUDGE_MS = 60_000
const MAX_COLLAPSE_SPREAD_MS = 60 * NUDGE_MS
/** Below this, a spread is not worth telling anyone about. */
const SPREAD_WARN_MS = 5 * NUDGE_MS

export function toIsoDate(ms: number): IsoDate {
  const d = new Date(ms)
  const two = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/**
 * `YYYY-MM-DD` → local midnight on that date.
 *
 * **Use this instead of `new Date(iso)`.** The built-in parser treats a bare
 * date as *UTC* midnight per the ECMAScript spec, and every reader in this
 * codebase then asks for local fields — so west of UTC `new Date('2026-10-01')`
 * reports 30 September, and a holiday marked on the calendar lands on the wrong
 * square, shifts the wrong reminder, or is silently not a holiday at all.
 *
 * The whole point of `IsoDate` is that a holiday is a *date*, not an instant;
 * this is the only parse that keeps that true.
 *
 * Returns an invalid Date for anything that is not exactly `YYYY-MM-DD`, so a
 * caller that forgets to validate gets `NaN` rather than a plausible wrong day.
 */
export function parseIsoDate(iso: IsoDate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return new Date(NaN)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
}

/** `isWorkingDay` for callers that hold a date rather than an instant. */
export function isWorkingDayIso(iso: IsoDate, cal: WorkCalendar): boolean {
  const d = parseIsoDate(iso)
  if (Number.isNaN(d.getTime())) return false
  return isWorkingDay(d.getTime(), cal)
}

/** `iso` shifted by whole local days, still a date. Never arithmetic on ms — DST. */
export function addIsoDays(iso: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(iso)
  if (Number.isNaN(d.getTime())) return iso
  d.setDate(d.getDate() + days)
  return toIsoDate(d.getTime())
}

/**
 * Parse a pasted block of dates.
 *
 * Accepts `2026-10-01`, `2026/10/1` and `20261001`, separated by anything that
 * is not a digit or a separator — which covers a comma-separated list, one per
 * line, and the mixed forms people actually paste out of a government notice.
 * Anything unparseable is reported rather than silently dropped: a holiday
 * list that quietly lost three days is worse than one that refused to load.
 */
export function parseDateList(text: string): { dates: IsoDate[]; rejected: string[] } {
  const dates: IsoDate[] = []
  const rejected: string[] = []
  for (const raw of text.split(/[\s,;、，；]+/)) {
    const token = raw.trim()
    if (!token) continue
    const dashed = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(token)
    const packed = /^(\d{4})(\d{2})(\d{2})$/.exec(token)
    const m = dashed ?? packed
    if (!m) {
      rejected.push(token)
      continue
    }
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    // Round-trip through Date to reject 2026-02-31 and friends, which every
    // "just check 1..31" validator lets through.
    const probe = new Date(y, mo - 1, d)
    if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
      rejected.push(token)
      continue
    }
    const iso = toIsoDate(probe.getTime())
    if (!dates.includes(iso)) dates.push(iso)
  }
  dates.sort()
  return { dates, rejected }
}

/**
 * Is this instant on a working day?
 *
 * Precedence is explicit and matters: an entry in `workdays` beats the weekend,
 * and an entry in `holidays` beats everything. A date that is in both lists is
 * a holiday — the safer answer, because sending on a day off is the mistake
 * that gets noticed.
 */
export function isWorkingDay(ms: number, cal: WorkCalendar): boolean {
  const iso = toIsoDate(ms)
  if (cal.holidays.includes(iso)) return false
  if (cal.workdays.includes(iso)) return true
  return !cal.weekend.includes(new Date(ms).getDay())
}

/**
 * The nearest working day in one direction, keeping the time of day.
 *
 * Built from local calendar fields rather than by adding 86 400 000 ms, so a
 * daylight-saving transition in between still lands on the wall-clock time the
 * user asked for. Returns null when no working day exists within a month,
 * which in practice means the calendar marks every day as a holiday.
 */
export function shiftToWorkingDay(
  ms: number,
  cal: WorkCalendar,
  direction: 'before' | 'after',
): number | null {
  if (isWorkingDay(ms, cal)) return ms
  const step = direction === 'after' ? 1 : -1
  const cursor = new Date(ms)
  for (let i = 0; i < MAX_SHIFT_DAYS; i++) {
    cursor.setDate(cursor.getDate() + step)
    if (isWorkingDay(cursor.getTime(), cal)) return cursor.getTime()
  }
  return null
}

/**
 * Everything the calendar did to an occurrence list, so none of it is silent.
 *
 * `skipped` is the policy working as asked; `dropped` and `crowded` are the
 * calendar failing to honour it, and those two are the reason this type exists.
 */
export interface CalendarAdjustment {
  /** Removed on purpose by `policy: 'skip'`. Expected, not a problem. */
  skipped: number[]
  /**
   * No working day within `MAX_SHIFT_DAYS` in the requested direction, so the
   * reminder is gone. **This is a send that will not happen**, and it used to
   * vanish without a trace.
   */
  dropped: number[]
  /** Moved off a non-working day, `{ from, to }`. */
  moved: Array<{ from: number; to: number }>
  /** Nudged later to stay distinct from an earlier arrival at the same instant. */
  spread: Array<{ at: number; byMs: number }>
  /**
   * Left sharing an instant with another occurrence because nudging further
   * would have crossed the spread cap or the end of the working day.
   */
  crowded: number[]
}

function emptyAdjustment(): CalendarAdjustment {
  return { skipped: [], dropped: [], moved: [], spread: [], crowded: [] }
}

/**
 * The part of a `CalendarAdjustment` a user needs to be told about, small
 * enough to store on the job and hand to the health strip.
 *
 * `undefined` means "nothing worth saying" — so a job carrying one of these is
 * always a job with something wrong, and a stale one can be cleared by simply
 * recomputing.
 */
export interface CalendarWarning {
  /** When it was computed, so an old warning can be recognised as old. */
  at: number
  /** Fire times that will never be sent. Empty unless something went wrong. */
  dropped: number[]
  /** How many occurrences ended up sharing an instant with another. */
  crowded: number
  /** The widest a same-instant collapse had to spread things, in ms. */
  spreadMs: number
}

export function calendarWarning(
  adj: CalendarAdjustment,
  now = Date.now(),
): CalendarWarning | undefined {
  const spreadMs = adj.spread.reduce((max, s) => Math.max(max, s.byMs), 0)
  if (adj.dropped.length === 0 && adj.crowded.length === 0 && spreadMs < SPREAD_WARN_MS) {
    return undefined
  }
  return { at: now, dropped: [...adj.dropped], crowded: adj.crowded.length, spreadMs }
}

/**
 * Reserve an instant, nudging later if it is already taken — but not forever.
 *
 * Collapsing is intentional: three reminders that all fall inside the same
 * public holiday and all shift to the following Monday would otherwise arrive
 * as three identical messages at the same instant. The nudge is capped for two
 * reasons the uncapped version got wrong: a burst of a few hundred would have
 * spread over several *hours* with nothing on screen saying so, and a large
 * enough nudge walks the occurrence off the end of the working day it was just
 * moved onto — quietly undoing the policy that put it there.
 *
 * At the cap the occurrence keeps its instant rather than being dropped. A
 * duplicate timestamp is a visible annoyance; a missing send is the failure
 * this application exists to prevent.
 */
function place(base: number, seen: Set<number>, adj: CalendarAdjustment): number {
  const day = toIsoDate(base)
  let t = base
  while (seen.has(t)) {
    const next = t + NUDGE_MS
    if (next - base > MAX_COLLAPSE_SPREAD_MS) break
    if (toIsoDate(next) !== day) break
    t = next
  }
  if (t !== base) adj.spread.push({ at: base, byMs: t - base })
  if (seen.has(t)) adj.crowded.push(t)
  else seen.add(t)
  return t
}

/**
 * Rewrite an occurrence list according to the policy, and say what that cost.
 *
 * The plain `applyWorkCalendar` below discards the second half of the answer,
 * which is exactly how a reminder used to disappear in silence. Prefer this one
 * anywhere the result can reach a user.
 */
export function applyWorkCalendarDetailed(
  occurrences: number[],
  policy: WorkdayPolicy,
  cal: WorkCalendar,
): { occurrences: number[]; adjustment: CalendarAdjustment } {
  const adjustment = emptyAdjustment()
  if (policy === 'off') return { occurrences, adjustment }

  const seen = new Set<number>()
  const out: number[] = []

  for (const at of occurrences) {
    if (isWorkingDay(at, cal)) {
      out.push(place(at, seen, adjustment))
      continue
    }
    if (policy === 'skip') {
      adjustment.skipped.push(at)
      continue
    }

    const shifted = shiftToWorkingDay(at, cal, policy)
    if (shifted === null) {
      // Every day within a month is off. Dropping is the only thing left to
      // do, but it is now recorded — see `calendarWarning`.
      adjustment.dropped.push(at)
      continue
    }
    adjustment.moved.push({ from: at, to: shifted })
    out.push(place(shifted, seen, adjustment))
  }

  return { occurrences: out.sort((a, b) => a - b), adjustment }
}

/** The list only. Kept for callers that genuinely cannot report anything. */
export function applyWorkCalendar(
  occurrences: number[],
  policy: WorkdayPolicy,
  cal: WorkCalendar,
): number[] {
  return applyWorkCalendarDetailed(occurrences, policy, cal).occurrences
}

// ---------------------------------------------------------------------------
// Moving a calendar between installs
// ---------------------------------------------------------------------------

/**
 * What an incoming calendar would change here.
 *
 * Computed rather than applied, because the two calendars mean different
 * things: the holiday lists are facts about a country and merge cleanly, while
 * `weekend` is a fact about where the *reader* lives. Silently taking Friday
 * and Saturday off because a colleague in Riyadh exported the file would break
 * every reminder on the importing machine, including the ones that had nothing
 * to do with the import.
 */
export interface CalendarDiff {
  /** Holiday dates in the incoming calendar that this install does not have. */
  newHolidays: IsoDate[]
  /** Make-up workdays likewise. */
  newWorkdays: IsoDate[]
  /** True when the two disagree about which weekdays are not worked. */
  weekendDiffers: boolean
  incomingWeekend: number[]
  localWeekend: number[]
  /** True when there is nothing at all to decide. */
  identical: boolean
}

export function diffCalendars(local: WorkCalendar, incoming: WorkCalendar): CalendarDiff {
  const newHolidays = incoming.holidays.filter((d) => !local.holidays.includes(d)).sort()
  const newWorkdays = incoming.workdays.filter((d) => !local.workdays.includes(d)).sort()
  const weekendDiffers =
    [...incoming.weekend].sort().join(',') !== [...local.weekend].sort().join(',')
  return {
    newHolidays,
    newWorkdays,
    weekendDiffers,
    incomingWeekend: [...incoming.weekend],
    localWeekend: [...local.weekend],
    identical: newHolidays.length === 0 && newWorkdays.length === 0 && !weekendDiffers,
  }
}

/**
 * `keep` — change nothing.
 * `merge` — add the file's dates, keep this machine's working week.
 * `replace` — adopt the file's calendar wholesale.
 *
 * `merge` is the only one that is safe without asking, because it is purely
 * additive: nothing this install already knew is removed.
 */
export type CalendarMergeChoice = 'keep' | 'merge' | 'replace'

export function mergeCalendars(
  local: WorkCalendar,
  incoming: WorkCalendar,
  choice: CalendarMergeChoice,
): WorkCalendar {
  if (choice === 'keep') return local
  if (choice === 'replace') {
    return {
      weekend: [...incoming.weekend],
      holidays: [...incoming.holidays].sort(),
      workdays: [...incoming.workdays].sort(),
    }
  }
  const union = (a: IsoDate[], b: IsoDate[]) => [...new Set([...a, ...b])].sort()
  return {
    weekend: [...local.weekend],
    holidays: union(local.holidays, incoming.holidays),
    workdays: union(local.workdays, incoming.workdays),
  }
}
