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

/**
 * The same stack, single-quoted, for the one place it is written inside a
 * double-quoted HTML `style` attribute. Derived rather than typed twice: a
 * literal double quote there would close the attribute at "Times New Roman"
 * and silently drop every family after it.
 */
const READER_FONT_STACK_ATTR = READER_FONT_STACK.replace(/"/g, "'")

/** Wrap a plain-text body so it can go through the same frame the HTML does. */
export function textAsHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // Named, not `font: inherit` — see `READER_FONT_STACK`. The size and
  // leading are spelled out for the same reason the family is, and because
  // `<pre>` carries a UA default (monospace, and the 13px monospace quirk
  // with it) that has to be displaced by a real value rather than by a
  // keyword that resolves to nothing useful in this document.
  return `<pre style="white-space:pre-wrap;word-break:break-word;font-family:${READER_FONT_STACK_ATTR};font-size:16px;line-height:1.65;margin:0">${escaped}</pre>`
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

export function MessageBodyFrame({
  html,
  find,
  onLinkClick,
  frameClassName = 'reader__frame',
  nightFilter = false,
  foldQuotes = false,
}: {
  html: string
  find: string
  onLinkClick: (url: string) => void
  /** Defaults to the inbox reader's own sizing; callers with a tighter budget (the calendar's row preview) pass their own. */
  frameClassName?: string
  /**
   * Sender mail is always built on a white `#fff` body (see the injected
   * style below) regardless of the app's own theme — reasonable in light
   * mode, a lit rectangle in the middle of a dark one. This inverts the
   * whole frame and un-inverts images/video so photos still look right; it
   * cannot know which senders picked colours on purpose, which is why the
   * caller offers a way back to the original per message rather than this
   * component deciding for good.
   *
   * The caller gates this on `settings.readerDarkInvert` *and* on the app
   * actually being in dark mode; this component is told the answer, it does
   * not read either.
   */
  nightFilter?: boolean
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
      // keeps it, and 16px is what the rest of the message reads at.
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
       * The fold's own rules live in this stylesheet rather than in a second
       * one of their own, unlike the night filter: this sheet is written once
       * per *document*, and a document is exactly the lifetime of a fold —
       * changing `html` or `foldQuotes` replaces the srcDoc and reloads the
       * frame, so there is nothing here for a toggle to have to un-write.
       *
       * Literal colours, like the three above them. This is a separate
       * document: `var(--surface-2)` resolves against *its* root, which has no
       * custom properties and never will — the theme cannot cross a document
       * boundary any more than the bundled fonts can (see `READER_FONT_STACK`).
       * The values are the neutral end of the light palette, and the night
       * filter inverts them along with everything else, which is why the
       * button is legible in both without a second rule.
       *
       * `display:revert` rather than `block` or `inline`: the hidden run is a
       * `<div>` in an HTML body and a `<span>` inside the `<pre>` of a plain
       * text one, and one keyword restores whichever each of them was.
       */
      const fold =
        `.${QUOTE_CLASS}{display:none}` +
        `html.${QUOTE_OPEN_CLASS} .${QUOTE_CLASS}{display:revert}` +
        `.${QUOTE_BTN_CLASS}{display:block;box-sizing:border-box;width:100%;` +
        'min-height:48px;margin:16px 0;padding:12px 14px;border:1px solid #d4d4d4;' +
        'border-radius:8px;background:#f4f4f5;color:#3f3f46;font-family:inherit;' +
        'font-size:16px;line-height:1.5;text-align:start;cursor:pointer}' +
        `.${QUOTE_BTN_CLASS}:hover{background:#e8e8ea}` +
        '.aev-quotehide{display:none}' +
        `html.${QUOTE_OPEN_CLASS} .aev-quoteshow{display:none}` +
        `html.${QUOTE_OPEN_CLASS} .aev-quotehide{display:inline}`
      const style = doc.createElement('style')
      style.textContent =
        'body{margin:0;padding:16px;font-family:' +
        READER_FONT_STACK +
        ';font-size:16px;line-height:1.65;color:#111;background:#fff;word-break:break-word}' +
        'img{max-width:100%;height:auto}table{max-width:100%}' +
        centreOuter +
        'mark.aev-find{background:#ffe066;color:#111}' +
        fold
      doc.head?.appendChild(style)
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [])

  /**
   * A second, dedicated `<style>` rather than folding this into the one
   * above: that one is written once, in `handleLoad`, and never again for
   * the life of this document — right for the fixed base rules, wrong for a
   * filter the reader toggles on and off without the frame reloading.
   */
  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.head) return
    let style = doc.getElementById('aev-night') as HTMLStyleElement | null
    if (!nightFilter) {
      style?.remove()
      return
    }
    if (!style) {
      style = doc.createElement('style')
      style.id = 'aev-night'
      doc.head.appendChild(style)
    }
    // Invert the frame, then invert media back — the standard trick for
    // adapting content nobody authored for a dark background. It changes
    // colours the sender chose on purpose too, which is exactly what the
    // "view original colors" toggle this is paired with exists to undo.
    //
    // ## Why no photograph comes out inverted, as a proof rather than a hope
    //
    // The usual objection to this technique is that `filter: invert()` on a
    // container turns every photograph into a negative, and that un-inverting
    // `img` only catches *some* of them because a picture can also arrive as a
    // CSS `background-image`, which no element-level rule can reach.
    //
    // That second channel does not exist here, and it is closed upstream
    // rather than patched over. `electron/sanitizeHtml.ts` allows exactly
    // seven CSS properties (`ALLOWED_STYLES`), and its own comment gives the
    // reason the list is written as an allowlist: every property on it "cannot
    // embed a URL". There is no `background-image`, no `background`
    // shorthand, no `border-image`, no `list-style-image`; `<style>` elements
    // are dropped whole by `nonTextTags`, and no stylesheet can be linked
    // because `link` is not an allowed tag. So the *only* way a picture can be
    // in this frame at all is an `<img>` — every remote one rewritten to a
    // blank data pixel until the reader loads it, every inline one a `data:`
    // URI — and `img` is in the un-invert rule below.
    //
    // `video`, `svg` and `canvas` are on that rule too and are not in the
    // sanitiser's `ALLOWED_TAGS`, so they cannot appear. They stay listed
    // because this frame is also handed the app's own scheduled-draft HTML,
    // and a rule that quietly depended on the mail allowlist for a body that
    // did not come through it would be a trap for whoever widens either.
    //
    // ## Why the invert is inside the frame and not on the frame
    //
    // Because `filter` on the `<iframe>` element would invert the app's own
    // chrome around it as well, and — the part that matters — it would be
    // applied *outside* the document, where no rule of ours can reach in to
    // put the pictures back. Inside, `html` and `img` are two selectors in one
    // cascade and the second undoes the first exactly.
    //
    // `contrast(0.92) brightness(0.94)` after the invert, on the frame only
    // (not the media rule): a plain white-background/#111-text message —
    // most of them — inverts to pure #000 on #eee, ~18:1 contrast. The rest
    // of this app's dark theme was deliberately backed off from ~15-16:1 to
    // ~12-13:1 (see theme.css) because that flatter black-on-white extreme
    // reads as glare over a longer read. This nudges the same pair to
    // ~13.8:1 — inside that tuned range — without touching the mechanism.
    style.textContent =
      'html{filter:invert(1) hue-rotate(180deg) contrast(0.92) brightness(0.94)}' +
      'img,video,svg,canvas{filter:invert(1) hue-rotate(180deg)}'
  }, [nightFilter, loaded])

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
