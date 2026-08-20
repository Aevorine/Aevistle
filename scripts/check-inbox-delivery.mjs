/**
 * Mail that arrives is either announced or accounted for — `npm run check:inbox-delivery`.
 *
 * Four consecutive releases shipped a fix for "new mail raises nothing" and the
 * user reported, after every one of them, that new mail still raised nothing.
 * That was not four wrong fixes. It was one missing instrument: the decision to
 * announce was made by a pure function whose answer was thrown away, so the
 * only way to test any of those fixes was to wait for real mail and watch a
 * corner of the screen. When nothing happened, the six possible causes were
 * indistinguishable, and the next release picked one and guessed.
 *
 * What the evidence eventually showed, on the reporting install: five accounts,
 * 187 cached messages, **187 of them already `\Seen`** — confirmed independently
 * against the provider's own API, which reported zero unread. Rule 2 of
 * `newArrivals` ("mail read somewhere else is not an event here") was therefore
 * eating one hundred percent of arrivals, permanently, on every device at once,
 * while the mail itself fetched and listed perfectly. Windows had delivered
 * forty Aevistle toasts in total and the most recent one predated three
 * separate arrivals.
 *
 * So this gate holds two things at once:
 *
 *   1. **The decision is complete.** Every message a sync brings back lands in
 *      exactly one bucket — announced, already known, read elsewhere, too old —
 *      and the buckets add up. A message that falls out of the count is a
 *      message nobody can explain the silence of.
 *   2. **The escape hatch works and is narrow.** `includeRead` turns off rule 2
 *      and *only* rule 2: an unprimed first sync still announces nothing, a
 *      week-old message is still not news, and a message we already knew about
 *      is still not new.
 *
 * Plus the wiring, because a correct decision nobody records is the failure
 * this project keeps re-finding: the report has to be computed *before* the
 * settings gate and the quiet-hours gate, or the trace can never say which of
 * the two silenced a notification.
 *
 * `--selftest` makes `includeRead` a no-op — the state this code was in when
 * the bug was reported — and requires this to go red.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync as readRaw, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/*
 * Line endings normalised at the door.
 *
 * These files are checked out CRLF on Windows, so a source assertion anchored
 * on a newline followed by two spaces and a bracket matches nothing at all —
 * which reads as nine confident failures against code that is correct. A gate
 * that goes red for a reason unrelated to what it measures is worse than no
 * gate, because the cheapest way to make it green is to delete it.
 */
const readFileSync = (path, enc) => readRaw(path, enc).split('\r\n').join('\n')

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const selftest = process.argv.includes('--selftest')

