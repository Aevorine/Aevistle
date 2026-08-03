/**
 * A dropped mail connection must not crash the app — `npm run check:socket-drop`.
 *
 * The bug this covers shipped and was reported: a modal reading "Aevistle hit an
 * unexpected problem — read ECONNRESET" over an app that was working. Nothing
 * had failed except a connection to a mail server, which is a thing that
 * happens — servers reclaim idle sockets, NAT tables expire, laptops change
 * network — and which every caller here already handles.
 *
 * The cause is a property of EventEmitter rather than of mail. `ImapFlow` is an
 * EventEmitter, and emitting `'error'` with no listener does not return the
 * error, it *throws* it, from whatever turn of the event loop the socket died
 * in. So it never reached the try/catch around any call; it went straight to
 * `uncaughtException`, where the crash reporter made it a dialog.
 *
 * Two things about finding this are worth keeping, because both were nearly
 * missed:
 *
 *   1. The pooled *SMTP* transporter was assumed to be the culprit and a test
 *      was written against it — which passed with the fix removed, because
 *      nodemailer handles its own socket errors internally. Asking both clients
 *      the same question settled it: nodemailer does not throw, ImapFlow does.
 *      **A guard that passes against the broken version is not a guard.**
 *   2. Driving a public function (`testInbox`) also passed without the fix,
 *      because every public function keeps a command in flight, and a command
 *      in flight makes ImapFlow *reject* rather than emit. The case that
 *      crashes is the quiet one in between — which is where the IDLE watcher
 *      spends nearly all of its life.
 *
 * So this connects a real client, lets it go quiet, and resets the socket
 * underneath it. Removing the listener in `imap.ts` must make it fail.
 */

import { build } from 'esbuild'
import net from 'node:net'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

/*
 * Built inside `node_modules` rather than the system temp directory.
 *
 * `imapflow` and `mailparser` stay external — they are CommonJS with
 * conditional requires — and CommonJS is also the bundle format, because
 * imapflow has no named ESM exports and an ESM bundle fails at link time.
 * External only resolves from somewhere `node_modules` is reachable.
 */
const dir = join('node_modules', '.aevistle-check')
await mkdir(dir, { recursive: true })
const bundle = join(dir, 'imap.cjs')
await build({
  entryPoints: ['electron/imap.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  external: ['electron', 'imapflow', 'mailparser', 'nodemailer'],
  logLevel: 'error',
})
const { buildClient } = createRequire(import.meta.url)(resolve(bundle))

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

/** Just enough IMAP to get logged in and into a mailbox. */
const live = new Set()
const server = net.createServer((socket) => {
  live.add(socket)
  socket.on('close', () => live.delete(socket))
  socket.on('error', () => {
    /* the client going away is the point of the test */
  })
  socket.write('* OK fake IMAP ready\r\n')
  socket.on('data', (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const [tag, rawCmd = ''] = line.split(' ')
      const cmd = rawCmd.toUpperCase()
      if (cmd === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=LOGIN\r\n${tag} OK done\r\n`)
      else if (cmd === 'LOGIN') socket.write(`${tag} OK logged in\r\n`)
      else if (cmd === 'ID') socket.write(`* ID NIL\r\n${tag} OK done\r\n`)
      else if (cmd === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`)
      else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        socket.write(`* 0 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 1]\r\n${tag} OK [READ-ONLY] done\r\n`)
      } else socket.write(`${tag} OK done\r\n`)
    }
  })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const { port } = server.address()

const config = {
  accountId: 'drop-test',
  enabled: true,
  // A hostname, not a literal IP: `buildClient` takes the resolved host
  // separately, and `servername` is what TLS identity would be checked against.
  imapHost: 'localhost',
  imapPort: port,
  imapSecurity: 'none',
  imapUsername: 'test@example.com',
  imapAllowInvalidCert: true,
  messages: [],
  pollMinutes: 5,
}

console.log('\n  Dropped mail connections\n')

/*
 * The assertion is "nothing reached the top level", so the failure has to be
 * observed rather than caught — an unhandled `'error'` throws asynchronously
 * and would otherwise take this script down before it could report anything.
 */
let uncaught = null
process.on('uncaughtException', (err) => { uncaught = err })
process.on('unhandledRejection', (err) => { uncaught = err })

const client = buildClient(config, 'hunter2', '127.0.0.1', { port, security: 'none' }, 10_000)

let connected = false
try {
  await client.connect()
  const lock = await client.getMailboxLock('INBOX', { readOnly: true })
  lock.release()
  connected = true
} catch (err) {
  console.log(`    (could not reach the fake server: ${err?.message ?? err})`)
}

check('a client built by imap.ts connects', connected)
check('the server sees the connection', live.size === 1, `${live.size} socket(s)`)

/*
 * The event under test: the server reclaims the connection while the client is
 * sitting quiet. A reset rather than a clean close — that is what a server
 * timing out a connection sends, and what surfaces as `read ECONNRESET`.
 */
for (const socket of live) {
  if (socket.resetAndDestroy) socket.resetAndDestroy()
  else socket.destroy()
}

await new Promise((r) => setTimeout(r, 1500))

check(
  'the reset did not reach the top-level handler',
  uncaught === null,
  uncaught ? `${uncaught.code ?? ''} ${uncaught.message ?? uncaught}`.trim() : '',
)

try {
  client.close()
} catch {
  /* already gone */
}
await new Promise((done) => server.close(done))
await rm(bundle, { force: true })

console.log(`\n  ${failed === 0 ? 'All clear.' : `${failed} failed.`}\n`)
process.exit(failed === 0 ? 0 : 1)
