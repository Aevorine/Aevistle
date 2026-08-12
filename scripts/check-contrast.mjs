/**
 * Every text colour, on every surface it is drawn on, in every theme.
 *
 * `theme.css` carries seven visual styles times a light and a dark variant, and
 * each variant restates around thirty colour tokens. That is roughly 400 text-
 * on-surface pairs, and the contrast ratios written in the comments beside them
 * were computed by hand, at different times, by whoever was editing that block.
 *
 * A number in a comment is a claim. This computes it.
 *
 * The thresholds are WCAG 2.1: 4.5:1 for body text, 3:1 for large text and for
 * the borders and icons that carry meaning. `--text-3` is the tertiary rank and
 * is held to 4.5 as well rather than 3, because in this app it is used for
 * timestamps and counts — small text that is read, not decoration.
 *
 * Run by `npm run check:contrast`, and part of `npm run check`.
 *
 * ===========================================================================
 * What this could not see until now
 *
 * Three holes, all of them the same shape: a pair it could not evaluate was
 * skipped, and a skipped pair was counted as a pass. The file printed "All
 * clear — every ink clears 4.5:1 on every surface it is drawn on" while
 * silently declining to look at some of the most-used colour pairs in the app.
 *
 *   1. `var()` was not resolved. `parseColour` returned null for anything that
 *      was not a literal hex or rgb(), and *every* block in theme.css defines
 *      `--accent` as `var(--accent-azure-l)` or one of its siblings. `--accent`
 *      is in the MEANINGFUL list and was therefore checked in exactly zero of
 *      the blocks it appears in. The accent is the one colour on screen that
 *      the user can change, and it had never been measured.
 *
 *   2. `color-mix()` was not resolved, and the comment beside the return said
 *      so — "not a flat colour, skip". `21-home-grid.css` builds the home
 *      screen's hero band entirely out of `color-mix()`, and its own comment
 *      records the consequence: "check:contrast reads theme.css and skips
 *      color-mix(), so it cannot see these; the ratios were computed the same
 *      way it computes its own". A hand-computed 189-pair table sitting in a
 *      comment because the machine could not read the file is the exact
 *      failure this script exists to end.
 *
 *   3. The matrix was ink-on-surface only. Text painted on a *fill* — a
 *      primary button's label on `--accent`, a conflict marker's label on
 *      `--danger` — was not in it at all, in either direction. That is the
 *      most-clicked pair in the application.
 *
 * All three are fixed below. The rule that replaces "skip" is: a pair that
 * cannot be resolved is counted and named in the output, never dropped. If the
 * unresolved count is not zero, the summary says so — so the next colour
 * function nobody taught this file about cannot pass by being invisible.
 */

import { readFileSync } from 'node:fs'
import { allStylesheets } from './lib/stylesheets.mjs'

const THEME = 'src/styles/theme.css'
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

/** The handful of bare colour keywords theme.css and the app parts actually use. */
const KEYWORDS = {
  transparent: { rgb: [0, 0, 0], alpha: 0 },
  white: { rgb: [255, 255, 255], alpha: 1 },
  black: { rgb: [0, 0, 0], alpha: 1 },
  currentcolor: null, // resolvable only against an element; never guessed
}

/**
 * Split a comma-separated argument list, respecting nested parentheses.
 * `color-mix(in srgb, var(--a) 88%, var(--b))` has three top-level parts and
 * a naive `.split(',')` finds four.
 */
function splitArgs(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim())
}

/**
 * Resolve a token's value to `{ rgb, alpha }`, following `var()` chains and
 * evaluating `color-mix()`.
 *
 * `lookup` maps a token name to its declared text in the scope being resolved.
 * `seen` breaks the cycle a self-referencing fallback would otherwise create
 * (`--accent-classical-marker: var(--accent-classical, var(--accent))`).
 *
 * Returns null when the value genuinely cannot be reduced to a colour — a
 * gradient, a shadow, `currentColor`, a mix in a space this does not implement.
 * Null is a *result* here, not a shortcut: every caller counts it.
 */
