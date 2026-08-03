/**
 * Does the formatting toolbar leave the caret somewhere usable?
 *
 * The transforms are easy; the selection afterwards is where these go wrong,
 * and it is the part that decides whether anyone uses the toolbar twice. Bold
 * with nothing selected has to leave the caret *between* the markers so the
 * next keystroke is bold. Bold with a word selected has to leave the word
 * selected so a second click can undo it. Neither is visible in a diff.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-markup-'))
const bundle = path.join(dir, 'markup.mjs')
await build({
  entryPoints: ['src/core/markup.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { applyMarkup } = await import(pathToFileURL(bundle).href)

const mdBundle = path.join(dir, 'markdown.mjs')
await build({
  entryPoints: ['src/core/markdown.ts'],
  bundle: true,
  format: 'esm',
  outfile: mdBundle,
  logLevel: 'error',
})
const { markdownToHtml, forTransport } = await import(pathToFileURL(mdBundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/** Render a result as `text` with the selection marked, so failures read clearly. */
const show = (r) =>
  r.text.slice(0, r.selectionStart) +
  '[' +
  r.text.slice(r.selectionStart, r.selectionEnd) +
  ']' +
  r.text.slice(r.selectionEnd)

const at = (action, text, start, end = start) => applyMarkup(action, text, start, end)

// --- wrapping ---------------------------------------------------------------

let r = at('bold', 'hello world', 6, 11)
check(`bold wraps the selection (${show(r)})`, r.text === 'hello **world**')
check('bold keeps the word selected so a second click can undo it', r.text.slice(r.selectionStart, r.selectionEnd) === 'world')

r = at('bold', 'hello ', 6)
check(`bold with no selection opens a pair (${show(r)})`, r.text === 'hello ****')
check(
  'and leaves the caret between the markers, ready to type',
  r.selectionStart === 8 && r.selectionEnd === 8,
)

r = at('bold', 'hello **world**', 8, 13)
check(`bold on already-bold text unwraps it (${show(r)})`, r.text === 'hello world')
check('and keeps the word selected', r.text.slice(r.selectionStart, r.selectionEnd) === 'world')

r = at('italic', 'make it loud', 8, 12)
check(`italic uses a single marker (${show(r)})`, r.text === 'make it *loud*')

r = at('code', 'run npm test now', 4, 12)
check(`code uses backticks (${show(r)})`, r.text === 'run `npm test` now')

// --- lines ------------------------------------------------------------------

const three = 'one\ntwo\nthree'
r = at('bullet', three, 0, three.length)
check(`bullet prefixes every line (${JSON.stringify(r.text)})`, r.text === '- one\n- two\n- three')

// Selecting the middle of one line still affects the whole line: that is what
// the user is looking at.
r = at('bullet', three, 5, 5)
check('bullet from a caret inside a line prefixes that line', r.text === 'one\n- two\nthree')

r = at('bullet', '- one\n- two', 0, 11)
check(`bullet on an already-bulleted block removes it (${JSON.stringify(r.text)})`, r.text === 'one\ntwo')

r = at('number', three, 0, three.length)
check(`numbered list counts up (${JSON.stringify(r.text)})`, r.text === '1. one\n2. two\n3. three')

r = at('quote', three, 0, three.length)
check('quote prefixes every line', r.text === '> one\n> two\n> three')

r = at('bullet', 'one\n\ntwo', 0, 8)
check(`a blank line is left alone (${JSON.stringify(r.text)})`, r.text === '- one\n\n- two')

// --- links ------------------------------------------------------------------

r = at('link', 'see the docs', 8, 12)
check(`a selected word becomes the label (${show(r)})`, r.text === 'see the [docs](https://)')
check(
  'and the caret lands in the target, which is the half still missing',
  r.text.slice(r.selectionStart, r.selectionEnd) === 'https://',
)

r = at('link', 'https://example.com', 0, 19)
check(
  `a selected URL becomes the target, not the label (${show(r)})`,
  r.text === '[](https://example.com)',
)
check(
  'and the caret lands in the empty label',
  r.selectionStart === 1 && r.selectionEnd === 1,
)

// --- nothing is ever lost ---------------------------------------------------

