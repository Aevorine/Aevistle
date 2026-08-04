/**
 * The gate on B3 — "送达窗口 / delivery window": a contact carrying a time zone
 * and working hours so a scheduled reminder lands during *their* day.
 *
 * `check:window` already proves the engine is right about the instant, with 147
 * assertions. This file exists because that has never been the failure this
 * project actually has. Three separate times a guard has gone green over code
 * that was written, exported, imported — and then never called: the three
 * `transport.ts` renderers, the `Recurrence.month` 0/1-based split that
 * `check:ics` could not see because it never crossed into the scheduler, and
 * the sync carry-forward that was computed and never spread. Every one of them
 * reads correctly in review and does nothing at run time.
 *
 * So this asserts **use**:
 *
 *   1. `ContactsView` really writes `deliveryWindow` onto the contact it saves,
 *      in the shape `applyDeliveryWindows` accepts — not "an editor exists".
 *   2. The editor computes its consequence from the engine, on the instant the
 *      *rule* asks for rather than on `job.occurrences` (which has already been
 *      through `applyDeliveryWindows` once, and would report "already inside
 *      this window" for every value anyone could type).
 *   3. The fault path renders, and says the window is **ignored** — because
 *      that is what happens. Nothing on that screen may imply mail is held.
 *   4. The compose marker exists, is fed by `To:` alone, and costs the message
 *      box no row: it is an inline sibling inside `.whenbar__text`, and the
 *      `.whenbar` / `.whenbar__quick` rules are untouched.
 *   5. The boundary: a contact built in the UI's shape, put through the UI's
 *      own `windowsForRecipients` and into `applyDeliveryWindows`, produces the
 *      instant it should. That is the crossing `check:ics` failed to make.
 *   6. Weekday numbering. `days` is `0 = Sunday` (`Date#getDay`) while the
 *      picker draws Monday-first — an off-by-one here means mail held on the
 *      wrong day, so both the drawing order and the stored value are asserted.
 *
 * `--selftest` breaks five things and requires this file to go red.
 *
 * Exit code 1 if anything needs attention.
 */

// Pinned before anything reads a clock. Shanghai is the sender's side of the
// case this feature exists for — "every Monday at 09:00" written here arrives
// at 03:00 in Los Angeles — and it is far enough east that an off-by-one in the
// zone arithmetic lands on a different calendar day instead of cancelling out.
process.env.TZ = 'Asia/Shanghai'

import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELFTEST = process.argv.includes('--selftest')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const FILES = {
  contacts: 'src/views/ContactsView.tsx',
  editor: 'src/components/DeliveryWindowEditor.tsx',
  picker: 'src/components/TimeZonePicker.tsx',
  preview: 'src/components/deliveryPreview.ts',
  compose: 'src/views/ComposeView.tsx',
}

/**
 * The known-bad versions, applied to the source text.
 *
 * Textual rather than a flag in the components, so the shipped files carry no
 * "make me wrong" switch: the guard proves it can catch a regression in code
 * that has no idea it is being tested. `preview` is the one file that is also
 * *bundled* from the modified text (see the mirror below), so breaking it fails
 * the boundary assertions rather than only a grep.
 */
const BREAKAGES = [
  {
    file: 'contacts',
    name: 'the editor no longer writes deliveryWindow onto the contact',
    from: 'onChange={(deliveryWindow) => setEditing({ ...editing, deliveryWindow })}',
    to: 'onChange={() => setEditing({ ...editing })}',
  },
  {
    file: 'preview',
    name: 'recipient matching stops normalising the address',
    from: 'for (const c of contacts) byAddress.set(c.address.trim().toLowerCase(), c)',
    to: 'for (const c of contacts) byAddress.set(c.address, c)',
  },
  {
    file: 'preview',
    name: 'the day picker is drawn Sunday-first',
    from: 'export const DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]',
    to: 'export const DAY_ORDER: readonly number[] = [0, 1, 2, 3, 4, 5, 6]',
  },
  {
    file: 'editor',
    name: 'the fault path never fires',
    from: '  const fault = faultOf(window)',
    to: '  const fault = null',
  },
  {
    file: 'compose',
    name: 'the compose marker leaves the sentence and becomes a row of its own',
    from: '<span className="whenbar__window" title={deliveryDetail}>',
    to: '<div className="deliverbar" title={deliveryDetail}>',
  },
]

const src = {}
for (const [key, rel] of Object.entries(FILES)) {
  src[key] = await readFile(path.join(root, rel), 'utf8')
}

