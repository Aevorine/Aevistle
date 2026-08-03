/**
 * Sign a release's checksums, prove the signature verifies, and publish both.
 *
 * What this buys, and why it is worth a script: without it, `SHA256SUMS.txt`
 * and the binaries it describes are fetched from the same place by the same
 * credential. Anyone who can write to the release can replace both, and the
 * in-app updater — which checks the download against exactly that file — would
 * accept the result without complaint. The checksums prove the download was not
 * corrupted in transit; they cannot prove who published it. A signature can.
 *
 * Three things it refuses to do:
 *
 *   - **Sign silently when no key exists.** It says so and exits non-zero, so a
 *     release does not quietly go out unsigned after somebody moved the file.
 *   - **Trust its own output.** The signature is verified against the public
 *     key before anything is uploaded. A `.asc` that does not verify is worse
 *     than none, because it looks like proof.
 *   - **Publish a fingerprint that disagrees with the docs.** If SECURITY.md
 *     names a different key, that is a mismatch someone has to look at.
 *
 * Usage: `npm run release:sign -- v0.1.5`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { findGpg, toGpgPath, GPG_HINT } from './gpg-path.mjs'

const TAG = process.argv[2]
if (!TAG) {
  console.error('Usage: npm run release:sign -- <tag>')
  process.exit(2)
}

const HOME_DIR = path.join(os.homedir(), '.aevistle')
const PROPS = path.join(HOME_DIR, 'gpg.properties')
const PUBLIC_KEY = path.join(HOME_DIR, 'aevistle-public-key.asc')
const SUMS = path.join('release', 'SHA256SUMS.txt')
const SIG = `${SUMS}.asc`

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  })

function die(message, hint) {
  console.error(`\n  ✗ ${message}`)
  if (hint) console.error(`    ${hint}`)
  console.error('')
  process.exit(1)
}

// --- the key ----------------------------------------------------------------

const GPG = findGpg()
if (!GPG) die('Cannot sign: gpg is not installed or not reachable.', GPG_HINT)

if (!existsSync(PROPS)) {
  die(
    'No signing key. This release would go out unsigned.',
    'Run `bash scripts/setup-signing-key.sh` once, then re-run this.',
  )
}

const props = Object.fromEntries(
  readFileSync(PROPS, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const at = l.indexOf('=')
      return [l.slice(0, at).trim(), l.slice(at + 1)]
    }),
)
const { fingerprint, passphrase } = props
if (!fingerprint || !passphrase) die(`${PROPS} is missing fingerprint or passphrase.`)

/*
 * The project's own GnuPG home, not the user's.
 *
 * Written by the setup script into ~/.aevistle/gnupg, for a Windows-specific
 * reason worth knowing: Git for Windows' gpg puts `use-keyboxd` in the global
 * ~/.gnupg/common.conf, and then looks for that daemon at a POSIX path which
 * only resolves inside MSYS. Signing therefore works from Git Bash and fails
 * from PowerShell and from Node — which is where these scripts actually run.
 *
 * Falls back to the default home for installs made before this existed, and
 * for Linux and macOS where none of it applies.
 */
const GNUPGHOME = props.gnupghome && existsSync(props.gnupghome) ? props.gnupghome : null
const homeArgs = GNUPGHOME ? ['--homedir', toGpgPath(GNUPGHOME, GPG)] : []

if (!existsSync(SUMS)) die(`${SUMS} not found.`, 'Build the release first.')

// --- sign -------------------------------------------------------------------

console.log(`\n  Signing ${SUMS}`)
console.log(`  key ${fingerprint}`)

const signed = run(GPG, [
  ...homeArgs,
  '--batch',
  '--yes',
  '--pinentry-mode',
  'loopback',
  '--passphrase',
  passphrase,
  '--local-user',
  fingerprint,
  '--armor',
  '--detach-sign',
  '--output',
  toGpgPath(SIG, GPG),
  toGpgPath(SUMS, GPG),
])
if (signed.status !== 0) die('gpg refused to sign.', (signed.stderr || '').trim().split('\n').pop())

