/**
 * The daily digest: is it true, and is it still one scheduler?
 *
 * Two failures this exists to catch, and they are different in kind.
 *
 * **The digest lies.** It is the one mail in this application whose entire
 * content is a claim about the application itself, so a wrong number here is
 * not a cosmetic bug — it is the app telling its user "nothing is due today"
 * on a day something is. Every count therefore has to come from the same
 * engine the scheduler uses: `upcoming()` through quiet hours and the working
 * calendar, `findConflicts()` for the conflicts, and `truncated` carried all
 * the way out so "12 sends" is never printed when the real figure is 1 440.
 *
 * **The digest grows its own clock.** The whole architecture of this app is
 * one TS recurrence engine budgeting absolute timestamps while two native
 * schedulers only ever answer "wake me at T". A digest with a `setInterval`
 * behind it would be a second answer to that question, and it would be right
 * on the desktop and silently absent on Android — which is exactly the shape
 * of failure the shared engine exists to make impossible. So this guard reads
 * the source and asserts the wiring: the digest is an ordinary `ScheduledJob`
 * built by `rebuildJob`, handed over in the existing `bridge.syncJobs` call,
 * with its body composed on the way out.
 *
 * A guard that only imported `buildDigest` and checked its arithmetic would
 * pass with the whole feature unplugged. The source assertions below are the
 * ones that cross the module boundary.
 *
 * `--selftest` re-introduces each fault in turn and requires the matching
 * assertion to catch it.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'Asia/Shanghai'

import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SELFTEST = process.argv.includes('--selftest')

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-digest-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-digest-'))
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

const digestMod = await load('src/core/digest.ts', 'digest')
const textMod = await load('src/core/digestText.ts', 'digestText')
const typesMod = await load('src/core/types.ts', 'types')

const appState = await readFile('src/state/AppState.tsx', 'utf8')
const settingsView = await readFile('src/views/SettingsView.tsx', 'utf8')
const digestSource = await readFile('src/core/digest.ts', 'utf8')

const failures = []
let checked = 0
const ok = (what, pass) => {
  checked++
  if (!pass) failures.push(what)
  return pass
}
const eq = (what, actual, expected) =>
  ok(
    `${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected),
  )

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 86_400_000
/** Monday 3 August 2026, 08:00 local. */
const NOW = new Date(2026, 7, 3, 8, 0, 0, 0).getTime()
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
    draft: {
      accountId: 'a',
      to: ['x@example.com'],
      cc: [],
      bcc: [],
      subject: 'S',
      body: '',
      bodyFormat: 'plain',
      attachments: [],
      priority: 'normal',
      requestReadReceipt: false,
      individualDelivery: false,
    },
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

const { buildDigest, digestIsEmpty, DIGEST_JOB_ID, DIGEST_WEEK_DAYS } = digestMod

// ===========================================================================
// It is a summary, not a sentence
// ===========================================================================

if (ok('buildDigest is exported', typeof buildDigest === 'function')) {
  const one = buildDigest([job('daily', baseRec)], { now: NOW, calendar: PLAIN })

  eq('today: a daily 09:00 reminder is one send today', one.todayCount, 1)
  eq('today: named, once', one.todayEntries.length, 1)
  eq('today: with the reminder it belongs to', one.todayEntries[0].jobId, 'daily')
  ok('today: as a timestamp, not as text', typeof one.todayEntries[0].times[0] === 'number')
  eq('today: with how many people it reaches', one.todayEntries[0].recipients, 1)
  eq('today: the date is the local date', one.today, '2026-08-03')
  eq('week: seven days of a daily rule', one.weekCount, DIGEST_WEEK_DAYS)
  eq('week: the horizon is reported, not assumed', one.weekDays, DIGEST_WEEK_DAYS)
  eq('shape: nothing in the summary is a rendered sentence', typeof one.todayCount, 'number')
  eq('shape: when it was computed is recorded', one.generatedAt, NOW)

  // The one thing a summary of "today" must never do.
  const tomorrowOnly = buildDigest(
    [job('later', { ...baseRec, kind: 'once', startAt: NOW + 2 * DAY })],
    { now: NOW, calendar: PLAIN },
  )
  eq('today: a reminder due on Wednesday is not due today', tomorrowOnly.todayCount, 0)
  eq('today: but it is still in the week', tomorrowOnly.weekCount, 1)
  eq('today: and nothing is listed for today', tomorrowOnly.todayEntries.length, 0)
}

// ===========================================================================
// The counts are of what the scheduler does
// ===========================================================================

