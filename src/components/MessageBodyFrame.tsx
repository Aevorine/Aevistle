/**
 * Renders a sanitized message body inside a fully inert iframe (no
 * `allow-scripts`) and intercepts link clicks from the *parent* page via
 * `allow-same-origin` — see `electron/sanitizeHtml.ts`'s file header for why
 * this is the shape it is.
 *
 * `find` highlights matches by walking the frame's text nodes from out here.
 * That is only possible because of `allow-same-origin`, and it is the reason
 * the search is done this way rather than by injecting a script: the frame
 * still cannot execute anything, whatever the sanitiser upstream missed.
 *
 * Everything this component *adds* to a message — the night repaint, the
 * quoted-history fold and its button — is done the same way, and that is a
 * deliberate rule rather than three coincidences:
 *
 *   · the markup is built with `createElement` / `textContent` on the frame's
 *     live document, never by concatenating a string and assigning it to
 *     `innerHTML`, so nothing this file writes can become markup by accident;
 *   · nothing runs *inside* the frame — the fold's button has no handler of
 *     its own, it is a plain inert `<button>` and the parent's existing
 *     document-level click listener is what notices it was pressed;
 *   · the sandbox attribute, the CSP and `sanitizeHtml.ts` are untouched. If
 *     a feature here ever seems to need `allow-scripts`, the feature is wrong.
 *
 * Shared by the inbox reader and the calendar's per-reminder body preview —
 * one render path for HTML that did not originate as this app's own compose
 * text, so a scheduled draft's HTML gets exactly the same protection a
 * received message does rather than a second, unaudited one.
 */

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import {
  cidOfPlaceholder,
  remoteIndexOfPlaceholder,
  safeImageDataUri,
} from '../core/mail/remoteImagePlaceholder'
import { lockAxis, resolveSwipe, type Axis } from '../core/platform/gestures'

/**
 * The families received mail is set in, named literally.
 *
 * They have to be named, not inherited. This frame is a *separate document*:
 * `font-family: inherit` inside it resolves against that document's own root,
 * which has no `font-family` and no `@font-face` — the parent page's
 * `--font-sans` and its bundled faces do not cross the document boundary. So
 * the old `inherit` did not mean "the app's type", it meant "whatever this
 * engine's default standard font is": roughly Times plus a system CJK face on
 * Windows, and Roboto plus Noto Sans CJK — sans-serif — on Android. The two
 * screens that read the most text were the two that matched the app least.
 *
 * This mirrors what `--font-sans` in `src/styles/theme.css` resolves to, with
 * one honest omission: the bundled "Aevistle Text" family is *not* here and
 * cannot be. Reaching it would need an `@font-face` with a `url()` pointing at
 * the app's woff2 files, which this frame is deliberately not allowed to load
 * — no font is injected and the srcDoc sandbox and CSP are not widened for
 * one. What is left is system faces only:
 *
 *   Windows  real Times New Roman and real SimSun/宋体 are both installed, so
 *            the frame lands on the same two faces the rest of the app draws
 *            with. Effectively a match.
 *   Android  neither Times New Roman nor SimSun exists. Latin falls to the
 *            platform's `serif` (Noto Serif / Tinos), and CJK falls to the
 *            ROM's Noto Serif CJK if it ships one and to the system default
 *            if it does not. That is a serif — the fault this replaces put a
 *            sans-serif there — but it is not the same serif the app itself
 *            uses. This is the best available without widening the sandbox,
 *            and it is a real remaining difference, not parity.
 */
const READER_FONT_STACK =
  '"Times New Roman", Times, "SimSun", "宋体", "Songti SC", "Noto Serif SC", "Noto Serif CJK SC", serif'

/** Wrap a plain-text body so it can go through the same frame the HTML does. */
export function textAsHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  /*
   * `font: inherit`, where the family, the size and the leading used to be
   * written out.
   *
   * They were spelled out because `<pre>` carries a UA default — monospace,
   * and the 13px monospace quirk with it — that a keyword resolving to
   * nothing useful could not displace. `inherit` resolves to *this document's*
   * `body`, which is now set by the injected sheet below, so the three values
   * have one definition instead of two that can drift.
   *
   * It also has to stay a shorthand rather than three longhands, because the
   * point is to be correct at both moments: before the sheet lands the `<pre>`
   * inherits the UA's body (16px, not 13px monospace), and after it lands it
   * inherits the reader's own type — including the user's `--text-scale`,
   * which a hard `font-size:16px` here silently cancelled.
   */
  return `<pre style="white-space:pre-wrap;word-break:break-word;font:inherit;margin:0">${escaped}</pre>`
}

/* ==========================================================================
   Colour, without a single literal

   Everything this file paints — the ground, the ink, the fold button, the
   find highlight — is read out of the app's own tokens at run time and
   written into the frame as ordinary CSS values. The frame is a separate
   document, so `var(--surface-1)` inside it resolves against *its* root,
   which has no custom properties and never will (the same boundary
   `READER_FONT_STACK` describes for fonts). Passing the resolved value in is
   the only way the theme crosses it.

   The two helpers below also carry the arithmetic for item 18 — adjusting a
   sender's own colours for a dark ground instead of inverting the frame. They
   parse what `getComputedStyle` hands back (always `rgb()`/`rgba()`) and the
   hex forms a token file is written in, and nothing else: an unparseable
   value is left exactly as the sender wrote it, which is the safe direction.
   ========================================================================== */

interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase()
  if (text === '' || text === 'transparent') return null
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)
  if (hex) {
    const digits = hex[1]
    const wide = digits.length > 4
    const step = wide ? 2 : 1
    const at = (i: number) => {
      const part = digits.slice(i * step, i * step + step)
      const full = wide ? part : part + part
      return parseInt(full, 16)
    }
    if (digits.length === 3 || digits.length === 6) return { r: at(0), g: at(1), b: at(2), a: 1 }
    if (digits.length === 4 || digits.length === 8) return { r: at(0), g: at(1), b: at(2), a: at(3) / 255 }
    return null
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text)
  if (!fn) return null
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const channel = (raw: string) =>
    raw.endsWith('%') ? Math.round((parseFloat(raw) / 100) * 255) : Math.round(parseFloat(raw))
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
  return { r, g, b, a: Number.isFinite(alpha) ? alpha : 1 }
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
  else if (max === gg) h = ((bb - rr) / d + 2) / 6
  else h = ((rr - gg) / d + 4) / 6
  return { h, s, l }
}

