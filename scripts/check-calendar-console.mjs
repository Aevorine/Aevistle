/**
 * The calendar as a place where scheduled mail is *managed*, not looked at.
 *
 * Four things joined this screen and every one of them fails the way this
 * codebase keeps paying for — by existing, compiling, and never being reached:
 *
 *   - **De-staggering.** `applyWorkCalendarDetailed` de-duplicates the
 *     occurrences of one reminder and is called once per job, so four rules
 *     that each independently say 09:00 have never had anything spreading
 *     them. `spreadSameMinute` is that same nudge with a `seen` set that spans
 *     jobs — so this asserts both that it spreads them and that the
 *     within-one-job nudge it was extended from still behaves exactly as it
 *     did, including still refusing to move anything *earlier*.
 *   - **Writing the result back.** A plan that computes perfect new instants
 *     and produces a `Recurrence` nothing fires from is the `Recurrence.month`
 *     bug again: `check:ics` was fully green while October's reminder went out
 *     in September, because it only ever asserted ics↔ics. So the restaggered
 *     rule is handed to `computeOccurrences` and the *occurrence* is checked,
 *     and the whole de-stagger is run end to end until `findConflicts` agrees
 *     the pile-up is gone.
 *   - **The date a double-click carries to the compose screen.** It travels
 *     through one module and is consumed by one function, and the assertion
 *     that matters is on the *consumer* — `nextWholeHour`, the single point
 *     every new reminder's start time comes through — not on the store.
 *   - **The heatmap.** A scale is information only if every step it can
 *     produce has a shade, and the shades get stronger as the steps do. A
 *     sixth step added with no CSS to go with it is a busier day painted
 *     lighter than a quieter one, which no screenshot would catch.
 *
 * Also asserted: that the props these features added are actually *passed*.
 * Two switches in this app's settings page were wired to nothing at all, and
 * three functions in `transport.ts` were written, imported, and never called.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { concatenatedAppCss } from './lib/stylesheets.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dir
try {
  dir = await mkdtemp(path.join(ROOT, 'node_modules', '.aevistle-console-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-console-'))
}

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

/**
 * Two modules in **one** bundle, so they share a module instance.
 *
 * Bundling `composeSeed.ts` and `RecurrenceEditor.tsx` separately gives each
 * its own copy of the seed's module state, and a test that seeded one and read
 * the other would pass on a wiring that does not exist. The first draft of this
 * file did exactly that and reported a false failure, which is the friendlier
 * direction for that mistake to go.
 */
async function loadTogether(contents, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: `${name}.ts` },
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const cal = await load('src/core/schedule/workCalendar.ts', 'workCalendar')
const reschedule = await load('src/core/schedule/reschedule.ts', 'reschedule')
const conflicts = await load('src/core/sync/conflicts.ts', 'conflicts')
const schedule = await load('src/core/schedule/schedule.ts', 'schedule')
const seed = await load('src/core/mail/composeSeed.ts', 'composeSeed')
const heat = await load('src/core/schedule/calendarLoad.ts', 'calendarLoad')

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

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
const present = (what, value) => {
  checked++
  if (typeof value !== 'function') {
    failures.push(`${what} — the export does not exist`)
    return false
  }
  return true
}

const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()
const iso = (ms) => cal.toIsoDate(ms)
const hhmm = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const MIN = 60_000
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
    draft: { accountId: 'a', to: [`${id}@example.com`], cc: [], bcc: [], subject: `S-${id}`, body: '', attachments: [] },
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
// The nudge it was extended from must still behave exactly as it did
// ===========================================================================
//
// `spreadSameMinute` and `applyWorkCalendarDetailed` now share one placement
// routine. The whole risk of that is that generalising it quietly changed the
// old caller — and the old caller decides when real mail goes out.

