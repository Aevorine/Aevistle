/**
 * A visual style is four things in four files, and nothing checks that all four
 * arrived.
 *
 * `VisualStyle` in `core/types.ts` is the list of looks the app claims to have.
 * A value in that union only becomes a real style if theme.css also carries its
 * shape rule, its light, dark and `prefers-color-scheme: dark` colour rules —
 * each restating every theme-scoped token, as the section header in that file
 * says they must — and its stylecard preview; and if `SettingsView.tsx` lists it
 * in `STYLES` with a label key the six locales all translate. Miss the dark
 * block and the style silently keeps the previous style's dark palette. Miss the
 * `prefers-color-scheme` twin and it is correct until the user leaves the theme
 * on "match system". Miss the `STYLES` entry and the style exists, is storable,
 * is reachable by editing settings.json, and cannot be chosen. TypeScript sees
 * none of this: the union is a union of strings, and CSS is not typed.
 *
 * Also here, because it is the same question asked of one file instead of four:
 * `check-css-tokens.mjs` proves every `var(--x)` names a token that is *defined
 * somewhere*, which is not the same as defined *where it is read*. A token
 * declared only inside `:root[data-style="runecircuit"]` is absent under the
 * other six styles, so a `.card { color: var(--that) }` outside the block passes
 * that check and paints nothing six times out of seven. That is the same class
 * of bug — an invalid custom property is dropped in silence — one scope deeper.
 *
 * `--selftest` injects a missing dark block, a style theme.css knows and the
 * union does not, a style Settings never offers, and two out-of-scope token
 * reads, and requires this to go red on each.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { concatenatedAppCss } from './lib/stylesheets.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const selftest = process.argv.includes('--selftest')

const THEME_CSS = 'src/styles/theme.css'
const APP_CSS = 'src/styles/app.css'
const TYPES_TS = 'src/core/types.ts'
const SETTINGS_TSX = 'src/views/SettingsView.tsx'
const LOCALES = ['en', 'zh-CN', 'fr', 'es', 'ru', 'ar']

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

const failures = []
const warnings = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

// --- sources ----------------------------------------------------------------

let themeCss = read(THEME_CSS)
let settingsTsx = read(SETTINGS_TSX)
/* The concatenation, not the index: this check reasons about which rule
   wins across the whole stylesheet, and after the split no single file shows
   that. See lib/stylesheets.mjs. */
const appCss = concatenatedAppCss()
const typesTs = read(TYPES_TS)

if (selftest) {
  themeCss = themeCss
    .replace(':root[data-style="midnight"][data-theme="dark"] {', ':root[data-style="selftest-gone"] {')
    .concat(
      '\n:root[data-style="selftest-orphan"] { --bg: #000000; }\n',
      '.selftest-leak { color: var(--classical-ink-l); }\n',
      ':root[data-style="paper"] .selftest-cross { border-color: var(--circuit-trace); }\n',
    )
}

/** Comments blanked, newlines kept, so reported line numbers still land on real
 *  code — the approach `check-css-tokens.mjs` established. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))

/**
 * Every brace-delimited block, with its prelude, the at-rules it sits inside,
 * and its own declarations.
 *
 * Quoted runs are stepped over whole: `--texture-grain` holds an inline SVG
 * data URI, and a `{`, `}` or `;` inside a string is not structure.
 */
function parseBlocks(text) {
  const clean = stripComments(text)
  const blocks = []
  const open = []
  let buf = ''
  let bufLine = 0
  let line = 1

  const note = (ch) => {
    if (buf.trim() === '' && ch.trim() !== '') bufLine = line
    buf += ch
  }
  const flushDecl = () => {
    const decl = buf.trim()
    buf = ''
    if (!decl || open.length === 0) return
    const at = decl.indexOf(':')
    if (at < 0) return
    open[open.length - 1].decls.push({
      prop: decl.slice(0, at).trim(),
      value: decl.slice(at + 1).trim(),
      line: bufLine,
    })
  }

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '"' || ch === "'") {
      const end = clean.indexOf(ch, i + 1)
      const run = clean.slice(i, end < 0 ? clean.length : end + 1)
      note(run)
      line += (run.match(/\n/g) ?? []).length
      i += run.length - 1
      continue
    }
    if (ch === '\n') {
      line++
      buf += ch
      continue
    }
    if (ch === '{') {
      const block = {
        prelude: buf.trim().replace(/\s+/g, ' '),
        parents: open.map((b) => b.prelude),
        line: bufLine || line,
        decls: [],
      }
      buf = ''
      open.push(block)
      blocks.push(block)
      continue
    }
    if (ch === '}') {
      flushDecl()
      open.pop()
      continue
    }
    if (ch === ';') {
      flushDecl()
      continue
    }
    note(ch)
  }
  return blocks
}

