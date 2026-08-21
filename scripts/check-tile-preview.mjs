/**
 * Do the numbers on a Home tile's preview mean what they say?
 *
 * The preview panel exists to save a screen transition: hold a tile and read
 * "3 个定时已就绪" instead of opening the schedule to find out. That trade is
 * only worth making if the figure is right, and a wrong figure here is worse
 * than no panel at all — it is a confident answer nobody will go and check.
 *
 * `buildTilePreview` is a pure function of `AppState`, so this asks it directly
 * rather than through a rendered screen. Four properties, each of which has a
 * plausible wrong implementation that would look fine on screen:
 *
 *   - "today" is a calendar day, not `now + 86400000`. A send at 23:00 is due
 *     today and a send at 00:30 tomorrow is not, and the arithmetic version
 *     gets both wrong every day of the year.
 *   - a paused schedule is not armed. `state.jobs.length` is the count that is
 *     easy to reach for and it counts reminders that will never fire.
 *   - the next fire is the soonest across *all* jobs, not the first job's.
 *   - a tile with no case answers "nothing", not a panel of empty lines.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-tilepreview-'))
const bundle = path.join(dir, 'tilePreview.mjs')
await build({
  entryPoints: ['src/core/home/tilePreview.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { buildTilePreview } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const HOUR = 3_600_000
/** A Tuesday, 10:00 local, so "later today" and "tomorrow" are unambiguous. */
const NOW = new Date(2026, 7, 4, 10, 0, 0).getTime()
/** 23:30 the same calendar day — the case `now + 86400000` gets right by accident. */
const LATE_TODAY = new Date(2026, 7, 4, 23, 30, 0).getTime()
/** 00:30 the next calendar day — 14 hours away, and not today. */
const EARLY_TOMORROW = new Date(2026, 7, 5, 0, 30, 0).getTime()

const job = (over = {}) => ({
  id: over.id ?? 'j1',
  name: 'r',
  enabled: true,
  draft: { to: [], subject: '', body: '' },
  recurrence: { kind: 'once', startAt: NOW, timeOfDay: '10:00', catchUp: 'skip' },
  occurrences: [],
  runCount: 0,
  retry: {},
  status: 'idle',
  ...over,
})

const base = {
  accounts: [],
  jobs: [],
  contacts: [],
  templates: [],
  logs: [],
  settings: { digestEnabled: false, greetingCountry: 'CN', calendarSubscribeEnabled: false },
  draft: {},
  inboxAccounts: [],
  draftSnapshots: [],
  outbox: [],
  codeHits: [],
  recentRecipients: [],
  pairedDevices: [],
  syncConflicts: [],
  deletedJobs: [],
  schemaVersion: 1,
}
const withJobs = (jobs) => ({ ...base, jobs })
const valueOf = (p, key) => p.lines.find((l) => l.key === key)?.values?.n

// --- "today" is a calendar day ----------------------------------------------

const late = buildTilePreview('schedule', withJobs([job({ occurrences: [LATE_TODAY] })]), NOW)
check('a send at 23:30 tonight counts as due today', valueOf(late, 'preview.schedule.today') === 1)

const tomorrow = buildTilePreview(
  'schedule',
  withJobs([job({ occurrences: [EARLY_TOMORROW] })]),
  NOW,
)
check(
  'a send at 00:30 tomorrow does not count as due today',
  tomorrow.lines.every((l) => l.key !== 'preview.schedule.today'),
)
check(
  'and it is still reported as the next send',
  tomorrow.lines.some((l) => l.key === 'preview.schedule.next'),
)

// --- paused is not armed -----------------------------------------------------

const mixed = buildTilePreview(
  'schedule',
  withJobs([
    job({ id: 'a', enabled: true, occurrences: [NOW + HOUR] }),
    job({ id: 'b', enabled: false, occurrences: [NOW + HOUR] }),
    job({ id: 'c', enabled: false, occurrences: [NOW + HOUR] }),
  ]),
  NOW,
)
check('two paused reminders are not counted as armed', valueOf(mixed, 'preview.schedule.armed') === 1)
check('and only the enabled one is due today', valueOf(mixed, 'preview.schedule.today') === 1)

const allPaused = buildTilePreview(
  'schedule',
  withJobs([job({ enabled: false, occurrences: [NOW + HOUR] })]),
  NOW,
)
check('with nothing armed, the paused count is what is reported', valueOf(allPaused, 'preview.schedule.paused') === 1)

// --- the next fire is the soonest across every job ---------------------------

const several = buildTilePreview(
  'schedule',
  withJobs([
    job({ id: 'a', occurrences: [NOW + 5 * HOUR] }),
    job({ id: 'b', occurrences: [NOW + 1 * HOUR] }),
    job({ id: 'c', occurrences: [NOW + 9 * HOUR] }),
  ]),
  NOW,
)
const nextAt = Number(several.lines.find((l) => l.key === 'preview.schedule.next')?.values?.at)
check('the next send is the soonest of all of them, not the first listed', nextAt === NOW + HOUR)

const past = buildTilePreview(
  'schedule',
  withJobs([job({ occurrences: [NOW - 5 * HOUR, NOW + 2 * HOUR] })]),
  NOW,
)
check(
  'an occurrence already in the past is skipped',
  Number(past.lines.find((l) => l.key === 'preview.schedule.next')?.values?.at) === NOW + 2 * HOUR,
)

// --- today's log figures --------------------------------------------------

const logs = buildTilePreview(
  'logs',
  {
    ...base,
    logs: [
      { at: LATE_TODAY, kind: 'send', level: 'info' },
      { at: NOW - HOUR, kind: 'send', level: 'info' },
      { at: NOW - HOUR, kind: 'send', level: 'error' },
      { at: EARLY_TOMORROW - 26 * HOUR, kind: 'send', level: 'info' },
    ],
  },
  NOW,
)
check("today's sends exclude yesterday's", valueOf(logs, 'preview.logs.sentToday') === 2)
check('a failed send is not also counted as sent', valueOf(logs, 'preview.logs.failedToday') === 1)

// --- the empty case is a state, not an absence -------------------------------

const nothing = buildTilePreview('schedule', base, NOW)
check('an install with no schedules still says something', nothing.lines.length > 0)
check('and is flagged as the quiet case', nothing.empty === true)

const busy = buildTilePreview('schedule', withJobs([job({ occurrences: [NOW + HOUR] })]), NOW)
check('a real figure is not flagged quiet', busy.empty === false)

const unknown = buildTilePreview('compose', base, NOW)
check('a tile with no case draws no panel at all', unknown.lines.length === 0 && unknown.empty === true)

// --- a preview never becomes a screen ----------------------------------------

for (const id of ['schedule', 'contacts', 'templates', 'logs', 'workcal', 'reliability', 'pairing']) {
  const p = buildTilePreview(id, withJobs([job({ occurrences: [NOW + HOUR] })]), NOW)
  check(`${id} says at most three things`, p.lines.length <= 3)
  check(`${id} names a translation key for every line`, p.lines.every((l) => typeof l.key === 'string' && l.key.length > 0))
}

// --- report ------------------------------------------------------------------

console.log('')
console.log('check:tile-preview — the figures on a held tile are the figures the screen would show')
console.log(`  ${checked} checks`)
if (failures.length > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  console.log('')
  process.exit(1)
}
console.log('')
console.log('  All clear.')
