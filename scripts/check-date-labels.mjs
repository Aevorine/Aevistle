/**
 * Every date this app formats, in every language it ships — does `Intl` accept
 * it? — `npm run check:date-labels`
 *
 * ===========================================================================
 * The bug
 *
 * `formatDateTime` spread its caller's options over `{dateStyle: 'medium',
 * timeStyle: 'short'}`. `Intl.DateTimeFormat` treats the styles and the
 * individual components (`weekday`, `month`, `hour` …) as two mutually
 * exclusive ways of asking for the same thing, and combining them does not
 * degrade — it throws `TypeError: Invalid option : option` out of the
 * constructor, in all six locales.
 *
 * `InboxView`'s day separators ask for `{weekday: 'long'}` on any message
 * between two and six days old. The merge turned that into the forbidden
 * combination, the throw happened inside a React render, `ErrorBoundary` caught
 * it, and *the whole inbox screen went blank* — on the desktop, on the phone
 * and on the tablet, because it is one piece of shared renderer code. It
 * shipped in 0.3.29 and survived 0.3.30, 0.3.31 and 0.3.32.
 *
 * ===========================================================================
 * Why nothing caught it, and what this gate does differently
 *
 * Every fixture in this repository seeds messages minutes apart, so no probe
 * ever produced a message old enough to reach the `weekday` branch. The screen
 * rendered, the checks passed, and the app was blank for anyone with a mailbox
 * older than 48 hours. `npm run check:inbox-reader` covers the *reader's* body
 * region and could not see this, because the crash is one level up — the list
 * that reader is opened from never rendered at all.
 *
 * So this gate does not test a fixture. It does two things a fixture cannot:
 *
 *   1. **Every label a real mailbox produces.** `dayLabel` is called for
 *      offsets from "this minute" out past a year, in every locale, at hours
 *      that straddle local midnight — so the `weekday` branch is reached by
 *      construction rather than by luck.
 *
 *   2. **Every option shape the source actually writes.** The `formatDateTime(
 *      …, { … })` literals are read out of `src/` and each one is put through
 *      the real formatter in every locale. A new call site is covered the day
 *      it is written, without anybody remembering this file exists — which is
 *      the property the previous gates lacked.
 *
 * Both layers assert against the shipping `createI18n`, not a copy of its
 * arithmetic: reverting the fix in `src/i18n/index.ts` must turn this red, and
 * that has been confirmed by doing it.
 */

