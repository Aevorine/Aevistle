/**
 * Do the six locales still agree with each other?
 *
 * `en.ts` defines the key type, so a key missing from *it* is a compile error
 * and TypeScript already has that covered. The other five are plain records of
 * the same type, and TypeScript is happy to let them be incomplete: a key added
 * to English and forgotten in Arabic renders as the raw key string on screen,
 * at runtime, only for users in that language. Nothing fails, nothing warns.
 *
 * Duplicate keys are the other half. A locale file is one big object literal,
 * so a repeated key silently takes the last value — and when the two spellings
 * differ, which one wins depends on where in the file they landed. Adding four
 * keys across six files by script is exactly how that happens, and it did.
 *
 * Also checked: placeholders. `{n}` in English and no `{n}` in Russian is a
 * count that renders as a sentence with a hole in it.
 *
 * Exit code 1 if anything needs attention.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'src', 'i18n')
const BASE = 'en'

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

/**
 * Keys in file order, duplicates included.
 *
 * A regex rather than an import because these files are TypeScript and this
 * has to see the *source* — an imported object has already collapsed its
 * duplicates, which is the very thing being looked for.
 */
function keysOf(source) {
  const keys = []
  // Quoted key at the start of a line, then a colon. Covers both `'a.b':` and
  // the occasional double-quoted one; skips anything indented deeper, which is
  // a nested object rather than a translation key.
  const re = /^ {2}(['"])([^'"]+)\1\s*:/gm
  let m
  while ((m = re.exec(source))) keys.push(m[2])
  return keys
}

/**
 * Interpolation slots only — `{n}`, `{name}`.
 *
 * `{{…}}` is stripped first. That is the app's *merge variable* syntax, and
 * several strings show it to the user literally ("the message contains
 * {{variables}} but merging is off"). Matching the inner braces of those made
 * this check fire on English, French and Spanish but not Chinese, Russian or
 * Arabic — because the inner word is only `[a-zA-Z0-9_]` in the Latin ones. The
 * result looked exactly like three broken translations and was three false
 * positives.
 */
const placeholders = (value) =>
  (value.replace(/\{\{[\s\S]*?\}\}/g, '').match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(',')

/** Key → raw value text, last one wins, matching what the object literal does. */
function valuesOf(source) {
  const out = new Map()
  const re = /^ {2}(['"])([^'"]+)\1\s*:\s*([\s\S]*?),\s*$/gm
  let m
  while ((m = re.exec(source))) out.set(m[2], m[3])
  return out
}

const locales = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .map((f) => f.replace(/\.ts$/, ''))

check('the base locale must exist', locales.includes(BASE))
check('all six shipped languages must be present', locales.length >= 6)

const sources = new Map(locales.map((l) => [l, readFileSync(path.join(DIR, `${l}.ts`), 'utf8')]))
const keys = new Map(locales.map((l) => [l, keysOf(sources.get(l))]))
const values = new Map(locales.map((l) => [l, valuesOf(sources.get(l))]))

// --- duplicates -------------------------------------------------------------

for (const locale of locales) {
  const seen = new Set()
  const dups = new Set()
  for (const k of keys.get(locale)) {
    if (seen.has(k)) dups.add(k)
    seen.add(k)
  }
  check(
    `${locale}.ts must not define the same key twice (${[...dups].slice(0, 4).join(', ')})`,
    dups.size === 0,
  )
}

// --- parity -----------------------------------------------------------------

const baseKeys = new Set(keys.get(BASE))
check('the base locale must have keys at all', baseKeys.size > 100)

for (const locale of locales) {
  if (locale === BASE) continue
  const mine = new Set(keys.get(locale))
  const missing = [...baseKeys].filter((k) => !mine.has(k))
  const extra = [...mine].filter((k) => !baseKeys.has(k))
  check(
    `${locale}.ts is missing ${missing.length} key(s) (${missing.slice(0, 4).join(', ')})`,
    missing.length === 0,
  )
  check(
    `${locale}.ts has ${extra.length} key(s) English does not (${extra.slice(0, 4).join(', ')})`,
    extra.length === 0,
  )
}

// --- placeholders -----------------------------------------------------------

for (const locale of locales) {
  if (locale === BASE) continue
  const mismatched = []
  for (const [key, value] of values.get(BASE)) {
    const mine = values.get(locale).get(key)
    if (mine === undefined) continue
    if (placeholders(value) !== placeholders(mine)) mismatched.push(key)
  }
  check(
    `${locale}.ts placeholders must match English (${mismatched.slice(0, 4).join(', ')})`,
    mismatched.length === 0,
  )
}

// --- placeholders that nobody fills in --------------------------------------
//
// The parity check above only asks whether the six locales agree with each
// other. All six agreeing on a `{y}` that no call site ever supplies is still
// a literal `{y}` on screen, in every language at once — which is how
// `workcal.presetsHint` shipped its first draft.
//
// Only single-argument `t('key')` calls are inspected. A call with a second
// argument is passing *something*, and deciding whether it passes the right
// names would mean parsing the object literal — more machinery than this earns.

const CALLERS = ['src']
const sourceFiles = []
const walk = (dir) => {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(rel)
    else if (/\.tsx?$/.test(entry.name) && !rel.startsWith('src/i18n')) sourceFiles.push(rel)
  }
}
for (const dir of CALLERS) walk(dir)

const bare = new Set()
for (const file of sourceFiles) {
  const text = readFileSync(path.join(ROOT, file), 'utf8')
  // `t('some.key')` with nothing after it. The negative lookahead on `,` is
  // what separates "no arguments" from "arguments given".
  const re = /\bt\(\s*(['"])([^'"]+)\1\s*\)/g
  let m
  while ((m = re.exec(text))) bare.add(m[2])
}

const unfilled = [...bare].filter((key) => {
  const value = values.get(BASE).get(key)
  return value !== undefined && placeholders(value) !== ''
})
check(
  `every placeholder must be given a value (${unfilled.slice(0, 4).join(', ')})`,
  unfilled.length === 0,
)

// --- keys nothing can reach -------------------------------------------------
//
// The checks above all run in one direction: is every key that exists here
// present, consistent and filled in. None of them asks whether anything ever
// renders it. Thirty-six did not — a screen's `hint` prop had been dropped in
// an earlier round and the sentence stayed behind, translated six times, for a
// UI element that no longer asked for it. Six translators' worth of work on
// text no user could see, and nothing anywhere said so.
//
// Three ways a key is legitimately reached, all of which occur in this repo:
//
//   1. a literal        t('codes.title'), or the key travelling as a prop
//   2. a template       t(`condition.kind.${kind}`)  -> prefix condition.kind.
//   3. concatenation    'codes.reason.' + reason     -> prefix codes.reason.
//
// Literals are matched anywhere in the file, not only inside `t(...)`: keys are
// passed as props (`summary.key`), returned from helpers (`purposeKey`) and
// listed in tuple arrays. Over-matching here is the safe direction — a key
// wrongly called dead gets deleted and renders as raw `foo.bar` on screen.
//
// `src/i18n/index.ts` is scanned, unlike the parity walk above which skips all
// of src/i18n. It is itself a caller: `formatRelative` and `formatAgo`
// translate the nine time.* keys, and excluding it reports all nine as dead.

// `android` is in the list because the native scheduler is a caller too: a send
// condition it blocks on emits a `skipReasonKey`, which the web layer renders
// through `t()`. Leaving it out reports every Java-only reason key as dead.
const REACH_DIRS = ['src', 'electron', 'scripts', 'tests', 'android/app/src/main/java']
const RECORD_FILES = new Set(locales.map((l) => `src/i18n/${l}.ts`))

/**
 * Keys deliberately kept despite having no caller, with the reason. An entry
 * here is a decision someone made, not an exemption to be handed out freely.
 */
const KEEP_UNREACHED = new Map([
  ['home.subtitle', 'the home screen was raised with the user, who asked for it to be left alone'],
])

const reachFiles = []
const reachWalk = (dir) => {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.name === 'node_modules') continue
    if (entry.isDirectory()) reachWalk(rel)
    else if (/\.(tsx?|mjs|java)$/.test(entry.name) && !RECORD_FILES.has(rel)) reachFiles.push(rel)
  }
}
for (const dir of REACH_DIRS) {
  try {
    reachWalk(dir)
  } catch {
    // An optional tree (`tests` is not present in every checkout) is not a
    // failure — it just contributes no call sites.
  }
}

const seenLiterals = new Set()
const seenPrefixes = new Set()
for (const file of reachFiles) {
  const text = readFileSync(path.join(ROOT, file), 'utf8')
  for (const m of text.matchAll(/(['"])([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+)+)\1/g)) {
    seenLiterals.add(m[2])
  }
  for (const m of text.matchAll(/`([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+)*\.?)\$\{/g)) {
    seenPrefixes.add(m[1])
  }
  for (const m of text.matchAll(/(['"])([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+)*\.)\1\s*\+/g)) {
    seenPrefixes.add(m[2])
  }
}

const unreached = [...baseKeys].filter(
  (key) =>
    !KEEP_UNREACHED.has(key) &&
    !seenLiterals.has(key) &&
    ![...seenPrefixes].some((p) => p.length > 0 && key.startsWith(p)),
)
check(
  `every key must be reachable from some code path (${unreached.length}: ${unreached
    .slice(0, 4)
    .join(', ')})`,
  unreached.length === 0,
)

// ---------------------------------------------------------------------------

const label = 'the six locales agree'
if (failures.length === 0) {
  console.log(
    `\n  ${label}\n  ${checked} checks across ${locales.length} locales, ${baseKeys.size} keys\n\n  All clear.\n`,
  )
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
