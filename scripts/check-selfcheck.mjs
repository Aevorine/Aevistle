#!/usr/bin/env node
/**
 * The self-check's own self-check.
 *
 * `core/selfcheck.ts` decides, for every layer between the compose screen and
 * the mail server, whether it passed, warned, failed, or did not apply. Those
 * verdicts are the entire product: a user arrives at that panel having already
 * concluded the app is broken, and what they do next is whatever the first
 * non-passing row tells them to. A verdict that is merely plausible sends them
 * to re-enter a password that was never the problem.
 *
 * So the rules are tested here rather than trusted. Every case below is one a
 * real device produces, and each asserts the distinction that case exists to
 * make — most importantly the three that are easy to collapse into each other:
 *
 *   - `skip` must never read as `pass`. A check that did not run has found
 *     nothing, and a row of ticks that includes untested layers is a report
 *     that argues with the user about their own experience.
 *   - a dead layer must silence the layers above it, not fail them. An SMTP
 *     test that could not run says nothing about SMTP.
 *   - "we could not ask" must not become "the answer is no".
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href)

const bundle = path.join(ROOT, 'node_modules', '.cache-selfcheck.mjs')
await build({
  entryPoints: [path.join(ROOT, 'src/core/selfcheck.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
})
const { runSelfCheck, summarise, missingAccountFields } = await import(pathToFileURL(bundle).href)

let checks = 0
let failed = 0
const ok = (label, cond, detail = '') => {
  checks++
  if (cond) return
  failed++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** A healthy Android device with one working password account. */
function facts(over = {}) {
  return {
    platform: 'android',
    native: 'ok',
    permissions: { notifications: 'granted', exactAlarms: 'granted' },
    accounts: [
      {
        id: 'a1',
        label: 'Work',
        authMethod: 'password',
        missingFields: [],
        hasSecret: true,
        imapConfigured: true,
        smtp: { ok: true },
        imap: { ok: true },
      },
    ],
    enabledJobs: 2,
    armedJobs: 2,
    deadOutbox: 0,
    ...over,
  }
}

const status = (rows, id) => rows.find((r) => r.id === id)?.status
const row = (rows, id) => rows.find((r) => r.id === id)

console.log('\n  the mail self-check reaches the right verdicts\n')

// --- the happy path ---------------------------------------------------------
{
  const rows = runSelfCheck(facts())
  ok('a healthy device reports no failures', summarise(rows).fail === 0)
  ok('...and no warnings', summarise(rows).warn === 0)
  ok('...and nothing to act on', summarise(rows).firstProblem === undefined)
}

// --- the failure this panel was written for ---------------------------------
{
  const rows = runSelfCheck(facts({ native: 'missing' }))
  ok('a missing native bridge fails', status(rows, 'native') === 'fail')
  ok(
    'the live SMTP probe is SKIPPED, not failed, when the bridge is down',
    status(rows, 'smtp:a1') === 'skip',
    `got ${status(rows, 'smtp:a1')} — a failure here would blame the mail server for a broken install`,
  )
  ok('the live IMAP probe is skipped too', status(rows, 'imap:a1') === 'skip')
  ok(
    'the bridge is the first thing to act on',
    summarise(rows).firstProblem?.id === 'native',
    'ordering is the panel’s whole contract: the first problem must be the deepest one',
  )
  ok('the bridge row carries a hint', Boolean(row(rows, 'native').hintKey))
}

// --- "we could not ask" is not "no" -----------------------------------------
{
  const rows = runSelfCheck(
    facts({ accounts: [{ ...facts().accounts[0], hasSecret: undefined, smtp: undefined, imap: undefined }] }),
  )
  ok('an unasked credential is skipped, not failed', status(rows, 'cred:a1') === 'skip')
  ok('an unrun SMTP probe is skipped, not failed', status(rows, 'smtp:a1') === 'skip')
  ok('nothing is reported as failing', summarise(rows).fail === 0)
}

