/**
 * The gate on three small modules that all fail the same way: quietly, and
 * only at scale.
 *
 *   - `core/mail/syncLimit.ts` caps how many mailboxes are talked to at once.
 *     Its whole reason to exist is a five-account install, so a bug in it is
 *     invisible on the one- and two-account setups anybody develops against.
 *     It also replaces `Promise.all` at two call sites specifically to stop one
 *     unreachable account discarding four good answers — a behaviour that is
 *     indistinguishable from "the refresh failed" unless something asserts it.
 *
 *   - `core/ops/syncHealth.ts` decides when a *run* of failures is worth a
 *     notification. Both halves of it are about not being annoying, and both
 *     are the kind of off-by-one that ships: a threshold that fires on the
 *     first blip trains people to ignore it, and a missing cooldown re-fires
 *     every five minutes for as long as the account stays broken.
 *
 *   - `core/mail/dayGroups.ts` decides where "Today" ends. Every bug in it is a
 *     timezone bug, which means it is correct on the developer's machine by
 *     construction and wrong for half the planet.
 *
 * `--selftest` widens the failure threshold to 1 and requires this to go red.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const selftest = process.argv.includes('--selftest')

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const out = mkdtempSync(join(tmpdir(), 'aevistle-synclimit-'))
const bundle = (src, name) => {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, src)}"`,
      '--bundle',
      '--format=esm',
      `--outfile="${join(out, name)}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
}

try {
  bundle('src/core/mail/syncLimit.ts', 'limit.mjs')
  bundle('src/core/ops/syncHealth.ts', 'health.mjs')
  bundle('src/core/mail/dayGroups.ts', 'days.mjs')
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { runLimited, fastestFirst, DEFAULT_SYNC_CONCURRENCY } = await import(
  pathToFileURL(join(out, 'limit.mjs')).href
)
const { recordSync, shouldAlert, markAlerted, FAILURE_ALERT_THRESHOLD, FAILURE_ALERT_COOLDOWN_MS } =
  await import(pathToFileURL(join(out, 'health.mjs')).href)
const { dayLabel, daysBetween, flattenByDay, groupByDay, startOfDay } = await import(
  pathToFileURL(join(out, 'days.mjs')).href
)

// --- the limiter ------------------------------------------------------------

check('the default is more than one, or it is not parallel at all', DEFAULT_SYNC_CONCURRENCY > 1)
check('and small enough to leave a phone some CPU', DEFAULT_SYNC_CONCURRENCY <= 4)

{
  /*
   * The measurement that matters: not "did they all finish" but "how many were
   * ever running at once". A limiter that awaits each task in turn also passes
   * a completion test, and would be four times slower.
   */
  let live = 0
  let peak = 0
  const task = () => async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 5))
    live--
    return 1
  }
  const results = await runLimited(Array.from({ length: 12 }, task), 3)
  check('every task ran', results.length === 12 && results.every((r) => r.ok))
  check('never more than the limit at once', peak <= 3)
  check('and it did actually run them in parallel', peak === 3)
}

{
  const order = []
  const results = await runLimited(
    [
      async () => {
        order.push('a')
        return 'a'
      },
      async () => {
        throw new Error('boom')
      },
      async () => {
        order.push('c')
        return 'c'
      },
    ],
    2,
  )
  check('a task that throws does not reject the whole batch', results.length === 3)
  check('the thrower is marked failed in its own slot', results[1].ok === false)
  check('and its neighbours keep their values, in order', results[0].value === 'a' && results[2].value === 'c')
  check('the other tasks still ran', order.join() === 'a,c')
}

check('an empty list is not an error', (await runLimited([], 3)).length === 0)
check(
  'a nonsense limit still runs everything, one at a time',
  (await runLimited([async () => 1, async () => 2], 0)).length === 2,
)

check(
  'the fastest account goes first',
  fastestFirst([{ n: 'slow', d: 30_000 }, { n: 'fast', d: 400 }], (x) => x.d)
    .map((x) => x.n)
    .join() === 'fast,slow',
)
check(
  'an account that has never synced is not punished for it',
  fastestFirst([{ n: 'new' }, { n: 'known', d: 400 }], (x) => x.d)
    .map((x) => x.n)
    .join() === 'new,known',
)

// --- the failure run --------------------------------------------------------

check('the threshold is past a transient blip', FAILURE_ALERT_THRESHOLD >= (selftest ? 99 : 3))
check('the cooldown is hours, not minutes', FAILURE_ALERT_COOLDOWN_MS >= 60 * 60_000)