if (SELFTEST) {
  for (const breakage of BREAKAGES) {
    if (!src[breakage.file].includes(breakage.from)) {
      console.error(
        `  SELFTEST CANNOT RUN: "${breakage.from}" is no longer in ${FILES[breakage.file]}.`,
      )
      process.exit(1)
    }
    src[breakage.file] = src[breakage.file].replace(breakage.from, breakage.to)
  }
}

const css = await readFile(path.join(root, 'src/styles/app.css'), 'utf8')
const LOCALES = ['en', 'zh-CN', 'fr', 'es', 'ru', 'ar']
const localeSources = new Map()
for (const locale of LOCALES) {
  localeSources.set(locale, await readFile(path.join(root, `src/i18n/${locale}.ts`), 'utf8'))
}

let failures = 0
let checks = 0
const problems = []

function ok(label, condition, detail = '') {
  checks++
  if (condition) return true
  failures++
  problems.push(`${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

// ---------------------------------------------------------------------------
// Helpers over the source text
// ---------------------------------------------------------------------------

/**
 * Blank out comments, keeping the line count.
 *
 * Every "this file must *not* contain X" assertion runs against this rather
 * than the raw text. Both of the negative checks below name the thing they are
 * forbidding in their own explanatory comment — the editor explains why it does
 * not read `job.occurrences`, the picker explains why it is not a `<datalist>` —
 * and a guard that fires on its own rationale is a guard nobody can write a
 * comment near.
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (whole, keep) => keep + ' '.repeat(whole.length - keep.length))

/** Comment-free versions, for the "must not contain" questions. */
const code = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, stripComments(v)]))

/** One top-level CSS rule by exact selector, body only. */
function ruleBody(source, selector) {
  const at = source.indexOf(`\n${selector} {`)
  if (at < 0) return null
  const end = source.indexOf('\n}', at)
  return end < 0 ? null : source.slice(at, end)
}

/** Keys defined by a locale file. */
function keysOf(source) {
  return [...source.matchAll(/^ {2}(['"])([^'"]+)\1\s*:/gm)].map((m) => m[2])
}

/** English values, so the wording of the fault messages can be checked. */
function valuesOf(source) {
  const out = new Map()
  const re = /^ {2}(['"])([^'"]+)\1\s*:\s*([\s\S]*?),\s*$/gm
  let m
  while ((m = re.exec(source))) out.set(m[2], m[3])
  return out
}

/** The contents of the `.whenbar__text` div in the compose screen. */
function whenbarTextBlock(text) {
  const at = text.indexOf('<div className="whenbar__text">')
  if (at < 0) return null
  const end = text.indexOf('\n                    </div>', at)
  return end < 0 ? null : text.slice(at, end)
}

/** The `delivery` memo in the compose screen, call through to its deps. */
function deliveryMemo(text) {
  const at = text.indexOf('const delivery = useMemo(')
  if (at < 0) return null
  const end = text.indexOf('\n  }, [', at)
  if (end < 0) return null
  return text.slice(at, text.indexOf('])', end) + 2)
}

// ---------------------------------------------------------------------------
// 1. The editor writes the field, and the card saves it
// ---------------------------------------------------------------------------

ok(
  'ContactsView imports the editor rather than inlining a second one',
  /import\s*\{\s*DeliveryWindowEditor\s*\}\s*from\s*'\.\.\/components\/DeliveryWindowEditor'/.test(
    src.contacts,
  ),
)
ok('ContactsView actually renders it', /<DeliveryWindowEditor\b/.test(src.contacts))
ok(
  'it is bound to the contact being edited',
  /value=\{editing\.deliveryWindow\}/.test(src.contacts),
)
ok(
  'and it writes `deliveryWindow` back onto that contact',
  /onChange=\{\(deliveryWindow\) => setEditing\(\{ \.\.\.editing, deliveryWindow \}\)\}/.test(
    src.contacts,
  ),
  'a window nobody stores is a settings screen with no settings behind it',
)
ok(
  'the same Save button persists it — no second, forgettable save',
  /dispatch\(\{ type: 'upsertContact', contact: editing \}\)/.test(src.contacts),
)
ok(
  'the editor is given the schedule, so the preview can name a real send time',
  /jobs=\{state\.jobs\}/.test(src.contacts),
)
ok(
  'the editor is given the address it must match jobs against',
  /address=\{editing\.address\}/.test(src.contacts),
)

// ---------------------------------------------------------------------------
// 2. The editor computes its consequence from the engine
// ---------------------------------------------------------------------------

ok(
  'the editor reaches the engine through the shared preview module',
  /from '\.\/deliveryPreview'/.test(src.editor),
)
ok('…and calls previewFor, rather than re-deriving the landing', /previewFor\(/.test(src.editor))
ok('…and asks the engine what is wrong, rather than validating by hand', /faultOf\(/.test(src.editor))
ok(
  'the example instant comes from the rule',
  /computeOccurrences\(job\.recurrence,/.test(src.editor),
)
ok(
  'the example instant is never taken from job.occurrences',
  !/job\.occurrences/.test(code.editor),
  'those have already been through applyDeliveryWindows — previewing them reports "already inside" for every value anyone could type',
)
ok(
  'the preview is recomputed from the window currently on screen',
  /previewFor\(planned\.at, \[\{ address, name: who, window \}\]\)/.test(src.editor),
)
ok(
  'the consequence names all four outcomes',
  ['deliver.previewMoved', 'deliver.previewInside', 'deliver.previewIgnored', 'deliver.previewImpossible'].every(
    (k) => src.editor.includes(k),
  ),
)
ok(
  'the moved sentence carries both instants and the recipient’s own clock',
  /t\('deliver\.previewMoved', \{[\s\S]{0,220}planned:[\s\S]{0,220}actual:[\s\S]{0,220}theirTime:/.test(
    src.editor,
  ),
)
ok(
  'the moved state is also visible without reading the sentence',
  /data-moved=\{preview\.moved \|\| undefined\}/.test(src.editor),
)
ok(
  'the example says where it came from',
  src.editor.includes('deliver.previewSource') && src.editor.includes('deliver.previewSourceNone'),
  'a number with no provenance is a number nobody can check',
)

// ---------------------------------------------------------------------------
// 3. The fault path renders, and says "ignored", never "held"
// ---------------------------------------------------------------------------

for (const key of [
  'deliver.faultUnknownZone',
  'deliver.faultMalformed',
  'deliver.faultNeverOpens',
  'deliver.faultIgnored',
]) {
  ok(`the editor renders ${key}`, src.editor.includes(key))
}
ok(
  'the fault is surfaced inline, on the card, not swallowed',
  /<Banner[\s\S]{0,200}tone="warning"/.test(src.editor),
)
ok(
  'the unknown-zone message repeats the zone that was rejected',
  /t\(faultKey, \{ zone: window\.timeZone \}\)/.test(src.editor),
)

// ---------------------------------------------------------------------------
// 4. The zone picker is drawn in the page
// ---------------------------------------------------------------------------

ok('the picker asks the engine for the zone list', /knownTimeZones\(\)/.test(src.picker))
ok('…and filters it in the page', /filterZones\(/.test(src.picker))
ok('the list is a real listbox of real rows', /role="listbox"/.test(src.picker) && /role="option"/.test(src.picker))
ok('a row is a button, so it is reachable without a mouse', /className="zonepick__row"/.test(src.picker))
ok('the chosen zone is marked', /aria-selected=\{chosen\}/.test(src.picker))
ok('arrows and Enter work in the filter box', /ArrowDown/.test(src.picker) && /e\.key === 'Enter'/.test(src.picker))
ok(
  'Escape closes the list and not the dialog behind it',
  /stopImmediatePropagation\(\)/.test(src.picker),
  'every Modal in this app listens for Escape on `document`, where React’s stopPropagation has no effect',
)
for (const [name, text] of [
  ['TimeZonePicker', code.picker],
  ['DeliveryWindowEditor', code.editor],
  ['ContactsView', code.contacts],
]) {
  ok(
    `${name} never uses a <datalist>`,
    !/<datalist/i.test(text),
    'Chromium paints that popup outside the document: page CSS cannot reach it and a DOM probe cannot see it (PROJECT-BRIEF §4)',
  )
}
ok(
  'the zone list is not a 400-option <select> either',
  !/<select[\s\S]{0,400}knownTimeZones/.test(code.picker),
)

// ---------------------------------------------------------------------------
// 5. The day picker is the one that already exists
// ---------------------------------------------------------------------------

ok('the editor reuses the existing seven-cell picker', /className="daypicker"/.test(src.editor))
ok('…including its day button', /className="daypicker__day"/.test(src.editor))
ok(
  'the editor draws the days in the shared Monday-first order',
  /DAY_ORDER\.map\(/.test(src.editor),
)
ok(
  'a day button stores the same number it displays',
  /aria-pressed=\{value\.days\.includes\(d\)\}/.test(src.editor) &&
    /toggleDay\(value\.days, d\)/.test(src.editor) &&
    /t\(`weekday\.\$\{d\}`/.test(src.editor),
  'displaying d and storing something else is how mail ends up held on the wrong day',
)
ok(
  'no second day picker is invented in CSS',
  !/\n\.daypicker/.test(css.slice(css.indexOf('/* --- B3 · 送达窗口'))),
)

// ---------------------------------------------------------------------------
// 6. The compose marker: fed by To:, and costing no row
// ---------------------------------------------------------------------------

ok(
  'ComposeView imports the same helpers the scheduler’s rule is written in',
  /import\s*\{[\s\S]{0,200}windowsForRecipients[\s\S]{0,200}\}\s*from\s*'\.\.\/components\/deliveryPreview'/.test(
    src.compose,
  ),
)

const memo = deliveryMemo(src.compose)
ok('the marker is computed in a memo', memo !== null)
if (memo) {
  ok(
    'it consults the To: list',
    /windowsForRecipients\(draft\.to, state\.contacts\)/.test(memo),
    'this has to give the same answer as `windowsForDraft` in AppState or the screen promises a time the scheduler will not use',
  )
  ok(
    'Cc and Bcc are never consulted',
    !/draft\.cc/.test(memo) && !/draft\.bcc/.test(memo),
    'someone kept in the loop is not being reached; a carbon copy must not hold up the real recipient',
  )
  ok('it asks about the instant this bar edits', /recurrence\.startAt/.test(memo))
  ok('it goes through the engine', /previewFor\(/.test(memo))
  ok(
    'it stays quiet when nothing would move',
    /worthShowing\(preview\)/.test(memo),
    'a marker that is always there is a marker nobody reads',
  )
}

const textBlock = whenbarTextBlock(src.compose)
ok('the send-time sentence is still there', textBlock !== null)
if (textBlock) {
  ok(
    'the marker is folded into that sentence rather than given a row',
    /className="whenbar__window"/.test(textBlock),
    'every pixel below the message box comes off the message box — PROJECT-BRIEF §6, six times, with measurements',
  )
  ok('the marker names the recipient', /name: delivery\.boundTo\?\.name/.test(textBlock))
  ok('…and the time it really goes out', /when: formatDateTime\(delivery\.at\)/.test(textBlock))
  ok('the unmeetable case is said out loud', /deliver\.composeImpossible/.test(textBlock))
  ok(
    'the per-recipient breakdown is a title, which costs the layout nothing',
    /title=\{deliveryDetail\}/.test(textBlock),
  )
  ok(
    'the existing rule sentence is untouched',
    /className="whenbar__rule"/.test(textBlock) && /scheduleSummary\.key/.test(textBlock),
  )
}

ok(
  'the quick-times popover is untouched',
  /className="popover whenbar__picks"/.test(src.compose) && /quickTimes\(Date\.now\(\)\)/.test(src.compose),
)
ok(
  'the whenbar still switches its control on recurrence.kind',
  /recurrence\.kind === 'cron' \?/.test(src.compose) && /firesAtTimeOfDay \?/.test(src.compose),
)

const whenbar = ruleBody(css, '.whenbar')
ok('the .whenbar rule is still there', whenbar !== null)
if (whenbar) {
  ok(
    'and was not given a position, an anchor or a height for this',
    !/position:/.test(whenbar) && !/min-height:/.test(whenbar) && !/height:/.test(whenbar),
  )
}
const whenText = ruleBody(css, '.whenbar__text')
ok('the sentence still flexes as it did', whenText !== null && /flex: 1 1 12em/.test(whenText))

const marker = ruleBody(css, '.whenbar__window')
ok('the marker has a rule of its own', marker !== null)
if (marker) {
  // `line-height` is allowed and is in fact load-bearing here — see the rule's
  // own comment — so these are anchored declarations, not substrings.
  for (const [property, re] of [
    ['display: block', /display:\s*block/],
    ['min-height', /^\s*min-height:/m],
    ['height', /^\s*height:/m],
    ['margin', /^\s*margin(-[a-z-]+)?:/m],
    ['padding', /^\s*padding(-[a-z-]+)?:/m],
  ]) {
    ok(
      `the marker sets no \`${property}\` — it inherits the line it sits on`,
      !re.test(marker),
    )
  }
  ok('a long zone or name still breaks', /overflow-wrap: anywhere/.test(marker))
}