// --- a genuinely missing password -------------------------------------------
{
  const rows = runSelfCheck(facts({ accounts: [{ ...facts().accounts[0], hasSecret: false }] }))
  ok('a missing password fails', status(rows, 'cred:a1') === 'fail')
  ok('...with advice attached', row(rows, 'cred:a1').hintKey === 'selfcheck.credentialHint')
}

// --- OAuth states -----------------------------------------------------------
{
  const oauth = (state) => ({
    ...facts().accounts[0],
    authMethod: 'oauth2',
    hasSecret: undefined,
    oauthState: state,
  })
  ok('a connected grant passes', status(runSelfCheck(facts({ accounts: [oauth('connected')] })), 'cred:a1') === 'pass')
  ok(
    'a disconnected grant fails',
    status(runSelfCheck(facts({ accounts: [oauth('disconnected')] })), 'cred:a1') === 'fail',
  )

  // The distinction that matters most: a build with no client id registered is
  // not something the user can fix by signing in again, and must not say so.
  const unconfigured = runSelfCheck(facts({ accounts: [oauth('unconfigured')] }))
  ok('an unconfigured build fails', status(unconfigured, 'cred:a1') === 'fail')
  ok(
    '...and says it is the build, not the user’s password',
    row(unconfigured, 'cred:a1').hintKey === 'selfcheck.credentialUnconfiguredHint',
    'telling this user to sign in again sends them somewhere nothing can be fixed',
  )
}

// --- an account that authenticates by IP ------------------------------------
{
  const relay = { ...facts().accounts[0], authMethod: 'none', hasSecret: undefined }
  const rows = runSelfCheck(facts({ accounts: [relay] }))
  ok('an unauthenticated relay skips the credential row', status(rows, 'cred:a1') === 'skip')
  ok('...and is not reported as broken', summarise(rows).fail === 0)
  ok(
    'missingAccountFields does not demand a username for it',
    !missingAccountFields({
      host: 'smtp.example.com',
      port: 25,
      fromAddress: 'a@example.com',
      username: '',
      authMethod: 'none',
    }).includes('username'),
  )
  ok(
    '...but does demand one otherwise',
    missingAccountFields({
      host: 'smtp.example.com',
      port: 25,
      fromAddress: 'a@example.com',
      username: '',
      authMethod: 'password',
    }).includes('username'),
  )
}

// --- IMAP that was never set up ---------------------------------------------
{
  const rows = runSelfCheck(
    facts({ accounts: [{ ...facts().accounts[0], imapConfigured: false, imap: undefined }] }),
  )
  ok('an account with no inbox skips the IMAP row', status(rows, 'imap:a1') === 'skip')
  ok('...and still runs SMTP', status(rows, 'smtp:a1') === 'pass')
}

// --- permissions ------------------------------------------------------------
{
  const denied = runSelfCheck(facts({ permissions: { notifications: 'blocked', exactAlarms: 'denied' } }))
  ok('blocked notifications warn rather than fail', status(denied, 'notifications') === 'warn')
  ok(
    'denied exact alarms warn rather than fail',
    status(denied, 'exactAlarms') === 'warn',
    'mail still arrives, just late — calling that a failure teaches users to ignore this panel',
  )

  // Below Android 12 there is no such permission to hold. That is a pass, not
  // a "not applicable" that sends someone hunting for a missing setting.
  const old = runSelfCheck(facts({ permissions: { notifications: 'granted', exactAlarms: 'not-required' } }))
  ok('an Android version that needs no exact-alarm permission passes', status(old, 'exactAlarms') === 'pass')
  ok('...with nothing to do about it', row(old, 'exactAlarms').hintKey === undefined)
}

// --- the silent one ---------------------------------------------------------
{
  // Everything green, nothing sent: jobs enabled, none with a next occurrence.
  const rows = runSelfCheck(facts({ enabledJobs: 3, armedJobs: 0 }))
  ok('jobs switched on with no next send is a failure', status(rows, 'armed') === 'fail')
  ok('...and says how many', row(rows, 'armed').detail === '0/3')
  ok('every other layer still passes', summarise(rows).fail === 1)

  ok('no enabled jobs is not a failure', status(runSelfCheck(facts({ enabledJobs: 0, armedJobs: 0 })), 'armed') === 'skip')
}

