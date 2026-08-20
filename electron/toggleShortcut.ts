/**
 * One key that brings the window here, and the same key that puts it away.
 *
 * ## Why this is separate from the tray
 *
 * The tray icon already toggles (`toggleWindowFromTray` in `main.ts`), and that
 * is the whole behaviour this wants — but the tray only answers a mouse that
 * has travelled to the notification area, found a 16px icon among a dozen, and
 * hit it. A window worth summoning is worth summoning without looking, and the
 * app is otherwise invisible to the keyboard while it is hidden: an accelerator
 * inside the window cannot fire when there is no window on screen to receive
 * it, which is exactly the state this exists to leave.
 *
 * So the toggle itself is not reimplemented here. `apply` is handed the same
 * function the tray click calls, and this module owns only the one thing the
 * tray does not have: a registration with the OS, and the honest reporting of
 * whether it took.
 *
 * ## Why the failure has to be visible
 *
 * `globalShortcut.register` returns `false` when another application already
 * holds the combination — and on a normal desktop that is common rather than
 * exotic. Nothing about the app changes when it happens: no error, no
 * exception, no log. The user presses the key, nothing happens, and the setting
 * still says the key is set. That is the same shape of lie as a scheduled task
 * that exists and cannot run (see `backgroundMailTask.ts`), found in the same
 * pass, so it gets the same treatment: the registered state is read back and
 * reported, and the settings screen says "this combination is taken" rather
 * than showing a value that does nothing.
 *
 * ## Why the accelerator is a setting rather than a constant
 *
 * Because whether a combination is free is a fact about *the user's machine*,
 * not about this app, and no default can be right everywhere. The default below
 * is chosen to be unlikely rather than to be certain, and the point of exposing
 * it is that someone whose default is taken has a way out that is not
 * "uninstall the other program".
 */

import { BrowserWindow, globalShortcut } from 'electron'

/**
 * The combination registered when the user has not chosen one.
 *
 * `Ctrl+Alt+A` rather than anything with Shift: `Ctrl+Shift+<letter>` is where
 * browsers, editors and chat apps put their own global hotkeys, and a default
 * that collides on most machines would make the feature look broken on first
 * use. Alt-based combinations are comparatively empty on Windows outside the
 * menu mnemonics, which are window-local and unaffected by a global grab.
 *
 * Electron's accelerator syntax, not the platform's: `Control` maps to Command
 * on macOS through `CommandOrControl`, which is what this uses, so the same
 * string is idiomatic on both.
 */
export const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Alt+A'

/** What `apply` last put in place, so `state` can answer without re-registering. */
let active: string | null = null
/** Why the last apply failed, when it did. Null while healthy or while off. */
let failure: 'taken' | 'invalid' | null = null

/**
 * Is this something Electron will accept at all?
 *
 * `register` throws on a malformed accelerator rather than returning `false`,
 * and the string comes from a text field in the settings screen — so a typo
 * would become an unhandled exception in the main process, which on Windows is
 * a modal error dialog over an app in which nothing is wrong. Checked here so
 * the same code path that reports "taken" can report "not a valid combination".
 *
 * Deliberately permissive: this rejects the shapes that throw, not the
 * combinations that are unwise. Electron owns the real grammar and this is not
 * a second copy of it.
 */
function looksLikeAccelerator(value: string): boolean {
  const parts = value.split('+').map((p) => p.trim())
  if (parts.length < 2) return false
  if (parts.some((p) => p.length === 0)) return false
  const modifiers = new Set([
    'Command',
    'Cmd',
    'Control',
    'Ctrl',
    'CommandOrControl',
    'CmdOrCtrl',
    'Alt',
    'Option',
    'AltGr',
    'Shift',
    'Super',
    'Meta',
  ])
  // At least one modifier, and the last part must not be one: a bare key would
  // swallow that key for every application on the machine, and a combination
  // that is only modifiers can never fire.
  return parts.slice(0, -1).every((p) => modifiers.has(p)) && !modifiers.has(parts[parts.length - 1])
}

/**
 * Register `accelerator`, or clear whatever is registered when it is null.
 *
 * Idempotent, because the renderer pushes desktop prefs on every settings edit:
 * re-applying the combination that is already active unregisters and registers
 * the same string, which is cheap and keeps this a pure function of the value
 * rather than of the sequence of calls that got here.
 *
 * `onToggle` is `main.ts`'s tray toggle. Passing it in rather than importing it
 * is what keeps this module free of the window, the tray and the prefs — it can
 * be reasoned about, and changed, without any of them.
 */
export function applyToggleShortcut(
  accelerator: string | null,
  onToggle: () => void,
): { registered: string | null; failure: 'taken' | 'invalid' | null } {
  if (active) {
    globalShortcut.unregister(active)
    active = null
  }
  failure = null

  if (!accelerator) return { registered: null, failure: null }

  if (!looksLikeAccelerator(accelerator)) {
    failure = 'invalid'
    return { registered: null, failure }
  }

  let ok = false
  try {
    ok = globalShortcut.register(accelerator, onToggle)
  } catch (error) {
    // Belt and braces behind `looksLikeAccelerator`: Electron's grammar is
    // larger than the check above and may reject something it lets through.
    console.error('[aevistle] the toggle shortcut was refused:', error)
    ok = false
  }

  if (!ok) {
    failure = 'taken'
    return { registered: null, failure }
  }

  active = accelerator
  return { registered: active, failure: null }
}

/**
 * What is actually registered right now.
 *
 * `globalShortcut.isRegistered` is asked rather than trusting `active`, for the
 * same reason the scheduled task is read back: the value this module *wanted*
 * is not evidence of what the OS *has*. They can diverge — another application
 * registering the same combination later does not notify us — and the settings
 * screen showing the wanted value would be the lie this file exists to avoid.
 */
export function toggleShortcutState(): {
  registered: string | null
  failure: 'taken' | 'invalid' | null
} {
  if (active && !globalShortcut.isRegistered(active)) {
    return { registered: null, failure: 'taken' }
  }
  return { registered: active, failure }
}

/**
 * Drop the registration.
 *
 * Called on `will-quit`. Electron does unregister everything itself when the
 * process ends, so this is not load-bearing for a clean exit — it exists for
 * the case that is not clean: a relaunch (the updater's, or the scheduled
 * task's racing a quit) can briefly have two processes, and the second one's
 * `register` would return `false` against the first one's dying grab. The user
 * would see a shortcut that stopped working after an update, once, until the
 * next restart.
 */
export function releaseToggleShortcut(): void {
  if (active) globalShortcut.unregister(active)
  active = null
  failure = null
}

/**
 * A window is a prerequisite the caller can forget about.
 *
 * The toggle is meaningful with no window at all — that is the state it is for
 * — so `main.ts`'s handler creates one. This helper only exists to keep that
 * decision next to the shortcut rather than hidden in a callback: an
 * accelerator that quietly did nothing when the last window had been closed
 * would be indistinguishable from one that failed to register.
 */
export function hasWindow(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())
}
