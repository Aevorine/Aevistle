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
 * What a picture that could not be fetched looks like.
 *
 * An image the proxy refused or failed on used to keep the transparent pixel,
 * which is indistinguishable from an image that loaded and happens to be
 * white — the failure was silent by construction. This is a dashed frame with
 * a broken-picture glyph: still a `data:` URI (so the body frame's
 * `img-src 'self' data: blob:` CSP is untouched), still inert inside an
 * `<img>`, and unmistakably not the sender's artwork.
 *
 * `preserveAspectRatio="none"` on purpose: the mail's own width/height
 * attributes stretch it, and a frame that fills the slot the picture was
 * supposed to occupy is exactly the point.
 */
export const BROKEN_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" preserveAspectRatio="none">' +
      '<rect x="1" y="1" width="46" height="46" fill="#f4f4f5" stroke="#c4c4c8" stroke-width="2" stroke-dasharray="4 3"/>' +
      '<path d="M14 32l7-9 5 6 4-4 4 7z" fill="#c4c4c8"/>' +
      '<circle cx="17" cy="17" r="3" fill="#c4c4c8"/>' +
      '<path d="M10 10l28 28" stroke="#a1a1aa" stroke-width="2.5"/>' +
      '</svg>',
  )

/**
 * Splice previously-fetched remote images back into a sanitized body, once
 * the caller has decided (via account/sender policy or an explicit "load
 * images" click) that this message's remote content should load.
 *
 * `resolved[i]` may be `null` for a URL that failed to fetch. `fallback` is
 * what goes in its place — pass `BROKEN_IMAGE` once the fetch has actually
 * been attempted and failed, and leave it out while some images are still
 * pending, so an image in flight is not accused of being broken.
 */
export function resolveRemoteImages(
  html: string,
  resolved: Array<string | null>,
  fallback?: string,
): string {
  let out = html
  resolved.forEach((dataUri, index) => {
    const replacement = dataUri ?? fallback
    if (!replacement) return
    out = out.split(`${BLANK_PIXEL}#${index}`).join(replacement)
  })
  return out
}