{
  let run = recordSync(undefined, false)
  check('one failure does not alert', shouldAlert(run, 0) === false)
  run = recordSync(run, false)
  check('two failures do not alert', shouldAlert(run, 0) === false)
  run = recordSync(run, false)
  check('three in a row do', shouldAlert(run, 0) === true)

  const alerted = markAlerted(run, 1_000)
  check('and it does not alert again straight away', shouldAlert(recordSync(alerted, false), 2_000) === false)
  check(
    'but does again once the cooldown is over',
    shouldAlert(recordSync(alerted, false), 1_000 + FAILURE_ALERT_COOLDOWN_MS + 1) === true,
  )

  /*
   * A success has to clear `alertedAt` as well as the count. An account that
   * recovered on Monday and broke again on Friday is a new problem, and
   * leaving the old timestamp behind would swallow the first alert for it.
   */
  const recovered = recordSync(alerted, true)
  check('a success clears the count', recovered.count === 0)
  check('a success clears the cooldown too', recovered.alertedAt === undefined)
  const brokeAgain = [recovered, null, null].reduce((r) => recordSync(r, false), recovered)
  check('so a fresh run of three alerts immediately', shouldAlert(brokeAgain, 3_000) === true)
}

// --- the day separators -----------------------------------------------------

/*
 * The bug this file exists to prevent, stated as a test: midnight is a local
 * concept. `Math.floor(at / 86400000) * 86400000` is midnight UTC, which puts
 * a 22:00 message into tomorrow's group for anyone east of Greenwich.
 */
{
  const late = new Date(2026, 7, 20, 22, 30, 0).getTime()
  const alsoToday = new Date(2026, 7, 20, 1, 15, 0).getTime()
  check('22:30 and 01:15 on the same local date group together', startOfDay(late) === startOfDay(alsoToday))
  check('start of day is actually midnight local', new Date(startOfDay(late)).getHours() === 0)
}

{
  const now = new Date(2026, 7, 20, 12, 0, 0).getTime()
  const today = new Date(2026, 7, 20, 8, 0, 0).getTime()
  const yesterday = new Date(2026, 7, 19, 23, 30, 0).getTime()
  const threeDays = new Date(2026, 7, 17, 9, 0, 0).getTime()
  const longAgo = new Date(2026, 6, 1, 9, 0, 0).getTime()

  check('today is today', dayLabel(today, now).kind === 'today')
  check('yesterday is yesterday even at 23:30', dayLabel(yesterday, now).kind === 'yesterday')
  check('three days back is a weekday name', dayLabel(threeDays, now).kind === 'weekday')
  check('a month back is a date', dayLabel(longAgo, now).kind === 'date')
  check('a message dated in the future reads as today, not as a negative day', dayLabel(now + 3_600_000, now).kind === 'today')
  check('whole days, not 24-hour chunks', daysBetween(now, yesterday) === 1)

  const items = [{ at: today }, { at: today - 3_600_000 }, { at: yesterday }, { at: threeDays }]
  const groups = groupByDay(items, (x) => x.at, now)
  check('three days produce three groups', groups.length === 3)
  check('the two from today share one', groups[0].items.length === 2)
  check('the group key is stable across the items in it', groups[0].key === startOfDay(today))

  const rows = flattenByDay(items, (x) => x.at, now)
  check('flattening emits one separator per group plus every item', rows.length === 3 + 4)
  check('the first row is a separator', rows[0].type === 'separator')
  check('a separator carries its own count', rows[0].count === 2)
  check('an empty list produces no rows at all', flattenByDay([], (x) => x.at, now).length === 0)

  /*
   * Grouping must not re-sort. The order on screen is the order the user
   * picked, and silently overriding it would be a sort nobody asked for
   * appearing as a side effect of a cosmetic feature.
   */
  const scrambled = [{ at: today }, { at: threeDays }, { at: today }]
  check(
    'an unsorted list is grouped, not sorted',
    groupByDay(scrambled, (x) => x.at, now).length === 3,
  )
}

// ---------------------------------------------------------------------------

rmSync(out, { recursive: true, force: true })

const label = 'sync fan-out, failure runs and day separators behave at scale'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  const caught = failures.some((f) => f === 'the threshold is past a transient blip')
  if (!caught) {
    console.log('\n  SELFTEST FAILED: a too-eager alert threshold was not caught.\n')
    process.exit(1)
  }
  console.log('\n  Selftest OK — the injected fault was caught.\n')
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