function resolveColour(raw, lookup, seen = new Set()) {
  if (raw == null) return null
  const v = String(raw).trim()
  if (!v) return null

  const kw = KEYWORDS[v.toLowerCase()]
  if (kw !== undefined) return kw

  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
    const h = v.replace('#', '')
    if (h.length === 8) return { rgb: hexToRgb('#' + h.slice(0, 6)), alpha: parseInt(h.slice(6, 8), 16) / 255 }
    if (h.length === 4) {
      const full = [...h].map((c) => c + c).join('')
      return { rgb: hexToRgb('#' + full.slice(0, 6)), alpha: parseInt(full.slice(6, 8), 16) / 255 }
    }
    return { rgb: hexToRgb(v), alpha: 1 }
  }

  let m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/)
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]
    return { rgb: [+m[1], +m[2], +m[3]], alpha: a }
  }

  // var(--x) or var(--x, fallback)
  m = v.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,([\s\S]+))?\)$/)
  if (m) {
    const name = m[1]
    if (!seen.has(name)) {
      const next = lookup(name)
      if (next != null) {
        const got = resolveColour(next, lookup, new Set([...seen, name]))
        if (got) return got
      }
    }
    return m[2] ? resolveColour(m[2].trim(), lookup, new Set([...seen, name])) : null
  }

  /*
   * color-mix(in <space>, <c1> [p1%], <c2> [p2%])
   *
   * Only `srgb` is evaluated. The other spaces this codebase uses — `oklab`,
   * for the calendar's load tint — are a different interpolation and computing
   * them as if they were sRGB would produce a number that is wrong in a way
   * nobody would catch. Unimplemented spaces return null, which is *reported*
   * as unresolved rather than passed over. The one place a mix feeds a text
   * pair (`--hero-ink` / `--hero-bg`, 21-home-grid.css) is `in srgb`, which is
   * also the space its own hand-computed table was derived in — so the two are
   * comparable.
   *
   * Percentage normalisation follows the spec: one percentage given means the
   * other is 100 minus it; neither given means 50/50; both given are
   * normalised to sum to 100. Alpha is mixed alongside the channels.
   */
  m = v.match(/^color-mix\(([\s\S]+)\)$/)
  if (m) {
    const args = splitArgs(m[1])
    if (args.length !== 3) return null
    const space = args[0].replace(/^in\s+/, '').trim().toLowerCase()
    if (space !== 'srgb') return null

    const part = (arg) => {
      const pct = arg.match(/\s([\d.]+)%$/)
      // `calc(70% * var(--intensity, 1))` — a runtime value, not a constant.
      if (/calc\(/.test(arg)) return null
      return { text: pct ? arg.slice(0, pct.index).trim() : arg.trim(), pct: pct ? parseFloat(pct[1]) : null }
    }
    const a = part(args[1])
    const b = part(args[2])
    if (!a || !b) return null

    let pa = a.pct
    let pb = b.pct
    if (pa == null && pb == null) { pa = 50; pb = 50 }
    else if (pa == null) pa = 100 - pb
    else if (pb == null) pb = 100 - pa
    const sum = pa + pb
    if (sum <= 0) return null
    pa /= sum
    pb /= sum

    const ca = resolveColour(a.text, lookup, seen)
    const cb = resolveColour(b.text, lookup, seen)
    if (!ca || !cb) return null

    // Premultiplied, which is what the spec does and what makes mixing with
    // `transparent` behave: `color-mix(in srgb, X 88%, transparent)` is X at
    // 88% alpha, not X blended toward black.
    const alpha = ca.alpha * pa + cb.alpha * pb
    if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 }
    const rgb = [0, 1, 2].map(
      (i) => (ca.rgb[i] * ca.alpha * pa + cb.rgb[i] * cb.alpha * pb) / alpha,
    )
    return { rgb, alpha }
  }

  return null
}

/* ---- read every declaration block that defines tokens ---- */

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const themeCode = stripComments(readFileSync(THEME, 'utf8').replace(/\r\n/g, '\n'))

