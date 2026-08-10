/**
 * Create the Ed25519 update-signing key. Run once, ever.
 *
 * Mirrors `setup-signing-key.sh`'s reasoning: generating a private key is the
 * one step that must not be repeatable by accident. A second key here would
 * sign future manifests with something the public half embedded in
 * `electron/updateSigningKey.ts` cannot verify — which fails every install
 * exactly the way a forged signature would, just without an attacker.
 *
 * This key is separate from the GPG key `setup-signing-key.sh` creates. That
 * one stays a human-verified, OpenPGP-format signature for anyone who runs
 * `gpg --verify` by hand, documented in SECURITY.md. This one exists only so
 * `electron/updater.ts` can check a signature itself, in-process, with
 * nothing heavier than `node:crypto` — see `updateSigningKey.ts` for why that
 * ruled out reusing the GPG key directly.
 *
 * Usage: `node scripts/setup-update-signing-key.mjs`
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const HOME_DIR = path.join(os.homedir(), '.aevistle')
const KEY_PATH = path.join(HOME_DIR, 'update-signing-key.pem')

if (existsSync(KEY_PATH)) {
  console.log(`\n  A key already exists at ${KEY_PATH}.`)
  console.log('  Refusing to generate a second one — that would sign future releases')
  console.log('  with a key nothing has the matching public half for.')
  console.log('  To replace it deliberately: delete that file, re-run this script, then')
  console.log('  update UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64 in electron/updateSigningKey.ts')
  console.log('  to match the new public key it prints — otherwise every future release')
  console.log('  fails its own signature check.\n')
  process.exit(0)
}

mkdirSync(HOME_DIR, { recursive: true })
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

console.log(`\n  Written: ${KEY_PATH}`)
console.log('  (already covered by .gitignore — *.pem is never reachable by git)\n')
console.log('  This matches the public key already embedded in electron/updateSigningKey.ts,')
console.log('  so nothing else needs changing. If it ever needs to be regenerated, the new')
console.log('  public key to paste there is:\n')
console.log(`    ${spki}\n`)
console.log('  Back this key up somewhere outside this machine. If it is lost, future')
console.log('  releases simply fall back to hash-only verification (same as before this')
console.log('  feature existed) — not catastrophic, but signing stops until a new key is')
console.log('  generated and re-embedded. If it leaks, treat it like the GPG signing key:')
console.log('  rotate it and update the public half everywhere it is embedded.\n')