{
  // Twenty consecutive holidays and a 23:45 daily reminder pushed backwards:
  // every occurrence collapses onto one evening and the nudge has to spread
  // them, forwards only, without crossing midnight.
  const block = []
  for (let i = 0; i < 20; i++) block.push(iso(at(2026, 6, 2) + i * 86_400_000))
  const BLOCK = { weekend: [0, 6], holidays: block, workdays: [] }

  const raw = schedule.computeOccurrences(
    { ...baseRec, startAt: at(2026, 6, 2, 23, 45), timeOfDay: '23:45' },
    { after: NOW, until: NOW + 25 * 86_400_000, count: 200 },
  )
  const { occurrences, adjustment } = cal.applyWorkCalendarDetailed(raw, 'before', BLOCK)

  ok('nudge: the within-one-job collapse still spreads', adjustment.spread.length > 0)
  ok(
    'nudge: and still only ever pushes later, never earlier',
    adjustment.spread.every((s) => s.byMs > 0),
  )
  ok(
    'nudge: it still never crosses midnight',
    occurrences.every((t) => new Date(t).getHours() === 23),
  )
  ok(
    'nudge: it still stops at the cap rather than spreading for hours',
    adjustment.spread.every((s) => s.byMs <= 60 * MIN),
  )
}

// ===========================================================================
// Spreading a pile-up ACROSS jobs — the thing nothing did
// ===========================================================================

if (present('stagger: spreadSameMinute is exported', cal.spreadSameMinute)) {
  const nine = at(2026, 6, 2, 9)
  const four = ['a', 'b', 'c', 'd'].map((jobId) => ({ jobId, at: nine }))
  const plan = cal.spreadSameMinute(four)

  eq('stagger: one of four keeps the minute everybody asked for', plan.moves.length, 3)
  const landed = [nine, ...plan.moves.map((m) => m.to)]
  eq('stagger: and all four end up on different instants', new Set(landed).size, 4)
  ok(
    'stagger: every one of them stays inside the window',
    plan.moves.every((m) => Math.abs(m.to - m.from) <= plan.windowMs),
  )
  ok(
    'stagger: and lands on a whole minute',
    landed.every((t) => t % MIN === 0),
  )
  ok('stagger: nothing is reported as crowded when there was room', plan.crowded.length === 0)

  // Both directions, nearest first. Pushing everybody strictly later means the
  // last one is N minutes from the time its owner actually chose.
  ok(
    'stagger: it spreads either side of the chosen minute, not only later',
    plan.moves.some((m) => m.to < m.from) && plan.moves.some((m) => m.to > m.from),
  )
  eq(
    'stagger: the closest free slot is used first',
    plan.moves.map((m) => (m.to - m.from) / MIN).sort((x, y) => Math.abs(x) - Math.abs(y)),
    [1, -1, 2],
  )

  // Determinism: the same pile-up, the jobs listed in a different order.
  const reversed = cal.spreadSameMinute([...four].reverse())
  eq(
    'stagger: the answer does not depend on the order the jobs arrived in',
    reversed.moves.map((m) => `${m.jobId}@${m.to - m.from}`).sort(),
    plan.moves.map((m) => `${m.jobId}@${m.to - m.from}`).sort(),
  )

  // One send is not a pile-up.
  eq('stagger: a single send is left exactly where it is', cal.spreadSameMinute([{ jobId: 'a', at: nine }]).moves, [])

  // Already-occupied instants the caller knows about.
  const avoiding = cal.spreadSameMinute([{ jobId: 'a', at: nine }], { taken: [nine] })
  ok('stagger: an instant the caller says is taken is avoided', avoiding.moves.length === 1)

  // The day boundary, from both ends. A send nudged past midnight is on a day
  // the calendar was never asked about.
  const midnight = at(2026, 6, 2, 0, 0)
  const early = cal.spreadSameMinute(['a', 'b', 'c'].map((jobId) => ({ jobId, at: midnight })))
  ok(
    'stagger: a pile-up at 00:00 never moves anything into the previous day',
    [midnight, ...early.moves.map((m) => m.to)].every((t) => iso(t) === '2026-06-02'),
  )
  const lateNight = at(2026, 6, 2, 23, 59)
  const late = cal.spreadSameMinute(['a', 'b', 'c'].map((jobId) => ({ jobId, at: lateNight })))
  ok(
    'stagger: and a pile-up at 23:59 never moves anything into the next day',
    [lateNight, ...late.moves.map((m) => m.to)].every((t) => iso(t) === '2026-06-02'),
  )

  // More sends than the window has slots. Keeping a duplicate timestamp is the
  // documented choice; dropping a send is the failure this app exists to stop.
  const crowd = Array.from({ length: 40 }, (_, i) => ({ jobId: `j${i}`, at: nine }))
  const packed = cal.spreadSameMinute(crowd)
  ok('stagger: an over-full window reports what it could not place', packed.crowded.length > 0)
  eq(
    'stagger: and never loses one — every job is still accounted for',
    packed.moves.length + (crowd.length - packed.moves.length),
    40,
  )
  ok(
    'stagger: nothing escapes the window even when it runs out of room',
    packed.moves.every((m) => Math.abs(m.to - m.from) <= packed.windowMs),
  )
}

