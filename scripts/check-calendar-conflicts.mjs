/**
 * The calendar screen's own logic: conflicts, dragging, year ranges, and the
 * Chinese statutory tables.
 *
 * Four separate things that all fail the same way — by looking like they
 * worked:
 *
 *   - **Conflicts.** Every one of these states is reachable today and reported
 *     nowhere. A calendar with no working day left drops sends silently; four
 *     reminders shifted onto one Monday morning arrive as four messages in one
 *     instant; a `skip` policy on a Saturday-only rule is a reminder that is
 *     armed, shows a next-run time, and will never fire.
 *   - **Dragging a reminder.** Moving *one send* and moving *the rule* are
 *     different operations, and only the second is possible for a repeating
 *     reminder. A drag that quietly rewrote a weekly rule when the user meant
 *     to move one message is the failure this plan/confirm split exists to
 *     stop, so the refusals are asserted as hard as the successes.
 *   - **Year ranges.** Applying a preset used to fill exactly the year on
 *     screen with no way to remove one afterwards. The range has to be bounded
 *     (a "from 1970 to 2099" typo is 800 dates in a file read on every launch)
 *     and pruning has to take out the year asked for and nothing else.
 *   - **The Chinese tables.** These cannot be computed, so the only thing that
 *     can be checked is that the transcription is internally right and that a
 *     year nobody has announced comes back as *nothing* rather than as a guess.
 *     The 2026 dates below are the ones in the State Council notice; if this
 *     file and `cnHolidays.ts` ever disagree, one of them was edited carelessly.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-conflicts-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-conflicts-'))
}

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    external: ['react', 'react-dom'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const conflicts = await load('src/core/conflicts.ts', 'conflicts')
const reschedule = await load('src/core/reschedule.ts', 'reschedule')
const presets = await load('src/core/holidayPresets.ts', 'presets')
const cn = await load('src/core/cnHolidays.ts', 'cnHolidays')
const cal = await load('src/core/workCalendar.ts', 'workCalendar')

const failures = []
let checked = 0
const ok = (what, pass) => {
  checked++
  if (!pass) failures.push(what)
}
const eq = (what, actual, expected) =>
  ok(
    `${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected),
  )
const present = (what, value) => {
  checked++
  if (typeof value !== 'function') failures.push(`${what} — the export does not exist`)
  return typeof value === 'function'
}
/**
 * "There is at least one, so the assertions about it can run."
 *
 * Removing a detection rule must produce a *named* failure, not a
 * `Cannot read properties of undefined` three lines later — a guard that dies
 * on the first missing thing hides every other consequence of the same change,
 * which is exactly when you most want the whole list.
 */
const some = (what, list) => {
  checked++
  const pass = Array.isArray(list) && list.length > 0
  if (!pass) failures.push(`${what} — nothing was reported at all`)
  return pass
}

const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
const iso = (ms) => cal.toIsoDate(ms)
const NOW = at(2026, 6, 1, 8)
const PLAIN = { weekend: [0, 6], holidays: [], workdays: [] }

const baseRec = {
  kind: 'daily',
  startAt: NOW,
  timeOfDay: '09:00',
  monthDayFallback: 'last',
  endMode: 'never',
  jitterSeconds: 0,
  skipWeekends: false,
  catchUp: 'fireOnce',
}

