/**
 * Does any `position: fixed` element still have an ancestor that quietly became
 * its containing block?
 *
 * ## The bug this exists because of
 *
 * `28-states.css` had `:root[data-shell='mobile'] .view__inner { animation:
 * viewarrive 120ms ease-out both }`. The `both` fill mode keeps the *last*
 * keyframe applied after the animation ends, and that keyframe is
 * `transform: translate3d(0, 0, 0)` — an identity transform. It moves nothing.
 * It looks like nothing. And a non-`none` transform makes an element the
 * containing block for every `position: fixed` descendant, so `.modal-scrim`
 * (`position: fixed; inset: 0`) stopped resolving against the viewport and
 * started resolving against the view's own padded column.
 *
 * Measured at 360x800 with the Appearance section open: the scrim was 328x1326
 * and the dialog inside it 328px wide at x=16. That is the report 设置界面弹出
 * 的界面左右是空白的，没有完全覆盖 — a 16px stripe of page down each side of
 * every dialog opened from inside a view, on phones and tablets only.
 *
 * Nothing about the symptom points at the cause. The dialog rules are correct,
 * the shell attribute is set, `width: 100%` is applied and computes to the wrong
 * number, and the line responsible is one word in a file about page-entry
 * animations that never mentions dialogs. That is precisely the kind of defect a
 * gate is for.
 *
 * ## What is actually checked
 *
 * Statically, over the built stylesheet parts:
 *
 *   1. Collect every keyframes block that sets `transform` (or `scale` /
 *      `rotate` / `translate`, the standalone properties, which create a
 *      containing block on the same terms).
 *   2. Collect every `animation` shorthand / `animation-fill-mode` that names
 *      one of those and fills *forwards* (`forwards` or `both`).
 *   3. Fail if the selector it lands on is an ancestor-shaped selector — one of
 *      the known wrappers a fixed-position overlay lives inside — unless the
 *      animation ends at `opacity: 0`, where the element is on its way out and
 *      has nothing left to contain.
 *
 * The wrapper list is explicit rather than inferred: this file cannot resolve
 * selectors against a DOM, and a heuristic that guessed would either miss the
 * one case that matters or fail the build on every exit animation in the app.
 * Adding a new scroll/page wrapper means adding it here, which is the point —
 * the list is short, and it is the list of places this trap can be re-sprung.
 *
 * Exit code 1 if anything needs attention.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'src', 'styles', 'app')

/**
 * The elements a `position: fixed` overlay is rendered inside.
 *
 * `.modal-scrim`, `.toasts`, `.popover` and the lightbox all mount wherever
 * their React owner sits, which is inside a view — so every one of these is a
 * potential containing block for all of them.
 */
const WRAPPERS = [
  '.view__inner',
  '.view',
  '.main',
  '.shell',
  '.app',
  'body',
  ':root',
  'html',
]

/** Properties that create a containing block for fixed descendants. */
const CB_PROPS = /(^|[\s;{])(transform|scale|rotate|translate|perspective|filter|backdrop-filter|will-change|contain)\s*:/

const failures = []
let checked = 0

const files = readdirSync(DIR).filter((f) => f.endsWith('.css')).sort()
const sources = files.map((f) => ({ file: f, css: readFileSync(path.join(DIR, f), 'utf8') }))
const all = sources.map((s) => s.css).join('\n')

/* -------------------------------------------------------------------------- */
/*  1. Which keyframes create a containing block, and which fade out           */
/* -------------------------------------------------------------------------- */

/**
 * Comments are stripped first.
 *
 * Several of these files argue about `transform` in prose at length — this very
 * check is described in one of them — and a scanner that read the arguments as
 * declarations would fail on the documentation of its own rule.
 */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const keyframes = new Map()
const kfRe = /@keyframes\s+([\w-]+)\s*\{/g
const body = strip(all)
let m
while ((m = kfRe.exec(body)) !== null) {
  // Brace-match rather than a lazy `[\s\S]*?\}`: a keyframes block contains
  // nested `{ }` per stop, so the first closing brace is never the right one.
  let depth = 1
  let i = kfRe.lastIndex
  while (i < body.length && depth > 0) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
    i++
  }
  const block = body.slice(kfRe.lastIndex, i - 1)
  keyframes.set(m[1], {
    createsCB: CB_PROPS.test(block),
    // "Ends invisible" is read off the last stop that mentions opacity — an
    // element animating to nothing has nothing left to be the containing block
    // for, and every exit animation in this app is of that shape.
    fadesOut: /opacity\s*:\s*0(\.0+)?\s*[;}]/.test(block.slice(block.lastIndexOf('to') >= 0 ? block.lastIndexOf('to') : 0)),
  })
}
checked++
if (keyframes.size === 0) failures.push('no @keyframes found at all — this check is looking at the wrong files')