// --- verify what was just produced -----------------------------------------
//
// In a throwaway home holding nothing but the exported public key, rather than
// in the signing keyring. The signing keyring trusts its own secret key
// unconditionally, so a verification there would pass on a signature nobody
// else could check — which is the one outcome this step exists to rule out.
//
// The key is *imported*, not handed to `--keyring`. That option wants a binary
// keyring; given an armoured `.asc` it reads no keys at all and reports "Can't
// check signature: No public key", which looks exactly like a bad signature.

const scratch = mkdtempSync(path.join(tmpdir(), 'aevistle-verify-'))
try {
  // Empty rather than absent, so Git for Windows' gpg does not write
  // `use-keyboxd` here and then fail to start a daemon it cannot name.
  writeFileSync(path.join(scratch, 'common.conf'), '')
  const scratchArgs = ['--homedir', toGpgPath(scratch, GPG)]

  const imported = run(GPG, [...scratchArgs, '--batch', '--import', toGpgPath(PUBLIC_KEY, GPG)])
  if (imported.status !== 0) {
    die('Could not import the public key to verify against.', (imported.stderr || '').trim())
  }

  var verified = run(GPG, [
    ...scratchArgs,
    '--batch',
    '--verify',
    toGpgPath(SIG, GPG),
    toGpgPath(SUMS, GPG),
  ])
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
const verifyOut = `${verified.stdout ?? ''}${verified.stderr ?? ''}`
if (verified.status !== 0 || !/Good signature/i.test(verifyOut)) {
  die('The signature does not verify against the published public key.', verifyOut.trim().split('\n').pop())
}
if (!verifyOut.replace(/\s/g, '').includes(fingerprint.replace(/\s/g, ''))) {
  die('The signature verified, but with a different key than the one on record.')
}
console.log('  ✓ signature verifies against the published public key')

// --- the docs have to name the same key ------------------------------------
//
// Filled in here rather than left for someone to remember. A fingerprint in the
// documentation that does not match the key that signed the file makes
// verification fail for every reader who follows the instructions — and it
// fails in the way that looks like tampering, which is the worst possible
// false alarm for a security feature to raise.

const MARKER = '<!-- AEVISTLE_GPG_FINGERPRINT -->'
if (existsSync('SECURITY.md')) {
  const security = readFileSync('SECURITY.md', 'utf8')
  const line = new RegExp(`${MARKER}.*`)
  if (line.test(security)) {
    const next = security.replace(line, `${MARKER}${fingerprint}`)
    if (next !== security) {
      writeFileSync('SECURITY.md', next)
      console.log('  ✓ SECURITY.md now names this fingerprint')
    }
  } else if (
    security.includes('GPG') &&
    !security.replace(/\s/g, '').includes(fingerprint.replace(/\s/g, ''))
  ) {
    die(
      'SECURITY.md names a GPG key, but not this one, and has no marker to update.',
      'A published fingerprint that disagrees with the signature makes verification fail for everyone.',
    )
  }
}

// --- publish ----------------------------------------------------------------

const assets = [SIG]
if (existsSync(PUBLIC_KEY)) assets.push(PUBLIC_KEY)

const uploaded = run('gh', ['release', 'upload', TAG, ...assets, '--clobber'])
if (uploaded.status !== 0) {
  die('Could not upload to the release.', (uploaded.stderr || '').trim().split('\n').pop())
}

console.log(`  ✓ uploaded ${assets.map((a) => path.basename(a)).join(', ')} to ${TAG}`)
console.log('\n  Anyone can now check the download came from this key:\n')
console.log('    gpg --import aevistle-public-key.asc')
console.log('    gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt')
console.log('    sha256sum -c SHA256SUMS.txt\n')
