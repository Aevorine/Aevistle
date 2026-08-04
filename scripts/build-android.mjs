/**
 * Build the Android release APK — `npm run build:android`.
 *
 * Wraps Gradle rather than asking people to remember the incantation, and does
 * the three things that otherwise waste an afternoon:
 *
 *   1. finds a JDK 17 and an Android SDK even when neither is on PATH, which
 *      is the normal state of a Windows machine that installed them by hand;
 *   2. caps the Gradle daemon's heap. The default sizing assumes it owns the
 *      machine, and on a 16 GB laptop that is already running a bundler it
 *      dies with a native-allocation crash rather than a build error;
 *   3. checks the APK afterwards. Gradle reports success for an assemble that
 *      produced nothing when the output directory was stale.
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ANDROID = path.join(ROOT, 'android')
const OUT = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release')

// ---------------------------------------------------------------------------
// Toolchain discovery
// ---------------------------------------------------------------------------

function firstExisting(candidates) {
  return candidates.find((c) => c && existsSync(c)) ?? null
}

/**
 * Capacitor 8 compiles itself with `sourceCompatibility 21`, so an older JDK
 * fails with "invalid source release: 21" — from inside a dependency, which is
 * a confusing place to read an error. Hence: pick by *version*, never by
 * directory name, and say so plainly when nothing suitable is installed.
 */
const REQUIRED_JAVA = 21

/** Read the major version out of a JDK's `release` file. */
function javaMajor(home) {
  try {
    const release = readFileSync(path.join(home, 'release'), 'utf8')
    const raw = /JAVA_VERSION="?([0-9._]+)/.exec(release)?.[1]
    if (!raw) return null
    // "21.0.10" -> 21, and the old "1.8.0_481" -> 8.
    const parts = raw.split('.')
    return Number(parts[0] === '1' ? parts[1] : parts[0])
  } catch {
    return null
  }
}

/**
 * Places a JDK plausibly lives, without hard-coding anyone's drive layout.
 *
 * On Windows the same folder name ("Program Files", "Android", a personal
 * "Apps" directory) turns up on whichever drive the machine happens to use, so
 * the roots are composed from the drives that exist rather than listed.
 */
function searchRoots() {
  if (process.platform !== 'win32') {
    return ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/opt']
  }

  const drives = 'CDEFG'
    .split('')
    .map((letter) => `${letter}:\\`)
    .filter((drive) => existsSync(drive))

  const folders = [
    'Program Files',
    'Program Files\\Java',
    'Program Files\\Android',
    'Program Files\\Eclipse Adoptium',
    'Program Files\\Microsoft',
    'Program Files\\Amazon Corretto',
    'Apps',
    'APPS',
    'Java',
    'Tools',
    '', // the drive root itself, for D:\jdk-21 style installs
  ]

  const roots = []
  for (const drive of drives) {
    for (const folder of folders) {
      const full = folder ? path.join(drive, folder) : drive
      if (existsSync(full)) roots.push(full)
    }
  }
  return roots
}

function jdkCandidates() {
  const found = []

  const add = (home) => {
    if (!home) return
    // macOS nests the real home one level deeper.
    const real = firstExisting([home, path.join(home, 'Contents', 'Home')])
    if (real && existsSync(path.join(real, 'bin')) && !found.includes(real)) found.push(real)
  }

  add(process.env.JAVA_HOME)

  // Android Studio ships a JDK that always matches what the Android plugin
  // wants; on a machine where nothing else is installed it is the one that
  // works, so it is checked early.
  for (const root of searchRoots()) {
    for (const name of ['Android Studio', 'AndroidStudio', 'android-studio']) {
      add(path.join(root, name, 'jbr'))
      add(path.join(root, name, 'jre'))
    }
  }
  add('/Applications/Android Studio.app/Contents/jbr')
  add(path.join(os.homedir(), 'Android', 'android-studio', 'jbr'))

  const roots = searchRoots()

  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!/jdk|java|jbr|zulu|corretto|temurin/i.test(name)) continue
      const full = path.join(root, name)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      add(full)
      // One more level: <tools-dir>\JDK17\jdk-17.0.x+y
      try {
        for (const nested of readdirSync(full)) add(path.join(full, nested))
      } catch {
        /* not a directory we can list */
      }
    }
  }

  return found
}

function findJdk() {
  const rated = jdkCandidates()
    .map((home) => ({ home, major: javaMajor(home) ?? 0 }))
    .sort((a, b) => b.major - a.major)

  const usable = rated.find((j) => j.major >= REQUIRED_JAVA)
  if (usable) return usable.home

  if (rated.length > 0) {
    console.error(
      `Found JDK ${rated[0].major} at ${rated[0].home}, but the Android build needs ` +
        `JDK ${REQUIRED_JAVA} or newer (Capacitor compiles with source level ${REQUIRED_JAVA}).`,
    )
  }
  return null
}

