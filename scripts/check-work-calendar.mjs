/**
 * Does the working calendar actually reach the scheduler — and does it say so
 * when it cannot?
 *
 * Five properties, all of which failed silently before this file existed. Every
 * one of them is written so that reverting the fix produces a named FAIL rather
 * than a crash: a missing export is reported as the missing behaviour it is.
 *
 *   - **B1 An edit re-arms.** Marking a day a holiday used to change what the
 *     preview drew and nothing about what would fire. The occurrence lists on
 *     disk — the ones handed to the desktop tick and the Android alarm — were
 *     only rebuilt at the next restart, or the next time each job happened to
 *     be saved by hand. Watching a reminder go out on a day you marked off is
 *     the whole feature failing with the UI unchanged.
 *   - **B2 One weekend, not two.** The legacy `skipWeekends` flag ran against a
 *     hard-coded Saturday/Sunday inside `nextFireAfter`, so it could not see
 *     `calendar.weekend` (a Friday/Saturday week was invisible to it) nor any
 *     holiday — and a job carrying both the flag and a `workdayPolicy` was
 *     shifted twice.
 *   - **B3 Nothing is dropped in silence.** `shiftToWorkingDay` returns null
 *     when no working day exists within a month, and the caller simply skipped
 *     that occurrence. A reminder that will never be sent, with nothing
 *     anywhere saying so, is the worst failure this product has.
 *   - **B4 A date is a date.** `new Date('2026-10-01')` is *UTC* midnight per
 *     spec; every reader here asks for local fields. West of UTC that is 30
 *     September, so a holiday marks the wrong square and shifts the wrong day.
 *   - **B5 The calendar travels.** An exported job carried `workdayPolicy` and
 *     left the calendar behind, landing on another install pointing at a set of
 *     days that does not exist there.
 *
 * Exit code 1 if anything needs attention.
 */

