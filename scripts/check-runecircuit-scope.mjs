/**
 * Chunk-06's A7 audit, made permanent: does any `[data-style="runecircuit"]`
 * selector reach a reading surface?
 *
 * The runecircuit style adds texture, glow and colour washes — grain on a
 * card, a neon border tint, the solar-term wash under the working calendar —
 * and every one of those belongs on chrome (`.card`, `.monthgrid`, a button, a
 * badge, a toast) and never on prose: the compose message body, the message
 * reader, or a list row's own subject/name text. A card border blending
 * toward `--neon-cyan` is a mood; the same blend under `--text-1` on a mail
 * subject is a legibility bug that happens to also be on-theme.
 *
 * "Reading surface" is not a hand-typed list here — it is *derived*: every
 * selector in app.css that sets `max-width: var(--reading-max)` is one, by
 * theme.css's own definition of that token ("caps prose at 68 characters
 * wherever prose..."), plus a short list of surfaces that are reading-only
 * without personally carrying that token (the compose textarea, the message
 * reader's iframe, and the list-row text classes `.job`/`.log`/`.codecard`
 * already lean on for ellipsis truncation — see the "nothing leaves its box"
 * section of app.css). A selector wrapped in `:not(.compose-card)` is not
 * flagged for *naming* `.compose-card`; excluding a surface is the point.
 *
 * Exit code 1 if a runecircuit selector's own class list intersects that set.
 */

import { readFileSync } from 'node:fs'

const APP_CSS = 'src/styles/app.css'
const text = readFileSync(APP_CSS, 'utf8')

// Comments blanked, newlines kept, so line numbers still point at real code —
// same approach `check-css-tokens.mjs` uses.
const clean = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
const lines = clean.split('\n')

// --- derive the reading-surface class set ------------------------------------

const READING_SURFACES = new Set([
  // Not `max-width: var(--reading-max)` themselves, but reading-only by what
  // they hold: the compose message body, the message reader's rendered HTML,
  // and the list-row prose classes app.css's own "nothing leaves its box"
  // section names as carrying "user-supplied and unbounded" text.
  '.compose-card',
  '.textarea--body',
  '.reader__frame',
  // `MessageBodyFrame` has two callers and only one of them takes the default
  // `reader__frame` class: the calendar's per-reminder body preview passes its
  // own. The plain-text fallback beside it and the day panel's untruncated
  // subject/recipient are the same kind of surface — sender-authored text, read
  // rather than glanced at.
  '.dayrow__previewframe',
  '.dayrow__previewtext',
  '.dayrow__subject',
  '.dayrow__who',
  '.job__name',
  '.job__from',
  '.job__meta',
  '.job__body',
  '.log__title',
  '.log__body',
  '.codecard__subject',
  '.codecard__main',
  '.codecard__meta',
  '.bin-row__subject',
  '.bin-row__text',
  '.bin-row__meta',
  '.attachment__body',
])

{
  let depth = 0
  let currentSelector = ''
  // A selector list is written one selector per line here, so the prelude has
  // to be accumulated until the line that opens the block. Reading only that
  // last line dropped every selector but the final one — `.view__inner p` was
  // silently missing from the set for exactly that reason.
  let prelude = ''
  lines.forEach((line) => {
    if (depth === 0) {
      const opensBrace = line.includes('{')
      if (opensBrace) {
        currentSelector = (prelude + line.slice(0, line.indexOf('{'))).trim()
        prelude = ''
      } else {
        prelude += line
      }
    } else if (currentSelector && /max-width:\s*var\(--reading-max\)/.test(line)) {
      for (const sel of currentSelector.split(',')) {
        const cls = sel.trim().match(/\.[a-zA-Z0-9_-]+/g)
        if (cls) cls.forEach((c) => READING_SURFACES.add(c))
      }
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth < 0) depth = 0
  })
}

// --- scan every runecircuit-scoped selector ----------------------------------

const problems = []

lines.forEach((line, i) => {
  if (!line.includes('[data-style="runecircuit"]')) return
  const braceAt = line.indexOf('{')
  const selectorPart = braceAt >= 0 ? line.slice(0, braceAt) : line
  if (!selectorPart.trim() || selectorPart.trim().startsWith('/*')) return

  for (const rawSelector of selectorPart.split(',')) {
    // `:not(.compose-card)` names the class it excludes — strip `:not(...)`
    // before looking for a hit, or every correctly-scoped exclusion in this
    // file would flag itself.
    const selector = rawSelector.replace(/:not\([^)]*\)/g, '')
    const classes = selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []
    for (const cls of classes) {
      if (READING_SURFACES.has(cls)) {
        problems.push({ line: i + 1, selector: rawSelector.trim(), cls })
      }
    }
  }
})

for (const p of problems) {
  console.log(`  FAIL  ${APP_CSS}:${p.line} — "${p.selector}" reaches reading surface "${p.cls}"`)
}

console.log(
  `\n  ${READING_SURFACES.size} reading-surface classes known · ${problems.length} runecircuit selector(s) touching one`,
)

if (problems.length > 0) process.exit(1)
console.log('\n  All clear — no runecircuit selector reaches a reading surface.')
