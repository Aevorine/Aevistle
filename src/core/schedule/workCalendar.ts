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
 * How the nudge is allowed to move: one direction or both, how far, in what step.
 *
 * `allowEarlier` is the whole reason this is a parameter rather than a
 * constant. Inside one job the nudge may only push *later*: the occurrences
 * arrive in order and an earlier slot is a time the rule already went past.
 * Across jobs — see `spreadSameMinute` — the collision is between rules that
 * each independently chose 09:00, none of them has priority over the others,
 * and pushing four of them strictly later means the last one is twenty minutes
 * out. Spreading around the chosen minute keeps everybody closer to the time
 * they actually asked for.
 */
export interface NudgeOptions {
  /** Smallest move. One minute — `Recurrence.timeOfDay` has no finer unit. */
  stepMs: number
  /** How far from `base` a nudge may end up, in either direction. */
  maxSpreadMs: number
  /** May a slot before `base` be used? */
  allowEarlier: boolean
}

/**
 * Candidate offsets from the base instant, nearest first.
 *
 * `+1, +2, +3…` one-directionally; `+1, −1, +2, −2…` when both are allowed, so
 * the answer is always the closest free slot to the time the user chose.
 */
function* nudgeOffsets({ stepMs, maxSpreadMs, allowEarlier }: NudgeOptions): Generator<number> {
  for (let k = 1; k * stepMs <= maxSpreadMs; k++) {
    yield k * stepMs
    if (allowEarlier) yield -k * stepMs
  }
}

/**
 * Reserve an instant, nudging off it if it is already taken — but not forever.
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
 *
 * The day boundary is never crossed in either direction. A send nudged past
 * midnight is on a day the calendar was not asked about, which is how a
 * "working days only" policy quietly delivers on a Saturday.
 */
export function placeWithin(
  base: number,
  seen: Set<number>,
  adj: CalendarAdjustment,
  options: NudgeOptions,
): number {
  const day = toIsoDate(base)
  let t = base
  if (seen.has(t)) {
    for (const offset of nudgeOffsets(options)) {
      const candidate = base + offset
      if (toIsoDate(candidate) !== day) {
        // Walking one way, the day boundary is the end of the road. Walking
        // both ways, it only rules out this side — the other one may still
        // have room, and giving up there would leave a collision unresolved
        // for every send scheduled near midnight.
        if (!options.allowEarlier) break
        continue
      }
      t = candidate
      if (!seen.has(t)) break
    }
    /*
     * Nothing free inside the cap — so the occurrence keeps its instant, which
     * is what the doc comment above has always promised.
     *
     * The loop leaves `t` on the last candidate it tried, and that candidate
     * is taken too. Measured: 63 occurrences on one instant, one-minute steps,
     * a one-hour cap — #61, #62 and #63 all came back as base + 60 min. Three
     * mails went out together anyway, an hour later than asked, and only the
     * lateness was new. Colliding at `base` is the honest outcome, and it is
     * the one `adj.crowded` below is there to report.
     */
    if (seen.has(t)) t = base
  }
  if (t !== base) adj.spread.push({ at: base, byMs: t - base })
  if (seen.has(t)) adj.crowded.push(t)
  else seen.add(t)
  return t
}

