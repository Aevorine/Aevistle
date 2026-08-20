/**
 * Formulas in mail actually become formulas — `npm run check:math`.
 *
 * The module under test runs *after* `sanitizeHtml` and puts new markup into a
 * document that has already been cleaned, which is the one place in this app
 * where a well-meaning enhancement can reopen an XSS hole. So this does not
 * grep the source: it builds `src/core/mail/math.ts` and runs it, and every
 * assertion below is either "the maths rendered" or "the thing that must never
 * happen did not".
 *
 * Three groups:
 *
 *   1. **It works.** All four delimiter forms render, display and inline are
 *      distinguished, and the output is MathML — because MathML is what makes
 *      this work inside `MessageBodyFrame`'s inert `srcDoc` iframe with no
 *      stylesheet and no web fonts. A change to KaTeX's default HTML output
 *      would render nothing visible in there and would look like a styling bug
 *      months later.
 *
 *   2. **It is safe.** Tags and attributes are never scanned, so a `$` inside
 *      an `href` cannot start a formula; `\href`, `\url` and `\includegraphics`
 *      are refused by `trust: false`; and no `<script>`, `javascript:` or event
 *      handler may appear in the output for any input.
 *
 *   3. **It leaves everything else alone.** A message with no maths comes back
 *      byte-identical — the reader falls back to the untouched string on that
 *      basis. `$PATH` inside `<code>` stays `$PATH`; a shell script quoted in a
 *      mail is not an equation.
 *
 * `--selftest` disables the tag-skipping and requires this to go red, which is
 * the proof that group 2 is measuring something.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const selftest = process.argv.includes('--selftest')

let failed = 0
let checked = 0
const check = (what, ok, detail = '') => {
  checked++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// --- build the module under test -------------------------------------------

/*
 * Built inside `node_modules/`, not in the OS temp directory.
 *
 * The module dynamically imports `katex`, and a bundle sitting outside this
 * checkout resolves that against the temp directory's (nonexistent)
 * `node_modules` — the import fails, `renderMath` returns the input unchanged
 * exactly as it is designed to, and every assertion in group 1 goes red for a
 * reason that has nothing to do with the code. `node_modules` is already
 * ignored by git and by every tool here, so nothing else has to know.
 */
const out = join(root, 'node_modules', '.aevistle-math')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
let source = readFileSync(join(root, 'src/core/mail/math.ts'), 'utf8')

if (selftest) {
  // Scan the tags too. A `$` in an attribute then becomes a delimiter, which is
  // precisely the hole group 2 exists to keep shut.
  source = source.replace('(i % 2 === 1 ? segment : renderText(segment))', 'renderText(segment)')
}
const entry = join(out, 'math.ts')
writeFileSync(entry, source)

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${entry}"`,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile="${join(out, 'math.mjs')}"`,
      // Left as a real dynamic import so the test exercises the same lazy load
      // the app does, rather than a copy inlined at build time.
      '--external:katex',
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { hasMath, renderMath } = await import(pathToFileURL(join(out, 'math.mjs')).href)

// --- 1. it works ------------------------------------------------------------

console.log('\n  Formulas render\n')

const inline = await renderMath('<p>Einstein said $E = mc^2$ once.</p>')
check('inline $…$ renders', inline.includes('<math') && !inline.includes('$E = mc^2$'))
check(
  'the output is MathML, not KaTeX HTML',
  inline.includes('<math') && !inline.includes('class="katex-html"'),
  // The iframe has no stylesheet and no web fonts; KaTeX's HTML output is
  // invisible in there, and would look like a CSS bug rather than a mode change.
  'MathML is what survives the inert srcDoc frame',
)
check('the surrounding prose is kept', inline.includes('Einstein said') && inline.includes('once.'))

const display = await renderMath('<p>$$\\int_0^1 x\\,dx = \\frac{1}{2}$$</p>')
check('display $$…$$ renders', display.includes('<math'))
check(
  'display mode is marked as display',
  display.includes('display="block"'),
  display.includes('display="block"')
    ? ''
    : display.includes('<math')
      ? 'rendered, but inline'
      : 'did not render at all',
)

check('\\[…\\] renders', (await renderMath('<p>\\[a^2+b^2=c^2\\]</p>')).includes('<math'))
check('\\(…\\) renders', (await renderMath('<p>\\(a^2\\)</p>')).includes('<math'))

check(
  'two formulas on one line stay two',
  ((await renderMath('<p>$a$ and $b$</p>')).match(/<math/g) ?? []).length === 2,
)
check(
  'HTML-escaped TeX is decoded before rendering',
  (await renderMath('<p>$a &lt; b$</p>')).includes('<math'),
  'TeX arrives escaped; a literal &lt; is not valid input to KaTeX',
)
check(
  'broken TeX leaves the message readable',
  typeof (await renderMath('<p>$\\frac{1}{$</p>')) === 'string',
)

// --- 2. it is safe ----------------------------------------------------------

console.log('\n  Nothing new becomes markup\n')

