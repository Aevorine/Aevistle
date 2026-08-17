/**
 * The gate on new-mail notifications.
 *
 * Two things are checked here, and they fail in different ways.
 *
 * The first is the decision itself — which arrivals are worth interrupting
 * someone for. Every rule in `core/mail/newMail.ts` exists because of a specific way
 * a naive "tell me about new mail" misfires: the first sync after launch
 * discovering an entire mailbox, an account catching up after a week offline,
 * mail already read in webmail arriving here as if it were news. Those are all
 * silent failures in the bad direction — nothing throws, a notification simply
 * fires when it should not, and the user's remedy is to turn notifications off
 * altogether, taking the verification-code channel with them.
 *
 * The second is that the *other* implementation agrees. Android's background
 * worker cannot call any of this: it runs on WorkManager's schedule with no
 * WebView in the process, so `InboxSyncWorker.java` applies the same rules in
 * Java against the native cache. Two implementations of one rule is exactly the
 * shape that drifts, and it would drift invisibly — the phone would announce
 * something the desktop stayed quiet about, months apart, with nobody able to
 * say which was right. So the window constant is read out of both files and
 * compared.
 *
 * `--selftest` widens the Java window and requires this to go red.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

// --- build the module under test -------------------------------------------

const out = mkdtempSync(join(tmpdir(), 'aevistle-newmail-'))
try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'src/core/mail/newMail.ts')}"`,
      '--bundle',
      '--format=esm',
      `--outfile="${join(out, 'nm.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const {
  NEW_MAIL_WINDOW_MS,
  MISSED_MAIL_MAX_AGE_MS,
  recencyCutoff,
  restoredBaseline,
  newArrivals,
  announcementFor,
  senderName,
  previewLine,
} = await import(pathToFileURL(join(out, 'nm.mjs')).href)

// --- the decision -----------------------------------------------------------

const NOW = 1_700_000_000_000

/** A message with only the fields the decision reads. */
const msg = (id, over = {}) => ({
  id,
  accountId: 'acct_1',
  folderPath: 'INBOX',
  uid: 1,
  uidValidity: 1,
  from: 'Alex Chen <alex@example.com>',
  to: 'me@example.com',
  subject: 'Hello',
  date: NOW - 60_000,
  snippet: 'Just checking in about tomorrow.',
  sizeBytes: 100,
  hasAttachments: false,
  seen: false,
  tag: 'none',
  bodyCached: false,
  ...over,
})

const arrivals = (opts) =>
  newArrivals({
    before: new Set(opts.before ?? []),
    after: opts.after,
    now: NOW,
    primed: opts.primed ?? true,
    since: opts.since,
  })

check(
  'the first sync after launch announces nothing, however much it found',
  arrivals({ after: [msg('a'), msg('b'), msg('c')], primed: false }).length === 0,
)

check(
  'a message that was not there before is an arrival',
  arrivals({ before: ['a'], after: [msg('a'), msg('b')] }).map((m) => m.id).join() === 'b',
)

check(
  'a message that was already there is not',
  arrivals({ before: ['a', 'b'], after: [msg('a'), msg('b')] }).length === 0,
)

check(
  'mail already read elsewhere never announces',
  arrivals({ before: [], after: [msg('b', { seen: true })] }).length === 0,
)

check(
  'an account catching up after a week announces nothing from last week',
  arrivals({ before: [], after: [msg('b', { date: NOW - 7 * 24 * 3600_000 })] }).length === 0,
)

check(
  'a message right at the edge of the window still counts',
  arrivals({ before: [], after: [msg('b', { date: NOW - NEW_MAIL_WINDOW_MS + 1000 })] }).length === 1,
)

check(
  'a message just past the edge does not',
  arrivals({ before: [], after: [msg('b', { date: NOW - NEW_MAIL_WINDOW_MS - 1000 })] }).length === 0,
)

check(
  'arrivals come back newest first',
  arrivals({
    before: [],
    after: [msg('old', { date: NOW - 600_000 }), msg('new', { date: NOW - 1000 })],
  })
    .map((m) => m.id)
    .join() === 'new,old',
)

// --- mail that arrived while the app was not running ------------------------
//
// The rule above ("only what is genuinely recent") is correct while the app is
// running and syncing on a timer, and is exactly wrong the first time it looks
// after being closed: a night's mail is hours old, so a fixed thirty-minute
// window drops precisely the arrivals the user most wanted. `since` — the
// account's own last completed sync — is what widens it, and these checks are
// the ones that fail if that widening is lost to a refactor. The symptom would
// be silence, which is why it is worth a gate rather than a comment.

check(
  'mail that arrived while the app was closed is announced on the first sync back',
  arrivals({
    before: ['a'],
    after: [msg('a'), msg('b', { date: NOW - 6 * 3600_000 })],
    since: NOW - 8 * 3600_000,
  }).length === 1,
)