/** The same colour at a different lightness, hue and saturation untouched. */
function atLightness(colour: Rgb, lightness: number): string {
  const { h, s } = toHsl(colour)
  const alpha = colour.a >= 1 ? '' : ` / ${Math.round(colour.a * 100)}%`
  return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(lightness * 100)}%${alpha})`
}

/* ==========================================================================
   Quoted history

   A reply carries the whole conversation under it. On a 360px screen that is
   routinely four screens of text you have already read, sitting between you
   and the attachments, and the reader's scrollbar stops meaning anything.

   ## The rule this obeys

   Hiding real content is worse than leaving a quote on screen. So every rule
   below is written to *fail closed*: when the shape is not one of the ones
   named here, nothing is folded and the message renders exactly as it did
   before this existed. The label always carries a real count — the number of
   lines actually inside the folded region, counted, never estimated — because
   "show quoted text" with no number gives no way to tell a two-line signature
   from forty lines of history, and that number is the only thing on the button
   that helps anyone decide whether to press it.

   ## What is folded

   *Plain text* (`textAsHtml`'s `<pre>`), two accepted shapes:

     1. An attribution line — "On … wrote:", 「在…写道：」, "Le … a écrit :",
        "-----Original Message-----", or an Outlook `From:/Sent:/Subject:`
        header block — with real text above it. Everything from that line to
        the end of the body folds. Two lines minimum.
     2. No attribution, but the body *ends* in a run of `>`-quoted lines with
        unquoted text above it. Three lines minimum, and the run's first line
        must start with exactly one `>`.

   *HTML*: shape 1 only. `>` has a standardised meaning in a text/plain body
   (RFC 3676 §4.5); `<blockquote>` does not — it is an ordinary typographic
   element, and a newsletter that ends on a pull-quote would have that quote
   folded away by a rule that treated the two as equivalent. So a bare trailing
   `<blockquote>` with no attribution is deliberately left alone. It is a known
   false negative, chosen over a false positive.

   ## What is deliberately NOT folded, and why

     · Interleaved replies. Only the *last* quoted run is a candidate, and only
       when unquoted text precedes it. In a bottom-post-inside-the-quote reply
       the answer lives between the quoted paragraphs, and folding those would
       hide the reply itself.
     · A message that is quoted all the way to the top. There is nothing left
       to show, so folding would hide the whole message behind a button.
     · A Markdown blockquote opening a message — same test, from the other end:
       the run has to be at the bottom and have content above it.
     · `>>> ` REPL transcripts, and `-> ` / `=> ` arrows in a log paste. The
       arrows never match (`>` has to be the first non-space character); the
       REPL is excluded by requiring the run's first line to be a single `>`,
       which is what every mail client emits at the outermost quote level.
     · An attribution-shaped *sentence* with no date in it. "Вот что он
       написал:" is a person introducing what follows, not a client announcing
       a quote, and the four-digit test on `ATTRIBUTION_DATED` is what tells
       them apart in all six languages at once.
     · A `From:` line with fewer than three header lines under it — "From:
       Shanghai" in a form is not a quoted header block.
     · Signatures, `--` separators, unsubscribe footers and legal disclaimers.
       They are the sender's own words in their own message, not history.
     · Anything inside a `<table>`. Marking a `<td>` and inserting a button
       beside it is how a layout table gets taken apart; the fold declines.
     · Runs shorter than the minimums above — a button that hides two lines
       costs a line to save two.

   ## How the toggle works without a script in the frame

   The fold is DOM state on the frame's own document: the hidden run is
   classed, the button is a plain `<button>` with no handler, and the parent
   page's existing click listener — the one that already intercepts `<a>` —
   flips a class on the frame's `<html>`. The frame executes nothing; the
   sandbox is unchanged. Both labels ship in the markup and CSS picks one, so
   pressing the button does not need a re-render (and cannot cause one).
   ========================================================================== */

/** The hidden run. The injected stylesheet is what makes it invisible. */
const QUOTE_CLASS = 'aev-quoted'
/** The one-line summary that stands in for it. */
const QUOTE_BTN_CLASS = 'aev-quotebtn'
/** On the frame's own `<html>` while the quote is showing. */
const QUOTE_OPEN_CLASS = 'aev-quote-open'
/** A wrapper this file created, so undoing a fold unwraps exactly those. */
const QUOTE_WRAP_ATTR = 'data-aev-wrap'

/**
 * How many lines are examined at all.
 *
 * A hostile IMAP message can hand this a body with a hundred thousand lines
 * and no user action, and every regex below then runs on every one of them.
 * The attribution that matters is never past this point in a real reply, and
 * `codeExtract.ts` caps its own input for exactly the same reason.
 */
const MAX_SCAN_LINES = 4000
/** And how much of one line. The patterns are anchored at both ends anyway. */
const MAX_LINE_TEST = 200
/** With an attribution vouching for it, two lines is enough to be worth hiding. */
const MIN_ATTRIBUTED_LINES = 2
/** Without one, three — the run has nothing but its own shape to argue with. */
const MIN_BARE_QUOTE_LINES = 3

/**
 * The attribution sentence, in each of the six languages this app ships.
 *
 * Anchored at *both* ends on a trimmed line, which is half of what makes these
 * conservative: "on the whole I wrote: nothing" does not match, and a sentence
 * that merely contains the words cannot either. The cost is real and accepted —
 * a client that wraps its attribution across two lines is not recognised, and
 * that message simply keeps its quote.
 *
 * The other half is `DATE_DIGITS` below, and it is not optional. Every one of
 * these patterns has a `.{4,160}` in the middle that a real sentence can walk
 * into: Russian "Вот что он написал:" satisfies the fifth pattern completely,
 * and it is ordinary prose with the rest of the message under it — folding
 * there would hide exactly the content the reader was sent. What separates the
 * two is that a machine-written attribution always says *when*: it carries a
 * date, a time, or both. Four digits is the cheapest test for that and it
 * costs the real ones nothing — a year alone already clears it.
 */
const ATTRIBUTION_DATED: RegExp[] = [
  // Gmail, Apple Mail, Thunderbird: "On Tue, 12 Aug 2026 at 10:04, X <x@y> wrote:"
  /^on\s.{4,160}\swrote:$/i,
  // 「在 2026年8月12日 ... 写道：」 — 简体与繁体的「写道/寫道」都在内
  /^在\s*.{4,160}\s*(?:写道|寫道)\s*[:：]$/,
  /^le\s.{4,160}\sa\s+écrit\s*:$/i,
  /^el\s.{4,160}\sescribió\s*:$/i,
  /^.{4,160}\s(?:писал|писала|написал|написала|пишет)\(?а?\)?\s*[:：]$/i,
  /^(?:في|بتاريخ)\s.{4,160}\s(?:كتب|كتبت)\s*[:：]$/,
]

/** The separator Outlook and several Chinese clients write instead of a sentence. */
const ATTRIBUTION_SEPARATOR =
  /^[-–—_]{2,}\s*(?:original message|forwarded message|原始邮件|原邮件|转发邮件|轉發郵件|mensaje original|mensaje reenviado|message d'origine|message transféré|исходное сообщение|пересланное сообщение|الرسالة الأصلية)\s*[-–—_]{2,}$/i

/**
 * At least four digits on the line — see `ATTRIBUTION_DATED`.
 *
 * Counted rather than matched with `/(?:\D*\d){4}/`: a bounded repetition
 * wrapped around a greedy `\D*` is the shape that backtracks, and this runs
 * over attacker-supplied lines. One `match` and a length is linear and says
 * plainly what it means.
 */
function hasDateDigits(line: string): boolean {
  return (line.match(/\d/g)?.length ?? 0) >= 4
}

/**
 * The other Outlook shape: no sentence at all, a little header block.
 *
 * `From:` alone is nowhere near enough — a message can say "From: Shanghai" in
 * prose — so three of its companions have to follow within five lines. Three,
 * not two: `From:` / `Date:` / `Subject:` is a combination an ordinary form or
 * a pasted record can reach by accident, and folding everything under it would
 * hide the rest of the message. Every client that writes this block writes at
 * least `Sent`/`Date`, `To` and `Subject` under the `From`, so the stricter
 * count costs the real case nothing and drops the accidental one.
 */
const HEADER_FROM = /^(?:from|发件人|寄件者|de|von|от|من)\s*[:：]\s*\S/i
const HEADER_COMPANION =
  /^(?:sent|date|to|cc|subject|发送时间|发送日期|日期|時間|收件人|抄送|主题|主旨|enviado|fecha|para|asunto|envoyé|date d'envoi|à|objet|отправлено|дата|кому|тема|تاريخ|إلى|الموضوع)\s*[:：]/i

/** Up to three leading spaces — some clients indent the marker, none indent more. */
const QUOTED_LINE = /^ {0,3}>/
/** The outermost quote level, which is what a mail client writes and a REPL does not. */
const TOP_LEVEL_QUOTE = /^ {0,3}>(?!>)/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isAttributionLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length < 8 || trimmed.length > MAX_LINE_TEST) return false
  if (ATTRIBUTION_SEPARATOR.test(trimmed)) return true
  if (!hasDateDigits(trimmed)) return false
  return ATTRIBUTION_DATED.some((re) => re.test(trimmed))
}

function isHeaderBlockAt(lines: string[], at: number): boolean {
  if (!HEADER_FROM.test(lines[at].trim().slice(0, MAX_LINE_TEST))) return false
  let companions = 0
  for (let i = at + 1; i < Math.min(lines.length, at + 6); i++) {
    if (HEADER_COMPANION.test(lines[i].trim().slice(0, MAX_LINE_TEST))) companions++
  }
  return companions >= 3
}

function opensQuote(lines: string[], at: number): boolean {
  return isAttributionLine(lines[at]) || isHeaderBlockAt(lines, at)
}

/** Lines in `slice`, ignoring the blank ones trailing off the end. */
function countFolded(lines: string[], from: number): number {
  let end = lines.length - 1
  while (end >= from && isBlank(lines[end])) end--
  return end < from ? 0 : end - from + 1
}

/**
 * Where the quoted history starts in a plain-text body, or `null`.
 *
 * Returns the *line index*, and the caller splits the `<pre>`'s single text
 * node there — so the count and the split can never disagree about what was
 * hidden, which is the failure mode a separate "estimate the length" step
 * would have.
 */
function findTextFold(lines: string[]): { at: number; lines: number } | null {
  const limit = Math.min(lines.length, MAX_SCAN_LINES)

  // 1 — the first attribution with real text above it. First rather than last:
  // a thread quoted four deep has four of these, and folding from the topmost
  // one is what hides the whole history instead of only its innermost layer.
  for (let i = 1; i < limit; i++) {
    if (!opensQuote(lines, i)) continue
    if (!lines.slice(0, i).some((l) => !isBlank(l))) break
    const folded = countFolded(lines, i)
    return folded >= MIN_ATTRIBUTED_LINES ? { at: i, lines: folded } : null
  }

  // 2 — a trailing `>` run, with nothing to introduce it.
  let end = lines.length - 1
  while (end >= 0 && isBlank(lines[end])) end--
  if (end < 0) return null
  let before = end
  while (before >= 0 && (QUOTED_LINE.test(lines[before]) || isBlank(lines[before]))) before--
  let start = before + 1
  while (start <= end && isBlank(lines[start])) start++
  if (start > end) return null
  if (!TOP_LEVEL_QUOTE.test(lines[start])) return null
  let quoted = 0
  for (let i = start; i <= end; i++) if (QUOTED_LINE.test(lines[i])) quoted++
  if (quoted < MIN_BARE_QUOTE_LINES) return null
  // Something unquoted and non-blank has to be above it, or the whole message
  // is the quote and there is nothing left to show.
  if (!lines.slice(0, start).some((l) => !isBlank(l) && !QUOTED_LINE.test(l))) return null
  return { at: start, lines: end - start + 1 }
}

/**
 * Tags that end a line by existing.
 *
 * This is the definition the count on the button is honest about: a "line" is
 * one `<br>` or one block-element boundary, with empty ones dropped. It is not
 * the number of lines the *browser* wrapped the quote onto — that number
 * changes with the window width and could not be put in a label — and it is
 * not an approximation of it either. It is the quoted history's own lines.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CENTER', 'DD', 'DIV', 'DL', 'DT',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD',
  'TR', 'UL',
])

function linesOf(nodes: Node[]): string[] {
  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += (node.textContent ?? '').replace(/\s+/g, ' ')
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el.tagName === 'BR') {
      out += '\n'
      return
    }
    const block = BLOCK_TAGS.has(el.tagName)
    if (block) out += '\n'
    for (const kid of Array.from(el.childNodes)) walk(kid)
    if (block) out += '\n'
  }
  for (const node of nodes) walk(node)
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

/** Is there real text before `stop`? Answered without reading the whole body. */
function hasTextBefore(body: HTMLElement, stop: Element): boolean {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let seen = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    // `DOCUMENT_POSITION_FOLLOWING` is set both for a node after `stop` and for
    // one inside it, so this one test ends the walk at the quote either way.
    if (stop.compareDocumentPosition(node) & 4) break
    seen += (node.textContent ?? '').trim().length
    if (seen >= 8) return true
  }
  return false
}

/**
 * The element the quoted history starts at in an HTML body, or `null`.
 *
 * Two passes, cheapest first. Text nodes cover every client that writes the
 * attribution as a sentence — which is all of them except Outlook, whose
 * header block puts `From:` inside a `<b>` and so never appears as one text
 * node. That one is caught by reading the last few top-level children whole.
 */
function findHtmlFoldStart(body: HTMLElement): Element | null {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let scanned = 0
  let node: Node | null
  while ((node = walker.nextNode()) && scanned < MAX_SCAN_LINES) {
    scanned++
    const text = node.textContent ?? ''
    if (text.trim().length < 8) continue
    if (!isAttributionLine(text)) continue
    const host = node.parentElement
    // `host === body` means the attribution is a bare text node hanging off
    // the body with no element of its own. Folding "from here" would have to
    // start at `body`, and marking `body` hides the message. Skipped, not
    // worked around.
    if (!host || host === body) continue
    if (host.closest('table')) return null
    return host
  }

  const children = Array.from(body.children)
  for (const child of children.slice(-4)) {
    if (child.closest('table')) continue
    const lines = linesOf([child])
    if (lines.length >= MIN_ATTRIBUTED_LINES && isHeaderBlockAt(lines, 0)) return child
  }
  return null
}

/** Everything after `node` in document order, as a flat, non-overlapping list. */
function nodesFrom(body: HTMLElement, node: Element): Node[] {
  const out: Node[] = [node]
  let sibling = node.nextSibling
  while (sibling) {
    out.push(sibling)
    sibling = sibling.nextSibling
  }
  // Then, level by level up to the body, everything *after* each ancestor —
  // never the ancestor itself, which is holding the reply this fold exists to
  // keep on screen.
  let parent = node.parentNode
  while (parent && parent !== body) {
    let after = parent.nextSibling
    while (after) {
      out.push(after)
      after = after.nextSibling
    }
    parent = parent.parentNode
  }
  return out
}

/** Undo whatever a previous run of `applyFold` left behind. */
function clearFold(doc: Document) {
  doc.documentElement.classList.remove(QUOTE_OPEN_CLASS)
  for (const button of Array.from(doc.querySelectorAll(`.${QUOTE_BTN_CLASS}`))) button.remove()
  for (const marked of Array.from(doc.querySelectorAll(`.${QUOTE_CLASS}`))) {
    marked.classList.remove(QUOTE_CLASS)
    if (!marked.hasAttribute(QUOTE_WRAP_ATTR)) continue
    // A wrapper this file added: put its contents back where they were.
    const parent = marked.parentNode
    if (!parent) continue
    while (marked.firstChild) parent.insertBefore(marked.firstChild, marked)
    parent.removeChild(marked)
    parent.normalize()
  }
}

/**
 * Fold the quoted history in `doc`, if there is one this file is sure about.
 *
 * Built node by node with `textContent`, never by assigning `innerHTML`: the
 * one thing this function must never do is turn a string into markup inside a
 * document that holds attacker-authored content.
 */
function applyFold(doc: Document, labels: { show: (n: number) => string; hide: string }) {
  const body = doc.body
  if (!body) return

  const button = () => {
    const el = doc.createElement('button')
    el.type = 'button'
    el.className = QUOTE_BTN_CLASS
    return el
  }
  const fill = (el: HTMLElement, count: number) => {
    const show = doc.createElement('span')
    show.className = 'aev-quoteshow'
    show.textContent = labels.show(count)
    const hide = doc.createElement('span')
    hide.className = 'aev-quotehide'
    hide.textContent = labels.hide
    el.append(show, hide)
  }

  // --- the plain-text body -------------------------------------------------
  //
  // `textAsHtml` produces exactly one `<pre>` holding exactly one text node.
  // Requiring that shape rather than reconstructing it is what keeps this off
  // a body the find-highlighter has already split into marks: it declines and
  // the message keeps its quote, which is the right way round.
  const onlyChild = body.children.length === 1 ? body.firstElementChild : null
  if (onlyChild?.tagName === 'PRE' && onlyChild.childNodes.length === 1) {
    const text = onlyChild.firstChild
    if (!text || text.nodeType !== 3) return
    const lines = (text.textContent ?? '').split('\n')
    const fold = findTextFold(lines)
    if (!fold) return
    const head = lines.slice(0, fold.at).join('\n')
    const tail = lines.slice(fold.at).join('\n')
    // The `\n` is the separator `join` did not put back, and it is added
    // unconditionally: `head.endsWith('\n')` looks like the same test and is
    // not, because a head whose last line is empty already ends in one and
    // would then lose the blank line the sender left above the quote.
    text.textContent = `${head}\n`
    const control = button()
    fill(control, fold.lines)
    const wrap = doc.createElement('span')
    wrap.className = QUOTE_CLASS
    wrap.setAttribute(QUOTE_WRAP_ATTR, '')
    wrap.textContent = tail
    onlyChild.append(control, wrap)
    return
  }

  // --- the HTML body -------------------------------------------------------
  const start = findHtmlFoldStart(body)
  if (!start) return
  if (!hasTextBefore(body, start)) return
  const folded = nodesFrom(body, start)
  const count = linesOf(folded).length
  if (count < MIN_ATTRIBUTED_LINES) return

  const control = button()
  fill(control, count)
  start.parentNode?.insertBefore(control, start)
  for (const node of folded) {
    if (node.nodeType === 1) {
      ;(node as Element).classList.add(QUOTE_CLASS)
      continue
    }
    // A bare text node between two blocks cannot carry a class, so it gets a
    // wrapper — tagged, so `clearFold` can take exactly this one back out.
    if (node.nodeType !== 3 || (node.textContent ?? '').trim() === '') continue
    const wrap = doc.createElement('span')
    wrap.className = QUOTE_CLASS
    wrap.setAttribute(QUOTE_WRAP_ATTR, '')
    node.parentNode?.insertBefore(wrap, node)
    wrap.appendChild(node)
  }
}

/* ==========================================================================
   The reading layout, and the palette that carries it

   Three things cross the document boundary here, and all three have to be
   *carried* rather than inherited: the type size the user chose, the colours
   the app is painted in, and the measure. See `READER_FONT_STACK` for the
   general shape of that boundary — a custom property declared on the app's
   root is not visible in this document any more than a bundled font is.
   ========================================================================== */

interface Palette {
  /** `light` or `dark`, so the frame's own form controls and scrollbar follow. */
  scheme: 'light' | 'dark'
  ground: string
  ink: string
  inkQuiet: string
  line: string
  panel: string
  panelHover: string
  mark: string
  /** The type scale's own root size, in px, so `rem` in here means what it does out there. */
  rootSize: string
  pad: string
  padTight: string
  gap: string
  radius: string
  tap: string
  /** Latin measure, from `--reading-max`. Empty when the token cannot be read. */
  measure: string
  /** Whether the sender's own colours need adjusting for this ground. */
  night: boolean
}

/**
 * Below this the ground counts as dark. Well clear of both ends: the light
 * palettes' `--surface-1` sits at ~0.96 relative luminance and every dark
 * one at ~0.012, so nothing real is anywhere near the line.
 */
const DARK_GROUND_BELOW = 0.4

/**
 * The measure for a CJK body.
 *
 * A Han character is one em wide, so `40em` is forty of them — the figure
 * Chinese typography settles on for a comfortable line, and the same order of
 * magnitude as `--reading-max`'s 68 Latin characters (a Latin character
 * averages about half an em, so 68ch is ~34em). One token cannot serve both,
 * because the two scripts disagree about what a "character" is by a factor of
 * two; which one is used is decided from the message's own text.
 */
const CJK_MEASURE = '40em'

/** The app's palette, as the frame has to receive it: resolved values, no `var()`. */
function readPalette(night: boolean): Palette {
  const paper: Palette = {
    scheme: 'light',
    // System keywords, not literals, and not the app's tokens either. Under
    // `color-scheme: light` these are white and black whatever the OS is set
    // to — which is exactly the paper the sender laid the message out on, and
    // exactly what "show original colours" means.
    ground: 'canvas',
    ink: 'canvastext',
    inkQuiet: 'color-mix(in srgb, canvastext 65%, canvas)',
    line: 'color-mix(in srgb, canvastext 22%, canvas)',
    panel: 'color-mix(in srgb, canvastext 6%, canvas)',
    panelHover: 'color-mix(in srgb, canvastext 12%, canvas)',
    mark: 'color-mix(in srgb, highlight 45%, transparent)',
    rootSize: '',
    pad: '1rem',
    padTight: '0.75rem',
    gap: '0.5rem',
    radius: '8px',
    tap: '48px',
    measure: '',
    night: false,
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return paper

  const root = getComputedStyle(document.documentElement)
  const token = (name: string) => root.getPropertyValue(name).trim()
  const ground = token('--surface-1')
  const ink = token('--text-1')
  const parsed = parseColor(ground)
  const appIsDark = parsed !== null && luminance(parsed) < DARK_GROUND_BELOW

  const shared = {
    rootSize: root.fontSize,
    pad: token('--sp-4') || paper.pad,
    padTight: token('--sp-3') || paper.padTight,
    gap: token('--sp-2') || paper.gap,
    radius: token('--r-sm') || paper.radius,
    tap: token('--ctl-md') || paper.tap,
    measure: token('--reading-max'),
    mark: `color-mix(in srgb, ${token('--accent') || 'highlight'} 38%, transparent)`,
  }

  // "Show original colours" on a dark app is the one case the tokens cannot
  // answer: they are the dark end by definition, and the request is for the
  // light one. Paper it is — with the type, spacing and measure still coming
  // from the app, because those are not what the reader asked to undo.
  if (!night && appIsDark) return { ...paper, ...shared }
  if (!ground || !ink) return { ...paper, ...shared }

  return {
    scheme: appIsDark ? 'dark' : 'light',
    ground,
    ink,
    inkQuiet: token('--text-2') || ink,
    line: token('--border') || paper.line,
    panel: token('--surface-2') || paper.panel,
    panelHover: token('--surface-3') || paper.panelHover,
    ...shared,
    night: night && appIsDark,
  }
}

/**
 * The palette, as a stylesheet on the frame's own root.
 *
 * Its own `<style>` rather than folded into the base sheet, for the same
 * reason the night rules had one: the base sheet is written once per document
 * and the palette changes under it — the theme, the accent, the text size, and
 * the per-message "show original colours" toggle all move it without the frame
 * reloading.
 */
function writeTheme(doc: Document, palette: Palette, cjk: boolean) {
  let style = doc.getElementById('aev-theme') as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = 'aev-theme'
    doc.head?.appendChild(style)
  }
  const measure = cjk ? CJK_MEASURE : palette.measure
  style.textContent =
    ':root{' +
    `color-scheme:${palette.scheme};` +
    // The root size, so `rem` and the `--text-scale` the user picked mean the
    // same thing in here as they do out there. Without it the frame is always
    // 16px and the text-size setting stops at the frame's edge.
    (palette.rootSize ? `font-size:${palette.rootSize};` : '') +
    `--aev-ground:${palette.ground};` +
    `--aev-ink:${palette.ink};` +
    `--aev-ink-2:${palette.inkQuiet};` +
    `--aev-line:${palette.line};` +
    `--aev-panel:${palette.panel};` +
    `--aev-panel-hover:${palette.panelHover};` +
    `--aev-mark:${palette.mark};` +
    `--aev-pad:${palette.pad};` +
    `--aev-pad-2:${palette.padTight};` +
    `--aev-gap:${palette.gap};` +
    `--aev-radius:${palette.radius};` +
    `--aev-tap:${palette.tap};` +
    (measure ? `--aev-measure:${measure};` : '') +
    '}'
}

/* --------------------------------------------------------------------------
   The measure, and who is allowed one
   ----------------------------------------------------------------------- */

/** How much of the body is read to decide which script it is in. */
const SCRIPT_SAMPLE_CHARS = 600
const CJK_CHARS = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g

/**
 * Is this body one this app may set a measure on?
 *
 * Only plain text and simple HTML. A sender who built a fixed-width table
 * layout has already decided how wide the message is, and clamping it would
 * be this app inventing a design decision rather than repairing one — the
 * same line `centreOuter` draws, from the other side. So anything carrying a
 * table or a declared width is left exactly as it arrived.
 *
 * `<pre>` is included deliberately: `textAsHtml` produces exactly that, and a
 * plain-text mail is the body that benefits most from a measure — it has no
 * layout of its own at all, so on a 1474px window it ran the full width.
 */
function bodyTakesMeasure(doc: Document): boolean {
  const body = doc.body
  if (!body) return false
  return body.querySelector('table, [style*="width"], [width]') === null
}

/** Whether the first few hundred characters read as CJK rather than Latin. */
function bodyIsCjk(doc: Document): boolean {
  const body = doc.body
  if (!body) return false
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let sample = ''
  let node: Node | null
  while ((node = walker.nextNode()) && sample.length < SCRIPT_SAMPLE_CHARS) {
    sample += node.textContent ?? ''
  }
  const sliced = sample.slice(0, SCRIPT_SAMPLE_CHARS)
  const letters = sliced.replace(/\s/g, '').length
  if (letters < 12) return false
  return (sliced.match(CJK_CHARS)?.length ?? 0) / letters > 0.3
}

/* --------------------------------------------------------------------------
   The sender's own colours, on a dark ground

   What this replaces: `html{filter:invert(1) hue-rotate(180deg)}` with an
   un-invert on `img`. That trick is one declaration and it is wrong in a way
   no amount of tuning fixes — it does not adapt a message to a dark ground,
   it photographically negates it. A logo in a brand colour comes out in the
   complementary one; a scanned document comes out as a negative; a PNG with
   an alpha channel comes out inverted *and* the un-invert rule then inverts
   the parts of the page showing through it. The un-invert also only ever
   covered `<img>`, which was true only because the sanitiser allows no other
   way for a picture to be in the frame (see `ALLOWED_STYLES`) — a defence
   resting on a list in another file.

   So: the ground and the default ink come from the theme (above), pictures
   are not touched at all, and a colour the *sender* declared is moved rather
   than mirrored — same hue, same saturation, a lightness that works on this
   ground. A red heading stays red. A photograph stays a photograph.

   Both halves are recorded on the element, so "show original colours" is an
   exact undo rather than a second guess at what the sender wrote.
   ----------------------------------------------------------------------- */

/**
 * How many declared colours are examined.
 *
 * A hostile body can carry a hundred thousand elements with a `style` on each,
 * and every one of them costs a resolved style read. The cap is the same
 * discipline `MAX_SCAN_LINES` applies to the fold, and a real newsletter is
 * two orders of magnitude under it.
 */
const MAX_RECOLOURED = 1500
/** Ink at or below this luminance was written for white paper. */
const INK_DARK_BELOW = 0.45
/** …and is lifted to at least this lightness, keeping its hue. */
const INK_TARGET_L = 0.72
/** Under this saturation a colour is a grey, and greys become the theme's ink. */
const GREY_BELOW_S = 0.12
/** A background at or above this luminance is the sender's white paper. */
const BG_LIGHT_ABOVE = 0.75
/** A mid-tone panel is darkened to this instead of being replaced. */
const BG_TARGET_L = 0.24
/** Below this it is already dark enough to leave alone. */
const BG_DARK_BELOW = 0.06

function adjustSenderColours(doc: Document, palette: Palette) {
  const body = doc.body
  if (!body) return
  const candidates = body.querySelectorAll<HTMLElement>('[style],font[color],[bgcolor]')
  const limit = Math.min(candidates.length, MAX_RECOLOURED)
  for (let i = 0; i < limit; i++) {
    const el = candidates[i]
    // Already adjusted — the effect re-runs on a re-fold and on a language
    // change, and a second pass over its own output would lighten a colour
    // twice and lose the original.
    if (el.hasAttribute('data-aev-ink') || el.hasAttribute('data-aev-bg')) continue
    const declaresInk = el.style.color !== '' || (el.tagName === 'FONT' && el.hasAttribute('color'))
    const declaresBg = el.style.backgroundColor !== '' || el.hasAttribute('bgcolor')
    if (!declaresInk && !declaresBg) continue
    const computed = doc.defaultView?.getComputedStyle(el)
    if (!computed) continue

    if (declaresInk) {
      const colour = parseColor(computed.color)
      if (colour && colour.a > 0.1 && luminance(colour) < INK_DARK_BELOW) {
        const { s, l } = toHsl(colour)
        el.dataset.aevInk = el.style.color
        el.style.color = s < GREY_BELOW_S ? palette.ink : atLightness(colour, Math.max(l, INK_TARGET_L))
      }
    }
    if (declaresBg) {
      const colour = parseColor(computed.backgroundColor)
      if (colour && colour.a > 0.05) {
        const lum = luminance(colour)
        const { s, l } = toHsl(colour)
        const next =
          lum >= BG_LIGHT_ABOVE
            ? // The sender's paper. Replaced outright rather than darkened, so
              // the message sits on the *same* ground the frame does instead
              // of on a near-black rectangle a shade off it.
              palette.ground
            : lum > BG_DARK_BELOW && s >= GREY_BELOW_S
              ? atLightness(colour, Math.min(l, BG_TARGET_L))
              : lum > BG_DARK_BELOW
                ? palette.panel
                : ''
        if (next) {
          el.dataset.aevBg = el.style.backgroundColor
          el.style.backgroundColor = next
        }
      }
    }
  }
}

/** Put every colour this file moved back exactly where the sender had it. */
function restoreSenderColours(doc: Document) {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[data-aev-ink],[data-aev-bg]'))) {
    if (el.hasAttribute('data-aev-ink')) {
      // The empty string is a real recorded value: it means the sender set the
      // colour with `<font color>` or `bgcolor` and had no inline style at
      // all, so clearing the inline property is what restores the attribute.
      el.style.color = el.dataset.aevInk ?? ''
      el.removeAttribute('data-aev-ink')
    }
    if (el.hasAttribute('data-aev-bg')) {
      el.style.backgroundColor = el.dataset.aevBg ?? ''
      el.removeAttribute('data-aev-bg')
    }
  }
}

/**
 * The pictures a message is still waiting for, and what to paint in their
 * place — see `src/core/mail/remoteImagePlaceholder.ts` for the convention.
 */
export interface FrameImages {
  /** Resolved remote images by placeholder index. `null` = fetched and failed. */
  remote?: Array<string | null>
  /** What a failed remote image becomes, once every URL has actually been tried. */
  remoteFallback?: string
  /** Resolved inline (`cid:`) parts, keyed by `normalizeCid`. */
  inline?: Record<string, string>
  /** Every inline part that could be read has been — drop whatever is left. */
  inlineSettled?: boolean
}

export function MessageBodyFrame({
  html,
  find,
  onLinkClick,
  frameClassName = 'reader__frame',
  nightFilter = false,
  foldQuotes = false,
  images,
  onImagesUnplaced,
  onScroll,
  onSwipeDismiss,
  themeKey = '',
}: {
  html: string
  find: string
  onLinkClick: (url: string) => void
  /** Defaults to the inbox reader's own sizing; callers with a tighter budget (the calendar's row preview) pass their own. */
  frameClassName?: string
  /**
   * Paint the message for a dark room rather than for white paper.
   *
   * On, the frame takes the app's own dark tokens for its ground and ink and
   * the sender's *declared* colours are moved onto that ground — see
   * `adjustSenderColours`, which also records what this used to be (a whole-
   * frame `filter: invert()`) and why that had to go. Off, the frame is the
   * paper the sender laid the message out on, which is what "show original
   * colours" means; pictures are never touched either way.
   *
   * The caller gates this on `settings.readerDarkInvert` *and* on the app
   * actually being in dark mode; this component is told the answer, it does
   * not read either.
   */
  nightFilter?: boolean
  /**
   * Pictures to place into the *already-parsed* document, rather than by
   * rebuilding `html` and reloading the frame.
   *
   * Rebuilding was what this did, and the cost was not small: a new `srcDoc`
   * throws away the parsed document, every image that had already decoded,
   * the reader's scroll position inside the message, the fold's DOM state and
   * the find highlighting — and re-runs the fold and find passes over the
   * whole body. All of that to change one attribute per picture. The frame is
   * same-origin, so the attributes are reachable from out here.
   */
  images?: FrameImages
  /**
   * Called when the swap above could not be made at all — the document was
   * not reachable, or it holds none of the placeholders the caller resolved.
   * The caller's answer is the old full rebuild, which is a fallback and not
   * an error: it produces exactly the same picture, one reload later.
   */
  onImagesUnplaced?: () => void
  /** The message's own scroll offset. The body scrolls *inside* this frame. */
  onScroll?: (top: number) => void
  /**
   * A finger swipe across the message body, left or right — either direction
   * means the same thing here, "close this and go back to the list", so the
   * direction itself is not reported.
   *
   * Mouse drags never trigger this (text selection has to keep working), and a
   * vertical scroll releases it the same way `useSwipe` releases a list row:
   * once the drag is unambiguously vertical, this stops watching for the rest
   * of that gesture rather than fighting the scroll for it.
   */
  onSwipeDismiss?: () => void
  /**
   * Anything that moves the app's palette or type scale: the theme, the
   * accent, the visual style, the text-size setting.
   *
   * A string rather than the values themselves, because this component does
   * not know what a theme is — it reads whatever the tokens currently say and
   * only needs to be told *when* to read them again. The frame is a separate
   * document, so nothing here re-cascades on its own.
   */
  themeKey?: string
  /**
   * Collapse the quoted history behind one line — see the block comment above
   * `QUOTE_CLASS` for every rule this obeys and every shape it refuses.
   *
   * Off by default, so the calendar's reminder preview (which renders this
   * app's own compose text, where there is no history to fold) is unaffected
   * unless it ever asks. The inbox reader passes `settings.readerFoldQuotes`.
   */
  foldQuotes?: boolean
}) {
  const { t, locale } = useI18n()
  const ref = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(0)

  /**
   * `t` is read through a ref for the same reason `onLinkClick` is: it is a
   * new function on every render of the i18n provider, and the effects below
   * must re-run when the *language* changes, not whenever a parent re-renders.
   * `locale` is the dependency; this is only how the effect reaches the
   * current translator once it has decided to run.
   */
  const tRef = useRef(t)
  tRef.current = t

  /**
   * The click handler is installed on the frame's *document*, once, when the
   * frame loads — and it is never removed, because the document goes away with
   * the frame. So the effect below must not depend on `onLinkClick`: it would
   * re-register the `load` listener on an iframe that has already loaded,
   * `handleLoad` would not run again, and the document would keep the handler
   * built on the first render's closure. `openLinkSafely` closes over `t`,
   * which is rebuilt every render, so switching language with a preview open
   * left the open-link confirmation in the previous one.
   */
  const linkRef = useRef(onLinkClick)
  linkRef.current = onLinkClick

  /** Read by the frame's own scroll listener, for the same reason `linkRef` is. */
  const scrollRef = useRef(onScroll)
  scrollRef.current = onScroll

  /** Read by the frame's own swipe listener, for the same reason `linkRef` is. */
  const dismissRef = useRef(onSwipeDismiss)
  dismissRef.current = onSwipeDismiss

  /**
   * The current answer to "is this message being painted for a dark room",
   * for `handleLoad` — which is registered once and would otherwise close over
   * whatever the first render happened to say.
   */
  const nightRef = useRef(nightFilter)
  nightRef.current = nightFilter

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return
    const handleLoad = () => {
      setLoaded((n) => n + 1)
      const doc = iframe.contentDocument
      if (!doc) return
      const handler = (e: MouseEvent) => {
        const from = e.target as HTMLElement | null
        /*
         * The quoted-history button, first — it is the one control this app
         * puts *inside* the frame, and it works from out here precisely so
         * that nothing has to run in there. `classList.toggle` on the frame's
         * own `<html>` is the whole mechanism; the two labels are already in
         * the markup and the injected stylesheet picks between them, so this
         * neither re-renders React nor rebuilds the document.
         */
        if (from?.closest?.(`.${QUOTE_BTN_CLASS}`)) {
          e.preventDefault()
          doc.documentElement.classList.toggle(QUOTE_OPEN_CLASS)
          return
        }
        const target = from?.closest?.('a[href]') as HTMLAnchorElement | null
        if (!target) return
        e.preventDefault()
        linkRef.current(target.href)
      }
      doc.addEventListener('click', handler)
      /*
       * The message's own scroll, forwarded out.
       *
       * The body scrolls *inside* this frame — the frame itself is a fixed box
       * in the reader's column — so the reader has no other way to know that
       * somebody is reading rather than looking. Its sticky header uses this
       * to shrink. A listener on the document rather than on `contentWindow`
       * because a viewport scroll is dispatched at the Document; passive
       * because nothing here can or should cancel it.
       */
      doc.addEventListener(
        'scroll',
        () => scrollRef.current?.(doc.documentElement?.scrollTop ?? 0),
        { passive: true },
      )
      /*
       * Swipe-to-close, tracked the same way the click and the scroll above
       * are: a listener the *outer* page attaches to the frame's own document
       * via `allow-same-origin`, not a script running inside it. Nothing here
       * executes in the sandboxed frame's own context.
       *
       * `lockAxis`/`resolveSwipe` are the same arithmetic `useSwipe` uses for
       * a list row — reused rather than re-derived so a swipe means the same
       * distance and the same flick speed everywhere in this app. There is no
       * `useSwipe` call here because that hook returns React pointer handlers
       * for a JSX element in *this* document; the gesture happens in the
       * frame's document instead, so only the pure functions are reusable.
       */
      let swipeStart: { x: number; y: number; t: number } | null = null
      let swipeAxis: Axis = 'undecided'
      doc.addEventListener('pointerdown', (e: PointerEvent) => {
        // Mouse excluded for the same reason `useSwipe` excludes it: this
        // frame is also where the reader's text gets selected with a mouse,
        // and a selection drag becoming a swipe would eat that.
        if (e.pointerType === 'mouse') return
        swipeStart = { x: e.clientX, y: e.clientY, t: e.timeStamp }
        swipeAxis = 'undecided'
      })
      doc.addEventListener('pointermove', (e: PointerEvent) => {
        if (!swipeStart) return
        if (swipeAxis === 'undecided') {
          swipeAxis = lockAxis(e.clientX - swipeStart.x, e.clientY - swipeStart.y)
          // Locked vertical: this is a scroll, not a swipe. Let go completely
          // so the rest of the drag is free to scroll the message.
          if (swipeAxis === 'vertical') swipeStart = null
        }
      })
      const endSwipe = (e: PointerEvent) => {
        const from = swipeStart
        swipeStart = null
        if (!from || swipeAxis !== 'horizontal') return
        const width = doc.documentElement?.clientWidth || doc.body?.clientWidth || 0
        if (!width) return
        const result = resolveSwipe(from, { x: e.clientX, y: e.clientY, t: e.timeStamp }, width)
        if (result) dismissRef.current?.()
      }
      doc.addEventListener('pointerup', endSwipe)
      doc.addEventListener('pointercancel', () => {
        swipeStart = null
      })
      // The families are named literally rather than inherited, and the size
      // and leading with them — see `READER_FONT_STACK` for why `inherit`
      // could never have worked across a document boundary and for what this
      // does and does not match on each platform.
      //
      // This sets the app's type as the frame's *default*, not as an
      // override. There is no `!important` and no universal selector: a
      // declaration on `body` reaches every element that does not state a
      // font of its own, and yields to any that does. That is the right way
      // round for a mail reader — a newsletter's own typography is part of
      // what the sender wrote, and a client that overrules it is showing
      // something other than the message.
      //
      // In practice the sender has almost no way to exercise that anyway,
      // and it is worth being exact about which: `electron/sanitizeHtml.ts`
      // strips `<style>` elements outright, and its `ALLOWED_STYLES` list
      // has no `font-family` entry, so a `style="font-family:Arial"` on a
      // `<td>` is gone before the HTML ever reaches this frame. The one
      // channel left open is the legacy `<font face="...">` tag, which the
      // sanitiser does allow; it applies to its own element directly and so
      // beats the inherited `body` rule below. A sender who asks that
      // plainly still gets the face they asked for; everything else — which
      // is nearly everything — lands on the stack above. `font-size` behaves
      // the same way: the sanitiser permits it, so a sender who sets one
      // keeps it, and `1rem` — the app's own body size, at whatever
      // `--text-scale` the user picked — is what the rest of the message
      // reads at.
      //
      // The `margin-inline: auto` run is the fix for the oldest-looking
      // complaint about this app: "only the left half of the window has
      // anything in it". Bulk mail is built as a fixed `<table width="600">`,
      // and a 600px table left-aligned in a reader that is 1474px wide on a
      // 1536px screen paints 52% of the window and leaves the other 48% blank
      // — all of it on the right, because the table hugs the start edge.
      // Centring moves half that emptiness to the other side, which is the
      // difference between a page that looks broken and a page that looks
      // like every other mail client.
      //
      // Only the outermost box is touched, and only through `margin-inline`,
      // which is inert on anything already as wide as its parent: fluid mail
      // and plain text are bit-identical before and after. Sender HTML is not
      // otherwise restyled — there is no safe general rule for it — and
      // `margin-inline` rather than `margin-left/right` so an Arabic message
      // in an RTL window centres the same way (measured: before this, an RTL
      // 600px table pinned to the right and left the blank on the *left*).
      //
      // Two conditions, both load-bearing. `:not(table table)` picks the
      // outer frame at whatever depth the sender buried it — a nested table
      // is positioned by the design around it and must not move. And a
      // declared width is what separates "this is a fixed-width layout" from
      // "this is a small data table in a text mail": the second one belongs
      // where the sender put it, and centring it would be this rule inventing
      // a design decision rather than repairing one. `width="100%"` matches
      // too and is harmless — there is no free margin to distribute.
      const centreOuter =
        'table[width]:not(table table),' +
        'table[style*="width"]:not(table table),' +
        'body>:is(div,center,section,article)[style*="width"]' +
        '{margin-inline:auto}'
      /*
       * The measure — the one rule that changes how a message is *laid out*
       * rather than only how it is coloured.
       *
       * A plain-text mail has no layout of its own, so before this it ran the
       * full width of the frame: 1474px on a 1536px screen is roughly 180
       * Latin characters a line, at which point the eye loses the start of the
       * next one. The app has had one answer to that since it had prose at all
       * (`--reading-max`), and this is that answer carried across the document
       * boundary; `--aev-measure` is written by `writeTheme` because the value
       * depends on which script the message is in.
       *
       * Gated on a class rather than applied outright: `bodyTakesMeasure`
       * refuses any body that brought a layout with it. See its comment.
       */
      const measure = 'html.aev-measure body{max-width:var(--aev-measure);margin-inline:auto}'
      /*
       * The fold's own rules live in this stylesheet rather than in a second
       * one of their own, unlike the palette: this sheet is written once per
       * *document*, and a document is exactly the lifetime of a fold —
       * changing `html` or `foldQuotes` replaces the srcDoc and reloads the
       * frame, so there is nothing here for a toggle to have to un-write.
       *
       * Every value here is a token, reached through the `--aev-*` custom
       * properties `writeTheme` defines on this document's own root. That is
       * the whole trick for a separate document: `var(--surface-2)` in here
       * resolves against *this* root, which has none of the app's properties
       * and never will — the theme cannot cross a document boundary any more
       * than the bundled fonts can (see `READER_FONT_STACK`) — so the values
       * are read out of the app's root and written in. Seven hex literals
       * used to stand in for them, and they were the reason the button only
       * looked right in one theme and had to be rescued by an `invert()`.
       *
       * `display:revert` rather than `block` or `inline`: the hidden run is a
       * `<div>` in an HTML body and a `<span>` inside the `<pre>` of a plain
       * text one, and one keyword restores whichever each of them was.
       */
      const fold =
        `.${QUOTE_CLASS}{display:none}` +
        `html.${QUOTE_OPEN_CLASS} .${QUOTE_CLASS}{display:revert}` +
        `.${QUOTE_BTN_CLASS}{display:block;box-sizing:border-box;width:100%;` +
        'min-height:var(--aev-tap);margin:var(--aev-pad) 0;' +
        'padding:var(--aev-pad-2);border:1px solid var(--aev-line);' +
        'border-radius:var(--aev-radius);background:var(--aev-panel);' +
        'color:var(--aev-ink-2);font:inherit;line-height:1.5;' +
        'text-align:start;cursor:pointer}' +
        `.${QUOTE_BTN_CLASS}:hover{background:var(--aev-panel-hover)}` +
        '.aev-quotehide{display:none}' +
        `html.${QUOTE_OPEN_CLASS} .aev-quoteshow{display:none}` +
        `html.${QUOTE_OPEN_CLASS} .aev-quotehide{display:inline}`
      const style = doc.createElement('style')
      style.textContent =
        'body{margin:0;padding:var(--aev-pad);font-family:' +
        READER_FONT_STACK +
        ';font-size:1rem;line-height:1.65;color:var(--aev-ink,canvastext);' +
        'background:var(--aev-ground,canvas);word-break:break-word}' +
        'img{max-width:100%;height:auto}table{max-width:100%}' +
        centreOuter +
        measure +
        'mark.aev-find{background:var(--aev-mark);color:inherit}' +
        fold
      doc.head?.appendChild(style)

      /*
       * The palette and the measure decision are written here as well as in
       * the effect below, and that is not a duplicate: `useEffect` runs after
       * the browser has had a chance to paint, so leaving this to the effect
       * alone showed one frame of an unthemed document — white, in a dark
       * app, at the exact moment a message opens. `writeTheme` is idempotent
       * and the effect simply overwrites what this wrote.
       */
      doc.documentElement.classList.toggle('aev-measure', bodyTakesMeasure(doc))
      // Recorded as a class rather than recomputed: the palette effect below
      // re-runs on every theme change and on every toggle of the night
      // reading, and walking the body's text again each time to answer a
      // question whose answer cannot have changed would be the find-box
      // mistake in a different place.
      const cjk = bodyIsCjk(doc)
      doc.documentElement.classList.toggle('aev-cjk', cjk)
      writeTheme(doc, readPalette(nightRef.current), cjk)
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [])

  /**
   * The palette, and the sender's own colours on it.
   *
   * ## What this replaces
   *
   * One declaration: `html{filter:invert(1) hue-rotate(180deg) contrast(0.92)
   * brightness(0.94)}`, with `img,video,svg,canvas{filter:invert(1)
   * hue-rotate(180deg)}` un-inverting the media again. It was cheap and it was
   * wrong in a way tuning cannot reach — it does not adapt a message to a dark
   * ground, it photographically negates one. The un-invert put photographs
   * back only because the sanitiser happens to allow no `background-image`
   * (see `ALLOWED_STYLES` in `electron/sanitizeHtml.ts`), so the defence rested
   * on a list in another file; and a PNG with an alpha channel still came out
   * inverted *and* let the negated page show through it. `svg` and `canvas`
   * were named on the rule for tags the sanitiser does not even allow.
   *
   * ## What happens instead
   *
   *   · the ground and the default ink come from the app's own tokens, read
   *     out of its root and written into this document by `writeTheme` — so a
   *     dark reader is dark because the theme says so, not because a filter
   *     turned a white one inside out;
   *   · pictures are not touched at all, by anything, ever;
   *   · a colour the *sender* declared is moved rather than mirrored — same
   *     hue and saturation, a lightness that works on this ground. See
   *     `adjustSenderColours`.
   *
   * ## Why it is still one toggle
   *
   * "Show original colours" is unchanged and now means exactly what it says:
   * the palette goes back to paper (`readPalette`), and every colour this file
   * moved is put back from the value recorded on the element itself, rather
   * than by a second guess at what the sender wrote.
   *
   * `loaded` is in the dependency list because a reload replaces the document
   * this wrote into; `html` because it replaces the elements
   * `adjustSenderColours` recorded its undo values on.
   */
  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.head) return
    const palette = readPalette(nightFilter)
    writeTheme(doc, palette, doc.documentElement.classList.contains('aev-cjk'))
    // Always restore first. The two directions are not symmetrical — going
    // dark records an undo value per element, coming back consumes it — and a
    // pass that adjusted on top of its own output would lighten the same text
    // twice and lose the original after two toggles.
    restoreSenderColours(doc)
    if (palette.night) adjustSenderColours(doc, palette)
  }, [nightFilter, themeKey, loaded, html])

  /**
   * Put the resolved pictures into the document that is already on screen.
   *
   * This is the whole of item 13. What it replaces was a single line at the
   * call site — `setResolvedHtml(resolveRemoteImages(...))` — and the cost of
   * that line was a *new document*: changing `html` changes `srcDoc`, which
   * reloads the frame, which re-parses the sender's markup, re-decodes every
   * picture that had already arrived, loses the reader's place inside the
   * message, and re-runs the fold and the find pass over the whole body. For a
   * change of one attribute per image.
   *
   * The frame is `allow-same-origin`, so the attribute is reachable from out
   * here — the same access the link interception, the fold and the find have
   * always used, and nothing runs *inside* the frame to do it.
   *
   * Both kinds of parked picture are placed by the same walk, because they are
   * the same convention with a different fragment: a remote image the reader
   * (or the policy) asked to load, and an inline `cid:` part that was in the
   * message all along. See `remoteImagePlaceholder.ts`.
   *
   * The fallback is deliberately narrow. "Placed nothing at all when there was
   * something to place" is the honest test for *cannot* — a document that has
   * lost one `<img>` to the sanitiser's empty-anchor filter has not failed,
   * and reporting it would put back the very reload this exists to remove.
   */
  const unplacedRef = useRef(onImagesUnplaced)
  unplacedRef.current = onImagesUnplaced

  useEffect(() => {
    if (!images) return
    const doc = ref.current?.contentDocument
    if (!doc?.body) {
      unplacedRef.current?.()
      return
    }
    const remote = images.remote
    const inline = images.inline
    let expected = 0
    if (remote) {
      for (const value of remote) {
        if (safeImageDataUri(value) ?? images.remoteFallback) expected++
      }
    }
    if (inline) expected += Object.keys(inline).length

    let placed = 0
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? ''
      const index = remoteIndexOfPlaceholder(src)
      if (index !== null) {
        if (!remote || index >= remote.length) continue
        // Validated a second time here rather than trusted from the fetch
        // path, for the reason `resolveRemoteImages` gives: this is the last
        // point before an attacker-influenced value re-enters an
        // already-sanitized document.
        const next = safeImageDataUri(remote[index]) ?? images.remoteFallback
        if (!next) continue
        img.setAttribute('src', next)
        placed++
        continue
      }
      const cid = cidOfPlaceholder(src)
      if (cid === null) continue
      const next = inline ? safeImageDataUri(inline[cid]) : null
      if (next) {
        img.setAttribute('src', next)
        placed++
      } else if (images.inlineSettled) {
        // Every attachment that could be read has been, and this reference
        // matched none of them. Dropping the `src` is exactly what both
        // sanitizers did with every `cid:` image before they were resolvable
        // at all — the failure mode is the old behaviour, silently.
        img.removeAttribute('src')
      }
    }
    if (placed === 0 && expected > 0) unplacedRef.current?.()
  }, [images, loaded, html])

  /**
   * Fold the quoted history, or take a previous fold back out.
   *
   * Done on the frame's *live* document rather than by rewriting the HTML
   * string before it becomes a srcDoc, and that is the safer of the two by
   * some distance: re-parsing a sender's markup and serialising it back would
   * put this file in the business of round-tripping malformed HTML — a stray
   * `<td>` outside a table is silently dropped by any parser, so a message
   * would render differently *because* it had a quote in it. Here the browser
   * parses the sender's bytes exactly once, as it always did, and this only
   * adds a class and a button to nodes that already exist.
   *
   * Runs before the find effect below on purpose: the search has to be able to
   * see the folded region's text nodes and to open the fold when a match lands
   * inside one, and it can only do that if the fold is already there.
   */
  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.body) return
    clearFold(doc)
    if (!foldQuotes) return
    applyFold(doc, {
      show: (n) => tRef.current('inbox.quoteShow', { n }),
      hide: tRef.current('inbox.quoteHide'),
    })
    // `locale` rather than `t`: see `tRef` above.
  }, [foldQuotes, loaded, html, locale])

  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.body) return

    // Clear previous highlights first, or a second search would highlight
    // inside the marks the first one left behind.
    for (const mark of [...doc.querySelectorAll('mark.aev-find')]) {
      const parent = mark.parentNode
      if (!parent) continue
      parent.replaceChild(doc.createTextNode(mark.textContent ?? ''), mark)
      parent.normalize()
    }
    const needle = find.trim().toLowerCase()
    if (needle.length === 0) return

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      // The fold button's own label is this app talking, not the message.
      // Highlighting inside it would mean a search for "12" lit up the words
      // "show the 12 quoted lines" as if the mail had said them.
      if ((node.parentElement as HTMLElement | null)?.closest?.(`.${QUOTE_BTN_CLASS}`)) continue
      if ((node.textContent ?? '').toLowerCase().includes(needle)) targets.push(node as Text)
    }

    let first: HTMLElement | null = null
    for (const text of targets) {
      const value = text.textContent ?? ''
      const fragment = doc.createDocumentFragment()
      let index = 0
      for (;;) {
        const at = value.toLowerCase().indexOf(needle, index)
        if (at < 0) break
        fragment.appendChild(doc.createTextNode(value.slice(index, at)))
        const mark = doc.createElement('mark')
        mark.className = 'aev-find'
        mark.textContent = value.slice(at, at + needle.length)
        fragment.appendChild(mark)
        first ??= mark
        index = at + needle.length
      }
      fragment.appendChild(doc.createTextNode(value.slice(index)))
      text.parentNode?.replaceChild(fragment, text)
    }
    // A hit inside the folded history opens it. The `TreeWalker` above reaches
    // `display: none` text either way — it walks the DOM, not the layout — so
    // without this the search would honestly report a match and then scroll to
    // something nobody can see, which is the worst of both.
    if (first?.closest(`.${QUOTE_CLASS}`)) doc.documentElement.classList.add(QUOTE_OPEN_CLASS)
    first?.scrollIntoView({ block: 'center' })
  }, [find, loaded, html])

  return (
    <iframe
      ref={ref}
      // No `allow-scripts` — the content cannot execute anything regardless
      // of whether the sanitizer upstream has a bug. `allow-same-origin`
      // alone is what lets the effects above reach `contentDocument`.
      sandbox="allow-same-origin"
      srcDoc={html}
      title="message-body"
      className={frameClassName}
    />
  )
}
