#!/usr/bin/env node
/**
 * Can another application still hand this one something to send?
 *
 * "Share to Aevistle" is not one feature, it is a chain of six links across two
 * platforms, and every single break in it is silent. The manifest, the registry
 * writes, the argv parse, the buffer, the subscription and the draft merge all
 * compile independently of each other; none of them fails a build, a test or a
 * review when it stops connecting to the next one. The symptom is always the
 * same and always deniable: the app is simply not in the share sheet, or it
 * opens on an empty Compose screen. There is nothing to read in a log.
 *
 * Every assertion below stands for a break that actually happened:
 *
 *   - The intent filters were correct and the feature still did not exist on the
 *     phone, because they were only ever in a build nobody installed. A gate
 *     cannot check what is on a device, but it can refuse to let the filters
 *     quietly disappear from the manifest.
 *   - `protocols: mailto` in electron-builder.yml reads like it registers the
 *     handler on Windows and does not — only the mac, Linux and AppX targets
 *     consult that key. The NSIS script is the only thing that writes those
 *     registry values, so it is the thing that has to be checked.
 *   - `second-instance` was wired up taking no arguments, so a share arriving
 *     at an already-running app raised the window and dropped the payload.
 *   - The share was applied to the draft before start-up finished, and `hydrate`
 *     then replaced the whole state object with what was on disk. On Windows
 *     that was not a race but a certainty. The subscription being gated on
 *     `ready` is the fix, and it is one word — exactly the kind of word that
 *     comes out again during an unrelated tidy-up, with no visible consequence
 *     until somebody follows a mailto: link with the app closed.
 *
 * Deliberately NOT checked: the Windows 11 share sheet. That needs an MSIX
 * package with a `windows.shareTarget` extension, this project ships NSIS and
 * portable builds, and the decision not to add one was made explicitly. The
 * honest Windows story is the mailto handler and the Send To entry, so those are
 * what this gate holds to.
 *
 * Exit code 1 if any link in the chain is missing.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let checks = 0
let failed = 0
const check = (label, condition, detail = '') => {
  checks++
  if (condition) return
  failed++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n  another application can still hand Aevistle something to send\n')

// --- Android: the share sheet has to be told this app exists ----------------

const manifest = read('android/app/src/main/AndroidManifest.xml')

/**
 * The activity block, so a filter cannot pass this gate by sitting on a
 * receiver. Only an exported activity with a DEFAULT category is offered in a
 * chooser; the same filter on `AlarmReceiver` would satisfy a naive substring
 * search and put nothing in the share sheet.
 */
const activity = manifest.match(/<activity\b[\s\S]*?<\/activity>/g)?.join('\n') ?? ''
check('MainActivity is declared as an activity', /android:name="\.MainActivity"/.test(activity))
check(
  'MainActivity is exported, or the launcher and every filter on it are unreachable',
  /android:exported="true"/.test(activity),
)

const filters = activity.match(/<intent-filter>[\s\S]*?<\/intent-filter>/g) ?? []
const filterWith = (...needles) =>
  filters.filter((f) => needles.every((n) => f.includes(n)))

check(
  'a SEND filter accepts plain text, so long-pressing text offers this app',
  filterWith(
    'android.intent.action.SEND',
    'android.intent.category.DEFAULT',
    'android:mimeType="text/plain"',
  ).length > 0,
)
check(
  'a SEND_MULTIPLE filter accepts any type, so sharing files and images offers this app',
  filterWith(
    'android.intent.action.SEND_MULTIPLE',
    'android.intent.category.DEFAULT',
    'android:mimeType="*/*"',
  ).length > 0,
)
check(
  'a SENDTO filter claims mailto:, so this app can be a mail client',
  filterWith('android.intent.action.SENDTO', 'android:scheme="mailto"').length > 0,
)

// --- Android: the intent has to reach the WebView ---------------------------

