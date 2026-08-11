/**
 * Does a yearly reminder fire in the month it says it fires in?
 *
 * `Recurrence.month` is written by exactly two things — an `.ics` import and a
 * drag on the calendar — and read by exactly one: the function that decides
 * whether a given day is a send day. The two writers stored 0 for January.
 * The reader subtracted one first. So an October reminder went out in
 * September, and a January one produced `month: 0 - 1 = -1`, matched no date
 * in any year, and sat in the list marked armed with no next send. Forever.
 *
 * `check:ics` was green throughout, because it only ever asserted that an
 * `.ics` round-trip preserved the number. It never handed the number to the
 * scheduler. That is the difference between asserting a value was computed and
 * asserting it was used, and it is the reason this file exists separately.
 *
 * `--selftest` re-introduces the off-by-one and requires that the checks below
 * go red. A guard nobody has watched fail is not yet a guard.
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const selftest = process.argv.includes('--selftest')

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-yearly-'))
const out = path.join(dir, 'b.mjs')
await build({
  stdin: {
    contents: `
      export { computeOccurrences } from './src/core/schedule/schedule'
      export { parseRRule, rruleToRecurrence, recurrenceToRRule } from './src/core/schedule/ics'
      export { planReschedule } from './src/core/schedule/reschedule'
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const m = await import(pathToFileURL(out).href)
await rm(dir, { recursive: true, force: true })

const results = []
const check = (name, ok, detail) => results.push({ name, ok, detail })

/** Bend the value the way the bug did, so the assertions below can be watched failing. */
const bend = (month) => (selftest ? month + 1 : month)

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const from = Date.UTC(2026, 0, 1, 0, 0, 0)

function firstOccurrence(month, day = 15) {
  const rec = {
    kind: 'yearly',
    startAt: from,
    timeOfDay: '09:00',
    month: bend(month),
    dayOfMonth: day,
    monthDayFallback: 'skip',
    endMode: 'never',
  }
  const list = m.computeOccurrences(rec, { from, limit: 1 })
  return list.length > 0 ? new Date(list[0]) : null
}

// 1. Every month, straight through the scheduler. January is listed like any
//    other because it is the one that used to vanish entirely, and a guard
//    that skips the interesting case is decoration.
for (let month = 0; month < 12; month++) {
  const at = firstOccurrence(month)
  check(
    `yearly in ${MONTHS[month]} fires in ${MONTHS[month]}`,
    at !== null && at.getMonth() === month,
    at === null ? 'no occurrence at all' : `fired in ${MONTHS[at.getMonth()]}`,
  )
}

// 2. The path a real user takes: an .ics file in, then the scheduler.
for (const [byMonth, expected] of [
  [1, 0],
  [10, 9],
  [12, 11],
]) {
  const rule = m.parseRRule(`FREQ=YEARLY;BYMONTH=${byMonth};BYMONTHDAY=15`)
  const rec = rule ? m.rruleToRecurrence(rule, from) : null
  // `rruleToRecurrence` returns a *partial* rule — the importer merges it onto
  // the job's existing one — so the fields it does not own have to be supplied
  // here, exactly as the real import path supplies them.
  const bent = rec
    ? {
        startAt: from,
        timeOfDay: '09:00',
        monthDayFallback: 'skip',
        ...rec,
        month: bend(rec.month),
      }
    : null
  const list = bent ? m.computeOccurrences(bent, { from, limit: 1 }) : []
  check(
    `.ics BYMONTH=${byMonth} schedules in ${MONTHS[expected]}`,
    list.length > 0 && new Date(list[0]).getMonth() === expected,
    list.length === 0 ? 'no occurrence at all' : `got ${MONTHS[new Date(list[0]).getMonth()]}`,
  )
}

// 3. And back out again, so an imported reminder that is exported still says
//    the same thing to the next program that reads it.
for (const month of [0, 9, 11]) {
  const rule = m.recurrenceToRRule({
    kind: 'yearly',
    startAt: from,
    timeOfDay: '09:00',
    month,
    dayOfMonth: 15,
    monthDayFallback: 'skip',
    endMode: 'never',
  })
  check(
    `${MONTHS[month]} exports as BYMONTH=${month + 1}`,
    rule !== null && rule.byMonth?.[0] === month + 1,
    rule === null ? 'no rule at all' : `BYMONTH=${rule.byMonth?.[0]}`,
  )
}

// 4. Dragging a yearly reminder on the calendar: the month the confirmation
//    box names has to be the month it actually lands in.
{
  const rec = {
    kind: 'yearly',
    startAt: Date.UTC(2026, 9, 3, 9, 0, 0),
    timeOfDay: '09:00',
    month: 9,
    dayOfMonth: 3,
    monthDayFallback: 'skip',
    endMode: 'never',
  }
  const plan = m.planReschedule({ id: 'j', recurrence: rec }, '2026-10-03', '2026-10-20')
  const moved = plan?.recurrence
    ? { ...plan.recurrence, month: bend(plan.recurrence.month) }
    : null
  const list = moved ? m.computeOccurrences(moved, { from, limit: 1 }) : []
  const at = list.length > 0 ? new Date(list[0]) : null
  check(
    'dragging to 10-20 schedules in October',
    at !== null && at.getMonth() === 9 && at.getDate() === 20,
    at === null ? 'no occurrence at all' : `${MONTHS[at.getMonth()]} ${at.getDate()}`,
  )
}

const failed = results.filter((r) => !r.ok)
for (const r of results) {
  if (!r.ok) console.log(`  FAIL  ${r.name} — ${r.detail}`)
}
console.log(`\n  ${results.length - failed.length}/${results.length} yearly-month checks`)

if (selftest) {
  if (failed.length === 0) {
    console.log('\n  SELFTEST FAILED: the off-by-one was re-introduced and nothing went red.')
    process.exit(1)
  }
  console.log(`\n  Selftest OK — ${failed.length} checks go red on the known-bad version.`)
  process.exit(0)
}

if (failed.length > 0) process.exit(1)
console.log('\n  All clear.')