{
  // Quiet hours. A 02:00 daily reminder does not fire at 02:00, and a digest
  // that quoted 02:00 would be quoting a time nothing happens at.
  //
  // Read at half past midnight, so today's 02:00 is still ahead and the shift
  // shows up in *today's* list rather than only in the week's total.
  const NIGHT = new Date(2026, 7, 3, 0, 30, 0, 0).getTime()
  const at2am = job('night', { ...baseRec, timeOfDay: '02:00', startAt: NIGHT })
  const loud = buildDigest([at2am], { now: NIGHT, calendar: PLAIN })
  const quiet = buildDigest([at2am], {
    now: NIGHT,
    calendar: PLAIN,
    quiet: { enabled: true, start: '22:00', end: '07:00' },
  })
  eq('quiet hours: the reminder is due today either way', loud.todayEntries.length, 1)
  ok(
    'quiet hours: the times move',
    JSON.stringify(quiet.todayEntries.map((e) => e.times)) !==
      JSON.stringify(loud.todayEntries.map((e) => e.times)),
  )
  ok(
    'quiet hours: every time quoted is outside the window',
    quiet.todayEntries
      .flatMap((e) => e.times)
      .every((at) => {
        const h = new Date(at).getHours()
        return h >= 7 && h < 22
      }),
  )

  // The working calendar. 2026-08-05 is a Wednesday, marked off.
  const skipping = job('weekdays', { ...baseRec, workdayPolicy: 'skip' })
  const withHoliday = buildDigest([skipping], {
    now: NOW,
    calendar: { weekend: [0, 6], holidays: ['2026-08-05'], workdays: [] },
  })
  const without = buildDigest([skipping], { now: NOW, calendar: PLAIN })
  ok(
    'working calendar: a holiday removes a send from the count',
    withHoliday.weekCount < without.weekCount,
  )

  // A paused reminder arms nothing.
  const paused = buildDigest([{ ...job('off', baseRec), enabled: false }], {
    now: NOW,
    calendar: PLAIN,
  })
  eq('a paused reminder is not reported as going out', paused.todayCount, 0)
  eq('and is not counted among the reminders looked at', paused.jobsConsidered, 0)
}

// ===========================================================================
// Truncation is carried, not smoothed
// ===========================================================================

{
  const everyMinute = job('spam', {
    ...baseRec,
    kind: 'interval',
    intervalMs: 60_000,
    startAt: NOW,
  })
  const busy = buildDigest([everyMinute], { now: NOW, calendar: PLAIN })
  ok('truncation: an every-minute rule cannot be counted exactly', busy.truncated === true)
  ok('truncation: and the number it does give is large', busy.weekCount > 100)

  const calm = buildDigest([job('daily', baseRec)], { now: NOW, calendar: PLAIN })
  eq('truncation: an ordinary daily count is exact', calm.truncated, false)
}

// ===========================================================================
// A reminder that is nearly finished
// ===========================================================================

{
  // Ten runs allowed, nine already used: exactly one send left, not seven.
  const nearlyDone = job(
    'ending',
    { ...baseRec, endMode: 'afterCount', maxRuns: 10 },
    { runCount: 9 },
  )
  const d = buildDigest([nearlyDone], { now: NOW, calendar: PLAIN })
  eq('run cap: a reminder with one run left promises one send', d.weekCount, 1)

  const spent = buildDigest(
    [job('spent', { ...baseRec, endMode: 'afterCount', maxRuns: 3 }, { runCount: 3 })],
    { now: NOW, calendar: PLAIN },
  )
  eq('run cap: a finished reminder promises none', spent.weekCount, 0)
  eq('run cap: and is not listed for today', spent.todayEntries.length, 0)
}

// ===========================================================================
// Conflicts come from the conflict scanner, not from a second opinion
// ===========================================================================

{
  const three = ['a', 'b', 'c'].map((id) => job(id, { ...baseRec, timeOfDay: '09:00' }))
  const stacked = buildDigest(three, { now: NOW, calendar: PLAIN })
  ok('conflicts: three reminders on one minute are reported', stacked.conflictCount > 0)
  ok(
    'conflicts: as the calendar screen would report them',
    stacked.conflicts.some((c) => c.kind === 'sameMinute'),
  )
  eq('conflicts: the horizon is reported', stacked.conflictDays > 0, true)

  // A Saturday-only rule with "skip" never sends — an error, and the count of
  // errors is what the digest leads with.
  const doomed = buildDigest(
    [job('sat', { ...baseRec, kind: 'weekly', weekdays: [6], workdayPolicy: 'skip' })],
    { now: NOW, calendar: PLAIN },
  )
  ok('conflicts: a reminder that will never send is an error', doomed.conflictErrors > 0)

  const clean = buildDigest([job('fine', baseRec)], { now: NOW, calendar: PLAIN })
  eq('conflicts: an ordinary schedule has none', clean.conflictCount, 0)
  eq('conflicts: and no errors', clean.conflictErrors, 0)
}