check(
  'a message from before the last sync is still not an arrival',
  arrivals({
    before: ['a'],
    after: [msg('a'), msg('b', { date: NOW - 9 * 3600_000 })],
    since: NOW - 8 * 3600_000,
  }).length === 0,
)

check(
  'mail read elsewhere while the app was closed still does not announce',
  arrivals({
    before: [],
    after: [msg('b', { date: NOW - 6 * 3600_000, seen: true })],
    since: NOW - 8 * 3600_000,
  }).length === 0,
)

check(
  'an account that has never synced does not use a widened window',
  arrivals({ before: [], after: [msg('b', { date: NOW - 6 * 3600_000 })], since: 0 }).length === 0,
)

check(
  'the first sync after launch still announces nothing when there is no baseline',
  arrivals({
    after: [msg('a'), msg('b')],
    primed: false,
    since: NOW - 8 * 3600_000,
  }).length === 0,
)

// `since` widens; it must never narrow. A sync a minute ago leaves the
// ordinary window in force, because a message can predate the last sync and
// still be new to it — delivered late, or off the end of the fetched page.
check(
  'a recent last sync does not shrink the ordinary window',
  recencyCutoff(NOW, NOW - 60_000) === NOW - NEW_MAIL_WINDOW_MS,
)
check(
  'an older last sync widens the window to it',
  recencyCutoff(NOW, NOW - 8 * 3600_000) === NOW - 8 * 3600_000,
)
check(
  'a last sync from beyond the cap is clamped to the cap',
  recencyCutoff(NOW, NOW - 90 * 24 * 3600_000) === NOW - MISSED_MAIL_MAX_AGE_MS,
)
check(
  'a missing last sync falls back to the ordinary window',
  recencyCutoff(NOW, undefined) === NOW - NEW_MAIL_WINDOW_MS,
)
check(
  'a nonsense last sync falls back rather than throwing the window open',
  recencyCutoff(NOW, Number.NaN) === NOW - NEW_MAIL_WINDOW_MS,
)

// --- the baseline recovered from disk ---------------------------------------
//
// `restoredBaseline` is the seam between "what was saved" and the rules above.
// It used to live inside the React state container, where nothing could reach
// it, and it is the half of the fix that fails silently: get `primed` wrong in
// one direction and a night's mail is swallowed, wrong in the other and
// opening the app recites the whole mailbox.

const saved = (over = {}) => ({ messages: [{ id: 'a' }, { id: 'b' }], lastSyncAt: NOW - 3600_000, ...over })

check(
  'a saved account that has synced before is a trustworthy baseline',
  restoredBaseline(saved()).primed === true,
)
check(
  'a restored baseline knows what the account held',
  [...restoredBaseline(saved()).ids].sort().join() === 'a,b',
)
check(
  'a restored baseline carries the time it was last true',
  restoredBaseline(saved()).since === NOW - 3600_000,
)
check(
  'an account that was genuinely empty is still a trustworthy baseline',
  restoredBaseline(saved({ messages: [] })).primed === true,
)
check(
  'an account that has never synced is not a baseline',
  restoredBaseline(saved({ lastSyncAt: 0 })).primed === false,
)
check(
  'a missing account row is not a baseline',
  restoredBaseline(undefined).primed === false,
)
check(
  'a row with no lastSyncAt at all is not a baseline',
  restoredBaseline({ messages: [{ id: 'a' }] }).primed === false,
)
check(
  'a corrupt lastSyncAt is not a baseline',
  restoredBaseline(saved({ lastSyncAt: Number.NaN })).primed === false &&
    restoredBaseline(saved({ lastSyncAt: 'yesterday' })).primed === false,
)
check(
  'a row with no message list restores as empty rather than throwing',
  restoredBaseline({ lastSyncAt: NOW - 1000 }).ids.size === 0,
)

// End to end over the seam: a saved row, mail that landed while the app was
// off, and the announcement the user should get on the way back in.
{
  const row = saved({ lastSyncAt: NOW - 8 * 3600_000 })
  const base = restoredBaseline(row)
  const overnight = newArrivals({
    before: base.ids,
    after: [msg('a'), msg('b'), msg('c', { date: NOW - 6 * 3600_000 })],
    now: NOW,
    primed: base.primed,
    since: base.since,
  })
  check('a saved row plus overnight mail produces an arrival', overnight.length === 1)
  check('and it is the message that actually arrived', overnight[0]?.id === 'c')
  check('and it collapses into one announcement', announcementFor(overnight)?.count === 1)
}

// --- the announcement -------------------------------------------------------

check('nothing to announce answers null', announcementFor([]) === null)

const many = announcementFor([msg('old', { date: NOW - 600_000 }), msg('new', { date: NOW - 1000 })])
check('an announcement counts everything it covers', many?.count === 2)
check(
  'an announcement is about the newest, whatever order it was handed',
  many?.newest.id === 'new',
)

