/**
 * The gate on "which mail is worth interrupting me for".
 *
 * `check-new-mail.mjs` guards the question about the *mail* — is this message
 * new, unseen, recent. This guards the question after it, the user's own, and
 * the two fail in different ways.
 *
 * A wrong answer here is silent in the direction that costs the most. The
 * sender allowlist is the sharpest example: it is the only rule in the app
 * where an *empty* value and a *populated* value have opposite meanings, and
 * getting that backwards turns "I haven't set this up" into "notify me about
 * nothing, forever", with the mail still arriving and listing perfectly. That
 * is the exact failure this whole feature exists to fix, so it is the first
 * thing checked.
 *
 * The keyword rule is checked from the other side: it is the only thing in the
 * app allowed to override quiet hours, so a keyword that *fails* to override is
 * a dead feature and a keyword that overrides something it should not — a muted
 * account — is a mute switch that does not mute.
 *
 * And, as with new mail, the Java background worker reimplements all three
 * rules with no WebView in the process. Two implementations of one rule drift,
 * invisibly, months apart, so the Java source is read and held to the same
 * behaviour.
 *
 * `--selftest` inverts the allowlist's empty case and requires this to go red.
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

// --- build the modules under test -------------------------------------------

const out = mkdtempSync(join(tmpdir(), 'aevistle-notifypolicy-'))
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
  bundle('src/core/mail/notifyPolicy.ts', 'policy.mjs')
  bundle('src/core/ops/notifyLedger.ts', 'ledger.mjs')
  bundle('src/core/mail/newMail.ts', 'newmail.mjs')
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { applyPolicy, decideNotification, fromAddress, keywordHit, senderAllowed } = await import(
  pathToFileURL(join(out, 'policy.mjs')).href
)
const { appendLedger, pruneLedger, reasons, summarise, LEDGER_MAX_ENTRIES } = await import(
  pathToFileURL(join(out, 'ledger.mjs')).href
)
const { explainArrivals } = await import(pathToFileURL(join(out, 'newmail.mjs')).href)

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

// --- rule 2: the allowlist, and its empty case ------------------------------
//
// First, because it is the one that fails silently and catastrophically. An
// empty list has to mean "everyone", never "nobody": the two are identical on
// screen and one of them is an app that has gone quiet forever.

check('an empty allowlist lets everyone through', senderAllowed('a@b.com', []) === (!selftest))
check('a missing allowlist lets everyone through', senderAllowed('a@b.com', undefined ?? []))
check(
  'a list of only blanks still means everyone',
  senderAllowed('a@b.com', ['', '   ', '\t']) === true,
)
check(
  'a populated list keeps everyone else out',
  senderAllowed('stranger@elsewhere.com', ['alex@example.com']) === false,
)
check(
  'an address entry matches that address',
  senderAllowed('Alex <alex@example.com>', ['alex@example.com']) === true,
)
check('an address entry is case-insensitive', senderAllowed('ALEX@EXAMPLE.COM', ['alex@example.com']))
check(
  'an address entry does not match a different mailbox at the same domain',
  senderAllowed('sam@example.com', ['alex@example.com']) === false,
)
check('a domain entry matches the domain', senderAllowed('anyone@example.com', ['example.com']))
check('a domain entry matches a subdomain', senderAllowed('bot@mail.example.com', ['example.com']))
/*
 * The one that turns an allowlist into a hole. A substring test would let
 * `example.com` match `example.com.attacker.net`, which is a domain an
 * attacker can register today — so the match is anchored at the right and a
 * dot is required in front of it.
 */
check(
  'a domain entry does not match a lookalike suffix domain',
  senderAllowed('bot@example.com.attacker.net', ['example.com']) === false,
)
check(
  'a domain entry does not match a domain that merely ends with the same letters',
  senderAllowed('bot@notexample.com', ['example.com']) === false,
)
check('the bare address is taken out of a display-name header', fromAddress('"A B" <a@b.com>') === 'a@b.com')
check('a header that is already bare survives unchanged', fromAddress('a@b.com') === 'a@b.com')

// --- rule 1: per account ----------------------------------------------------

check(
  'an account with no entry follows the global switch',
  decideNotification(msg('a'), 'acct_1', {}).notify === true,
)
check(
  'an account set to true rings',
  decideNotification(msg('a'), 'acct_1', { accounts: { acct_1: true } }).notify === true,
)
check(
  'an account set to false does not',
  decideNotification(msg('a'), 'acct_1', { accounts: { acct_1: false } }).notify === false,
)
check(
  'muting one account leaves the others alone',
  decideNotification(msg('a'), 'acct_2', { accounts: { acct_1: false } }).notify === true,
)
check(
  'a muted account names itself as the reason',
  decideNotification(msg('a'), 'acct_1', { accounts: { acct_1: false } }).suppressed ===
    'accountMuted',
)

// --- rule 3: keywords -------------------------------------------------------