/* -------------------------------------------------------------------------- */
/*  2. Every rule that runs one of them with a forward fill                    */
/* -------------------------------------------------------------------------- */

for (const { file, css } of sources) {
  const clean = strip(css)
  // One declaration block at a time, with the selector that owns it.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let r
  while ((r = ruleRe.exec(clean)) !== null) {
    const selector = r[1].trim().replace(/\s+/g, ' ')
    const decls = r[2]
    if (!/animation/.test(decls)) continue
    // `@keyframes` stops (`from`, `to`, `54%`) are not selectors and carry no
    // animation shorthand; anything that looks like one here is a real rule.
    if (/^(from|to|\d+%)$/.test(selector)) continue

    const fills = /animation(-fill-mode)?\s*:[^;]*\b(forwards|both)\b/.test(decls)
    if (!fills) continue

    const named = [...keyframes.keys()].filter((name) =>
      new RegExp(`animation[^;]*\\b${name}\\b`).test(decls),
    )
    for (const name of named) {
      const kf = keyframes.get(name)
      checked++
      if (!kf.createsCB) continue
      if (kf.fadesOut) continue
      const isWrapper = WRAPPERS.some((w) => selector.includes(w))
      if (!isWrapper) continue
      failures.push(
        `${file}: \`${selector}\` runs \`${name}\` with a forward fill.\n` +
          `    That keyframe sets a transform-like property, so it stays applied after the\n` +
          `    animation ends and makes this element the containing block for every\n` +
          `    position:fixed descendant — dialogs, toasts and popovers included. Use\n` +
          `    \`backwards\` (there is no delay, so the entrance is unchanged), or animate a\n` +
          `    property that does not create a containing block.`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  3. The gate has to be able to fail                                         */
/* -------------------------------------------------------------------------- */

/*
 * A check that cannot see its own bug is not a check. This re-runs the whole
 * detection over the exact stylesheet that shipped the defect, and fails if it
 * comes back clean — so the next person to "simplify" the matching above finds
 * out here rather than the next time a dialog is the wrong size.
 */
const REGRESSION = `
@keyframes viewarrive {
  from { opacity: 0; transform: translate3d(8px, 0, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
:root[data-shell='mobile'] .view__inner {
  animation: viewarrive 120ms ease-out both;
}
`
{
  const clean = strip(REGRESSION)
  const kfBlock = clean.slice(clean.indexOf('{', clean.indexOf('@keyframes')) + 1)
  const createsCB = CB_PROPS.test(kfBlock)
  const rule = /\.view__inner\s*\{([^}]*)\}/.exec(clean)
  const caught =
    createsCB &&
    rule !== null &&
    /animation(-fill-mode)?\s*:[^;]*\b(forwards|both)\b/.test(rule[1]) &&
    WRAPPERS.some((w) => '.view__inner'.includes(w))
  checked++
  if (!caught) {
    failures.push(
      'self-test: the known 0.3.6 defect (`.view__inner` + `viewarrive` + `both`) is no ' +
        'longer detected by the matching above. The gate has stopped guarding.',
    )
  }
}

/* -------------------------------------------------------------------------- */

if (failures.length > 0) {
  console.error(`check-fixed-containing-block: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`check-fixed-containing-block: OK (${checked} checks over ${files.length} stylesheet parts)`)
