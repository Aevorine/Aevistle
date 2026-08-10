/**
 * Is the latest published release's `SHA256SUMS.txt` actually signed with
 * the update-signing key, and does the signature hold? — `npm run check:update-signing`.
 *
 * Missing is not failure: every release published before this feature
 * existed, and this feature's own release before `release:sign-update` has
 * ever run for it, legitimately has no `SHA256SUMS.txt.ed25519` yet — the
 * desktop updater already treats that as "installable, hash-only verified",
 * the same tolerance `check-signing.mjs` gives a release with no GPG
 * signature. What must never happen, and what this exists to catch, is a
 * signature that is *present* and *wrong* — a corrupted upload, or in the
 * threat model this feature exists for, a forged one.
 *
 * Verifies against the *embedded* public key (the same file
 * `electron/updater.ts` imports), not a local secret, because that is the
 * only thing a stranger — or the shipped app — can do.
 *
 * Being offline is reported and does not fail, matching audit-deps.mjs and
 * check-signing.mjs: "could not check" must not read as "checked and fine".
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPublicKey, verify } from 'node:crypto'

const REPO = 'Aevorine/Aevistle'

const run = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 })

console.log('\n  Update-manifest signature (Ed25519)')

const latest = run('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName,assets'])
if (latest.status !== 0) {
  console.log('  ⚠ Could not reach GitHub. Not checked this run.\n')
  process.exit(0)
}

let release
try {
  release = JSON.parse(latest.stdout)
} catch {
  console.log('  ⚠ Could not read the release listing. Not checked this run.\n')
  process.exit(0)
}

const names = new Set((release.assets ?? []).map((a) => a.name))
const tag = release.tagName

if (!names.has('SHA256SUMS.txt.ed25519')) {
  console.log(`  ⚠ ${tag} does not publish SHA256SUMS.txt.ed25519 yet.`)
  console.log('    Not a failure — run `npm run release:sign-update` when publishing this release.\n')
  process.exit(0)
}
if (!names.has('SHA256SUMS.txt')) {
  console.log(`  ✗ ${tag} has a signature but no SHA256SUMS.txt for it to cover.\n`)
  process.exit(1)
}

const dir = mkdtempSync(path.join(tmpdir(), 'aevistle-updsig-'))
try {
  for (const asset of ['SHA256SUMS.txt', 'SHA256SUMS.txt.ed25519']) {
    const got = run('gh', ['release', 'download', tag, '--repo', REPO, '-p', asset, '-D', dir])
    if (got.status !== 0) {
      console.log('  ⚠ Could not download the release assets. Not checked this run.\n')
      process.exit(0)
    }
  }

  const data = readFileSync(path.join(dir, 'SHA256SUMS.txt'))
  const signature = Buffer.from(readFileSync(path.join(dir, 'SHA256SUMS.txt.ed25519'), 'utf8').trim(), 'base64')

  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const keyOut = mkdtempSync(path.join(tmpdir(), 'aevistle-updkey-'))
  let UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64
  try {
    execFileSync(
      'npx',
      [
        'esbuild',
        `"${path.join(root, 'electron/updateSigningKey.ts')}"`,
        '--bundle',
        '--format=esm',
        `--outfile="${path.join(keyOut, 'key.mjs')}"`,
        '--log-level=warning',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
    )
    ;({ UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64 } = await import(pathToFileURL(path.join(keyOut, 'key.mjs')).href))
  } finally {
    rmSync(keyOut, { recursive: true, force: true })
  }

  const publicKey = createPublicKey({
    key: Buffer.from(UPDATE_SIGNING_PUBLIC_KEY_SPKI_BASE64, 'base64'),
    format: 'der',
    type: 'spki',
  })

  if (!verify(null, data, publicKey, signature)) {
    console.log(`  ✗ ${tag}: SHA256SUMS.txt.ed25519 does not verify against the embedded public key.\n`)
    process.exit(1)
  }

  console.log(`  ✓ ${tag} is signed, and the signature verifies against the embedded public key`)
  console.log('\n  All clear.\n')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