check('an empty keyword list forces nothing', keywordHit(msg('a', { subject: 'invoice' }), []) === false)
check('a keyword in the subject hits', keywordHit(msg('a', { subject: 'Your invoice' }), ['invoice']))
check('a keyword is case-insensitive', keywordHit(msg('a', { subject: 'Your INVOICE' }), ['invoice']))
check(
  'a keyword hits inside a word, so languages without spaces work',
  keywordHit(msg('a', { subject: '您的验证码是 8391' }), ['验证码']),
)
check(
  'a keyword in the sender name hits too',
  keywordHit(msg('a', { from: 'Interview Team <hr@x.com>', subject: 'Hello' }), ['interview']),
)
check(
  'a keyword gets past an allowlist the sender is not on',
  decideNotification(msg('a', { subject: 'Your invoice' }), 'acct_1', {
    senders: ['someone@else.com'],
    keywords: ['invoice'],
  }).notify === true,
)
check(
  'and says so, rather than looking like an ordinary pass',
  decideNotification(msg('a', { subject: 'Your invoice' }), 'acct_1', {
    senders: ['someone@else.com'],
    keywords: ['invoice'],
  }).override === 'keyword',
)
/*
 * The line the keyword rule must not cross. A mute switch that a keyword can
 * talk its way past is not a mute switch, and the user typed the mute more
 * recently and more deliberately than the word.
 */
check(
  'a keyword does NOT get past a muted account',
  decideNotification(msg('a', { subject: 'Your invoice' }), 'acct_1', {
    accounts: { acct_1: false },
    keywords: ['invoice'],
  }).notify === false,
)
check(
  'a message that would have passed anyway reports no override',
  decideNotification(msg('a', { subject: 'Your invoice' }), 'acct_1', { keywords: ['invoice'] })
    .override === 'keyword',
)

// --- the keyword rule reaching back into newMail.ts -------------------------
//
// Rule 3 is worthless if the arrival was already discarded before the policy
// ever sees it, and that is exactly what happens to a verification code: read
// on the phone within seconds, or landed an hour before the laptop woke.

const forced = explainArrivals({
  before: new Set(),
  after: [msg('a', { seen: true, subject: 'Your verification code' })],
  now: NOW,
  primed: true,
  includeRead: false,
  force: (m) => keywordHit(m, ['verification code']),
})
check('a forced message survives the already-read rule', forced.arrivals.length === 1)
check('and is not also counted as suppressed', forced.readElsewhere === 0)

const forcedOld = explainArrivals({
  before: new Set(),
  after: [msg('a', { date: NOW - 5 * 60 * 60_000, subject: 'Your verification code' })],
  now: NOW,
  primed: true,
  force: (m) => keywordHit(m, ['verification code']),
})
check('a forced message survives the too-old rule', forcedOld.arrivals.length === 1)

const notForced = explainArrivals({
  before: new Set(),
  after: [msg('a', { seen: true })],
  now: NOW,
  primed: true,
  force: () => false,
})
check('without a force predicate the rules are unchanged', notForced.arrivals.length === 0)

/*
 * Rule 1 of newMail.ts is deliberately NOT overridable. An unprimed baseline
 * is the app admitting it does not know what the mailbox already held, and
 * forcing past that announces the whole inbox.
 */
const unprimed = explainArrivals({
  before: new Set(),
  after: [msg('a', { subject: 'invoice' }), msg('b', { subject: 'invoice' })],
  now: NOW,
  primed: false,
  force: () => true,
})
check('a force predicate cannot announce a whole mailbox on the first sync', unprimed.arrivals.length === 0)

// --- the batch --------------------------------------------------------------

const outcome = applyPolicy(
  [
    msg('a'),
    msg('b', { from: 'spam@elsewhere.com' }),
    msg('c', { from: 'spam@elsewhere.com', subject: 'Your invoice' }),
  ],
  'acct_1',
  { senders: ['example.com'], keywords: ['invoice'] },
)
check('the batch keeps the listed sender', outcome.keep.some((m) => m.id === 'a'))
check('the batch drops the unlisted sender', !outcome.keep.some((m) => m.id === 'b'))
check('the batch keeps the unlisted sender whose subject was forced', outcome.keep.some((m) => m.id === 'c'))
check('the batch counts the drop', outcome.senderNotListed === 1)
check('the batch counts the force', outcome.forced === 1)
check('the batch reports that something urgent is in it', outcome.urgent === true)
check(
  'an ordinary batch is not urgent, so quiet hours still apply to it',
  applyPolicy([msg('a')], 'acct_1', {}).urgent === false,
)

// --- the ledger -------------------------------------------------------------

const entry = (over = {}) => ({
  at: NOW,
  accountId: 'acct_1',
  examined: 10,
  fresh: 4,
  announced: 1,
  readElsewhere: 2,
  tooOld: 1,
  accountMuted: 0,
  senderNotListed: 0,
  forced: 0,
  quiet: 0,
  switchedOff: 0,
  ...over,
})