// A caller that assembled its own list unsorted must still get the newest.
const unsorted = announcementFor([msg('new', { date: NOW - 1000 }), msg('old', { date: NOW - 600_000 })])
check('order handed in does not decide which message is announced', unsorted?.newest.id === 'new')

// --- wording ----------------------------------------------------------------

check('a quoted display name is read as a name', senderName('"Alex Chen" <alex@example.com>') === 'Alex Chen')
check('an unquoted display name is read as a name', senderName('Alex Chen <alex@example.com>') === 'Alex Chen')
check('a bare address is left alone', senderName('alex@example.com') === 'alex@example.com')
check(
  'an address with no display name does not answer with an empty string',
  senderName('<alex@example.com>') === '<alex@example.com>',
)

check(
  'a preview collapses whitespace',
  previewLine(msg('a', { snippet: 'one\n\n  two   three' })) === 'one two three',
)
check('an empty snippet makes no preview', previewLine(msg('a', { snippet: '   ' })) === '')
const long = previewLine(msg('a', { snippet: 'x'.repeat(500) }), 40)
check('a long preview is cut to the limit', long.length === 40)
check('a cut preview says it was cut', long.endsWith('…'))

// --- the two implementations agree ------------------------------------------

/*
 * `InboxSyncRunner.java`, not `InboxSyncWorker.java`.
 *
 * 0.3.24 moved the rules out of the worker so the WorkManager schedule and the
 * foreground service could share one copy, and this file kept reading the
 * emptied-out worker. The regexes then matched nothing, `javaMinutes` came back
 * `undefined`, and the comparison this section exists for failed — so the gate
 * was red from the moment that refactor landed, and stayed red through a
 * release. A gate pointed at a file the logic has left is worse than no gate:
 * it reports a drift it can no longer see.
 */
const RUNNER = 'android/app/src/main/java/dev/aevistle/app/InboxSyncRunner.java'

const tsSource = readFileSync(join(root, 'src/core/mail/newMail.ts'), 'utf8')
let javaSource = readFileSync(join(root, RUNNER), 'utf8')
if (selftest) {
  javaSource = javaSource.replace(/WINDOW_MS\s*=\s*30L/, 'WINDOW_MS = 90L')
}

const tsMinutes = /NEW_MAIL_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60_000/.exec(tsSource)?.[1]
const javaMinutes = /\bWINDOW_MS\s*=\s*(\d+)L\s*\*\s*60L\s*\*\s*1000L/.exec(javaSource)?.[1]

check('src/core/mail/newMail.ts states its window in minutes', tsMinutes !== undefined)
check('InboxSyncRunner.java states its window in minutes', javaMinutes !== undefined)
check(
  `the two new-mail windows must match (TS ${tsMinutes ?? '?'}m, Java ${javaMinutes ?? '?'}m)`,
  tsMinutes !== undefined && tsMinutes === javaMinutes,
)

// The cap on how far a stale last-sync time may widen the window is the second
// shared number, and it drifts the same way the first one did.
const tsMissedDays = /MISSED_MAIL_MAX_AGE_MS\s*=\s*(\d+)\s*\*\s*24\s*\*\s*60\s*\*\s*60_000/.exec(
  tsSource,
)?.[1]
const javaMissedDays = /MISSED_MAX_AGE_MS\s*=\s*(\d+)L\s*\*\s*24L/.exec(javaSource)?.[1]

check('src/core/mail/newMail.ts states its missed-mail cap in days', tsMissedDays !== undefined)
check('InboxSyncRunner.java states its missed-mail cap in days', javaMissedDays !== undefined)
check(
  `the two missed-mail caps must match (TS ${tsMissedDays ?? '?'}d, Java ${javaMissedDays ?? '?'}d)`,
  tsMissedDays !== undefined && tsMissedDays === javaMissedDays,
)

// Presence, not behaviour: this script cannot run Java. What it can do is
// refuse to let the widening quietly disappear from the side that needs it
// most — the one that runs while the app is closed.
check(
  'the Java side widens its window with the account last-sync time',
  /recencyCutoff\(/.test(javaSource) && /optLong\("lastSyncAt"/.test(javaSource),
)
check(
  'the Java side caps how far a stale last-sync time may reach',
  /MISSED_MAX_AGE_MS/.test(javaSource),
)

// The Java side must apply the same three rules. Checked as presence rather
// than by parsing: a rule silently dropped there is invisible on this platform
// and only shows up as a phone announcing things a desktop does not.
check('the Java side skips messages it already knew', /known\.contains\(id\)/.test(javaSource))
check('the Java side skips messages already read', /optBoolean\("seen"/.test(javaSource))
check('the Java side skips messages older than the window', /<\s*cutoff/.test(javaSource))

// ---------------------------------------------------------------------------

rmSync(out, { recursive: true, force: true })

const label = 'new mail is announced by the same rules on both platforms'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  const caught = failures.some((f) => f.startsWith('the two new-mail windows must match'))
  if (!caught) {
    console.log('\n  SELFTEST FAILED: a drifted window was not caught.\n')
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
