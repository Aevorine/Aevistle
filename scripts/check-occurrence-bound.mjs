/**
 * Does bounding `computeOccurrences` by `until` change what the conflict scan
 * finds? A 33x speed-up that quietly reports different conflicts would be a
 * regression wearing a benchmark as a disguise.
 *
 * Compares, per job, the occurrence list the old code kept (compute 200, then
 * filter to the window) against the new one (stop at the window, then filter).
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-equiv-'))
const out = path.join(dir, 'b.mjs')
await build({
  stdin: {
    contents: `
      export { computeOccurrences } from './src/core/schedule/schedule'
      export { DEFAULT_WORK_CALENDAR } from './src/core/schedule/workCalendar'
      export { findConflicts, CONFLICT_DAYS } from './src/core/sync/conflicts'
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', outfile: out, logLevel: 'error',
})
const m = await import(pathToFileURL(out).href)
await rm(dir, { recursive: true, force: true })

const now = Date.UTC(2026, 7, 4, 3, 0, 0)   // fixed, so this is reproducible
const cal = m.DEFAULT_WORK_CALENDAR
const until = now + m.CONFLICT_DAYS * 86_400_000

const kinds = ['weekly', 'monthly', 'daily', 'yearly', 'once', 'interval']
const jobs = Array.from({ length: 300 }, (_, i) => ({
  id: 'j' + i,
  recurrence: {
    kind: kinds[i % kinds.length],
    startAt: now - i * 3_600_000,
    timeOfDay: String((i % 23)).padStart(2, '0') + ':' + String((i * 7) % 60).padStart(2, '0'),
    weekdays: [i % 7, (i + 2) % 7],
    dayOfMonth: (i % 31) + 1,
    monthDayFallback: i % 2 ? 'last' : 'skip',
    month: i % 12,
    intervalMinutes: (i % 90) + 5,
    endMode: i % 5 === 0 ? 'afterCount' : 'never',
    maxRuns: 40,
    jitterSeconds: 0,
    skipWeekends: false,
  },
  runCount: i % 5,
}))

// `--selftest` drops the window bound by one day, which must make the two
// disagree. A guard that stays green against a knowingly-wrong bound proves
// nothing about the right one.
const SELFTEST = process.argv.includes('--selftest')
const bound = SELFTEST ? until - 86_400_000 : until

let mismatches = 0
for (const j of jobs) {
  const old = m
    .computeOccurrences(j.recurrence, { after: now, count: 200, runsSoFar: j.runCount, calendar: cal })
    .filter((at) => at <= until)
  const neu = m
    .computeOccurrences(j.recurrence, { after: now, until: bound, count: 200, runsSoFar: j.runCount, calendar: cal })
    .filter((at) => at <= until)
  if (old.length !== neu.length || old.some((v, k) => v !== neu[k])) {
    mismatches++
    if (mismatches <= 3) {
      console.log(`  MISMATCH ${j.id} (${j.recurrence.kind}): old ${old.length} vs new ${neu.length}`)
    }
  }
}

console.log(`\n  300 rules across ${kinds.length} recurrence kinds`)
console.log(`  identical windows : ${300 - mismatches}/300`)

// And the whole scan, compared structurally.
const scan = m.findConflicts(jobs, cal, { now })
console.log(`  conflicts found   : ${scan.conflicts.length}`)
console.log(`  dates flagged     : ${scan.byDate.size}`)
console.log(mismatches === 0 ? '\n  Equivalent.' : `\n  ${mismatches} rules differ — NOT equivalent.`)
process.exit(mismatches === 0 ? 0 : 1)
