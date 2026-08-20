/**
 * Mail that contains mathematics, shown as mathematics.
 *
 * Physics and maths reach a mailbox as TeX far more often than as an image: a
 * supervisor writes `$E = mc^2$`, a journal alert carries `\[ \int_0^\infty
 * e^{-x}\,dx = 1 \]`, an assignment quotes `\(\sum_{i=1}^n i\)`. All of it
 * arrives as literal backslashes and dollar signs and is read as noise.
 *
 * ## Why MathML rather than KaTeX's usual HTML output
 *
 * KaTeX normally emits HTML spans positioned by `katex.min.css` and drawn in
 * the KaTeX web fonts — about 1.2 MB of WOFF2 across a dozen faces. That is a
 * problem twice over here. The body renders inside `MessageBodyFrame`'s inert
 * `srcDoc` iframe, where a relative font URL has no base to resolve against and
 * the frame's whole design is that it fetches nothing; and 1.2 MB of fonts in
 * the bundle is paid by every user on every launch for a feature most messages
 * never trigger.
 *
 * `output: 'mathml'` emits a `<math>` element and nothing else. Chromium has
 * shipped MathML Core since 109 — this app runs Electron 43 on the desktop and
 * a modern WebView on Android — so the browser lays it out with the fonts
 * already on the machine. No stylesheet to inject, no fonts to ship, and the
 * markup survives the iframe unchanged.
 *
 * ## Why this is safe to put into an already-sanitized document
 *
 * Because it runs *after* `sanitizeHtml` and adds markup the sanitizer never
 * sees, this is exactly the shape of change that reopens an XSS hole, so the
 * two things that make it safe are both deliberate:
 *
 *   1. **Only text between tags is examined.** The HTML is split on tags and
 *      every odd segment — the tags themselves, with their attributes — is
 *      passed through untouched. A `$` inside `href="…$…"` is not a delimiter
 *      and cannot become one.
 *   2. **KaTeX is called with `trust: false`** (its default), under which
 *      `\href`, `\url`, `\includegraphics` and `\htmlClass` are refused rather
 *      than honoured. What comes back is `<math>` elements and text: no script,
 *      no event handler, no URL of any kind.
 *
 * `strict: false` keeps a message with slightly wrong TeX rendering the parts
 * that are right instead of failing the whole document, and `throwOnError:
 * false` leaves an unparseable fragment as the literal text it arrived as —
 * which is strictly better than what happens today, and never worse.
 *
 * ## Why the import is dynamic
 *
 * KaTeX is ~280 KB of JavaScript. Most mail has no mathematics in it, so
 * `hasMath` is a synchronous string test that costs nothing, and the library is
 * only fetched for a message that actually contains a delimiter. Nothing about
 * opening ordinary mail becomes slower.
 */

/**
 * The four delimiter pairs, longest-first.
 *
 * Order matters and is the whole reason this is one alternation rather than
 * four passes: `$$…$$` has to be tried before `$…$`, or display maths is read
 * as an empty inline formula followed by stray text. `\[`/`\(` are the LaTeX
 * forms that survive a plain-text mail client, which is where most of this
 * actually comes from.
 *
 * The inner patterns are non-greedy and forbid the delimiter itself, so two
 * separate formulas on one line stay two formulas rather than becoming one that
 * swallows the prose between them.
 *
 * The inline `$…$` arm carries two extra conditions, and they are the
 * difference between a feature and a nuisance. `[^\s$]` at both ends means the
 * delimiters must hug their contents — which is what stops
 *
 *     Lunch is $12, dinner is $20.
 *
 * from being read as a formula containing "12, dinner is ". That sentence is
 * ordinary mail, it is *extremely* common, and rendering it as mathematics
 * would make the feature look broken to someone who has never sent a formula
 * in their life. `isMath` below adds the second condition.
 */
const MATH =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g

/**
 * Does this inline fragment look like mathematics rather than money?
 *
 * Applied only to `$…$`; the other three forms are unambiguous, because nobody
 * writes `\[` by accident. A fragment that *starts with a digit* has to carry a
 * TeX signal — a backslash command, a superscript, a subscript or a group — to
 * count. So `$2^{10}$` and `$3\times4$` render, and `$5-$7`, `$100$` and
 * `$20.` do not.
 *
 * Deliberately asymmetric: a fragment starting with a letter is left alone and
 * renders, because `$x$` and `$a_1$` are how variables are written and no
 * currency looks like that. The rule only fires where the ambiguity actually
 * lives.
 */
function isMath(source: string): boolean {
  if (!/^\d/.test(source)) return true
  return /[\\^_{}]/.test(source)
}

/** Tags and text, alternating: even indices are text, odd indices are tags. */
const TAGS = /(<[^>]*>)/

