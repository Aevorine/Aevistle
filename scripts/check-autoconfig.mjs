/**
 * Does typing an address really fill the rest of the form in, and does it
 * really leave alone the boxes someone edited by hand?
 *
 * Two claims, and they pull against each other. The first is what makes
 * "type your address and you are done" work. The second is what stops a port
 * someone corrected from being silently thrown away on the next keystroke.
 * A change that satisfies one by breaking the other looks fine in use until
 * the day it does not, so both are asserted here.
 *
 * The third claim is the one that was actually broken: changing the *domain*
 * has to re-derive. Editing a stored account flagged every field as
 * hand-edited up front, so `me@outlook.com` → `me@gmail.com` left Microsoft's
 * servers sitting under a Gmail address and looked like nothing happened.
 *
 * `--selftest` swaps in a knowingly-broken rule to prove these checks go red.
 * A guard that cannot fail is not a guard.
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-autoconfig-'))
const bundle = path.join(dir, 'providers.mjs')
await build({
  entryPoints: ['src/core/providers.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { autoConfigForAddress, carryAutoFlags, deviationsFrom, domainOfAddress } = await import(
  pathToFileURL(bundle).href
)
await rm(dir, { recursive: true, force: true })

const SELFTEST = process.argv.includes('--selftest')

/** The pre-fix behaviour: editing an account protects everything, forever. */
const brokenCarry = (_prev, _next, _values, current) => current

const carry = SELFTEST ? brokenCarry : carryAutoFlags

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

// ---------------------------------------------------------------------------
// 1. An address alone fills the form in, for providers people actually use.
// ---------------------------------------------------------------------------
const EXPECTED = [
  ['me@gmail.com', 'smtp.gmail.com', 465, 'ssl', 'imap.gmail.com', 993, 'ssl'],
  ['me@outlook.com', 'smtp.office365.com', 587, 'starttls', 'outlook.office365.com', 993, 'ssl'],
  ['me@hotmail.com', 'smtp.office365.com', 587, 'starttls', 'outlook.office365.com', 993, 'ssl'],
  ['me@live.com', 'smtp.office365.com', 587, 'starttls', 'outlook.office365.com', 993, 'ssl'],
  ['me@qq.com', 'smtp.qq.com', 465, 'ssl', 'imap.qq.com', 993, 'ssl'],
  ['me@163.com', 'smtp.163.com', 465, 'ssl', 'imap.163.com', 993, 'ssl'],
  ['me@126.com', 'smtp.126.com', 465, 'ssl', 'imap.126.com', 993, 'ssl'],
  ['me@icloud.com', 'smtp.mail.me.com', 587, 'starttls', 'imap.mail.me.com', 993, 'ssl'],
  ['me@yahoo.com', 'smtp.mail.yahoo.com', 465, 'ssl', 'imap.mail.yahoo.com', 993, 'ssl'],
  ['me@sina.com', 'smtp.sina.com', 465, 'ssl', 'imap.sina.com', 993, 'ssl'],
  ['me@exmail.qq.com', 'smtp.exmail.qq.com', 465, 'ssl', 'imap.exmail.qq.com', 993, 'ssl'],
  ['me@gmx.com', 'mail.gmx.com', 587, 'starttls', 'imap.gmx.com', 993, 'ssl'],
]

for (const [addr, host, port, security, imapHost, imapPort, imapSecurity] of EXPECTED) {
  const cfg = autoConfigForAddress(addr)
  const p = cfg?.preset
  check(`${addr} is recognised`, Boolean(cfg) && cfg.guessed === false)
  check(`${addr} → ${host}:${port}/${security}`, p?.host === host && p?.port === port && p?.security === security)
  check(
    `${addr} → IMAP ${imapHost}:${imapPort}/${imapSecurity}`,
    p?.imapHost === imapHost && p?.imapPort === imapPort && p?.imapSecurity === imapSecurity,
  )
}

// Microsoft's pair is the one this round was reported against; state it alone
// so a regression names itself rather than hiding in the table above.
const ms = autoConfigForAddress('someone@outlook.com')?.preset
check('Microsoft SMTP is 587/STARTTLS, never 587/SSL', ms?.port === 587 && ms?.security === 'starttls')

