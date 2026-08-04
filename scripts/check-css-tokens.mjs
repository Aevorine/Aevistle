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
import { readFileSync } from 'node:fs'

const selftest = process.argv.includes('--selftest')
const FILES = ['src/styles/theme.css', 'src/styles/app.css']

let sources = FILES.map((f) => ({ file: f, text: readFileSync(f, 'utf8') }))
if (selftest) {
  sources = sources.map((s) =>
    s.file.endsWith('app.css')
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
 * outside a media query.
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
 */
for (const { file, text } of sources) {
  const clean = stripComments(text)
  const lines = clean.split('\n')
  const byProperty = new Map()
  let depth = 0
  let current = null
  lines.forEach((line, i) => {
    if (depth === 0) {
      const rule = line.match(/^([.#][a-zA-Z0-9_-]+)\s*\{/)
      current = rule ? rule[1] : null
    }
    if (depth === 1 && current) {
      const decl = line.match(/^\s+([a-z-]+)\s*:/)
      if (decl && !decl[1].startsWith('--')) {
        const key = `${current}|${decl[1]}`
        const at = byProperty.get(key) ?? []
        at.push(i + 1)
        byProperty.set(key, at)
      }
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth < 0) depth = 0
  })
  for (const [key, at] of byProperty) {
    if (at.length > 1) {
      const [selector, property] = key.split('|')
      problems.push({
        kind: 'competing-declaration',
        file,
        line: at[0],
        detail: `${selector} sets ${property} on lines ${at.join(', ')}`,
      })
    }
  }
}

for (const p of problems) {
  console.log(`  FAIL  ${p.kind}: ${p.detail}${p.line ? ` (${p.file}:${p.line})` : ` (${p.file})`}`)
}
console.log(`\n  ${defined.size} tokens defined · ${problems.length} problems`)

if (selftest) {
  const sawToken = problems.some((p) => p.detail === '--not-a-real-token')
  const sawDupe = problems.some((p) => p.detail.startsWith('.selftest-dup sets color'))
  if (!sawToken || !sawDupe) {
    console.log(
      `\n  SELFTEST FAILED: undefined token caught=${sawToken}, competing declaration caught=${sawDupe}`,
    )
    process.exit(1)
  }
  console.log('\n  Selftest OK — both injected faults were caught.')
  process.exit(0)
}

if (problems.length > 0) process.exit(1)
console.log('\n  All clear.')
