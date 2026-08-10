/**
 * Sign `release/SHA256SUMS.txt` with the Ed25519 update-signing key, and
 * prove the signature verifies before leaving it for `release.mjs` to
 * publish — `npm run release:sign-update`.
 *
 * What this closes: `SHA256SUMS.txt` and the installers it describes are
 * both published to the same GitHub release by the same credential. Someone
 * who can write to the release can replace both, and the desktop updater —
 * which historically checked the download against exactly that file — would
 * accept the result without complaint. A signature over the manifest, whose
 * public half ships inside the app rather than living next to what it
 * verifies, is what makes forging *both* files at once no longer enough.
 *
 * Refuses to sign silently when no key exists, and refuses to trust its own
 * output — the signature is verified against the embedded public key before
 * this script exits 0, so a bug here fails loud instead of publishing a
 * signature that looks fine and is not.
 *
 * Usage: `node scripts/sign-update-manifest.mjs`
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const KEY_PATH = path.join(os.homedir(), '.aevistle', 'update-signing-key.pem')
const SUMS = path.join('release', 'SHA256SUMS.txt')
const SIG = `${SUMS}.ed25519`

function die(message, hint) {
  console.error(`\n  ✗ ${message}`)
  if (hint) console.error(`    ${hint}`)
  console.error('')
  process.exit(1)
}

if (!existsSync(KEY_PATH)) {
  die('No update-signing key. This release would go out unsigned.', 'Run `node scripts/setup-update-signing-key.mjs` once, then re-run this.')
}
if (!existsSync(SUMS)) die(`${SUMS} not found.`, 'Run `npm run release:hashes` first.')

const privateKey = createPrivateKey(readFileSync(KEY_PATH, 'utf8'))
// The exact bytes on disk, not a re-serialization — this has to be byte-for-
// byte what the updater fetches and hashes, or a correct signature over a
// slightly different manifest verifies against nothing.
const data = readFileSync(SUMS)
const signature = sign(null, data, privateKey) // Ed25519 has no separate digest step

// --- verify what was just produced, against the *embedded* public key ------
//
// Not the key pair just used to sign: that would only prove Node's crypto
// implementation is internally consistent. Bundling the same file
// `electron/updater.ts` imports and checking against it is what proves the
// signature about to ship actually verifies with what the app will use.

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(path.join(tmpdir(), 'aevistle-updkey-'))
let UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64
try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${path.join(root, 'electron/updateSigningKey.ts')}"`,
      '--bundle',
      '--format=esm',
      `--outfile="${path.join(out, 'key.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
  ;({ UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64 } = await import(pathToFileURL(path.join(out, 'key.mjs')).href))
} finally {
  rmSync(out, { recursive: true, force: true })
}

const publicKey = createPublicKey({
  key: Buffer.from(UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64, 'base64'),
  format: 'der',
  type: 'spki',
})
if (!verify(null, data, publicKey, signature)) {
  die(
    'The signature just produced does not verify against the embedded public key.',
    'Do not publish this file — this means the key on disk and electron/updateSigningKey.ts have drifted apart.',
  )
}

writeFileSync(SIG, `${signature.toString('base64')}\n`, 'utf8')
console.log(`\n  ✓ signed ${SUMS}`)
console.log(`  ✓ verified against the embedded public key`)
console.log(`  → ${SIG}\n`)
