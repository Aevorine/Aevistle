/**
 * "Keep receiving even after I quit", on Windows.
 *
 * ## Why anything is needed at all
 *
 * Every desktop notification this app raises comes out of the *renderer*:
 * `AppState.tsx` decides an arrival is worth announcing and calls
 * `bridge.notify`, which reaches `showNotification` over IPC. The main process
 * holds the IMAP IDLE connection, but all it does on new mail is forward the
 * event to the window. No window, no notification — measured, not assumed:
 * with the window minimised and again with it hidden to the tray, a real
 * arrival produced a toast; there is no path that produces one with the
 * process gone.
 *
 * So "the app is closed and I still get told" cannot be solved inside a
 * process that is not running. Something outside it has to start one.
 *
 * ## Why a scheduled task rather than a service or a second process
 *
 * A Windows service needs an installer running as administrator and a separate
 * binary; a resident helper process is a second copy of the mail stack to keep
 * in step with the first, and a second thing to go wrong silently. A scheduled
 * task launching the app the app already knows how to launch — hidden, into
 * the tray, where it resumes the sync loop that already works — adds no new
 * mail code at all. If the app is already running, the single-instance lock
 * ends the new copy in milliseconds and `second-instance` ignores it because
 * of the `--hidden` guard in `main.ts`. The cost of a redundant run is a
 * process that starts and exits.
 *
 * ## Why the task is registered from XML rather than from `schtasks` switches
 *
 * This is the part that was wrong until 0.3.26, and it was wrong in the one
 * direction nothing reports: the task existed, Task Scheduler listed it, the
 * settings switch said "on", and on a laptop it did nothing.
 *
 * `schtasks /Create /SC MINUTE …` cannot express task *settings*, so every
 * task built that way silently inherits the Task Scheduler defaults. Measured
 * with `Export-ScheduledTask` on the machine where this feature had been
 * "working" for two releases, the task this file used to create carried:
 *
 *   - `DisallowStartIfOnBatteries: true` — on a laptop that is not plugged in,
 *     the background mail check **never launches at all**. This is the whole
 *     feature, off, on the machine class most likely to be closed and carried
 *     around. Nothing in the app could see it: `backgroundMailCheckRegistered`
 *     answered `true` the entire time, because the task was genuinely there.
 *   - `StopIfGoingOnBatteries: true` — worse than not starting. Unplugging the
 *     charger makes Task Scheduler *terminate the running Aevistle.exe* that
 *     this task started, so the app vanishes mid-session for a reason no user
 *     could trace back to a mail setting.
 *   - `ExecutionTimeLimit: PT72H` — the launched app is meant to stay resident
 *     and keep its IDLE connections; Task Scheduler counts that as a task that
 *     has been running for three days and kills it.
 *   - `StartWhenAvailable: false` — a trigger missed because the machine was
 *     asleep is never made up.
 *
 * The registration XML below sets all four the other way. It is the only form
 * `schtasks` accepts that can, and `backgroundMailCheckProblems` reads the
 * registered task back to prove the values actually took rather than trusting
 * the exit code — an exit code of 0 here means "the XML parsed", not "the
 * feature works", and that distinction is exactly what hid this.
 *
 * ## What this deliberately does not do
 *
 * It does not run as SYSTEM, does not survive the user account, does not ask
 * for elevation, and does not hide what it created: `schtasks` writes a plain
 * task in the user's own folder, visible in Task Scheduler under the name
 * below, removable with the command in `REMOVE_HINT` or by turning the switch
 * back off. An app that quietly relaunches itself is a thing users are right
 * to resent, so this is opt-in, off by default, and named in the settings
 * screen for exactly what it is.
 *
 * Windows only. macOS has launchd agents and Linux has systemd user units,
 * both of which are real answers and neither of which has a build shipping
 * today; `applyBackgroundMailCheck` is a no-op there rather than a lie.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

/** What the task is called in Task Scheduler. Stable — it is also the key used to replace or delete it. */
export const TASK_NAME = 'Aevistle background mail check'

/**
 * How often the task fires.
 *
 * Fifteen minutes, matching Android's WorkManager floor so both platforms make
 * the same promise. Shorter would mean launching a process every few minutes
 * for a mailbox that mostly has nothing new; longer starts to feel like the
 * mail is not arriving. Only ever paid when the app is *not* already running —
 * otherwise the launch dies on the single-instance lock.
 */
const INTERVAL_MINUTES = 15

/** Shown to the user so the thing this created is never a mystery. */
export const REMOVE_HINT = `schtasks /Delete /TN "${TASK_NAME}" /F`

