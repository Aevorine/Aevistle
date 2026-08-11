/**
 * How much of the page the soft keyboard is covering, as a CSS custom property.
 *
 * ## Why this exists at all
 *
 * The Android side used to answer this question by shrinking the window: fold
 * the IME inset into the content view's bottom padding, and every height in the
 * app — all of which cascade from `100dvh` on `html, body, #root` — follows for
 * free. It is the smallest possible change and it is why it was done twice.
 *
 * It also lifts the phone's five-tab bar off the bottom of the screen, because
 * that bar is laid out inside `.shell`, and `.shell` is a percentage of the
 * window. And when Android skips the final insets pass on keyboard close — some
 * OEM keyboards do — nothing ever lowers the padding again, so the bar stays
 * lifted with a keyboard-sized band of blank app-coloured background beneath it
 * for the rest of the session. That symptom was reported four times.
 *
 * So the window is now left at full height (see `MainActivity.applyInsets`) and
 * the keyboard becomes a *number* the page reasons about instead of a fact the
 * layout is helpless against.
 *
 * ## Why three sources and not one
 *
 * Each of the three can be wrong on its own, and they are wrong in different
 * situations, which is the only reason combining them is worth anything:
 *
 *   1. **The native push** (`window.__aevistleKeyboardInset`) is the only one
 *      that is accurate to the pixel, and the only one available at all when
 *      the WebView is not resized for the IME. It is also the one that can get
 *      stuck, which is the entire history above.
 *   2. **`visualViewport`** needs no bridge, so it covers the desktop build,
 *      the browser preview, and any Android build where the push fails. It
 *      reports nothing when the window is not resized for the keyboard, which
 *      on this app's Android target is most of the time.
 *   3. **Focus** is the one that cannot be stale. A soft keyboard cannot be up
 *      while nothing accepting text is focused. It says nothing about *height*,
 *      but it is a hard veto on any height the other two report — which is
 *      exactly what the failure mode needed and never had.
 *
 * Height comes from `max(1, 2)`; (3) gates whether that height counts. A stuck
 * native value therefore survives only as long as the user keeps a text field
 * focused, and is gone the moment they tap anything else.
 *
 * ## What reads it
 *
 * `--kb` (CSS pixels, `0px` when closed) and `data-kb="open"` on the root
 * element. `theme.css` declares `--kb: 0px` in the base `:root` so the token is
 * defined for `check-css-tokens.mjs` and so every platform that never calls in
 * here — Windows, the web preview — resolves it to zero without a fallback.
 */

/** Input types that never bring up a text keyboard. */
const NON_TEXT_INPUT = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/**
 * Below this many pixels, a `visualViewport` shortfall is browser chrome —
 * a collapsing URL bar, a find-in-page strip — and not a keyboard. Deliberately
 * generous: over-reporting here would shrink the compose box for a toolbar.
 */
const KEYBOARD_FLOOR_PX = 96

/** What the native side last told us. Never trusted without {@link isTextEntryFocused}. */
let nativeInset = 0

/** What is currently written to the root, so an unchanged value costs no style recalc. */
let applied = -1

function isTextEntryFocused(): boolean {
  const el = document.activeElement
  if (!el || el === document.body) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUT.has((el as HTMLInputElement).type)
  // `contenteditable` — the message reader's iframe is sandboxed and cannot
  // focus anything in this document, so this only ever means a real editor.
  return (el as HTMLElement).isContentEditable === true
}

function fromVisualViewport(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  // `offsetTop` matters on a pinch-zoomed page, where the visual viewport has
  // been scrolled inside the layout viewport and the shortfall is not all at
  // the bottom.
  const covered = window.innerHeight - vv.height - vv.offsetTop
  return covered >= KEYBOARD_FLOOR_PX ? Math.round(covered) : 0
}

function apply(): void {
  const height = isTextEntryFocused() ? Math.max(nativeInset, fromVisualViewport()) : 0
  if (height === applied) return
  applied = height
  const root = document.documentElement
  root.style.setProperty('--kb', `${height}px`)
  if (height > 0) root.setAttribute('data-kb', 'open')
  else root.removeAttribute('data-kb')
}

/**
 * Start listening. Idempotent by construction — `main.tsx` calls it once,
 * before the first render, so no screen ever paints against a stale `--kb`.
 */
export function installKeyboardInset(): void {
  window.__aevistleKeyboardInset = (px: number) => {
    // Guarded because this crosses a bridge from Java: a malformed value here
    // would otherwise become `calc(... - NaNpx)` and collapse a whole screen.
    nativeInset = Number.isFinite(px) && px > 0 ? Math.round(px) : 0
    apply()
  }

  // `focusin`/`focusout` rather than `focus`/`blur`: those do not bubble, and
  // the fields in question are scattered across every screen in the app.
  document.addEventListener('focusin', apply)
  // On the next frame, not immediately: moving focus between two text fields
  // fires `focusout` before `focusin`, and reacting to the gap would flash the
  // tab bar back in for one frame between two taps in the same form.
  document.addEventListener('focusout', () => requestAnimationFrame(apply))

  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
  }
  // The backstop for a rotation or a split-screen resize, where the keyboard
  // height changes without either of the above necessarily firing.
  window.addEventListener('resize', apply)
  // Coming back from another app: `MainActivity.onResume` re-reads the real
  // insets and republishes, but this covers the reverse order and the case
  // where the app was backgrounded with a field still focused.
  document.addEventListener('visibilitychange', apply)

  apply()
}

declare global {
  interface Window {
    /** Called from `MainActivity.publishKeyboardInset`, in CSS pixels. */
    __aevistleKeyboardInset?: (px: number) => void
  }
}