const inAttr = await renderMath('<a href="https://example.com/?a=$x$&b=1">link</a>')
check(
  'a $…$ inside an attribute is not a formula',
  !inAttr.includes('<math') && inAttr.includes('href="https://example.com/?a=$x$&b=1"'),
  'tags are passed through untouched; only text between them is scanned',
)

/*
 * Only the *tags* are inspected, not the text between them.
 *
 * With `throwOnError: false`, a refused `\href` is rendered as its own source
 * — so the characters `javascript:` genuinely do appear in the output, one
 * `<mi>` per letter, as something to look at. That is text, and text is inert.
 * A check that searched the whole string would go red for a rendering that is
 * exactly correct, and the way to make it green again would be to weaken it.
 * What actually matters is whether an *attribute* was created that can execute
 * or navigate, and that can only live inside a tag.
 */
const dangerousTags = (html) =>
  (html.match(/<[^>]*>/g) ?? []).filter((tag) =>
    /\son\w+\s*=|javascript:|\ssrc\s*=|\shref\s*=|<script/i.test(tag),
  )

/*
 * What the output has that the input did not.
 *
 * Two of the inputs below carry a raw `<script>` and an `<img onerror>` of
 * their own. Those cannot actually reach this module — `sanitizeHtml` runs
 * first and removes them — but they belong in the list anyway, as the
 * "suppose one did" case. What must be true is not "the output is clean" (it
 * cannot be, the caller handed us that markup) but "we introduced nothing".
 * Asserting the stronger property would fail on inputs this module is not
 * responsible for, and the only way to make it pass would be to stop testing
 * them.
 */
const introduced = (before, after) => {
  const had = new Set(dangerousTags(before))
  return dangerousTags(after).filter((tag) => !had.has(tag))
}

const hostile = [
  '<p>$\\href{javascript:alert(1)}{click}$</p>',
  '<p>$\\url{javascript:alert(1)}$</p>',
  '<p>$\\includegraphics{http://x/y.png}$</p>',
  '<p>$<script>alert(1)</script>$</p>',
  '<p>$\\text{<img src=x onerror=alert(1)>}$</p>',
  '<p>$\\htmlClass{x onmouseover=alert(1)}{y}$</p>',
  '<p>$\\htmlStyle{background:url(javascript:alert(1))}{y}$</p>',
]
for (const input of hostile) {
  const added = introduced(input, await renderMath(input))
  check(
    `no executable attribute is introduced by: ${input.slice(3, 45)}…`,
    added.length === 0,
    added.length ? `introduced ${added.join(' ')}` : '',
  )
}

// --- 3. everything else is left alone ---------------------------------------

console.log('\n  Ordinary mail is untouched\n')

/*
 * Prices, which is the case that decides whether this feature is a nuisance.
 *
 * "Lunch is $12, dinner is $20." is a sentence a mail client sees constantly,
 * and a naive `$…$` rule reads it as a formula containing "12, dinner is ".
 * Someone who has never written a formula in their life would see their mail
 * start rendering wrongly and have no idea why. Two rules stop it: the
 * delimiters must hug their contents, and a fragment starting with a digit has
 * to carry a TeX signal.
 */
const plain = '<p>Lunch is $12, dinner is $20.</p><div>No maths here.</div>'
check('a message with no formulas comes back identical', (await renderMath(plain)) === plain)
check('prices are not read as formulas', !hasMath(plain))
for (const money of ['I paid $5 and $7 today.', 'It is $100 or $250.', 'Between $5-$7.']) {
  check(`money stays money: ${money}`, (await renderMath(`<p>${money}</p>`)) === `<p>${money}</p>`)
}
check(
  'a formula that starts with a digit still renders when it is one',
  (await renderMath('<p>$2^{10} = 1024$</p>')).includes('<math'),
  'the digit rule must not cost real mathematics',
)
check('hasMath says no to prose', !hasMath('<p>Hello, nothing here.</p>'))
check('hasMath says yes to a formula', hasMath('<p>$x$</p>'))

const code = '<pre>export PATH=$PATH:/opt/bin\necho $HOME</pre>'
check('shell inside <pre> is not read as maths', (await renderMath(code)) === code)
const codeTag = '<code>$a$ and $b$</code>'
check('<code> is not read as maths', (await renderMath(codeTag)) === codeTag)
check(
  'a skipped block is restored exactly once',
  (await renderMath(`<p>$x$</p>${code}<p>$y$</p>`)).includes('export PATH=$PATH:/opt/bin'),
)

// --- verdict ----------------------------------------------------------------

const label = 'mail that contains mathematics shows mathematics'

if (selftest) {
  console.log(`\n  ${label}\n  ${checked} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: scanning inside tags was not caught.\n')
    process.exit(1)
  }
  console.log('  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

console.log(`\n  ${label}\n  ${checked} checks${failed ? `, ${failed} failed` : ''}\n`)
if (failed === 0) console.log('  All clear.\n')
process.exit(failed === 0 ? 0 : 1)
