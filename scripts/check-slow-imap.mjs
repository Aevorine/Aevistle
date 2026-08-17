/**
 * A slow mail server must not read as a broken one — `npm run check:slow-imap`.
 *
 * The bug this covers was live on a real install for three days, and its shape
 * is the reason it is worth a gate rather than a comment.
 *
 * Five accounts, four syncing every minute, one that had not synced since
 * Friday. Its stored error said `TimeoutError: No answer from the server
 * within 10 seconds`, which reads as "that mailbox is unreachable". It was
 * not. Probing the same account with the same stored credential and a generous
 * deadline, it connected and authenticated fine — in **36.7 s**, against 1-5 s
 * for the other four on the same provider and port. The app's per-rung slice is
 * `rungBudgetMs(totalBudgetMs(30), 3)` = 10 s, so every rung timed out, every
 * sync failed, no new mail was ever seen, and no notification was ever raised.
 * Nothing logged a problem, because from the app's point of view nothing had
 * gone wrong twice in a row that it did not already have a word for.
 *
 * So `withConnection` gains one patient retry of the configured endpoint when
 * that endpoint ran out of time. Two things about it need holding in place:
 *
 *   1. **It has to fire.** The first draft gated the retry on `lastError`
 *      being a `TimeoutError`, which looks right and is wrong for every
 *      account with an endpoint ladder: rung 1 (993/ssl) is the one that
 *      stalls, rungs 2 and 3 are guesses a real provider refuses in
 *      milliseconds, so `lastError` is an ECONNREFUSED from a port nobody
 *      configured. The retry would never have run on the account it was
 *      written for. This file is what caught that.
 *   2. **It has to stay bounded.** One retry, of rung 1 only. Ninety seconds
 *      per rung across a three-rung ladder is a four-minute sync, which is a
 *      worse failure than the one being fixed.
 *
 * `--selftest` reverts the retry to the `lastError` form and requires this to
 * go red.
 */

import { build } from 'esbuild'
import net from 'node:net'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const selftest = process.argv.includes('--selftest')

// Same arrangement, and for the same reasons, as `check-socket-drop.mjs`:
// built inside `node_modules` so the external CommonJS deps resolve.
const dir = join('node_modules', '.aevistle-check')
await mkdir(dir, { recursive: true })
const bundle = join(dir, 'imap-slow.cjs')

let source = await readFile('electron/imap.ts', 'utf8')
if (selftest) {
  source = source.replace('if (patient && configuredRungTimedOut) {', 'if (patient && lastError instanceof TimeoutError) {')
}

await build({
  stdin: { contents: source, resolveDir: resolve('electron'), sourcefile: 'imap.ts', loader: 'ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  external: ['electron', 'imapflow', 'mailparser', 'nodemailer'],
  logLevel: 'error',
})
const { syncInbox } = createRequire(import.meta.url)(resolve(bundle))

let failed = 0
const checks = []
const check = (name, ok, detail = '') => {
  checks.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

/**
 * An IMAP server that stalls at LOGIN on its first connection and is healthy on
 * every one after it.
 *
 * At LOGIN, not at the greeting, and the difference decides whether this test
 * reproduces the reported failure at all. imapflow enforces its own
 * `greetingTimeout` — which `buildClient` caps at 10 s — so a server that never
 * says hello is rejected by the *library* with `GREETING_TIMEOUT`, before
 * `withDeadline` has anything to say. The account that prompted this got its
 * greeting promptly and then took 36.7 s to finish authenticating, which is the
 * one shape that reaches our own deadline and produces the `TimeoutError` the
 * retry keys on. A first draft of this file stalled the greeting instead, and
 * passed for the wrong reason.
 *
 * Stalling rather than sleeping a fixed number of seconds: the client's
 * deadline is what ends the attempt, so this costs one rung budget of wall
 * clock and stays correct if that budget ever changes.
 */
let connections = 0
const server = net.createServer((socket) => {
  connections++
  const stallLogin = connections === 1
  socket.on('error', () => {
    /* the client giving up is the case under test */
  })

  socket.write('* OK fake IMAP ready\r\n')
  socket.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const [tag, rawCmd = ''] = line.split(' ')
      const cmd = rawCmd.toUpperCase()
      if (process.env.SLOW_IMAP_TRACE) console.log(`    [conn ${connections}] ${line.slice(0, 60)}`)
      if (cmd === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=LOGIN\r\n${tag} OK done\r\n`)
      else if (cmd === 'LOGIN' || cmd === 'AUTHENTICATE') {
        /*
         * Both spellings. imapflow sends `AUTHENTICATE LOGIN` when the server
         * advertises an `AUTH=` mechanism (this one does, two lines up) and a
         * bare `LOGIN` when it does not. Stalling only the spelling it does not
         * use is not a stall at all — an earlier draft matched `LOGIN` alone,
         * the client authenticated normally, and the test reported success on
         * the first connection while claiming to have proved a retry.
         */
        if (stallLogin) return // the reported failure, exactly: hello, then nothing
        socket.write(`${tag} OK logged in\r\n`)
      } else if (cmd === 'ID') socket.write(`* ID NIL\r\n${tag} OK done\r\n`)
      else if (cmd === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`)
      else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        socket.write(`* 0 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 1]\r\n${tag} OK [READ-ONLY] done\r\n`)
      } else if (cmd === 'SEARCH' || cmd === 'UID') socket.write(`* SEARCH\r\n${tag} OK done\r\n`)
      else socket.write(`${tag} OK done\r\n`)
    }
  })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const { port } = server.address()

const config = {
  accountId: 'slow-test',
  enabled: true,
  imapHost: 'localhost',
  imapPort: port,
  imapSecurity: 'none',
  imapUsername: 'test@example.com',
  imapAllowInvalidCert: true,
  messages: [],
  folders: [],
  pollMinutes: 5,
}

console.log('\n  A slow mail server is not a broken one\n')

const started = Date.now()
let synced = null
let error = null
try {
  synced = await syncInbox(config, 'hunter2')
} catch (e) {
  error = e
}
const elapsed = Date.now() - started

check(
  'a sync survives an endpoint that answered nothing on the first attempt',
  synced !== null,
  error ? `${error.name}: ${error.message}` : `${Math.round(elapsed / 1000)}s`,
)
check(
  'and it got there by retrying, not by a lucky first connection',
  connections >= 2,
  `${connections} connection(s)`,
)
// Two rungs plus one patient retry. A fourth connection would mean the retry
// had been let loose on the whole ladder, which is the four-minute sync this
// is deliberately not.
check(
  'and the retry is bounded to one, not one per rung',
  connections <= 3,
  `${connections} connection(s)`,
)

server.close()

console.log('')

if (selftest) {
  console.log(`  ${checks.length} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: the lastError-gated retry was not caught.\n')
    process.exit(1)
  }
  console.log('  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

if (failed === 0) {
  console.log(`  ${checks.length} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`  ${checks.length} checks, ${failed} failed\n`)
process.exit(1)