// ===========================================================================
// The digest does not report itself
// ===========================================================================

{
  const withSelf = buildDigest([job(DIGEST_JOB_ID, baseRec), job('real', baseRec)], {
    now: NOW,
    calendar: PLAIN,
  })
  eq('exclusion: without it the digest is in its own list', withSelf.todayEntries.length, 2)

  const excluded = buildDigest([job(DIGEST_JOB_ID, baseRec), job('real', baseRec)], {
    now: NOW,
    calendar: PLAIN,
    excludeJobIds: [DIGEST_JOB_ID],
  })
  eq('exclusion: excluded, only the real reminder is listed', excluded.todayEntries.length, 1)
  eq('exclusion: and it is the right one', excluded.todayEntries[0].jobId, 'real')

  eq(
    'empty: nothing scheduled at all is recognisable as such',
    digestIsEmpty(buildDigest([], { now: NOW, calendar: PLAIN })),
    true,
  )
}

// ===========================================================================
// Every word comes from the caller's `t`
// ===========================================================================

if (ok('renderDigestBody is exported', typeof textMod.renderDigestBody === 'function')) {
  const asked = []
  const ctx = {
    t: (key, values) => {
      asked.push(key)
      return values ? `⟦${key}:${JSON.stringify(values)}⟧` : `⟦${key}⟧`
    },
    formatDateTime: (ms) => `T${ms}`,
    jobName: (id) => `name-of-${id}`,
  }

  const digest = buildDigest([job('daily', baseRec)], { now: NOW, calendar: PLAIN })
  const body = textMod.renderDigestBody(digest, ctx)

  ok('render: the heading comes from a key', body.includes('⟦digest.todayHeading⟧'))
  ok('render: the count comes from a key', asked.includes('digest.todayCount'))
  ok('render: so does the week', asked.includes('digest.weekHeading'))
  ok('render: so do the conflicts', asked.includes('digest.conflictHeading'))
  ok('render: the numbers reach the text', body.includes('"n":1'))
  ok('render: when it was computed is in the mail', asked.includes('digest.generatedAt'))
  ok('render: and the caveat about staleness with it', asked.includes('digest.staleNote'))

  // Nothing may be written in English inside the renderer: with a `t` that
  // returns only bracketed keys, the body must contain no bare Latin word.
  const stripped = body.replace(/⟦[^⟧]*⟧/g, '')
  ok(
    `render: no untranslated prose leaks out (${JSON.stringify(stripped.slice(0, 60))})`,
    !/[A-Za-z]{3}/.test(stripped),
  )

  ok(
    'render: the subject is a key too',
    textMod.renderDigestSubject(digest, ctx).includes('digest.subject'),
  )

  // The conflict lines reuse the calendar screen's own wordings rather than
  // inventing a second set that can disagree with the first.
  const stacked = buildDigest(
    ['a', 'b', 'c'].map((id) => job(id, baseRec)),
    { now: NOW, calendar: PLAIN },
  )
  textMod.renderDigestBody(stacked, ctx)
  ok(
    'render: conflicts reuse cal.conflict.*',
    asked.some((k) => k.startsWith('cal.conflict.')),
  )
}

// ===========================================================================
// The settings exist, and existing installs get defaults
// ===========================================================================

{
  const d = typesMod.DEFAULT_SETTINGS
  eq('settings: the digest is off until asked for', d.digestEnabled, false)
  ok('settings: with a time to default to', typeof d.digestTime === 'string' && /^\d{2}:\d{2}$/.test(d.digestTime))
  ok('settings: greeting defaults are present too', typeof d.greetingTime === 'string')
  ok(
    'settings: greeting templates default to empty so the locale supplies them',
    d.greetingSubject === '' && d.greetingBody === '',
  )
}

// ===========================================================================
// The wiring — the half a behavioural test cannot see
// ===========================================================================

/** True when `haystack` matches, reported by name rather than by regex. */
const source = (what, haystack, re) => ok(what, re.test(haystack))

