/**
 * A custom property must not hold CSS this app's oldest engine cannot parse.
 *
 * ## The defect this exists because of
 *
 * Twice now, a modern CSS feature has been written into this stylesheet, worked
 * perfectly on every machine it was developed on, and silently done nothing on
 * the phone it was written for.
 *
 *   - `:has()` is Chromium 105. Thirty rules keyed off it decided the height of
 *     the compose message box; on a device without it the box came out at 128px
 *     instead of 475px. See `components/ui.tsx`'s note on `variant`.
 *   - `color-mix()` is Chromium 111. It defines the Home hero's morning and
 *     evening band colour; on a device without it the band stopped painting
 *     altogether and the white text landed on the app's own near-white
 *     background at 1.08:1. That is the 晚上好…看不清 report.
 *
 * `minSdkVersion` is 24 (Android 7.0), and a System WebView that has never been
 * updated on such a device is far below either number.
 *
 * ## Why this checks custom properties specifically
 *
 * Because that is the case where the usual fallback does not work, and where
 * the failure is destructive rather than cosmetic.
 *
 * An ordinary declaration the engine cannot parse is **dropped**, and the
 * cascade falls back to whatever was set before it. Writing
 *
 *     background: var(--surface-1);
 *     background: color-mix(in srgb, var(--accent) 20%, var(--surface-1));
 *
 * is therefore correct and complete: old engines keep the first line.
 *
 * A **custom property** does not fail that way. Custom properties accept any
 * syntactically valid token sequence, so
 *
 *     --hero-bg: color-mix(in srgb, var(--accent) 90%, black);
 *
 * is stored happily by an engine that has never heard of `color-mix()`. The
 * failure lands downstream, at `background: var(--hero-bg)`, as "invalid at
 * computed-value time" — and IACVT does **not** fall back to an earlier
 * declaration. The property becomes `unset`, so a background becomes
 * `transparent` and a `box-shadow` becomes `none`.
 *
 * So the two-declaration trick is not merely insufficient for a custom
 * property, it is actively misleading: the plain value written above it is
 * overwritten and gone before the failure ever happens.
 *
 * `@supports` is the only mechanism that decides this correctly, because it is
 * the only one evaluated *before* the value is stored. Hence the rule below.
 *
 * ## What is asserted
 *
 * Every declaration of a custom property whose value contains one of the
 * modern-CSS functions listed in `GUARDED` must either sit inside an
 * `@supports` block, or have a fallback declaration of the same property inside
 * an `@supports not (…)` block somewhere in the stylesheet.
 *
 * Ordinary declarations are not checked. They degrade safely by construction,
 * and demanding a hand-written fallback for all ~96 of them would be noise that
 * trains people to ignore this script — which is the failure mode
 * `lib/stylesheets.mjs` records for the checks that came before it.
 *
 * Run by `npm run check:css-fallbacks`. Exit code 1 if anything needs
 * attention.
 */

import { readStylesheets } from './lib/stylesheets.mjs'

/**
 * The functions an old WebView cannot parse, with the Chromium version each
 * arrived in — quoted in the failure message so the reader can weigh it against
 * `minSdkVersion` themselves rather than taking this file's word for it.
 */
const GUARDED = [
  { fn: 'color-mix(', since: 'Chromium 111' },
  { fn: 'oklch(', since: 'Chromium 111' },
  { fn: 'oklab(', since: 'Chromium 111' },
  { fn: 'lab(', since: 'Chromium 111' },
  { fn: 'lch(', since: 'Chromium 111' },
  { fn: 'light-dark(', since: 'Chromium 123' },
  /* `rgb(from …)` and friends — relative colour syntax, Chromium 119. Matched
     on the `from` keyword rather than the function name, since bare `rgb()` is
     as old as CSS itself. */
  { fn: 'from var(', since: 'Chromium 119 (relative colour syntax)' },
]