check('an entry older than a day is dropped', pruneLedger([entry({ at: NOW - 25 * 3600_000 })], NOW).length === 0)
check('an entry inside the day is kept', pruneLedger([entry({ at: NOW - 23 * 3600_000 })], NOW).length === 1)
check(
  'pruning returns the same array when nothing expired, so React can bail out',
  (() => {
    const list = [entry()]
    return pruneLedger(list, NOW) === list
  })(),
)
check(
  'the row cap bites even inside the window',
  appendLedger(
    Array.from({ length: LEDGER_MAX_ENTRIES }, () => entry()),
    entry(),
    NOW,
  ).length === LEDGER_MAX_ENTRIES,
)
check(
  'the cap keeps the newest rows, not the oldest',
  (() => {
    const many = Array.from({ length: LEDGER_MAX_ENTRIES }, (_, i) => entry({ examined: i }))
    const after = appendLedger(many, entry({ examined: 9999 }), NOW)
    return after[after.length - 1].examined === 9999 && after[0].examined === 1
  })(),
)

const sum = summarise(
  [
    entry(),
    entry({ accountId: 'acct_2', announced: 0, quiet: 3, fresh: 3, readElsewhere: 0, tooOld: 0 }),
  ],
  NOW,
)
check('the summary adds the accounts up', sum.fresh === 7 && sum.announced === 1)
check('held back is the sum of every reason', sum.heldBack === 2 + 1 + 3)
check('narrowing to one account excludes the other', summarise([entry(), entry({ accountId: 'acct_2' })], NOW, 'acct_2').syncs === 1)
check('an empty ledger reads as nothing having synced', summarise([], NOW).syncs === 0)
check('the breakdown drops the zeroes', reasons(sum).every((r) => r.count > 0))
check('the breakdown leads with the biggest reason', reasons(sum)[0].id === 'quiet')
check(
  'every printable reason except the window names a switch the user can reach',
  reasons(sum).every((r) => r.id === 'tooOld' || typeof r.fix === 'string'),
)

/*
 * The ledger rides in `AppState`, which is backed up to a file the user can
 * open and synced to their other devices. A diagnostic that carries the
 * mailbox it diagnoses is a leak, so the shape is checked to be counts only.
 */
const LEAKY = ['from', 'to', 'subject', 'snippet', 'messageId', 'id', 'body']
check(
  'a ledger entry carries no sender, subject or snippet',
  LEAKY.every((k) => !(k in entry())),
)

// --- the Java side ----------------------------------------------------------
//
// `InboxSyncRunner` reimplements all three rules for the notification that
// arrives while the app is closed — which is the notification these settings
// are mostly about. A rule honoured here and ignored there is a setting that
// works only while you are looking at the screen.

const javaSignal = readFileSync(
  join(root, 'android/app/src/main/java/dev/aevistle/app/AppSettingsSignal.java'),
  'utf8',
)
const javaRunner = readFileSync(
  join(root, 'android/app/src/main/java/dev/aevistle/app/InboxSyncRunner.java'),
  'utf8',
)

check('the Java side can read a list setting', /static List<String> strings\(/.test(javaSignal))
check('the Java side reads the per-account mute', /accountNotifies\(/.test(javaSignal))
check('the Java side has the allowlist rule', /senderAllowed\(/.test(javaSignal))
check('the Java side has the keyword rule', /keywordHit\(/.test(javaSignal))
check(
  'the Java allowlist anchors a domain entry with a dot, like the TS one',
  /endsWith\("\." \+ entry\)/.test(javaSignal),
)
check(
  'the Java allowlist requires a full match for an address entry',
  /entry\.equals\(address\)/.test(javaSignal),
)
check('the background worker applies the mute', /accountNotifies\(context, accountId\)/.test(javaRunner))
check('the background worker reads the two lists', /notifySenders/.test(javaRunner) && /notifyKeywords/.test(javaRunner))
check('the background worker lets a keyword skip the other rules', /if \(!urgent\) \{/.test(javaRunner))
/*
 * The ordering bug this replaces: quiet hours used to return before any
 * message had been looked at, so a keyword could never override them. A
 * regex on the source is crude and it is the only thing that catches a
 * refactor putting the early return back.
 */
check(
  'the background worker checks quiet hours after building the batch, not before',
  javaRunner.indexOf('anyUrgent && AppSettingsSignal.isQuiet') >
    javaRunner.indexOf('arrivals.add(m)'),
)

// ---------------------------------------------------------------------------

rmSync(out, { recursive: true, force: true })

const label = 'the three "who is worth interrupting me for" rules behave on both platforms'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  const caught = failures.some((f) => f === 'an empty allowlist lets everyone through')
  if (!caught) {
    console.log('\n  SELFTEST FAILED: an inverted empty allowlist was not caught.\n')
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
