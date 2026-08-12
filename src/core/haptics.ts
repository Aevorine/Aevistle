/**
 * Short vibrations for the three moments you would otherwise have to look at
 * the screen to learn: a send went, a send failed, a code was copied.
 *
 * ## Why this exists at all
 *
 * The two things this app does that a person waits on — sending, and catching
 * a verification code — are both things they are usually doing *while* doing
 * something else. The code arrives while they are looking at the login form in
 * another app. The send fires while the phone is face-down on a desk. In both
 * cases the app already knows the outcome and already says so on a screen
 * nobody is looking at.
 *
 * ## Why `navigator.vibrate` and not a Capacitor plugin
 *
 * The Haptics plugin would be a new native dependency, a new permission entry,
 * and a new thing to keep in step across Capacitor upgrades, in exchange for
 * pattern support this file does not need. `navigator.vibrate` is in the
 * WebView already, needs no permission on Android, and takes exactly the
 * millisecond patterns below. On the Electron build it is absent or a no-op —
 * which is the correct behaviour there, not a gap to fill: a desktop has no
 * hand holding it.
 *
 * ## Why the patterns are shaped the way they are
 *
 * They have to be distinguishable through a pocket, which means the difference
 * has to be in the *rhythm*, not the length — two 20ms taps and one 40ms tap
 * carry the same energy and feel almost identical, but two-and-a-gap does not
 * feel like one-long.
 *
 *   ok      one short tap                  "done, nothing to do"
 *   fail    two taps with a gap            "stop, this needs you"
 *   copy    one very short tap             "taken" — quieter than `ok`,
 *                                          because copying happens a dozen
 *                                          times in a row and a full-weight
 *                                          buzz each time becomes noise
 *
 * ## Failure is silent, on purpose
 *
 * Every call site is a moment that has already succeeded or already failed at
 * the thing the user cares about. A vibration that throws must not turn a
 * successful send into an error, and there is nothing useful to report when a
 * device has no vibrator: this is the one place in this codebase where a
 * swallowed exception is the correct answer rather than a silent failure, and
 * that is why the swallow is here in one function instead of at eight call
 * sites where it would be indistinguishable from carelessness.
 */

export type HapticKind = 'ok' | 'fail' | 'copy'

/**
 * Milliseconds. Odd indices are silences — see `navigator.vibrate`.
 *
 * Always arrays, including the single-pulse ones. The spec allows a bare
 * number, but the DOM lib in this toolchain types the parameter as
 * `Iterable<number>`, which a number is not — so `ok: 18` type-checks nowhere
 * and `ok: [18]` type-checks everywhere. One shape is also easier to read as a
 * table than two.
 */
const PATTERNS: Record<HapticKind, number[]> = {
  ok: [18],
  fail: [16, 90, 16],
  copy: [10],
}

/**
 * Read at call time rather than captured, so turning the setting off in
 * Settings takes effect on the next buzz instead of the next launch. The
 * setting lives in `Settings.haptics` and this module has no access to the
 * store, so the caller passes it — see `haptic()`.
 */
export function haptic(kind: HapticKind, enabled: boolean | undefined): void {
  // `undefined` means "never set", and the default is on — see
  // `DEFAULT_SETTINGS.haptics` in core/types.ts. `=== false` rather than
  // `!enabled` so an unset value does not read as a refusal.
  if (enabled === false) return
  try {
    // Guarded rather than called directly: `vibrate` is absent in the Electron
    // renderer and in older WebViews, and TypeScript's DOM lib declares it as
    // always present, so the type system is no help here — only the runtime
    // check is.
    if (typeof navigator.vibrate !== 'function') return
    navigator.vibrate(PATTERNS[kind])
  } catch {
    // Deliberate. See the module doc: the caller's real work already happened.
  }
}
