#!/usr/bin/env node
/**
 * Aevistle is a **public client**, and this gate is what keeps it one.
 *
 * Both builds are installed on other people's machines and the source is
 * public. Anything embedded in the EXE, the APK or the JavaScript bundle can be
 * read back out by anyone who has a copy — Google says as much about installed
 * apps in its own documentation. So there is no secret to protect, and the
 * security of the flow has to come from somewhere that is not secrecy: PKCE,
 * which proves the app that redeems the code is the app that asked for it, and
 * a redirect only this app can receive.
 *
 * RFC 8252 ("OAuth 2.0 for Native Apps") is the shape that follows:
 * authorization code + PKCE, in the *system browser*, back to a loopback
 * address or a private-use scheme. No client secret, no embedded web view, no
 * form in this app that asks for a provider password.
 *
 * ---------------------------------------------------------------------------
 * Why a gate and not a code review
 * ---------------------------------------------------------------------------
 *
 * Every rule below has a plausible-looking way to break it, and each one gets
 * broken by somebody trying to fix a real error message:
 *
 *   - Google answers `invalid_client` when a token request is malformed. The
 *     first search result for that is "add your client secret". Doing so makes
 *     the error go away and publishes a credential to a public repository.
 *   - An embedded web view is the easy way to keep the user "inside the app",
 *     and it also hands this app the user's Google password, breaks their
 *     password manager, and is refused outright by both vendors.
 *   - `plain` PKCE makes a hashing problem disappear and removes the entire
 *     protection PKCE exists to give.
 *   - Binding the callback listener to `0.0.0.0` fixes a "connection refused"
 *     on some machine and exposes the authorization code to the local network.
 *
 * None of those produce a failing build or a visible symptom. Three of the four
 * make something *start working*. That is exactly the kind of change a test
 * suite cannot notice and a reviewer has no reason to question.
 *
 * `--selftest` injects each violation and requires this file to go red.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const selftest = process.argv.includes('--selftest')

let checks = 0
const failures = []
const check = (label, ok, detail = '') => {
  checks++
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

/** Every source file under the roots that own OAuth code. */
function sourcesUnder(dirs, extensions) {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'build' || entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (extensions.some((e) => entry.endsWith(e))) out.push(full)
    }
  }
  for (const dir of dirs) walk(path.join(ROOT, dir))
  return out
}

const SELF = 'scripts/check-public-client.mjs'

