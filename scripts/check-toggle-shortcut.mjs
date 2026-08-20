/**
 * The show/hide shortcut does what the settings row claims — `npm run check:toggle-shortcut`.
 *
 * A global accelerator is the one control in this app that is used while the
 * app is *not on screen*, which makes it the one whose failure nobody sees.
 * `globalShortcut.register` returns `false` — no throw, no log — when another
 * application already holds the combination, so a settings row drawn from the
 * stored preference would show a key that does nothing at all. That is the same
 * shape as the scheduled task in 0.3.26 (registered, and unable to run), so it
 * gets the same treatment: read back what the OS granted, and prove here that
 * the read-back is real.
 *
 * `electron` is replaced with a stub that records every call, so this exercises
 * the actual module against a `globalShortcut` whose answers the test chooses —
 * including the answer that matters, `register` refusing.
 *
 * Also checks the wiring in `main.ts`, because a correct module nothing calls
 * correctly is the failure this project keeps finding:
 *
 *   - applied on *every* prefs push, not only when the value changed. The value
 *     can be lost without changing, when another app starts and takes it;
 *     applying on change alone leaves it dead until the next settings edit.
 *   - applied at startup too, before the renderer has pushed anything — a
 *     `--hidden` launch may have no window for a long time, and the key that
 *     reveals it has to work from the start.
 *   - released on the way out, so a relaunch that briefly overlaps can register.
 *
 * `--selftest` makes `register` always succeed and requires this to go red:
 * proof that the refusal path is what the safety checks are measuring.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const selftest = process.argv.includes('--selftest')

let failed = 0
let checked = 0
const check = (what, ok, detail = '') => {
  checked++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// --- build the module against a fake Electron -------------------------------

const out = join(root, 'node_modules', '.aevistle-shortcut')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

/*
 * The stub is a module, not a mock library: the point is that the code under
 * test is unmodified, and only the platform underneath it is chosen. `taken`
 * is the switch this whole gate exists for — the combination another
 * application already holds.
 */
writeFileSync(
  join(out, 'electron-stub.mjs'),
  `export const calls = []
export const taken = new Set()
export const globalShortcut = {
  register(accelerator, handler) {
    calls.push(['register', accelerator])
    if (taken.has(accelerator)) return ${selftest ? 'true' : 'false'}
    held.add(accelerator)
    handlers.set(accelerator, handler)
    return true
  },
  unregister(accelerator) {
    calls.push(['unregister', accelerator])
    held.delete(accelerator)
    handlers.delete(accelerator)
  },
  isRegistered: (accelerator) => held.has(accelerator),
}
export const held = new Set()
export const handlers = new Map()
export const BrowserWindow = { getAllWindows: () => [] }
`,
  'utf8',
)

/*
 * Transpiled, not bundled, and then the import specifier is rewritten by hand.
 *
 * `--bundle --alias:electron=…` inlines a *copy* of the stub into the output,
 * so the module under test mutates one set of objects while this file, having
 * imported the stub separately, inspects another. Everything then reads as
 * "nothing was registered" and the gate fails against working code — which is
 * a fake failure, and the kind that gets a real check deleted. Leaving the
 * import as an import and pointing it at the same file URL gives both sides one
 * shared instance.
 */