// Set before anything reads the clock. The B4 failure is invisible in UTC and
// east of it, so the whole file runs somewhere the bug would actually bite.
process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Inside the project, not the system temp dir: the state module imports React,
// and a bundle written elsewhere cannot resolve it. `tmpdir` is imported for
// the fallback below so this still runs where node_modules is not writable.
let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-workcal-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-workcal-'))
}

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    // The state module pulls in React; it is a devDependency and resolves, but
    // there is no reason to inline it. Everything else — including the Capacitor
    // bridge — is bundled, because the reducer under test must not depend on
    // which platform packages happen to be installed.
    external: ['react', 'react-dom'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const cal = await load('src/core/schedule/workCalendar.ts', 'workCalendar')
const sched = await load('src/core/schedule/schedule.ts', 'schedule')
const transfer = await load('src/core/schedule/jobTransfer.ts', 'jobTransfer')
const app = await load('src/state/AppState.tsx', 'appState')

const failures = []
let checked = 0
const ok = (what, pass) => {
  checked++
  if (!pass) failures.push(what)
}
const eq = (what, actual, expected) =>
  ok(`${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
     JSON.stringify(actual) === JSON.stringify(expected))
/** A behaviour that was removed rather than broken still has to read as a failure. */
const present = (what, value) => {
  checked++
  if (typeof value !== 'function') failures.push(`${what} — the export does not exist`)
  return typeof value === 'function'
}

const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
const iso = (ms) => cal.toIsoDate(ms)
const MIN = 60_000

// ===========================================================================
// B4 — a bare YYYY-MM-DD is a local date, not a UTC instant
// ===========================================================================

if (present('B4: parseIsoDate is exported', cal.parseIsoDate)) {
  // The control: this is what the codebase used to do, and what it produces on
  // this machine. If this ever stops being wrong the test below proves nothing.
  ok(
    'B4: the built-in parse really is wrong here (west of UTC)',
    new Date('2026-10-01').getDate() === 30,
  )

  for (const d of ['2026-01-01', '2026-03-08', '2026-10-01', '2026-12-31']) {
    ok(`B4: ${d} round-trips through parseIsoDate/toIsoDate`, iso(cal.parseIsoDate(d).getTime()) === d)
  }
  eq('B4: parseIsoDate lands on local midnight', cal.parseIsoDate('2026-10-01').getHours(), 0)
  eq('B4: parseIsoDate keeps the day of month', cal.parseIsoDate('2026-10-01').getDate(), 1)
  ok('B4: junk is NaN, not a plausible wrong day', Number.isNaN(cal.parseIsoDate('next friday').getTime()))
  ok('B4: a slashed date is refused rather than guessed', Number.isNaN(cal.parseIsoDate('2026/10/01').getTime()))
}

if (present('B4: isWorkingDayIso is exported', cal.isWorkingDayIso)) {
  // 2026-10-01 is a Thursday. Read as UTC midnight it becomes Wednesday 30
  // September here — a working day either way, so the *holiday* list is what
  // exposes the difference.
  const C = { weekend: [0, 6], holidays: ['2026-10-01'], workdays: [] }
  ok('B4: a holiday read as a local date is not a working day', !cal.isWorkingDayIso('2026-10-01', C))
  ok('B4: and the day before it still is', cal.isWorkingDayIso('2026-09-30', C))
}

if (present('B4: addIsoDays is exported', cal.addIsoDays)) {
  eq('B4: addIsoDays crosses a month end', cal.addIsoDays('2026-10-31', 1), '2026-11-01')
  // 8 March 2026 is the US spring-forward. Adding a day by milliseconds lands
  // at 23:00 on the same date; adding a calendar day does not.
  eq('B4: addIsoDays survives a DST spring-forward', cal.addIsoDays('2026-03-07', 1), '2026-03-08')
  eq('B4: and the day after it', cal.addIsoDays('2026-03-08', 1), '2026-03-09')
}

// ===========================================================================
// B2 — the legacy skipWeekends flag
// ===========================================================================

const baseRec = {
  kind: 'daily',
  startAt: at(2026, 10, 1, 9),
  timeOfDay: '09:00',
  monthDayFallback: 'last',
  endMode: 'never',
  jitterSeconds: 0,
  skipWeekends: false,
  catchUp: 'fireOnce',
}

if (present('B2: migrateSkipWeekends is exported', sched.migrateSkipWeekends)) {
  const legacy = { ...baseRec, skipWeekends: true }
  const migrated = sched.migrateSkipWeekends(legacy)

  // 'after', not 'skip'. The flag moved a weekend fire to the following Monday
  // and never cancelled anything; migrating it to 'skip' would turn "remind me
  // on the 15th" into months of silence the first time the 15th was a Saturday.
  eq('B2: the flag becomes a forward shift', migrated.workdayPolicy, 'after')
  eq('B2: and the flag itself is cleared', migrated.skipWeekends, false)

  const twice = sched.migrateSkipWeekends(migrated)
  ok('B2: migrating twice is a no-op (safe on every hydrate)', twice === migrated)
  eq('B2: nothing else about the rule changed', { ...migrated, workdayPolicy: undefined, skipWeekends: true }, { ...legacy, workdayPolicy: undefined })

  // The double-shift: the editor hides the toggle once a policy is set, but the
  // stored flag kept running, so this job got both.
  const both = sched.migrateSkipWeekends({ ...baseRec, skipWeekends: true, workdayPolicy: 'before' })
  eq('B2: an explicit policy wins over the legacy flag', both.workdayPolicy, 'before')
  eq('B2: and the flag is dropped so nothing is shifted twice', both.skipWeekends, false)

  // The flag was never applied to one-off sends, so it must not become a policy.
  const once = sched.migrateSkipWeekends({ ...baseRec, kind: 'once', skipWeekends: true })
  eq('B2: a one-off gains no policy', once.workdayPolicy, undefined)
  eq('B2: but loses the dead flag', once.skipWeekends, false)
}

// The Saudi week. 2026-10-02 is a Friday, 2026-10-03 a Saturday, 2026-10-04 a Sunday.
const SA = { weekend: [5, 6], holidays: [], workdays: [] }
eq('B2 (fixture): 2026-10-02 is a Friday', new Date(at(2026, 10, 2)).getDay(), 5)

{
  const legacy = { ...baseRec, skipWeekends: true, startAt: at(2026, 10, 2, 9) }
  const next = sched.nextFireAfter(legacy, at(2026, 10, 1, 12), SA)
  ok(
    'B2: the legacy path honours a Friday/Saturday weekend',
    next !== null && iso(next) === '2026-10-04',
  )
  const holiday = { weekend: [0, 6], holidays: ['2026-10-01', '2026-10-02'], workdays: [] }
  const afterHoliday = sched.nextFireAfter(
    { ...baseRec, skipWeekends: true, startAt: at(2026, 9, 30, 9) },
    at(2026, 9, 30, 12),
    holiday,
  )
  ok(
    'B2: the legacy path honours holidays too',
    afterHoliday !== null && iso(afterHoliday) === '2026-10-05',
  )
}

{
  // End to end: a migrated job, armed against the Saudi week, never fires on a
  // Friday or a Saturday.
  const migrated = sched.migrateSkipWeekends({ ...baseRec, skipWeekends: true, startAt: at(2026, 10, 1, 9) })
  const raw = sched.computeOccurrences(migrated, { after: at(2026, 10, 1, 0), count: 20, calendar: SA })
  const shaped = cal.applyWorkCalendar(raw, migrated.workdayPolicy ?? 'off', SA)
  ok('B2: a migrated daily job produces sends', shaped.length > 0)
  ok(
    'B2: and not one of them lands on the Saudi weekend',
    shaped.every((t) => ![5, 6].includes(new Date(t).getDay())),
  )
}

// ===========================================================================
// B3 — a dropped send is reported
// ===========================================================================

if (present('B3: applyWorkCalendarDetailed is exported', cal.applyWorkCalendarDetailed)) {
  // Every day in a 40-day block is off, which is further than shiftToWorkingDay
  // will look. The occurrence in the middle of it cannot be placed anywhere.
  const blocked = []
  for (let i = 0; i < 45; i++) blocked.push(iso(at(2026, 10, 1) + i * 86_400_000))
  const CLOSED = { weekend: [0, 6], holidays: blocked, workdays: [] }

  const target = at(2026, 10, 5, 9)
  const r = cal.applyWorkCalendarDetailed([target], 'after', CLOSED)
  eq('B3: an unplaceable occurrence is not in the output', r.occurrences.length, 0)
  eq('B3: it is reported as dropped, not forgotten', r.adjustment.dropped, [target])

  const w = cal.calendarWarning(r.adjustment, 1)
  ok('B3: and a warning is produced for it', w !== undefined && w.dropped.length === 1)

  const clean = cal.applyWorkCalendarDetailed([at(2026, 9, 24, 9)], 'after', { weekend: [0, 6], holidays: [], workdays: [] })
  eq('B3: a clean list produces no warning', cal.calendarWarning(clean.adjustment, 1), undefined)

  // The collapse. Twenty consecutive holidays, a daily 23:45 reminder, shifted
  // backwards: every one of them lands on the same Wednesday at 23:45, and the
  // uncapped one-minute nudge used to walk the last few over midnight — onto a
  // day the policy had just moved them off.
  const block = []
  for (let i = 0; i < 20; i++) block.push(iso(at(2026, 10, 1) + i * 86_400_000))
  const BLOCK = { weekend: [0, 6], holidays: block, workdays: [] }
  const many = []
  for (let i = 0; i < 20; i++) many.push(at(2026, 10, 1, 23, 45) + i * 86_400_000)
  const c = cal.applyWorkCalendarDetailed(many, 'before', BLOCK)

  eq('B3: nothing is lost to the collapse', c.occurrences.length, many.length)
  const landed = iso(c.occurrences[0])
  ok(
    'B3: the de-duplication nudge never carries a send onto the next day',
    c.occurrences.every((t) => iso(t) === landed),
  )
  ok(
    'B3: the spread is capped, not unbounded',
    Math.max(...c.occurrences) - Math.min(...c.occurrences) <= 60 * MIN,
  )
  ok('B3: and the pile-up is reported', c.adjustment.crowded.length > 0 || c.adjustment.spread.length > 0)
  const cw = cal.calendarWarning(c.adjustment, 1)
  ok('B3: a bunched-up day raises a warning', cw !== undefined)

  eq('B3: skip is recorded as skipped, not as dropped',
     cal.applyWorkCalendarDetailed([at(2026, 10, 3, 9)], 'skip', { weekend: [0, 6], holidays: [], workdays: [] }).adjustment.dropped, [])

  // The old signature has to keep working — the preview screens still use it.
  eq(
    'B3: applyWorkCalendar still returns a plain list',
    cal.applyWorkCalendar([at(2026, 10, 3, 9)], 'after', { weekend: [0, 6], holidays: [], workdays: [] }),
    [at(2026, 10, 5, 9)],
  )
}

// ===========================================================================
// B1 — editing the calendar re-arms the jobs that are already armed
// ===========================================================================

const NOW = at(2026, 9, 1, 8)

function job(id, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    draft: { accountId: 'a1', to: ['x@example.com'], cc: [], bcc: [], subject: 's', body: '', attachments: [] },
    recurrence: { ...baseRec, startAt: NOW, workdayPolicy: 'after' },
    occurrences: [],
    runCount: 0,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
    status: 'armed',
    // Fixed in the past: the fixture dates are in the future, and the reducer
    // stamps the real clock.
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function stateWith(jobs, settings = {}) {
  return {
    accounts: [], jobs, contacts: [], templates: [], logs: [],
    settings: {
      quietHoursEnabled: false, quietStart: '22:00', quietEnd: '07:00',
      logRetentionDays: 30, logMaxEntries: 500,
      workCalendar: { weekend: [0, 6], holidays: [], workdays: [] },
      ...settings,
    },
    draft: { accountId: '', to: [], cc: [], bcc: [], subject: '', body: '', attachments: [] },
    inboxAccounts: [], draftSnapshots: [], outbox: [], codeHits: [], recentRecipients: [],
    schemaVersion: 1,
  }
}

if (present('B1: the reducer is reachable', app.reducer)) {
  // Armed first, exactly as hydrate would leave it.
  const armed = app.reducer(stateWith([job('j1')]), { type: 'hydrate', state: stateWith([job('j1')]) })
  const seeded = app.reducer(armed, {
    type: 'upsertJob',
    job: { ...job('j1'), occurrences: sched.computeOccurrences({ ...baseRec, startAt: NOW, workdayPolicy: 'after' }, { after: NOW, count: 24 }) },
  })
  const before = seeded.jobs[0].occurrences
  ok('B1 (fixture): the job starts out armed', before.length > 0)

  // Every one of the next 60 days becomes a holiday except a handful, which is
  // what marking a shutdown period looks like.
  const holidays = []
  for (let i = 0; i < 20; i++) holidays.push(iso(NOW + i * 86_400_000))
  const after = app.reducer(seeded, {
    type: 'patchSettings',
    patch: { workCalendar: { weekend: [0, 6], holidays, workdays: [] } },
  })

  const now2 = after.jobs[0].occurrences
  ok('B1: the armed job\'s occurrence list changed', JSON.stringify(now2) !== JSON.stringify(before))
  ok(
    'B1: and not one of the new fire times is on a day just marked off',
    now2.every((t) => !holidays.includes(iso(t))),
  )
  ok(
    'B1: updatedAt is bumped, so the scheduler-sync signature notices',
    after.jobs[0].updatedAt > seeded.jobs[0].updatedAt,
  )
  eq('B1: the settings themselves still land', after.settings.workCalendar.holidays.length, 20)

  // Quiet hours have the same shape of problem and the same fix.
  const quiet = app.reducer(seeded, {
    type: 'patchSettings',
    patch: { quietHoursEnabled: true, quietStart: '06:00', quietEnd: '12:00' },
  })
  ok(
    'B1: changing quiet hours re-arms too',
    quiet.jobs[0].occurrences.every((t) => {
      const h = new Date(t).getHours()
      return h >= 12 || h < 6
    }),
  )

  // No churn where nothing applies: a job that opted out of the calendar must
  // not be re-armed by a calendar edit, or every alarm on the device is torn
  // down and rebuilt for nothing.
  const off = app.reducer(
    stateWith([{ ...job('j2'), recurrence: { ...baseRec, startAt: NOW, workdayPolicy: 'off' }, occurrences: [NOW + 86_400_000] }]),
    { type: 'patchSettings', patch: { workCalendar: { weekend: [0, 6], holidays, workdays: [] } } },
  )
  eq('B1: a job with policy off is left alone', off.jobs[0].occurrences, [NOW + 86_400_000])
  eq('B1: and its updatedAt is untouched', off.jobs[0].updatedAt, 1)

  // A paused job has no alarms to re-arm.
  const paused = app.reducer(
    stateWith([{ ...job('j3'), enabled: false, occurrences: [] }]),
    { type: 'patchSettings', patch: { workCalendar: { weekend: [0, 6], holidays, workdays: [] } } },
  )
  eq('B1: a paused job stays paused and empty', paused.jobs[0].occurrences, [])

  // A dropped send reaches the activity log rather than disappearing (B3 again,
  // from the side the user actually sees).
  const allOff = []
  for (let i = 0; i < 45; i++) allOff.push(iso(NOW + i * 86_400_000))
  const dropped = app.reducer(seeded, {
    type: 'patchSettings',
    patch: { workCalendar: { weekend: [0, 6], holidays: allOff, workdays: [] } },
  })
  ok(
    'B3/B1: a calendar that leaves nowhere to send raises a warning on the job',
    dropped.jobs[0].calendarWarning !== undefined,
  )
  ok(
    'B3/B1: and an entry in the activity log',
    dropped.logs.some((l) => l.level === 'error' && /will not be sent/i.test(l.title)),
  )

  // Budget. A hundred armed reminders is already an unusual install.
  const many = []
  for (let i = 0; i < 100; i++) many.push(job(`bulk${i}`))
  const bulk = stateWith(many)
  const t0 = Date.now()
  app.reducer(bulk, { type: 'patchSettings', patch: { workCalendar: { weekend: [0, 6], holidays, workdays: [] } } })
  const elapsed = Date.now() - t0
  ok(`B1: 100 jobs recompute inside a second (took ${elapsed} ms)`, elapsed < 1000)
}

// ===========================================================================
// B6 — the raw-occurrence cache a second calendar edit reuses
// ===========================================================================
//
// `reshapeJob` skips `computeOccurrences`'s day-by-day search on a cache hit,
// which means the two things that can make a cached list wrong — time
// consuming its first entry, and a run moving `runCount` past what it was
// computed against — have to be caught here, not discovered by a reminder
// that quietly stops firing.

if (present('B6: the reducer is reachable', app.reducer)) {
  // A yearly rule anchored months from `startAt` forces `nextFireAfter` to
  // walk most of a year per occurrence — the cost `reshapeJob` exists to
  // avoid paying twice.
  // `month` is 0-based, like `Date.getMonth()` — 3 is April. (See the scar
  // tissue in `nextFireAfter`'s doc comment about this exact field.)
  const yearly = (id) =>
    job(id, {
      recurrence: { ...baseRec, kind: 'yearly', month: 3, dayOfMonth: 15, startAt: NOW, workdayPolicy: 'after' },
    })
  const fleet = []
  for (let i = 0; i < 150; i++) fleet.push(yearly(`year${i}`))
  const coldState = stateWith(fleet)

  // `startAt` is NOW (2026-09-01), so the first April 15th the rule can match
  // is 2027, not 2026 — the search has already gone past this year's. 2027-04-15
  // is a Thursday: marking it off pushes the occurrence to the next working
  // day, and the second edit pushes it one day further — both fixture dates a
  // job would actually have to move for.
  const t0 = Date.now()
  const warmed = app.reducer(coldState, {
    type: 'patchSettings',
    patch: { workCalendar: { weekend: [0, 6], holidays: ['2027-04-15'], workdays: [] } },
  })
  const tCold = Date.now() - t0

  ok('B6: a cold edit populates the raw cache', warmed.jobs[0].rawOccurrences !== undefined)
  eq('B6: tagged with the runCount it was computed against', warmed.jobs[0].rawOccurrencesRunCount, 0)

  const holidays2 = ['2027-04-15', '2027-04-16']
  const t1 = Date.now()
  const rewarmed = app.reducer(warmed, {
    type: 'patchSettings',
    patch: { workCalendar: { weekend: [0, 6], holidays: holidays2, workdays: [] } },
  })
  const tWarm = Date.now() - t1

  // Correctness first: a cache-hit re-shape has to be indistinguishable from
  // a full rebuild, not just fast. Same proof B1 already relies on — nothing
  // lands on a day just marked off.
  ok(
    'B6: a cache-hit re-shape still honours the new calendar',
    rewarmed.jobs.every((j) => j.occurrences.every((t) => !holidays2.includes(iso(t)))),
  )
  ok(
    'B6: and actually changed something (the calendar edit was not a no-op)',
    JSON.stringify(rewarmed.jobs[0].occurrences) !== JSON.stringify(warmed.jobs[0].occurrences),
  )

  // Then speed: the whole point. A generous absolute ceiling rather than a
  // tight ratio, so this stays true on a slow CI runner — 150 yearly jobs
  // reshaping from cache is a few thousand cheap array operations, nothing
  // that should ever approach the search the cold pass just did.
  ok(`B6: a cache-hit edit stays fast regardless of load (${tWarm} ms)`, tWarm < 500)
  if (tCold > 20) {
    ok(
      `B6: and is meaningfully faster than the cold edit that built the cache (cold ${tCold} ms, warm ${tWarm} ms)`,
      tWarm < tCold,
    )
  }

  // The cache must never outlive the run count it was computed against.
  const capped = job('capped', {
    recurrence: { ...baseRec, startAt: NOW, workdayPolicy: 'after', endMode: 'afterCount', maxRuns: 3 },
    runCount: 2,
  })
  const seeded = app.reducer(stateWith([capped]), {
    type: 'patchSettings',
    patch: { workCalendar: { weekend: [0, 6], holidays: [], workdays: [] } },
  })
  const cache = seeded.jobs[0]
  ok('B6: one run left of three means exactly one cached occurrence', cache.rawOccurrences?.length === 1)
  eq('B6: cached against runCount 2', cache.rawOccurrencesRunCount, 2)

  const ran = app.reducer(seeded, {
    type: 'jobRan',
    jobId: 'capped',
    run: { runCount: 3, lastRunAt: Date.now(), lastResult: 'ok', status: 'done', occurrences: [] },
  })
  ok(
    'B6 (fixture): the run itself does not touch the cache',
    ran.jobs[0].rawOccurrences?.length === 1 && ran.jobs[0].rawOccurrencesRunCount === 2,
  )

  // A calendar edit landing right after the exhausting run must not resurrect
  // the one occurrence the stale cache still remembers — the rule is done.
  const after2 = app.reducer(ran, {
    type: 'patchSettings',
    patch: { workCalendar: { weekend: [0, 6], holidays: ['2026-09-02'], workdays: [] } },
  })
  eq(
    'B6: a run that exhausts the rule stays exhausted after the next calendar edit',
    after2.jobs[0].occurrences,
    [],
  )
  eq('B6: the cache is re-established against the current runCount', after2.jobs[0].rawOccurrencesRunCount, 3)
}

// ===========================================================================
// B5 — the calendar travels with the jobs
// ===========================================================================

const CN = { weekend: [0, 6], holidays: ['2026-10-01', '2026-10-02'], workdays: ['2026-10-10'] }

{
  const withPolicy = job('exported')
  const plain = { ...job('plain'), recurrence: { ...baseRec, startAt: NOW, workdayPolicy: 'off' } }

  const file = transfer.exportJobs([withPolicy], '0.1.6', NOW, CN)
  ok('B5: the file carries the calendar when a job depends on one', file.workCalendar !== undefined)
  eq('B5: and carries it intact', file.workCalendar?.holidays, CN.holidays)

  const noneNeeded = transfer.exportJobs([plain], '0.1.6', NOW, CN)
  eq(
    'B5: an export of jobs that ignore the calendar does not ship one',
    noneNeeded.workCalendar,
    undefined,
  )

  const LOCAL = { weekend: [0, 6], holidays: ['2026-12-25'], workdays: [] }
  const parsed = transfer.parseImport(JSON.stringify(file), LOCAL)
  eq('B5: the calendar survives the round trip', parsed.workCalendar?.holidays, CN.holidays)
  ok('B5: and the import knows a decision is needed', parsed.calendar?.needed === true)
  eq('B5: the diff names the dates this machine would gain', parsed.calendar?.diff?.newHolidays, CN.holidays)
  eq('B5: and the make-up days', parsed.calendar?.diff?.newWorkdays, CN.workdays)
  ok('B5: identical working weeks are not flagged', parsed.calendar?.diff?.weekendDiffers === false)

  // A file from an install with a different working week must be reported, not
  // applied: adopting it silently would rewrite every schedule on this machine.
  const saudiFile = transfer.exportJobs([withPolicy], '0.1.6', NOW, { ...CN, weekend: [5, 6] })
  const saudiParsed = transfer.parseImport(JSON.stringify(saudiFile), LOCAL)
  ok('B5: a different working week is flagged', saudiParsed.calendar?.diff?.weekendDiffers === true)

  // The old failure: jobs that need a calendar, arriving without one.
  const stripped = { ...file, workCalendar: undefined }
  const orphan = transfer.parseImport(JSON.stringify(stripped), LOCAL)
  ok('B5: a file that needs a calendar and has none says so', orphan.calendar?.missing === true)

  if (present('B5: mergeCalendars is exported', cal.mergeCalendars)) {
    const merged = cal.mergeCalendars(LOCAL, CN, 'merge')
    ok('B5: merging keeps what this machine already had', merged.holidays.includes('2026-12-25'))
    ok('B5: and adds what the file brought', CN.holidays.every((d) => merged.holidays.includes(d)))
    eq('B5: merging never adopts the file\'s working week', merged.weekend, LOCAL.weekend)
    eq('B5: keep changes nothing', cal.mergeCalendars(LOCAL, CN, 'keep'), LOCAL)
    eq('B5: replace is available for a caller that asked', cal.mergeCalendars(LOCAL, CN, 'replace').weekend, CN.weekend)
  }

  // Untrusted input: a hand-edited file must not be able to install a weekday
  // of 9 or a holiday of "soon".
  const hostile = JSON.stringify({
    ...file,
    workCalendar: { weekend: [0, 6, 9, 'sat'], holidays: ['2026-10-01', 'soon', 42], workdays: 'nope' },
  })
  const cleaned = transfer.parseImport(hostile, LOCAL).workCalendar
  eq('B5: a nonsense weekday is dropped', cleaned?.weekend, [0, 6])
  eq('B5: a nonsense holiday is dropped', cleaned?.holidays, ['2026-10-01'])
  eq('B5: a workdays field that is not a list becomes empty', cleaned?.workdays, [])

  // An older file has no calendar key at all and must still import.
  const old = transfer.parseImport(
    JSON.stringify({ format: 'aevistle.jobs', version: 1, exportedAt: NOW, jobs: [] }),
    LOCAL,
  )
  eq('B5: a file written before this existed still parses', old.jobs.length, 0)
  eq('B5: and asks for no decision', old.calendar, undefined)

  // Imported jobs are migrated on the way in (B2 again, at the other door).
  const legacyFile = transfer.exportJobs(
    [{ ...withPolicy, recurrence: { ...baseRec, startAt: NOW, skipWeekends: true, workdayPolicy: undefined } }],
    '0.1.6', NOW, CN,
  )
  const legacyParsed = transfer.parseImport(JSON.stringify(legacyFile), LOCAL)
  const { jobs: landed } = transfer.materialise(legacyParsed, 'acct', (p) => `${p}_1`, new Set(), NOW)
  eq('B5/B2: an imported legacy flag is migrated', landed[0]?.recurrence.workdayPolicy, 'after')
  eq('B5/B2: and cleared', landed[0]?.recurrence.skipWeekends, false)
}

// ===========================================================================

await rm(dir, { recursive: true, force: true })

const label = 'the working calendar reaches the scheduler, and says when it cannot'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
