/**
 * The blank-pixel placeholder convention shared between `electron/sanitizeHtml.ts`
 * (which writes it) and the renderer's message-detail view (which resolves it,
 * after the user explicitly asks to load images for one message). Kept
 * dependency-free and in `src/core` — unlike the sanitizer itself, which stays
 * main-process-only — because both sides need the exact same constant.
 *
 * Two kinds of picture are parked on the same pixel, told apart by the
 * fragment the sanitizer writes after it:
 *
 *   `#<n>`        a *remote* image. `n` indexes `SanitizeResult.remoteImages`,
 *                 and the bytes only ever arrive through the main process's
 *                 vetted fetch, once the policy or the reader says so.
 *   `#cid=<id>`   an *inline* image — one of the message's own MIME parts,
 *                 referenced by `cid:`. No network is involved at all: the
 *                 bytes are already on disk beside the message, and resolving
 *                 one is a local file read, not a fetch.
 *
 * The two namespaces cannot collide: `#cid=` never parses as a number and a
 * number never starts with `c`.
 */

/** A fully transparent 1x1 GIF — visually nothing, but a legitimate `<img>` so layout is not broken. */
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

/** What an inline `cid:` reference is parked on until its own attachment is read. */
export const INLINE_MARK = '#cid='

/** The placeholder a remote image at `index` is parked on. */
export function remotePlaceholder(index: number): string {
  return `${BLANK_PIXEL}#${index}`
}

/**
 * The placeholder an inline `cid:` reference is parked on.
 *
 * `encodeURIComponent` because a Content-ID is a stranger's string: it may
 * carry a quote, a space or a `#`, any of which would either end the attribute
 * early or split the fragment this convention depends on.
 */
export function inlinePlaceholder(cid: string): string {
  return `${BLANK_PIXEL}${INLINE_MARK}${encodeURIComponent(cid)}`
}

/**
 * One Content-ID, in the one spelling both sides compare on.
 *
 * A `Content-ID` header is written `<abc@example>`; the `cid:` URL that refers
 * to it is written without the angle brackets, and mail parsers disagree about
 * which of the two they hand back. Comparing raw is how a signature image that
 * *is* in the message renders as nothing. Case-folded for the same reason —
 * RFC 2392 treats the domain half as case-insensitive and real senders vary.
 */
export function normalizeCid(raw: string): string {
  return raw.trim().replace(/^<|>$/g, '').toLowerCase()
}

/** The Content-ID a placeholder names, or `null` if it is not an inline one. */
export function cidOfPlaceholder(src: string): string | null {
  if (!src.startsWith(`${BLANK_PIXEL}${INLINE_MARK}`)) return null
  const raw = src.slice(BLANK_PIXEL.length + INLINE_MARK.length)
  try {
    return normalizeCid(decodeURIComponent(raw))
  } catch {
    // A malformed percent-escape is a placeholder this app did not write.
    return null
  }
}

/**
 * Every inline part a sanitized body actually asks for, in order, deduplicated.
 *
 * Read off the string rather than the parsed document because the caller needs
 * it *before* the frame exists — it is what decides which attachments are
 * worth reading off disk at all. A message can carry an inline part nothing
 * references (a forwarded signature image, most often), and reading those
 * would spend the budget on pictures that can never appear.
 *
 * The character class is exactly what `inlinePlaceholder` can emit:
 * `encodeURIComponent`'s unreserved set plus its `%XX` escapes. Anything else
 * in the attribute is not a placeholder this app wrote.
 */
const INLINE_PLACEHOLDER_RE = new RegExp(
  `${BLANK_PIXEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${INLINE_MARK}([A-Za-z0-9\\-_.!~*'()%]+)`,
  'g',
)

export function inlineCidsOf(html: string): string[] {
  if (!html.includes(INLINE_MARK)) return []
  const out = new Set<string>()
  for (const match of html.matchAll(INLINE_PLACEHOLDER_RE)) {
    const cid = cidOfPlaceholder(`${BLANK_PIXEL}${INLINE_MARK}${match[1]}`)
    if (cid) out.add(cid)
  }
  return [...out]
}