/** [{ name, tokens: Map }] — one per :root / [data-style] / @media block. */
const blocks = []
{
  const re = /(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(themeCode))) {
    const selector = m[2].trim().replace(/\s+/g, ' ')
    if (!/:root/.test(selector)) continue
    const tokens = new Map()
    for (const d of m[3].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      tokens.set(d[1], d[2].trim())
    }
    if (tokens.size) blocks.push({ name: selector.slice(0, 60), tokens, full: selector })
  }
}

/**
 * Custom properties declared outside theme.css, keyed by the selector that
 * declares them.
 *
 * Only used by the named extra pairs at the bottom of this file — this is not
 * a general sweep of every rule in the app, because a custom property on
 * `.stylecard` is a preview swatch, not a surface anybody reads text on, and
 * pairing every local ink with every local ground would invent hundreds of
 * combinations that do not exist on screen. What it *is* for is the one case
 * where a genuine reading surface is assembled outside the token file.
 */
const localTokens = new Map()
for (const file of allStylesheets()) {
  if (file.replace(/\\/g, '/').endsWith('theme.css')) continue
  const code = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  const re = /(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(code))) {
    const selector = m[2].trim().replace(/\s+/g, ' ')
    const tokens = new Map()
    for (const d of m[3].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens.set(d[1], d[2].trim())
    if (!tokens.size) continue
    const prev = localTokens.get(selector) ?? new Map()
    for (const [k, v] of tokens) prev.set(k, v)
    localTokens.set(selector, prev)
  }
}

/* ---- resolve a theme by layering base :root under the style, under the block ---- */

const base = new Map()
for (const b of blocks) {
  if (/^:root,?$|^:root\[data-theme="light"\]$/.test(b.name.split(',')[0].trim())) {
    for (const [k, v] of b.tokens) if (!base.has(k)) base.set(k, v)
  }
}

/**
 * A style's theme-independent block — `:root[data-style="contrast"]` with no
 * `[data-theme]` on it. This is where a style restates the seven accent
 * swatches, and it is a layer the previous version of this file did not have:
 * it merged only the base `:root`, so `contrast`'s much darker
 * `--accent-teal-l` was invisible and every style would have been measured
 * against the house palette.
 */
const styleShape = new Map()
for (const b of blocks) {
  const m = /^:root\[data-style="([a-z]+)"\]$/.exec(b.name.trim())
  if (m) styleShape.set(m[1], b.tokens)
}

const styleOf = (sel) => /\[data-style="([a-z]+)"\]/.exec(sel)?.[1] ?? null
/* Dark is spelled two ways: explicitly, and as the `:not([data-theme="light"])`
   form that only ever appears inside `@media (prefers-color-scheme: dark)`. */
const isDark = (sel) => /\[data-theme="dark"\]/.test(sel) || /:not\(\[data-theme="light"\]\)/.test(sel)

const ACCENTS = ['azure', 'indigo', 'teal', 'violet', 'amber', 'rose', 'emerald']

const INK = ['--text-1', '--text-2', '--text-3']
const GROUND = ['--bg', '--surface-1', '--surface-2', '--surface-3', '--surface-inset']
const MEANINGFUL = ['--success', '--warning', '--danger', '--info', '--accent']

const problems = []
const rows = []
let pairs = 0
let unresolved = []

/**
 * Text painted on a *fill* rather than on a surface.
 *
 * Absent from this file entirely until now, which left the primary button —
 * the single most-clicked thing in the app — unmeasured. `accentSweep` means
 * "check this against all seven accent swatches, not just the one the block
 * happens to name", because the seven `[data-accent]` rules at the foot of
 * theme.css let the user replace `--accent` with any of them at runtime and a
 * ratio that only holds for azure is not a ratio that holds.
 */
