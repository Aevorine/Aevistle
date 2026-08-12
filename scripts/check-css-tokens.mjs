/**
 * Every `var(--x)` in the stylesheets has to resolve to something.
 *
 * A CSS custom property that was never defined does not warn, does not fall
 * back, and does not fail a build. The browser throws the whole declaration
 * away and the page carries on looking almost right. Five of them were live in
 * this app at once:
 *
 *   - `--surface-0` in `:focus-visible`, so the outer half of the focus ring
 *     had never once been painted, on any control, in either theme;
 *   - `--surface-0` and `--border-1` in `.settingsnav`, so the sticky section
 *     bar had no background and cards scrolled through the text of it;
 *   - `--border-1` in `.shortcuts__keys` and `.senddetails`, so two borders
 *     were simply absent;
 *   - `--fs-sm` in `.chiprow__label`, so that label never got smaller.
 *
 * Every one of those is a typo for a token that does exist. None of them was
 * visible in a screenshot unless you already knew to look.
 *
 * Also flagged: a selector defined twice at the same specificity in the same
 * file. That is not always wrong, but `.swatch` was declared once as a 12px
 * legend square and once as a 30px accent circle, and since both matched every
 * `.swatch` in the app the second silently won — the calendar legend rendered
 * as five large circles nobody had asked for.
 *
 * `--selftest` injects both faults and requires this to go red.
 */
import { allStylesheets, readStylesheets } from './lib/stylesheets.mjs'

const selftest = process.argv.includes('--selftest')
/* Computed, not spelled. `app.css` was split into `app/*.css` this round and
   this list still said `src/styles/app.css` — so the check went on reporting
   "all clear" against a file that had become twenty @import lines. See
   lib/stylesheets.mjs. */
const FILES = allStylesheets()

let sources = readStylesheets(FILES)
if (selftest) {
  sources = sources.map((s) =>
    s.file.endsWith('01-base.css')
      ? {
          ...s,
          text: [
            s.text,
            '.selftest-a {',
            '  color: var(--not-a-real-token);',
            '}',
            '.selftest-dup {',
            '  color: red;',
            '}',
            '.selftest-dup {',
            '  color: blue;',
            '}',
            /* The two shapes the old line-matching scan could not see at all.
               Injected here so the repair stays proven rather than remembered:
               a compound, grouped, brace-on-the-next-line selector, and a
               collision that only exists inside a media block. If either of
               these stops being caught, this file has regressed to what it
               was, and `--selftest` says so instead of printing "all clear".
               See the header of the competing-declaration scan below. */
            '.selftest-outer .selftest-inner,',
            '.selftest-other',
            '{',
            '  padding: 1px;',
            '}',
            '.selftest-outer .selftest-inner {',
            '  padding: 2px;',
            '}',
            '@media (min-width: 1px) {',
            '  .selftest-media { top: 1px; }',
            '  .selftest-media { top: 2px; }',
            '}',
            /* And the control for it: the *same* selector and property in a
               different media context is not a collision, and must not be
               reported. A scan that flagged this would be unusable on
               17-phone.css and 26-tablet.css, which exist to override. */
            '@media (min-width: 2px) {',
            '  .selftest-media { top: 3px; }',
            '}',
            '',
          ].join('\n'),
        }
      : s,
  )
}