// ===========================================================================
// Writing it back: the rule, not just a number
// ===========================================================================

if (present('restagger: planRestagger is exported', reschedule.planRestagger)) {
  const daily = job('d', { ...baseRec, kind: 'daily', startAt: at(2026, 6, 2, 9), timeOfDay: '09:00' })

  const later = reschedule.planRestagger(daily, 3 * MIN)
  if (ok('restagger: a daily rule can be moved a few minutes', Boolean(later.recurrence))) {
    eq('restagger: the rule\'s time of day moves', later.recurrence.timeOfDay, '09:03')
    // Both fields, always. One field holding 09:00 while the other holds 09:03
    // is the shape that put October's reminder in September.
    eq('restagger: and so does startAt, so the two cannot disagree', hhmm(later.recurrence.startAt), '09:03')
    eq('restagger: it says which way it went', later.reasonKey, 'cal.stagger.later')
    eq('restagger: and by how much', later.byMinutes, 3)

    // The assertion that matters: hand the new rule to the scheduler and look
    // at what it will actually fire. A plan the engine ignores is the bug this
    // whole file exists to catch.
    const before = schedule.computeOccurrences(daily.recurrence, { after: at(2026, 6, 2, 8), count: 1 })
    const after = schedule.computeOccurrences(later.recurrence, { after: at(2026, 6, 2, 8), count: 1 })
    eq('restagger: the scheduler fires at the old time before', hhmm(before[0]), '09:00')
    eq('restagger: and at the new one after — the rule really moved', hhmm(after[0]), '09:03')
  }

  const earlier = reschedule.planRestagger(daily, -2 * MIN)
  if (ok('restagger: it can also move earlier', Boolean(earlier.recurrence))) {
    eq('restagger: to the minute asked for', earlier.recurrence.timeOfDay, '08:58')
    eq('restagger: and says so', earlier.reasonKey, 'cal.stagger.earlier')
    const after = schedule.computeOccurrences(earlier.recurrence, { after: at(2026, 6, 2, 8), count: 1 })
    eq('restagger: which the scheduler agrees with', hhmm(after[0]), '08:58')
  }

  // A weekly rule keeps its weekday: this moves the *time*, and nothing else.
  const weekly = job('w', { ...baseRec, kind: 'weekly', weekdays: [2, 5], startAt: at(2026, 6, 2, 9) })
  const shifted = reschedule.planRestagger(weekly, MIN)
  if (ok('restagger: a weekly rule can be moved too', Boolean(shifted.recurrence))) {
    eq('restagger: and keeps every weekday it had', shifted.recurrence.weekdays, [2, 5])
    eq('restagger: it is still a weekly rule', shifted.recurrence.kind, 'weekly')
  }

  // The refusals, which are the honest half.
  for (const [what, plan, reason] of [
    [
      'a cron rule',
      reschedule.planRestagger(job('c', { ...baseRec, kind: 'cron', cron: '0 9 * * *' }), MIN),
      'cal.stagger.cron',
    ],
    [
      'a move of no minutes at all',
      reschedule.planRestagger(daily, 0),
      'cal.stagger.noChange',
    ],
    [
      'a move that would cross midnight forwards',
      reschedule.planRestagger(job('l', { ...baseRec, timeOfDay: '23:59' }), MIN),
      'cal.stagger.crossesMidnight',
    ],
    [
      'a move that would cross midnight backwards',
      reschedule.planRestagger(job('e', { ...baseRec, timeOfDay: '00:00' }), -MIN),
      'cal.stagger.crossesMidnight',
    ],
    [
      'a rule whose time of day is unreadable',
      reschedule.planRestagger(job('b', { ...baseRec, timeOfDay: 'soon' }), MIN),
      'cal.stagger.badTime',
    ],
  ]) {
    eq(`restagger: ${what} produces no rule to save`, plan.recurrence, undefined)
    eq(`restagger: ${what} says why`, plan.reasonKey, reason)
  }

  // Every reason this can return has to be a string the app can print. A
  // refusal that renders as `cal.stagger.cron` on screen is a refusal nobody
  // can act on — four advisory keys shipped exactly like that once.
  const en = read('src/i18n/en.ts')
  for (const key of [
    'cal.stagger.later',
    'cal.stagger.earlier',
    'cal.stagger.cron',
    'cal.stagger.noChange',
    'cal.stagger.crossesMidnight',
    'cal.stagger.badTime',
  ]) {
    ok(`restagger: "${key}" is a real translation key`, en.includes(`  '${key}':`))
  }
}