/**
 * Regions whose text is not prose and must not be scanned.
 *
 * `<style>` because a stylesheet is full of braces and the odd `$` in a
 * selector, `<pre>` and `<code>` because someone quoting a shell script that
 * says `$PATH` means `$PATH`. Matched as whole blocks and skipped, rather than
 * tracked with a depth counter — mail HTML is frequently malformed enough that
 * a counter would desynchronise, and skipping is the safe direction to fail in.
 */
const SKIP = /<(style|pre|code)\b[\s\S]*?<\/\1\s*>/gi

/**
 * What marks the hole a skipped block was lifted out of.
 *
 * NUL, because it is the one character that cannot reach here inside a message:
 * `sanitizeHtml` runs first and no valid HTML text node carries one. A
 * placeholder a message could contain would let a mail collide with the
 * bookkeeping and get someone else's `<pre>` pasted into it.
 *
 * Written as an escape rather than typed into the source, deliberately. A raw
 * NUL byte makes this file *binary* to ripgrep, to `git diff`, and to several
 * editors — the whole module stops being greppable and its diffs stop being
 * readable, for a character nobody can see.
 */
const SENTINEL = '\u0000'

/**
 * Is there anything here worth loading KaTeX for?
 *
 * Deliberately cheap and deliberately over-eager: a false positive costs one
 * dynamic import that then changes nothing, and a false negative means a
 * formula silently stays as raw TeX. The same alternation the renderer uses, so
 * the two can never disagree about what counts as maths.
 */
export function hasMath(html: string): boolean {
  if (!html) return false
  // Cheapest possible rejection first: no dollar and no backslash means no TeX,
  // and that is the overwhelming majority of mail.
  if (!html.includes('$') && !html.includes('\\')) return false
  MATH.lastIndex = 0
  for (let m = MATH.exec(html); m; m = MATH.exec(html)) {
    // The first three arms are unambiguous; only the inline `$…$` arm has to
    // clear `isMath`. Answering "yes" for a message whose only candidate is a
    // price would load KaTeX to change nothing.
    if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) return true
    if (isMath(m[4])) return true
  }
  return false
}

/** `&lt;` and friends back to characters — TeX source arrives HTML-escaped. */
function unescapeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    // Ampersand last, or `&amp;lt;` would decode twice and produce `<` from
    // text that was meant to read `&lt;`.
    .replace(/&amp;/g, '&')
}

/**
 * The same document with its TeX rendered.
 *
 * Returns the input unchanged when there is no maths in it or when KaTeX cannot
 * be loaded — a message that renders as it did yesterday is the correct outcome
 * of a failed enhancement, and the alternative (an empty body, or a thrown
 * error inside the reader) is not.
 */
export async function renderMath(html: string): Promise<string> {
  if (!hasMath(html)) return html

  let katex: typeof import('katex')
  try {
    katex = (await import('katex')).default as unknown as typeof import('katex')
  } catch {
    return html
  }

  const one = (source: string, displayMode: boolean): string | null => {
    const tex = unescapeEntities(source).trim()
    if (!tex) return null
    try {
      return katex.renderToString(tex, {
        displayMode,
        output: 'mathml',
        throwOnError: false,
        strict: false,
        // The default, stated rather than assumed: it is the single option that
        // decides whether `\href` and `\includegraphics` can put a URL into the
        // output of a function that runs after sanitizing.
        trust: false,
      })
    } catch {
      // `throwOnError: false` covers TeX errors; this covers KaTeX itself
      // failing, which must leave the message readable rather than blank.
      return null
    }
  }

  const renderText = (text: string): string => {
    MATH.lastIndex = 0
    return text.replace(MATH, (whole, display1, display2, inline1, inline2) => {
      const isDisplay = display1 !== undefined || display2 !== undefined
      const source = display1 ?? display2 ?? inline1 ?? inline2
      // Money stays money — see `isMath`. Only the inline arm can be a price.
      if (inline2 !== undefined && !isMath(inline2)) return whole
      return one(source, isDisplay) ?? whole
    })
  }

  /*
   * Skipped blocks are lifted out and put back by placeholder, rather than
   * being detected during the walk.
   *
   * A `<pre>` can contain tags, so the tag/text split below cannot tell "text
   * inside a pre" from "text between paragraphs" on its own. Removing those
   * regions first makes that distinction unnecessary.
   */
  const skipped: string[] = []
  const withoutSkipped = html.replace(SKIP, (block) => {
    skipped.push(block)
    return `${SENTINEL}SKIP${skipped.length - 1}${SENTINEL}`
  })

  const rendered = withoutSkipped
    .split(TAGS)
    .map((segment, i) => (i % 2 === 1 ? segment : renderText(segment)))
    .join('')

  return rendered.replace(
    new RegExp(`${SENTINEL}SKIP(\\d+)${SENTINEL}`, 'g'),
    (_m, i) => skipped[Number(i)] ?? '',
  )
}
