/**
 * Does "why this time?" ever say something the scheduler would not do?
 *
 * `core/schedule/occurrenceExplain.ts`'s whole reason to exist is that it must never
 * drift from the real pipeline `state/AppState.tsx`'s `shapeOccurrences`
 * runs before a job is armed — working calendar, then quiet hours, then a
 * recipient's delivery window. So most of what is checked below is not "is
 * this timestamp right" (that is `check:workcal`'s, `check:upcoming`'s and
 * `check:window`'s job, against the same underlying functions) but "does
 * `explainNextOccurrence`'s `finalAt` and step chain agree, exactly, with
 * calling `applyWorkCalendarDetailed` → `applyQuietHours` →
 * `applyDeliveryWindows` by hand on the same inputs" — the two are computed
 * independently in this file and compared, so a future edit that lets them
 * diverge fails loudly here rather than showing a confident, wrong sentence
 * on the compose screen.
 *
 * The rest covers the shape rules the header comment on the source file
 * promises: jitter never moves `to`; a calendar `skip`-through does not
 * fabricate a `workCalendar` step for an occurrence the calendar never
 * touched; a job with nothing adjusted reports zero steps, not a chain of
 * no-ops; and three different ways there can be no next occurrence at all
 * are each reported as `hasNext: false` rather than a made-up timestamp.
 *
 * Exit code 1 if anything needs attention.
 */

// Pinned so the delivery-window scenario has a known, *different* zone to
// compare against — the same reason `check-delivery-window.mjs` does this.
process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-occurrence-explain-'))

// One entry re-exporting all four modules, so this script can call
// `explainNextOccurrence` and, side by side, the exact real functions it
// wraps — the only way to prove the two never disagree.
const entry = path.join(dir, 'entry.ts')
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(path.join(root, 'src/core/schedule/occurrenceExplain.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/core/schedule/schedule.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/core/schedule/workCalendar.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/core/schedule/deliveryWindow.ts'))};`,
  ].join('\n'),
)

const bundle = path.join(dir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})

const {
  explainNextOccurrence,
  computeOccurrences,
  applyWorkCalendarDetailed,
  applyQuietHours,
  applyDeliveryWindows,
  DEFAULT_WORK_CALENDAR,
} = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const HOUR = 3_600_000
const DAY = 86_400_000
// A Monday, mid-morning — same reference instant `check-upcoming.mjs` uses,
// so a failure here and a failure there are easy to correlate.
const NOW = new Date(2026, 7, 3, 10, 0, 0).getTime()

const BASE_RULE = {
  monthDayFallback: 'last',
  endMode: 'never',
  jitterSeconds: 0,
  skipWeekends: false,
  catchUp: 'fireOnce',
}

const daily = (overrides = {}) => ({
  ...BASE_RULE,
  kind: 'daily',
  startAt: NOW,
  timeOfDay: '09:00',
  ...overrides,
})

const once = (overrides = {}) => ({
  ...BASE_RULE,
  kind: 'once',
  startAt: NOW + HOUR,
  timeOfDay: '10:00',
  ...overrides,
})

const NO_QUIET = { enabled: false, start: '00:00', end: '00:00' }

/**
 * The same three rewrites `explainNextOccurrence` wraps, run by hand on
 * whatever raw occurrence list the caller already has — the independent
 * half of every cross-check below.
 */
function shapeByHand(occurrences, rec, calendar, quiet, windows) {
  const detailed = applyWorkCalendarDetailed(occurrences, rec.workdayPolicy ?? 'off', calendar, NOW)
  const quieted = applyQuietHours(detailed.occurrences, quiet)
  const delivered =
    windows.length === 0 ? quieted : quieted.map((at) => applyDeliveryWindows(at, windows).at)
  return { detailed, quieted, delivered }
}

// --- never drift: cross-check against the real pipeline, by hand ------------

function crossCheck(label, rec, opts) {
  const calendar = opts.calendar ?? DEFAULT_WORK_CALENDAR
  const quiet = opts.quiet ?? NO_QUIET
  const windows = opts.windows ?? []

  const raw = computeOccurrences(rec, { runsSoFar: opts.runsSoFar, count: 24, after: NOW, calendar })
  const explanation = explainNextOccurrence(rec, { now: NOW, calendar, quiet, windows, runsSoFar: opts.runsSoFar })

  if (raw.length === 0) {
    check(`${label}: no raw candidates means hasNext is false`, explanation.hasNext === false)
    return explanation
  }

  const { detailed, delivered } = shapeByHand(raw, rec, calendar, quiet, windows)

  if (detailed.occurrences.length === 0) {
    check(`${label}: calendar consuming every candidate means hasNext is false`, explanation.hasNext === false)
    return explanation
  }

  check(`${label}: hasNext is true when the pipeline produces something`, explanation.hasNext === true)
  check(
    `${label}: finalAt matches applyWorkCalendarDetailed → applyQuietHours → applyDeliveryWindows exactly`,
    explanation.finalAt === delivered[0],
  )

  const afterCalendar = detailed.occurrences[0]
  const movedEntry = detailed.adjustment.moved.find((m) => m.to === afterCalendar)
  const expectedOriginal = movedEntry ? movedEntry.from : afterCalendar
  check(`${label}: originalAt matches the calendar's own moved-from record`, explanation.originalAt === expectedOriginal)

  // The deterministic part of the chain (everything but `jitter`) must walk
  // continuously from originalAt to finalAt-before-jitter, in pipeline order.
  const deterministic = explanation.steps.filter((s) => s.kind !== 'jitter')
  const order = ['workCalendar', 'quietHours', 'deliveryWindow']
  check(
    `${label}: deterministic steps are in pipeline order`,
    deterministic.every((s, i) => i === 0 || order.indexOf(s.kind) >= order.indexOf(deterministic[i - 1].kind)),
  )
  let cursor = explanation.originalAt
  for (const step of deterministic) {
    check(`${label}: step "${step.kind}" continues from the previous instant`, step.from === cursor)
    cursor = step.to
  }
  check(`${label}: the chain ends at finalAt`, cursor === explanation.finalAt)

  const jitterStep = explanation.steps.find((s) => s.kind === 'jitter')
  if (rec.jitterSeconds > 0) {
    check(`${label}: jitter configured means a jitter step is present`, jitterStep !== undefined)
    if (jitterStep) {
      check(`${label}: jitter never moves the alarm (from === to)`, jitterStep.from === jitterStep.to)
      check(`${label}: jitter step sits at finalAt`, jitterStep.to === explanation.finalAt)
      check(`${label}: jitter step reports the configured ceiling`, jitterStep.jitterSeconds === rec.jitterSeconds)
    }
  } else {
    check(`${label}: no jitter configured means no jitter step`, jitterStep === undefined)
  }
  check(
    `${label}: jitter is always the last step, when present`,
    jitterStep === undefined || explanation.steps[explanation.steps.length - 1] === jitterStep,
  )

  return explanation
}