/** Strip comments so a documented example inside one is never read as code. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Walk the text tracking brace depth, recording which `@supports` blocks are
 * open at each point.
 *
 * A real parser would be better and is not worth it here: the question is only
 * "is this declaration lexically inside an @supports block", which brace
 * counting answers exactly. Strings and comments are the usual reason that
 * argument fails — comments are removed above, and no value in these
 * stylesheets contains an unbalanced brace inside a string.
 */
function scan(css) {
  const declarations = []
  /** Open blocks, innermost last. `null` for anything that is not `@supports`. */
  const stack = []
  let i = 0
  let chunkStart = 0

  const flushDeclarations = (upTo) => {
    const text = css.slice(chunkStart, upTo)
    for (const raw of text.split(';')) {
      const decl = raw.trim()
      if (!decl.startsWith('--')) continue
      const colon = decl.indexOf(':')
      if (colon === -1) continue
      declarations.push({
        prop: decl.slice(0, colon).trim(),
        value: decl.slice(colon + 1).trim(),
        supports: stack.filter(Boolean),
        at: css.slice(0, upTo).split('\n').length,
      })
    }
  }

  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      flushDeclarations(i)
      // The prelude is everything since the last brace or semicolon.
      const prelude = css.slice(chunkStart, i)
      const lastBreak = Math.max(prelude.lastIndexOf(';'), 0)
      const selector = prelude.slice(lastBreak).trim()
      stack.push(selector.startsWith('@supports') ? selector : null)
      chunkStart = i + 1
    } else if (ch === '}') {
      flushDeclarations(i)
      stack.pop()
      chunkStart = i + 1
    }
    i += 1
  }
  return declarations
}

const sheets = readStylesheets()
const offenders = []
/** Custom properties given a plain value inside an `@supports not (…)` block. */
const covered = new Set()

const scanned = sheets.map(({ file, text }) => ({ file, decls: scan(stripComments(text)) }))

for (const { decls } of scanned) {
  for (const decl of decls) {
    const inNegated = decl.supports.some((s) => /@supports\s+not\b/.test(s))
    const guarded = GUARDED.find((g) => decl.value.includes(g.fn))
    if (inNegated && !guarded) covered.add(decl.prop)
  }
}

for (const { file, decls } of scanned) {
  for (const decl of decls) {
    const guarded = GUARDED.find((g) => decl.value.includes(g.fn))
    if (!guarded) continue
    // Already inside an @supports block of its own — the author has decided
    // explicitly, which is all this check asks for.
    if (decl.supports.length > 0) continue
    if (covered.has(decl.prop)) continue
    offenders.push({ file, decl, guarded })
  }
}

const checked = scanned.reduce((n, s) => n + s.decls.length, 0)

if (offenders.length === 0) {
  console.log(
    `  ok    ${checked} custom-property declarations across ${sheets.length} stylesheets; ` +
      `every modern-CSS value has an @supports fallback`,
  )
  process.exit(0)
}

console.log('')
console.log('  A custom property holds CSS the oldest supported WebView cannot parse,')
console.log('  and has no @supports fallback. This does not degrade — it destroys')
console.log('  whichever property reads it (invalid at computed-value time -> unset).')
console.log('')
for (const { file, decl, guarded } of offenders) {
  console.log(`  FAIL  ${file}:${decl.at}`)
  console.log(`          ${decl.prop}: ${decl.value.slice(0, 72)}`)
  console.log(`          ${guarded.fn.replace('(', '()')} needs ${guarded.since}; minSdkVersion here is 24.`)
}
console.log('')
console.log('  Fix it by restating the property with a plain value inside:')
console.log('')
console.log('      @supports not (color: color-mix(in srgb, red 50%, blue)) {')
console.log('        <the same selector> { --token: <plain value> !important; }')
console.log('      }')
console.log('')
console.log('  A plain declaration *above* the fancy one does not work for a custom')
console.log('  property — nothing is dropped, so the plain value is simply overwritten.')
console.log('')
process.exit(1)