const FILL_PAIRS = [
  {
    ink: '--accent-text',
    ground: '--accent',
    accentSweep: true,
    threshold: AA_BODY,
    why: 'the primary button label (.btn--primary, 05-buttons.css:43) and ~20 other fills',
  },
  {
    ink: '--text-inverse',
    ground: '--accent',
    accentSweep: true,
    threshold: AA_BODY,
    why: 'named as the most-clicked pair; the fills that actually use --text-inverse are --warning/--danger below, but this is the pair asked for and it is one edit away from being real',
  },
  {
    ink: '--text-inverse',
    ground: '--warning',
    threshold: AA_BODY,
    why: '.monthgrid__marks[data-conflict="warning"] (04-forms.css:809)',
  },
  {
    ink: '--text-inverse',
    ground: '--danger',
    threshold: AA_BODY,
    why: '.monthgrid__marks[data-conflict="error"] (04-forms.css:813)',
  },
]

for (const block of blocks) {
  const style = styleOf(block.full)
  const shape = style ? styleShape.get(style) : null
  /* Block first, then the style's own shape block, then the base :root. The
     middle layer is what makes `contrast`'s restated accent palette visible. */
  const t = (name) => block.tokens.get(name) ?? shape?.get(name) ?? base.get(name)
  const lookup = t
  const colour = (name) => {
    const raw = t(name)
    if (raw == null) return null
    const got = resolveColour(raw, lookup)
    if (!got) unresolved.push(`${block.name}: ${name} = ${String(raw).slice(0, 60)}`)
    return got
  }

  const inks = INK.filter((k) => block.tokens.has(k))
  if (!inks.length) continue // not a theme block, just a shape/motion block

  const dark = isDark(block.full)

  let worst = { ratio: Infinity, label: '' }
  const check = (ratio, label, threshold, detail) => {
    pairs++
    if (ratio < worst.ratio) worst = { ratio, label }
    if (ratio < threshold) {
      problems.push({
        block: block.name,
        key: `${block.name}|${label}`,
        text: `${block.name}\n      ${detail} = ${ratio.toFixed(2)}:1, under ${threshold}`,
      })
    }
  }

  for (const inkName of INK) {
    const ink = colour(inkName)
    if (!ink) continue
    for (const groundName of GROUND) {
      const ground = colour(groundName)
      if (!ground) continue
      const fg = ink.alpha < 1 ? flatten(ink.rgb, ink.alpha, ground.rgb) : ink.rgb
      check(
        contrast(fg, ground.rgb),
        `${inkName} on ${groundName}`,
        AA_BODY,
        `${inkName} (${t(inkName)}) on ${groundName} (${t(groundName)})`,
      )
    }
  }

  /*
   * The hover and active washes.
   *
   * These are translucent overlays, not surfaces: `rgba(15,23,42,0.04)` is
   * painted *over* whatever the row was already sitting on, so the real ground
   * under a hovered row's text is the composite. Measured against each opaque
   * surface in turn rather than against one guess, because a row hovers on
   * `--surface-1` in a card and on `--bg` in a list pane and they are not the
   * same number.
   *
   * `--text-3` is the one that matters — it is the metadata rank, and metadata
   * is what a hovered list row is mostly made of — but all three inks are swept
   * because the cost of doing so is nothing.
   */
  for (const washName of ['--surface-hover', '--surface-active']) {
    const wash = colour(washName)
    if (!wash) continue
    for (const groundName of GROUND) {
      const ground = colour(groundName)
      if (!ground) continue
      const composite = flatten(wash.rgb, wash.alpha, ground.rgb)
      for (const inkName of INK) {
        const ink = colour(inkName)
        if (!ink) continue
        const fg = ink.alpha < 1 ? flatten(ink.rgb, ink.alpha, composite) : ink.rgb
        check(
          contrast(fg, composite),
          `${inkName} on ${washName} over ${groundName}`,
          AA_BODY,
          `${inkName} (${t(inkName)}) on ${washName} (${t(washName)}) over ${groundName} (${t(groundName)})`,
        )
      }
    }
  }

  // Semantic colours only have to clear the large-text / non-text line: they
  // are used on chips and icons at 14px+ bold, and as borders.
  for (const name of MEANINGFUL) {
    const c = colour(name)
    const ground = colour('--surface-1')
    if (!c || !ground) continue
    check(
      contrast(c.rgb, ground.rgb),
      `${name} on --surface-1`,
      AA_LARGE,
      `${name} (${t(name)}) on --surface-1`,
    )
  }

  // Text on a fill.
  for (const pair of FILL_PAIRS) {
    const ink = colour(pair.ink)
    if (!ink) continue
    const grounds = pair.accentSweep
      ? ACCENTS.map((a) => [`--accent-${a}-${dark ? 'd' : 'l'}`, `${pair.ground} as ${a}`])
      : [[pair.ground, pair.ground]]
    for (const [tokenName, label] of grounds) {
      const ground = colour(tokenName)
      if (!ground) continue
      const fg = ink.alpha < 1 ? flatten(ink.rgb, ink.alpha, ground.rgb) : ink.rgb
      check(
        contrast(fg, ground.rgb),
        `${pair.ink} on ${label}`,
        pair.threshold,
        `${pair.ink} (${t(pair.ink)}) on ${label} (${t(tokenName)}) — ${pair.why}`,
      )
    }
  }

  rows.push(`  ${block.name.padEnd(52)} worst ${worst.ratio.toFixed(1)}:1  (${worst.label})`)
}