/**
 * Blank out comments: a token named in prose is not a token in use.
 *
 * The newlines are kept. Deleting them outright shifted every line number
 * after the first comment, and this file reports line numbers — a checker that
 * points at the wrong line is worse than one that points at none.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))

const defined = new Set()
for (const { text } of sources) {
  for (const m of stripComments(text).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1])
}

const problems = []

for (const { file, text } of sources) {
  const clean = stripComments(text)
  const lines = clean.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
      // `var(--x, fallback)` is deliberate and safe — the fallback is the
      // definition for that use.
      if (m[2] === ',') continue
      if (!defined.has(m[1])) {
        problems.push({ kind: 'undefined-token', file, line: i + 1, detail: m[1] })
      }
    }
  })
}

/**
 * The same selector setting the same property twice, at the same specificity,
 * in the same at-rule context.
 *
 * Declaring a selector twice is ordinary CSS and often deliberate — a base
 * rule and a later addition that sets different properties is fine. What is
 * never fine is two rules *competing* for one property, because then one of
 * them is dead code that reads exactly like live code. `.swatch` was declared
 * as a 12px legend square and as a 30px accent circle, both setting `width`,
 * `height` and `border-radius`; the second won everywhere, including on the
 * calendar legend it was never meant to touch. The same shape appeared once
 * before as three `min-height` rules stacked on one selector, two of which had
 * been unreachable the whole time.
 *
 * ---------------------------------------------------------------------------
 * What this used to reach, and did not
 *
 * The first version of this scan was two lines of regex and both were wrong in
 * a way that made it look like it was working:
 *
 *   `line.match(/^([.#][a-zA-Z0-9_-]+)\s*\{/)`
 *       One class or one id, alone, with its brace on the same line, starting
 *       at column 0. So `.job .job__name {`, `.card,\n.panel {`,
 *       `[data-style="runecircuit"] .chip {`, `html, body, #root {` and every
 *       selector whose `{` sat on the next line were all invisible to it. The
 *       app's stylesheets are mostly compound and grouped selectors, so this
 *       was checking a minority of the rules in the files it read.
 *
 *   `if (depth === 0)`
 *       A rule only counted if it was at the top level of the file, which
 *       exempted the contents of every `@media` block — 30 of them across the
 *       app, including the whole of `26-tablet.css` and `17-phone.css`, which
 *       are nothing but media blocks. The responsive rules, which is where two
 *       people editing the same breakpoint actually collide, were the part it
 *       could not see at all.
 *
 * Both are fixed by walking the file with a brace/string/comment-aware scanner
 * instead of matching lines, which is what the code below is.
 *
 * ---------------------------------------------------------------------------
 * Three deliberate choices in what counts as a collision
 *
 *   Context, not depth. A rule inside `@media (max-width: 599.98px)` and the
 *   same rule inside `@media (min-width: 600px)` are not competing — they can
 *   never both apply. So the key includes the *stack of at-rule preludes* a
 *   rule sits under, and only rules under the identical stack are compared.
 *   A rule at the top level and the same rule inside a media block are
 *   likewise different keys: the media rule is an override by design.
 *
 *   Per selector, not per selector list. `.a, .b { color: red }` followed by
 *   `.b { color: blue }` leaves the first declaration dead on `.b`, and
 *   comparing the whole list as one string would miss it. Each comma-separated
 *   selector is keyed on its own.
 *
 *   Identical text only. `.a` and `.card .a` are different keys and are never
 *   compared, which is the cheap way to require identical specificity without
 *   computing specificity: two rules whose selector text is character-for-
 *   character the same cannot have different specificity, and that is exactly
 *   the case where the later one silently kills the earlier one.
 *
 * What it still cannot reach, stated rather than left to be discovered:
 * shorthand/longhand pairs. `.x { margin: 0 }` and a later `.x { margin-top:
 * 4px }` do interact, and this compares property *names*, so it sees two
 * different properties and says nothing. Teaching it the shorthand table would
 * also make `padding` + `padding-left` — a completely ordinary and correct
 * pattern — a failure, so the blind spot is kept on purpose.
 */

/** Collapse whitespace and normalise quotes so two spellings of one selector key alike. */
const normaliseSelector = (s) =>
  s.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').replace(/'/g, '"').trim()