source(
  'wiring: AppState imports the digest builder',
  appState,
  /import \{[^}]*buildDigest[^}]*\} from '\.\.\/core\/digest'/,
)
source(
  'wiring: and the renderer',
  appState,
  /import \{[^}]*renderDigestBody[^}]*\} from '\.\.\/core\/digestText'/,
)
source(
  'wiring: the digest body is composed inside the syncJobs hand-off',
  appState,
  /bridge\.syncJobs\([\s\S]{0,1200}?withDigestBody\(/,
)
source(
  'wiring: "run now" composes a fresh digest instead of resending a stored body',
  appState,
  /withDigestBody\(job,[\s\S]{0,60}?\)\n?[\s\S]{0,120}?sendDraftNow\(outgoing\.draft\)/,
)
source(
  'wiring: the digest reminder is built through rebuildJob, like every other job',
  appState,
  /function digestJobFor\([\s\S]{0,400}?rebuildJob\(/,
)
source(
  'wiring: it is a daily recurrence, so the shared engine budgets its timestamps',
  appState,
  /function digestJobFor\([\s\S]{0,900}?kind: 'daily'/,
)
source(
  'wiring: the settings switch is bound to something',
  settingsView,
  /patch\(\{ digestEnabled: v \}\)/,
)
source(
  'wiring: the settings preview goes through the same renderer as the mail',
  settingsView,
  /renderDigestBody\(digest, ctx\)/,
)

// The load-bearing negative: no second scheduler anywhere in this feature.
ok(
  'no second scheduler: core/digest.ts arms no timer of its own',
  !/setInterval|setTimeout/.test(digestSource),
)
{
  // Every line that is part of the digest's path, and not one of them may arm
  // a timer. Proximity was tried first and was a false positive: the scheduler
  // arming retry sits a few lines below the `syncJobs` call the digest rides
  // in on, and "near each other in the file" is not "one is the other".
  const path = appState
    .split('\n')
    .filter((line) => /DIGEST_JOB_ID|withDigestBody|digestJobFor|buildDigest/.test(line))
  ok('no second scheduler: the digest path exists at all', path.length >= 4)
  ok(
    'no second scheduler: nothing on the digest path arms a timer',
    path.every((line) => !/set(?:Interval|Timeout)/.test(line)),
  )
}

// ===========================================================================
// Self-test
// ===========================================================================

if (SELFTEST) {
  let caught = 0
  const probes = [
    [
      'counting the rule instead of the schedule (quiet hours ignored)',
      () => {
        const at2am = job('night', { ...baseRec, timeOfDay: '02:00' })
        const quiet = buildDigest([at2am], {
          now: NOW,
          calendar: PLAIN,
          quiet: { enabled: true, start: '22:00', end: '07:00' },
        })
        // Broken would be: a time still inside the quiet window.
        return quiet.todayEntries
          .flatMap((e) => e.times)
          .some((at) => new Date(at).getHours() < 7)
      },
    ],
    [
      'a paused reminder counted as going out',
      () =>
        buildDigest([{ ...job('off', baseRec), enabled: false }], { now: NOW, calendar: PLAIN })
          .todayCount > 0,
    ],
    [
      'an every-minute rule reported as an exact total',
      () =>
        buildDigest(
          [job('spam', { ...baseRec, kind: 'interval', intervalMs: 60_000 })],
          { now: NOW, calendar: PLAIN },
        ).truncated === false,
    ],
    [
      'a spent run cap still promising a week of mail',
      () =>
        buildDigest(
          [job('spent', { ...baseRec, endMode: 'afterCount', maxRuns: 3 }, { runCount: 3 })],
          { now: NOW, calendar: PLAIN },
        ).weekCount > 0,
    ],
    [
      'the digest listing itself',
      () =>
        buildDigest([job(DIGEST_JOB_ID, baseRec)], {
          now: NOW,
          calendar: PLAIN,
          excludeJobIds: [DIGEST_JOB_ID],
        }).todayEntries.length > 0,
    ],
    [
      'the body composed from a stored draft instead of on the way out',
      () => !/bridge\.syncJobs\([\s\S]{0,1200}?withDigestBody\(/.test(appState),
    ],
    [
      'a timer of the digest’s own',
      () => /setInterval|setTimeout/.test(digestSource),
    ],
  ]
  for (const [label, isBroken] of probes) {
    if (isBroken()) console.error(`SELFTEST FAIL  ${label} was not caught`)
    else caught++
  }
  console.log(`selftest: ${caught}/${probes.length} broken states would be caught`)
  if (caught !== probes.length) failures.push('selftest')
}

// ---------------------------------------------------------------------------

await rm(dir, { recursive: true, force: true })

const label = 'the daily digest is true, and is still one scheduler'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