const sources = [
  { file: THEME_CSS, text: themeCss },
  { file: APP_CSS, text: appCss },
]
const blocks = sources.flatMap(({ file, text }) =>
  parseBlocks(text).map((b) => ({ ...b, file })),
)

/** The style ids a selector is gated on. `data-style-preview` does not match:
 *  the attribute name has to end right where the `=` begins. Negations are
 *  dropped first — `:not([data-style="paper"])` is the six styles that are not
 *  paper, which gates nothing. */
const stylesIn = (selector) =>
  [...selector.replace(/:not\([^)]*\)/g, '').matchAll(/\[data-style="([a-zA-Z0-9-]+)"\]/g)].map(
    (m) => m[1],
  )

/** A block's gate is its own selector's plus every enclosing selector's. */
const gateOf = (block) =>
  new Set([block.prelude, ...block.parents].flatMap(stylesIn))

// --- the union --------------------------------------------------------------

// Anchored on the members rather than on whatever declaration follows, so the
// union can move to the end of the file without this reading as "no union".
const unionMatch = typesTs.match(
  /export type VisualStyle =\s*\|?\s*'[a-zA-Z0-9-]+'(?:\s*\|\s*'[a-zA-Z0-9-]+')*/,
)
check(`${TYPES_TS} must declare a VisualStyle union`, unionMatch !== null)
const STYLES_DECLARED = unionMatch
  ? [...unionMatch[0].matchAll(/'([a-zA-Z0-9-]+)'/g)].map((m) => m[1])
  : []
check('the VisualStyle union must have members', STYLES_DECLARED.length > 1)

const declared = new Set(STYLES_DECLARED)

// --- theme.css: every style's four blocks -----------------------------------

/**
 * Which of the four rules a style block is.
 *
 * `aurora` has no rule of its own for shape — its radius ladder and rhythm are
 * the base `:root` values, deliberately, so an install that was never given a
 * style keeps the interface it had. So the shape rule is the one of the four
 * that is allowed to be absent; the three colour rules are not, because there
 * is no such thing as inheriting half a palette from whichever style happened
 * to be written above you in the file.
 */
