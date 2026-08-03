/**
 * Does exporting and re-importing reminders keep them, and drop the right things?
 *
 * Three properties matter more than round-tripping cleanly, and all three are
 * the kind that fail quietly:
 *
 *   - **No credentials leave.** The point of the feature is a file you can put
 *     in a backup or mail to yourself. If an account id, host or username ever
 *     rides along, that stops being true and nothing on screen would say so.
 *   - **Bookkeeping resets.** `runCount` and friends describe the machine that
 *     ran the job. Importing them would make an "after N sends" rule arrive
 *     already spent — a reminder that never fires, with no error anywhere.
 *   - **A bad row does not take the file down.** Someone restoring forty
 *     reminders should get the thirty-nine good ones and be told about the one
 *     that was wrong.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-transfer-'))
const bundle = path.join(dir, 'jobTransfer.mjs')
await build({
  entryPoints: ['src/core/jobTransfer.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { exportJobs, parseImport, materialise, TRANSFER_VERSION } = await import(
  pathToFileURL(bundle).href
)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const NOW = Date.UTC(2026, 7, 4, 9, 0, 0)
let seq = 0
const newId = (p) => `${p}_${++seq}`

const job = {
  id: 'job_local_1',
  name: 'Weekly report',
  enabled: true,
  draft: {
    accountId: 'acct_secret_local',
    to: ['team@example.com'],
    cc: [],
    bcc: [],
    subject: 'Status',
    body: 'Here it is',
    attachments: [
      { id: 'a1', name: 'report.pdf', size: 10, mime: 'application/pdf', source: 'path', path: 'D:/reports/report.pdf', addedAt: 1, inline: false },
      { id: 'a2', name: 'gone.pdf', size: 10, mime: 'application/pdf', source: 'path', path: 'D:/reports/gone.pdf', addedAt: 1, inline: false },
    ],
  },
  recurrence: { kind: 'weekly', startAt: NOW, timeOfDay: '09:00', weekdays: [1] },
  retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
  occurrences: [NOW + 1000],
  runCount: 17,
  lastRunAt: NOW - 5000,
  lastResult: 'ok',
  status: 'armed',
  createdAt: 1,
  updatedAt: 2,
}

// --- export -----------------------------------------------------------------

const file = exportJobs([job], '0.1.4', NOW)
const text = JSON.stringify(file)

check('the file identifies itself', file.format === 'aevistle.jobs')
check('the file carries a version', file.version === TRANSFER_VERSION)
check('the reminder survives export', file.jobs.length === 1)
check('attachment paths travel', file.jobs[0].attachmentPaths.length === 2)
check('attachment bytes do not travel', file.jobs[0].draft.attachments.length === 0)

// The one that matters most: nothing identifying the local install.
check('no account id anywhere in the file', !text.includes('acct_secret_local'))
check('no local job id in the file', !text.includes('job_local_1'))
for (const word of ['password', 'secret', 'imapHost', 'username']) {
  check(`the word "${word}" must not appear in an export`, !text.toLowerCase().includes(word.toLowerCase()))
}

// --- import -----------------------------------------------------------------

const parsed = parseImport(text)
check('the reminder survives the round trip', parsed.jobs.length === 1)
check('both attachment paths are reported for checking', parsed.attachmentPaths.length === 2)

const { jobs: imported, droppedAttachments } = materialise(
  parsed,
  'acct_on_this_machine',
  newId,
  new Set(['D:/reports/gone.pdf']),
  NOW,
)
check('one reminder is created', imported.length === 1)
check('it is attached to the account the user chose', imported[0].draft.accountId === 'acct_on_this_machine')
check('it gets a fresh id', imported[0].id !== 'job_local_1')
check('the subject came through', imported[0].draft.subject === 'Status')
check('the recurrence came through', imported[0].recurrence.kind === 'weekly')
check('the attachment that exists is kept', imported[0].draft.attachments.length === 1)
check('the missing attachment is dropped', droppedAttachments === 1)
check(
  'the kept attachment keeps its path',
  imported[0].draft.attachments[0].path === 'D:/reports/report.pdf',
)

check('runCount resets', imported[0].runCount === 0)
check('lastRunAt does not travel', imported[0].lastRunAt === undefined)
check('lastResult does not travel', imported[0].lastResult === undefined)
check('occurrences are recomputed, not inherited', imported[0].occurrences.length === 0)

/*
 * The same properties, asked of a file that *does* carry the fields.
 *
 * The round trip above cannot see this: the exporter strips the bookkeeping,
 * so by the time `materialise` runs there is nothing left to inherit and an
 * importer that trusted the file would pass anyway. Proven — an earlier version
 * of this check let exactly that through. A hand-edited or older file is the
 * real case, and the importer has to ignore the fields rather than rely on
 * nobody having sent them.
 */
const hostile = materialise(
  {
    jobs: [
      {
        ...file.jobs[0],
        runCount: 99,
        lastRunAt: 12345,
        lastResult: 'failed',
        occurrences: [1, 2, 3],
        id: 'job_from_the_file',
        status: 'done',
      },
    ],
    problems: [],
    attachmentPaths: [],
  },
  'acct_on_this_machine',
  newId,
  new Set(),
  NOW,
).jobs[0]
check('a file claiming runCount is ignored', hostile.runCount === 0)
check('a file claiming lastRunAt is ignored', hostile.lastRunAt === undefined)
check('a file claiming lastResult is ignored', hostile.lastResult === undefined)
check('a file claiming occurrences is ignored', hostile.occurrences.length === 0)
check('a file claiming an id is ignored', hostile.id !== 'job_from_the_file')
check('a file claiming a status is ignored', hostile.status === 'armed')

// --- refusing what it should refuse -----------------------------------------

const refuses = (text, why) => {
  try {
    parseImport(text)
    return false
  } catch (e) {
    return e.message === why
  }
}
check('plain text is refused', refuses('hello', 'not-json'))
check('some other JSON file is refused', refuses('{"hello":1}', 'not-aevistle'))
check(
  'a file from a newer version is refused rather than half-read',
  refuses(JSON.stringify({ ...file, version: TRANSFER_VERSION + 1 }), 'too-new'),
)

// --- a bad row does not take the file down ----------------------------------

const mixed = parseImport(
  JSON.stringify({
    format: 'aevistle.jobs',
    version: TRANSFER_VERSION,
    exportedAt: NOW,
    jobs: [
      file.jobs[0],
      null,
      { name: 'no recurrence', draft: { to: ['a@b.c'] } },
      { name: 'no recipients', recurrence: { kind: 'once' }, draft: { to: [] } },
      file.jobs[0],
    ],
  }),
)
check('the good rows survive alongside bad ones', mixed.jobs.length === 2)
check('every bad row is reported', mixed.problems.length === 3)
check(
  'the problems say which row and why',
  mixed.problems[0].index === 1 &&
    mixed.problems[1].reason === 'no-recurrence' &&
    mixed.problems[2].reason === 'no-recipients',
)

// ---------------------------------------------------------------------------

const label = 'reminders can move between installs'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