// A zone with daylight saving and a negative offset, so `startOfDay` is being
// exercised rather than agreed with — the same reason the calendar gates pin it.
process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-datelabels-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-datelabels-'))
}

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    external: ['react', 'react-dom'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const failures = []
let checked = 0
const fail = (what, why) => {
  failures.push(`${what} — ${why}`)
  console.log(`  FAIL  ${what}\n        ${why}`)
}
const ok = (what) => {
  checked++
  console.log(`  ok    ${what}`)
}

try {
  const i18n = await load('src/i18n/index.ts', 'i18n')
  const days = await load('src/core/mail/dayGroups.ts', 'dayGroups')

  const locales = i18n.LOCALES.map((l) => l.id)
  if (locales.length === 0) {
    fail('locales', 'LOCALES is empty, so nothing below tested anything')
  }

  // -------------------------------------------------------------------------
  // 1 — every separator a real mailbox produces
  // -------------------------------------------------------------------------

  /**
   * The list `InboxView.dayLabelText` is, without React.
   *
   * Copied in shape but not in substance: every branch calls the *real*
   * `formatDateTime`, which is the function under test. A `today` label needs
   * no formatter and is included anyway, so the set of kinds this walks is the
   * set the type declares rather than the subset that happens to be
   * interesting.
   */
  const labelText = (fmt, t, label) => {
    if (label.kind === 'today') return t('inbox.day.today')
    if (label.kind === 'yesterday') return t('inbox.day.yesterday')
    if (label.kind === 'weekday') return fmt(label.at, { weekday: 'long' })
    return fmt(label.at, { dateStyle: 'medium' })
  }

  /**
   * Offsets in days, from this minute out past a year.
   *
   * 2 through 6 are the `weekday` window and are named individually rather
   * than sampled — that is the branch this whole file exists for, and a stride
   * that skipped one of them would be a gate with a hole exactly where the bug
   * was.
   */
  const DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 30, 89, 200, 400]
  /**
   * And where in the day. 00:30 and 23:30 land either side of local midnight,
   * which is where `daysBetween` earns its `startOfDay` and where an off-by-one
   * would put a message in the wrong bucket — including into `weekday` from a
   * test that thought it was asking for `yesterday`.
   */
  const HOURS = [0.5, 9, 13, 23.5]

  const now = new Date(2026, 7, 21, 14, 30, 0).getTime()
  const kindsSeen = new Set()

  for (const locale of locales) {
    const { formatDateTime, t } = i18n.createI18n(locale)
    let thrown = null
    let labels = 0
    for (const offset of DAY_OFFSETS) {
      for (const hour of HOURS) {
        const at = now - offset * 86_400_000 - (14.5 - hour) * 3_600_000
        const label = days.dayLabel(at, now)
        kindsSeen.add(label.kind)
        try {
          const text = labelText(formatDateTime, t, label)
          if (typeof text !== 'string' || text.length === 0) {
            thrown = `${label.kind} at -${offset}d ${hour}h produced no text`
            break
          }
          labels++
        } catch (e) {
          thrown = `${label.kind} at -${offset}d ${hour}h threw ${e?.constructor?.name}: ${e?.message}`
          break
        }
      }
      if (thrown) break
    }
    if (thrown) fail(`inbox day separators in ${locale}`, thrown)
    else ok(`inbox day separators in ${locale} — ${labels} labels, none threw`)
  }

  /* The gate has to have *reached* the branch, not merely not-failed. A
     `dayLabel` that stopped emitting `weekday` would silently turn every check
     above into a check of nothing, which is the failure mode this repository
     has recorded a dozen times. */
  for (const kind of ['today', 'yesterday', 'weekday', 'date']) {
    if (kindsSeen.has(kind)) ok(`the offsets above actually produced a '${kind}' separator`)
    else fail(`coverage of '${kind}'`, 'no offset in this gate produces that label, so it was never tested')
  }

  // -------------------------------------------------------------------------
  // 2 — every option shape the source writes
  // -------------------------------------------------------------------------

  /** Every `.ts`/`.tsx` under `src/`, minus this repository's own i18n module. */
  const walk = (root) => {
    const out = []
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  /**
   * Pull the object literal out of every `formatDateTime(x, { … })`.
   *
   * Braces are counted rather than matched with a regex, so a nested object or
   * a `{ n }` interpolation inside the literal does not truncate it. A call
   * whose options are not a literal — a variable, a spread — is skipped and
   * counted, and the count is printed: an unreadable call site is a limit of
   * this gate and is stated rather than hidden.
   */
  const shapes = []
  let unreadable = 0
  for (const file of walk('src')) {
    if (file.replace(/\\/g, '/').endsWith('src/i18n/index.ts')) continue
    const source = readFileSync(file, 'utf8')
    const call = /formatDateTime\s*\(/g
    let match
    while ((match = call.exec(source))) {
      const comma = source.indexOf(',', match.index)
      if (comma < 0) continue
      const brace = source.indexOf('{', comma)
      const close = source.indexOf(')', comma)
      if (brace < 0 || (close >= 0 && close < brace)) continue
      let depth = 0
      let end = -1
      for (let i = brace; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      if (end < 0) continue
      const literal = source.slice(brace, end + 1)
      let value
      try {
        value = new Function(`return (${literal})`)()
      } catch {
        unreadable++
        continue
      }
      if (value && typeof value === 'object') {
        shapes.push({ file: file.replace(/\\/g, '/'), literal: literal.replace(/\s+/g, ' '), value })
      }
    }
  }

  if (shapes.length === 0) {
    fail(
      'source scan',
      'found no `formatDateTime(…, { … })` call site in src/ — the scan broke, so layer 2 tested nothing',
    )
  } else {
    ok(`read ${shapes.length} option literals out of src/ (${unreadable} call site(s) not a literal, skipped)`)
  }

  for (const locale of locales) {
    const { formatDateTime } = i18n.createI18n(locale)
    let bad = null
    for (const shape of shapes) {
      try {
        const text = formatDateTime(now, shape.value)
        if (typeof text !== 'string' || text.length === 0) {
          bad = `${shape.file} ${shape.literal} produced no text`
          break
        }
      } catch (e) {
        bad = `${shape.file} ${shape.literal} threw ${e?.constructor?.name}: ${e?.message}`
        break
      }
    }
    if (bad) fail(`source option shapes in ${locale}`, bad)
    else ok(`source option shapes in ${locale} — all ${shapes.length} accepted by Intl`)
  }

  // -------------------------------------------------------------------------
  // 3 — the rule itself, stated directly
  // -------------------------------------------------------------------------

  /*
   * Layers 1 and 2 test what the app writes today. This tests the guarantee
   * `formatDateTime` now makes, so a future call site nobody has written yet is
   * covered too: naming a component must never reach `Intl` with a style
   * beside it, whatever the caller passed.
   */
  const COMPONENTS = [
    { weekday: 'long' },
    { month: 'numeric', day: 'numeric' },
    { hour: '2-digit', minute: '2-digit' },
    { year: 'numeric' },
    { timeZoneName: 'short' },
    // The nastiest shape: a caller that names both families itself. The helper
    // has to drop the style rather than forward the pair into the constructor.
    { dateStyle: 'full', weekday: 'long' },
    { timeStyle: 'short', hour: 'numeric' },
  ]
  for (const locale of locales) {
    const { formatDateTime } = i18n.createI18n(locale)
    let bad = null
    for (const opts of COMPONENTS) {
      try {
        const text = formatDateTime(now, opts)
        if (typeof text !== 'string' || text.length === 0) bad = `${JSON.stringify(opts)} produced no text`
      } catch (e) {
        bad = `${JSON.stringify(opts)} threw ${e?.constructor?.name}: ${e?.message}`
      }
      if (bad) break
    }
    if (bad) fail(`component options in ${locale}`, bad)
    else ok(`component options in ${locale} — the style defaults stayed out of the way`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.log(`  FAIL — ${failures.length} problem(s), ${checked} check(s) passed`)
  process.exit(1)
}
console.log(`  PASS — ${checked} check(s)`)