const files = sourcesUnder(
  ['src', 'electron', 'android/app/src', 'scripts'],
  ['.ts', '.tsx', '.js', '.mjs', '.java', '.gradle', '.xml'],
)
const read = new Map(
  files
    .map((f) => [path.relative(ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')])
    // This file writes the forbidden strings on purpose, both to describe them
    // and to inject them under `--selftest`. Scanning itself would make it
    // permanently red, which is the fastest way for a gate to be deleted.
    .filter(([name]) => name !== SELF),
)

/**
 * Comments blanked, code kept.
 *
 * Load-bearing for the WebView rule specifically. `OAuthConsent.java` carries a
 * long comment headed "Why a Custom Tab and not a WebView" that explains what
 * an embedded browser would cost the user — and a raw substring search reported
 * that prose as a violation. A gate that punishes a file for documenting the
 * rule it follows teaches people to stop documenting.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

let oauthTs = stripComments(read.get('src/core/oauth.ts') ?? '')
let electronOauth = stripComments(read.get('electron/oauth.ts') ?? '')
let consentJava = stripComments(
  read.get('android/app/src/main/java/dev/aevistle/app/OAuthConsent.java') ?? '',
)

if (selftest) {
  /*
   * The injections must match the source as it is actually written, which is
   * the whole difficulty with a selftest: the first version replaced
   * `code_challenge_method: 'S256'` — an object-literal form this file does not
   * use — so the substitution silently did nothing and the selftest reported
   * that the gate had failed to catch a violation that was never injected. A
   * `--selftest` that can pass without testing anything is worth less than none,
   * so each replacement below is asserted to have changed something.
   */
  const before = oauthTs
  oauthTs = oauthTs
    .replace("params.set('code_challenge_method', 'S256')", "params.set('code_challenge_method', 'plain')")
    .replace('export function codeExchangeBody', "const client_secret = 'shhh'\nexport function codeExchangeBody")
  if (oauthTs === before) {
    console.log('\n  SELFTEST BROKEN: the injections matched nothing in src/core/oauth.ts.\n')
    process.exit(1)
  }
  electronOauth = electronOauth.replace(/listen\(0, '127\.0\.0\.1'/, "listen(0, '0.0.0.0'")
  consentJava = consentJava.replace('CustomTabsIntent', 'WebView')
}

console.log('\n  the OAuth2 client stays public: no secret, PKCE, system browser, loopback\n')

// --- 1. no client secret, anywhere -----------------------------------------

for (const [name, source] of read) {
  // The word may appear in prose explaining its absence; what must never appear
  // is an assignment or a request parameter carrying one.
  const code = stripComments(source)
  const offending = [
    /client_secret\s*[:=]\s*['"`]/i,
    /clientSecret\s*[:=]\s*['"`]/i,
    /["'`]client_secret["'`]\s*,/i,
    /append\w*\(\s*["'`]client_secret["'`]/i,
    /put\(\s*"client_secret"/i,
  ].find((re) => re.test(code))
  check(
    `${name} must not carry a client secret`,
    !offending,
    offending ? `matched ${offending}` : '',
  )
}
// The selftest injection lives in a variable rather than on disk, so it is
// checked separately — otherwise `--selftest` would prove nothing here.
check(
  'no client secret in the OAuth core (selftest-aware)',
  !/client_secret\s*=\s*['"]/.test(oauthTs),
)

// --- 2. authorization code + PKCE, S256 only -------------------------------

check(
  'the authorize request asks for a code, not a token',
  /response_type['"\s:=]+.{0,4}code/.test(oauthTs) && !/response_type[^\n]*token/.test(oauthTs),
  'an implicit-flow (`response_type=token`) request has no PKCE protection at all',
)
check(
  'PKCE uses S256',
  /code_challenge_method['"\s:=]+.{0,4}S256/.test(oauthTs),
)
check(
  'PKCE never falls back to `plain`',
  !/code_challenge_method[^\n]*['"]plain['"]/.test(oauthTs),
  '`plain` sends the verifier itself, which is the thing PKCE exists not to send',
)
check(
  'the Android side pins S256 too',
  /"S256"/.test(consentJava) && !/"plain"/.test(consentJava),
)
check(
  'the verifier is generated from a CSPRNG',
  /SecureRandom/.test(consentJava),
  'a `Math.random`-grade verifier is guessable, which defeats PKCE entirely',
)

// --- 3. the system browser, never an embedded one --------------------------

check(
  'the desktop hands the consent URL to the system browser',
  /openExternal\s*\(/.test(electronOauth),
)
check(
  'the desktop never opens consent in an app window',
  !/new BrowserWindow|loadURL\s*\(/.test(electronOauth),
  'an embedded window would put this app between the user and their password',
)
check(
  'Android uses Custom Tabs, not a WebView',
  /CustomTabsIntent/.test(consentJava) && !/\bWebView\b/.test(consentJava),
  'RFC 8252 §8.12 forbids embedded user agents, and both vendors refuse them',
)

// --- 4. the redirect only this app can receive -----------------------------

check(
  'the loopback listener binds 127.0.0.1 only',
  /listen\(\s*0\s*,\s*['"]127\.0\.0\.1['"]/.test(electronOauth),
  'binding 0.0.0.0 would expose the authorization code to the local network',
)
check(
  'the loopback port is OS-assigned',
  /listen\(\s*0\s*,/.test(electronOauth),
  'a fixed port is one another process can hold first',
)
check(
  "the Android redirect scheme is the app's own id",
  /ANDROID_REDIRECT_SCHEME\s*=\s*'dev\.aevistle\.app'/.test(oauthTs),
  'a generic scheme is one another app can register and win a chooser for',
)

// --- 5. no provider password is ever asked for in-app ----------------------

const dialog = read.get('src/components/AccountDialog.tsx') ?? ''
check(
  'the password field is removed under OAuth2, not merely disabled',
  /isOauth\s*\?\s*null\s*:/.test(dialog),
  'a disabled box still reads as something the user was meant to fill in',
)

// --- 6. nothing leaked into what actually ships ---------------------------

for (const artifact of ['dist-electron/main.cjs', 'dist-electron/preload.cjs']) {
  const full = path.join(ROOT, artifact)
  if (!existsSync(full)) continue // not built in this working tree; nothing to judge
  check(
    `${artifact} carries no client secret`,
    !/client_secret\s*[:=]\s*["'`][^"'`]+["'`]/.test(readFileSync(full, 'utf8')),
  )
}

// ---------------------------------------------------------------------------

if (selftest) {
  const wanted = ['PKCE never falls back', 'binds 127.0.0.1', 'Custom Tabs', 'selftest-aware']
  const missed = wanted.filter((w) => !failures.some((f) => f.includes(w)))
  console.log(`  ${checks} checks, ${failures.length} failed`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  if (missed.length) {
    console.log(`\n  SELFTEST FAILED: these injected violations were not caught: ${missed.join(', ')}\n`)
    process.exit(1)
  }
  console.log('\n  Selftest OK — every injected violation was caught.\n')
  process.exit(0)
}

console.log(`  ${checks} checks${failures.length ? `, ${failures.length} failed` : ''}`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log(failures.length ? '\n  The client is no longer safely public.\n' : '\n  All clear.\n')
process.exit(failures.length ? 1 : 0)
