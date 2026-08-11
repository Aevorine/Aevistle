/**
 * Every text colour, on every surface it is drawn on, in every theme.
 *
 * `theme.css` carries seven visual styles times a light and a dark variant, and
 * each variant restates around thirty colour tokens. That is roughly 400 text-
 * on-surface pairs, and the contrast ratios written in the comments beside them
 * were computed by hand, at different times, by whoever was editing that block.
 * Some are stale by construction: this round changed the body typeface from a
 * serif to a sans, and two of those comments justify their numbers with how 宋体
 * strokes behave on an LCD.
 *
 * A number in a comment is a claim. This computes it.
 *
 * The thresholds are WCAG 2.1: 4.5:1 for body text, 3:1 for large text and for
 * the borders and icons that carry meaning. `--text-3` is the tertiary rank and
 * is held to 4.5 as well rather than 3, because in this app it is used for
 * timestamps and counts — small text that is read, not decoration.
 *
 * Run by `npm run check:contrast`, and part of `npm run check`.
 */

import { readFileSync } from 'node:fs'

const SRC = 'src/styles/theme.css'
const AA_BODY = 4.5
const AA_LARGE = 3.0

/* ---- colour maths (sRGB, WCAG 2.1) ---- */

const hexToRgb = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** rgba(r,g,b,a) over an opaque backdrop. */
const flatten = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)))

const parseColour = (raw) => {
  const v = raw.trim()
  let m = v.match(/^#[0-9a-fA-F]{3,8}$/)
  if (m) {
    const h = v.replace('#', '')
    if (h.length === 8) return { rgb: hexToRgb('#' + h.slice(0, 6)), alpha: parseInt(h.slice(6, 8), 16) / 255 }
    return { rgb: hexToRgb(v), alpha: 1 }
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/)
  if (m) return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] === undefined ? 1 : +m[4] }
  return null // color-mix(), var(), gradients — not a flat colour, skip
}

/* ---- read every declaration block that defines theme tokens ---- */

const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

/** [{ name, tokens: Map }] — one per :root / [data-style] / @media block. */
const blocks = []
{
  const re = /(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(code))) {
    const selector = m[2].trim().replace(/\s+/g, ' ')
    if (!/:root/.test(selector)) continue
    const tokens = new Map()
    for (const d of m[3].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      tokens.set(d[1], d[2].trim())
    }
    if (tokens.size) blocks.push({ name: selector.slice(0, 60), tokens })
  }
}

/* ---- resolve a theme by layering the base :root under each style block ---- */

const base = new Map()
for (const b of blocks) if (/^:root,?$|^:root\[data-theme="light"\]$/.test(b.name.split(',')[0].trim())) {
  for (const [k, v] of b.tokens) if (!base.has(k)) base.set(k, v)
}

const INK = ['--text-1', '--text-2', '--text-3']
const GROUND = ['--bg', '--surface-1', '--surface-2', '--surface-3', '--surface-inset']
const MEANINGFUL = ['--success', '--warning', '--danger', '--info', '--accent']

const problems = []
const rows = []
let pairs = 0

for (const block of blocks) {
  const t = (name) => block.tokens.get(name) ?? base.get(name)
  const inks = INK.filter((k) => block.tokens.has(k))
  if (!inks.length) continue // not a theme block, just a shape/motion block

  let worst = { ratio: Infinity, label: '' }
  for (const inkName of INK) {
    const ink = parseColour(t(inkName) ?? '')
    if (!ink) continue
    for (const groundName of GROUND) {
      const ground = parseColour(t(groundName) ?? '')
      if (!ground) continue
      const fg = ink.alpha < 1 ? flatten(ink.rgb, ink.alpha, ground.rgb) : ink.rgb
      const ratio = contrast(fg, ground.rgb)
      pairs++
      if (ratio < worst.ratio) worst = { ratio, label: `${inkName} on ${groundName}` }
      if (ratio < AA_BODY) {
        problems.push(`${block.name}\n      ${inkName} (${t(inkName)}) on ${groundName} (${t(groundName)}) = ${ratio.toFixed(2)}:1, under ${AA_BODY}`)
      }
    }
  }
  // Semantic colours only have to clear the large-text / non-text line: they
  // are used on chips and icons at 14px+ bold, and as borders.
  for (const name of MEANINGFUL) {
    const c = parseColour(t(name) ?? '')
    const ground = parseColour(t('--surface-1') ?? '')
    if (!c || !ground) continue
    const ratio = contrast(c.rgb, ground.rgb)
    pairs++
    if (ratio < AA_LARGE) {
      problems.push(`${block.name}\n      ${name} (${t(name)}) on --surface-1 = ${ratio.toFixed(2)}:1, under ${AA_LARGE}`)
    }
  }
  rows.push(`  ${block.name.padEnd(52)} worst ${worst.ratio.toFixed(1)}:1  (${worst.label})`)
}

console.log('')
console.log(rows.join('\n'))
console.log('')
console.log(`  ${blocks.length} token blocks, ${pairs} colour pairs computed`)
console.log('')

if (problems.length) {
  console.error(`  ${problems.length} pair${problems.length === 1 ? '' : 's'} under the WCAG AA line:\n`)
  for (const p of problems) console.error(`    ${p}`)
  console.error('')
  process.exit(1)
}

console.log(`  All clear — every ink clears ${AA_BODY}:1 on every surface it is drawn on,`)
console.log(`  and every semantic colour clears ${AA_LARGE}:1.\n`)
