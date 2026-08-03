/**
 * Do the touch gestures decline to fire when they should?
 *
 * Detecting a swipe is easy; the value is entirely in the refusals. A list that
 * acts on any horizontal drift eats scrolls, and a pull-to-refresh that does
 * not check the scroll position fires halfway down a mailbox. Both are
 * infuriating and neither shows up in a screenshot.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-gestures-'))
const bundle = path.join(dir, 'gestures.mjs')
await build({
  entryPoints: ['src/core/gestures.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { lockAxis, resolveSwipe, dragOffset, resolvePull, PULL_THRESHOLD_PX, SWIPE_FRACTION } =
  await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const PHONE = 400
const TABLET = 1000
const p = (x, y, t) => ({ x, y, t })

// --- axis locking: the refusals -------------------------------------------

check('a tap decides nothing', lockAxis(2, 3) === 'undecided')
check('a clear horizontal drag is horizontal', lockAxis(60, 5) === 'horizontal')
check('a clear vertical drag is vertical', lockAxis(4, 60) === 'vertical')
check('a diagonal drag is refused rather than guessed', lockAxis(40, 38) === 'undecided')
check(
  'a scroll that wanders sideways stays vertical',
  lockAxis(14, 80) === 'vertical',
)
check('movement below the lock threshold is undecided', lockAxis(9, 9) === 'undecided')

// --- swipe: distance is relative to the row --------------------------------

const slowFar = (width, dx) => resolveSwipe(p(200, 0, 0), p(200 + dx, 0, 900), width)

check('a quarter of a phone row is a swipe', slowFar(PHONE, -PHONE * 0.3) === 'trailing')
check(
  'the same pixel count on a tablet is not',
  slowFar(TABLET, -PHONE * 0.3) === null,
)
check('a proportional drag on a tablet is a swipe', slowFar(TABLET, -TABLET * 0.3) === 'trailing')
check('a short slow drag is refused', slowFar(PHONE, -30) === null)
check('direction is reported', slowFar(PHONE, PHONE * 0.3) === 'leading')

// --- swipe: a flick counts even when short ---------------------------------

const flick = (dx, ms) => resolveSwipe(p(200, 0, 0), p(200 + dx, 0, ms), PHONE)
check('a fast short flick fires', flick(-60, 80) === 'trailing')
check('a slow drag the same distance does not', flick(-60, 1200) === null)
check(
  'a fast but tiny movement is still refused (a jittery tap)',
  flick(-20, 20) === null,
)

// --- right-to-left ----------------------------------------------------------

const rtl = (dx) => resolveSwipe(p(200, 0, 0), p(200 + dx, 0, 900), PHONE, true)
check('in RTL a rightward swipe is trailing', rtl(PHONE * 0.3) === 'trailing')
check('in RTL a leftward swipe is leading', rtl(-PHONE * 0.3) === 'leading')
check(
  'RTL is the mirror of LTR, not a different rule',
  rtl(PHONE * 0.3) === slowFar(PHONE, -PHONE * 0.3),
)

// --- drag feedback ----------------------------------------------------------

const limit = PHONE * SWIPE_FRACTION
check('below the threshold the row follows the finger exactly', dragOffset(40, PHONE) === 40)
check(
  'past the threshold it resists rather than stopping dead',
  dragOffset(limit + 100, PHONE) > limit && dragOffset(limit + 100, PHONE) < limit + 100,
)
check('resistance is symmetric', dragOffset(-(limit + 100), PHONE) === -dragOffset(limit + 100, PHONE))

// --- pull to refresh: the refusal that matters most -------------------------

check(
  'pulling down at the top arms once past the threshold',
  resolvePull(PULL_THRESHOLD_PX, 0).armed === true,
)
check('a short pull does not arm', resolvePull(20, 0).armed === false)
check('but it does show progress, so the gesture feels alive', resolvePull(20, 0).progress > 0)
check(
  'pulling while scrolled down does nothing at all',
  resolvePull(200, 350).armed === false && resolvePull(200, 350).progress === 0,
)
check('pushing up never arms', resolvePull(-100, 0).armed === false)
check('progress is clamped', resolvePull(10_000, 0).progress === 1)

// ---------------------------------------------------------------------------

const label = 'touch gestures decline when they should'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