/* ---------------------------------------------------------------------------
   The home screen's hero band — the one reading surface built outside theme.css

   `21-home-grid.css` mixes its ground from `--accent` and its ink from
   `--accent-text`, in three time-of-day states, and its own comment records
   that this script could not see any of it. It can now: `color-mix(in srgb,…)`
   resolves, and the sweep below is the same 189 combinations that comment
   computed by hand — 7 accents x light/dark x every style that restates the
   swatches — done by the machine so the table cannot go stale.

   Held to 3:1, not 4.5:1, and that is the band's own documented rank rather
   than a concession made here: the greeting is `--text-lg` bold (18.67px) and
   the figures are `--text-value` bold (20px), both of which are WCAG "large
   text". A 4.5 threshold here would be measuring the wrong rule.
   --------------------------------------------------------------------------- */

const HERO_STATES = [
  ['day', null],
  ['morning', '.homehero[data-tod=\'morning\']'],
  ['night', '.homehero[data-tod=\'night\']'],
]
const heroBase = localTokens.get('.homehero')
let heroPairs = 0
let heroWorst = { ratio: Infinity, label: '(nothing measured)' }

if (!heroBase || !heroBase.has('--hero-bg') || !heroBase.has('--hero-ink')) {
  /* Not a silent skip. If the hero stops declaring these, the sweep below
     measures nothing and would print a flawless zero-failure result for a
     surface it never looked at — which is the exact defect the header of this
     file is about. */
  problems.push({
    block: '21-home-grid.css',
    key: 'hero|missing',
    text:
      '21-home-grid.css\n      .homehero no longer declares --hero-bg / --hero-ink, so the hero contrast ' +
      'sweep measured nothing. Update HERO_STATES in check-contrast.mjs to match what it declares now.',
  })
} else {
  for (const block of blocks) {
    if (!INK.some((k) => block.tokens.has(k))) continue
    const style = styleOf(block.full)
    const shape = style ? styleShape.get(style) : null
    const dark = isDark(block.full)
    for (const accent of ACCENTS) {
      for (const [state, stateSel] of HERO_STATES) {
        const stateTokens = stateSel ? localTokens.get(stateSel) : null
        const lookup = (name) => {
          if (name === '--accent') return `var(--accent-${accent}-${dark ? 'd' : 'l'})`
          return (
            stateTokens?.get(name) ??
            heroBase.get(name) ??
            block.tokens.get(name) ??
            shape?.get(name) ??
            base.get(name)
          )
        }
        const bg = resolveColour(lookup('--hero-bg'), lookup)
        const ink = resolveColour(lookup('--hero-ink'), lookup)
        if (!bg || !ink) {
          unresolved.push(`${block.name} hero/${accent}/${state}`)
          continue
        }
        const fg = ink.alpha < 1 ? flatten(ink.rgb, ink.alpha, bg.rgb) : ink.rgb
        const ratio = contrast(fg, bg.rgb)
        heroPairs++
        pairs++
        const label = `${block.name} · ${accent} · ${state}`
        if (ratio < heroWorst.ratio) heroWorst = { ratio, label }
        if (ratio < AA_LARGE) {
          problems.push({
            block: block.name,
            key: `hero|${label}`,
            text: `${block.name}\n      .homehero --hero-ink on --hero-bg (${accent}, ${state}) = ${ratio.toFixed(2)}:1, under ${AA_LARGE}`,
          })
        }
      }
    }
  }
}