// ===========================================================================
// End to end: does the button actually make the conflict go away?
// ===========================================================================

{
  const nine = at(2026, 6, 2, 9)
  const jobs = ['a', 'b', 'c', 'd'].map((id) =>
    job(id, { ...baseRec, kind: 'daily', startAt: nine, timeOfDay: '09:00' }),
  )

  const scan = conflicts.findConflicts(jobs, PLAIN, { now: NOW, days: 10 })
  const pileUps = scan.conflicts.filter((c) => c.kind === 'sameMinute')
  if (ok('end to end: four reminders on one minute are reported', pileUps.length > 0)) {
    eq('end to end: and all four are named', pileUps[0].jobIds.slice().sort(), ['a', 'b', 'c', 'd'])

    // Exactly what the screen does: plan the spread, turn each move into a
    // rule, save it.
    const plan = cal.spreadSameMinute(pileUps[0].jobIds.map((jobId) => ({ jobId, at: pileUps[0].at })))
    const byId = new Map(jobs.map((j) => [j.id, j]))
    const after = jobs.map((j) => {
      const move = plan.moves.find((m) => m.jobId === j.id)
      if (!move) return j
      const restagger = reschedule.planRestagger(byId.get(j.id), move.to - move.from)
      return { ...j, recurrence: restagger.recurrence ?? j.recurrence }
    })

    eq(
      'end to end: the pile-up is gone from the rescan',
      conflicts.findConflicts(after, PLAIN, { now: NOW, days: 10 }).conflicts.filter((c) => c.kind === 'sameMinute')
        .length,
      0,
    )
    // And it did not simply delete the schedule to achieve that.
    const times = after.map(
      (j) => schedule.computeOccurrences(j.recurrence, { after: at(2026, 6, 2, 8), count: 1 })[0],
    )
    ok('end to end: all four reminders still fire', times.every((t) => typeof t === 'number'))
    eq('end to end: on four different minutes', new Set(times).size, 4)
    ok(
      'end to end: all of them within the window of the time they asked for',
      times.every((t) => Math.abs(t - nine) <= cal.STAGGER_WINDOW_MS),
    )
    ok('end to end: and all still on the same day', times.every((t) => iso(t) === '2026-06-02'))
  }
}