const mainActivity = read('android/app/src/main/java/dev/aevistle/app/MainActivity.java')
check(
  'a warm share is collected — onNewIntent is overridden',
  /onNewIntent\s*\(/.test(mainActivity),
  'singleTask means a second share never re-runs onCreate',
)
check(
  'the shared text is read as a CharSequence, not a String',
  /getCharSequenceExtra\s*\(\s*Intent\.EXTRA_TEXT/.test(mainActivity),
  'getStringExtra silently returns null for styled text',
)
check('attached files are read from EXTRA_STREAM', /EXTRA_STREAM/.test(mainActivity))
check(
  'a cold share is parked for collection rather than sent into a dead WebView',
  /pendingShare/.test(mainActivity),
)

const plugin = read('android/app/src/main/java/dev/aevistle/app/AevistleNativePlugin.java')
check(
  'the JS side has a method to collect the parked share',
  /takePendingShare/.test(plugin) && /takePendingShare/.test(read('src/core/bridge-android.ts')),
)

// --- Windows: the OS has to be told too ------------------------------------

const nsh = read('build/installer.nsh')
check(
  'the installer creates the Explorer "Send to" shortcut',
  /CreateShortcut\s+"\$SENDTO\\/.test(nsh),
)
check(
  'the installer registers a mailto: ProgID with a URL Protocol value',
  /Url\.mailto"\s+"URL Protocol"/.test(nsh),
)
check(
  'the ProgID has an open command that is handed the URL',
  /Url\.mailto\\shell\\open\\command/.test(nsh),
)
check(
  'the app appears in Settings, Default apps — Clients\\Mail Capabilities',
  /Software\\Clients\\Mail\\.*\\Capabilities\\UrlAssociations/.test(nsh),
)
check(
  'and in RegisteredApplications, without which the Capabilities block is never read',
  /Software\\RegisteredApplications/.test(nsh),
)

const builder = read('electron-builder.yml')
check(
  'the NSIS target still includes installer.nsh, or none of the above is ever written',
  /include:\s*build\/installer\.nsh/.test(builder),
)

const main = read('electron/main.ts')
check(
  'the running app claims mailto: at runtime as well',
  /setAsDefaultProtocolClient\(\s*'mailto'\s*\)/.test(main),
)
check(
  'a share to an already-running app reads the new command line',
  /second-instance[\s\S]{0,400}?argv/.test(main),
  'the handler took no arguments once, so the payload was dropped',
)
check('a cold share parses process.argv', /shareFromArgv/.test(main))
check('mailto: URLs are parsed', /shareFromMailto/.test(main))
check(
  'a share arriving before the page is alive is buffered in main',
  /pendingShare/.test(main) && /did-finish-load/.test(main),
)

const preload = read('electron/preload.ts')
check(
  'preload buffers the payload too, since the page cannot listen while it loads',
  /pendingShare/.test(preload),
)
check(
  'preload resumes buffering after an unsubscribe',
  /shareDelivered\s*=\s*false/.test(preload),
  'latching it on for the life of the window makes the buffer go deaf after the first subscribe',
)

// --- both platforms: the payload has to survive start-up --------------------

const app = read('src/App.tsx')
const shareEffect = app.match(/useEffect\(\(\)\s*=>\s*\{[^}]*onShare[\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
check('there is a share subscription in App.tsx', Boolean(shareEffect))
check(
  'the share subscription waits for `ready`',
  Boolean(shareEffect) && /if\s*\(\s*!ready\b/.test(shareEffect[0]),
  'hydrate replaces the whole state object, draft included, so a share applied before it is discarded',
)
check(
  '`ready` is in the subscription dependencies, or the guard never re-runs',
  Boolean(shareEffect) && /\[[^\]]*\bready\b[^\]]*\]\)$/.test(shareEffect[0]),
)
check(
  'the payload is merged into the draft rather than replacing it',
  /type:\s*'setDraft'/.test(app),
)

// ---------------------------------------------------------------------------

if (failed === 0) {
  console.log(`  ${checks} checks, all clear.\n`)
  process.exit(0)
}
console.log(`\n  ${checks} checks, ${failed} failed\n`)
process.exit(1)
