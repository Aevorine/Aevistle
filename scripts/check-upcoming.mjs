/**
 * Does the send preview tell you how many messages you just signed up for?
 *
 * A mistyped recurrence is silent in the way this application exists to
 * prevent: "every 30 minutes" and "every 30 days" look identical on the
 * compose screen, and one of them sends 1 440 messages a month. The preview
 * answered what *one* message would look like and never how many there would
 * be.
 *
 * The two properties that matter:
 *
 *   - the count is of what the *scheduler* would do, not of what the rule says.
 *     Quiet hours and the working calendar rewrite the list afterwards, so
 *     arithmetic on the rule would confidently report times that never happen;
 *   - a count that had to be truncated says so. Reporting "60 sends in 30 days"
 *     when the real figure is 1 440 is worse than reporting nothing, because
 *     the number would be believed.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-upcoming-'))
const bundle = path.join(dir, 'upcoming.mjs')
await build({
  entryPoints: ['src/core/upcoming.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { upcoming, countLabel } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
// A Monday, mid-morning, so weekday arithmetic is easy to reason about.
const NOW = new Date(2026, 7, 3, 10, 0, 0).getTime()

// --- the mistake this exists to surface -------------------------------------

const daily = upcoming(
  { kind: 'daily', startAt: NOW, timeOfDay: '09:00' },
  { now: NOW, days: 30 },
)
check('a daily reminder is about 30 sends in 30 days', daily.occurrences.length >= 29 && daily.occurrences.length <= 31)
check('a daily reminder is one per day', daily.days.every((d) => d.times.length === 1))
check('a daily count is exact', countLabel(daily).atLeast === false)

const everyThirtyMinutes = upcoming(
  { kind: 'interval', startAt: NOW, timeOfDay: '09:00', intervalMs: 30 * MIN },
  { now: NOW, days: 30 },
)
check(
  'every-30-minutes is reported as vastly more than every-30-days',
  everyThirtyMinutes.occurrences.length > daily.occurrences.length * 10,
)
check('and it is flagged as a floor, not a total', countLabel(everyThirtyMinutes).atLeast === true)

const everyThirtyDays = upcoming(
  { kind: 'interval', startAt: NOW, timeOfDay: '09:00', intervalMs: 30 * DAY },
  { now: NOW, days: 30 },
)
check('every-30-days is at most one send in the window', everyThirtyDays.occurrences.length <= 1)
check('and that count is exact', countLabel(everyThirtyDays).atLeast === false)

// --- the count is of what the scheduler does --------------------------------

const at2am = { kind: 'daily', startAt: NOW, timeOfDay: '02:00' }
const withoutQuiet = upcoming(at2am, { now: NOW, days: 7 })
const withQuiet = upcoming(at2am, {
  now: NOW,
  days: 7,
  quiet: { enabled: true, start: '22:00', end: '07:00' },
})
check('quiet hours are applied, not ignored', withQuiet.occurrences.length > 0)
check(
  'a 02:00 daily send does not stay at 02:00 when quiet hours cover it',
  withQuiet.occurrences.some((at, i) => at !== withoutQuiet.occurrences[i]),
)
check(
  'every reported time is outside the quiet window',
  withQuiet.occurrences.every((at) => {
    const h = new Date(at).getHours()
    return h >= 7 && h < 22
  }),
)

const weekdays = { kind: 'daily', startAt: NOW, timeOfDay: '09:00', workdayPolicy: 'skip' }
const withCalendar = upcoming(weekdays, {
  now: NOW,
  days: 14,
  calendar: { weekend: [0, 6], holidays: ['2026-08-05'], workdays: [] },
})
check(
  'the working calendar is applied',
  withCalendar.occurrences.length < upcoming(weekdays, { now: NOW, days: 14 }).occurrences.length,
)
check(
  'no reported day is a weekend',
  withCalendar.occurrences.every((at) => ![0, 6].includes(new Date(at).getDay())),
)
check(
  'the holiday is skipped',
  !withCalendar.days.some((d) => d.date === '2026-08-05'),
)

// --- shape ------------------------------------------------------------------

check('days are grouped', daily.days.length === daily.occurrences.length)
check('days are in order', daily.days.every((d, i, a) => i === 0 || d.date > a[i - 1].date))
check(
  'nothing outside the window is reported',
  daily.occurrences.every((at) => at >= NOW && at <= NOW + 30 * DAY),
)

const once = upcoming({ kind: 'once', startAt: NOW + HOUR, timeOfDay: '09:00' }, { now: NOW, days: 30 })
check('a one-off reports exactly one send', once.occurrences.length === 1)
check('a one-off is not flagged as truncated', once.truncated === false)

const past = upcoming({ kind: 'once', startAt: NOW - DAY, timeOfDay: '09:00' }, { now: NOW, days: 30 })
check('a reminder whose only time has passed reports none', past.occurrences.length === 0)

// ---------------------------------------------------------------------------

const label = 'the preview says how many sends are coming'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