// ---------------------------------------------------------------------------
// 2. An unknown domain still fills in, and says it is guessing.
// ---------------------------------------------------------------------------
const guess = autoConfigForAddress('me@some-company-nobody-knows.example')
check('unknown domain still yields a config', Boolean(guess))
check('unknown domain is flagged as a guess', guess?.guessed === true)
check('unknown domain guesses smtp.<domain>:587/STARTTLS', guess?.preset.host === 'smtp.some-company-nobody-knows.example' && guess?.preset.port === 587 && guess?.preset.security === 'starttls')
check('unknown domain guesses imap.<domain>:993/SSL', guess?.preset.imapHost === 'imap.some-company-nobody-knows.example' && guess?.preset.imapPort === 993)

// Half-typed addresses must not blank the form out.
check('"me@" yields nothing rather than clearing fields', autoConfigForAddress('me@') === null)
check('"me" yields nothing', autoConfigForAddress('me') === null)
check('trailing dot still matches', domainOfAddress('a@qq.com.') === 'qq.com')

// ---------------------------------------------------------------------------
// 3. Hand-edited fields survive; preset-shaped ones do not count as edits.
// ---------------------------------------------------------------------------
const outlookPreset = autoConfigForAddress('me@outlook.com')

/** A stored Outlook account, untouched — every value is just the preset. */
const pristine = {
  providerId: 'outlook',
  label: 'Outlook / Hotmail',
  host: 'smtp.office365.com',
  port: 587,
  security: 'starttls',
  username: 'me@outlook.com',
  fromAddress: 'me@outlook.com',
  imapHost: 'outlook.office365.com',
  imapPort: 993,
  imapSecurity: 'ssl',
  imapUsername: 'me@outlook.com',
}

check('a pristine account deviates in nothing', deviationsFrom(outlookPreset, pristine).size === 0)

/** The same account with a port someone corrected by hand. */
const customised = { ...pristine, port: 2525 }
const dev = deviationsFrom(outlookPreset, customised)
check('a hand-set port is seen as a deviation', dev.has('port'))
check('only the port is a deviation', dev.size === 1)

const ALL = new Set([
  'providerId', 'label', 'host', 'port', 'security', 'username',
  'imapHost', 'imapPort', 'imapSecurity', 'imapUsername',
])

// Same domain, different local part: a typo fix. Nothing may be re-derived.
const sameDomain = carry('me@outlook.com', 'me2@outlook.com', pristine, ALL)
check('same domain keeps every hand-edit flag', sameDomain.size === ALL.size)

// Different domain, nothing customised: everything is free to re-derive.
const crossPristine = carry('me@outlook.com', 'me@gmail.com', pristine, ALL)
check(
  'changing domain re-derives an untouched account',
  crossPristine.size === 0,
)

// Different domain, one real customisation: that one alone is protected.
const crossCustom = carry('me@outlook.com', 'me@gmail.com', customised, ALL)
check('changing domain keeps the hand-set port', crossCustom.has('port'))
check('changing domain re-derives everything else', crossCustom.size === 1)

/*
 * Leaving a domain no preset knows.
 *
 * `autoConfigForAddress` never returns null for a well-formed domain — it
 * guesses `smtp.<domain>` and says so — which means there *is* a baseline to
 * compare against even here. So the rule stays the same rather than falling
 * back to "protect everything": values matching the guess were never chosen,
 * values differing from it were.
 */
const onGuessed = {
  providerId: undefined,
  label: 'weird-host.example',
  host: 'smtp.weird-host.example',
  port: 587,
  security: 'starttls',
  username: 'me@weird-host.example',
  fromAddress: 'me@weird-host.example',
  imapHost: 'imap.weird-host.example',
  imapPort: 993,
  imapSecurity: 'ssl',
  imapUsername: 'me@weird-host.example',
}
check(
  'leaving a guessed domain re-derives when nothing was overridden',
  carry('me@weird-host.example', 'me@gmail.com', onGuessed, ALL).size === 0,
)

const onGuessedCustom = { ...onGuessed, host: 'mail.weird-host.example' }
const leftCustom = carry('me@weird-host.example', 'me@gmail.com', onGuessedCustom, ALL)
check('leaving a guessed domain keeps a hand-set host', leftCustom.has('host'))
check('leaving a guessed domain re-derives the rest', leftCustom.size === 1)

// ---------------------------------------------------------------------------
console.log(`  ${checked} checks`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`)
  console.log(`\n  ${failures.length} of ${checked} failed.`)
  process.exit(1)
}
console.log('  All clear.')