// A plain daily rule, nothing configured to move it.
crossCheck('plain daily, nothing configured', daily(), {})

// The working calendar moving an occurrence off a holiday.
const HOLIDAY_CAL = { weekend: [0, 6], holidays: ['2026-08-04'], workdays: [] }
crossCheck('workdayPolicy: after, onto a holiday', daily({ workdayPolicy: 'after' }), { calendar: HOLIDAY_CAL })
crossCheck('workdayPolicy: before, onto a holiday', daily({ workdayPolicy: 'before' }), { calendar: HOLIDAY_CAL })

// The calendar skipping straight past a holiday to find the next occurrence.
{
  const rec = daily({ workdayPolicy: 'skip' })
  // Sanity on the fixture itself: Aug 4 2026 (the holiday) really is the
  // candidate that gets skipped, not some other day the test would still
  // pass against by accident.
  const raw = computeOccurrences(rec, { count: 24, after: NOW, calendar: HOLIDAY_CAL })
  check('the fixture actually lands its first raw candidate on the holiday', raw[0] === new Date(2026, 7, 4, 9, 0, 0).getTime())

  const explanation = crossCheck('workdayPolicy: skip, onto a holiday', rec, { calendar: HOLIDAY_CAL })
  check(
    'the surviving occurrence was never itself moved, so there is no workCalendar step',
    explanation.steps.every((s) => s.kind !== 'workCalendar'),
  )
  check(
    'originalAt is the surviving day, not the skipped holiday',
    explanation.originalAt === new Date(2026, 7, 5, 9, 0, 0).getTime(),
  )
}

// workdayPolicy 'off' must ignore the calendar entirely, even on a holiday.
crossCheck('workdayPolicy: off, ignores the same holiday', daily({ workdayPolicy: 'off' }), {
  calendar: HOLIDAY_CAL,
})

// Quiet hours holding a 02:00 send.
crossCheck('quiet hours over a 02:00 daily send', daily({ timeOfDay: '02:00' }), {
  quiet: { enabled: true, start: '22:00', end: '07:00' },
})

// Jitter alone — never moves finalAt, always trails the chain.
crossCheck('jitter only', daily({ jitterSeconds: 45 }), {})