/**
 * Walk one stylesheet and return every declaration, with the selector and the
 * at-rule context it sits in.
 *
 * A character scanner rather than a line matcher, for the reason in the header
 * above: this file's rules are grouped and compound and their braces are not
 * where a regex expects them. Strings are tracked so a `{` inside
 * `content: "{"` does not open a block; comments are already blanked by
 * `stripComments` before this sees the text, and the blanking preserves
 * newlines so the line numbers this reports are the real ones.
 */
function scanRules(text) {
  const out = []
  const stack = [] // { kind: 'at' | 'rule', prelude, selectors }
  let buf = ''
  let line = 1
  let quote = null

  const inRule = () => stack.length > 0 && stack[stack.length - 1].kind === 'rule'
  const contextOf = () =>
    stack
      .filter((f) => f.kind === 'at')
      .map((f) => f.prelude)
      .join(' > ')

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') line += 1

    if (quote) {
      if (ch === '\\') { buf += ch + (text[i + 1] ?? ''); i += 1; continue }
      if (ch === quote) quote = null
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue }

    if (ch === '{') {
      const prelude = buf.trim()
      buf = ''
      if (prelude.startsWith('@')) {
        // `@media`, `@supports`, `@layer`, `@keyframes` — a context, not a rule.
        stack.push({ kind: 'at', prelude: normaliseSelector(prelude) })
      } else {
        stack.push({
          kind: 'rule',
          selectors: prelude.split(',').map(normaliseSelector).filter(Boolean),
          context: contextOf(),
        })
      }
      continue
    }
    if (ch === '}') {
      buf = ''
      stack.pop()
      continue
    }
    if (ch === ';') {
      // A declaration ends here — or an `@import`/`@charset` at the top level,
      // which has no colon-property shape and falls out of the match below.
      if (inRule()) {
        const decl = /^\s*([a-zA-Z-]+)\s*:/.exec(buf)
        if (decl && !decl[1].startsWith('--')) {
          const frame = stack[stack.length - 1]
          for (const sel of frame.selectors) {
            out.push({ selector: sel, property: decl[1], context: frame.context, line })
          }
        }
      }
      buf = ''
      continue
    }
    buf += ch
  }
  return out
}

/**
 * Collisions that already existed when the two bugs above were fixed.
 *
 * Every one of these was reported the first time the repaired scan ran; none
 * of them was introduced by the repair. They are listed rather than silenced
 * so that the gate fails on the thirty-first, and so that "we know about these"
 * is a fact in the file instead of a memory.
 *
 * Format: `file|context|selector|property`, exactly as the key is built below,
 * plus a note saying what it is. Delete an entry when the collision is fixed —
 * a baseline entry that no longer matches anything is reported as STALE and
 * fails this check, because a baseline nobody prunes is how a repaired gate
 * goes back to sleep.
 */
const BASELINE = new Map([
  /* Both are the same shape and both are deliberate: `.input, .textarea,
     .select` sets one base for the three controls and `.textarea` alone
     refines two of its values, at identical specificity, later in the file.
     The comment at 04-forms.css:250 states the second half of the pair
     explicitly ("`.textarea` below already overrides it to
     `--leading-relaxed`, which is right"), which is the evidence that this is
     a decision rather than a collision.

     Baselined rather than exempted by a rule change. "A group sets a default
     and one member refines it" is not distinguishable from "someone wrote the
     same rule twice" without reading the intent, and the whole reason this
     check exists is that `.swatch` looked exactly like the first and was the
     second. Two entries is a short enough list to defend one by one. */
  [
    'src/styles/app/04-forms.css||.textarea|min-height',
    'deliberate: the .input/.textarea/.select group sets --control-h as a floor; a textarea holds prose and needs 128px.',
  ],
  [
    'src/styles/app/04-forms.css||.textarea|line-height',
    'deliberate: the group sets --leading-tight so single-line controls measure exactly --control-h; a textarea wants --leading-relaxed. Stated at 04-forms.css:250.',
  ],
])