function kindOf(block) {
  const sel = block.prelude
  // `:not([data-theme="light"])` contains the light selector as a substring and
  // means the opposite of it, so the negations come out before anything is
  // matched — the whole prefers-color-scheme group reads as "light" otherwise.
  const asserted = sel.replace(/:not\([^)]*\)/g, '')
  const inPrefersDark = block.parents.some((p) => /prefers-color-scheme:\s*dark/.test(p))
  if (/\[data-accent(-base|-cyber)?[="]/.test(asserted)) return 'accent'
  if (asserted.includes('[data-theme="light"]')) return 'light'
  if (asserted.includes('[data-theme="dark"]')) return 'dark'
  if (inPrefersDark && sel.includes(':not([data-theme="light"])')) return 'prefers'
  if (inPrefersDark) return 'other'
  return 'shape'
}

// `accent` and `other` blocks are deliberately absent from this: the two-axis
// accent rules set two tokens each and are not palettes, so the parity checks
// below have to skip them rather than read them as a style falling short.
const styleBlocks = new Map(
  STYLES_DECLARED.map((id) => [id, { light: [], dark: [], prefers: [], shape: [] }]),
)

for (const block of blocks) {
  // `:root` only: app.css scopes plenty of ordinary selectors on `data-style`,
  // and those are not the style's palette.
  if (!block.prelude.includes(':root')) continue
  for (const id of new Set(stylesIn(block.prelude))) {
    const bucket = styleBlocks.get(id)
    if (!bucket) continue
    const kind = kindOf(block)
    if (bucket[kind]) bucket[kind].push(block)
  }
}

for (const id of STYLES_DECLARED) {
  const bucket = styleBlocks.get(id)
  for (const kind of ['light', 'dark', 'prefers']) {
    check(
      `${THEME_CSS} has no ${kind} colour rule for style "${id}"`,
      bucket[kind].length > 0,
    )
  }
}

// --- theme.css: styles the union has never heard of -------------------------

const seenInCss = new Map()
for (const block of blocks) {
  for (const id of stylesIn(block.prelude)) {
    if (!seenInCss.has(id)) seenInCss.set(id, `${block.file}:${block.line}`)
  }
}
for (const [id, where] of seenInCss) {
  check(
    `"${id}" is styled at ${where} but is not a member of VisualStyle`,
    declared.has(id),
  )
}

// --- theme.css: each colour rule restates the whole palette -----------------
//
// The section header in theme.css says every colour rule restates all the
// theme-scoped tokens, and means it: a style that inherited half its dark
// palette from the base theme would be a style only where it disagreed, and the
// disagreements are exactly what a reader cannot see from one block. The base
// `:root, :root[data-theme="light"]` rule is the list of what "all" means.

const tokensOf = (list) =>
  new Set(list.flatMap((b) => b.decls.filter((d) => d.prop.startsWith('--')).map((d) => d.prop)))

const baseLight = blocks.find(
  (b) =>
    b.file === THEME_CSS &&
    b.prelude.includes(':root[data-theme="light"]') &&
    stylesIn(b.prelude).length === 0,
)
check(`${THEME_CSS} must have a base light theme rule to compare styles against`, Boolean(baseLight))

const PALETTE = baseLight ? tokensOf([baseLight]) : new Set()
check('the base light theme rule must define the palette', PALETTE.size > 10)

for (const id of STYLES_DECLARED) {
  const bucket = styleBlocks.get(id)
  for (const kind of ['light', 'dark', 'prefers']) {
    if (bucket[kind].length === 0) continue
    const mine = tokensOf(bucket[kind])
    const missing = [...PALETTE].filter((t) => !mine.has(t))
    check(
      `style "${id}" ${kind} rule leaves ${missing.length} palette token(s) to whatever came before it (${missing.slice(0, 5).join(', ')})`,
      missing.length === 0,
    )
  }
  // The `prefers-color-scheme` rule is a copy of the explicit dark one by
  // construction. Copies drift, and this one drifts invisibly: it is only ever
  // on screen for users who left the theme on "match system".
  if (bucket.dark.length && bucket.prefers.length) {
    const dark = tokensOf(bucket.dark)
    const pref = tokensOf(bucket.prefers)
    const only = [...dark].filter((t) => !pref.has(t))
    const extra = [...pref].filter((t) => !dark.has(t))
    check(
      `style "${id}" sets ${only.length} token(s) in its dark rule that its prefers-color-scheme twin does not (${only.slice(0, 5).join(', ')})`,
      only.length === 0,
    )
    check(
      `style "${id}" sets ${extra.length} token(s) only in its prefers-color-scheme rule (${extra.slice(0, 5).join(', ')})`,
      extra.length === 0,
    )
  }
  // The shape rule is theme-independent by construction — it is where corners
  // and rhythm go precisely because they have no business changing when the sun
  // goes down. A palette token landing in it is a colour that stops changing
  // too, and it outranks nothing, so the effect is one theme's colour showing
  // under both.
  const inShape = [...tokensOf(bucket.shape)].filter((t) => PALETTE.has(t))
  check(
    `style "${id}" sets ${inShape.length} palette token(s) in its theme-independent shape rule (${inShape.slice(0, 5).join(', ')})`,
    inShape.length === 0,
  )
}

// --- theme.css: the stylecard previews --------------------------------------
//
// A tile has to paint a style the page is not currently in, so it cannot use
// `var(--bg)` — it carries its own `--preview-*` copy. A style with no tile is
// a blank square in Settings.

const previewsIn = (selector) =>
  [...selector.matchAll(/\[data-style-preview="([a-zA-Z0-9-]+)"\]/g)].map((m) => m[1])

const previewBlocks = { base: new Map(), dark: new Map(), prefers: new Map() }
for (const block of blocks) {
  const ids = previewsIn(block.prelude)
  if (ids.length === 0) continue
  const inPrefersDark = block.parents.some((p) => /prefers-color-scheme:\s*dark/.test(p))
  const group = block.prelude.includes('[data-theme="dark"]')
    ? 'dark'
    : inPrefersDark
      ? 'prefers'
      : 'base'
  for (const id of ids) {
    if (!previewBlocks[group].has(id)) previewBlocks[group].set(id, [])
    previewBlocks[group].get(id).push(block)
  }
  for (const id of ids) {
    check(
      `"${id}" has a style preview at ${block.file}:${block.line} but is not a member of VisualStyle`,
      declared.has(id),
    )
  }
}

const PREVIEW_TOKENS = new Set([...previewBlocks.base.values()].flatMap((l) => [...tokensOf(l)]))
check('the style previews must define preview tokens', PREVIEW_TOKENS.size > 3)

for (const id of STYLES_DECLARED) {
  const base = previewBlocks.base.get(id) ?? []
  check(`style "${id}" has no stylecard preview in ${THEME_CSS}`, base.length > 0)
  if (base.length === 0) continue
  const mine = tokensOf(base)
  const missing = [...PREVIEW_TOKENS].filter((t) => !mine.has(t))
  check(
    `style "${id}"'s preview tile is missing ${missing.length} token(s) (${missing.slice(0, 5).join(', ')})`,
    missing.length === 0,
  )
}

/**
 * The two dark preview groups have to cover the same styles as each other.
 *
 * Not "every style needs a dark preview": `midnight` deliberately has neither,
 * because the tile is already showing the committed dark form it is advertising.
 * What is never deliberate is a style appearing in one of the two dark
 * mechanisms and not the other — that is a tile that is right until the user
 * stops choosing a theme by hand.
 */
{
  const dark = [...previewBlocks.dark.keys()].sort()
  const prefers = [...previewBlocks.prefers.keys()].sort()
  const onlyDark = dark.filter((id) => !previewBlocks.prefers.has(id))
  const onlyPrefers = prefers.filter((id) => !previewBlocks.dark.has(id))
  check(
    `preview tile(s) with a [data-theme="dark"] rule and no prefers-color-scheme twin (${onlyDark.join(', ')})`,
    onlyDark.length === 0,
  )
  check(
    `preview tile(s) with a prefers-color-scheme rule and no [data-theme="dark"] twin (${onlyPrefers.join(', ')})`,
    onlyPrefers.length === 0,
  )
}

// --- SettingsView: the picker -----------------------------------------------

if (selftest) {
  settingsTsx = settingsTsx.replace(/^ *\{ id: 'nordic',[^\n]*\r?\n/m, '')
}

const arrayMatch = settingsTsx.match(/const STYLES\b[^[]*\[([\s\S]*?)\n\]/)
check(`${SETTINGS_TSX} must declare a STYLES array`, arrayMatch !== null)

const registered = arrayMatch
  ? [...arrayMatch[1].matchAll(/\{\s*id:\s*'([a-zA-Z0-9-]+)',\s*labelKey:\s*'([^']+)'\s*\}/g)].map(
      (m) => ({ id: m[1], labelKey: m[2] }),
    )
  : []

const registeredIds = registered.map((r) => r.id)
const unregistered = STYLES_DECLARED.filter((id) => !registeredIds.includes(id))
const unknown = registeredIds.filter((id) => !declared.has(id))
const duplicated = registeredIds.filter((id, i) => registeredIds.indexOf(id) !== i)

check(
  `style(s) in VisualStyle that Settings never offers (${unregistered.join(', ')})`,
  unregistered.length === 0,
)
check(
  `STYLES offers ${unknown.length} style(s) VisualStyle does not name (${unknown.join(', ')})`,
  unknown.length === 0,
)
check(`STYLES lists the same style twice (${duplicated.join(', ')})`, duplicated.length === 0)

// --- the six locales translate every label ----------------------------------
//
// `check-i18n.mjs` proves the six locales agree with each other; it cannot know
// that `settings.style.runecircuit` is a key any of them was supposed to have.
// That comes from the union, and only from here.

const localeValues = new Map(
  LOCALES.map((locale) => {
    const source = read(path.join('src', 'i18n', `${locale}.ts`))
    const values = new Map()
    // The value pattern walks escapes rather than stopping at the first quote:
    // a label with an apostrophe in it is a translation, not a parse error, and
    // reading it as a missing key would be a failure invented by this script.
    for (const m of source.matchAll(/^ {2}(['"])([^'"]+)\1\s*:\s*(['"])((?:\\.|(?!\3).)*)\3,\s*$/gm)) {
      values.set(m[2], m[4])
    }
    return [locale, values]
  }),
)

for (const { id, labelKey } of registered) {
  const untranslated = LOCALES.filter((locale) => {
    const value = localeValues.get(locale).get(labelKey)
    return value === undefined || value.trim() === ''
  })
  check(
    `style "${id}"'s label ${labelKey} is missing or empty in ${untranslated.join(', ')}`,
    untranslated.length === 0,
  )
  // An untranslated locale is easy to spot when the string differs; five
  // locales sharing English's exact wording is the copy-paste that gets missed.
  const english = localeValues.get('en').get(labelKey)
  const copied = LOCALES.filter(
    (locale) => locale !== 'en' && localeValues.get(locale).get(labelKey) === english,
  )
  if (english && copied.length === LOCALES.length - 1) {
    warnings.push(
      `style "${id}"'s label reads "${english}" in all six locales — a proper name may be right, an untranslated one is not`,
    )
  }
}

// --- tokens read outside the style that defines them ------------------------
//
// `check-css-tokens.mjs` collects definitions into one flat set, so a token
// declared only inside `:root[data-style="runecircuit"]` reads as defined
// everywhere. It is not: under the other six styles the declaration that reads
// it is invalid at computed value time and the browser drops it — the same
// silence as a token that was never defined at all, which is the bug that check
// exists to catch.
//
// Restriction propagates through aliases. `:root { --x-now: var(--x-l) }` is
// unscoped, but if `--x-l` only exists under one style then `--x-now` only
// resolves under that style too, and so does anything reading `--x-now`.

const definitions = new Map()
const uses = []

for (const block of blocks) {
  const gate = gateOf(block)
  for (const decl of block.decls) {
    if (decl.prop.startsWith('--')) {
      if (!definitions.has(decl.prop)) definitions.set(decl.prop, [])
      definitions.get(decl.prop).push({ gate, block, decl })
    }
    // `var(--x, fallback)` is safe by construction — the fallback is the
    // definition for that read. Same carve-out `check-css-tokens.mjs` makes.
    for (const m of decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
      if (m[2] === ',') continue
      uses.push({ token: m[1], gate, block, decl, target: decl.prop })
    }
  }
}

/**
 * Style a token resolves only under, or null if it resolves everywhere.
 *
 * `null` is also the answer whenever the chain cannot be followed — a value
 * mixing a restricted read with an unrestricted one, a cycle. Under-reporting
 * is the right way to be wrong here: the failures below are meant to be worth
 * acting on every time, and a checker nobody believes is worse than one that
 * misses a case.
 */
const restrictedTo = new Map()
{
  const inProgress = new Set()
  const resolve = (token) => {
    if (restrictedTo.has(token)) return restrictedTo.get(token)
    if (inProgress.has(token)) return null
    inProgress.add(token)
    const answer = compute(token)
    inProgress.delete(token)
    restrictedTo.set(token, answer)
    return answer
  }
  const compute = (token) => {
    const sites = definitions.get(token) ?? []
    if (sites.length === 0) return null
    const gates = new Set()
    for (const site of sites) {
      if (site.gate.size > 0) {
        for (const id of site.gate) gates.add(id)
        continue
      }
      // Ungated, so it is only restricted if everything it is built from is.
      // Reads with a fallback do not count: they resolve on their own.
      const reads = [...site.decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)].map((m) => m[1])
      if (reads.length === 0) return null
      for (const via of reads) {
        const gate = resolve(via)
        if (!gate) return null
        gates.add(gate)
      }
    }
    return gates.size === 1 ? [...gates][0] : null
  }
  for (const token of definitions.keys()) resolve(token)
}

/**
 * A read is a failure when the declaration it feeds is a real CSS property and
 * the rule holding it is not gated on the style that defines the token — that
 * declaration is dropped under every other style, and `.card` exists under all
 * of them.
 *
 * A read that feeds another *custom property* in an ungated rule is not
 * reported: the alias is dead under the other styles too, but whether that
 * matters depends on who reads the alias, and the answer to that can be in TSX.
 * Restriction was propagated through it above, so the failure still lands if
 * the chain ever reaches a real property. Those chains are listed as warnings
 * instead, since only their call sites can settle them.
 */
const gatedAliases = new Map()
let scopedReads = 0
for (const use of uses) {
  const only = restrictedTo.get(use.token)
  if (!only) continue
  scopedReads++
  if (use.gate.has(only)) continue
  if (use.target.startsWith('--') && use.gate.size === 0) {
    if (!gatedAliases.has(only)) gatedAliases.set(only, new Set())
    gatedAliases.get(only).add(use.target)
    continue
  }
  const where =
    use.gate.size === 0
      ? 'a rule that matches under every style'
      : `[data-style="${[...use.gate].join('/')}"]`
  failures.push(
    `${use.block.file}:${use.decl.line} — "${use.decl.prop}" reads ${use.token}, which only exists under [data-style="${only}"], from ${where}`,
  )
}

/**
 * A gated alias is only correct if whoever reads it is gated on the same style.
 *
 * Those readers are in TSX, and they are built rather than spelled —
 * `var(--classical-${id}-now)`. So the token name is matched a segment at a
 * time, with `${…}` accepted in place of any segment, and the file that reads
 * it is asked to at least know the style's name. That is a weak proof and it is
 * meant to be: strong enough to stay quiet on `SettingsView.tsx`, which reads
 * these seven inside its `visualStyle === 'runecircuit'` branch, and to speak up
 * when a component with no notion of the style starts reading one.
 */
const CALLER_DIRS = ['src/views', 'src/components', 'src/core']
const callers = []
{
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(entry.name)) callers.push({ file: rel, text: read(rel) })
    }
  }
  for (const dir of CALLER_DIRS) walk(dir)
}