// Calendar + quiet + jitter together, to prove pipeline order end to end.
crossCheck('calendar, quiet hours and jitter together', daily({ timeOfDay: '02:00', workdayPolicy: 'after', jitterSeconds: 20 }), {
  calendar: HOLIDAY_CAL,
  quiet: { enabled: true, start: '22:00', end: '07:00' },
})

// A recipient's delivery window doing the actual moving.
const TOKYO_WORK_HOURS = { timeZone: 'Asia/Tokyo', from: '09:00', to: '18:00', days: [1, 2, 3, 4, 5] }
const tokyoExplanation = crossCheck('a Tokyo delivery window moves it', daily({ timeOfDay: '09:00' }), {
  windows: [TOKYO_WORK_HOURS],
})

// --- delivery-window specific shape ------------------------------------------

{
  const deliveryStep = tokyoExplanation.steps.find((s) => s.kind === 'deliveryWindow')
  check('a delivery-window move produces a deliveryWindow step', deliveryStep !== undefined)
  if (deliveryStep) {
    check('the step names the recipient that bound it (index 0, the only one)', deliveryStep.recipientIndex === 0)
  }
}

// A window nobody can be reached in (`days: []`, a fault this codebase calls
// `neverOpens`) must be ignored, not reported as a move.
{
  const faulty = { timeZone: 'Asia/Tokyo', from: '09:00', to: '18:00', days: [] }
  const explanation = explainNextOccurrence(daily({ timeOfDay: '09:00' }), {
    now: NOW,
    windows: [faulty],
  })
  check(
    'a faulty delivery window produces no deliveryWindow step',
    explanation.steps.every((s) => s.kind !== 'deliveryWindow'),
  )
}

// Two recipients: only the one that actually binds the cursor is named.
{
  const alreadyInside = { timeZone: 'America/Los_Angeles', from: '00:00', to: '24:00', days: [0, 1, 2, 3, 4, 5, 6] }
  const explanation = explainNextOccurrence(daily({ timeOfDay: '09:00' }), {
    now: NOW,
    windows: [alreadyInside, TOKYO_WORK_HOURS],
  })
  const deliveryStep = explanation.steps.find((s) => s.kind === 'deliveryWindow')
  check('with two windows, the one that actually moved the cursor is named', deliveryStep?.recipientIndex === 1)
}

// --- "one line, not an empty chain of no-ops" --------------------------------

{
  const explanation = explainNextOccurrence(daily(), { now: NOW })
  check('nothing configured means zero steps', explanation.steps.length === 0)
  check('and originalAt equals finalAt', explanation.originalAt === explanation.finalAt)
}

// --- three ways there can be no next occurrence ------------------------------

{
  // A one-off whose only instant has already passed.
  const explanation = explainNextOccurrence(once({ startAt: NOW - DAY, timeOfDay: '09:00' }), { now: NOW })
  check('a one-off that already fired has no next occurrence', explanation.hasNext === false)
}

{
  // An afterCount rule that has already used up every run.
  const explanation = explainNextOccurrence(
    daily({ endMode: 'afterCount', maxRuns: 3 }),
    { now: NOW, runsSoFar: 3 },
  )
  check('an afterCount rule with no runs left has no next occurrence', explanation.hasNext === false)
}

{
  // A calendar that calls every single day a day off, so `workdayPolicy:
  // 'after'` can never find a working day to shift onto — every one of the
  // 24 candidates this function searches is dropped, not just skipped.
  const noWorkingDayEver = { weekend: [0, 1, 2, 3, 4, 5, 6], holidays: [], workdays: [] }
  const explanation = explainNextOccurrence(daily({ workdayPolicy: 'after' }), {
    now: NOW,
    calendar: noWorkingDayEver,
  })
  check('a calendar with no working day at all has no next occurrence', explanation.hasNext === false)
}

// --- purity: nothing here is allowed to mutate what it was handed -----------

{
  const rec = Object.freeze(daily({ workdayPolicy: 'after', jitterSeconds: 10 }))
  const calendar = Object.freeze({ ...HOLIDAY_CAL })
  const quiet = Object.freeze({ enabled: true, start: '22:00', end: '07:00' })
  const windows = Object.freeze([Object.freeze({ ...TOKYO_WORK_HOURS })])
  let threw = false
  try {
    explainNextOccurrence(rec, { now: NOW, calendar, quiet, windows })
  } catch {
    threw = true
  }
  check('explainNextOccurrence does not mutate frozen inputs', threw === false)
}

// ---------------------------------------------------------------------------

const label = 'the schedule simulator\'s "why this time?" chain agrees with the real pipeline'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