const sample = 'Dear team,\n\nPlease review the attached.\n\nThanks'
for (const action of ['bold', 'italic', 'code', 'link', 'bullet', 'number', 'quote']) {
  const out = at(action, sample, 12, 18)
  const stripped = out.text.replace(/[*`>\-\[\]()]|\d+\.\s|https:\/\//g, '')
  const original = sample.replace(/[*`>\-\[\]()]|\d+\.\s|https:\/\//g, '')
  check(`${action} does not drop any of the user's own text`, stripped.includes(original.slice(0, 10)))
  check(
    `${action} returns a selection inside the text it produced`,
    out.selectionStart >= 0 &&
      out.selectionEnd >= out.selectionStart &&
      out.selectionEnd <= out.text.length,
  )
}

// --- what the toolbar writes has to actually arrive formatted ---------------
//
// The toolbar without this is a lie: both transports only ever checked
// `bodyFormat === 'html'`, so a markdown body went out as plain text and the
// recipient saw the asterisks.

const html = (md) => markdownToHtml(md)

check('bold becomes bold', html('**loud**').includes('<strong>loud</strong>'))
check('italic becomes italic', html('*soft*').includes('<em>soft</em>'))
check('code becomes code', html('`npm test`').includes('<code>npm test</code>'))
// Template literals here rather than escapes: these inputs are multi-line by
// nature, and `\n` inside a quoted string is exactly the character that got
// mangled when this file was generated.
check(
  'a bulleted list becomes a list',
  /<ul>[\s\S]*<li>one<\/li>[\s\S]*<\/ul>/.test(html(`- one\n- two`)),
)
check('a numbered list becomes an ordered list', html(`1. one\n2. two`).includes('<ol>'))
check('a quote becomes a blockquote', html('> said').includes('<blockquote>'))
check(
  'a link becomes an anchor',
  html('[docs](https://example.com)').includes('<a href="https://example.com">docs</a>'),
)
check('lists are closed', (html(`- one\n\nafter`).match(/<\/ul>/g) || []).length === 1)

// --- escaping: the part that must not be got wrong --------------------------

check(
  'a script tag typed into the body arrives as visible text',
  !html('<script>alert(1)</script>').includes('<script'),
)
check('and its characters survive', html('<script>x</script>').includes('&lt;script&gt;'))
check(
  'markdown cannot reintroduce a tag through a link label',
  !html('[<img src=x onerror=alert(1)>](https://a.b)').includes('<img'),
)
/*
 * The property is "never behind an href", not "the characters never appear".
 *
 * A refused link is rendered as the literal text the user typed — deliberately,
 * because losing content silently is the worse failure — so the string
 * `javascript:` does still show up in the output, as escaped body text. An
 * earlier version of this check asserted the characters were absent and failed
 * on correct behaviour.
 */
const jsLink = html('[click](javascript:alert(1))')
check('a javascript: link never becomes an href', !/href="\s*javascript:/i.test(jsLink))
check('no anchor is produced for it at all', !jsLink.includes('<a '))
check('and its text is kept rather than vanishing', jsLink.includes('click'))
check('a data: link is refused', !html('[x](data:text/html,<b>)').includes('href="data:'))
check('mailto: is allowed', html('[mail](mailto:a@b.c)').includes('href="mailto:a@b.c"'))
check(
  'an ampersand in the body is escaped once, not twice',
  html('Tom & Jerry').includes('Tom &amp; Jerry') && !html('Tom & Jerry').includes('&amp;amp;'),
)
check(
  'text inside code is escaped too',
  html('`<b>`').includes('&lt;b&gt;') && !html('`<b>`').includes('<b>'),
)

// --- the boundary -----------------------------------------------------------

const md = { body: '**hi**', bodyFormat: 'markdown', subject: 's' }
const sent = forTransport(md)
check('a markdown draft is handed over as html', sent.bodyFormat === 'html')
check('and its body is rendered', sent.body.includes('<strong>hi</strong>'))
check('the original draft is not mutated', md.body === '**hi**' && md.bodyFormat === 'markdown')

const plain = { body: '**not markdown**', bodyFormat: 'plain' }
check('a plain draft is handed over untouched', forTransport(plain).body === '**not markdown**')
check('and keeps its format', forTransport(plain).bodyFormat === 'plain')

const alreadyHtml = { body: '<b>x</b>', bodyFormat: 'html' }
check('an html draft is not re-escaped', forTransport(alreadyHtml).body === '<b>x</b>')

// ---------------------------------------------------------------------------

const label = 'the formatting toolbar leaves the caret usable'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
