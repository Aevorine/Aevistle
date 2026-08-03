/**
 * Recurrence engine.
 *
 * Design note — why occurrences are *precomputed* into a list:
 * Android runs scheduled sends inside a WorkManager worker that may fire long
 * after the WebView is gone, so it cannot ask JavaScript "when is the next
 * one?". Instead the core precomputes a list of absolute timestamps and the
 * platform only ever has to answer "wake me at T". That keeps every calendar
 * rule in this one file, in one language, testable without an emulator.
 */

import type { Recurrence } from './types'

/** Bound on how far ahead we are willing to search for the next match. */
const MAX_SEARCH_DAYS = 366 * 5
const MINUTE = 60_000

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are both Sunday)
]

const MONTH_ALIASES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DOW_ALIASES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

function parseField(raw: string, index: number): Set<number> {
  const [lo, hi] = FIELD_RANGES[index]
  const out = new Set<number>()
  const alias = index === 3 ? MONTH_ALIASES : index === 4 ? DOW_ALIASES : null

  for (const chunk of raw.split(',')) {
    const part = chunk.trim().toLowerCase()
    if (!part) throw new Error(`empty item in field ${index + 1}`)

    let step = 1
    let body = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      body = part.slice(0, slash)
      const stepText = part.slice(slash + 1)
      step = Number(stepText)
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${stepText}"`)
    }

    let start: number
    let end: number
    if (body === '*') {
      start = lo
      end = hi
    } else {
      const dash = body.indexOf('-', 1)
      if (dash > 0) {
        start = readNumber(body.slice(0, dash), alias)
        end = readNumber(body.slice(dash + 1), alias)
      } else {
        start = readNumber(body, alias)
        end = slash >= 0 ? hi : start
      }
    }
    if (start < lo || end > hi || start > end) {
      throw new Error(`value out of range in field ${index + 1}: "${part}"`)
    }
    for (let v = start; v <= end; v += step) out.add(v)
  }

  if (out.size === 0) throw new Error(`field ${index + 1} matches nothing`)
  return out
}