/* ---------------------------------------------------------------------------
   The baseline

   Everything below already failed the first time the repaired checks above
   were run. None of it was introduced by the repair; all of it had simply
   never been measured, because the pair was skipped or the token was a
   `var()` this file could not follow.

   Listed one by one rather than waved through by lowering a threshold, so the
   gate fails on the next one. An entry that no longer matches anything is
   reported as STALE and fails, because a baseline nobody prunes is how a
   repaired gate goes quiet again.
   --------------------------------------------------------------------------- */
/**
 * Family 1 — the translucent washes, 107 pairs.
 *
 * `--surface-hover` and `--surface-active` are 4-9% overlays. Composited over
 * a surface they lift (or drop) it by a few points of luminance, and
 * `--text-3` — the tertiary rank, tuned to sit just over 4.5:1 on the *bare*
 * surface — falls under the line on the composite. Worst in the app:
 * `--text-3` #8a8a91 on `--surface-active` over `--surface-3` in graphite
 * dark, at 3.46:1. The worst `--surface-hover` pair on its own is 3.98:1
 * (nordic dark, over `--surface-3`).
 *
 * Never measured before because this file had no notion of an overlay at all:
 * `--surface-hover` was not in GROUND, so no ink was ever tested against it,
 * in any theme, in any style. The tuning comments in theme.css that quote
 * 5.1-5.5:1 for `--text-3` are all quoting the *bare*-surface number. That
 * number is correct, and it is not the number a hovered list row shows — which
 * is most of the rows a person looks at while a pointer is on screen.
 *
 * Not fixed here. Darkening `--text-3` by the ~8% this needs moves the
 * tertiary rank on every surface in all fourteen theme x style combinations,
 * and every one of those has a hand-tuned ratio in a comment beside it. That
 * is a palette decision across the whole file; a gate's job is to say the
 * number is wrong, not to pick the new one.
 */
const BASELINE_WASH = [
  ":root, :root[data-theme=\"light\"]|--text-3 on --surface-hover over --bg",
  ":root, :root[data-theme=\"light\"]|--text-3 on --surface-hover over --surface-3",
  ":root, :root[data-theme=\"light\"]|--text-3 on --surface-active over --bg",
  ":root, :root[data-theme=\"light\"]|--text-3 on --surface-active over --surface-2",
  ":root, :root[data-theme=\"light\"]|--text-3 on --surface-active over --surface-3",
  ":root, :root[data-theme=\"light\"]|--text-3 on --surface-active over --surface-inset",
  ":root[data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-3",
  ":root[data-theme=\"dark\"]|--text-3 on --surface-active over --surface-1",
  ":root[data-theme=\"dark\"]|--text-3 on --surface-active over --surface-2",
  ":root[data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-3",
  ":root:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-1",
  ":root:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-2",
  ":root:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-3 on --surface-hover over --bg",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-3 on --surface-active over --bg",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"aurora\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"aurora\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"aurora\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"aurora\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"aurora\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"aurora\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"aurora\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"aurora\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"aurora\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"aurora\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-3 on --surface-hover over --bg",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-3 on --surface-active over --bg",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-active over --bg",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"graphite\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --bg",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"graphite\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-3 on --surface-hover over --bg",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-3 on --surface-active over --bg",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-2 on --surface-active over --surface-3",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"paper\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-2 on --surface-active over --surface-3",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"paper\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-3 on --surface-hover over --bg",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-3 on --surface-active over --bg",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-3 on --surface-hover over --bg",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-3 on --surface-active over --bg",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"nordic\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"nordic\"][data-theme=\"dark\"]|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"nordic\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"nordic\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"nordic\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"nordic\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-2",
  ":root[data-style=\"nordic\"]:not([data-theme=\"light\"])|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"nordic\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-1",
  ":root[data-style=\"nordic\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"nordic\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-3 on --surface-hover over --bg",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-3 on --surface-hover over --surface-3",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-3 on --surface-active over --bg",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-3 on --surface-active over --surface-2",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-3 on --surface-active over --surface-inset",
  ":root[data-style=\"runecircuit\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"runecircuit\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"contrast\"][data-theme=\"dark\"]|--text-3 on --surface-active over --surface-3",
  ":root[data-style=\"contrast\"]:not([data-theme=\"light\"])|--text-3 on --surface-active over --surface-3",
  ":root|--text-3 on --surface-hover over --bg",
  ":root|--text-3 on --surface-hover over --surface-3",
  ":root|--text-3 on --surface-active over --bg",
  ":root|--text-3 on --surface-active over --surface-2",
  ":root|--text-3 on --surface-active over --surface-3",
  ":root|--text-3 on --surface-active over --surface-inset"
]