/** The remote-image index a placeholder names, or `null` if it is not one. */
export function remoteIndexOfPlaceholder(src: string): number | null {
  if (!src.startsWith(`${BLANK_PIXEL}#`)) return null
  const raw = src.slice(BLANK_PIXEL.length + 1)
  if (!/^\d+$/.test(raw)) return null
  return Number(raw)
}

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
 * A fetched image's value, checked again here rather than trusted from
 * `downloadRemoteImage`. That function already validates the server's
 * `Content-Type` before building this string, but this splice is the last
 * point before an attacker-influenced value re-enters already-sanitized
 * HTML — a second, independent gate here means a bug in the fetch path
 * can never turn into HTML injection on its own, only into a broken-image
 * fallback.
 */
const DATA_IMAGE_URI = /^data:image\/[a-z0-9][a-z0-9.+-]{0,127};base64,[A-Za-z0-9+/=]+$/

/**
 * The one gate every resolved picture passes through, whichever path it took.
 *
 * Exported because there are now two of those paths — the string splice below,
 * and `MessageBodyFrame`'s in-place swap on the already-parsed document — and
 * a second, separately-written validity test is how they would come to
 * disagree about what counts as an image.
 */
export function safeImageDataUri(value: string | null | undefined): string | null {
  return value && DATA_IMAGE_URI.test(value) ? value : null
}

/**
 * Splice previously-fetched remote images back into a sanitized body, once
 * the caller has decided (via account/sender policy or an explicit "load
 * images" click) that this message's remote content should load.
 *
 * `resolved[i]` may be `null` for a URL that failed to fetch, or for one that
 * "fetched" something that does not look like an image data URI — treated
 * the same way on purpose, since from here the two are indistinguishable in
 * the way that matters. `fallback` is what goes in its place — pass
 * `BROKEN_IMAGE` once the fetch has actually been attempted and failed, and
 * leave it out while some images are still pending, so an image in flight is
 * not accused of being broken.
 */
export function resolveRemoteImages(
  html: string,
  resolved: Array<string | null>,
  fallback?: string,
): string {
  let out = html
  /*
   * Highest index first, and that is a fix rather than a preference.
   *
   * The search string is a *prefix* of every longer index's placeholder:
   * `…Ow==#1` occurs inside `…Ow==#10`, `…#19`, `…#100`. Ascending, index 1
   * ran while `#10` was still in the document, split it after the `1`, and
   * left the trailing `0"` glued to the front of the substituted data URI —
   * so the eleventh picture in a message came out corrupt and the eleventh
   * onwards silently lost their placeholders. Descending, every longer index
   * has already been consumed by the time a shorter prefix of it is searched
   * for, and no index is a prefix of a *shorter* one.
   *
   * The replacements cannot reintroduce the hazard: `DATA_IMAGE_URI` admits
   * no `#`, and `BROKEN_IMAGE` is percent-encoded, so neither can contain a
   * placeholder for a later pass to find.
   */
  for (let index = resolved.length - 1; index >= 0; index--) {
    const replacement = safeImageDataUri(resolved[index]) ?? fallback
    if (!replacement) continue
    out = out.split(remotePlaceholder(index)).join(replacement)
  }
  return out
}

/**
 * Splice a message's own inline (`cid:`) pictures into a sanitized body.
 *
 * The string twin of `MessageBodyFrame`'s in-place swap, kept for the same
 * reason `resolveRemoteImages` is: the frame's live document is the fast path,
 * and this is what runs when that path cannot be taken.
 *
 * `byCid` is keyed by `normalizeCid`. A reference with no attachment behind it
 * keeps the blank pixel — invisible, exactly like a remote image nobody has
 * loaded, and deliberately *not* an error. (The in-place path can do better
 * and removes the `src` outright, which is what this app did with every `cid:`
 * image before they were resolved at all; a string splice cannot reach the
 * attribute without re-parsing the sender's markup, which is the one thing the
 * renderer is careful never to do.)
 */
export function resolveInlineImages(html: string, byCid: Map<string, string>): string {
  let out = html
  for (const [cid, dataUri] of byCid) {
    const safe = safeImageDataUri(dataUri)
    if (!safe) continue
    out = out.split(inlinePlaceholder(cid)).join(safe)
  }
  return out
}
