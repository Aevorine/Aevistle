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

export function toIsoDate(ms: number): IsoDate {
  const d = new Date(ms)
  const two = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
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
 * Rewrite an occurrence list according to the policy.
 *
 * Collapsing is intentional: three reminders that all fall inside the same
 * public holiday and all shift to the following Monday would otherwise arrive
 * as three identical messages one minute apart. Later ones are nudged by a
 * minute so they stay distinct and ordered, the same trick `applyQuietHours`
 * uses for the same reason.
 */
export function applyWorkCalendar(
  occurrences: number[],
  policy: WorkdayPolicy,
  cal: WorkCalendar,
): number[] {
  if (policy === 'off') return occurrences

  const seen = new Set<number>()
  const out: number[] = []

  for (const at of occurrences) {
    if (isWorkingDay(at, cal)) {
      let t = at
      while (seen.has(t)) t += 60_000
      seen.add(t)
      out.push(t)
      continue
    }
    if (policy === 'skip') continue

    const shifted = shiftToWorkingDay(at, cal, policy)
    if (shifted === null) continue
    let t = shifted
    while (seen.has(t)) t += 60_000
    seen.add(t)
    out.push(t)
  }

  return out.sort((a, b) => a - b)
}

/**
 * Working days between two instants, inclusive of both ends' dates.
 * Used by the schedule screen to answer "how many working days away is this?".
 */
export function workingDaysBetween(fromMs: number, toMs: number, cal: WorkCalendar): number {
  if (toMs < fromMs) return -workingDaysBetween(toMs, fromMs, cal)
  const cursor = new Date(fromMs)
  cursor.setHours(0, 0, 0, 0)
  const end = new Date(toMs)
  end.setHours(0, 0, 0, 0)
  let n = 0
  for (let i = 0; i <= 366 * 5 && cursor.getTime() <= end.getTime(); i++) {
    if (isWorkingDay(cursor.getTime(), cal)) n++
    cursor.setDate(cursor.getDate() + 1)
  }
  return n
}