function readNumber(text: string, alias: Record<string, number> | null): number {
  const t = text.trim()
  if (alias && t in alias) return alias[t]
  const n = Number(t)
  if (!Number.isInteger(n)) throw new Error(`"${text}" is not a number`)
  return n
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron needs 5 fields (minute hour day month weekday), got ${parts.length}`)
  }
  const minutes = parseField(parts[0], 0)
  const hours = parseField(parts[1], 1)
  const daysOfMonth = parseField(parts[2], 2)
  const months = parseField(parts[3], 3)
  const rawDow = parseField(parts[4], 4)

  // Cron treats 7 as Sunday; normalise so Date.getDay() comparisons work.
  const daysOfWeek = new Set<number>()
  for (const d of rawDow) daysOfWeek.add(d === 7 ? 0 : d)

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

/** Validate without throwing — used by the UI to show a red/green hint. */
export function validateCron(expression: string): { ok: true } | { ok: false; error: string } {
  try {
    parseCron(expression)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function cronDayMatches(f: CronFields, d: Date): boolean {
  if (!f.months.has(d.getMonth() + 1)) return false
  const domHit = f.daysOfMonth.has(d.getDate())
  const dowHit = f.daysOfWeek.has(d.getDay())
  // Standard cron: when both day fields are restricted the match is an OR.
  if (f.domRestricted && f.dowRestricted) return domHit || dowHit
  if (f.domRestricted) return domHit
  if (f.dowRestricted) return dowHit
  return true
}

function nextCron(expression: string, afterMs: number): number | null {
  const f = parseCron(expression)
  const hours = [...f.hours].sort((a, b) => a - b)
  const minutes = [...f.minutes].sort((a, b) => a - b)

  const cursor = new Date(afterMs)
  cursor.setSeconds(0, 0)

  for (let day = 0; day <= MAX_SEARCH_DAYS; day++) {
    const probe = new Date(cursor)
    probe.setDate(probe.getDate() + day)
    if (!cronDayMatches(f, probe)) continue
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(probe)
        t.setHours(h, m, 0, 0)
        if (t.getTime() > afterMs) return t.getTime()
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Calendar recurrences
// ---------------------------------------------------------------------------

function splitTimeOfDay(hhmm: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return [9, 0]
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const min = Math.min(59, Math.max(0, Number(m[2])))
  return [h, min]
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

/** Push a weekend fire time forward to the following Monday, same time. */
function shiftOffWeekend(t: number): number {
  const d = new Date(t)
  while (isWeekend(d)) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * The next fire time strictly after `afterMs`, ignoring end conditions.
 * Returns null when the rule can never fire again.
 */
export function nextFireAfter(rec: Recurrence, afterMs: number): number | null {
  const floor = Math.max(afterMs, rec.startAt - 1)

  let result: number | null = null

  switch (rec.kind) {
    case 'once': {
      result = rec.startAt > afterMs ? rec.startAt : null
      break
    }

    case 'interval': {
      // Sub-minute cadences take `intervalMs` directly; the calendar branches
      // below stay minute-granular on purpose — see the field's doc comment
      // in types.ts.
      const step = rec.intervalMs ?? Math.max(1, rec.intervalMinutes ?? 60) * MINUTE
      if (rec.startAt > afterMs) {
        result = rec.startAt
      } else {
        const elapsed = afterMs - rec.startAt
        const steps = Math.floor(elapsed / step) + 1
        result = rec.startAt + steps * step
      }
      break
    }

    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'yearly': {
      const [hh, mm] = splitTimeOfDay(rec.timeOfDay)
      const cursor = new Date(floor)
      cursor.setHours(0, 0, 0, 0)

      for (let day = 0; day <= MAX_SEARCH_DAYS; day++) {
        const probe = new Date(cursor)
        probe.setDate(probe.getDate() + day)

        if (!calendarDayMatches(rec, probe)) continue

        probe.setHours(hh, mm, 0, 0)
        const t = probe.getTime()
        if (t > afterMs && t >= rec.startAt) {
          result = t
          break
        }
      }
      break
    }

    case 'cron': {
      if (!rec.cron) return null
      try {
        // Flooring the search at startAt-1 already guarantees result >= startAt.
        result = nextCron(rec.cron, floor)
      } catch {
        return null
      }
      break
    }
  }

  if (result === null) return null

  if (rec.skipWeekends && rec.kind !== 'once') {
    const shifted = shiftOffWeekend(result)
    // Shifting can land us on or before `afterMs`; step forward if so.
    if (shifted <= afterMs) return nextFireAfter(rec, shifted)
    result = shifted
  }

  return result
}

function calendarDayMatches(rec: Recurrence, probe: Date): boolean {
  switch (rec.kind) {
    case 'daily':
      return true

    case 'weekly': {
      const days = rec.weekdays && rec.weekdays.length > 0
        ? rec.weekdays
        : [new Date(rec.startAt).getDay()]
      return days.includes(probe.getDay())
    }

    case 'monthly': {
      const want = rec.dayOfMonth ?? new Date(rec.startAt).getDate()
      const last = lastDayOfMonth(probe.getFullYear(), probe.getMonth())
      if (want > last) {
        return rec.monthDayFallback === 'last' && probe.getDate() === last
      }
      return probe.getDate() === want
    }

    case 'yearly': {
      const ref = new Date(rec.startAt)
      const wantMonth = (rec.month ?? ref.getMonth() + 1) - 1
      const wantDay = rec.dayOfMonth ?? ref.getDate()
      if (probe.getMonth() !== wantMonth) return false
      const last = lastDayOfMonth(probe.getFullYear(), probe.getMonth())
      if (wantDay > last) {
        return rec.monthDayFallback === 'last' && probe.getDate() === last
      }
      return probe.getDate() === wantDay
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Occurrence lists
// ---------------------------------------------------------------------------

export interface OccurrenceOptions {
  /** Runs already completed, counted against `maxRuns`. */
  runsSoFar?: number
  /** How many future timestamps to produce. */
  count?: number
  /** Compute occurrences strictly after this instant. */
  after?: number
}

/**
 * Produce the next `count` fire times, honouring the end condition.
 * An empty array means "this job will never fire again".
 */
export function computeOccurrences(rec: Recurrence, opts: OccurrenceOptions = {}): number[] {
  const count = Math.max(1, opts.count ?? 24)
  const runsSoFar = opts.runsSoFar ?? 0
  const after = opts.after ?? Date.now()

  const out: number[] = []
  let cursor = after
  let produced = 0

  // A hard iteration ceiling so a pathological rule can never spin forever.
  for (let guard = 0; guard < count * 64 && produced < count; guard++) {
    const next = nextFireAfter(rec, cursor)
    if (next === null) break

    if (rec.endMode === 'onDate' && rec.endDate !== undefined && next > rec.endDate) break
    if (rec.endMode === 'afterCount' && rec.maxRuns !== undefined) {
      if (runsSoFar + produced >= rec.maxRuns) break
    }

    out.push(next)
    produced++
    cursor = next

    if (rec.kind === 'once') break
  }

  return out
}

/**
 * Occurrences that were missed while the device was off, plus the future list.
 * Applies the catch-up policy: `fireOnce` collapses any backlog into a single
 * immediate send, `skip` drops it.
 */
export interface RearmResult {
  /** Fire right now (at most one entry, by design — nobody wants 40 copies). */
  dueNow: number[]
  /** Upcoming timestamps to hand to the platform scheduler. */
  upcoming: number[]
}

export function rearm(
  rec: Recurrence,
  storedOccurrences: number[],
  opts: { now?: number; runsSoFar?: number; count?: number } = {},
): RearmResult {
  const now = opts.now ?? Date.now()
  const missed = storedOccurrences.filter((t) => t <= now)
  const dueNow = rec.catchUp === 'fireOnce' && missed.length > 0 ? [missed[missed.length - 1]] : []

  const stillFuture = storedOccurrences.filter((t) => t > now)
  const needed = Math.max(1, opts.count ?? 24)

  if (stillFuture.length >= needed) {
    return { dueNow, upcoming: stillFuture.slice(0, needed) }
  }

  const seed = stillFuture.length > 0 ? stillFuture[stillFuture.length - 1] : now
  const more = computeOccurrences(rec, {
    after: seed,
    count: needed - stillFuture.length,
    runsSoFar: (opts.runsSoFar ?? 0) + missed.length,
  })

  return { dueNow, upcoming: [...stillFuture, ...more] }
}

/** Apply the per-run random jitter, in ms. Kept separate so it is testable. */
export function applyJitter(baseMs: number, jitterSeconds: number, rand = Math.random): number {
  if (jitterSeconds <= 0) return baseMs
  return baseMs + Math.floor(rand() * jitterSeconds * 1000)
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

export interface QuietHours {
  enabled: boolean
  /** 'HH:mm', local time. */
  start: string
  end: string
}

function minutesOfDay(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/**
 * Whether an instant falls inside the nightly window.
 *
 * The window wraps midnight whenever `start` is later than `end`, which is the
 * normal case — 22:00 to 07:00 is one window, not "the 15 hours in between".
 */
export function isQuiet(ms: number, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false
  const start = minutesOfDay(quiet.start)
  const end = minutesOfDay(quiet.end)
  // An unparseable or empty window must never hold mail back: failing open is
  // the only safe direction for a tool whose job is delivering on time.
  if (start === null || end === null || start === end) return false

  const at = new Date(ms)
  const now = at.getHours() * 60 + at.getMinutes()
  return start < end ? now >= start && now < end : now >= start || now < end
}

/**
 * Move an instant to the moment quiet hours end.
 *
 * Built from local calendar fields rather than by adding milliseconds, so a
 * daylight-saving transition inside the window still lands on the wall-clock
 * time the user asked for.
 */
export function shiftPastQuiet(ms: number, quiet: QuietHours): number {
  if (!isQuiet(ms, quiet)) return ms
  const end = minutesOfDay(quiet.end)
  if (end === null) return ms

  const at = new Date(ms)
  const candidate = new Date(at)
  candidate.setHours(Math.floor(end / 60), end % 60, 0, 0)
  // Already past today's end boundary means the window wrapped midnight and
  // the release point is tomorrow morning.
  if (candidate.getTime() <= ms) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/**
 * Push every occurrence out of the quiet window.
 *
 * Applied where the occurrence list is built rather than where mail is sent,
 * so it holds on both platforms without either native scheduler knowing the
 * feature exists — the desktop timer and the Android alarm both simply get a
 * later timestamp. Duplicates are collapsed: two reminders due at 02:00 and
 * 03:00 would otherwise both be released at exactly 07:00.
 */
export function applyQuietHours(occurrences: number[], quiet: QuietHours): number[] {
  if (!quiet.enabled) return occurrences
  const seen = new Set<number>()
  const out: number[] = []
  for (const at of occurrences) {
    let shifted = shiftPastQuiet(at, quiet)
    // A minute apart is enough to keep them distinct without drifting far from
    // the boundary the user chose.
    while (seen.has(shifted)) shifted += 60_000
    seen.add(shifted)
    out.push(shifted)
  }
  return out.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Human-readable summary (structured — the UI supplies the words)
// ---------------------------------------------------------------------------

export interface RecurrenceSummary {
  key: string
  values: Record<string, string | number>
}

export function summarizeRecurrence(rec: Recurrence): RecurrenceSummary {
  const time = rec.timeOfDay
  switch (rec.kind) {
    case 'once':
      return { key: 'recur.summary.once', values: {} }
    case 'interval': {
      if (rec.intervalMs !== undefined) {
        const ms = rec.intervalMs
        if (ms < 1000) return { key: 'recur.summary.everyNMs', values: { n: ms } }
        if (ms % 60_000 !== 0) {
          return { key: 'recur.summary.everyNSeconds', values: { n: Math.round(ms / 1000) } }
        }
        const fromMs = ms / 60_000
        if (fromMs % 1440 === 0) return { key: 'recur.summary.everyNDays', values: { n: fromMs / 1440 } }
        if (fromMs % 60 === 0) return { key: 'recur.summary.everyNHours', values: { n: fromMs / 60 } }
        return { key: 'recur.summary.everyNMinutes', values: { n: fromMs } }
      }
      const m = rec.intervalMinutes ?? 60
      if (m % 1440 === 0) return { key: 'recur.summary.everyNDays', values: { n: m / 1440 } }
      if (m % 60 === 0) return { key: 'recur.summary.everyNHours', values: { n: m / 60 } }
      return { key: 'recur.summary.everyNMinutes', values: { n: m } }
    }
    case 'daily':
      return { key: 'recur.summary.daily', values: { time } }
    case 'weekly':
      return { key: 'recur.summary.weekly', values: { time, count: (rec.weekdays ?? []).length } }
    case 'monthly':
      return {
        key: 'recur.summary.monthly',
        values: { time, day: rec.dayOfMonth ?? new Date(rec.startAt).getDate() },
      }
    case 'yearly':
      return { key: 'recur.summary.yearly', values: { time } }
    case 'cron':
      return { key: 'recur.summary.cron', values: { expr: rec.cron ?? '' } }
  }
}
