/**
 * The layout is allowed three widths and two heights. This fails the build if
 * it grows a fourth.
 *
 * 界面不统一 has been reported five times. Every previous round answered it by
 * restyling the screens that were complained about, and every time the answer
 * came apart the same way: not because any one screen was wrong, but because
 * the screens did not agree on *when* to change shape. At the start of this
 * round there were eleven boundaries live at once —
 *
 *   app.css          560 620 700 720 760 900 1000 1100 1500 1600
 *   useNarrow.ts     760      (the tab bar and the dialog treatment)
 *   RecipientPicker  760      (dropdown or bottom sheet)
 *   ComposeView      900      (whether the message box gets the screen)
 *
 * — so dragging a window from 1600px to 320px crossed eleven of them, and
 * between any two the app was a mix of two arrangements. No screenshot review
 * finds that, because it is never wrong in a screenshot; it is wrong in the
 * band between two screenshots.
 *
 * There is nothing to review here now. The boundaries are Android's own window
 * size classes, they are declared once in `useNarrow.ts`, and this script is
 * what makes "declared once" true of the stylesheet as well — CSS cannot read
 * a JavaScript constant, so the literal is checked instead of shared.
 *
 * Run by `npm run check:breakpoints`, and part of `npm run check`.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CSS_DIR = 'src/styles/app'
const EXTRA_CSS = ['src/styles/theme.css']
const TS = 'src/components/useNarrow.ts'

/**
 * The only boundaries any query in this app may name.
 *
 * Three boundaries, five spellings: each one is written `N` in a `min-width`
 * and `N - 0.02` in a `max-width`, so that a viewport of exactly N px matches
 * one side and not both. 600 has no `min-width` spelling because nothing keys
 * off "phone landscape and up" on its own — compact and medium share a shape —
 * and 840 has no `max-width` partner beyond 839.98 for the same reason.
 */
const ALLOWED_WIDTH = new Set(['599.98', '600', '839.98', '840', '1199.98', '1200'])
/** 480 = a phone on its side. 880 = a window too short for a form and a message box. */
const ALLOWED_HEIGHT = new Set(['479.98', '480', '879.98', '880'])

const problems = []
const seen = { width: new Map(), height: new Map() }

/* ---- 1. the stylesheets ---- */
const cssFiles = [
  ...readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => join(CSS_DIR, f)),
  ...EXTRA_CSS,
]

for (const file of cssFiles) {
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  // Comments in this project discuss pixel values at length. Blank them out,
  // preserving newlines so line numbers stay true.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  code.split('\n').forEach((line, i) => {
    if (!/@media/.test(line)) return
    for (const m of line.matchAll(/(min|max)-(width|height):\s*([0-9.]+)px/g)) {
      const [, , axis, value] = m
      const allowed = axis === 'width' ? ALLOWED_WIDTH : ALLOWED_HEIGHT
      seen[axis].set(value, (seen[axis].get(value) ?? 0) + 1)
      if (!allowed.has(value)) {
        problems.push(`${file}:${i + 1}  ${axis} boundary ${value}px is not one of ${[...allowed].join(' / ')}`)
      }
    }
  })
}

/* ---- 2. the TypeScript side, which must name the same numbers ---- */
const ts = readFileSync(TS, 'utf8')
const constOf = (name) => {
  const m = ts.match(new RegExp(`export const ${name} = (\\d+)`))
  return m ? m[1] : null
}
const BP_MEDIUM = constOf('BP_MEDIUM')
const BP_EXPANDED = constOf('BP_EXPANDED')
const BP_LARGE = constOf('BP_LARGE')

if (BP_MEDIUM !== '600') problems.push(`${TS}  BP_MEDIUM is ${BP_MEDIUM}, expected 600`)
if (BP_EXPANDED !== '840') problems.push(`${TS}  BP_EXPANDED is ${BP_EXPANDED}, expected 840`)
if (BP_LARGE !== '1200') problems.push(`${TS}  BP_LARGE is ${BP_LARGE}, expected 1200`)

const shortMatch = ts.match(/SHORT_QUERY = `\(max-height: (\d+)px\)`/)
if (!shortMatch) problems.push(`${TS}  SHORT_QUERY is missing or no longer a plain max-height query`)
else if (!ALLOWED_HEIGHT.has(shortMatch[1])) {
  problems.push(`${TS}  SHORT_QUERY names ${shortMatch[1]}px, which the stylesheets do not use`)
}

/* ---- 3. nobody else may hold a raw breakpoint ---- */
const OTHER_TS = ['src/views/ComposeView.tsx', 'src/components/RecipientPicker.tsx', 'src/App.tsx', 'src/main.tsx']
for (const file of OTHER_TS) {
  let src
  try { src = readFileSync(file, 'utf8') } catch { continue }
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  for (const m of code.matchAll(/matchMedia\(\s*['"`]\(m(?:in|ax)-(?:width|height):\s*[0-9.]+px\)/g)) {
    problems.push(`${file}  holds a literal media query (${m[0].slice(11, 60)}...) — import the constant from useNarrow.ts instead`)
  }
}

/* ---- report ---- */
const fmt = (m) => [...m.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([v, n]) => `${v}px x${n}`).join('  ')
console.log('')
console.log(`  width boundaries in use : ${fmt(seen.width) || '(none)'}`)
console.log(`  height boundaries in use: ${fmt(seen.height) || '(none)'}`)
console.log(`  files scanned           : ${cssFiles.length} stylesheets + ${OTHER_TS.length + 1} modules`)
console.log('')

if (problems.length) {
  console.error(`  ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`)
  for (const p of problems) console.error(`    ${p}`)
  console.error('')
  console.error('  Every boundary in this app is declared in src/components/useNarrow.ts.')
  console.error('  A new one is not a styling decision, it is a decision about when the')
  console.error('  whole app changes shape — so it goes there, with the reason, or it')
  console.error('  does not go in.')
  console.error('')
  process.exit(1)
}

console.log('  All clear — three widths, two heights, one source.\n')