for (const { file, text } of sources) {
  const byKey = new Map()
  for (const d of scanRules(stripComments(text))) {
    const key = `${d.selector}|${d.property}|${d.context}`
    const at = byKey.get(key) ?? { lines: [], d }
    at.lines.push(d.line)
    byKey.set(key, at)
  }
  for (const [, { lines, d }] of byKey) {
    if (lines.length < 2) continue
    const where = d.context ? ` inside ${d.context}` : ''
    problems.push({
      kind: 'competing-declaration',
      file,
      line: lines[0],
      baselineKey: `${file.replace(/\\/g, '/')}|${d.context}|${d.selector}|${d.property}`,
      detail: `${d.selector} sets ${d.property} on lines ${lines.join(', ')}${where}`,
    })
  }
}

/* Split the problems into the ones the baseline already accounts for and the
   ones it does not. A baselined problem is printed, so it never becomes
   invisible, but it does not fail the run. */
const seenBaselineKeys = new Set()
const live = []
const baselined = []
for (const p of problems) {
  if (p.baselineKey && BASELINE.has(p.baselineKey)) {
    seenBaselineKeys.add(p.baselineKey)
    baselined.push(p)
  } else {
    live.push(p)
  }
}
const stale = [...BASELINE.keys()].filter((k) => !seenBaselineKeys.has(k))

for (const p of live) {
  console.log(`  FAIL  ${p.kind}: ${p.detail}${p.line ? ` (${p.file}:${p.line})` : ` (${p.file})`}`)
}
if (baselined.length > 0) {
  console.log(`\n  ${baselined.length} known, baselined collision(s) — not new, still wrong:`)
  for (const p of baselined) {
    console.log(`    base  ${p.detail} (${p.file}:${p.line})`)
    console.log(`          ${BASELINE.get(p.baselineKey)}`)
  }
}
console.log(
  `\n  ${defined.size} tokens defined · ${live.length} problem(s)` +
    (baselined.length ? ` · ${baselined.length} baselined` : ''),
)

if (selftest) {
  const saw = (needle) => problems.some((p) => p.detail.startsWith(needle))
  const checks = {
    'undefined token': problems.some((p) => p.detail === '--not-a-real-token'),
    'plain duplicate': saw('.selftest-dup sets color'),
    'compound/grouped selector': saw('.selftest-outer .selftest-inner sets padding'),
    'collision inside @media': saw('.selftest-media sets top'),
  }
  // The control: `.selftest-media` also appears under a *second* media query,
  // and that pair must NOT be reported. Counted rather than merely absent,
  // because "one report" and "two reports" are the difference between the
  // context key working and it being ignored.
  const mediaHits = problems.filter((p) => p.detail.startsWith('.selftest-media sets top')).length
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  if (failed.length > 0 || mediaHits !== 1) {
    console.log('\n  SELFTEST FAILED:')
    for (const [name, ok] of Object.entries(checks)) console.log(`    ${ok ? 'caught' : 'MISSED'}  ${name}`)
    if (mediaHits !== 1) {
      console.log(
        `    MISSED  media-context isolation — expected exactly 1 report for .selftest-media, got ${mediaHits}` +
          (mediaHits > 1 ? ' (two different @media blocks were compared as one context)' : ''),
      )
    }
    process.exit(1)
  }
  console.log('\n  Selftest OK — all four injected faults were caught, and the media-context control was not.')
  process.exit(0)
}

if (stale.length > 0) {
  console.log(`\n  ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} no longer match anything:`)
  for (const k of stale) console.log(`    STALE  ${k}`)
  console.log(
    '\n  Someone fixed these — thank you. Delete the matching line(s) from BASELINE in\n' +
      '  scripts/check-css-tokens.mjs and this goes green. A baseline that is never pruned\n' +
      '  is a list of defects the gate has agreed to stop noticing.',
  )
}

if (live.length > 0 || stale.length > 0) process.exit(1)
console.log('\n  All clear.')