const readerPattern = (token) =>
  new RegExp(
    'var\\(\\s*' +
      token
        .slice(2)
        .split('-')
        .map((seg) => `(?:${seg}|\\$\\{[^}]*\\})`)
        .join('-')
        .replace(/^/, '--'),
  )

for (const [only, tokens] of gatedAliases) {
  const unread = []
  const ungated = []
  for (const token of [...tokens].sort()) {
    const pattern = readerPattern(token)
    const readers = callers.filter((c) => pattern.test(c.text))
    if (readers.length === 0) unread.push(token)
    else if (!readers.some((c) => c.text.includes(`'${only}'`))) ungated.push(token)
  }
  if (unread.length > 0) {
    warnings.push(
      `${unread.length} token(s) resolve only while data-style="${only}" and nothing outside CSS reads them (${unread.join(', ')})`,
    )
  }
  if (ungated.length > 0) {
    warnings.push(
      `${ungated.length} token(s) resolve only while data-style="${only}" but the code reading them never names that style, so the read may not be gated on it (${ungated.join(', ')})`,
    )
  }
}

// ---------------------------------------------------------------------------

const label = 'every visual style is complete in all four places'

if (selftest) {
  const wanted = [
    ['missing dark rule', (f) => f.includes('no dark colour rule for style "midnight"')],
    ['unregistered style', (f) => f.includes('Settings never offers (nordic)')],
    ['orphan style in CSS', (f) => f.includes('"selftest-orphan"') && f.includes('not a member of VisualStyle')],
    ['out-of-scope token read', (f) => f.includes('--classical-ink-l') && f.includes('every style')],
    ['token read from another style', (f) => f.includes('--circuit-trace') && f.includes('[data-style="paper"]')],
  ]
  const missed = wanted.filter(([, match]) => !failures.some(match)).map(([name]) => name)
  if (missed.length > 0) {
    console.log(`\n  SELFTEST FAILED — not caught: ${missed.join(', ')}`)
    for (const f of failures) console.log(`    saw: ${f}`)
    process.exit(1)
  }
  console.log(`\n  Selftest OK — all ${wanted.length} injected faults were caught.`)
  process.exit(0)
}

console.log(
  `\n  ${label}\n  ${checked} checks across ${STYLES_DECLARED.length} styles and ${LOCALES.length} locales · ${definitions.size} tokens, ${scopedReads} read of a style-scoped one\n`,
)
for (const f of failures) console.log(`  FAIL  ${f}`)
for (const w of warnings) console.log(`  WARN  ${w}`)
if (failures.length > 0) {
  console.log(`\n  ${failures.length} failed.\n`)
  process.exit(1)
}
console.log(`  All clear.\n`)