let failed = 0
let checked = 0
const check = (what, ok, detail = '') => {
  checked++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// --- build the decision module ---------------------------------------------

const out = join(root, 'node_modules', '.aevistle-delivery')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'src/core/mail/newMail.ts')}"`,
      '--format=esm',
      '--platform=node',
      `--outfile="${join(out, 'newMail.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

if (selftest) {
  const src = readRaw(join(out, 'newMail.mjs'), 'utf8')
  const broken = src.replace('m.seen && !opts.includeRead', 'm.seen')
  if (broken === src) {
    console.error('selftest could not find the rule to break — this gate is pointing at nothing')
    process.exit(1)
  }
  writeFileSync(join(out, 'newMail.mjs'), broken, 'utf8')
}

const { explainArrivals, newArrivals, NEW_MAIL_WINDOW_MS } = await import(
  pathToFileURL(join(out, 'newMail.mjs')).href
)

// --- fixtures ---------------------------------------------------------------

const NOW = 1_760_000_000_000
const msg = (id, opts = {}) => ({
  id,
  accountId: 'a',
  folderPath: 'INBOX',
  uid: Number(id.replace(/\D/g, '')) || 1,
  uidValidity: 1,
  from: 'Someone <s@example.com>',
  to: 'me@example.com',
  subject: `subject ${id}`,
  date: opts.date ?? NOW - 60_000,
  snippet: 'body',
  sizeBytes: 100,
  hasAttachments: false,
  seen: opts.seen ?? false,
  tag: 'none',
  bodyCached: false,
})

const base = (over = {}) => ({
  before: new Set(),
  after: [],
  now: NOW,
  primed: true,
  ...over,
})

// --- the decision is complete ----------------------------------------------

console.log('\n  Every message lands in exactly one bucket\n')

{
  const after = [
    msg('m1'), // new, unread, recent  -> announced
    msg('m2', { seen: true }), // read elsewhere
    msg('m3', { date: NOW - 5 * NEW_MAIL_WINDOW_MS }), // too old
    msg('m4'), // already known
  ]
  const r = explainArrivals(base({ after, before: new Set(['m4']) }))
  check('examined counts everything the sync returned', r.examined === 4, `got ${r.examined}`)
  check('a message already in the baseline is not fresh', r.fresh === 3, `got ${r.fresh}`)
  check(
    'the buckets partition the fresh messages',
    r.arrivals.length + r.readElsewhere + r.tooOld === r.fresh,
    `${r.arrivals.length} + ${r.readElsewhere} + ${r.tooOld} vs ${r.fresh} — ` +
      'a message in no bucket is silence nobody can explain',
  )
  check('the unread recent one is announced', r.arrivals.length === 1 && r.arrivals[0].id === 'm1')
  check('the read one is attributed to "read elsewhere"', r.readElsewhere === 1)
  check('the old one is attributed to "too old"', r.tooOld === 1)
}

{
  // Read *and* old: attributed once, to the first rule that drops it, or the
  // counts stop adding up and the report starts overstating both causes.
  const r = explainArrivals(
    base({ after: [msg('m9', { seen: true, date: NOW - 5 * NEW_MAIL_WINDOW_MS })] }),
  )
  check(
    'a message two rules would drop is counted once',
    r.readElsewhere + r.tooOld === 1,
    `readElsewhere=${r.readElsewhere} tooOld=${r.tooOld}`,
  )
}

{
  const r = explainArrivals(base({ after: [msg('m1'), msg('m2')], primed: false }))
  check('an unprimed sync announces nothing', r.arrivals.length === 0)
  check(
    'an unprimed sync still reports what it saw',
    r.examined === 2 && r.fresh === 2 && r.primed === false,
    'otherwise the first sync of a session is indistinguishable from an empty mailbox',
  )
}

// --- the escape hatch -------------------------------------------------------

console.log('\n  Announcing mail another device already read\n')

{
  const after = [msg('m1', { seen: true })]
  const off = explainArrivals(base({ after }))
  const on = explainArrivals(base({ after, includeRead: true }))
  check(
    'off by default: a read arrival is held back',
    off.arrivals.length === 0 && off.readElsewhere === 1,
  )
  check(
    'on: the same arrival is announced',
    on.arrivals.length === 1 && on.readElsewhere === 0,
    // The whole point. With a phone marking everything read within seconds,
    // this switch is the difference between the feature working and the
    // feature being mathematically unable to fire.
    'this is the rule that was silencing 187 of 187 messages',
  )
}

{
  const on = { includeRead: true }
  check(
    'it does not resurrect a message we already knew about',
    explainArrivals(base({ after: [msg('m1', { seen: true })], before: new Set(['m1']), ...on }))
      .arrivals.length === 0,
  )
  check(
    'it does not widen the recency window',
    explainArrivals(
      base({ after: [msg('m1', { seen: true, date: NOW - 5 * NEW_MAIL_WINDOW_MS })], ...on }),
    ).arrivals.length === 0,
  )
  check(
    'it does not announce on an unprimed first sync',
    explainArrivals(base({ after: [msg('m1', { seen: true })], primed: false, ...on })).arrivals
      .length === 0,
    'otherwise adding an account recites the whole mailbox',
  )
}

// --- the old entry point is unchanged --------------------------------------

console.log('\n  The existing rules still mean what they meant\n')

{
  const after = [msg('m1'), msg('m2', { seen: true }), msg('m3', { date: NOW - 5 * NEW_MAIL_WINDOW_MS })]
  const arrivals = newArrivals(base({ after }))
  check(
    'newArrivals still drops read and old mail',
    arrivals.length === 1 && arrivals[0].id === 'm1',
    'check-new-mail.mjs measures this function; it must not have changed shape',
  )
  check('newArrivals still sorts newest first', (() => {
    const sorted = newArrivals(
      base({ after: [msg('a1', { date: NOW - 600_000 }), msg('a2', { date: NOW - 60_000 })] }),
    )
    return sorted.length === 2 && sorted[0].id === 'a2'
  })())
}

// --- the mailbox is opened for reading -------------------------------------

console.log('\n  A sync cannot change the mailbox\n')

{
  const imap = readFileSync(join(root, 'electron/imap.ts'), 'utf8')
  check(
    'the sync selects INBOX read-only',
    /getMailboxLock\(INBOX_PATH,\s*\{\s*readOnly:\s*true\s*\}\)/.test(imap) &&
      !/getMailboxLock\(INBOX_PATH\)(?!\s*,)/.test(imap),
    // SELECT lets a server set \Seen on a fetch; EXAMINE forbids it. Nothing
    // here fetches without BODY.PEEK today, and "as long as nobody adds one" is
    // not a property worth relying on when the failure is mail marked read
    // across every device by an app that was only looking.
    'EXAMINE, not SELECT — see the comment at that line',
  )
  check(
    'bodies are still fetched with PEEK',
    /BODY\.PEEK\[\]/.test(imap),
    'a non-peek fetch marks mail read on the server for every device at once',
  )
  const writePaths = imap.match(/getMailboxLock\((?!INBOX_PATH,)[^)]*\)/g) ?? []
  check(
    'the only read-write locks are the flag-writing ones',
    writePaths.every((m) => /readOnly/.test(m) || /folderPath\)/.test(m)),
    `saw ${writePaths.length} non-INBOX locks`,
  )
}

// --- the wiring -------------------------------------------------------------

console.log('\n  The decision is written down\n')

{
  const app = readFileSync(join(root, 'src/state/AppState.tsx'), 'utf8')
  const announce = /const announceNewMail = useCallback\([\s\S]*?\n  \)\n/.exec(app)?.[0] ?? ''

  check('the announce path asks for a report', /explainArrivals\(/.test(announce))
  check(
    'the report is computed before the settings and quiet gates',
    announce.indexOf('explainArrivals(') > 0 &&
      announce.indexOf('explainArrivals(') < announce.indexOf('notifyOnNewMail === false'),
    // Gating first costs nothing and hides everything: "no notification" then
    // cannot be told apart from "setting off" or "quiet hours".
    'otherwise the trace can never name which gate silenced it',
  )
  check(
    'both gates are recorded rather than returned from',
    /withheld[\s\S]{0,200}?'off'[\s\S]{0,200}?'quiet'/.test(announce),
  )
  check('the trace is called on every decision', /traceDelivery\(/.test(announce))
  check(
    'the user’s choice reaches the rule',
    /includeRead:\s*settings\.notifyReadElsewhere === true/.test(announce),
    'a setting the decision never reads is a switch that does nothing',
  )

  const trace = /const traceDelivery = useCallback\([\s\S]*?\n  \)\n/.exec(app)?.[0] ?? ''
  check('there is a trace to call', trace.length > 0)
  check(
    'a sync with nothing to decide writes nothing',
    /if \(announced === 0 && suppressed === 0 && !unprimed\) return/.test(trace),
    // One minute times five accounts is 7,200 rows a day, which would push the
    // sends this log exists for straight off the end of the retention window.
    'a log that records every tick is a log that deletes the evidence',
  )
  check(
    'the trace carries counts, not mail',
    !/subject|snippet|senderName|\.from\b/.test(trace),
    'the activity log is exportable as CSV',
  )
  check("the trace is an 'inbox' entry", /kind: 'inbox'/.test(trace))
  check(
    'each rule has its own line',
    ['announced', 'readElsewhere', 'tooOld', 'notPrimed', 'off', 'quiet'].every((k) =>
      trace.includes(`inbox.trace.${k}`),
    ),
  )
  check(
    'the trace is in the announce callback’s dependencies',
    (app.match(/\[[^[\]]*\]/g) ?? []).some(
      (deps) => /\btraceDelivery\b/.test(deps) && /\bi18n\b/.test(deps),
    ),
    /*
     * The dependency *list*, not the exact text of it.
     *
     * This used to match the literal `[bridge, i18n, traceDelivery]`, which
     * made it a gate on a string rather than on a property: adding a fourth
     * legitimate dependency turned it red, and — far worse — reordering the
     * three while dropping one would have kept it green in some spellings.
     * What matters is that `traceDelivery` is in there at all; a stale closure
     * would log against the wrong account label.
     */
    'a stale closure here would log against the wrong account label',
  )
}

{
  const logs = readFileSync(join(root, 'src/views/LogsView.tsx'), 'utf8')
  check(
    'the activity log can show only the receiving side',
    /filter === 'inbox'[\s\S]{0,80}?kind === 'inbox'/.test(logs) &&
      /logs\.filterInbox/.test(logs),
    'a record nothing can display is not a record',
  )
  const settings = readFileSync(join(root, 'src/views/SettingsView.tsx'), 'utf8')
  check(
    'the switch exists and is reachable',
    /notifyReadElsewhere/.test(settings) && /patch\(\{ notifyReadElsewhere: v \}\)/.test(settings),
  )
}

// --- and the same on the phone ---------------------------------------------

console.log('\n  The phone obeys the same switches\n')

{
  const runner = readFileSync(
    join(root, 'android/app/src/main/java/dev/aevistle/app/InboxSyncRunner.java'),
    'utf8',
  )
  const announce = /private static void announce\([\s\S]*?\n    \}\n/.exec(runner)?.[0] ?? ''
  check('there is an announce path to check', announce.length > 0)
  check(
    'the phone honours "announce new mail"',
    /flag\(context, "notifyOnNewMail", true\)/.test(announce),
    // It read none of these. A switch that works only while the app is open is
    // a switch that does nothing, since the notifications it governs are the
    // ones raised while it is closed.
    'it was ignored entirely by the background path',
  )
  check('the phone honours quiet hours', /isQuiet\(context, now\)/.test(announce))
  check(
    'the phone honours "announce mail read elsewhere"',
    /flag\(context, "notifyReadElsewhere", false\)/.test(announce) &&
      /optBoolean\("seen", false\) && !includeRead/.test(announce),
  )
  check(
    'the two platforms default the same way',
    /"notifyOnNewMail", true/.test(announce) && /"notifyReadElsewhere", false/.test(announce),
    'a default that differs by platform is a bug report nobody can reproduce',
  )

  const signal = readFileSync(
    join(root, 'android/app/src/main/java/dev/aevistle/app/AppSettingsSignal.java'),
    'utf8',
  )
  check(
    'an absent setting falls back to the app default, not to false',
    /if \(settings == null \|\| settings\.isNull\(key\)\) return fallback;/.test(signal),
    'a state file written before the setting existed must not silence the app',
  )
  check(
    'an unreadable quiet window fails open',
    /if \(start < 0 \|\| end < 0 \|\| start == end\) return false;/.test(signal),
    'holding mail back because a time string would not parse is the worst outcome',
  )
  check(
    'a quiet window that wraps midnight is handled',
    /now >= start \|\| now < end/.test(signal),
    '22:00–07:00 is the shape almost everyone picks',
  )
}

// --- verdict ----------------------------------------------------------------

const label = 'mail that arrives is either announced or accounted for'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: rule 2 silencing every arrival was not caught.\n')
    process.exit(1)
  }
  console.log('  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} checks${failed ? `, ${failed} failed` : ''}\n`)
if (failed === 0) console.log('  All clear.\n')
process.exit(failed === 0 ? 0 : 1)
