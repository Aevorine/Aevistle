/**
 * The Android row that can say "everything is granted and mail still is not
 * arriving" — `npm run check:keepalive`.
 *
 * Three permissions decide whether this app *may* receive mail in the
 * background, and the settings screen has shown all three since they were
 * added. None of them decides whether it *does*. Huawei, Honor, Xiaomi, OPPO,
 * vivo and Samsung each ship an auto-start list that is not an Android
 * permission, has no API, and freezes `InboxIdleService` regardless of what
 * those three say. So a phone can read granted / granted / granted and receive
 * nothing, which is exactly the report this came from and which the app had no
 * way to answer.
 *
 * What is guarded here:
 *
 *   1. The status row reports the *service*, not a permission. If it ever
 *      starts deriving its answer from the permissions above it, it becomes
 *      three rows saying the same true-and-useless thing.
 *   2. "No account is receiving" is `not-required`, not `denied`. A fresh
 *      install with nothing switched on must not open on a red row telling the
 *      user to go fight their battery manager over a service that correctly
 *      does not exist.
 *   3. The auto-start button reaches the auto-start opener. It very nearly did
 *      not: `fixPermission` ended in an unnamed `else` that fell through to the
 *      battery dialog, which opens, looks like it worked, and changes nothing
 *      about the list that was actually stopping the service. A wrong screen
 *      that appears is worse than a button that fails.
 *   4. There is always a fallback. Vendor component names are private, get
 *      renamed between OS versions, and are not exported on some builds — so
 *      the opener has to end at a screen that always exists.
 *
 * `--selftest` reroutes the auto-start button through the battery opener and
 * requires this to go red.
 */

import { readFile } from 'node:fs/promises'

const selftest = process.argv.includes('--selftest')

let failed = 0
const checks = []
const check = (name, ok, detail = '') => {
  checks.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

const perms = await readFile('android/app/src/main/java/dev/aevistle/app/Permissions.java', 'utf8')
const plugin = await readFile(
  'android/app/src/main/java/dev/aevistle/app/AevistleNativePlugin.java',
  'utf8',
)
const bridge = await readFile('src/core/platform/bridge-android.ts', 'utf8')
let hook = await readFile('src/state/hooks/useAndroidPermissions.ts', 'utf8')

if (selftest) {
  hook = hook.replace(
    "else if (what === 'openAutoStartSettings') await android.openAutoStartSettings?.()",
    '',
  )
}

// --- 1. it reports the service, not a permission ----------------------------

const backgroundService = /static String backgroundService\(Context context\) \{[\s\S]*?\n    \}/.exec(
  perms,
)?.[0]

check('Permissions.java answers for the background service', Boolean(backgroundService))
check(
  'and it answers by looking for the service itself',
  /InboxIdleService\.class\.getName\(\)/.test(backgroundService ?? ''),
)
check(
  'not by re-reading a permission',
  !/isIgnoringBatteryOptimizations|canScheduleExactAlarms|areNotificationsEnabled/.test(
    backgroundService ?? '',
  ),
  'the service row must not be derived from the permission rows',
)

// --- 2. nothing to do is not a failure --------------------------------------

check(
  'an account-less phone reports not-required rather than stopped',
  /enabledAccounts\(\)\.isEmpty\(\)\)\s*return NOT_REQUIRED/.test(backgroundService ?? ''),
)
check(
  'a refusal to enumerate is not reported as stopped either',
  // Generous span: the catch block carries the explanation of *why* it answers
  // this way, and a bound tight enough to exclude a comment is a bound that
  // fails the next time someone documents their reasoning properly.
  /catch[\s\S]{0,600}?return NOT_REQUIRED/.test(backgroundService ?? ''),
  'an unknowable answer must not send the user off to fix the wrong thing',
)

// --- 3. the button reaches the opener ---------------------------------------

check(
  'the auto-start action is routed by name, not by falling through',
  /what === 'openAutoStartSettings'\s*\)\s*await android\.openAutoStartSettings\?\.\(\)/.test(hook),
  /openAutoStartSettings/.test(hook) ? '' : 'no route at all',
)
check(
  'the battery opener is still the one the battery action reaches',
  /openBatteryOptimizationSettings\?\.\(\)/.test(hook),
)
check('the plugin exposes the opener', /public void openAutoStartSettings\(PluginCall call\)/.test(plugin))
check('the plugin reports the service state', /result\.put\("backgroundService"/.test(plugin))
check('the bridge declares both', /openAutoStartSettings\(\): Promise/.test(bridge) && /backgroundService: BackgroundServiceState/.test(bridge))
check('the bridge implements the opener', /openAutoStartSettings: \(\) => Native\.openAutoStartSettings\(\)/.test(bridge))

// --- 4. always a fallback ---------------------------------------------------

const opener = /static boolean openAutoStartSettings\([\s\S]*?\n    \}/.exec(perms)?.[0] ?? ''
check('the opener tries the Huawei manager the report came from', /com\.huawei\.systemmanager/.test(opener))
check(
  'it covers the other vendors that ship one',
  ['miui.securitycenter', 'coloros.safecenter', 'vivo.permissionmanager', 'samsung'].every((v) =>
    opener.includes(v),
  ),
)
check(
  'and it ends somewhere that always exists',
  /appDetails\(context\)/.test(opener),
  'a private vendor component that has been renamed must not leave a dead button',
)

// --- the words ---------------------------------------------------------------

for (const locale of ['ar', 'en', 'es', 'fr', 'ru', 'zh-CN']) {
  const src = await readFile(`src/i18n/${locale}.ts`, 'utf8')
  check(
    `${locale} has the service row and its button`,
    ["'settings.permBackgroundService'", "'settings.permServiceStopped'", "'settings.permOpenAutoStart'"].every(
      (k) => src.includes(k),
    ),
  )
}

console.log('')

const label = 'the phone can say when its own app manager stopped us'

if (selftest) {
  console.log(`  ${label}\n  ${checks.length} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: a misrouted auto-start button was not caught.\n')
    process.exit(1)
  }
  console.log('  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

if (failed === 0) {
  console.log(`  ${label}\n  ${checks.length} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`  ${label}\n  ${checks.length} checks, ${failed} failed\n`)
process.exit(1)