// --- outbox -----------------------------------------------------------------
{
  const rows = runSelfCheck(facts({ deadOutbox: 4 }))
  ok('a dead outbox warns', status(rows, 'outbox') === 'warn')
  ok('...and says how many', row(rows, 'outbox').detail === '4')
}

// --- no accounts at all -----------------------------------------------------
{
  const rows = runSelfCheck(facts({ accounts: [] }))
  ok('no accounts is a failure', status(rows, 'accounts') === 'fail')
  ok('...and no per-account rows are invented', rows.every((r) => !r.id.includes(':')))
}

// --- the browser preview ----------------------------------------------------
{
  const rows = runSelfCheck(facts({ platform: 'web', native: 'ok', permissions: undefined }))
  ok('the browser preview warns about itself', status(rows, 'platform') === 'warn')
  ok('...rather than pretending to be a device', Boolean(row(rows, 'platform').hintKey))
  ok('...and does not claim a native bridge it never checked', row(rows, 'native') === undefined)

  const desktop = runSelfCheck(facts({ platform: 'desktop', permissions: undefined }))
  ok('the desktop build passes its platform row', status(desktop, 'platform') === 'pass')
  ok('...and has no Android permission rows', row(desktop, 'notifications') === undefined)
}

// --- the report must not argue with itself ----------------------------------
{
  /*
   * Found by running the panel rather than by reading it. In the browser
   * preview the platform row says "mail checks are skipped here" — and the
   * first version then ran them anyway, so three SMTP rows underneath it read
   * "failed", each quoting the preview's own refusal as though a server had
   * rejected a password. A user seeing that goes and checks their mail
   * settings, which is the one place the fault definitely is not.
   *
   * The facts here are deliberately the ones the preview really produces: the
   * probes *did* run and *did* come back false, and the verdict must still be
   * `skip`, because what they measured was the absence of an engine.
   */
  const preview = runSelfCheck(
    facts({
      platform: 'web',
      permissions: undefined,
      accounts: [
        {
          ...facts().accounts[0],
          hasSecret: false,
          smtp: { ok: false, error: 'Browser preview cannot open an SMTP connection.' },
          imap: { ok: false, error: 'Browser preview cannot open an IMAP connection.' },
        },
      ],
    }),
  )
  ok('the preview skips SMTP instead of failing it', status(preview, 'smtp:a1') === 'skip')
  ok('the preview skips IMAP instead of failing it', status(preview, 'imap:a1') === 'skip')
  ok('the preview skips the credential instead of failing it', status(preview, 'cred:a1') === 'skip')
  ok(
    'no row blames the mail server for the absence of a mail engine',
    preview.every((r) => !r.detail?.includes('Browser preview')),
    'the preview’s own refusal must never be shown as a server’s reply',
  )
  ok('the platform warning is the only thing to act on', summarise(preview).firstProblem?.id === 'platform')
  ok('nothing at all is reported as failed', summarise(preview).fail === 0)

  // The same must hold for the Android case it was originally written for.
  const broken = runSelfCheck(
    facts({
      native: 'missing',
      accounts: [{ ...facts().accounts[0], hasSecret: false, smtp: { ok: false, error: 'no plugin' } }],
    }),
  )
  ok('a dead bridge also skips the credential row', status(broken, 'cred:a1') === 'skip')
  ok('...leaving the bridge as the single failure', summarise(broken).fail === 1)
}

// --- the summary contract ---------------------------------------------------
{
  const rows = runSelfCheck(facts({ native: 'missing', deadOutbox: 1 }))
  const s = summarise(rows)
  ok('skips are counted apart from passes', s.skip > 0 && s.pass + s.fail + s.warn + s.skip === rows.length)
  ok('a failure outranks a warning as the thing to act on', s.firstProblem?.status === 'fail')
}

console.log(`\n  ${checks} checks${failed ? `, ${failed} failed` : ''}`)
console.log(failed ? '\n  The self-check reaches wrong verdicts.\n' : '\n  All clear.\n')
process.exit(failed ? 1 : 0)