/** The within-one-job nudge: later only, one minute at a time, up to an hour. */
function place(base: number, seen: Set<number>, adj: CalendarAdjustment): number {
  return placeWithin(base, seen, adj, {
    stepMs: NUDGE_MS,
    maxSpreadMs: MAX_COLLAPSE_SPREAD_MS,
    allowEarlier: false,
  })
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
  /**
   * The floor a `'before'` shift may not cross, epoch ms.
   *
   * Opt-in, and absent by default, because the shift itself is pure calendar
   * arithmetic that several callers run over historical dates on purpose — a
   * fixture, a preview of last month, the conflict scan. Pass it from the
   * paths that are arming a real reminder; see the `'before'` branch below for
   * what happens without it.
   */
  notBefore?: number,
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
    /*
     * A `'before'` shift is the one direction that can land in the past, and
     * it did so in silence.
     *
     * Measured: it is 12:00 on Tue 2026-08-10, a one-off is set for Wed 09:00,
     * Wednesday is a holiday, the policy is "move it earlier". The shift
     * returns Tue 09:00 — three hours ago. Nothing here objected, and
     * `upcoming()` then filtered it out for being in the past, so the send
     * preview read "0 sends" with no warning attached and the reminder simply
     * ceased to exist.
     *
     * Dropped and recorded instead, which is the same treatment the
     * no-working-day-within-a-month case already gets: it reaches
     * `calendarWarning`, and the schedule row keeps saying the calendar could
     * not place this one. Moving it later instead would be the wrong repair —
     * "before" is usually chosen because after the date is no use.
     */
    if (notBefore !== undefined && shifted < notBefore) {
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
// De-staggering: the collision the nudge above cannot see
// ---------------------------------------------------------------------------

/**
 * The default window a de-stagger may spread a pile-up over, either side of the
 * minute everybody picked.
 *
 * Five minutes, not an hour. `MAX_COLLAPSE_SPREAD_MS` is generous because it is
 * cleaning up after the *calendar* — a public holiday can shift a whole week of
 * sends onto one morning and something has to give. A de-stagger is a
 * deliberate action on a handful of reminders that genuinely all say 09:00, and
 * a reminder that arrives at 09:47 because two others also wanted nine is not
 * the reminder anybody set.
 */
export const STAGGER_WINDOW_MS = 5 * NUDGE_MS
export const STAGGER_STEP_MS = NUDGE_MS

/** One send in a pile-up, named by the reminder it belongs to. */
export interface StaggerSend {
  jobId: string
  at: number
}

export interface StaggerMove {
  jobId: string
  from: number
  to: number
}

export interface StaggerPlan {
  /** Sends that were given a different instant, in the order they were placed. */
  moves: StaggerMove[]
  /** Sends there was no free slot for. They keep the shared instant. */
  crowded: StaggerSend[]
  windowMs: number
  stepMs: number
}

/**
 * Spread a pile-up **across jobs**, which nothing in this file did before.
 *
 * `applyWorkCalendarDetailed` de-duplicates the occurrences of *one* reminder
 * and cannot do more: it is called once per job, with a `seen` set that lives
 * and dies inside that call. So four different reminders that each say 09:00,
 * or four that a holiday each shifted onto the same Monday morning, arrive as
 * four messages in the same instant — the `sameMinute` conflict
 * `core/conflicts.ts` reports and nothing has ever been able to fix.
 *
 * This is the same nudge, given a `seen` set that spans jobs and permission to
 * move both ways. It plans only; the caller writes the result back, because
 * changing when a *rule* fires is an edit to somebody's reminder and belongs
 * behind a confirmation and an undo.
 *
 * The first send in each minute keeps its instant. Somebody has to, and the
 * alternative — moving all of them — means a de-stagger nobody asked for
 * changes every reminder involved.
 */
export function spreadSameMinute(
  sends: StaggerSend[],
  opts: { windowMs?: number; stepMs?: number; taken?: Iterable<number> } = {},
): StaggerPlan {
  const windowMs = opts.windowMs ?? STAGGER_WINDOW_MS
  const stepMs = opts.stepMs ?? STAGGER_STEP_MS
  const seen = new Set<number>(opts.taken ?? [])
  const adjustment = emptyAdjustment()
  const moves: StaggerMove[] = []
  const crowded: StaggerSend[] = []

  // Earliest first, then by job id. Deterministic on purpose: running a
  // de-stagger twice must produce the same answer, and "whichever order the
  // job list happened to be in" is not that.
  const ordered = [...sends].sort((a, b) => a.at - b.at || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0))

  for (const send of ordered) {
    const before = adjustment.crowded.length
    const to = placeWithin(send.at, seen, adjustment, {
      stepMs,
      maxSpreadMs: windowMs,
      allowEarlier: true,
    })
    if (adjustment.crowded.length > before) crowded.push({ jobId: send.jobId, at: to })
    if (to !== send.at) moves.push({ jobId: send.jobId, from: send.at, to })
  }

  return { moves, crowded, windowMs, stepMs }
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
