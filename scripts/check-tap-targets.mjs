/**
 * Walks the running app at four device sizes and measures every control.
 *
 * Reading the stylesheet cannot answer this. A control's rendered height is the
 * result of a cascade the source does not show you — this round found a send
 * button at 50px where `--control-h` said 48 (a `font` shorthand three files
 * away had reset its line-height), a chip cross declared at both 16px and 24px
 * in two places that both matched, and a `.markup__toggle` at 22px whose 48px
 * floor lived behind `@media (any-pointer: coarse)` and had therefore never run
 * on any machine anyone had checked it on. None of those is visible in CSS.
 * All three are visible in `getBoundingClientRect`.
 *
 * What it enforces:
 *
 *   1. no control below 44px in any direction on a touch shell
 *   2. no more than 4 distinct control heights at any one size — the measured
 *      count was 17 before this round, which is the whole of 界面不统一 in one
 *      number
 *   3. one type size per kind of text (a label is a label on every screen)
 *
 * Needs the dev server. `npm run check:tap` starts one, runs this, stops it.
 */

/*
 * Resolved out of `tests/`, which carries its own dependency island so the root
 * lockfile stays still (see the note in .gitignore). Playwright is a ~300MB
 * install with browser binaries; it is a test dependency, not a build one, and
 * this script is the only thing outside `tests/` that needs it.
 */
import { createRequire } from 'node:module'
const require = createRequire(new URL('../tests/package.json', import.meta.url))
let chromium
try {
  ({ chromium } = require('playwright'))
} catch {
  console.error('\n  playwright is not installed. Run `npm install` inside tests/ first.\n')
  process.exit(1)
}

const TARGET = process.env.CHECK_URL ?? 'http://127.0.0.1:5199/'

/** The sizes this app is actually used at, not a sweep. */
const SIZES = [
  { name: 'phone portrait', width: 360, height: 800, touch: true },
  { name: 'phone landscape', width: 800, height: 360, touch: true },
  { name: 'tablet portrait', width: 768, height: 1024, touch: true },
  { name: 'laptop', width: 1024, height: 768, touch: false },
  /*
   * The large-text setting, on the size that has least room for it.
   *
   * `textScale: larger` moves the root font-size to 125%, and the whole type
   * and spacing scale is in `rem`, so every control on this screen grows at
   * once. That is the intent — but it is also exactly the condition under
   * which a row that fitted stops fitting, and the setting has no other guard.
   * Measured here rather than assumed: a 48px button becomes 50px and stops,
   * which is what the four-height ceiling below is checking.
   */
  { name: 'phone, largest text', width: 360, height: 800, touch: true, textScale: 'larger' },
]

const MIN_TAP = 44
const MAX_DISTINCT_HEIGHTS = 4

/** Runs inside the page. Written as a function, not a string: Playwright
    evaluates a string as an *expression*, so a stringified arrow returns the
    arrow rather than calling it. */
const MEASURE = () => {
  const CONTROL = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=checkbox],[role=switch]'
  const rows = []
  for (const el of document.querySelectorAll(CONTROL)) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (getComputedStyle(el).visibility === 'hidden') continue
    rows.push({
      cls: (typeof el.className === 'string' && el.className) || el.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      inline: getComputedStyle(el).display === 'inline',
    })
  }
  const kind = (label, sel) => {
    const set = new Set()
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(); if (r.height < 1) continue
      set.add(getComputedStyle(el).fontSize)
    }
    return [label, [...set]]
  }
  return {
    shell: document.documentElement.getAttribute('data-shell'),
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
    sizeClass: document.documentElement.getAttribute('data-size-class'),
    controls: rows,
    kinds: [
      kind('field label', '.field__label'),
      kind('button text', '.btn'),
      kind('input text', 'input.input, .select, .textarea'),
      kind('card title', '.card__title'),
    ].filter(([, v]) => v.length),
  }
}

const browser = await chromium.launch()
const problems = []
const report = []

for (const size of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    hasTouch: size.touch,
    isMobile: size.touch,
  })
  await page.goto(TARGET, { waitUntil: 'networkidle' })
  // The shell writes data-shell / data-size-class in an effect; wait for it.
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-size-class'), null, { timeout: 5000 })
  if (size.textScale) {
    // Set directly rather than through Settings: this is a check of the
    // stylesheet's behaviour at that scale, not of the switch that sets it.
    await page.evaluate((v) => document.documentElement.setAttribute('data-text-scale', v), size.textScale)
    await page.waitForTimeout(120)
  }
  const m = await page.evaluate(MEASURE)

  const heights = new Map()
  const tooSmall = []
  for (const c of m.controls) {
    // An inline `<a>` inside a sentence is text, not a target — it is sized by
    // its line box and making it 44px tall would break the paragraph it is in.
    if (c.inline) continue
    heights.set(c.h, (heights.get(c.h) ?? 0) + 1)
    // A textarea or a tall list row is not a violation of a *minimum*.
    if (c.h < MIN_TAP || c.w < MIN_TAP) tooSmall.push(c)
  }
  const distinct = [...heights.keys()].filter((h) => h <= 120).sort((a, b) => a - b)

  report.push(`  ${size.name.padEnd(16)} ${String(size.width + 'x' + size.height).padEnd(10)} ` +
    `shell=${String(m.shell ?? '-').padEnd(7)} class=${String(m.sizeClass).padEnd(9)} root=${String(m.rootFontSize).padEnd(5)} ` +
    `heights: ${distinct.join(' ')}`)

  if (m.shell === 'mobile' && tooSmall.length) {
    for (const c of tooSmall.slice(0, 8)) {
      problems.push(`${size.name}: ${c.cls.slice(0, 34)} is ${c.w}x${c.h}, under the ${MIN_TAP}px floor`)
    }
  }
  if (distinct.length > MAX_DISTINCT_HEIGHTS) {
    problems.push(`${size.name}: ${distinct.length} distinct control heights (${distinct.join(' ')}) — at most ${MAX_DISTINCT_HEIGHTS} allowed`)
  }
  for (const [label, sizes] of m.kinds) {
    if (sizes.length > 1) {
      problems.push(`${size.name}: "${label}" renders at ${sizes.length} different sizes (${sizes.join(', ')}) — one kind of text, one size`)
    }
  }

  await page.close()
}

await browser.close()

console.log('')
console.log(report.join('\n'))
console.log('')

if (problems.length) {
  console.error(`  ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`)
  for (const p of problems) console.error(`    ${p}`)
  console.error('')
  process.exit(1)
}

console.log('  All clear — every control clears 44px on a touch shell, and each kind')
console.log('  of text has one size.\n')
