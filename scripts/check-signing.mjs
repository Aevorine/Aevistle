/**
 * Is the latest published release actually signed, and does the signature hold?
 *
 * This is the check that keeps the feature from decaying. Signing is a step in
 * a release process, and a step in a release process is a step somebody skips
 * on the evening it is inconvenient — after which every later release is
 * unsigned too, and nothing anywhere says so. The absence of a signature is
 * invisible from the download page.
 *
 * It verifies the *published* signature against the *published* public key,
 * both fetched from the release, because that is the only thing a stranger can
 * do and therefore the only thing worth asserting. Verifying against the local
 * keyring would pass on a machine that holds the secret key and tell nobody
 * anything.
 *
 * Being offline is reported and does not fail — the same three-way distinction
 * `audit-deps.mjs` makes, for the same reason: "could not check" must not read
 * as "checked and fine", and must not block work either.
 *
 * Exit code 1 only when a release is genuinely unsigned or the signature is bad.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findGpg, GPG_HINT } from './gpg-path.mjs'

const REPO = 'Aevorine/Aevistle'

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  })

console.log('\n  Release signature')

/*
 * Resolved before anything else touches the network.
 *
 * It sat below the GitHub call in an earlier version, which hid a worse
 * mistake: the constant was never declared at all, so `run(GPG, …)` further
 * down was a ReferenceError waiting on the one code path that only runs once a
 * release *is* signed. It would have appeared the first time the feature
 * worked, which is the least useful moment for a defect to surface.
 */
const GPG = findGpg()
if (!GPG) {
  // Not a failure of the release — this machine simply cannot check it.
  console.log(`  ⚠ ${GPG_HINT}`)
  console.log('    The signature was NOT verified this run.\n')
  process.exit(0)
}

const latest = run('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName,assets'])
if (latest.status !== 0) {
  console.log('  ⚠ Could not reach GitHub. The release was NOT checked this run.')
  console.log(`    ${(latest.stderr || '').trim().split('\n').pop()}\n`)
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

const missing = ['SHA256SUMS.txt', 'SHA256SUMS.txt.asc', 'aevistle-public-key.asc'].filter(
  (n) => !names.has(n),
)
if (missing.length > 0) {
  console.log(`  ✗ ${tag} is missing: ${missing.join(', ')}`)
  console.log('    Run `npm run release:sign -- ' + tag + '` to sign and publish it.\n')
  process.exit(1)
}

// --- verify as a stranger would ---------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), 'aevistle-sig-'))
try {
  for (const asset of ['SHA256SUMS.txt', 'SHA256SUMS.txt.asc', 'aevistle-public-key.asc']) {
    const got = run('gh', ['release', 'download', tag, '--repo', REPO, '-p', asset, '-D', dir])
    if (got.status !== 0) {
      console.log('  ⚠ Could not download the release assets. Not checked this run.\n')
      process.exit(0)
    }
  }

  const verified = run(GPG, [
    '--no-default-keyring',
    '--keyring',
    path.join(dir, 'aevistle-public-key.asc'),
    '--verify',
    path.join(dir, 'SHA256SUMS.txt.asc'),
    path.join(dir, 'SHA256SUMS.txt'),
  ])
  const out = `${verified.stdout ?? ''}${verified.stderr ?? ''}`

  if (!/Good signature/i.test(out)) {
    console.log(`  ✗ ${tag}: the published signature does not verify.`)
    console.log(`    ${out.trim().split('\n').slice(-2).join(' / ')}\n`)
    process.exit(1)
  }

  // The docs have to name the key that actually signed it, or every reader who
  // follows the published instructions gets a failure.
  const fpr = /([0-9A-F]{40})/i.exec(out.replace(/\s/g, ''))?.[1]
  if (fpr && existsSync('SECURITY.md')) {
    const security = readFileSync('SECURITY.md', 'utf8').replace(/\s/g, '')
    if (security.includes('GPG') && !security.includes(fpr)) {
      console.log(`  ✗ ${tag} is signed by ${fpr}, which SECURITY.md does not name.\n`)
      process.exit(1)
    }
  }

  console.log(`  ✓ ${tag} is signed, and the published signature verifies`)
  if (fpr) console.log(`    key ${fpr}`)
  console.log('\n  All clear.\n')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