/**
 * The settings whose value decides whether this feature works at all.
 *
 * Kept as data rather than as four comparisons inline because three things read
 * this list: `taskXml` renders it into the registration document,
 * `backgroundMailCheckProblems` checks the registered task against it, and
 * `scripts/check-background-mail.mjs` asserts the values themselves. A setting
 * written into the XML but missing here would never be verified, and one
 * verified but never written would fail on every machine — one table makes
 * both impossible.
 */
export const REQUIRED_TASK_SETTINGS: ReadonlyArray<{ tag: string; value: string; why: string }> = [
  {
    tag: 'DisallowStartIfOnBatteries',
    value: 'false',
    why: 'on a laptop running on battery the task would never start',
  },
  {
    tag: 'StopIfGoingOnBatteries',
    value: 'false',
    why: 'unplugging the charger would terminate the running app',
  },
  {
    tag: 'StartWhenAvailable',
    value: 'true',
    why: 'a trigger missed while the machine slept would never be made up',
  },
  {
    tag: 'ExecutionTimeLimit',
    value: 'PT0S',
    why: 'the launched app stays resident and would be killed after 72 hours',
  },
]

function run(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'schtasks',
      args,
      // `buffer`, because `/XML` answers in UTF-16 and decoding that as UTF-8
      // yields a string full of NULs in which no tag name can be found — the
      // verification would fail on every machine, for the wrong reason.
      { windowsHide: true, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${decode(stdout)}${decode(stderr)}`.trim() })
      },
    )
  })
}

/** UTF-16LE when it looks like it, UTF-8 otherwise. `schtasks` uses both, by subcommand. */
function decode(buf: Buffer | string | undefined): string {
  if (!buf) return ''
  if (typeof buf === 'string') return buf
  const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
  return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '')
}

/** XML text, with the five characters that would otherwise end the element. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Local time in the form Task Scheduler wants for a boundary: no zone, no milliseconds. */
function localBoundary(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

/**
 * The registration document.
 *
 * `<Command>` carries the bare path with no quotes of its own — unlike `/TR`,
 * which takes one string Windows re-parses as a command line. Quoting it here
 * names a path that does not exist, and the task then fails at run time with
 * 0x2 rather than at registration: the failure that looks like the feature
 * simply not working.
 *
 * There is deliberately no `<LogonTrigger>`, and that is a measured decision
 * rather than an omission. A logon trigger would be genuinely useful — the
 * fifteen-minute repetition counts from whenever this was last written, so a
 * machine that boots into a locked session can wait a full interval before the
 * first check. But registering one requires elevation: with it present,
 * `schtasks /Create /XML` answers "Access is denied" for an ordinary user, and
 * `applyBackgroundMailCheck` would fall through to the switch-form fallback —
 * the version carrying the battery defaults this whole file exists to escape.
 * Measured, by registering the same document with and without the element on a
 * non-elevated account: without it, registered; with it, refused, every time.
 * A trigger that costs the feature is worth less than the feature.
 */
export function taskXml(execPath: string, now = new Date()): string {
  const settings = REQUIRED_TASK_SETTINGS.map((s) => `    <${s.tag}>${s.value}</${s.tag}>`).join(
    '\n',
  )
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Aevistle</Author>
    <Description>Starts Aevistle hidden every ${INTERVAL_MINUTES} minutes to check for new mail. Created by Aevistle's "keep receiving after I quit" setting; remove it there, or with: ${esc(REMOVE_HINT)}</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localBoundary(now)}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${INTERVAL_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
${settings}
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowHardTerminate>false</AllowHardTerminate>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <Priority>7</Priority>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(execPath)}</Command>
      <Arguments>--hidden</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/** True when a task by this name currently exists. */
export async function backgroundMailCheckRegistered(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const { ok } = await run(['/Query', '/TN', TASK_NAME])
  return ok
}

/**
 * Which of the load-bearing settings the *registered* task actually lacks.
 *
 * Read back from Task Scheduler rather than assumed from our own XML, because
 * the whole class of bug this file now guards against is a registration that
 * succeeded while meaning something else. An empty array means healthy; each
 * entry names one setting and why it matters, so the settings screen can say
 * more than "on".
 *
 * A task that does not exist reports nothing wrong — "not registered" is
 * `backgroundMailCheckRegistered`'s answer to give, and reporting both would
 * put two complaints on screen for one cause.
 */
export async function backgroundMailCheckProblems(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const { ok, output } = await run(['/Query', '/TN', TASK_NAME, '/XML', 'ONE'])
  if (!ok) return []
  return REQUIRED_TASK_SETTINGS.filter((s) => {
    const found = new RegExp(`<${s.tag}>([^<]*)</${s.tag}>`, 'i').exec(output)?.[1]?.trim()
    // Absent counts as wrong: every one of these has a Task Scheduler default,
    // and in each case the default is the value that breaks the feature.
    return (found ?? '').toLowerCase() !== s.value.toLowerCase()
  }).map((s) => `${s.tag}: ${s.why}`)
}

/**
 * Create or remove the task to match `enabled`.
 *
 * Returns what actually happened rather than throwing, because the caller is an
 * IPC handler answering a settings toggle: a failure here has to become
 * something the switch can show, not an unhandled rejection in a process the
 * user cannot see. Reporting `false` from a switch that says "on" is the one
 * outcome worth more than a clean-looking call site.
 *
 * `app.isPackaged` is checked for the same reason `setLoginItemSettings` checks
 * it: run from a checkout, `process.execPath` is
 * `node_modules/electron/dist/electron.exe` and the app directory is an
 * argument npm supplied, so a task built from it would launch Electron's
 * "path-to-app" placeholder every fifteen minutes on a machine where somebody
 * once ran the dev build. A development run has no business writing a scheduled
 * task into the user's account.
 */
export async function applyBackgroundMailCheck(enabled: boolean): Promise<boolean> {
  if (process.platform !== 'win32') return false

  if (!enabled) {
    // `/F` so removing an absent task is not an error: the switch going off
    // must converge on "no task" whether or not one was ever created.
    await run(['/Delete', '/TN', TASK_NAME, '/F'])
    return false
  }

  if (!app.isPackaged) {
    console.warn('[aevistle] background mail check not registered: this is a development build')
    return false
  }

  /*
   * UTF-16LE with a byte-order mark. `schtasks /XML` rejects a UTF-8 file with
   * "The task XML is malformed" — a message that points at the document rather
   * than at its encoding, and sends anyone debugging it back to reread
   * perfectly good XML.
   *
   * Written under the OS temp directory and removed in the `finally`: the file
   * exists for the length of one `schtasks` call and describes nothing secret,
   * but leaving files behind in the user's profile for a settings toggle is
   * still litter.
   */
  const file = path.join(app.getPath('temp'), `aevistle-task-${randomUUID()}.xml`)
  let created = false
  try {
    await writeFile(file, Buffer.from(`﻿${taskXml(process.execPath)}`, 'utf16le'))
    const { ok, output } = await run(['/Create', '/TN', TASK_NAME, '/XML', file, '/F'])
    created = ok
    if (!ok) console.error('[aevistle] could not register the background mail check:', output)
  } catch (error) {
    console.error('[aevistle] could not write the background mail check definition:', error)
  } finally {
    await unlink(file).catch(() => {})
  }

  if (created) {
    const problems = await backgroundMailCheckProblems()
    if (problems.length > 0) {
      // Registered, and not what we asked for. Group policy and some managed
      // machines override task settings; saying so beats a switch reading "on".
      console.error('[aevistle] the background mail check registered with wrong settings:', problems)
    }
    return true
  }

  /*
   * Fall back to the switch form rather than leaving the user with nothing.
   *
   * `/RL LIMITED` — the user's own privileges, nothing more. `/F` replaces an
   * existing task rather than failing, which is what makes this idempotent for
   * a renderer that pushes prefs on every settings edit. The quoting matters:
   * `/TR` takes one string that Windows parses as a command line, so the
   * executable path — which contains spaces on a default install — has to
   * carry its own quotes *inside* that string. `execFile` passes our array
   * through without a shell, so these are the only quotes involved.
   *
   * This is the version with the battery defaults — the bug the XML path
   * exists to fix — so it is strictly a degraded mode and says so in the log.
   * But "mail checked only while plugged in" beats "no background check at
   * all", and `backgroundMailCheckProblems` reports exactly what is wrong with
   * it to the settings screen instead of letting it read as healthy.
   */
  console.warn('[aevistle] falling back to the switch-form task; it will not run on battery')
  const { ok } = await run([
    '/Create',
    '/TN',
    TASK_NAME,
    '/TR',
    `"${process.execPath}" --hidden`,
    '/SC',
    'MINUTE',
    '/MO',
    String(INTERVAL_MINUTES),
    '/RL',
    'LIMITED',
    '/F',
  ])
  return ok
}
