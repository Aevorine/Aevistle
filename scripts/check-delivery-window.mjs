/**
 * Does a scheduled send land inside the *recipient's* working hours?
 *
 * `core/schedule/deliveryWindow.ts` is the only module in this codebase that reasons in
 * a clock other than the sender's, and it has to do it without a time-zone
 * library. Everything below is one of the four ways that goes wrong:
 *
 *   - **The wrong clock.** The whole feature is "not 03:00 their time". A
 *     module that quietly falls back to the machine's own zone passes every
 *     casual test written by someone sitting in that zone, so every assertion
 *     here names an explicit IANA zone and an absolute UTC instant, and
 *     `process.env.TZ` is pinned so that "the sender's zone" is a known,
 *     *different* answer rather than whatever the machine happens to be.
 *   - **The hour that does not exist.** A window opening at 02:30 on a
 *     spring-forward day. Naive arithmetic returns 03:30 and silently loses the
 *     first half-hour of the window.
 *   - **The hour that happens twice.** An autumn-back day has two 01:30s. Which
 *     one the window opens at is a decision, and an undocumented decision is a
 *     bug waiting for November.
 *   - **The recipient who cannot be reached.** Auckland and California inside
 *     ordinary business hours have no shared instant at all. That has to come
 *     back as a reported impossibility with the send still going out — never as
 *     a message that quietly never leaves.
 *
 * Both hemispheres are covered because they move in opposite directions, and
 * `Asia/Kathmandu` (+05:45) and `Australia/Adelaide` (+09:30) are here because
 * a whole class of offset bugs only shows up when the offset is not a whole
 * hour.
 *
 * `--selftest` re-introduces the naive wall-clock inversion — one offset,
 * looked up at the instant we are trying to resolve, and no handling for the
 * hour that does not exist — and requires that the checks below go red. A guard
 * nobody has watched fail is not yet a guard.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const selftest = process.argv.includes('--selftest')

const SOURCE = path.join(process.cwd(), 'src', 'core', 'schedule', 'deliveryWindow.ts')

/**
 * The known-bad version: resolve a wall clock with whatever offset happens to
 * be in force at the naive instant, and assume the wall clock exists.
 *
 * Every replacement is counted. A bend that silently matched nothing would
 * produce a green selftest and a false sense of a working guard — the same
 * shape as an `unzip` that exits 0 having extracted nothing.
 */
const BENDS = [
  ['const o1 = offsetOf(naive - DAY_MS, zone)', 'const o1 = offsetOf(naive, zone)'],
  ['const o2 = offsetOf(naive + DAY_MS, zone)', 'const o2 = offsetOf(naive, zone)'],
  [
    'const gap = findTransition(naive - DAY_MS, naive + DAY_MS, zone)',
    'const gap = null && findTransition(naive - DAY_MS, naive + DAY_MS, zone)',
  ],
]

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-window-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-window-'))
}

let entry = SOURCE
if (selftest) {
  let source = await readFile(SOURCE, 'utf8')
  for (const [find, replace] of BENDS) {
    if (!source.includes(find)) {
      console.log(`\n  SELFTEST FAILED: nothing to bend — "${find}" is not in the module.\n`)
      await rm(dir, { recursive: true, force: true })
      process.exit(1)
    }
    source = source.split(find).join(replace)
  }
  entry = path.join(dir, 'bent.ts')
  await writeFile(entry, source, 'utf8')
}

