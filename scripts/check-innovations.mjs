/**
 * Behaviour check for the send-time features — `npm run check:features`.
 *
 * These six modules share a property that makes them worth a table of cases
 * rather than a click-through: every one of them decides whether a message
 * goes out, and every one of them can be wrong *silently*. A merge that blanks
 * an unknown variable, a holiday rule that skips the wrong day, a condition
 * that blocks when it should have said "cannot tell" — none of those throw,
 * none show up on screen, and all of them are only noticed by the person who
 * did not get the email.
 *
 * The clock is pinned wherever a case depends on it. Left free, "the previous
 * working day" changes answer depending on which day the suite is run.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'aevistle-features-'))

async function load(entry, name) {
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'error' })
  return import(pathToFileURL(outfile).href)
}

const merge = await load('src/core/mergeVars.ts', 'merge')
const cal = await load('src/core/workCalendar.ts', 'cal')
const cond = await load('src/core/conditions.ts', 'cond')
const snap = await load('src/core/snapshots.ts', 'snap')
const out = await load('src/core/outbox.ts', 'outbox')
const rcpt = await load('src/core/receipts.ts', 'receipts')
const pre = await load('src/core/preflight.ts', 'preflight')

await rm(dir, { recursive: true, force: true })

let passed = 0
const failures = []

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) passed++
  else failures.push(`${label}\n    expected ${e}\n    got      ${a}`)
}

function ok(label, condition) {
  if (condition) passed++
  else failures.push(label)
}

// ---------------------------------------------------------------------------
// A6 — template variables and mail merge
// ---------------------------------------------------------------------------

const contacts = [
  { id: 'c1', name: 'Lena Fischer', address: 'lena@example.com', tags: [], createdAt: 0,
    fields: { company: 'Northwind' } },
  { id: 'c2', name: '张三', address: 'zhang@example.com', tags: [], createdAt: 0 },
]

const draft = (patch = {}) => ({
  to: ['lena@example.com', 'zhang@example.com'],
  cc: [], bcc: [], subject: 'Hi {{firstName}}', body: 'From {{company}} on {{date}}',
  bodyFormat: 'plain', attachments: [], accountId: 'a1', priority: 'normal',
  requestReadReceipt: false, individualDelivery: false, ...patch,
})

const merged = merge.buildMergeMessages(draft(), contacts, {
  enabled: true, now: Date.UTC(2026, 7, 2, 4, 0), locale: 'en',
})
check('merge: one message per recipient', merged.length, 2)
check('merge: first name from the contact', merged[0].draft.subject, 'Hi Lena')
check('merge: custom field substituted', merged[0].draft.body.startsWith('From Northwind'), true)
check('merge: To is narrowed to one address', merged[0].draft.to, ['lena@example.com'])
// A contact with no `company` must not silently produce "From  on …".
check('merge: unknown variable is left standing', merged[1].draft.body.includes('{{company}}'), true)
check('merge: and is reported as missing', merged[1].missing, ['company'])
// CJK name, no space to split on: firstName must fall back to the whole name.
check('merge: CJK name survives firstName', merged[1].draft.subject, 'Hi 张三')

const noContact = merge.buildMergeMessages(draft({ to: ['nobody@example.com'] }), [], {
  enabled: true, now: 0,
})
check('merge: name falls back to the local part', noContact[0].draft.subject, 'Hi nobody')

const unmerged = merge.buildMergeMessages(draft(), contacts, { enabled: false, now: 0 })
check('merge off: one message only', unmerged.length, 1)
check('merge off: recipient list untouched', unmerged[0].draft.to.length, 2)

// Cc and Bcc must not be carried into every expanded copy.
const withCc = merge.buildMergeMessages(draft({ cc: ['boss@example.com'] }), contacts, {
  enabled: true, now: 0,
})
check('merge: Cc dropped from expanded copies', withCc.every((m) => m.cc === undefined || m.draft.cc.length === 0), true)

check('merge: usedVars in order', merge.usedVars('{{b}} {{a}} {{b}}'), ['b', 'a'])
check('merge: substitution is literal, not recursive', merge.render('{{x}}', { x: '{{y}}' }), '{{y}}')

// ---------------------------------------------------------------------------
// A8 — working days, holidays and make-up days
// ---------------------------------------------------------------------------

// 2026-10-01 is a Thursday; 2026-10-03 a Saturday; 2026-10-05 a Monday.
const CN = { weekend: [0, 6], holidays: ['2026-10-01', '2026-10-02'], workdays: ['2026-10-10'] }
const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime()

ok('calendar: a plain Thursday is a working day', cal.isWorkingDay(at(2026, 9, 24), CN))
ok('calendar: a listed holiday is not', !cal.isWorkingDay(at(2026, 10, 1), CN))
ok('calendar: Saturday is not', !cal.isWorkingDay(at(2026, 10, 3), CN))
ok('calendar: a make-up Saturday is', cal.isWorkingDay(at(2026, 10, 10), CN))
// 2026-10-10 is a Saturday listed as a workday — the case a weekend-only rule gets wrong.
ok('calendar: make-up day beats the weekend', cal.isWorkingDay(at(2026, 10, 10), CN))

check(
  'calendar: skip drops the holiday',
  cal.applyWorkCalendar([at(2026, 10, 1), at(2026, 9, 30)], 'skip', CN),
  [at(2026, 9, 30)],
)
check(
  'calendar: after moves 1 Oct to Monday 5 Oct',
  cal.applyWorkCalendar([at(2026, 10, 1)], 'after', CN),
  [at(2026, 10, 5)],
)
check(
  'calendar: before moves 1 Oct back to Wednesday 30 Sep',
  cal.applyWorkCalendar([at(2026, 10, 1)], 'before', CN),
  [at(2026, 9, 30)],
)
// Two reminders inside the same holiday must not collapse into one instant.
const collapsed = cal.applyWorkCalendar([at(2026, 10, 1, 9), at(2026, 10, 2, 9)], 'after', CN)
check('calendar: two shifted fires stay distinct', collapsed.length, 2)
ok('calendar: and stay ordered', collapsed[0] < collapsed[1])
check('calendar: off is a no-op', cal.applyWorkCalendar([at(2026, 10, 1)], 'off', CN), [at(2026, 10, 1)])

const parsed = cal.parseDateList('2026-10-01, 2026/10/2\n20261003 rubbish 2026-02-31')
check('calendar: three formats all parse', parsed.dates, ['2026-10-01', '2026-10-02', '2026-10-03'])
check('calendar: junk is reported, not dropped', parsed.rejected, ['rubbish', '2026-02-31'])

// ---------------------------------------------------------------------------
// A5 — send conditions
// ---------------------------------------------------------------------------

const withFiles = draft({ attachments: [{ id: 'f1', name: 'report.pdf', path: '/tmp/report.pdf', size: 1, mime: '', source: 'path', addedAt: 0, inline: false }] })

check(
  'condition: missing attachment blocks',
  cond.evaluateConditions([{ kind: 'attachmentsPresent' }], withFiles, {
    now: 0, fileExists: () => false,
  }).send,
  false,
)
check(
  'condition: present attachment passes',
  cond.evaluateConditions([{ kind: 'attachmentsPresent' }], withFiles, {
    now: 0, fileExists: () => true,
  }).send,
  true,
)
// The rule the whole design rests on: unanswerable must never mean "block".
const undecided = cond.evaluateConditions([{ kind: 'attachmentsPresent' }], withFiles, { now: 0 })
check('condition: no filesystem does not block', undecided.send, true)
check('condition: and says so', undecided.undecidable, true)

const replyCtx = {
  now: 0, inboxKnown: true, lastRunAt: 1000,
  latestInboundFrom: (a) => (a === 'lena@example.com' ? 5000 : undefined),
}
check(
  'condition: a reply after the last run blocks',
  cond.evaluateConditions([{ kind: 'noReplySince' }], draft(), replyCtx).send,
  false,
)
check(
  'condition: a reply from before the last run does not',
  cond.evaluateConditions([{ kind: 'noReplySince' }], draft(), {
    ...replyCtx, lastRunAt: 9000,
  }).send,
  true,
)
check(
  'condition: an inbox that never synced does not block',
  cond.evaluateConditions([{ kind: 'noReplySince' }], draft(), {
    now: 0, inboxKnown: false, latestInboundFrom: () => 5000, lastRunAt: 0,
  }).send,
  true,
)

const noon = new Date(2026, 7, 2, 12, 0).getTime()
const night = new Date(2026, 7, 2, 23, 0).getTime()
check('condition: inside the window passes',
  cond.evaluateConditions([{ kind: 'timeWindow', from: '09:00', to: '18:00' }], draft(), { now: noon }).send, true)
check('condition: outside it blocks',
  cond.evaluateConditions([{ kind: 'timeWindow', from: '09:00', to: '18:00' }], draft(), { now: night }).send, false)
// A window that wraps midnight is one window, not the 15 hours in between.
check('condition: a wrapping window includes 23:00',
  cond.evaluateConditions([{ kind: 'timeWindow', from: '22:00', to: '07:00' }], draft(), { now: night }).send, true)
// An unparseable window fails open, like quiet hours.
check('condition: a broken window never blocks',
  cond.evaluateConditions([{ kind: 'timeWindow', from: 'nonsense', to: '' }], draft(), { now: night }).send, true)

check('condition: escalation waits for a failure',
  cond.evaluateConditions([{ kind: 'previousRunFailed' }], draft(), { now: 0, lastResult: 'ok' }).send, false)
check('condition: and fires after one',
  cond.evaluateConditions([{ kind: 'previousRunFailed' }], draft(), { now: 0, lastResult: 'failed' }).send, true)
check('condition: no conditions always passes', cond.evaluateConditions(undefined, draft(), { now: 0 }).send, true)

// ---------------------------------------------------------------------------
// A7 — draft snapshots
// ---------------------------------------------------------------------------

const emptyish = draft({ to: [], subject: '', body: '' })
check('snapshot: nothing worth keeping is not kept', snap.captureSnapshot([], emptyish, 'auto'), null)

const first = snap.captureSnapshot([], draft({ subject: 'One' }), 'manual', 1_000)
check('snapshot: the first is kept', first.length, 1)
check('snapshot: an identical draft is not re-recorded',
  snap.captureSnapshot(first, draft({ subject: 'One' }), 'auto', 100_000), null)
check('snapshot: an automatic one respects the quiet period',
  snap.captureSnapshot(first, draft({ subject: 'Two' }), 'auto', 1_100), null)
check('snapshot: an explicit one ignores it',
  snap.captureSnapshot(first, draft({ subject: 'Two' }), 'manual', 1_100).length, 2)

// The copy must not alias the live draft's arrays.
const live = draft({ subject: 'Three' })
const held = snap.captureSnapshot([], live, 'manual', 0)
live.to.push('late@example.com')
check('snapshot: arrays are copied, not aliased', held[0].draft.to.length, 2)

let rolling = []
for (let i = 0; i < snap.SNAPSHOT_CAP + 5; i++) {
  rolling = snap.captureSnapshot(rolling, draft({ subject: `v${i}` }), 'manual', i * 1000) ?? rolling
}
check('snapshot: the list is capped', rolling.length, snap.SNAPSHOT_CAP)
check('snapshot: newest first', rolling[0].draft.subject, `v${snap.SNAPSHOT_CAP + 4}`)

// ---------------------------------------------------------------------------
// A11 — the offline queue
// ---------------------------------------------------------------------------

const fail = (kind) => ({ ok: false, accepted: [], rejected: [], durationMs: 0, errorKind: kind, error: kind })

ok('outbox: a network failure is queueable', out.isQueueable(fail('network')))
ok('outbox: a timeout is queueable', out.isQueueable(fail('timeout')))
// A wrong password fails identically forever; queueing it produces a message
// that retries until someone notices.
ok('outbox: an auth failure is not', !out.isQueueable(fail('auth')))
ok('outbox: a bad recipient is not', !out.isQueueable(fail('recipient')))
ok('outbox: a success is not', !out.isQueueable({ ok: true, accepted: [], rejected: [], durationMs: 1 }))

const item = out.queueItem(draft(), fail('network'), 0)
check('outbox: first backoff is 30s', item.nextAttemptAt, 30_000)
check('outbox: nothing is due before then', out.dueItems([item], 29_999).length, 0)
check('outbox: due once it elapses', out.dueItems([item], 30_000).length, 1)

let attempt = item
for (let i = 0; i < out.MAX_ATTEMPTS; i++) attempt = out.afterAttempt(attempt, fail('network'), 0)
check('outbox: it gives up out loud', attempt.status, 'failed')
check('outbox: and stops being due', out.dueItems([attempt], 10 ** 12).length, 0)
check('outbox: a success removes it', out.afterAttempt(item, { ok: true, accepted: [], rejected: [], durationMs: 1 }), null)
ok('outbox: backoff is capped at an hour', out.backoffMs(50) === 3_600_000)

// ---------------------------------------------------------------------------
// A4 — delivery receipts
// ---------------------------------------------------------------------------

const inboxMsg = (patch) => ({
  id: 'm1', accountId: 'a1', folderPath: 'INBOX', uid: 1, uidValidity: 1,
  from: 'someone@example.com', to: '', subject: '', date: 5000, snippet: '',
  sizeBytes: 0, hasAttachments: false, seen: false, tag: 'none', bodyCached: false, ...patch,
})

check('receipt: a daemon bounce is classified',
  rcpt.classifyReport(inboxMsg({ from: 'MAILER-DAEMON@example.com', subject: 'Undeliverable: Invoice' })), 'bounce')
check('receipt: a Chinese bounce subject is classified',
  rcpt.classifyReport(inboxMsg({ from: 'x@y.com', subject: '退信通知' })), 'bounce')
check('receipt: a read notification is classified',
  rcpt.classifyReport(inboxMsg({ from: 'lena@example.com', subject: 'Read: Invoice' })), 'read')
check('receipt: ordinary mail is neither',
  rcpt.classifyReport(inboxMsg({ from: 'lena@example.com', subject: 'Re: Invoice' })), null)

check('receipt: prefixes are stripped for comparison',
  rcpt.normaliseSubject('Re: Read: Weekly report'), 'weekly report')

const sent = [{ logId: 'L1', at: 1000, subject: 'Weekly report', messageId: '<abc@host>' }]
const byId = rcpt.trackReceipts(sent, [
  inboxMsg({ id: 'b1', from: 'MAILER-DAEMON@x', subject: 'Delivery failure', snippet: 'original: abc@host', date: 2000 }),
])
check('receipt: matched by Message-ID', byId.get('L1').status, 'bounced')

const bySubject = rcpt.trackReceipts(sent, [
  inboxMsg({ id: 'r1', from: 'lena@example.com', subject: 'Read: Weekly report', date: 2000 }),
])
check('receipt: matched by subject', bySubject.get('L1').status, 'read')

// A bounce cannot precede the message it bounced.
const stale = rcpt.trackReceipts(sent, [
  inboxMsg({ id: 'b2', from: 'MAILER-DAEMON@x', subject: 'Undeliverable: Weekly report', date: 500 }),
])
check('receipt: an earlier report is ignored', stale.get('L1').status, 'sent')

// Absence of a bounce must never be reported as delivered.
check('receipt: silence stays "sent"', rcpt.trackReceipts(sent, []).get('L1').status, 'sent')

// A subject-less send must not attract every bounce in the mailbox.
const anonymous = rcpt.trackReceipts([{ logId: 'L2', at: 0, subject: '' }], [
  inboxMsg({ from: 'MAILER-DAEMON@x', subject: 'Undeliverable: something else', date: 100 }),
])
check('receipt: an empty subject matches nothing', anonymous.get('L2').status, 'sent')

// ---------------------------------------------------------------------------
// A1 — the send preview
// ---------------------------------------------------------------------------

const account = {
  id: 'a1', label: 'Work', fromName: 'Me', fromAddress: 'me@example.com', host: 'smtp.example.com',
  port: 465, security: 'ssl', username: 'me', authMethod: 'password', hasSecret: true,
  timeoutMs: 20000, autoNegotiate: true, allowInvalidCert: false, poolMaxMessages: 100,
  createdAt: 0, updatedAt: 0,
}
const baseOpts = {
  contacts, merge: false, attachmentWarnMb: 10, attachmentMaxMb: 25, bulkConfirmThreshold: 10,
  now: Date.UTC(2026, 7, 2),
}

const plain = pre.buildPreflight(draft({ subject: 'Hello', body: 'Text' }), account, baseOpts)
check('preflight: one message when merge is off', plain.messageCount, 1)
check('preflight: recipients counted across fields', plain.recipientCount, 2)
// Both recipients share the sender's own domain, so none of them is external.
check('preflight: same-domain recipients are not external', plain.externalCount, 0)
const outside = pre.buildPreflight(
  draft({ subject: 'Hello', body: 'Text', to: ['lena@example.com', 'x@elsewhere.test'] }),
  account,
  baseOpts,
)
check('preflight: a foreign domain is counted as external', outside.externalCount, 1)
ok('preflight: a clean draft is not blocked', !plain.blocked)

const mergedReport = pre.buildPreflight(draft({ subject: 'Hi {{firstName}}', body: 'x' }), account, {
  ...baseOpts, merge: true,
})
check('preflight: merge produces one message each', mergedReport.messageCount, 2)

const missing = pre.buildPreflight(withFiles, account, { ...baseOpts, fileExists: () => false })
ok('preflight: a missing attachment blocks the send', missing.blocked)
ok('preflight: and names the file',
  missing.warnings.some((w) => w.key === 'preflight.warn.missingFiles'))

const unknown = pre.buildPreflight(withFiles, account, baseOpts)
ok('preflight: an unchecked attachment does not block', !unknown.blocked)
// With merging off, `{{like this}}` is text the user typed. Worth a warning,
// never a refusal — see the comment in preflight.ts.
ok('preflight: literal braces with merge off are only a warning',
  unknown.warnings.some((w) => w.key === 'preflight.warn.varsWithoutMerge' && w.severity === 'warning'))

const unfilled = pre.buildPreflight(draft({ subject: 'Hi {{nmae}}' }), account, { ...baseOpts, merge: true })
ok('preflight: a typo in a variable blocks the send',
  unfilled.warnings.some((w) => w.key === 'preflight.warn.unfilledVars' && w.severity === 'error'))

const noAccount = pre.buildPreflight(draft(), undefined, baseOpts)
ok('preflight: no account blocks', noAccount.blocked)

// ---------------------------------------------------------------------------
// C7 — the remote-image cache
// ---------------------------------------------------------------------------

const img = await load('src/core/imageCache.ts', 'imageCache')

let fetches = 0
const fakeFetch = async (url) => {
  fetches++
  if (url.includes('bad')) throw new Error('blocked')
  return `data:image/png;base64,${url.length}`
}

img.clearImageCache()
const cachedRun = await img.resolveWithCache(['a.png', 'b.png', 'a.png'], fakeFetch)
// Three references, two distinct URLs: the repeated one must not be fetched twice.
check('imageCache: duplicates are fetched once', fetches, 2)
check('imageCache: results keep input order and length', cachedRun.length, 3)
ok('imageCache: the repeat resolves to the same data', cachedRun[0] === cachedRun[2])

fetches = 0
await img.resolveWithCache(['a.png', 'b.png'], fakeFetch)
check('imageCache: a second pass fetches nothing', fetches, 0)

fetches = 0
const failed = await img.resolveWithCache(['bad.png'], fakeFetch)
check('imageCache: a failure resolves to null', failed, [null])
await img.resolveWithCache(['bad.png'], fakeFetch)
// A blocked private address will be blocked identically next time; retrying it
// on every reopen is a slow way to get the same answer.
check('imageCache: failures are remembered too', fetches, 1)

img.clearImageCache()
for (let i = 0; i < 80; i++) await img.resolveWithCache([`u${i}.png`], fakeFetch)
ok('imageCache: the cache is bounded', img.imageCacheSize() <= 60)
check('imageCache: and keeps the most recent', img.getCached('u79.png') !== undefined, true)
check('imageCache: while dropping the oldest', img.getCached('u0.png'), undefined)

// ---------------------------------------------------------------------------

console.log(`\n${passed} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
