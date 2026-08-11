/**
 * Round-trip check for backup export and restore — `npm run check:backup`.
 *
 * Two properties matter and neither is visible from the UI:
 *
 *   1. A password never leaves the machine. The keystore is not in application
 *      state, but `hasSecret` is, and a `true` carried into a restore makes
 *      the app believe a password exists that does not — an account that looks
 *      configured and fails at 3am.
 *   2. Merging does not lose what was already there. That is the whole reason
 *      merge is the default, and it is exactly the kind of thing that quietly
 *      regresses.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'aevistle-backup-'))
const bundle = join(dir, 'backup.mjs')
await build({
  entryPoints: ['src/core/ops/backup.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { applyBackup, buildBackup, readBackup, summarise } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const account = (id, hasSecret) => ({
  id, label: id, fromName: 'x', fromAddress: `${id}@example.com`, host: 'h', port: 465,
  security: 'tls', username: 'u', authMethod: 'login', hasSecret,
})
const job = (id, attachments = 0) => ({
  id, name: id, enabled: true,
  draft: { to: ['a@example.com'], cc: [], bcc: [], subject: id, body: '', bodyFormat: 'plain',
           attachments: Array.from({ length: attachments }, (_, i) => ({ id: `at${i}` })),
           accountId: 'a1', priority: 'normal', requestReadReceipt: false, individualDelivery: false },
  recurrence: { kind: 'once', startAt: 1, timeOfDay: '09:00', monthDayFallback: 'skip' },
  occurrences: [], runCount: 0, retry: {}, status: 'armed', createdAt: 0, updatedAt: 0,
})

const source = {
  accounts: [account('a1', true), account('a2', true)],
  jobs: [job('j1', 2), job('j2')],
  contacts: [{ id: 'c1', name: 'One', address: 'one@example.com', tags: [] }],
  templates: [{ id: 't1', name: 'T', subject: 'S', body: 'B' }],
  logs: [{ id: 'l1', at: 1, kind: 'send', level: 'info', title: 'secret@example.com' }],
  settings: { themeMode: 'dark', accent: 'rose' },
  draft: {},
  inboxAccounts: [{ accountId: 'a1', messages: [{ id: 'm1', subject: 'private mail' }] }],
  schemaVersion: 2,
}

const checks = []
const check = (name, condition, detail = '') => checks.push({ name, ok: !!condition, detail })

// --- export ---------------------------------------------------------------
const file = buildBackup(source, '0.1.0')
const text = JSON.stringify(file)

check('no cached mail in the file', !text.includes('private mail'))
check('no activity log in the file', !text.includes('secret@example.com'))
check('hasSecret is cleared on export', file.accounts.every((a) => a.hasSecret === false))
check('accounts, jobs, contacts, templates all present',
  file.accounts.length === 2 && file.jobs.length === 2 &&
  file.contacts.length === 1 && file.templates.length === 1)

// --- read back ------------------------------------------------------------
const parsed = readBackup(text)
check('round-trips', parsed.accounts.length === 2 && parsed.jobs.length === 2)
check('hasSecret still false after reading', parsed.accounts.every((a) => a.hasSecret === false))

const summary = summarise(parsed)
check('summary counts the attachments that will not travel',
  summary.jobsWithAttachments === 1, `got ${summary.jobsWithAttachments}`)
check('summary counts accounts needing a password', summary.needPassword === 2)

// --- rejection ------------------------------------------------------------
for (const [label, input] of [
  ['not JSON', 'hello'],
  ['JSON but not a backup', '{"hello":1}'],
  ['a newer format', JSON.stringify({ kind: 'aevistle.backup', version: 999 })],
]) {
  let threw = ''
  try { readBackup(input) } catch (e) { threw = e.message }
  check(`rejects ${label} with a readable message`, threw && !/JSON\.parse|position \d/.test(threw), threw)
}

// --- merge ----------------------------------------------------------------
const existing = {
  ...source,
  accounts: [account('a3', true)],
  jobs: [job('j3')],
  contacts: [{ id: 'c9', name: 'Mine', address: 'mine@example.com', tags: [] }],
  templates: [],
  settings: { themeMode: 'light', accent: 'teal' },
}
const merged = applyBackup(existing, parsed, 'merge')
check('merge keeps what was already here',
  merged.jobs.some((j) => j.id === 'j3') && merged.contacts.some((c) => c.id === 'c9'))
check('merge adds what was in the file',
  merged.jobs.some((j) => j.id === 'j1') && merged.accounts.some((a) => a.id === 'a1'))
check('merge leaves local preferences alone', merged.settings.themeMode === 'light')

const replaced = applyBackup(existing, parsed, 'replace')
check('replace discards what was here', !replaced.jobs.some((j) => j.id === 'j3'))
check('replace takes the file’s settings', replaced.settings.themeMode === 'dark')

// --- report ---------------------------------------------------------------
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok   ' : 'FAIL '} ${c.name}${c.ok || !c.detail ? '' : `  (${c.detail})`}`)
}
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exit(1)