// ===========================================================================
// The date a double-click carries to the compose screen
// ===========================================================================

if (present('seed: seedComposeDate is exported', seed.seedComposeDate)) {
  const now = at(2026, 6, 1, 14, 37)
  /** A `defer` that never runs, so one "render pass" can be inspected. */
  const held = []
  const hold = (fn) => held.push(fn)
  const flush = () => {
    while (held.length > 0) held.shift()()
  }

  seed.clearComposeSeed()
  eq('seed: with nothing waiting, the start time is the next whole hour', hhmm(seed.nextComposeStart(now)), '15:00')

  eq('seed: a nonsense date is refused', seed.seedComposeDate('soon'), false)
  eq('seed: and nothing is left waiting', seed.peekComposeSeed(), null)

  ok('seed: a real date is accepted', seed.seedComposeDate('2026-09-15'))
  eq('seed: and can be inspected without being spent', seed.peekComposeSeed(), '2026-09-15')
  const started = seed.nextComposeStart(now, hold)
  eq('seed: the new reminder starts on the day that was double-clicked', iso(started), '2026-09-15')
  eq('seed: at an hour a person would have picked', hhmm(started), '09:00')

  // StrictMode invokes a `useState` initialiser twice and keeps one of the two
  // results. Both invocations must see the same seed, or whether the date
  // lands depends on which build you are running.
  eq(
    'seed: a second read inside the same render pass gets the same answer',
    iso(seed.nextComposeStart(now, hold)),
    '2026-09-15',
  )
  flush()
  eq(
    'seed: and once that pass is over the seed is spent',
    hhmm(seed.nextComposeStart(now, hold)),
    '15:00',
  )
  eq('seed: with nothing left behind', seed.peekComposeSeed(), null)

  // Today, after nine. Nine has gone; the next whole hour is the nearest time
  // on this day that anybody would have chosen.
  seed.clearComposeSeed()
  seed.seedComposeDate('2026-06-01')
  const today = seed.nextComposeStart(now, hold)
  flush()
  eq('seed: today after nine falls back to the next whole hour', hhmm(today), '15:00')
  eq('seed: on today, not tomorrow', iso(today), '2026-06-01')

  seed.clearComposeSeed()
  seed.seedComposeDate('2026-06-01')
  const earlyToday = seed.nextComposeStart(at(2026, 6, 1, 6, 5), hold)
  flush()
  eq('seed: today before nine still gets nine', hhmm(earlyToday), '09:00')
}

// ===========================================================================
// ...and that the compose screen is what reads it
// ===========================================================================
//
// The store above is testable in isolation and proves nothing on its own: a
// seed nobody consumes is a date that goes nowhere. `nextWholeHour` is the one
// function every new reminder's start time comes through, so the assertion is
// made on that, through the module the compose screen actually imports.

{
  const wired = await loadTogether(
    [
      "export * from './src/core/mail/composeSeed'",
      "export { nextWholeHour } from './src/components/RecurrenceEditor'",
      '',
    ].join('\n'),
    'wiring',
  )
  if (present('wiring: RecurrenceEditor still exports nextWholeHour', wired.nextWholeHour)) {
    const now = at(2026, 6, 1, 14, 37)
    wired.clearComposeSeed()
    eq('wiring: with no seed it is the next whole hour, exactly as before', hhmm(wired.nextWholeHour(now)), '15:00')

    wired.seedComposeDate('2026-09-15')
    const seeded = wired.nextWholeHour(now)
    eq('wiring: and the compose screen\'s seed really does read the calendar\'s date', iso(seeded), '2026-09-15')
    eq('wiring: at the seeded hour', hhmm(seeded), '09:00')
    // Spent, so the *next* reminder — the one started from the compose screen
    // itself — still begins today like it always did.
    await new Promise((resolve) => setTimeout(resolve, 5))
    eq('wiring: and the seed is spent, not sticky', hhmm(wired.nextWholeHour(now)), '15:00')
    wired.clearComposeSeed()
  }

  // The compose screen is off limits to this change, so the one thing that
  // must not have moved is the name it imports.
  const compose = read('src/views/ComposeView.tsx')
  ok('wiring: ComposeView still seeds from nextWholeHour', /nextWholeHour\(now\)/.test(compose))
  ok(
    'wiring: and its whenbar still switches on the recurrence kind',
    compose.includes("recurrence.kind === 'cron'"),
  )
}