try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'electron/toggleShortcut.ts')}"`,
      '--format=esm',
      '--platform=node',
      `--outfile="${join(out, 'toggle.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const stubUrl = pathToFileURL(join(out, 'electron-stub.mjs')).href
const transpiled = readFileSync(join(out, 'toggle.mjs'), 'utf8')
if (!/from ["']electron["']/.test(transpiled)) {
  console.error('the module no longer imports electron — this gate is pointing at nothing')
  process.exit(1)
}
writeFileSync(
  join(out, 'toggle.mjs'),
  transpiled.replace(/from ["']electron["']/g, `from ${JSON.stringify(stubUrl)}`),
  'utf8',
)

const mod = await import(pathToFileURL(join(out, 'toggle.mjs')).href)
const {
  applyToggleShortcut,
  toggleShortcutState,
  releaseToggleShortcut,
  DEFAULT_TOGGLE_SHORTCUT,
} = mod

// The stub's own exports come through the bundle's copy of it.
const stub = await import(pathToFileURL(join(out, 'electron-stub.mjs')).href)

const noop = () => {}
const reset = () => {
  releaseToggleShortcut()
  stub.calls.length = 0
  stub.held.clear()
  stub.handlers.clear()
  stub.taken.clear()
}

// --- the default ------------------------------------------------------------

console.log('\n  The combination itself\n')

check(
  'the default needs a modifier and is not a bare key',
  /\+/.test(DEFAULT_TOGGLE_SHORTCUT) && !/^[A-Za-z0-9]$/.test(DEFAULT_TOGGLE_SHORTCUT),
  DEFAULT_TOGGLE_SHORTCUT,
)
check(
  'the default uses CommandOrControl so one string works on both platforms',
  DEFAULT_TOGGLE_SHORTCUT.startsWith('CommandOrControl'),
)
check(
  'the default avoids Ctrl+Shift, where browsers and chat apps put theirs',
  !/Shift/.test(DEFAULT_TOGGLE_SHORTCUT),
)

// --- registering ------------------------------------------------------------

console.log('\n  Registering\n')

reset()
let r = applyToggleShortcut('CommandOrControl+Alt+A', noop)
check('a free combination registers', r.registered === 'CommandOrControl+Alt+A' && !r.failure)
check('the handler is the one that was passed in', stub.handlers.size === 1)

reset()
applyToggleShortcut('CommandOrControl+Alt+A', noop)
stub.calls.length = 0
applyToggleShortcut('CommandOrControl+Alt+A', noop)
check(
  're-applying the same value unregisters before registering',
  stub.calls[0]?.[0] === 'unregister' && stub.calls[1]?.[0] === 'register',
  'the renderer pushes prefs on every settings edit; this must be idempotent',
)

reset()
applyToggleShortcut('CommandOrControl+Alt+A', noop)
r = applyToggleShortcut('CommandOrControl+Alt+B', noop)
check('changing the value drops the old one', !stub.held.has('CommandOrControl+Alt+A'))
check('changing the value takes the new one', stub.held.has('CommandOrControl+Alt+B'))

reset()
applyToggleShortcut('CommandOrControl+Alt+A', noop)
r = applyToggleShortcut(null, noop)
check('null turns it off', r.registered === null && stub.held.size === 0 && !r.failure)

// --- refusal, which is the point -------------------------------------------

console.log('\n  When the OS says no\n')

reset()
stub.taken.add('CommandOrControl+Alt+A')
r = applyToggleShortcut('CommandOrControl+Alt+A', noop)
check(
  'a combination another app holds is reported as taken',
  r.registered === null && r.failure === 'taken',
  // Without this the settings row would print a key that does nothing, which
  // is indistinguishable from the feature not existing.
  'register() returns false silently; nothing else would ever notice',
)
check('a refused combination is not remembered as active', toggleShortcutState().registered === null)

reset()
for (const bad of ['A', 'Ctrl', 'Ctrl+', '+A', '', 'Ctrl+Alt']) {
  const answer = applyToggleShortcut(bad, noop)
  check(
    `"${bad}" is refused as invalid rather than thrown`,
    answer.registered === null && (bad === '' ? true : answer.failure === 'invalid'),
  )
}
check(
  'a malformed value never reaches globalShortcut.register',
  !stub.calls.some(([kind]) => kind === 'register'),
  'register() throws on a bad accelerator, and a throw here is a modal error dialog',
)

reset()
applyToggleShortcut('CommandOrControl+Alt+A', noop)
stub.held.delete('CommandOrControl+Alt+A') // another app took it after we did
check(
  'a combination lost after the fact is reported, not remembered',
  toggleShortcutState().registered === null && toggleShortcutState().failure === 'taken',
  'state() asks isRegistered rather than trusting what it wanted',
)

reset()
applyToggleShortcut('CommandOrControl+Alt+A', noop)
releaseToggleShortcut()
check('release drops the registration', stub.held.size === 0)
check('release leaves nothing claimed', toggleShortcutState().registered === null)

// --- the wiring -------------------------------------------------------------

console.log('\n  How main.ts uses it\n')

const main = readFileSync(join(root, 'electron/main.ts'), 'utf8')
const prefsHandler = /ipcMain\.handle\(IPC\.setDesktopPrefs[\s\S]*?\n  \}\)/.exec(main)?.[0] ?? ''

check('the prefs handler applies the shortcut', /applyToggleShortcut/.test(prefsHandler))
check(
  'it is applied unconditionally, not only when the value changed',
  /applyToggleShortcut/.test(prefsHandler) &&
    !/if\s*\([^)]*[Ss]hortcut[Cc]hanged[^)]*\)\s*\{?\s*applyToggleShortcut/.test(prefsHandler),
  'the combination can be lost without the preference changing',
)
check(
  'the toggle it registers is the same one the tray click uses',
  /applyToggleShortcut\([^)]*toggleWindowFromTray/.test(main),
  'two implementations of "show or hide" would drift',
)
check(
  'it is also applied at startup, before the renderer pushes anything',
  /createWindow\(\)[\s\S]{0,900}?applyToggleShortcut/.test(main),
  'a --hidden launch may have no window for a long time',
)
check('it is released on the way out', /releaseToggleShortcut\(\)/.test(main))
check(
  'what the OS granted is exposed over IPC',
  /IPC\.toggleShortcutState/.test(main) && /toggleShortcutState\(\)/.test(main),
)
check(
  'an absent field falls back to the default rather than to off',
  /toggleShortcut === null[\s\S]{0,200}?DEFAULT_TOGGLE_SHORTCUT/.test(main),
  'a renderer that predates the field must not silently remove a working shortcut',
)

const settings = readFileSync(join(root, 'src/views/SettingsView.tsx'), 'utf8')
check(
  'the settings row reads the granted state, not the stored preference',
  /shortcutState\.registered/.test(settings) && /shortcutState\.failure/.test(settings),
)
check(
  'the field commits on blur, not on every keystroke',
  /onBlur=\{\(e\) =>[\s\S]{0,220}?toggleShortcut/.test(settings) &&
    !/onChange=\{\(e\) =>[\s\S]{0,120}?toggleShortcut:/.test(settings),
  'typing "Ctrl+Alt+A" passes through "C", "Ct", "Ctr", each unregistering the working one',
)

// --- verdict ----------------------------------------------------------------

const label = 'one key shows the window, and the same key hides it'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: a refused registration was not caught.\n')
    process.exit(1)
  }
  console.log('  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} checks${failed ? `, ${failed} failed` : ''}\n`)
if (failed === 0) console.log('  All clear.\n')
process.exit(failed === 0 ? 0 : 1)
