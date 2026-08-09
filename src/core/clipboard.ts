/**
 * One way to put text on the clipboard, on every platform this app runs on.
 *
 * `navigator.clipboard.writeText` is the modern answer and it is the wrong one
 * on exactly the platform where copying matters most. Inside an Android
 * WebView, Chromium routes the async clipboard write through its permission
 * layer, and WebView's permission delegate has no path for
 * `clipboard-write` — `WebChromeClient.onPermissionRequest` only ever handles
 * audio, video, MIDI and protected media. So the promise rejects with
 * `NotAllowedError`, from a real tap, in a genuine secure context
 * (`https://localhost`, per `capacitor.config.ts`), with nothing wrong on the
 * page at all. That rejection is the entirety of the "复制失败 / copy failed"
 * report on the verification-code screen: the code was found, the card was
 * right, the value was correct, and the one action the screen exists for
 * answered with an error toast.
 *
 * So the write is tried three ways, cheapest-and-most-reliable first:
 *
 *   1. the native bridge (`bridge.copyText`), which on Android is
 *      `ClipboardManager.setPrimaryClip` — the API the platform actually
 *      intends for this, with no permission layer in front of it;
 *   2. `navigator.clipboard.writeText`, which is what desktop and the browser
 *      preview use and what a future WebView may well start honouring;
 *   3. a hidden `<textarea>` plus `document.execCommand('copy')`, the
 *      deprecated-but-universal path, kept as the last line so that a build
 *      running somewhere neither of the first two reaches still copies.
 *
 * Returning a boolean rather than throwing is deliberate: every caller's
 * response to a failure is the same toast, and half of them were previously
 * swallowing the rejection in a bare `catch` where a genuine platform gap
 * looked identical to "the user pressed cancel".
 */

import { getBridgeSync } from './bridge'

/**
 * The last-resort path.
 *
 * `execCommand` is only honoured from inside a user gesture, which is where
 * every caller here runs from (a click or a tap). The textarea is positioned
 * off-screen rather than hidden with `display: none`, because a node that is
 * not laid out cannot be selected and the copy silently produces nothing —
 * the exact failure mode this whole module exists to remove.
 */
function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.focus()
    area.select()
    // iOS/WebKit ignores `select()` on a readonly field; the range call is
    // what actually marks the text on those engines.
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(area)
  }
}

/**
 * Put `text` on the system clipboard. Answers whether it landed.
 *
 * Never throws — a caller that wants to report a failure checks the return
 * value, and a caller that does not can ignore it without leaving an
 * unhandled rejection behind.
 */
export async function copyText(text: string): Promise<boolean> {
  const bridge = getBridgeSync()
  if (bridge?.copyText) {
    try {
      await bridge.copyText(text)
      return true
    } catch {
      // A native failure is worth falling through for rather than reporting:
      // the two web paths below are still there, and on a desktop build the
      // bridge does not implement this at all.
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // The Android WebView case described at the top of this file. Not an
    // error worth surfacing while a working fallback remains.
  }

  return copyViaExecCommand(text)
}
