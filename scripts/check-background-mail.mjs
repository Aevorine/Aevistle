/**
 * "Keep receiving after I quit" must not become "pop to the front forever" —
 * `npm run check:background-mail`.
 *
 * The feature is one scheduled task that runs `Aevistle.exe --hidden` every
 * fifteen minutes. When the app is already running, the single-instance lock
 * ends the new copy immediately and `app.on('second-instance')` gets its
 * command line. That handler's whole job used to be `revealWindow()` — which,
 * with this task registered, means the window jumping to the foreground four
 * times an hour, forever, on a machine whose owner had deliberately closed it.
 * That is a worse bug than the missed notification the option exists to fix,
 * and it is one nobody would connect back to a switch in the settings screen.
 *
 * Three properties are checked, and each one is a way the feature turns
 * hostile rather than merely broken:
 *
 *   1. A `--hidden` relaunch must not raise the window; a plain one still must,
 *      because that is a person double-clicking the icon.
 *   2. The task must never be registered from a development build, where
 *      `process.execPath` is `node_modules/electron/dist/electron.exe` and the
 *      task would launch Electron's placeholder window every fifteen minutes,
 *      long after the checkout is gone. `setLoginItemSettings` already learned
 *      this the hard way — see the comment on `clearDevLoginItem` in `main.ts`.
 *   3. Turning the switch off must remove the task, including when no task is
 *      there, so "off" converges on "nothing registered" rather than erroring.
 *
 * `--selftest` removes the `--hidden` guard and requires this to go red.
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

let main = await readFile('electron/main.ts', 'utf8')
const task = await readFile('electron/backgroundMailTask.ts', 'utf8')

if (selftest) {
  main = main.replace("if (!argv.includes('--hidden')) revealWindow()", 'revealWindow()')
}

// --- 1. the relaunch must not steal the screen ------------------------------

const secondInstance = /app\.on\('second-instance',[\s\S]*?\n\}\)/.exec(main)?.[0] ?? ''

check('main.ts still has a second-instance handler', secondInstance.length > 0)
check(
  'a --hidden relaunch does not raise the window',
  /if\s*\(\s*!\s*argv\.includes\('--hidden'\)\s*\)\s*revealWindow\(\)/.test(secondInstance),
  secondInstance.includes('revealWindow') ? '' : 'revealWindow is not called at all',
)
check(
  'a relaunch without the flag still raises the window',
  secondInstance.includes('revealWindow()'),
)
check(
  'the task is what passes the flag',
  /--hidden/.test(task),
)

// --- 2. never from a development build --------------------------------------

check(
  'registration is refused unless the build is packaged',
  /if\s*\(\s*!app\.isPackaged\s*\)\s*\{[\s\S]{0,300}?return false/.test(task),
)
check(
  'the packaged check is not reachable only after schtasks has already run',
  task.indexOf('!app.isPackaged') < task.indexOf("'/Create'"),
  'the isPackaged guard must sit above the create call',
)

// --- 3. off means gone ------------------------------------------------------

check(
  'turning it off deletes the task',
  /if\s*\(\s*!enabled\s*\)\s*\{[\s\S]{0,400}?'\/Delete'/.test(task),
)
check(
  'deleting an absent task is not an error',
  /'\/Delete'[\s\S]{0,120}?'\/F'/.test(task),
)
check(
  'creating over an existing task replaces it rather than failing',
  /'\/Create'[\s\S]{0,400}?'\/F'/.test(task),
)

// --- what it must not be ----------------------------------------------------

check(
  'the task runs with the user privileges, not elevated',
  /'\/RL',\s*\n?\s*'LIMITED'/.test(task),
  /HIGHEST/.test(task) ? 'found /RL HIGHEST' : '',
)
check(
  'nothing here asks to run as SYSTEM',
  !/\/RU['"]?\s*,?\s*['"]?(SYSTEM|NT AUTHORITY)/i.test(task),
)
check(
  'the removal command is exposed to the user rather than hidden',
  /REMOVE_HINT/.test(task) && /schtasks \/Delete/.test(task),
)

// --- the user-facing copy has to exist in every language --------------------

for (const locale of ['ar', 'en', 'es', 'fr', 'ru', 'zh-CN']) {
  const src = await readFile(`src/i18n/${locale}.ts`, 'utf8')
  check(
    `${locale} explains what the switch creates`,
    src.includes("'settings.keepReceivingWhenClosedHint'") && src.includes('{command}'),
  )
}

console.log('')

const label = 'keeping receiving after a quit stays polite'

if (selftest) {
  console.log(`  ${label}\n  ${checks.length} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: an unguarded revealWindow was not caught.\n')
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