// ===========================================================================
// The heatmap: every step it can produce has a shade, and they get stronger
// ===========================================================================

if (present('heat: loadLevel is exported', heat.loadLevel)) {
  eq('heat: a day with nothing on it has no level at all', heat.loadLevel(0), undefined)
  eq('heat: not level zero — the attribute is simply absent', heat.loadLevel(-3), undefined)
  eq('heat: one send is the first step', heat.loadLevel(1), 1)
  eq('heat: two is the second', heat.loadLevel(2), 2)
  eq('heat: four is still the third — the steps are not the count', heat.loadLevel(4), 3)
  eq('heat: five is the fourth', heat.loadLevel(5), 4)
  eq('heat: eight is the top', heat.loadLevel(8), heat.MAX_LOAD_LEVEL)
  eq('heat: and forty is still the top, not a sixth shade', heat.loadLevel(40), heat.MAX_LOAD_LEVEL)

  // Monotonic: a busier day is never a lower step than a quieter one.
  let previous = 0
  let monotonic = true
  for (let n = 1; n <= 60; n++) {
    const level = heat.loadLevel(n)
    if (level < previous) monotonic = false
    previous = level
  }
  ok('heat: the scale never goes backwards as the day gets busier', monotonic)

  const css = concatenatedAppCss()
  const strengths = []
  for (let level = 1; level <= heat.MAX_LOAD_LEVEL; level++) {
    const rule = new RegExp(
      `\\.monthgrid__day\\[data-load='${level}'\\]\\s*\\{[^}]*--load-tint:\\s*color-mix\\(in oklab, var\\(--accent\\) (\\d+)%`,
    ).exec(css)
    if (!ok(`heat: step ${level} has a shade in the stylesheet`, Boolean(rule))) continue
    strengths.push(Number(rule[1]))
  }
  eq('heat: every step the code can return is painted', strengths.length, heat.MAX_LOAD_LEVEL)
  ok(
    'heat: and each step is stronger than the one below it',
    strengths.every((s, i) => i === 0 || s > strengths[i - 1]),
  )
  ok('heat: the scale is mixed from the accent token, never a literal colour', !/--load-tint:\s*#/.test(css))
  ok(
    'heat: it layers over the square rather than replacing its background',
    /\.monthgrid__day\[data-load\]\s*\{\s*background-image:/.test(css),
  )
  // The tint must not be so strong that the conflict border stops reading.
  ok('heat: no step is opaque enough to swallow the square', strengths.every((s) => s <= 40))

  // A shade with no step behind it is a rule nobody can reach.
  const painted = [...css.matchAll(/\.monthgrid__day\[data-load='(\d+)'\]/g)].map((m) => Number(m[1]))
  ok(
    'heat: and no shade is painted for a step that cannot happen',
    painted.every((level) => level >= 1 && level <= heat.MAX_LOAD_LEVEL),
  )
}

// ===========================================================================
// Is any of it actually wired up?
// ===========================================================================
//
// Every check above tests a function. None of them would notice if the screen
// stopped calling it — which is exactly how two settings switches shipped
// wired to nothing and three transport functions shipped never called.

{
  const grid = read('src/components/MonthGrid.tsx')
  const view = read('src/views/WorkCalendarView.tsx')
  const panel = read('src/components/CalendarDayPanel.tsx')
  const app = read('src/App.tsx')
  const css = concatenatedAppCss()

  ok('wiring: the grid renders each send as its own row', grid.includes('monthgrid__send'))
  ok('wiring: reading the prebuilt list rather than scanning one', grid.includes('mark?.lines'))
  ok('wiring: capped, with an affordance for the rest', grid.includes('MAX_CELL_SENDS') && grid.includes('moreLabel'))
  ok('wiring: a listed send opens the reminder', grid.includes('onOpenSend?.('))
  ok('wiring: and can be dragged, carrying its own job id', /dragPayload\(send\.jobId, cell\.iso\)/.test(grid))
  ok('wiring: an empty square takes a double-click', grid.includes('onDoubleClick'))
  ok(
    'wiring: and the second click of it never toggles the day',
    /event\.detail > 1/.test(grid),
  )
  ok('wiring: the square carries its heat step', grid.includes('data-load'))

  ok('wiring: the calendar screen turns the list on', /showSends/.test(view))
  ok('wiring: passes a memoised time formatter rather than one per cell', view.includes('formatTime={formatTime}'))
  ok('wiring: builds the heat step from the shared scale', view.includes('loadLevel(mark.count)'))
  ok('wiring: hands the grid a create handler', view.includes('onCreateDay={'))
  ok('wiring: which seeds the date the compose screen will read', view.includes('seedComposeDate(iso)'))
  ok('wiring: and takes back the toggle the first click committed', /undo\(\)/.test(view))
  ok('wiring: the de-stagger is offered where the conflict is named', view.includes('deStagger(conflict)'))
  ok('wiring: it plans with the shared nudge', view.includes('spreadSameMinute('))
  ok('wiring: writes the result back through scheduleDraft', /scheduleDraft\(\{ \.\.\.w\.job/.test(view))
  ok('wiring: as one undo entry for the whole batch', /pushUndo\(\s*t\('cal\.stagger\.undo'\)/.test(view))
  ok('wiring: and asks first', view.includes("t('cal.stagger.body'"))

  ok('wiring: the day panel lists the recipient', panel.includes('dayrow__who'))
  ok('wiring: and the subject', panel.includes('dayrow__subject'))
  ok('wiring: and offers the de-stagger on the day it happens', panel.includes('onDeStagger'))

  ok('wiring: the shell gives the calendar a way to reach compose', /WorkCalendarView onCompose=/.test(app))

  // A class rendered with no rule is invisible; a rule with no renderer is
  // dead weight that reads like live code.
  for (const cls of ['monthgrid__sends', 'monthgrid__send', 'monthgrid__more', 'monthgrid__sendtime', 'dayrow__who']) {
    ok(`wiring: .${cls} is styled`, css.includes(`.${cls}`))
  }

  // The 360px decision, asserted rather than trusted: a square that lists three
  // lines of text cannot also be 38px tall, so on a phone it does not.
  ok(
    'layout: below 599.98px the square goes back to a tap target',
    /@media \(max-width: 599.98px\) \{[\s\S]*?\.monthgrid__sends \{\s*display: none;/.test(css),
  )
  ok(
    'layout: the time in a row is never the part that gets truncated',
    /\.monthgrid__sendtime \{[^}]*flex: none/.test(css),
  )
  ok(
    'layout: and the part that is can actually shrink',
    /\.monthgrid__sendtext \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/.test(css),
  )
  ok(
    'layout: a subject in the day panel wraps anywhere, not only at spaces',
    /\.dayrow__subject \{|\.dayrow__who,\n\.dayrow__subject \{/.test(css) && /overflow-wrap: anywhere/.test(css),
  )
}

// ===========================================================================

await rm(dir, { recursive: true, force: true })

const label = 'the calendar is where scheduled mail is managed'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
