/**
 * Publish a release, start to finish — `npm run release -- v0.1.6`.
 *
 * This exists because signing was a separate command, and a separate command is
 * a thing that gets skipped. Not maliciously and not even carelessly: it gets
 * skipped on the evening the build took three tries, and after that every
 * release is unsigned and nothing anywhere says so. The absence of a signature
 * is invisible from the download page.
 *
 * So it is not a step here. It is inside the one thing that publishes, and
 * publishing cannot finish without it: a run that cannot sign fails before the
 * assets go up, rather than leaving a published release someone has to remember
 * to come back and fix.
 *
 * The order is deliberate:
 *
 *   1. Hash the artifacts, refusing to proceed if any is missing or empty.
 *   2. Sign the manifest and verify that signature in a keyring holding only
 *      the published public key — the check a stranger would run.
 *   3. Only then create or update the release and upload everything.
 *   4. Download it all back and verify again, from the published copies. The
 *      upload tool reporting success is not evidence that what landed is what
 *      was built; this project has been bitten by exactly that before.
 *
 * Every step prints what it verified. A step that cannot verify stops the run.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TAG = process.argv[2]
const NOTES = process.argv[3] ?? null

if (!TAG || !/^v\d+\.\d+\.\d+/.test(TAG)) {
  console.error('Usage: npm run release -- v0.1.6 [notes-file.md]')
  process.exit(2)
}
const VERSION = TAG.replace(/^v/, '')

const step = (n, what) => console.log(`\n  [${n}/4] ${what}`)
const fail = (why, hint) => {
  console.error(`\n  ✗ ${why}`)
  if (hint) console.error(`    ${hint}`)
  console.error('\n  Nothing was published.\n')
  process.exit(1)
}

/** Run a child step, streaming its output, and stop the release if it fails. */
function must(cmd, args, why) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) fail(why)
}

const ARTIFACTS = [
  `Aevistle-${VERSION}-win-x64-setup.exe`,
  `Aevistle-${VERSION}-win-x64-portable.exe`,
  `Aevistle-${VERSION}.apk`,
]

// --- 1. hashes ---------------------------------------------------------------

step(1, 'Hashing artifacts')
for (const name of ARTIFACTS) {
  const p = path.join('release', name)
  if (!existsSync(p)) fail(`${p} is missing.`, 'Build both platforms before publishing.')
}
must('node', ['scripts/release-hashes.mjs'], 'Could not write SHA256SUMS.txt.')

// --- 2. sign, before anything is published -----------------------------------
//
// Ahead of the upload on purpose. Signing afterwards would mean a failure here
// leaves a published, unsigned release behind — the exact state this script
// exists to make impossible.

step(2, 'Signing the manifest')
const signed = spawnSync('node', ['scripts/sign-release.mjs', TAG, '--no-upload'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (signed.status !== 0) {
  fail(
    'Could not sign the release.',
    'Run scripts/setup-signing-key.ps1 (Windows) or .sh once if there is no key yet.',
  )
}

// --- 3. publish --------------------------------------------------------------

step(3, `Publishing ${TAG}`)
const assets = [
  ...ARTIFACTS.map((n) => path.join('release', n)),
  path.join('release', 'SHA256SUMS.txt'),
  path.join('release', 'SHA256SUMS.txt.asc'),
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.aevistle', 'aevistle-public-key.asc'),
].filter((p) => existsSync(p))

const exists = spawnSync('gh', ['release', 'view', TAG], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (exists.status === 0) {
  must('gh', ['release', 'upload', TAG, ...assets, '--clobber'], 'Upload failed.')
} else {
  const args = ['release', 'create', TAG, ...assets, '--title', `Aevistle ${VERSION}`]
  if (NOTES) args.push('--notes-file', NOTES)
  else args.push('--generate-notes')
  must('gh', args, 'Could not create the release.')
}

// --- 4. verify the published copies -------------------------------------------
//
// Re-downloaded rather than re-read from disk. "gh said it worked" is a report
// about a network call, not evidence about what is now on the release page.

step(4, 'Verifying what was published')
const dir = mkdtempSync(path.join(tmpdir(), 'aevistle-release-'))
try {
  for (const name of [...ARTIFACTS, 'SHA256SUMS.txt']) {
    const got = spawnSync('gh', ['release', 'download', TAG, '-p', name, '-D', dir], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    if (got.status !== 0) fail(`Could not download ${name} back.`)
  }
  must('node', ['scripts/release-hashes.mjs', '--verify', dir], 'Published artifacts do not match.')
  must('node', ['scripts/check-signing.mjs'], 'The published signature does not verify.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n  ${TAG} published: hashed, signed, uploaded, and verified from the published copies.\n`)
