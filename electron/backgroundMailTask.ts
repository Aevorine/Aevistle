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

function run(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

/** True when a task by this name currently exists. */
export async function backgroundMailCheckRegistered(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const { ok } = await run(['/Query', '/TN', TASK_NAME])
  return ok
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
   * `/RL LIMITED` — the user's own privileges, nothing more. `/F` replaces an
   * existing task rather than failing, which is what makes this idempotent for
   * a renderer that pushes prefs on every settings edit.
   *
   * The quoting matters and is easy to get wrong: `/TR` takes one string that
   * Windows parses as a command line, so the executable path — which contains
   * spaces on a default install — has to carry its own quotes *inside* that
   * string. `execFile` passes our array through without a shell, so these are
   * the only quotes involved and there is no second round of shell parsing to
   * escape for.
   */
  const command = `"${process.execPath}" --hidden`
  const { ok, output } = await run([
    '/Create',
    '/TN',
    TASK_NAME,
    '/TR',
    command,
    '/SC',
    'MINUTE',
    '/MO',
    String(INTERVAL_MINUTES),
    '/RL',
    'LIMITED',
    '/F',
  ])
  if (!ok) console.error('[aevistle] could not register the background mail check:', output)
  return ok
}