// ---------------------------------------------------------------------------
// 7. Layout — the things that break at 360px
// ---------------------------------------------------------------------------

const blockStart = css.indexOf('/* --- B3 · 送达窗口')
const blockEnd = css.indexOf('/* --- end B3 · 送达窗口')
ok('the new stylesheet block is delimited', blockStart >= 0 && blockEnd > blockStart)

if (blockStart >= 0 && blockEnd > blockStart) {
  const block = css.slice(blockStart, blockEnd).replace(/\/\*[\s\S]*?\*\//g, ' ')
  ok(
    'nothing in the new block hard-codes a colour',
    !/#[0-9a-fA-F]{3,8}\b/.test(block) && !/\b(rgba?|hsla?|oklch|oklab)\(/.test(block),
    'six user-selectable styles exist; derive from the tokens',
  )
  ok('the emphasis states are derived from tokens', /color-mix\(in srgb, var\(--/.test(block))
  ok('nothing shouts !important', !/!important/.test(block))
  ok(
    'no fixed pixel cap on the scrolling list',
    !/max-height:\s*\d+px/.test(block),
    'a pixel cap shrinks the box on exactly the screens that had room for it — PROJECT-BRIEF §4',
  )
  ok(
    'break-word is never used where anywhere is needed',
    !/overflow-wrap:\s*break-word/.test(block),
  )
}

const rowRule = ruleBody(css, '.zonepick__row')
ok('a zone row has a rule of its own', rowRule !== null)
if (rowRule) {
  ok('a zone row is a real touch target', /min-height: var\(--tap-min\)/.test(rowRule))
}
for (const selector of ['.zonepick__id', '.zonepick__rowid']) {
  const rule = ruleBody(css, selector)
  ok(`${selector} exists`, rule !== null)
  if (rule) {
    ok(
      `${selector} breaks anywhere`,
      /overflow-wrap: anywhere/.test(rule),
      'America/Argentina/ComodRivadavia has nothing a normal line break can use; break-word will not let the box shrink below it',
    )
    ok(`${selector} can shrink at all`, /min-width: 0/.test(rule))
  }
}

const panel = ruleBody(css, '.zonepick__panel')
ok('the picker panel has a rule of its own', panel !== null)
if (panel) {
  ok(
    'the panel is in flow, not absolutely positioned',
    !/position:\s*absolute/.test(panel),
    'it lives inside .modal__body, which is the scroller — an absolute panel would be clipped by the very element that has to scroll it into view',
  )
}

const times = ruleBody(css, '.deliverwin__times')
ok('the two time boxes have a rule of their own', times !== null)
if (times) {
  ok('they wrap rather than squeeze at 360px', /flex-wrap: wrap/.test(times))
}
const line = ruleBody(css, '.deliverwin__line')
ok('the consequence line has a surface of its own', line !== null)
if (line) ok('and breaks anywhere', /overflow-wrap: anywhere/.test(line))

// ---------------------------------------------------------------------------
// 8. i18n — every key asked for exists in all six locales, and says the right thing
// ---------------------------------------------------------------------------

const used = new Set()
for (const text of [src.editor, src.picker, src.compose, src.contacts]) {
  for (const m of text.matchAll(/'(deliver\.[a-zA-Z.]+)'/g)) used.add(m[1])
}
ok('the screens ask for a meaningful number of new strings', used.size >= 25, `${used.size} keys`)

for (const locale of LOCALES) {
  const keys = new Set(keysOf(localeSources.get(locale)))
  const missing = [...used].filter((k) => !keys.has(k))
  ok(`${locale}.ts defines every deliver key`, missing.length === 0, missing.slice(0, 4).join(', '))
  ok(
    `${locale}.ts still carries the delivery-inbox-ics anchor`,
    localeSources.get(locale).includes('// --- ANCHOR:delivery-inbox-ics (B3/B4/B5) ---'),
  )
}

const english = valuesOf(localeSources.get('en'))
const faultText = english.get('deliver.faultIgnored') ?? ''
ok('the fault wording says the window is ignored', /ignored/i.test(faultText), faultText)
ok(
  '…and that the mail still goes out at the time that was set',
  /goes out at the time you set/i.test(faultText),
  faultText,
)
const ignoredPreview = english.get('deliver.previewIgnored') ?? ''
ok('the ignored preview says so too', /ignored/i.test(ignoredPreview), ignoredPreview)
for (const key of ['deliver.previewIgnored', 'deliver.previewImpossible', 'deliver.faultIgnored']) {
  const value = english.get(key) ?? ''
  ok(
    `${key} never claims mail is cancelled or waiting`,
    !/cancel/i.test(value) && !/\bwill be held\b/i.test(value) && !/\bis held\b/i.test(value),
    value,
  )
}

// ---------------------------------------------------------------------------
// 8b. One rule, one implementation
//
// `AppState.tsx` and `deliveryPreview.ts` both have to answer "whose delivery
// window counts for this draft?". They started as two copies of that answer,
// which is the shape this codebase has been caught by repeatedly (`Recurrence.
// month`, read 0-based in one place and 1-based in another, sent October's
// mail in September and passed every test). The moment these two disagree, the
// compose screen promises a send time the scheduler will not use, and neither
// side looks wrong.
//
// So: the reducer must *call* the shared function, not re-derive it. Asserted
// by absence as well as presence — a re-introduced private copy is exactly
// what this is here to catch.
// ---------------------------------------------------------------------------

const appState = await readFile('src/state/AppState.tsx', 'utf8')

ok(
  'the reducer imports the shared recipient rule',
  /import\s*\{[^}]*windowsForRecipients[^}]*\}\s*from\s*'\.\.\/components\/deliveryPreview'/.test(
    appState,
  ),
)
ok(
  'and calls it rather than re-deriving',
  /windowsOf\(\s*windowsForRecipients\(/.test(appState),
)
ok(
  'the reducer keeps no second address→window map of its own',
  !/byAddress\.set\([^)]*deliveryWindow/.test(appState) &&
    (appState.match(/\.deliveryWindow/g) ?? []).length === 0,
  'a private copy of the rule has come back',
)

// ---------------------------------------------------------------------------
// 9. The boundary: the UI's shape, through the UI's own rule, into the engine
//
// This is the crossing `check:ics` failed to make. A contact is built exactly
// as `ContactsView` saves one, handed to the *UI's* `windowsForRecipients`
// (the twin of `windowsForDraft` in AppState), and the resulting windows are
// put through `applyDeliveryWindows`. The instant is then asserted outright.
// ---------------------------------------------------------------------------

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-deliveryui-'))
try {
  /*
   * A two-file mirror of the module pair under test.
   *
   * `deliveryPreview.ts` is written from the (possibly broken) text held above,
   * so `--selftest` breaks the code that is *bundled*, not merely the code that
   * is grepped. `core/deliveryWindow.ts` imports nothing at all, so the mirror
   * needs no third file — and the type-only import of `core/types` is dropped
   * by esbuild before resolution.
   */
  await mkdir(path.join(dir, 'core'), { recursive: true })
  await mkdir(path.join(dir, 'components'), { recursive: true })
  await writeFile(
    path.join(dir, 'core/deliveryWindow.ts'),
    await readFile(path.join(root, 'src/core/deliveryWindow.ts'), 'utf8'),
  )
  await writeFile(path.join(dir, 'components/deliveryPreview.ts'), src.preview)

  const load = async (entry, name) => {
    const outfile = path.join(dir, `${name}.mjs`)
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      outfile,
      platform: 'node',
      logLevel: 'error',
    })
    return import(pathToFileURL(outfile).href)
  }

  const ui = await load(path.join(dir, 'components/deliveryPreview.ts'), 'ui')
  const engine = await load(path.join(root, 'src/core/deliveryWindow.ts'), 'engine')

  const LA = 'America/Los_Angeles'
  /** Monday 2026-08-03, 09:00 in Shanghai. Sunday 18:00 where the recipient is. */
  const MON_0900_SHANGHAI = Date.UTC(2026, 7, 3, 1, 0)
  /** Monday 2026-08-03, 09:00 in Los Angeles. */
  const MON_0900_LA = Date.UTC(2026, 7, 3, 16, 0)
  /** Sunday 2026-08-02, 13:00 in Los Angeles. */
  const SUN_1300_LA = Date.UTC(2026, 7, 2, 20, 0)

  /** Exactly what `DeliveryWindowEditor` builds: DEFAULT_DELIVERY_WINDOW, edited. */
  const officeHours = {
    ...engine.DEFAULT_DELIVERY_WINDOW,
    timeZone: LA,
  }
  ok(
    'the shape the editor starts from is Mon–Fri business hours',
    officeHours.from === '09:00' && officeHours.to === '18:00',
    JSON.stringify(officeHours),
  )
  ok(
    'and the engine accepts it without complaint',
    engine.windowFault(officeHours) === null,
    String(engine.windowFault(officeHours)),
  )

  /** A contact as `ContactsView` saves one — casing and stray spaces included. */
  const contact = {
    id: 'c1',
    name: 'Alice',
    address: '  Alice@Example.COM ',
    tags: [],
    createdAt: 0,
    deliveryWindow: officeHours,
  }

  const entries = ui.windowsForRecipients(['alice@example.com'], [contact])
  ok(
    'the UI finds the contact behind a To: address',
    entries.length === 1,
    `${entries.length} entries — an address list and a contact list are matched trimmed and lower-cased, exactly as AppState does it`,
  )
  ok('…and carries a name for the sentence to use', entries[0]?.name === 'Alice')
  ok('…and the window it saved', entries[0]?.window?.timeZone === LA)

  const result = engine.applyDeliveryWindows(MON_0900_SHANGHAI, ui.windowsOf(entries))
  ok(
    'a Monday 09:00 Shanghai reminder is moved out of the recipient’s Sunday evening',
    result.outcome === 'moved',
    `${result.outcome} / ${result.reason}`,
  )
  ok(
    '…to 09:00 Monday where they are',
    result.at === MON_0900_LA,
    new Date(result.at).toISOString(),
  )
  ok('…and it is their window that is holding it', result.boundBy === 0)

  const preview = ui.previewFor(MON_0900_SHANGHAI, entries)
  ok('the UI’s own preview agrees with the engine', preview.at === result.at)
  ok('…reports the move', preview.moved === true)
  ok('…names who the send is waiting on', preview.boundTo?.name === 'Alice')
  ok('…and is worth putting on screen', ui.worthShowing(preview) === true)
  ok(
    'the recipient’s own clock reads 09:00 at that instant',
    ui.wallTimeIn(preview.at, LA) === '09:00',
    String(ui.wallTimeIn(preview.at, LA)),
  )
  ok(
    'and it is a Monday there — 1, on Date#getDay numbering',
    ui.wallWeekdayIn(preview.at, LA) === 1,
    String(ui.wallWeekdayIn(preview.at, LA)),
  )

  // Nothing to do: an instant already inside the window is left where it is.
  const already = ui.previewFor(MON_0900_LA, entries)
  ok('an instant already inside the window is not moved', already.moved === false)
  ok('…and is not worth interrupting the compose screen for', ui.worthShowing(already) === false)

  // --- weekday numbering, from both ends ------------------------------------

  ok('the picker draws Monday first', ui.DAY_ORDER[0] === 1, JSON.stringify(ui.DAY_ORDER))
  ok('…and Sunday last', ui.DAY_ORDER[6] === 0, JSON.stringify(ui.DAY_ORDER))
  ok(
    '…while still offering all seven days exactly once',
    [...ui.DAY_ORDER].sort((a, b) => a - b).join() === '0,1,2,3,4,5,6',
  )
  ok(
    'ticking Sunday stores 0, not 7',
    ui.toggleDay([1, 2, 3, 4, 5], 0).join() === '0,1,2,3,4,5',
    ui.toggleDay([1, 2, 3, 4, 5], 0).join(),
  )
  ok('unticking removes exactly that day', ui.toggleDay([1, 2, 3, 4, 5], 1).join() === '2,3,4,5')
  ok('ticking twice is not two entries', ui.toggleDay([0], 0).join() === '')

  const sundayOnly = { timeZone: LA, from: '09:00', to: '18:00', days: [0] }
  const mondayOnly = { timeZone: LA, from: '09:00', to: '18:00', days: [1] }
  ok(
    'a Sunday-only window accepts a Sunday afternoon there',
    engine.isInsideWindow(SUN_1300_LA, sundayOnly) === true,
  )
  ok(
    '…and a Monday-only window does not',
    engine.isInsideWindow(SUN_1300_LA, mondayOnly) === false,
    'if this ever flips, `days` has been read as Monday-first and mail is held a day out',
  )

  // --- the fault path, all the way through ----------------------------------

  const unknownZone = { timeZone: 'Mars/Base', from: '09:00', to: '18:00', days: [1, 2, 3, 4, 5] }
  const malformed = { timeZone: LA, from: '09:', to: '18:00', days: [1, 2, 3, 4, 5] }
  const noDays = { timeZone: LA, from: '09:00', to: '18:00', days: [] }

  for (const [name, window, expected] of [
    ['an unknown zone', unknownZone, 'unknownZone'],
    ['a half-typed time', malformed, 'malformed'],
    ['a week with no days ticked', noDays, 'neverOpens'],
  ]) {
    ok(`${name} is a fault the editor can name`, ui.faultOf(window) === expected, String(ui.faultOf(window)))
    const ignored = engine.applyDeliveryWindows(MON_0900_SHANGHAI, [window])
    ok(
      `${name} leaves the send exactly where it was`,
      ignored.at === MON_0900_SHANGHAI,
      'a broken window is ignored so the mail goes out on time — never held',
    )
    ok(`${name} is reported as ignored, not silently dropped`, ignored.perRecipient[0].outcome === 'ignored')
    const faulty = ui.previewFor(MON_0900_SHANGHAI, [{ address: 'a@b.c', name: 'A', window }])
    ok(`${name} is flagged to the editor`, faulty.hasFault === true)
    ok(`${name} does not put a marker on the compose screen`, ui.worthShowing(faulty) === false)
  }

  ok('a usable window has no fault to report', ui.faultOf(officeHours) === null)

  // --- several recipients, which is where one send stops being enough -------

  const nz = {
    id: 'c2',
    name: 'Bao',
    address: 'bao@example.com',
    tags: [],
    createdAt: 0,
    deliveryWindow: { timeZone: 'Pacific/Auckland', from: '09:00', to: '12:00', days: [1, 2, 3, 4, 5] },
  }
  const morningOnly = {
    ...contact,
    deliveryWindow: { ...officeHours, from: '09:00', to: '12:00' },
  }
  const pair = ui.windowsForRecipients(['alice@example.com', 'bao@example.com'], [morningOnly, nz])
  ok('both windowed recipients are found, in To: order', pair.length === 2 && pair[0].name === 'Alice')
  const joint = ui.previewFor(MON_0900_SHANGHAI, pair)
  ok(
    'a New Zealand / California pair cannot be served by one send',
    joint.impossible === true || joint.splitRequired === true,
    `${joint.result.outcome} / ${joint.result.reason}`,
  )
  ok('…and the mail is not cancelled for it', Number.isFinite(joint.at))
  ok('…and it is worth saying so on the compose screen', ui.worthShowing(joint) === true)

  // --- Cc and Bcc are structurally incapable of holding a send -------------

  ok(
    'a contact who is not in the To: list contributes no window',
    ui.windowsForRecipients(['someone@else.test'], [contact]).length === 0,
  )
  ok('an empty To: list contributes nothing', ui.windowsForRecipients([], [contact]).length === 0)
  ok('a contact with no window contributes nothing', ui.windowsForRecipients(['x@y.z'], [{ ...contact, address: 'x@y.z', deliveryWindow: undefined }]).length === 0)

  // --- the zone picker's own filtering -------------------------------------

  const zones = engine.knownTimeZones()
  ok('this runtime knows a zone list to pick from', zones.length > 100, `${zones.length} zones`)
  const newYork = ui.filterZones(zones, 'new york')
  ok(
    'typing a city with a space still finds it',
    newYork.shown.includes('America/New_York'),
    'the picker treats `_` and `/` as spaces, which a datalist could not have been made to do',
  )
  const capped = ui.filterZones(zones, '')
  ok('an unfiltered list is capped rather than dumping 400 rows', capped.shown.length <= 120)
  ok('…and says how many it is holding back', capped.hidden === zones.length - capped.shown.length)
  ok('a query that matches nothing returns nothing', ui.filterZones(zones, 'zzzznotazone').shown.length === 0)
  const long = ui.filterZones(zones, 'argentina')
  ok('the long zone ids this layout must survive are really in the list', long.shown.some((z) => z.length > 24), long.shown[0] ?? '')

  // --- the sender's own zone, which is what an empty string means -----------

  ok('an empty zone resolves to this device', engine.resolveTimeZone('') === engine.senderTimeZone())
  ok('…and the UI can label it', typeof ui.deviceZone() === 'string' && ui.deviceZone().length > 0)
  ok(
    'a window with no zone of its own is still usable',
    engine.windowFault({ ...engine.DEFAULT_DELIVERY_WINDOW }) === null,
  )
  ok(
    'and the UI reports the zone it really uses',
    ui.effectiveZone({ ...engine.DEFAULT_DELIVERY_WINDOW }) === engine.senderTimeZone(),
  )

  // --- overnight windows: the ticked day is the evening --------------------

  const nightShift = { timeZone: LA, from: '22:00', to: '06:00', days: [5] }
  ok('the editor can tell an overnight window from an ordinary one', ui.wrapsMidnight(nightShift) === true)
  ok('…and an ordinary one from an overnight one', ui.wrapsMidnight(officeHours) === false)
  ok('an overnight window is not a fault', engine.windowFault(nightShift) === null)
} finally {
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const line of problems) console.error(`  FAIL  ${line}`)

console.log(`\ncheck:delivery-ui — ${checks - failures}/${checks} assertions passed`)

if (SELFTEST) {
  if (failures === 0) {
    console.error(
      `\nSELFTEST FAILED: the UI was broken (${BREAKAGES.map((b) => b.name).join('; ')}) and nothing went red.`,
    )
    process.exit(1)
  }
  console.log(`\nSelftest OK — ${failures} assertion(s) failed on the known-bad version.`)
  process.exit(0)
}

if (failures > 0) {
  console.error(`\nFAILED — ${failures} of ${checks} assertions.`)
  process.exit(1)
}
console.log('All clear.')
