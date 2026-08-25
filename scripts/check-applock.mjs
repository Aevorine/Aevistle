/**
 * The app lock's hashing, held to reference answers — `npm run check:applock`.
 *
 * `core/security/pinHash.ts` writes SHA-256 out by hand, because the lock has
 * to produce the *same* hash in the Electron renderer, the Android WebView
 * and under Node — and `crypto.subtle` is async, secure-context gated and not
 * something a screen lock should be one flaky WebView away from. A
 * hand-written hash is exactly the kind of code that can be wrong in silence:
 * a bad rotate constant still produces 64 confident hex characters, the lock
 * "works" on every machine that made the same mistake, and the day anything
 * recomputes the hash correctly, the right PIN stops opening it.
 *
 * So nothing here trusts the implementation. Every digest is compared against
 * `node:crypto`'s answer for the same bytes — the FIPS vectors plus inputs
 * chosen to hit the seams: both sides of the one-block/two-block boundary,
 * multi-byte UTF-8 (a `charCodeAt` bug survives every ASCII vector ever
 * written), and a million-byte message for the length-encoding split. The
 * PIN chain is then rebuilt step by step out of `node:crypto` and must land
 * on the same final hex.
 */

import { build } from 'esbuild'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-applock-'))

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, platform: 'node', logLevel: 'error' })
  return import(pathToFileURL(outfile).href)
}

const failures = []
let checked = 0
const check = (what, ok, detail = '') => {
  checked++
  if (ok) console.log(`  ok    ${what}`)
  else {
    failures.push(what)
    console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ''}`)
  }
}

try {
  const pin = await load('src/core/security/pinHash.ts', 'pinHash')

  // --- the digest itself, against node:crypto -------------------------------
  const nodeHash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const CASES = [
    '', // FIPS: e3b0c442…
    'abc', // FIPS one-block
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', // FIPS two-block
    'a'.repeat(55), // largest single-block message
    'a'.repeat(56), // smallest that pads into a second block
    'a'.repeat(64), // exactly one block of data
    'a'.repeat(65),
    '中文密码🔒', // multi-byte UTF-8 — a charCodeAt bug passes every case above
    'a'.repeat(1_000_000), // length encoding past the 32-bit shift
  ]
  for (const s of CASES) {
    const got = pin.sha256Hex(s)
    const want = nodeHash(Buffer.from(s, 'utf8'))
    check(
      `sha256 agrees with node:crypto for ${JSON.stringify(s.length > 12 ? `${s.slice(0, 9)}…(${s.length})` : s)}`,
      got === want,
      `got ${got}, node says ${want}`,
    )
  }
  const raw = randomBytes(1000)
  check('sha256 agrees on raw bytes (not only strings)', pin.sha256Hex(new Uint8Array(raw)) === nodeHash(raw))

  // The named FIPS 180-4 answer, so a wrong node build cannot vouch for a
  // wrong implementation: one fixed point that is in the standard itself.
  check(
    'sha256("abc") is the FIPS 180-4 answer',
    pin.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )

  // --- the PIN chain, rebuilt independently ---------------------------------
  const salt = pin.makeSalt()
  check('makeSalt gives 32 hex characters', /^[0-9a-f]{32}$/.test(salt))
  check('two salts differ', pin.makeSalt() !== pin.makeSalt())

  let ref = createHash('sha256').update(Buffer.from(`${salt}:1234`, 'utf8')).digest()
  ref = createHash('sha256').update(ref).digest()
  ref = createHash('sha256').update(ref).digest()
  check('hashPin(…, 3) equals the chain built out of node:crypto', pin.hashPin('1234', salt, 3) === ref.toString('hex'))

  const h = pin.hashPin('1234', salt, 5000)
  check('hashPin is deterministic', pin.hashPin('1234', salt, 5000) === h)
  check('a different PIN hashes differently', pin.hashPin('1235', salt, 5000) !== h)
  check('a different salt hashes differently', pin.hashPin('1234', pin.makeSalt(), 5000) !== h)
  check('a different iteration count hashes differently', pin.hashPin('1234', salt, 5001) !== h)

  const flipped = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0')
  check('timingSafeEqualHex accepts the same hash', pin.timingSafeEqualHex(h, h) === true)
  check('timingSafeEqualHex rejects a one-character change', pin.timingSafeEqualHex(h, flipped) === false)
  check('timingSafeEqualHex rejects a length change', pin.timingSafeEqualHex(h, h.slice(1)) === false)

  check('isValidPin accepts 4–12 digits', pin.isValidPin('1234') && pin.isValidPin('123456789012'))
  check(
    'isValidPin rejects everything else',
    !pin.isValidPin('123') && !pin.isValidPin('abcd') && !pin.isValidPin('1234567890123') && !pin.isValidPin('12 34'),
  )
  check(`PIN_LOCK_ITERATIONS is a real work factor (${pin.PIN_LOCK_ITERATIONS})`, pin.PIN_LOCK_ITERATIONS >= 20_000)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.log(`  FAIL — ${failures.length} problem(s), ${checked - failures.length} passed`)
  process.exit(1)
}
console.log(`  PASS — ${checked} check(s)`)