function job(id, recurrence, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    draft: { accountId: 'a', to: ['x@example.com'], cc: [], bcc: [], subject: 'S', body: '', attachments: [] },
    recurrence,
    occurrences: [],
    runCount: 0,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
    status: 'armed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// ===========================================================================
// N reminders on the same minute
// ===========================================================================

if (present('conflicts: findConflicts is exported', conflicts.findConflicts)) {
  const daily = (id) => job(id, { ...baseRec, kind: 'daily', startAt: at(2026, 6, 2, 9), timeOfDay: '09:00' })

  const three = conflicts.findConflicts([daily('a'), daily('b'), daily('c')], PLAIN, { now: NOW, days: 10 })
  const stacked = three.conflicts.filter((c) => c.kind === 'sameMinute')
  if (some('sameMinute: three reminders on one minute are reported', stacked)) {
    eq('sameMinute: and all three are named', stacked[0].jobIds.slice().sort(), ['a', 'b', 'c'])
    eq('sameMinute: on the minute they share', iso(stacked[0].at), '2026-06-02')
  }

  // Two is a choice, not a mistake. Flagging it would make the panel noise.
  const two = conflicts.findConflicts([daily('a'), daily('b')], PLAIN, { now: NOW, days: 10 })
  eq('sameMinute: two is not a conflict', two.conflicts.filter((c) => c.kind === 'sameMinute').length, 0)

  // A minute apart is not a collision.
  const apart = conflicts.findConflicts(
    [daily('a'), daily('b'), job('c', { ...baseRec, startAt: at(2026, 6, 2, 9, 1), timeOfDay: '09:01' })],
    PLAIN,
    { now: NOW, days: 10 },
  )
  eq('sameMinute: 09:01 does not collide with 09:00',
     apart.conflicts.filter((c) => c.kind === 'sameMinute').length, 0)

  // A paused reminder arms nothing, so it cannot collide with anything.
  const paused = conflicts.findConflicts(
    [daily('a'), daily('b'), { ...daily('c'), enabled: false }],
    PLAIN,
    { now: NOW, days: 10 },
  )
  eq('sameMinute: a paused reminder is not counted',
     paused.conflicts.filter((c) => c.kind === 'sameMinute').length, 0)
}

// ===========================================================================
// Every send skipped
// ===========================================================================

{
  // Weekly, Saturdays only, with "skip it" — every single fire is dropped.
  const saturdays = job('sat', {
    ...baseRec,
    kind: 'weekly',
    weekdays: [6],
    startAt: at(2026, 6, 6, 9),
    workdayPolicy: 'skip',
  })
  const scan = conflicts.findConflicts([saturdays], PLAIN, { now: NOW, days: 60 })
  const all = scan.conflicts.filter((c) => c.kind === 'allSkipped')
  if (some('allSkipped: a Saturday-only rule with skip never sends', all)) {
    eq('allSkipped: exactly one report, not one per occurrence', all.length, 1)
    eq('allSkipped: and it is an error, not a note', all[0].severity, 'error')
    eq('allSkipped: it names the reminder', all[0].jobIds, ['sat'])
  }

  // The same rule with "move later" is fine — it lands on Monday.
  const moved = conflicts.findConflicts(
    [{ ...saturdays, recurrence: { ...saturdays.recurrence, workdayPolicy: 'after' } }],
    PLAIN,
    { now: NOW, days: 60 },
  )
  eq('allSkipped: shifting instead of skipping is not a conflict',
     moved.conflicts.filter((c) => c.kind === 'allSkipped').length, 0)

  // A reminder that has simply finished is not broken.
  const finished = conflicts.findConflicts(
    [job('done', { ...baseRec, kind: 'once', startAt: at(2020, 1, 1, 9), workdayPolicy: 'skip' })],
    PLAIN,
    { now: NOW, days: 60 },
  )
  eq('allSkipped: a reminder with nothing left to send is not flagged',
     finished.conflicts.filter((c) => c.kind === 'allSkipped').length, 0)
}

// ===========================================================================
// Nowhere to move to
// ===========================================================================

{
  const blocked = []
  for (let i = 0; i < 60; i++) blocked.push(iso(at(2026, 6, 1) + i * 86_400_000))
  const CLOSED = { weekend: [0, 6], holidays: blocked, workdays: [] }

  const scan = conflicts.findConflicts(
    [job('shut', { ...baseRec, kind: 'daily', startAt: at(2026, 6, 2, 9), workdayPolicy: 'after' })],
    CLOSED,
    { now: NOW, days: 30 },
  )
  const nowhere = scan.conflicts.filter((c) => c.kind === 'nowhereToGo')
  if (some('nowhereToGo: a fully-closed calendar drops sends, and says so', nowhere)) {
    eq('nowhereToGo: reported as an error', nowhere[0].severity, 'error')
    ok('nowhereToGo: with a count of what will not be sent', nowhere[0].count > 0)
    ok('nowhereToGo: and the day it happens on', Boolean(nowhere[0].date))
  }

  // The same calendar and the same rule with the policy off: nothing to report,
  // because nothing is being moved.
  const off = conflicts.findConflicts(
    [job('shut', { ...baseRec, kind: 'daily', startAt: at(2026, 6, 2, 9), workdayPolicy: 'off' })],
    CLOSED,
    { now: NOW, days: 30 },
  )
  eq('nowhereToGo: a reminder that ignores the calendar is not affected by it',
     off.conflicts.filter((c) => c.kind === 'nowhereToGo').length, 0)
}

// ===========================================================================
// The pile-up
// ===========================================================================

{
  // Twenty consecutive holidays and a daily 23:45 reminder shifted backwards:
  // every one of them lands on the same evening.
  const block = []
  for (let i = 0; i < 20; i++) block.push(iso(at(2026, 6, 2) + i * 86_400_000))
  const BLOCK = { weekend: [0, 6], holidays: block, workdays: [] }

  const scan = conflicts.findConflicts(
    [job('pileup', { ...baseRec, kind: 'daily', startAt: at(2026, 6, 2, 23, 45), timeOfDay: '23:45', workdayPolicy: 'before' })],
    BLOCK,
    { now: NOW, days: 25 },
  )
  ok(
    'pile-up: a collapse is reported as crowded or spread',
    scan.conflicts.some((c) => c.kind === 'crowded' || c.kind === 'spread'),
  )

  const byDate = scan.byDate
  ok('index: conflicts are indexed by date for the grid', byDate.size > 0)
  ok(
    'index: every indexed conflict is in the list',
    [...byDate.values()].flat().every((c) => scan.conflicts.includes(c)),
  )
}

{
  const clean = conflicts.findConflicts(
    [job('fine', { ...baseRec, kind: 'weekly', weekdays: [2], startAt: at(2026, 6, 2, 9), workdayPolicy: 'after' })],
    PLAIN,
    { now: NOW, days: 60 },
  )
  eq('clean: an ordinary schedule produces no conflicts', clean.conflicts.length, 0)
  eq('clean: and nothing to mark on the grid', clean.byDate.size, 0)
  eq('clean: hasBlockingConflict agrees', conflicts.hasBlockingConflict(clean), false)
}

{
  // Errors sort above warnings, whatever order the jobs were in.
  const blockedDates = []
  for (let i = 0; i < 60; i++) blockedDates.push(iso(at(2026, 6, 1) + i * 86_400_000))
  const mixed = conflicts.findConflicts(
    [
      job('a', { ...baseRec, startAt: at(2026, 6, 2, 9) }),
      job('b', { ...baseRec, startAt: at(2026, 6, 2, 9) }),
      job('c', { ...baseRec, startAt: at(2026, 6, 2, 9) }),
      job('z', { ...baseRec, startAt: at(2026, 6, 2, 10), workdayPolicy: 'after' }),
    ],
    { weekend: [0, 6], holidays: blockedDates, workdays: [] },
    { now: NOW, days: 30 },
  )
  ok('order: errors come first', mixed.conflicts[0]?.severity === 'error')
  ok('order: hasBlockingConflict is true when a send will not happen',
     conflicts.hasBlockingConflict(mixed))
}

// ===========================================================================
// Dragging a reminder
// ===========================================================================

if (present('reschedule: planReschedule is exported', reschedule.planReschedule)) {
  // A one-off: the two meanings coincide, so it just moves.
  /** A plan that produced a rule, so the assertions about that rule can run. */
  const planned = (what, plan) => {
    checked++
    if (!plan || !plan.recurrence) {
      failures.push(`${what} — no rule was produced (outcome ${plan?.outcome}, ${plan?.reasonKey})`)
      return false
    }
    return true
  }

  const once = job('once', { ...baseRec, kind: 'once', startAt: at(2026, 6, 2, 9, 30) })
  const single = reschedule.planReschedule(once, '2026-06-02', '2026-06-05')
  eq('drag: a one-off moves one send', single.outcome, 'single')
  if (planned('drag: a one-off produces a rule to save', single)) {
    eq('drag: onto the day it was dropped on', iso(single.recurrence.startAt), '2026-06-05')
    eq('drag: keeping its time of day', reschedule.timeOfDayAt(single.recurrence.startAt), '09:30')
  }

  // A weekly rule: only the *series* can move, and only the dragged weekday.
  // 2026-06-02 is a Tuesday; 2026-06-04 is a Thursday.
  eq('drag (fixture): 2026-06-02 is a Tuesday', new Date(at(2026, 6, 2)).getDay(), 2)
  const weekly = job('weekly', { ...baseRec, kind: 'weekly', weekdays: [2, 5], startAt: at(2026, 6, 2, 9) })
  const series = reschedule.planReschedule(weekly, '2026-06-02', '2026-06-04')
  eq('drag: a weekly rule moves as a series', series.outcome, 'series')
  if (planned('drag: a weekly move produces a rule', series)) {
    eq('drag: the dragged weekday is replaced', series.recurrence.weekdays, [4, 5])
    eq('drag: and the other days are untouched', series.recurrence.weekdays.includes(5), true)
  }

  // Dragging from a day the rule does not name — the calendar put it there.
  const shifted = reschedule.planReschedule(weekly, '2026-06-03', '2026-06-04')
  eq('drag: a send the calendar moved cannot be dragged from where it landed', shifted.outcome, 'refused')
  eq('drag: and says why', shifted.reasonKey, 'cal.move.shiftedSource')

  const monthly = reschedule.planReschedule(
    job('m', { ...baseRec, kind: 'monthly', dayOfMonth: 2, startAt: at(2026, 6, 2, 9) }),
    '2026-06-02',
    '2026-06-17',
  )
  if (planned('drag: a monthly move produces a rule', monthly)) {
    eq('drag: a monthly rule takes the new day of month', monthly.recurrence.dayOfMonth, 17)
  }

  const yearly = reschedule.planReschedule(
    job('y', { ...baseRec, kind: 'yearly', month: 5, dayOfMonth: 2, startAt: at(2026, 6, 2, 9) }),
    '2026-06-02',
    '2026-09-15',
  )
  if (planned('drag: a yearly move produces a rule', yearly)) {
    eq('drag: a yearly rule takes the new month', yearly.recurrence.month, 8)
    eq('drag: and the new day', yearly.recurrence.dayOfMonth, 15)
  }

  const cadence = reschedule.planReschedule(
    job('i', { ...baseRec, kind: 'interval', intervalMs: 3 * 86_400_000, startAt: at(2026, 6, 2, 9) }),
    '2026-06-02',
    '2026-06-04',
  )
  eq('drag: a whole-day cadence shifts its anchor', cadence.outcome, 'series')
  if (planned('drag: a cadence move produces a rule', cadence)) {
    eq('drag: by exactly the days dragged', iso(cadence.recurrence.startAt), '2026-06-04')
    eq('drag: and keeps its cadence', cadence.recurrence.intervalMs, 3 * 86_400_000)
  }

  // The refusals.
  for (const [what, plan] of [
    ['a daily rule', reschedule.planReschedule(job('d', { ...baseRec, kind: 'daily' }), '2026-06-02', '2026-06-04')],
    ['a cron rule', reschedule.planReschedule(job('c', { ...baseRec, kind: 'cron', cron: '0 9 * * *' }), '2026-06-02', '2026-06-04')],
    ['a 90-minute cadence', reschedule.planReschedule(job('s', { ...baseRec, kind: 'interval', intervalMs: 90 * 60_000 }), '2026-06-02', '2026-06-04')],
    ['a drop on the same day', reschedule.planReschedule(job('x', { ...baseRec, kind: 'once' }), '2026-06-02', '2026-06-02')],
    ['a drop on nonsense', reschedule.planReschedule(job('x', { ...baseRec, kind: 'once' }), '2026-06-02', 'soon')],
  ]) {
    eq(`drag: ${what} is refused`, plan.outcome, 'refused')
    ok(`drag: ${what} explains itself`, typeof plan.reasonKey === 'string' && plan.reasonKey.length > 0)
    eq(`drag: ${what} produces no rule to save`, plan.recurrence, undefined)
  }

  // The honest limit, asserted so it cannot be quietly forgotten if the model
  // ever grows an exception list.
  eq('drag: only a one-off can move a single occurrence',
     reschedule.canMoveSingleOccurrence(job('o', { ...baseRec, kind: 'once' })), true)
  eq('drag: a weekly rule cannot',
     reschedule.canMoveSingleOccurrence(job('w', { ...baseRec, kind: 'weekly' })), false)

  // DST. 2026-03-08 is the US spring-forward; a day shift across it must stay
  // on the wall clock, not lose an hour.
  const dst = reschedule.planReschedule(
    job('dst', { ...baseRec, kind: 'once', startAt: at(2026, 3, 7, 9, 30) }),
    '2026-03-07',
    '2026-03-09',
  )
  if (planned('drag: a DST-crossing move produces a rule', dst)) {
    eq('drag: a shift across a DST boundary keeps the wall-clock time',
       reschedule.timeOfDayAt(dst.recurrence.startAt), '09:30')
    eq('drag: and lands on the right date', iso(dst.recurrence.startAt), '2026-03-09')
  }
  eq('drag: dayDelta counts calendar days across DST', reschedule.dayDelta('2026-03-07', '2026-03-09'), 2)
}

// ===========================================================================
// Year ranges and pruning
// ===========================================================================

if (present('presets: applyPresetRange is exported', presets.applyPresetRange)) {
  const CN = presets.HOLIDAY_PRESETS.find((p) => p.id === 'CN')

  eq('years: a range is inclusive', presets.yearRange(2026, 2028), [2026, 2027, 2028])
  eq('years: a reversed range is sorted, not emptied', presets.yearRange(2028, 2026), [2026, 2027, 2028])
  eq('years: a single year is a range of one', presets.yearRange(2026, 2026), [2026])
  eq('years: an absurd range is clamped', presets.yearRange(2000, 2099).length, presets.PRESET_MAX_YEARS)

  const filled = presets.applyPresetRange(PLAIN, CN, 2026, 2028)
  eq('range: three years of a five-date preset is fifteen dates', filled.holidays.length, 15)
  ok('range: 2026 is there', filled.holidays.includes('2026-10-01'))
  ok('range: and 2028', filled.holidays.includes('2028-10-01'))
  ok('range: applying twice adds nothing new',
     presets.applyPresetRange(filled, CN, 2026, 2028).holidays.length === 15)

  // The gap this closes: no way to take one year back out.
  const pruned = presets.clearYear(filled, 2027)
  eq('prune: the year asked for is gone', pruned.holidays.filter((d) => d.startsWith('2027')).length, 0)
  eq('prune: and only that year', pruned.holidays.length, 10)
  ok('prune: the neighbouring years are untouched', pruned.holidays.includes('2026-10-01') && pruned.holidays.includes('2028-10-01'))

  const withMakeup = { ...filled, workdays: ['2027-09-25', '2026-09-25'] }
  eq('prune: make-up days for that year go too',
     presets.clearYear(withMakeup, 2027).workdays, ['2026-09-25'])
  eq('prune: unless only one list was asked for',
     presets.clearYear(withMakeup, 2027, ['holidays']).workdays.sort(), ['2026-09-25', '2027-09-25'])

  eq('years: yearsInCalendar lists what is actually there',
     presets.yearsInCalendar(withMakeup), [2026, 2027, 2028])
  eq('years: countInYear counts both lists',
     presets.countInYear(withMakeup, 2026), { holidays: 5, workdays: 1 })

  // The weekend is a fact about the reader, not the country's holiday list,
  // but a preset is still allowed to set it — that is what picking a country
  // means. Saudi Arabia is the case that matters.
  const SA = presets.HOLIDAY_PRESETS.find((p) => p.id === 'SA')
  eq('range: picking a country sets its working week',
     presets.applyPresetRange(PLAIN, SA, 2026, 2026).weekend, [5, 6])
}

// ===========================================================================
// Names
// ===========================================================================

if (present('names: holidayNameFor is exported', presets.holidayNameFor)) {
  eq('names: a chip can say what the day is',
     presets.holidayNameFor('2026-10-01', { presetId: 'CN' }), 'National Day')
  eq('names: names work in any year, not just the one the table was written for',
     presets.holidayNameFor('2031-07-04', { presetId: 'US' }), 'Independence Day')
  eq('names: an ordinary day has no name',
     presets.holidayNameFor('2026-06-17', { presetId: 'CN' }), undefined)
  eq('names: and that is undefined, not the date echoed back',
     presets.holidayNameFor('2026-06-17'), undefined)

  // An exact date beats a fixed-date guess — this is what the Chinese tables
  // are for.
  const statutory = new Map([['2026-02-17', '春节']])
  eq('names: an exact statutory date wins',
     presets.holidayNameFor('2026-02-17', { statutory, presetId: 'US' }), '春节')

  // With no country chosen, a date several presets name is reported as
  // ambiguous rather than as one country's answer.
  const shared = presets.holidayNameFor('2026-05-01')
  ok('names: a date five countries name is not silently attributed to one',
     typeof shared === 'string' && shared.includes('/'))
}

// ===========================================================================
// The Chinese statutory tables
// ===========================================================================

if (present('cn: statutoryFor is exported', cn.statutoryFor)) {
  const y2026 = cn.statutoryFor(2026, [])
  checked++
  if (!y2026 || !Array.isArray(y2026.days)) failures.push('cn: 2026 is bundled — no table came back')
  else {
  eq('cn: and marked as bundled, not as fresh data', y2026.source, 'bundled')
  ok('cn: with the notice it was transcribed from', typeof y2026.paper === 'string' && y2026.paper.includes('gov.cn'))

  // The transcription, checked against the notice. Spring Festival 2026 is
  // 15–23 February, paid for by working Saturday the 14th and Saturday the 28th.
  const off = new Set(y2026.days.filter((d) => d.off).map((d) => d.date))
  const work = new Set(y2026.days.filter((d) => !d.off).map((d) => d.date))
  ok('cn: Spring Festival starts on 15 February 2026', off.has('2026-02-15'))
  ok('cn: and ends on the 23rd', off.has('2026-02-23'))
  ok('cn: the 24th is back to work', !off.has('2026-02-24'))
  eq('cn: 调休 — Saturday 14 February is a working day', work.has('2026-02-14'), true)
  eq('cn: 调休 — Saturday 28 February is a working day', work.has('2026-02-28'), true)
  eq('cn: National Day runs 1–7 October', [1, 2, 3, 4, 5, 6, 7].every((d) => off.has(`2026-10-0${d}`)), true)
  eq('cn: 调休 — Saturday 10 October is a working day', work.has('2026-10-10'), true)
  eq('cn: 调休 — Sunday 20 September is a working day', work.has('2026-09-20'), true)
  eq('cn: Mid-Autumn is 25–27 September', ['2026-09-25', '2026-09-26', '2026-09-27'].every((d) => off.has(d)), true)

  // A make-up day is a *working* day and must never end up in the holiday list.
  const dates = cn.statutoryToCalendarDates(y2026)
  eq('cn: the two lists do not overlap',
     dates.holidays.filter((d) => dates.workdays.includes(d)), [])
  const applied = cn.applyStatutoryYear(PLAIN, y2026)
  eq('cn: applying leaves 14 February a working day', cal.isWorkingDayIso('2026-02-14', applied), true)
  eq('cn: and 17 February a day off', cal.isWorkingDayIso('2026-02-17', applied), false)
  eq('cn: an ordinary Wednesday is unaffected', cal.isWorkingDayIso('2026-03-11', applied), true)

  }

  // The whole point: an unannounced year is nothing, not a guess.
  eq('cn: a year nobody has published comes back as undefined', cn.statutoryFor(2031, []), undefined)
  eq('cn: knownYears lists only what is actually known', cn.knownYears([]), [2025, 2026])

  // A fetched year replaces the bundle only when it is genuinely newer.
  const stale = { year: 2026, days: [{ date: '2026-01-01', name: 'x', off: true }], source: 'network', obtainedAt: 1 }
  eq('cn: a cache entry older than the bundle loses', cn.statutoryFor(2026, [stale])?.source, 'bundled')
  const fresh = { ...stale, obtainedAt: Date.now() }
  eq('cn: a newer one wins', cn.statutoryFor(2026, [fresh])?.source, 'network')
}

if (present('cn: parseStatutoryPayload is exported', cn.parseStatutoryPayload)) {
  const good = {
    year: 2027,
    papers: ['https://www.gov.cn/example'],
    days: [
      { date: '2027-01-01', name: '元旦', isOffDay: true },
      { date: '2027-01-02', name: '元旦', isOffDay: true },
      { date: '2027-01-04', name: '元旦', isOffDay: false },
    ],
  }
  const parsed = cn.parseStatutoryPayload(good, 2027, 99)
  checked++
  if (!parsed.year) failures.push(`cn feed: a well-formed payload parses — refused with "${parsed.error}"`)
  else {
    eq('cn feed: it is marked as network data', parsed.year.source, 'network')
    eq('cn feed: stamped with when it arrived', parsed.year.obtainedAt, 99)
    eq('cn feed: and keeps the notice URL', parsed.year.paper, 'https://www.gov.cn/example')
  }

  // Hostile input. Every one of these would otherwise install dates that decide
  // whether a reminder is sent.
  const bad = [
    ['not an object', null],
    ['a string', 'nope'],
    ['the wrong year', { year: 2028, days: good.days }],
    ['no days array', { year: 2027 }],
    ['an empty list', { year: 2027, days: [] }],
    ['dates from another year', { year: 2027, days: [{ date: '2026-01-01', name: 'x', isOffDay: true }] }],
    ['no make-up days at all', { year: 2027, days: [{ date: '2027-01-01', name: 'x', isOffDay: true }] }],
    ['isOffDay as a string', { year: 2027, days: [{ date: '2027-01-01', name: 'x', isOffDay: 'true' }] }],
  ]
  for (const [what, payload] of bad) {
    const result = cn.parseStatutoryPayload(payload, 2027, 99)
    ok(`cn feed: ${what} is refused`, result.error !== undefined && result.year === undefined)
  }

  // A payload with one bad entry among good ones keeps the good ones and drops
  // the bad one — silently keeping a malformed date would be worse.
  const partial = cn.parseStatutoryPayload(
    { year: 2027, days: [...good.days, { date: 'soon', name: 'x', isOffDay: true }] },
    2027,
    99,
  )
  eq('cn feed: one unreadable entry does not sink the file', partial.year?.days.length, 3)
  eq('cn feed: and the unreadable one is gone', partial.year?.days.some((d) => d.date === 'soon'), false)

  ok('cn feed: the URL names the year it asks for', cn.cnFeedUrl(2027).endsWith('/2027.json'))
  ok('cn feed: over https', cn.cnFeedUrl(2027).startsWith('https://'))
}

if (present('cn: fetchStatutoryYear is exported', cn.fetchStatutoryYear)) {
  // 404 is the ordinary answer for a year that has not been announced, and it
  // must be reported as "not published" rather than as a failure to retry.
  // Asserted on the flag, not on the wording: the screen has to be able to say
  // this in six languages, so an English sentence is the wrong carrier.
  const missing = await cn.fetchStatutoryYear(2031, {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  })
  ok('cn fetch: a 404 is reported as "not published yet"', missing.unpublished === true)
  ok('cn fetch: a 404 yields no year', missing.year === undefined)

  // The shape that actually happens. `holiday-cn` commits
  // `{"year": Y, "days": []}` as a placeholder, served as a 200, months before
  // the notice exists — and reporting that as a parse failure told the reader
  // their app was broken. This is the case the 2027 row hit in a real build.
  const placeholder = await cn.fetchStatutoryYear(2027, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ year: 2027, papers: [], days: [] }),
    }),
  })
  ok('cn fetch: an empty published file is "not published yet"', placeholder.unpublished === true)
  ok('cn fetch: and installs nothing', placeholder.year === undefined)

  // …but a file that is empty *because it was unreadable* is still an error.
  const garbled = await cn.fetchStatutoryYear(2027, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ year: 2027, days: [{ date: 'nonsense' }, { date: 'also-not' }] }),
    }),
  })
  ok('cn fetch: an unreadable file is NOT reported as unpublished', garbled.unpublished !== true)
  ok('cn fetch: and does say something went wrong', (garbled.error ?? '').length > 0)

  const offline = await cn.fetchStatutoryYear(2027, {
    fetchImpl: async () => {
      throw new Error('Failed to fetch')
    },
  })
  ok('cn fetch: a network failure is returned, not thrown', offline.error === 'Failed to fetch')
  eq('cn fetch: and no year is installed', offline.year, undefined)

  let sentUrl = ''
  let sentInit = null
  const okFetch = await cn.fetchStatutoryYear(2027, {
    now: 42,
    fetchImpl: async (url, init) => {
      sentUrl = url
      sentInit = init
      return {
        ok: true,
        status: 200,
        json: async () => ({
          year: 2027,
          days: [
            { date: '2027-01-01', name: '元旦', isOffDay: true },
            { date: '2027-01-04', name: '元旦', isOffDay: false },
          ],
        }),
      }
    },
  })
  eq('cn fetch: a good answer becomes a year', okFetch.year?.days.length, 2)
  eq('cn fetch: stamped with the time it arrived', okFetch.year?.obtainedAt, 42)
  ok('cn fetch: it asks for the year requested', sentUrl.endsWith('/2027.json'))
  eq('cn fetch: no credentials are sent', sentInit?.credentials, 'omit')
  eq('cn fetch: and no referrer', sentInit?.referrerPolicy, 'no-referrer')
}

// ===========================================================================

await rm(dir, { recursive: true, force: true })

const label = 'the calendar says what it is about to do wrong'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