/**
 * Family 2 — white text on the teal and emerald accents, 32 pairs.
 *
 * `--accent-text` is #ffffff and `--accent-teal-l` is #0d9488: 3.74:1.
 * Emerald #059669 is 3.77:1. Both are under 4.5 for the 16px semibold label a
 * primary button carries, and both are the user's own accent choice rather
 * than a default — azure, indigo, violet, amber and rose all clear the line,
 * and the `contrast` style, which restates all seven swatches darker, clears
 * it on every one. That last fact is also the check on this check: the style
 * that was *designed* for contrast is the one style absent from this list.
 *
 * Never measured before for two compounding reasons: text-on-fill was not in
 * the matrix at all, and `--accent` is always `var(--accent-teal-l)` rather
 * than a literal, which the old `parseColour` returned null for. So the pair
 * was skipped twice over, and the second skip would have hidden it even if
 * someone had added the first.
 *
 * Cross-checked against the one place these numbers already existed: the
 * hand-computed table in 21-home-grid.css:141 records "day 3.74:1 white on
 * teal #0d9488" as the worst of its 189 combinations. This file now computes
 * 3.74:1 for the same pair, from the source, which is the first time the two
 * have agreed by construction rather than by someone checking.
 *
 * Fixing it means darkening two swatches — the same change the `contrast`
 * style already makes — and that is a palette decision, not a gate's.
 */
const BASELINE_FILL = [

  ":root, :root[data-theme=\"light\"]|--accent-text on --accent as teal",
  ":root, :root[data-theme=\"light\"]|--accent-text on --accent as emerald",
  ":root, :root[data-theme=\"light\"]|--text-inverse on --accent as teal",
  ":root, :root[data-theme=\"light\"]|--text-inverse on --accent as emerald",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--accent-text on --accent as teal",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--accent-text on --accent as emerald",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-inverse on --accent as teal",
  ":root[data-style=\"aurora\"], :root[data-style=\"aurora\"][data-|--text-inverse on --accent as emerald",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--accent-text on --accent as teal",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--accent-text on --accent as emerald",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-inverse on --accent as teal",
  ":root[data-style=\"graphite\"], :root[data-style=\"graphite\"][d|--text-inverse on --accent as emerald",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--accent-text on --accent as teal",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--accent-text on --accent as emerald",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-inverse on --accent as teal",
  ":root[data-style=\"paper\"], :root[data-style=\"paper\"][data-th|--text-inverse on --accent as emerald",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--accent-text on --accent as teal",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--accent-text on --accent as emerald",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-inverse on --accent as teal",
  ":root[data-style=\"midnight\"], :root[data-style=\"midnight\"][d|--text-inverse on --accent as emerald",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--accent-text on --accent as teal",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--accent-text on --accent as emerald",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-inverse on --accent as teal",
  ":root[data-style=\"nordic\"], :root[data-style=\"nordic\"][data-|--text-inverse on --accent as emerald",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--accent-text on --accent as teal",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--accent-text on --accent as emerald",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-inverse on --accent as teal",
  ":root[data-style=\"runecircuit\"], :root[data-style=\"runecircu|--text-inverse on --accent as emerald",
  ":root|--accent-text on --accent as teal",
  ":root|--accent-text on --accent as emerald",
  ":root|--text-inverse on --accent as teal",
  ":root|--text-inverse on --accent as emerald"
]

