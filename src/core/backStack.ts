/**
 * What the Android back gesture means, decided in one place.
 *
 * ## The bug this exists because of
 *
 * Swiping in from either edge of the screen closed the whole application.
 *
 * Nothing in this project had ever claimed the back gesture. Capacitor 8's
 * `BridgeActivity` registers no `OnBackPressedCallback` of its own (grep it —
 * there is no `onBackPressed` anywhere in `@capacitor/android`), and this app
 * deliberately does not depend on `@capacitor/app`, which is where the
 * `backButton` event other Capacitor apps listen to comes from. So the gesture
 * fell through to the platform default for a root activity, which is to finish
 * it. Every screen, every dialog, every half-written message: one stray thumb
 * on the edge of the screen and the app was gone.
 *
 * That is not a phone-only complaint about a phone-only feature, either. It is
 * the single most-used navigation control on Android, and this app answered it
 * with the most destructive action it has.
 *
 * ## The model
 *
 * A stack of handlers, consulted newest-first. Each one answers "was that mine?"
 *
 *   - a dialog registers while it is open, and answers yes by closing itself;
 *   - the shell registers once, at the bottom, and answers yes by returning to
 *     Home from any other screen;
 *   - on Home with nothing open, every handler declines, and *that* is when the
 *     native side is allowed to close the application.
 *
 * The stack rather than a single global handler because the correct answer
 * genuinely depends on what is on top: with the message reader open over the
 * inbox, back has to shut the reader and leave the inbox exactly where it was.
 * A shell-level `if (dialogOpen)` would need the shell to know about every
 * dialog in the app, which is the coupling `Modal` exists to avoid.
 *
 * ## Why the handlers are consulted rather than commanded
 *
 * `runBack()` returns a boolean and the native side reads it. The alternative —
 * the page closing something and the native side assuming it worked — is the
 * silent no-op this codebase keeps finding: a handler that threw, or a dialog
 * that was already closing, would leave the gesture doing nothing at all with
 * no way to tell. Declining is an answer; the native side then exits, which is
 * the honest fallback.
 *
 * Deliberately not React state, and deliberately not a context. It is read from
 * a `WebView.evaluateJavascript` call that arrives outside React's world
 * entirely — the same seam `window.__aevistleKeyboardInset` already uses in
 * `MainActivity` — so it has to be reachable without a component tree.
 */

/** Answers "was that back press mine?" — `true` if it consumed it. */
export type BackHandler = () => boolean

/**
 * Newest last. `runBack` walks it from the end, so the most recently opened
 * surface is asked first — which is what "close the thing on top" means.
 */
const handlers: BackHandler[] = []

/**
 * Register a handler for as long as a surface is open.
 *
 * Returns its own removal, so a `useEffect` can hand it straight back as the
 * cleanup. Removal is by identity and tolerates being called twice — React's
 * StrictMode mounts every effect, tears it down and mounts it again, and a
 * cleanup that removed the wrong entry the second time would leave a dialog
 * that back could no longer close.
 */
export function pushBackHandler(handler: BackHandler): () => void {
  handlers.push(handler)
  return () => {
    const at = handlers.lastIndexOf(handler)
    if (at !== -1) handlers.splice(at, 1)
  }
}

/**
 * Offer a back press to the stack. `true` if something consumed it.
 *
 * A handler that throws is treated as having declined rather than being allowed
 * to take the whole gesture down with it: the next handler still gets its turn,
 * and if every one of them fails the app exits, which is what the gesture would
 * have done before this file existed. Logged rather than swallowed, so a
 * handler that is failing every time is visible in logcat instead of presenting
 * as "back sometimes exits the app".
 */
export function runBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    try {
      if (handlers[i]()) return true
    } catch (error) {
      console.error('[aevistle] a back handler threw; treating it as declined', error)
    }
  }
  return false
}

/** The name `MainActivity.askPageToGoBack` evaluates. Exported so the Android check script can assert both sides spell it the same. */
export const BACK_BRIDGE_NAME = '__aevistleBack'

declare global {
  interface Window {
    [BACK_BRIDGE_NAME]?: () => boolean
  }
}

/**
 * Publish `runBack` where the native side can reach it.
 *
 * Called once from `main.tsx`, before React mounts. Early on purpose: the
 * gesture is available from the first frame, and a back press during startup
 * that found no bridge would close the app — the exact failure this is here to
 * end. With nothing registered yet `runBack` returns `false` and the app exits,
 * which is both correct (there is nothing to go back to) and identical to the
 * old behaviour, so the window before React mounts is not made worse.
 */
export function installBackBridge(): void {
  window[BACK_BRIDGE_NAME] = runBack
}

/** Test seam: drop every handler. Not used by the app. */
export function resetBackHandlers(): void {
  handlers.length = 0
}
