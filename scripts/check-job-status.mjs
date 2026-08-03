/**
 * Does a finished send actually reach the schedule row?
 *
 * For four releases it did not. The scheduler updated `status`, `runCount`,
 * `lastRunAt` and `lastResult` on its own copy of the job and emitted
 * `jobUpdated`; nothing in the codebase listened to `jobUpdated`; and the
 * renderer's `onJobEvent` handler wrote an activity-log line and touched
 * nothing else. So the mail went out, the log said "Scheduled send completed",
 * and the row kept displaying the status it was created with — "waiting to
 * send" — permanently.
 *
 * Two quieter consequences of the same break, both checked below:
 *   - `runCount` never left 0, so an "after N sends" end condition could never
 *     come true and a bounded schedule sent forever;
 *   - `lastRunAt` / `lastResult` never left empty, so send conditions that ask
 *     about the previous run were reading values that never changed.
 *
 * Half of this is behavioural (the merge function is executed) and half is
 * structural (the wiring between processes cannot be executed from here, so it
 * is asserted to exist). The structural half is the weaker kind of check and is
 * kept narrow on purpose: it names the exact seam that was broken, not the
 * shape of the code around it.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

const failures = []
const fail = (what) => failures.push(what)
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) fail(what)
}

// ---------------------------------------------------------------------------
// 1. Behaviour: the merge itself
// ---------------------------------------------------------------------------

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-jobrun-'))
const bundle = path.join(dir, 'jobRun.mjs')
await build({
  entryPoints: ['src/core/jobRun.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const module = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const pending = {
  id: 'job_1',
  runCount: 0,
  status: 'armed',
  occurrences: [1000, 2000],
  updatedAt: 111,
  draft: { subject: 'x' },
}

const afterOk = module.applyRun(pending, {
  runCount: 1,
  lastRunAt: 1500,
  lastResult: 'ok',
  status: 'done',
  occurrences: [],
})

check('a successful run must leave the job out of "armed"', afterOk.status === 'done')
check('a successful run must raise runCount', afterOk.runCount === 1)
check('a successful run must record lastRunAt', afterOk.lastRunAt === 1500)
check('a successful run must record lastResult', afterOk.lastResult === 'ok')
check('a successful run must consume the occurrence', afterOk.occurrences.length === 0)
check('a run must not bump updatedAt (it would re-arm the alarm)', afterOk.updatedAt === 111)
check('a run must not disturb the draft', afterOk.draft.subject === 'x')
check('the finished job must report as finished', module.isFinished(afterOk) === true)

const afterFail = module.applyRun(pending, {
  runCount: 1,
  lastRunAt: 1500,
  lastResult: 'failed',
  lastError: 'nope',
  status: 'failed',
  occurrences: [2000],
})
check('a failed run must say failed, not armed', afterFail.status === 'failed')
check('a failed run must keep the error', afterFail.lastError === 'nope')
check('a failed job is not finished', module.isFinished(afterFail) === false)

// Redelivery: Android hands the same report over again if it crashes between
// draining the queue and clearing it. Absolute assignment makes that a no-op;
// an incremental `runCount += 1` would double-count.
const twice = module.applyRun(
  module.applyRun(pending, { runCount: 1, lastRunAt: 1500, lastResult: 'ok', status: 'done', occurrences: [] }),
  { runCount: 1, lastRunAt: 1500, lastResult: 'ok', status: 'done', occurrences: [] },
)
check('applying the same report twice must not double-count', twice.runCount === 1)

// ---------------------------------------------------------------------------
// 2. Structure: the seams between processes
// ---------------------------------------------------------------------------

const scheduler = read('electron/scheduler.ts')
const emits = scheduler.match(/this\.emit\('jobEvent',[^)]*\)/g) ?? []
check('the scheduler must emit at least the send and skip paths', emits.length >= 2)
check(
  'every jobEvent the scheduler emits must carry the run bookkeeping',
  emits.length > 0 && emits.every((e) => /\brun:/.test(e)),
)

const appState = read('src/state/AppState.tsx')
check(
  "the renderer's job-event handler must dispatch jobRan, not only write a log line",
  /onJobEvent\([\s\S]{0,600}?dispatch\(\{\s*type:\s*'jobRan'/.test(appState),
)
check("the reducer must handle 'jobRan'", /case 'jobRan'/.test(appState))
check(
  'the reducer must merge through applyRun so this file is what guards it',
  /case 'jobRan'[\s\S]{0,400}?applyRun\(/.test(appState),
)
check(
  'the renderer must drain runs that happened while it was closed',
  /pullJobRuns/.test(appState),
)

const plugin = read('android/app/src/main/java/dev/aevistle/app/AevistleNativePlugin.java')
check('the Android plugin must expose pullJobRuns', /public void pullJobRuns\(/.test(plugin))

const store = read('android/app/src/main/java/dev/aevistle/app/JobStore.java')
check('Android must queue a run report for the web layer', /queueRun\(/.test(store))
check('Android must drain that queue', /JSONArray drainRuns\(\)/.test(store))
check(
  'Android must not report a fired one-off as still armed',
  /"once"\.equals\(recurrenceKind\(job\)\)/.test(store),
)

// ---------------------------------------------------------------------------

const label = 'send status reaches the schedule row'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