const BASELINE = new Map([
  ...BASELINE_WASH.map((k) => [k, 'known: --text-3 under 4.5 on a hover/active composite; see BASELINE_WASH above']),
  ...BASELINE_FILL.map((k) => [k, 'known: white on the teal/emerald accent swatch, 3.74/3.77:1; see BASELINE_FILL above']),
])

/* `node scripts/check-contrast.mjs --dump-baseline` prints every currently
   failing key, one per line, ready to paste into one of the lists above.
   Exists so that adding to the baseline is a mechanical transcription rather
   than 139 lines of hand-copying, which is how a list like this acquires typos
   that quietly match nothing. */
if (process.argv.includes('--dump-baseline')) {
  for (const p of problems) console.log(p.key)
  process.exit(0)
}

const seenBaseline = new Set()
const live = []
const known = []
for (const p of problems) {
  if (BASELINE.has(p.key)) {
    seenBaseline.add(p.key)
    known.push(p)
  } else {
    live.push(p)
  }
}
const stale = [...BASELINE.keys()].filter((k) => !seenBaseline.has(k))

console.log('')
console.log(rows.join('\n'))
console.log('')
console.log(`  ${blocks.length} token blocks, ${pairs} colour pairs computed`)
console.log(`  ${heroPairs} of them the .homehero band (--hero-ink on --hero-bg), worst ${heroWorst.ratio.toFixed(2)}:1 — ${heroWorst.label}`)
if (unresolved.length) {
  /* Printed, always. The whole failure this file was repaired from is that an
     unresolvable colour was skipped and the skip looked like a pass. */
  const shown = [...new Set(unresolved)].slice(0, 10)
  console.log(`\n  ${unresolved.length} value(s) could not be reduced to a colour and were NOT checked:`)
  for (const u of shown) console.log(`    · ${u}`)
  if (unresolved.length > shown.length) console.log(`    · … and ${unresolved.length - shown.length} more`)
}
console.log('')

if (known.length) {
  console.log(`  ${known.length} known, baselined failure(s) — not new, still failing:`)
  for (const p of known) {
    console.log(`    base  ${p.text.replace(/\n\s+/, ' :: ')}`)
    console.log(`          ${BASELINE.get(p.key)}`)
  }
  console.log('')
}

if (stale.length) {
  console.error(`  ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} no longer match anything:`)
  for (const k of stale) console.error(`    STALE  ${k}`)
  console.error(
    '\n  Someone fixed these. Delete the matching line(s) from BASELINE in\n' +
      '  scripts/check-contrast.mjs and this goes green.\n',
  )
}

if (live.length) {
  console.error(`  ${live.length} pair${live.length === 1 ? '' : 's'} under the WCAG AA line:\n`)
  for (const p of live) console.error(`    ${p.text}`)
  console.error('')
}

if (live.length || stale.length) process.exit(1)

/* Deliberately not "All clear" while the baseline is non-empty. The previous
   version of this file printed exactly that sentence over a matrix that was
   skipping every `var()` and every `color-mix()` in the app, and the sentence
   is what made the skip invisible. What this run can honestly say is "nothing
   new", and it says which. */
if (known.length) {
  console.log(
    `  Nothing new — ${pairs} pairs computed, ${known.length} known failure(s) still failing\n` +
      `  (see BASELINE_WASH and BASELINE_FILL above for what they are and why they are not fixed here),\n` +
      `  and nothing outside that list is under its rank.\n`,
  )
} else {
  console.log(`  All clear — every ink clears ${AA_BODY}:1 on every surface it is drawn on,`)
  console.log(`  every semantic colour clears ${AA_LARGE}:1, and every text-on-fill pair clears its rank.\n`)
}
