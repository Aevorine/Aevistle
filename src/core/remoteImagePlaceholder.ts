/**
 * The blank-pixel placeholder convention shared between `electron/sanitizeHtml.ts`
 * (which writes it) and the renderer's message-detail view (which resolves it,
 * after the user explicitly asks to load images for one message). Kept
 * dependency-free and in `src/core` — unlike the sanitizer itself, which stays
 * main-process-only — because both sides need the exact same constant.
 */

/** A fully transparent 1x1 GIF — visually nothing, but a legitimate `<img>` so layout is not broken. */
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

/**
 * Splice previously-fetched remote images back into a sanitized body, once
 * the caller has decided (via account/sender policy or an explicit "load
 * images" click) that this message's remote content should load.
 *
 * `resolved[i]` may be `null` for a URL that failed to fetch — that entry is
 * simply left as the blank placeholder rather than treated as an error.
 */
export function resolveRemoteImages(html: string, resolved: Array<string | null>): string {
  let out = html
  resolved.forEach((dataUri, index) => {
    if (!dataUri) return
    out = out.split(`${BLANK_PIXEL}#${index}`).join(dataUri)
  })
  return out
}
