/**
 * Turn an attacker-authored HTML message body into something safe to render.
 *
 * This is the one place in the codebase that handles genuinely untrusted
 * markup — `src/core/mail/validate.ts`'s `escapeHtml`/`plainToHtml` sanitize the
 * *outbound* direction (the user's own compose text) and are not built for
 * this. Before this file, `ELE-04` in `scripts/audit.mjs` could truthfully
 * assert that no raw-markup injection exists anywhere in this codebase —
 * that stops being automatically true the moment a received body is
 * rendered, so two defences apply together here, not as alternatives:
 *
 *   1. This allowlist strips the obvious attack surface: script/style/iframe/
 *      object/embed/form/link/meta, every `on*` event handler, `javascript:`/
 *      `vbscript:` URLs, and — critically for mail specifically — every
 *      remote image and CSS `background-image`, which is the classic
 *      read-receipt / IP-leak vector ("did they open it, and from where").
 *   2. The caller renders the *output* of this function inside
 *      `<iframe sandbox="allow-same-origin" srcDoc={...}>` — no
 *      `allow-scripts`, so the content cannot execute anything regardless of
 *      whether this allowlist has a bug. `allow-same-origin` (and no more) is
 *      what a link-click handler needs: it lets the *parent* page reach
 *      `iframe.contentDocument` and intercept `<a>` clicks itself (extract
 *      `href`, `preventDefault()`, hand it to `openExternalSafely` behind a
 *      "this opens <host>" confirmation) — the iframe content never runs a
 *      script of its own to do that.
 */

import sanitizeHtmlLib from 'sanitize-html'
import { BLANK_PIXEL } from '../src/core/mail/remoteImagePlaceholder'

export interface SanitizeResult {
  html: string
  /** Original remote image URLs stripped out, in case the caller wants to offer "load images". */
  remoteImages: string[]
}

const ALLOWED_TAGS = [
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'div', 'span', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'img', 'font', 'center', 'small', 'sub', 'sup', 'wbr',
]

const ALLOWED_ATTRIBUTES: sanitizeHtmlLib.IOptions['allowedAttributes'] = {
  a: ['href', 'title', 'target'],
  img: ['src', 'alt', 'width', 'height'],
  font: ['color', 'size', 'face'],
  table: ['border', 'cellpadding', 'cellspacing', 'width'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'width'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'width'],
  '*': ['style'],
}

/**
 * No `background-image` (or any other `url(...)`-carrying property) on this
 * list — omission, not a regex scan for `url(`, is what keeps CSS from being
 * a second image-loading channel. Every property below is one whose CSS
 * value grammar cannot embed a URL.
 */
const ALLOWED_STYLES: sanitizeHtmlLib.IOptions['allowedStyles'] = {
  '*': {
    color: [/^[a-zA-Z#][a-zA-Z0-9(),.%\s#]*$/],
    'background-color': [/^[a-zA-Z#][a-zA-Z0-9(),.%\s#]*$/],
    'font-weight': [/^[a-zA-Z0-9]+$/],
    'font-style': [/^[a-zA-Z]+$/],
    'font-size': [/^[0-9.]+(px|pt|em|rem|%)$/],
    'text-align': [/^(left|right|center|justify)$/],
    'text-decoration': [/^[a-zA-Z\s]+$/],
  },
}

/**
 * The classic "hide this paragraph" trick: `color: red; background-color: red`
 * on the same element renders invisible text a scraper or a human skimming
 * the message never sees, but it is still there — used for keyword stuffing
 * past spam filters and for hiding fake "this is legitimate" disclaimers.
 *
 * `ALLOWED_STYLES` validates each property with its own regex and cannot
 * compare two properties against each other, so this runs first, on the raw
 * `style` string, before that allowlist filtering. It only catches the
 * same-element case (an inherited background from a parent isn't visible
 * here) — that is the trick actually reported, not a claim of a complete
 * invisible-text defence.
 */
function stripSameColorHidingTrick(style: string): string {
  const declarations = style.split(';').map((d) => d.trim()).filter(Boolean)
  let colorValue: string | null = null
  let colorIndex = -1
  let bgValue: string | null = null
  let bgIndex = -1

  declarations.forEach((decl, index) => {
    const colonIndex = decl.indexOf(':')
    if (colonIndex === -1) return
    const prop = decl.slice(0, colonIndex).trim().toLowerCase()
    const value = decl.slice(colonIndex + 1).trim().toLowerCase().replace(/\s+/g, '')
    if (prop === 'color') {
      colorValue = value
      colorIndex = index
    } else if (prop === 'background-color' || prop === 'background') {
      bgValue = value
      bgIndex = index
    }
  })

  if (colorValue !== null && bgValue !== null && colorValue === bgValue) {
    return declarations.filter((_, index) => index !== colorIndex && index !== bgIndex).join('; ')
  }
  return style
}

export function sanitizeMessageHtml(rawHtml: string): SanitizeResult {
  const remoteImages: string[] = []

  const html = sanitizeHtmlLib(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
    allowProtocolRelative: false,
    // script/style content must not survive as visible garbled text either —
    // discarding just the tag (the library default) would still leak a
    // sender's JS source onto the screen.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template'],
    transformTags: {
      '*': (tagName, attribs) =>
        attribs.style
          ? { tagName, attribs: { ...attribs, style: stripSameColorHidingTrick(attribs.style) } }
          : { tagName, attribs },
      img: (tagName, attribs) => {
        const src = attribs.src || ''
        if (src.startsWith('data:image/')) return { tagName, attribs }
        if (/^https?:\/\//i.test(src)) {
          const index = remoteImages.push(src) - 1
          // The fragment makes each placeholder's `src` value unique and
          // trivially find-and-replaceable later — a plain string search for
          // this exact value, not a regex over serialized HTML attributes
          // (which would have to guess at attribute order and quoting).
          // Browsers ignore a `#fragment` on a `data:` URI, so this still
          // renders as the same blank pixel until resolved.
          return { tagName, attribs: { ...attribs, src: `${BLANK_PIXEL}#${index}` } }
        }
        // `cid:` inline images and anything else unrecognised: dropped, not
        // resolved. Inlining `cid:` attachments is a real feature some
        // messages would benefit from — deliberately deferred rather than
        // half-built, since it needs cross-referencing against the parsed
        // attachment list at sanitize time, not just here.
        const { src: _drop, ...rest } = attribs
        return { tagName, attribs: rest }
      },
      // Anchors keep a real `href` on purpose — see the file header. The
      // renderer intercepts the click itself; nothing here should try to be
      // clever about `target`.
    },
    exclusiveFilter: (frame) =>
      // An empty `<a>` (icon-only tracking link with a 1x1 image already
      // stripped elsewhere, or just genuinely empty) is dead weight once its
      // image is gone.
      frame.tag === 'a' && !frame.text.trim() && frame.mediaChildren.length === 0,
  })

  return { html, remoteImages }
}

// `resolveRemoteImages` used to live here too — it moved to
// `src/core/mail/remoteImagePlaceholder.ts` so the renderer's message-detail view
// can call it directly after fetching images via `bridge.fetchRemoteImage`,
// without needing to reach into an Electron-main-only module.
export { resolveRemoteImages } from '../src/core/mail/remoteImagePlaceholder'
