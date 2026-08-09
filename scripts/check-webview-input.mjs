/**
 * The Android WebView has to deliver typed text as `input` events, or React
 * never learns anything was typed.
 *
 * This exists because of one line of configuration and the two-part bug report
 * it produced: "typing the address fills nothing in", and "type in one box and
 * the others go empty". Both are the same fault and neither is visible on a
 * desktop, in the browser preview, or in the e2e suite, because all three run a
 * WebView Capacitor has not touched.
 *
 * `android.captureInput: true` is Capacitor's hook for hardware keyboards and
 * barcode scanners. `CapacitorWebView.onCreateInputConnection` implements it by
 * returning `new BaseInputConnection(webView, false)` instead of the WebView's
 * own connection, and the `false` is the whole problem: it means "not a full
 * editor", so there is no editable buffer for the IME to compose into. Android
 * falls back to key events, and anything it cannot map to a keycode — a
 * predicted word, any CJK composition, an emoji — arrives as
 * `KeyEvent.ACTION_MULTIPLE`, which Capacitor handles by evaluating
 *
 *     document.activeElement.value = document.activeElement.value + '…'
 *
 * That assignment mutates the DOM node directly. No `input` event is dispatched,
 * so React's `onChange` never fires, so the component's state stays as it was.
 * The box *looks* filled. Then the next render of anything at all — one
 * keystroke in another field, a switch, the connection test's elapsed-seconds
 * counter — reconciles every controlled input back to the state React holds,
 * and the text disappears. Hence the symmetry: whichever field you touch, the
 * others empty.
 *
 * In the account dialog it also silently disabled auto-configuration, which
 * runs from the address field's `onChange`: no event, no provider match, no
 * host, no port, no username. The feature looked unimplemented.
 *
 * Two things are checked, and the second is the one that catches a regression
 * that has already shipped:
 *
 *   1. `capacitor.config.ts` does not turn it on.
 *   2. `android/app/src/main/assets/capacitor.config.json` — the copy `cap sync`
 *      writes into the APK, and the only one the running app reads — agrees
 *      with it. Editing the source and building without a sync leaves the old
 *      value in the artifact, so the fix would be in the repository and absent
 *      from the app, which is indistinguishable from not having fixed it.
 *
 * `--selftest` injects both faults and requires this to go red on each.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_TS = 'capacitor.config.ts'
const SYNCED_JSON = 'android/app/src/main/assets/capacitor.config.json'

const selftest = process.argv.includes('--selftest')

const failures = []
let checks = 0
const check = (what, ok, why) => {
  checks++
  if (!ok) failures.push(why ? `${what} — ${why}` : what)
}

console.log('\n  Checking the Android WebView delivers typed text to React…\n')

// --- 1. the source of truth -------------------------------------------------

let configTs = readFileSync(path.join(ROOT, CONFIG_TS), 'utf8')
if (selftest) configTs = configTs.replace(/captureInput:\s*false/, 'captureInput: true')

/**
 * Comments blanked, newlines kept — the approach `check-css-tokens.mjs`
 * established. The option is discussed at length in the config's own comment,
 * and prose about a setting is not the setting.
 */
const code = configTs.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))

const enabledInSource = /captureInput\s*:\s*true/.test(code)
check(
  `${CONFIG_TS} does not enable android.captureInput`,
  !enabledInSource,
  'it replaces the IME connection with a non-editor one, and typed text then reaches the DOM without an input event',
)

// --- 2. and what actually shipped -------------------------------------------

const syncedPath = path.join(ROOT, SYNCED_JSON)
if (!existsSync(syncedPath)) {
  // A working tree that has never run `cap sync` has nothing to disagree with.
  console.log(`  ${SYNCED_JSON} not present — skipping the synced-copy check.`)
} else {
  let syncedRaw = readFileSync(syncedPath, 'utf8')
  if (selftest) syncedRaw = syncedRaw.replace(/"captureInput":\s*false/, '"captureInput": true')

  let synced = null
  try {
    synced = JSON.parse(syncedRaw)
  } catch {
    /* handled by the check below */
  }
  check(`${SYNCED_JSON} is readable JSON`, synced !== null)

  const enabledInApk = synced?.android?.captureInput === true
  check(
    `${SYNCED_JSON} agrees with ${CONFIG_TS}`,
    !enabledInApk && enabledInApk === enabledInSource,
    enabledInApk
      ? 'the copy inside the APK still enables captureInput; run `npm run cap:sync` before building'
      : 'the synced copy disagrees with the source',
  )
}

// ---------------------------------------------------------------------------

if (selftest) {
  const wanted = ['does not enable android.captureInput', 'agrees with']
  const missed = wanted.filter((w) => !failures.some((f) => f.includes(w)))
  console.log(`  ${checks} checks, ${failures.length} failed`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  if (missed.length) {
    console.log(`\n  SELFTEST FAILED: these injected faults were not caught: ${missed.join(', ')}\n`)
    process.exit(1)
  }
  console.log('\n  Selftest OK — every injected fault was caught.\n')
  process.exit(0)
}

console.log(`  ${checks} checks${failures.length ? `, ${failures.length} failed` : ''}`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log(failures.length ? '\n  Typing on Android would not reach React.\n' : '\n  All clear.\n')
process.exit(failures.length ? 1 : 0)
