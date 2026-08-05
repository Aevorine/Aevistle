/**
 * Handing a generated file to the user, and finding out whether that worked.
 *
 * The `<a download>` dance is the same everywhere, but what it *means* is not.
 * In the browser preview the browser's own download UI is the feedback, so a
 * click is as much as the page can know. In the packaged desktop build the
 * main process owns the save dialog and is the only party that can say whether
 * a file exists on disk under a name the user will recognise.
 *
 * Before this existed, both callers toasted "exported" the instant the click
 * handler ran. That claim was wrong in two measured ways: the file landed as
 * `<random-guid>.tmp` with the suggested name discarded, and cancelling the
 * save dialog still produced a success toast. `electron/main.ts`'s
 * `will-download` handler fixes the first; this module makes the second
 * honest by waiting to be told.
 */
import { detectPlatform, getBridge } from './bridge'
import type { DownloadOutcome } from './ipc-contract'

/**
 * How long to wait for the shell to report back before giving up on the
 * report — not on the download.
 *
 * The save dialog is modal and a person may sit on it. Ten minutes is far
 * past any real hesitation while still bounding the listener's lifetime, and
 * timing out only costs the specific toast, never the file.
 */
const OUTCOME_TIMEOUT_MS = 10 * 60 * 1000

export interface SaveResult {
  /** `null` when the platform cannot tell us — treat as "probably fine". */
  outcome: DownloadOutcome | null
  /**
   * Set when the platform has no way to save this at all, so the caller can
   * say why instead of showing a success it cannot vouch for.
   */
  unsupported?: 'android'
}

/**
 * Trigger a download of `content` and, where the platform can say, resolve
 * with what actually happened.
 *
 * The listener is attached *before* the click. Attaching it afterwards is a
 * race the fast path loses: a save dialog dismissed immediately can complete
 * before a later-registered handler exists.
 */
export async function saveGeneratedFile(
  content: string,
  fileName: string,
  mime = 'application/json',
): Promise<SaveResult> {
  // Resolved before anything is triggered: the listener has to exist before
  // the click, and awaiting the bridge afterwards would reopen that race.
  const platform = await getBridge()
  const listen = platform.onDownloadDone?.bind(platform)

  /*
   * Android takes a different route entirely.
   *
   * The `<a download>` below is a no-op in a Capacitor WebView: without a
   * `DownloadListener` nothing is offered, and even with one, Android's
   * DownloadManager cannot fetch a `blob:` URL. So the button ran, nothing
   * happened, and the card said "exported" — the exact silent failure this app
   * exists not to do. That was met with an honest refusal, which was the right
   * call while nothing better existed and the wrong thing to leave in place: it
   * meant a phone could *import* a backup, a transfer file, a pairing file and
   * a working calendar, and export none of the four.
   *
   * The native SAF round trip is what was missing, and
   * `saveTextFile` is it — the same `ACTION_CREATE_DOCUMENT` dialog
   * `saveAttachmentAs` already used, with the bytes coming from here instead of
   * from disk. It reports `cancelled` the way the desktop's save dialog does, so
   * every caller's existing three-way toast (saved / cancelled / failed) is
   * already correct with no Android branch.
   *
   * `unsupported` is still returned when the method is missing, which is a build
   * running against an older native side. Refusing there is better than a
   * success nobody wrote a file for.
   */
  if (detectPlatform() === 'android') {
    const save = platform.saveTextFile?.bind(platform)
    if (!save) return { outcome: null, unsupported: 'android' }
    try {
      return { outcome: await save(fileName, mime, content) }
    } catch (error) {
      return {
        outcome: {
          ok: false,
          cancelled: false,
          name: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  return new Promise<SaveResult>((resolve) => {
    let done = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: DownloadOutcome | null) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
      resolve({ outcome })
    }

    if (listen) {
      unsubscribe = listen((outcome: DownloadOutcome) => finish(outcome))
      timer = setTimeout(() => finish(null), OUTCOME_TIMEOUT_MS)
    }

    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    // Appended rather than clicked detached: a detached anchor works in
    // Chromium today, but the download attribute is only specified for an
    // element in a document, and this is not the place to rely on that.
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()

    // Revoking immediately can cancel the download in some builds; a tick is
    // enough for the browser to have taken the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000)

    // Nothing will ever report back on this platform, so say so now rather
    // than leaving the caller waiting on a promise that cannot settle.
    if (!listen) finish(null)
  })
}