async function load(entryPoint, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const w = await load(entry, 'deliveryWindow')
const sched = await load(path.join(process.cwd(), 'src', 'core', 'schedule', 'schedule.ts'), 'schedule')

const failures = []
let checked = 0
const ok = (what, pass) => {
  checked++
  if (!pass) failures.push(what)
}
const eq = (what, actual, expected) =>
  ok(
    `${what} (got ${show(actual)}, want ${show(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected),
  )
const present = (what, value) => {
  checked++
  if (typeof value !== 'function') failures.push(`${what} — the export does not exist`)
  return typeof value === 'function'
}

/** Timestamps are unreadable as numbers, so failures print them as UTC. */
const show = (v) =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) > 1e11
    ? new Date(v).toISOString()
    : JSON.stringify(v)

/** Absolute UTC instant. Every fixture below is one of these — never a local Date. */
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi, 0, 0)

const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const win = (timeZone, from, to, days = WEEKDAYS) => ({ timeZone, from, to, days })

// ===========================================================================
// The fixtures, asserted before anything is built on them
// ===========================================================================

eq('fixture: 2026-08-04 is a Tuesday', new Date(U(2026, 8, 4)).getUTCDay(), 2)
eq('fixture: 2026-08-07 is a Friday', new Date(U(2026, 8, 7)).getUTCDay(), 5)
eq('fixture: 2026-08-08 is a Saturday', new Date(U(2026, 8, 8)).getUTCDay(), 6)
eq('fixture: 2026-08-10 is a Monday', new Date(U(2026, 8, 10)).getUTCDay(), 1)
eq('fixture: 2026-03-08 (US spring forward) is a Sunday', new Date(U(2026, 3, 8)).getUTCDay(), 0)
eq('fixture: 2026-11-01 (US autumn back) is a Sunday', new Date(U(2026, 11, 1)).getUTCDay(), 0)
eq('fixture: 2026-04-05 (AU DST ends) is a Sunday', new Date(U(2026, 4, 5)).getUTCDay(), 0)
eq('fixture: 2026-10-04 (AU DST starts) is a Sunday', new Date(U(2026, 10, 4)).getUTCDay(), 0)

// ===========================================================================
// The runtime this has to work on
// ===========================================================================

{
  // Electron 43 / Chromium and the Android WebView both carry full ICU, but a
  // guard that assumes it and a product that assumes it fail in the same
  // invisible way, so the assumption is stated out loud.
  const zones = w.knownTimeZones()
  ok('runtime: Intl.supportedValuesOf("timeZone") is available', zones.length > 0)
  ok('runtime: and it is the real list, not a stub', zones.includes('Asia/Shanghai'))
  for (const zone of [
    'Asia/Shanghai',
    'America/New_York',
    'Australia/Sydney',
    'Australia/Adelaide',
    'Asia/Kathmandu',
    'Pacific/Auckland',
    'Europe/London',
    'America/Los_Angeles',
  ]) {
    ok(`runtime: ICU knows ${zone}`, w.isValidTimeZone(zone))
  }

  // The reason `isValidTimeZone` builds a formatter instead of consulting the
  // list: the list is incomplete, and *which* aliases it omits moves with the
  // ICU version — this runtime lists `Asia/Calcutta` but not `US/Pacific`, and
  // an earlier one omitted both. Every one of these is a live alias that real
  // systems still emit and that a stored contact can legitimately carry.
  // Validating against the list would reject some of them and hold that
  // contact's mail forever, so the list is never the validator.
  const aliases = ['Asia/Calcutta', 'US/Pacific', 'Europe/Kiev', 'Australia/Canberra', 'GMT']
  for (const alias of aliases) {
    ok(`runtime: the legacy alias ${alias} is a usable zone`, w.isValidTimeZone(alias))
  }
  ok(
    'runtime: and at least one usable zone is missing from supportedValuesOf',
    zones.length > 0 && aliases.some((a) => !zones.includes(a)),
  )

  eq('runtime: the pinned sender zone is what "" resolves to', w.senderTimeZone(), 'America/Los_Angeles')
}

// ===========================================================================
// Reading a UTC instant as somebody else's wall clock
// ===========================================================================

if (present('wallClockIn is exported', w.wallClockIn)) {
  const shanghai = w.wallClockIn(U(2026, 8, 4, 2, 0), 'Asia/Shanghai')
  eq('wall clock: 02:00 UTC is 10:00 in Shanghai', shanghai?.minutes, 10 * 60)
  eq('wall clock: on the 4th', shanghai?.day, 4)
  eq('wall clock: a Tuesday', shanghai?.weekday, 2)

  // The date rolls over before the sender's does — the case a naive
  // implementation gets wrong by reading local fields off a Date.
  const auckland = w.wallClockIn(U(2026, 8, 4, 22, 0), 'Pacific/Auckland')
  eq('wall clock: 22:00 UTC Tue is already Wednesday in Auckland', auckland?.day, 5)
  eq('wall clock: and its weekday says so', auckland?.weekday, 3)

  eq('wall clock: an unknown zone is null, not a guess', w.wallClockIn(U(2026, 8, 4), 'Mars/Olympus_Mons'), null)

  eq('offset: Kathmandu is +05:45', w.zoneOffsetAt(U(2026, 8, 4), 'Asia/Kathmandu'), 5 * 3600_000 + 45 * 60_000)
  eq('offset: Adelaide in August is +09:30', w.zoneOffsetAt(U(2026, 8, 4), 'Australia/Adelaide'), 9 * 3600_000 + 30 * 60_000)
  eq('offset: Adelaide in January is +10:30', w.zoneOffsetAt(U(2026, 1, 4), 'Australia/Adelaide'), 10 * 3600_000 + 30 * 60_000)
  eq('offset: an unknown zone is null', w.zoneOffsetAt(U(2026, 8, 4), 'Mars/Olympus_Mons'), null)
}

// ===========================================================================
// Wall clock → instant, including the two hours that misbehave
// ===========================================================================

if (present('instantForWallClock is exported', w.instantForWallClock)) {
  const at = (y, mo, d, hh, mm, zone) => w.instantForWallClock(y, mo, d, hh * 60 + mm, zone)

  // Ordinary, whole-hour offset.
  eq('resolve: 09:00 in Shanghai is 01:00 UTC', at(2026, 8, 4, 9, 0, 'Asia/Shanghai')?.at, U(2026, 8, 4, 1, 0))
  eq('resolve: and it is unambiguous', at(2026, 8, 4, 9, 0, 'Asia/Shanghai')?.kind, 'exact')

  // Non-hour offsets.
  eq('resolve: 09:00 in Kathmandu is 03:15 UTC', at(2026, 8, 4, 9, 0, 'Asia/Kathmandu')?.at, U(2026, 8, 4, 3, 15))
  eq('resolve: 09:00 in Adelaide is 23:30 UTC the day before', at(2026, 8, 4, 9, 0, 'Australia/Adelaide')?.at, U(2026, 8, 3, 23, 30))

  // Northern spring: 02:00 becomes 03:00, so 02:30 never happens. The answer
  // has to be the transition itself, 03:00 EDT — not 03:30, which is what
  // naive arithmetic returns.
  const nySpring = at(2026, 3, 8, 2, 30, 'America/New_York')
  eq('DST: New York 02:30 on 2026-03-08 does not exist', nySpring?.kind, 'gap')
  eq('DST: and resolves to the transition, 03:00 EDT', nySpring?.at, U(2026, 3, 8, 7, 0))

  // Northern autumn: 01:30 happens twice. We take the first.
  const nyAutumn = at(2026, 11, 1, 1, 30, 'America/New_York')
  eq('DST: New York 01:30 on 2026-11-01 happens twice', nyAutumn?.kind, 'ambiguous')
  eq('DST: and the first one is chosen', nyAutumn?.at, U(2026, 11, 1, 5, 30))
  ok('DST: the second 01:30 is a real instant too', w.wallClockIn(U(2026, 11, 1, 6, 30), 'America/New_York')?.minutes === 90)

  // Southern hemisphere, the same two events in the opposite months.
  const sydSpring = at(2026, 10, 4, 2, 30, 'Australia/Sydney')
  eq('DST: Sydney 02:30 on 2026-10-04 does not exist', sydSpring?.kind, 'gap')
  eq('DST: and resolves to 03:00 AEDT', sydSpring?.at, U(2026, 10, 3, 16, 0))

  const sydAutumn = at(2026, 4, 5, 2, 30, 'Australia/Sydney')
  eq('DST: Sydney 02:30 on 2026-04-05 happens twice', sydAutumn?.kind, 'ambiguous')
  eq('DST: and the first (AEDT) one is chosen', sydAutumn?.at, U(2026, 4, 4, 15, 30))

  // Half-hour offset *and* a clock change, which is where an implementation
  // that rounds offsets to hours falls over.
  const adlSpring = at(2026, 10, 4, 2, 30, 'Australia/Adelaide')
  eq('DST: Adelaide 02:30 on 2026-10-04 does not exist', adlSpring?.kind, 'gap')
  eq('DST: and resolves to 03:00 ACDT', adlSpring?.at, U(2026, 10, 3, 16, 30))

  const adlAutumn = at(2026, 4, 5, 2, 30, 'Australia/Adelaide')
  eq('DST: Adelaide 02:30 on 2026-04-05 happens twice', adlAutumn?.kind, 'ambiguous')
  eq('DST: and the first (ACDT) one is chosen', adlAutumn?.at, U(2026, 4, 4, 16, 0))

  eq('resolve: an unknown zone is null', at(2026, 8, 4, 9, 0, 'Mars/Olympus_Mons'), null)
}

// ===========================================================================
// Inside and outside
// ===========================================================================

const CN = win('Asia/Shanghai', '09:00', '18:00')

if (present('isInsideWindow is exported', w.isInsideWindow)) {
  ok('inside: 10:00 Tuesday in Shanghai is inside 09:00–18:00', w.isInsideWindow(U(2026, 8, 4, 2, 0), CN))
  ok('inside: 03:00 Tuesday is not — this is the bug the feature exists for', !w.isInsideWindow(U(2026, 8, 3, 19, 0), CN))
  ok('inside: 18:00 exactly is outside — the end is exclusive', !w.isInsideWindow(U(2026, 8, 4, 10, 0), CN))
  ok('inside: 09:00 exactly is inside — the start is not', w.isInsideWindow(U(2026, 8, 4, 1, 0), CN))
  ok('inside: 10:00 Saturday is outside', !w.isInsideWindow(U(2026, 8, 8, 2, 0), CN))
}

if (present('nextInsideWindow is exported', w.nextInsideWindow)) {
  eq('next: 03:00 Tuesday waits until 09:00 that morning', w.nextInsideWindow(U(2026, 8, 3, 19, 0), CN), U(2026, 8, 4, 1, 0))
  eq('next: an instant already inside is returned unchanged', w.nextInsideWindow(U(2026, 8, 4, 2, 0), CN), U(2026, 8, 4, 2, 0))
  eq('next: Saturday waits for Monday', w.nextInsideWindow(U(2026, 8, 8, 2, 0), CN), U(2026, 8, 10, 1, 0))

  // The headline case from the brief.
  const NY = win('America/New_York', '09:00', '17:00')
  eq(
    'next: a Friday 18:00 send goes out Monday 09:00 in New York',
    w.nextInsideWindow(U(2026, 8, 7, 22, 0), NY),
    U(2026, 8, 10, 13, 0),
  )

  const KTM = win('Asia/Kathmandu', '09:00', '17:00')
  eq('next: a +05:45 zone opens at 03:15 UTC', w.nextInsideWindow(U(2026, 8, 4, 0, 0), KTM), U(2026, 8, 4, 3, 15))
}

// ===========================================================================
// Windows that meet a clock change
// ===========================================================================

{
  // A window that opens during the hour that does not exist opens at the
  // transition instead — it does not skip the day, and it does not open an
  // hour late.
  const gapWindow = win('America/New_York', '02:30', '09:00', EVERY_DAY)
  eq(
    'DST window: an opening inside the spring gap moves to the transition',
    w.nextInsideWindow(U(2026, 3, 8, 6, 0), gapWindow),
    U(2026, 3, 8, 7, 0),
  )

  // A window swallowed whole by the gap: 02:00–02:45 on a day whose clock goes
  // 02:00 → 03:00 never opens at all, so the send waits for tomorrow rather
  // than being released at 03:00 outside its own window.
  const swallowed = win('America/New_York', '02:00', '02:45', EVERY_DAY)
  eq(
    'DST window: a window the spring gap swallows waits for the next day',
    w.nextInsideWindow(U(2026, 3, 8, 6, 0), swallowed),
    U(2026, 3, 9, 6, 0),
  )

  // Autumn: the window opens at the *first* 01:30 and is still open during the
  // repeat.
  const autumn = win('America/New_York', '01:30', '03:00', EVERY_DAY)
  eq(
    'DST window: an autumn opening takes the first of the two 01:30s',
    w.nextInsideWindow(U(2026, 11, 1, 4, 0), autumn),
    U(2026, 11, 1, 5, 30),
  )
  ok('DST window: and the repeated hour is still inside it', w.isInsideWindow(U(2026, 11, 1, 6, 30), autumn))

  const syd = win('Australia/Sydney', '02:30', '05:00', EVERY_DAY)
  eq(
    'DST window: Sydney opens at the spring transition, not an hour later',
    w.nextInsideWindow(U(2026, 10, 3, 15, 0), syd),
    U(2026, 10, 3, 16, 0),
  )

  const adl = win('Australia/Adelaide', '02:30', '05:00', EVERY_DAY)
  eq(
    'DST window: Adelaide opens at the first 02:30 when the clock goes back',
    w.nextInsideWindow(U(2026, 4, 4, 15, 0), adl),
    U(2026, 4, 4, 16, 0),
  )
}

// ===========================================================================
// A window that spans midnight
// ===========================================================================

{
  const night = win('Asia/Shanghai', '22:00', '06:00')

  ok('midnight: Tuesday 23:00 is inside a 22:00–06:00 window', w.isInsideWindow(U(2026, 8, 4, 15, 0), night))
  ok('midnight: Wednesday 02:00 is inside it too — the window opened Tuesday', w.isInsideWindow(U(2026, 8, 4, 18, 0), night))
  ok('midnight: Saturday 02:00 is inside — Friday night runs into Saturday', w.isInsideWindow(U(2026, 8, 7, 18, 0), night))
  ok('midnight: Sunday 02:00 is not — Saturday is not in the day list', !w.isInsideWindow(U(2026, 8, 8, 18, 0), night))
  ok('midnight: Tuesday noon is not inside a night window', !w.isInsideWindow(U(2026, 8, 4, 4, 0), night))
  eq('midnight: and noon waits for 22:00 that evening', w.nextInsideWindow(U(2026, 8, 4, 4, 0), night), U(2026, 8, 4, 14, 0))

  // `24:00` as an end means midnight, not "hour 24 is invalid".
  const toMidnight = win('UTC', '22:00', '24:00', EVERY_DAY)
  eq('midnight: 24:00 is a readable end time', w.windowFault(toMidnight), null)
  ok('midnight: 23:00 is inside 22:00–24:00', w.isInsideWindow(U(2026, 8, 4, 23, 0), toMidnight))
  ok('midnight: 00:30 the next day is not', !w.isInsideWindow(U(2026, 8, 5, 0, 30), toMidnight))
}

// ===========================================================================
// Windows that are wrong, and the promise that being wrong never holds mail
// ===========================================================================

if (present('windowFault is exported', w.windowFault)) {
  const t = U(2026, 8, 4, 2, 0)

  const noDays = win('UTC', '09:00', '17:00', [])
  eq('fault: an empty day list can never open', w.windowFault(noDays), 'neverOpens')
  ok('fault: so it holds nothing back', w.isInsideWindow(t, noDays))
  eq('fault: and never moves a send', w.nextInsideWindow(t, noDays), t)

  const bogus = win('Mars/Olympus_Mons', '09:00', '17:00')
  eq('fault: an unknown zone is named as such', w.windowFault(bogus), 'unknownZone')
  ok('fault: and holds nothing back either', w.isInsideWindow(t, bogus))

  eq('fault: an unreadable start time', w.windowFault(win('UTC', 'nine', '17:00')), 'malformed')
  eq('fault: an unreadable end time', w.windowFault(win('UTC', '09:00', '25:00')), 'malformed')
  eq('fault: a zero-length window can never open', w.windowFault(win('UTC', '09:00', '09:00')), 'neverOpens')
  eq('fault: an ordinary window has no fault', w.windowFault(CN), null)
  eq('fault: the shipped default is usable', w.windowFault(w.DEFAULT_DELIVERY_WINDOW), null)
  ok(
    'fault: and the default really is business hours on a weekday',
    w.isInsideWindow(U(2026, 8, 4, 17, 0), w.DEFAULT_DELIVERY_WINDOW),
  )
  eq('fault: an empty zone means the sender, which is not a fault', w.windowFault(win('', '09:00', '17:00')), null)

  // 7 is Sunday in every cron-shaped editor, and `parseCron` already folds it.
  const sunday = win('UTC', '09:00', '17:00', [7])
  eq('fault: a day list of [7] is usable', w.windowFault(sunday), null)
  ok('fault: and 7 means Sunday', w.isInsideWindow(U(2026, 8, 9, 10, 0), sunday))
}

// ===========================================================================
// The sender's own zone
// ===========================================================================

{
  const own = win('', '09:00', '17:00')
  ok('sender zone: 09:30 Pacific is inside', w.isInsideWindow(U(2026, 8, 4, 16, 30), own))
  ok('sender zone: 08:00 Pacific is not', !w.isInsideWindow(U(2026, 8, 4, 15, 0), own))
  eq('sender zone: and 08:00 waits an hour', w.nextInsideWindow(U(2026, 8, 4, 15, 0), own), U(2026, 8, 4, 16, 0))
}

// ===========================================================================
// One send, several recipients
// ===========================================================================

if (present('applyDeliveryWindows is exported', w.applyDeliveryWindows)) {
  const LDN = win('Europe/London', '09:00', '17:00')

  {
    const t = U(2026, 8, 4, 2, 0)
    const r = w.applyDeliveryWindows(t, [CN])
    eq('apply: an instant already inside is unchanged', r.outcome, 'unchanged')
    eq('apply: and says so', r.reason, 'inside')
    eq('apply: at the instant it started at', r.at, t)
    eq('apply: with nothing to split', r.splitRequired, false)
    eq('apply: one landing per recipient', r.perRecipient.length, 1)
  }

  {
    const t = U(2026, 8, 3, 19, 0) // 03:00 Tuesday in Shanghai
    const r = w.applyDeliveryWindows(t, [CN])
    eq('apply: 03:00 their time is moved', r.outcome, 'moved')
    eq('apply: to 09:00 the same local morning', r.at, U(2026, 8, 4, 1, 0))
    eq('apply: and keeps the original', r.from, t)
    eq('apply: reported as an opening later the same day', r.reason, 'opensLater')
  }

  {
    const r = w.applyDeliveryWindows(U(2026, 8, 8, 2, 0), [CN])
    eq('apply: a weekend send is reported as landing on another day', r.reason, 'nextOpenDay')
    eq('apply: on Monday morning', r.at, U(2026, 8, 10, 1, 0))
  }

  {
    const r = w.applyDeliveryWindows(U(2026, 8, 4, 2, 0), [])
    eq('apply: no windows changes nothing', r.outcome, 'unchanged')
    eq('apply: and says there were none', r.reason, 'noWindows')
    eq('apply: with no landings', r.perRecipient.length, 0)
  }

  // Two zones that do overlap: Shanghai afternoon meets London morning.
  {
    const t = U(2026, 8, 4, 0, 0)
    const r = w.applyDeliveryWindows(t, [CN, LDN])
    eq('multi: two overlapping zones produce a joint instant', r.outcome, 'moved')
    eq('multi: the first moment that suits both', r.at, U(2026, 8, 4, 8, 0))
    eq('multi: and names the recipient being waited on', r.boundBy, 1)
    eq('multi: every recipient gets a landing', r.perRecipient.length, 2)
    eq('multi: Shanghai could have had it seven hours earlier', r.perRecipient[0].at, U(2026, 8, 4, 1, 0))
    eq('multi: London could not', r.perRecipient[1].at, U(2026, 8, 4, 8, 0))
    ok('multi: so splitting the send is worth offering', r.splitRequired)
    ok('multi: and the joint instant really is inside both windows',
       w.isInsideWindow(r.at, CN) && w.isInsideWindow(r.at, LDN))
  }

  // Two zones that do not. This is the case the whole `perRecipient` shape
  // exists for, and the one that must never be answered by not sending.
  {
    const t = U(2026, 8, 4, 0, 0)
    const AKL = win('Pacific/Auckland', '09:00', '12:00')
    const LAX = win('America/Los_Angeles', '09:00', '12:00')
    const r = w.applyDeliveryWindows(t, [AKL, LAX])
    eq('multi: Auckland and California cannot share a morning', r.outcome, 'impossible')
    eq('multi: and it is reported, not guessed at', r.reason, 'noCommonInstant')
    eq('multi: the send still happens, at its original instant', r.at, t)
    ok('multi: splitting is the way out', r.splitRequired)
    eq('multi: because each of them is reachable alone', r.perRecipient.filter((l) => l.outcome === 'moved').length, 2)
    eq('multi: Auckland gets tomorrow morning', r.perRecipient[0].at, U(2026, 8, 4, 21, 0))
    eq('multi: California gets this afternoon', r.perRecipient[1].at, U(2026, 8, 4, 16, 0))
    ok('multi: and each landing really is inside its own window',
       w.isInsideWindow(r.perRecipient[0].at, AKL) && w.isInsideWindow(r.perRecipient[1].at, LAX))
    // The bound is honest about being a bound.
    eq('multi: the horizon it searched is reported', r.horizonDays, w.DELIVERY_HORIZON_DAYS)
  }

  // The same impossibility without any time zones involved at all.
  {
    const t = U(2026, 8, 4, 0, 0)
    const morning = win('UTC', '09:00', '10:00')
    const afternoon = win('UTC', '14:00', '15:00')
    const r = w.applyDeliveryWindows(t, [morning, afternoon])
    eq('multi: two disjoint windows in one zone are impossible too', r.outcome, 'impossible')
    eq('multi: and the send keeps its instant', r.at, t)
  }

  // A faulty window among good ones constrains nothing and is still reported.
  {
    const t = U(2026, 8, 3, 19, 0)
    const r = w.applyDeliveryWindows(t, [win('Mars/Olympus_Mons', '09:00', '17:00'), CN])
    eq('multi: a broken window still gets a landing', r.perRecipient.length, 2)
    eq('multi: marked as ignored', r.perRecipient[0].outcome, 'ignored')
    eq('multi: with the reason', r.perRecipient[0].reason, 'unknownZone')
    eq('multi: and the good window still applies', r.at, U(2026, 8, 4, 1, 0))
  }

  {
    const t = U(2026, 8, 3, 19, 0)
    const r = w.applyDeliveryWindows(t, [win('UTC', '09:00', '17:00', [])])
    eq('multi: when every window is broken, nothing is held', r.outcome, 'unchanged')
    eq('multi: at the original instant', r.at, t)
    eq('multi: and the fault is named, not hidden behind "no windows"', r.reason, 'neverOpens')
  }
}

// ===========================================================================
// Where this sits relative to quiet hours
// ===========================================================================

{
  // The documented order: quiet hours (the sender's night) first, delivery
  // window (the recipient's day) last, and the window wins.
  //
  // Friday 23:00 Pacific. Quiet hours release it Saturday morning; the London
  // window then holds it until Monday 09:00 London — which is 01:00 Monday for
  // the sender, i.e. squarely back inside their own quiet hours. That is the
  // feature working. If someone ever "fixes" it by re-running quiet hours at
  // the end, this check goes red and the recipient goes back to 03:00 mail.
  const quiet = { enabled: true, start: '22:00', end: '07:00' }
  const LDN = win('Europe/London', '09:00', '17:00')

  const raw = U(2026, 8, 8, 6, 0) // Friday 23:00 in Los Angeles
  ok('order: the send starts inside the sender\'s quiet hours', sched.isQuiet(raw, quiet))

  const afterQuiet = sched.shiftPastQuiet(raw, quiet)
  eq('order: quiet hours release it Saturday 07:00 Pacific', afterQuiet, U(2026, 8, 8, 14, 0))

  const final = w.applyDeliveryWindows(afterQuiet, [LDN]).at
  eq('order: the recipient window then holds it to Monday 09:00 London', final, U(2026, 8, 10, 8, 0))
  ok('order: the result is inside the recipient window', w.isInsideWindow(final, LDN))
  ok('order: even though it is inside the sender\'s night', sched.isQuiet(final, quiet))
  ok(
    'order: re-running quiet hours would move it, which is exactly why they run first',
    sched.applyQuietHours([final], quiet)[0] !== final,
  )
}

// ===========================================================================

await rm(dir, { recursive: true, force: true })

const label = 'a scheduled send lands inside the recipient\'s day, not their night'

if (selftest) {
  if (failures.length === 0) {
    console.log(`\n  ${label}\n  ${checked} checks\n`)
    console.log('  SELFTEST FAILED: the naive wall-clock inversion was re-introduced and nothing went red.\n')
    process.exit(1)
  }
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed on the known-bad version\n`)
  for (const f of failures) console.log(`  RED   ${f}`)
  console.log(`\n  Selftest OK — ${failures.length} checks go red when the DST resolution is removed.\n`)
  process.exit(0)
}

if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
