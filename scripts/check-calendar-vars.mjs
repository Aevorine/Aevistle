/**
 * The calendar merge variables, and the one thing they must never become.
 *
 * `{{nextWorkday}}` and the rest exist so a message's *text* can agree with the
 * calendar that decides its *timing*. Without them the working calendar can
 * move a reminder from Saturday to Monday while the reminder still reads "see
 * you tomorrow", and the two halves of the same feature contradict each other
 * in front of the recipient.
 *
 * The dangerous failure is not a wrong date. It is a **silently empty one**.
 * `mergeVars.ts` is built on "an unknown variable is left standing, not
 * blanked" — `{{nmae}}` arriving as `{{nmae}}` is how you find the typo,
 * arriving as `` is how you send forty people a letter starting "Dear ,".
 * Registering the calendar names with empty values on a caller that has no
 * calendar would quietly opt those tokens out of that rule. So:
 *
 *   - with no calendar passed, `{{nextWorkday}}` must come back **standing**;
 *   - with a calendar passed, it must come back **filled**;
 *   - `{{holiday}}` is the single deliberate exception — a known variable whose
 *     empty value is a real answer ("today is not a holiday"), and the guard
 *     pins that so it cannot spread to the others by accident.
 *
 * Also asserted: the variables are computed at the **send** instant, not at
 * preview time. `buildPreflight` passes `scheduledFor` for exactly this, and a
 * preview that resolves "next working day" against today would show text the
 * recipient never receives.
 *
 * `--selftest` breaks each rule in turn and requires the assertion to catch it.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'Asia/Shanghai'

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SELFTEST = process.argv.includes('--selftest')

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-calvars-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-calvars-'))
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

const merge = await load('src/core/mergeVars.ts', 'merge')
const wc = await load('src/core/workCalendar.ts', 'wc')

let failures = 0
let checks = 0

function ok(label, condition, detail = '') {
  checks++
  if (condition) return true
  failures++
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

// ---------------------------------------------------------------------------
// A calendar with a known shape: 2026-10-01..03 off (National Day), and
// 2026-10-10 (a Saturday) worked as a make-up day.
// ---------------------------------------------------------------------------

const cal = {
  ...wc.DEFAULT_WORK_CALENDAR,
  weekend: [0, 6],
  holidays: ['2026-10-01', '2026-10-02', '2026-10-03'],
  workdays: ['2026-10-10'],
}

const names = new Map([
  ['2026-10-01', '国庆节'],
  ['2026-10-02', '国庆节'],
  ['2026-10-03', '国庆节'],
])

/** 2026-09-30 is a Wednesday. Local noon, to stay clear of any boundary. */
const WED = new Date(2026, 8, 30, 12, 0, 0).getTime()
/** 2026-10-01 is the Thursday holiday itself. */
const HOLIDAY = new Date(2026, 9, 1, 12, 0, 0).getTime()

const v = merge.calendarVars(WED, cal, names)

ok('today is the date asked for', v.today === '2026-09-30', v.today)
ok('an ordinary day has no holiday name', v.holiday === '', JSON.stringify(v.holiday))
ok(
  'the next working day skips the three-day holiday',
  v.nextWorkday === '2026-10-05',
  v.nextWorkday,
)
ok('the previous working day is the day before', v.prevWorkday === '2026-09-29', v.prevWorkday)
ok('the next holiday is the 1st', v.nextHolidayDate === '2026-10-01', v.nextHolidayDate)
ok('the next holiday is named', v.nextHoliday === '国庆节', v.nextHoliday)
ok('days to the next holiday counts one', v.daysToNextHoliday === '1', v.daysToNextHoliday)

const onDay = merge.calendarVars(HOLIDAY, cal, names)
ok('on the holiday itself the name is filled', onDay.holiday === '国庆节', onDay.holiday)
ok(
  'the make-up Saturday counts as a working day',
  merge.calendarVars(new Date(2026, 9, 9, 12).getTime(), cal, names).nextWorkday === '2026-10-10',
  merge.calendarVars(new Date(2026, 9, 9, 12).getTime(), cal, names).nextWorkday,
)

// A calendar where every day is off. The honest answer is an empty string, not
// a hang and not a wrong date — the same shape as `CalendarAdjustment.dropped`.
const allOff = { ...wc.DEFAULT_WORK_CALENDAR, weekend: [0, 1, 2, 3, 4, 5, 6], holidays: [], workdays: [] }
const none = merge.calendarVars(WED, allOff)
ok('a calendar with no working day says so rather than guessing', none.nextWorkday === '')
ok('and terminates', typeof none.nextWorkday === 'string')

// ---------------------------------------------------------------------------
// The rule that matters: standing vs filled
// ---------------------------------------------------------------------------

const draft = {
  to: ['lena@example.com'],
  cc: [],
  bcc: [],
  subject: 'Next: {{nextWorkday}}',
  body: 'Back on {{nextWorkday}}. Holiday: [{{holiday}}]',
  attachments: [],
}

const without = merge.buildMergeMessages(draft, [], { enabled: false, now: WED })
ok(
  'with no calendar the token is left standing',
  without[0].draft.subject.includes('{{nextWorkday}}'),
  without[0].draft.subject,
)
ok(
  'and is reported as missing',
  without[0].missing.includes('nextWorkday'),
  JSON.stringify(without[0].missing),
)

const withCal = merge.buildMergeMessages(draft, [], {
  enabled: false,
  now: WED,
  calendar: cal,
  holidayNames: names,
})
ok(
  'with a calendar the token is filled',
  withCal[0].draft.subject === 'Next: 2026-10-05',
  withCal[0].draft.subject,
)
ok('and is not reported as missing', !withCal[0].missing.includes('nextWorkday'))
ok(
  'a known-but-empty holiday renders as nothing, not as a token',
  withCal[0].draft.body.includes('Holiday: []'),
  withCal[0].draft.body,
)

// The existing contract must be untouched by all of the above.
ok(
  'an unknown variable is still left standing',
  merge.render('Hi {{nmae}}', { name: 'Lena' }) === 'Hi {{nmae}}',
)

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (SELFTEST) {
  let caught = 0
  const probes = [
    [
      'a blanked unknown variable',
      () => merge.render('Hi {{nmae}}', { name: 'Lena' }) !== 'Hi {{nmae}}',
    ],
    [
      'calendar vars registered without a calendar',
      () => !merge.buildMergeMessages(draft, [], { enabled: false, now: WED })[0].missing.includes('nextWorkday'),
    ],
    [
      'the holiday skipped when finding the next working day',
      () => merge.calendarVars(WED, cal, names).nextWorkday === '2026-10-01',
    ],
    [
      'an all-holiday calendar returning a date',
      () => merge.calendarVars(WED, allOff).nextWorkday !== '',
    ],
  ]
  for (const [label, isBroken] of probes) {
    if (isBroken()) console.error(`SELFTEST FAIL  ${label} was not caught`)
    else caught++
  }
  console.log(`selftest: ${caught}/${probes.length} broken states would be caught`)
  if (caught !== probes.length) failures++
}

await rm(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} problem(s) across ${checks} checks`)
  process.exit(1)
}
console.log(`calendar merge variables: ${checks} checks, 0 problems`)