function findSdk() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
  ]

  // Same reasoning as searchRoots(): find the folder, do not assume the drive.
  for (const root of searchRoots()) {
    for (const name of ['Android', 'AndroidSDK', 'android-sdk']) {
      candidates.push(path.join(root, name, 'sdk'), path.join(root, name))
    }
  }

  const usable = candidates.filter(
    (dir) =>
      dir && existsSync(path.join(dir, 'platforms')) && existsSync(path.join(dir, 'build-tools')),
  )

  // Two SDKs on one machine is common, and only one of them tends to have the
  // platform this project compiles against. Picking the wrong one fails deep
  // inside Gradle with a message about a missing android.jar, so prefer the
  // one that actually has it. ("android-36.1" does not satisfy compileSdk 36.)
  const wanted = compileSdkVersion()
  if (wanted) {
    const exact = usable.find((dir) =>
      existsSync(path.join(dir, 'platforms', `android-${wanted}`)),
    )
    if (exact) return exact
  }

  return usable[0] ?? null
}

/** The platform the Gradle build asks for, read rather than assumed. */
function compileSdkVersion() {
  try {
    const gradle = readFileSync(path.join(ANDROID, 'variables.gradle'), 'utf8')
    const value = /compileSdkVersion\s*=\s*(\d+)/.exec(gradle)?.[1]
    return value ? Number(value) : null
  } catch {
    return null
  }
}

const jdk = findJdk()
const sdk = findSdk()

if (!jdk) {
  console.error(
    `No usable JDK found. Install JDK ${REQUIRED_JAVA}+ (or Android Studio, which ` +
      'bundles one) and set JAVA_HOME if it is not in a standard location.',
  )
  process.exit(1)
}
if (!sdk) {
  console.error(
    'No Android SDK found. Install the command-line tools and set ANDROID_HOME.',
  )
  process.exit(1)
}

console.log(`  JDK          ${jdk}`)
console.log(`  Android SDK  ${sdk}`)

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Stale output is how a failed build gets reported as a success: the previous
// APK is still sitting there and every "did it work?" check passes.
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })

const gradlew = process.platform === 'win32'
  ? path.join(ANDROID, 'gradlew.bat')
  : path.join(ANDROID, 'gradlew')

const env = {
  ...process.env,
  JAVA_HOME: jdk,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  // 2 GB is comfortable for this project and leaves room for everything else on
  // a 16 GB machine. Raising it is what caused the crash this cap exists for.
  GRADLE_OPTS: '-Xmx2g -Dorg.gradle.daemon=false -Dfile.encoding=UTF-8',
}

console.log('\n  Running Gradle assembleRelease — this takes a few minutes\n')

try {
  execFileSync(gradlew, ['assembleRelease', '--no-daemon', '--stacktrace'], {
    cwd: ANDROID,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
} catch (e) {
  console.error(`\nGradle failed: ${e.message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

if (!existsSync(OUT)) {
  console.error(`\nGradle exited 0 but ${OUT} does not exist.`)
  process.exit(1)
}

const apks = readdirSync(OUT).filter((f) => f.endsWith('.apk'))
if (apks.length === 0) {
  console.error(`\nGradle exited 0 but produced no APK in ${OUT}.`)
  process.exit(1)
}

for (const apk of apks) {
  const full = path.join(OUT, apk)
  const { size } = statSync(full)
  // A Capacitor shell with JavaMail is ~4 MB; anything under 1 MB means the
  // web assets never made it in.
  if (size < 1_000_000) {
    console.error(`\n${apk} is only ${size} bytes — the web assets are missing.`)
    process.exit(1)
  }
  console.log(`\n  ${apk}  ${(size / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  ${full}`)
}

// Signature check, when the SDK has build-tools. An unsigned APK installs
// nowhere, and finding that out from a user is the expensive way.
//
// Gradle now refuses to produce a debug-signed release at all unless
// AEVISTLE_ALLOW_UNSIGNED_RELEASE is set (see android/app/build.gradle). This
// is the second lock on the same door, and it is worth having: it reads the
// signature off the artifact rather than trusting the build that made it, so a
// misconfiguration that slipped past the Gradle check still cannot leave this
// script looking like a successful release build.
let signature = null
try {
  const buildTools = path.join(sdk, 'build-tools')
  const version = readdirSync(buildTools).sort().reverse()[0]
  const apksigner = path.join(
    buildTools,
    version,
    process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
  )
  if (existsSync(apksigner)) {
    const out = execSync(`"${apksigner}" verify --print-certs "${path.join(OUT, apks[0])}"`, {
      env,
      encoding: 'utf8',
    })
    signature = /Signer #1 certificate DN: (.+)/.exec(out)?.[1]?.trim() ?? 'unknown'
    console.log(`  Signed by    ${signature}`)
  }
} catch {
  console.log('  Signature not verified (apksigner unavailable) — check before publishing.')
}

const allowUnsigned = ['1', 'true', 'yes'].includes(
  (process.env.AEVISTLE_ALLOW_UNSIGNED_RELEASE ?? '').trim().toLowerCase(),
)

if (signature && /CN=Android Debug/i.test(signature)) {
  if (!allowUnsigned) {
    console.error(
      '\nThis APK is signed with the Android debug key, which should no longer be\n' +
        'possible. Do not publish it: an APK signed with that key can never be\n' +
        'updated over a real release. Check android/app/build.gradle.',
    )
    process.exit(1)
  }
  console.log(
    '\n  AEVISTLE_ALLOW_UNSIGNED_RELEASE is set, so this APK carries the debug key.\n' +
      '  Installable for testing. Never publish it.',
  )
}
