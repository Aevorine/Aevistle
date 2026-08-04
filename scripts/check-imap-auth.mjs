/**
 * Guards the fix for "Right-hand side of 'instanceof' is not an object".
 *
 * `electron/imap.ts` used to decide "was this a rejected password?" with
 * `err instanceof AuthenticationFailure`, importing that class from 'imapflow'.
 * It typechecked forever, because `lib/imap-flow.d.ts` declares
 * `export class AuthenticationFailure`. The entry point never re-exports it —
 * the class only exists inside `lib/tools.js` — so at runtime the binding was
 * `undefined`, and `x instanceof undefined` throws a TypeError.
 *
 * That throw happened *inside the endpoint ladder's catch block*, so it
 * replaced the real connection error and escaped the ladder: every failure
 * surfaced as the TypeError instead of "port 587 needs STARTTLS".
 *
 * This script asserts three things:
 *   1. the source no longer imports or `instanceof`-tests that symbol;
 *   2. the duck-typed replacement classifies every case correctly;
 *   3. the old expression really does throw against this installed imapflow
 *      (i.e. the bug is reproducible, so the guard is not vacuous).
 *
 * Run with `--selftest` to prove the guard fails on a knowingly-broken
 * implementation — a guard that never goes red is not a guard.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const pass = (m) => console.log(`  PASS  ${m}`)
const fail = (m) => {
  failures.push(m)
  console.log(`  FAIL  ${m}`)
}
const check = (cond, m) => (cond ? pass(m) : fail(m))

/** The shipped implementation, kept byte-identical to `electron/imap.ts`. */
function isAuthFailure(err) {
  if (!err || typeof err !== 'object') return false
  const e = err
  if (e.authenticationFailed === true) return true
  return (
    typeof e.serverResponseCode === 'string' &&
    e.serverResponseCode.toUpperCase() === 'AUTHENTICATIONFAILED'
  )
}

/** Deliberately broken, used only by --selftest. */
function isAuthFailureBroken(err) {
  return err instanceof require('imapflow').AuthenticationFailure
}

const classify = process.argv.includes('--selftest') ? isAuthFailureBroken : isAuthFailure

console.log('imapflow', require('imapflow/package.json').version)

// --- 1. the source must not reach for the phantom export -------------------
// Comments are stripped first: `imap.ts` documents the old expression verbatim
// so the next reader knows why the duck-type exists, and a naive grep would
// match that prose and fail forever.
const raw = readFileSync(join(root, 'electron', 'imap.ts'), 'utf8')
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const importLines = src.split('\n').filter((l) => l.includes("from 'imapflow'"))
check(
  !importLines.some((l) => l.includes('AuthenticationFailure')),
  "electron/imap.ts does not import AuthenticationFailure from 'imapflow'",
)
check(
  !/instanceof\s+AuthenticationFailure/.test(src),
  'electron/imap.ts does not `instanceof AuthenticationFailure` (comments excluded)',
)

// --- 2. the bug is genuinely reproducible against this imapflow ------------
const runtimeExport = require('imapflow').AuthenticationFailure
if (runtimeExport === undefined) {
  let threw = false
  try {
    // eslint-disable-next-line no-unused-expressions
    new Error('x') instanceof runtimeExport
  } catch (e) {
    threw = e instanceof TypeError && /Right-hand side/.test(e.message)
  }
  check(threw, 'the old expression still throws the reported TypeError (guard is not vacuous)')
} else {
  pass(`imapflow now exports AuthenticationFailure (${typeof runtimeExport}) — duck-typing stays correct regardless`)
}

// --- 3. the replacement classifies correctly --------------------------------
const authTagged = Object.assign(new Error('Authentication failed'), { authenticationFailed: true })
const codeTagged = Object.assign(new Error('Invalid credentials'), {
  serverResponseCode: 'AUTHENTICATIONFAILED',
})
const sslError = new Error(
  '1090880:error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER:..\\..\\third_party\\boringssl\\src\\ssl\\tls_record.cc:127:',
)

const cases = [
  ['imapflow-tagged auth failure => auth', authTagged, true],
  ['server AUTHENTICATIONFAILED code => auth', codeTagged, true],
  ['BoringSSL WRONG_VERSION_NUMBER => not auth', sslError, false],
  ['ECONNREFUSED => not auth', new Error('connect ECONNREFUSED'), false],
  ['null => not auth', null, false],
  ['undefined => not auth', undefined, false],
  ['string => not auth', 'boom', false],
  ['plain object => not auth', {}, false],
]

for (const [label, input, expected] of cases) {
  let got
  try {
    got = classify(input)
  } catch (e) {
    fail(`${label} — threw ${e.constructor.name}: ${e.message}`)
    continue
  }
  check(got === expected, label)
}

console.log(
  failures.length === 0
    ? '\nAll clear — IMAP auth classification is duck-typed and total.'
    : `\n${failures.length} check(s) failed.`,
)
process.exit(failures.length === 0 ? 0 : 1)
