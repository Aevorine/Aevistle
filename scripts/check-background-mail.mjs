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

// --- 4. registered is not the same as working -------------------------------
//
// The defect this section exists for shipped in 0.3.24 and 0.3.25 and was
// invisible from inside the app: `schtasks /Create /SC MINUTE` cannot set task
// *settings*, so the task inherited Task Scheduler's defaults — among them
// "do not start on battery" and "stop when the machine goes on battery". On a
// laptop that is the entire feature off, while `backgroundMailCheckRegistered`
// answered true, the switch read on, and the task showed as Ready. Measured
// with `Export-ScheduledTask` on a machine where it had been "working" for
// days. Every check below is one way back to that state.

check(
  'the task is registered from XML, which is the only form that can set settings',
  /'\/XML'/.test(task),
  /\/SC['"]?,\s*\n?\s*['"]MINUTE/.test(task) && !/'\/XML'/.test(task)
    ? 'only the switch form is present, so settings fall back to the defaults'
    : '',
)

for (const [tag, value, why] of [
  ['DisallowStartIfOnBatteries', 'false', 'the task would never start on an unplugged laptop'],
  ['StopIfGoingOnBatteries', 'false', 'unplugging would terminate the running app'],
  ['StartWhenAvailable', 'true', 'a trigger missed while asleep would never be made up'],
  ['ExecutionTimeLimit', 'PT0S', 'the resident app would be killed after 72 hours'],
]) {
  // The XML emits this table, so the table is where the value lives — asserting
  // on the rendered tag would only prove the template string exists.
  check(
    `the task asks for ${tag} = ${value}`,
    new RegExp(`tag:\\s*'${tag}',\\s*\\n\\s*value:\\s*'${value}',`).test(task),
    why,
  )
}
check(
  'the settings table is what the XML is built from',
  /REQUIRED_TASK_SETTINGS\.map\([\s\S]{0,200}?<\$\{s\.tag\}>\$\{s\.value\}<\/\$\{s\.tag\}>/.test(task) &&
    /<Settings>\s*\n\$\{settings\}/.test(task),
  'a table nothing renders would pass every check above and set nothing',
)
check(
  'the same table is what the registered task is checked against',
  /REQUIRED_TASK_SETTINGS\.filter/.test(task),
  'it must drive both the write and the read-back, or the two can drift apart',
)

check(
  'the registered task is read back rather than trusted',
  /backgroundMailCheckProblems/.test(task) && /'\/Query'[\s\S]{0,200}?'\/XML'/.test(task),
  'an exit code of 0 means the XML parsed, not that the settings took',
)
check(
  'what is wrong with the task reaches the settings screen',
  /backgroundMailCheckProblems/.test(main) && /problems:/.test(main),
)
check(
  'a task written by an older build is rewritten without the user touching the switch',
  /backgroundMailApplied/.test(main) &&
    /backgroundChanged\s*\|\|\s*!backgroundMailApplied/.test(main),
  'applying only on change leaves every existing broken task in place forever',
)
check(
  'the XML file is written as UTF-16, which is the only encoding schtasks accepts',
  /utf16le/.test(task),
)
check(
  'the document asks for nothing that needs elevation',
  // The template's only trigger, checked by what follows it rather than by the
  // absence of the word — this file's own comments name `<LogonTrigger>` to
  // explain why it is not there, and a check that cannot tell an explanation
  // from an implementation is a check that goes red for being documented.
  /<\/TimeTrigger>\s*\n\s*<\/Triggers>/.test(task) &&
    !/RunLevel>HighestAvailable/.test(task),
  // Measured: the same document registers as an ordinary user without a logon
  // trigger and is refused with "Access is denied" with one. Refused means the
  // fallback path, and the fallback path is the battery-defaults bug.
  'an element that needs admin sends every ordinary account down the fallback',
)
check(
  'the answer schtasks gives is decoded by what it actually sent',
  /0xff/.test(task) && /'utf16le'\s*:\s*'utf8'/.test(task),
  // `/Query /XML` answers in UTF-8 with no BOM; `/Query` alone answers in
  // UTF-16. Assuming either one decodes the other into mojibake, in which no
  // tag name matches — and every setting would then read as "absent", i.e.
  // wrong, i.e. the settings screen calls a healthy task broken.
  'both encodings have to be handled, or the read-back reports nonsense',
)
check(
  'the XML command element carries a bare path, not a quoted one',
  /<Command>\$\{esc\(execPath\)\}<\/Command>/.test(task),
  'quotes inside <Command> become part of the path and the task fails at run time',
)

// --- 5. the phone half: a swipe must not end background mail ----------------

const idleService = await readFile(
  'android/app/src/main/java/dev/aevistle/app/InboxIdleService.java',
  'utf8',
)
check(
  'swiping the app away arranges for the sync loop to come back',
  /public void onTaskRemoved/.test(idleService),
  'without it an OEM task-killer ends background mail until the app is next opened',
)
check(
  'the restart is scheduled through an alarm rather than assumed from START_STICKY',
  /getForegroundService/.test(idleService) && /AlarmManager/.test(idleService),
)
check(
  'the worker is re-armed too, for the devices that refuse the alarm',
  /onTaskRemoved[\s\S]{0,900}?InboxSyncScheduler\.rearm/.test(idleService),
)
check(
  'nothing in the task-removal path can throw at the user as they close the app',
  /onTaskRemoved[\s\S]{0,400}?try\s*\{/.test(idleService) &&
    /catch\s*\(\s*SecurityException/.test(idleService),
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
