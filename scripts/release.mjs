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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import os from 'node:os'
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
  const r = spawnSync(cmd, quoted(args), { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) fail(why)
}

/**
 * Quote arguments that contain spaces, because `shell: true` means the shell
 * re-splits them.
 *
 * `--title` `Aevistle 0.1.6` arrived at gh as `--title Aevistle` plus a stray
 * `0.1.6`, which gh read as an asset pattern and rejected with "no matches
 * found for 0.1.6" — a message about the *title* that names a version number
 * and mentions neither. It went unnoticed because it only affects the
 * `release create` path: every release so far updated a tag that already
 * existed, and `release upload` takes no title.
 *
 * Quoting rather than dropping `shell: true`: on Windows the tools this runs
 * are `.cmd` shims that only resolve through a shell.
 */
function quoted(args) {
  if (process.platform !== 'win32') return args
  return args.map((a) => (/[\s]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a))
}

const ARTIFACTS = [
  `Aevistle-${VERSION}-win-x64-setup.exe`,
  `Aevistle-${VERSION}-win-x64-portable.exe`,
  `Aevistle-${VERSION}.apk`,
]

// --- 0. the APK actually is the version its filename claims -----------------
//
// v0.1.14 shipped with `versionName "0.1.13"` baked into its manifest: the APK
// in `release/` had been built sixteen minutes before the commit that bumped
// `android/app/build.gradle`, and nothing re-checked it before this script
// hashed, signed, and uploaded it under the new tag. Every check downstream —
// hashing, signing, the redownload-and-verify at the end — verifies that the
// *bytes* published match the *bytes* built. None of them ask whether the
// *app* those bytes contain agrees with the tag it is published under, so a
// stale rebuild sailed through every one of them.
//
// This reads the version the running app will actually report (`aapt dump
// badging`, the same tool a reviewer would reach for) and refuses to publish
// on a mismatch, rather than trusting that whoever ran the build did it in
// the right order.

step(0, 'Checking the APK reports the version it is being published as')
const apkPath = path.join('release', `Aevistle-${VERSION}.apk`)
if (existsSync(apkPath)) {
  const aapt = findAapt()
  if (!aapt) {
    fail(
      'Could not find aapt to verify the APK version.',
      'Install Android SDK build-tools, or set ANDROID_HOME.',
    )
  }
  const badging = spawnSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' })
  if (badging.status !== 0) fail(`Could not read ${apkPath} with aapt.`, badging.stderr)
  const builtVersion = /versionName='([^']*)'/.exec(badging.stdout)?.[1]
  if (builtVersion !== VERSION) {
    fail(
      `${apkPath} reports versionName '${builtVersion}', not '${VERSION}'.`,
      'Rebuild with `npm run build:android` after bumping android/app/build.gradle, then rerun this script.',
    )
  }
  console.log(`  ✓ ${apkPath} reports versionName '${VERSION}'`)
} else {
  console.log(`  (skipped: ${apkPath} does not exist yet — step 1 will report that.)`)
}

/** Find `aapt`, the way `scripts/build-android.mjs` finds the SDK it lives in. */
function findAapt() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]

  try {
    const local = readFileSync(path.join('android', 'local.properties'), 'utf8')
    const dir = /sdk\.dir\s*=\s*(.+)/.exec(local)?.[1]?.trim()
    // local.properties escapes Windows backslashes as `\:` and `\\`.
    if (dir) roots.push(dir.replace(/\\:/g, ':').replace(/\\\\/g, '\\'))
  } catch {
    /* no local.properties — rely on env vars and default install paths */
  }

  roots.push(
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  )

  for (const root of roots) {
    const buildTools = root && path.join(root, 'build-tools')
    if (!buildTools || !existsSync(buildTools)) continue
    const versions = readdirSync(buildTools).sort().reverse()
    for (const version of versions) {
      const exe = path.join(buildTools, version, process.platform === 'win32' ? 'aapt.exe' : 'aapt')
      if (existsSync(exe)) return exe
    }
  }
  return null
}

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

// A second, independent signature the desktop updater checks itself — see
// electron/updateSigningKey.ts for why this is not the same key as above.
const signedForUpdate = spawnSync('node', ['scripts/sign-update-manifest.mjs'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (signedForUpdate.status !== 0) {
  fail(
    'Could not sign the update manifest.',
    'Run scripts/setup-update-signing-key.mjs once if there is no key yet.',
  )
}

// --- 3. publish --------------------------------------------------------------

step(3, `Publishing ${TAG}`)
const assets = [
  ...ARTIFACTS.map((n) => path.join('release', n)),
  path.join('release', 'SHA256SUMS.txt'),
  path.join('release', 'SHA256SUMS.txt.asc'),
  path.join('release', 'SHA256SUMS.txt.ed25519'),
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
    const got = spawnSync('gh', quoted(['release', 'download', TAG, '-p', name, '-D', dir]), {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    if (got.status !== 0) fail(`Could not download ${name} back.`)
  }
  must('node', ['scripts/release-hashes.mjs', '--verify', dir], 'Published artifacts do not match.')
  must('node', ['scripts/check-signing.mjs'], 'The published signature does not verify.')
  must('node', ['scripts/check-update-signing.mjs'], 'The published update signature does not verify.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n  ${TAG} published: hashed, signed, uploaded, and verified from the published copies.\n`)
