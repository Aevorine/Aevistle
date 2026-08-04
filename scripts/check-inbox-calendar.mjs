/**
 * The gate on B4 — "收件箱 → 日历": a received message becoming a scheduled
 * reminder in one press.
 *
 * `check:dates` already proves the extractor answers correctly. This file
 * exists because that is not the failure this project keeps having. Three
 * times now a guard has gone green over a function that was written, exported,
 * imported — and then never called (PROJECT-BRIEF §4: `summarizeTransportError`
 * and its two neighbours; the `Recurrence.month` 0/1-based split that `check:ics`
 * could not see because it never crossed into the scheduler; the sync
 * carry-forward that was computed and not spread). Every one of those reads
 * correctly in review and does nothing at run time.
 *
 * So this asserts **use**, in the file that has to do the using:
 *
 *   1. `InboxView.tsx` really calls `extractDates`, inside a `useMemo`, keyed
 *      on the open message — and *not* on anything that changes while typing.
 *      The find-in-message path was already the measured bottleneck on this
 *      screen; re-extracting six languages per keystroke would be the same bug
 *      with a heavier consumer.
 *   2. The offer shows its evidence. A date nobody can check is a date nobody
 *      can correct — the lesson `CodesView` learned when it displayed a postcode.
 *   3. A `low` confidence reading is gated: no primary button, and a second
 *      question before anything is created. This is the whole safety margin of
 *      the feature. `dateExtract` deliberately downgrades an undecidable
 *      `03/04` rather than guessing; a UI that then schedules it on one press
 *      throws that decision away.
 *   4. Nothing runs on arrival. `scheduleDraft` is reachable only from a click.
 *   5. The two modules actually compose: a hit from `extractDates` fed to
 *      `buildChain` the way the view feeds it produces a job that fires at the
 *      right instant. That is the boundary `check:ics` failed to cross.
 *
 * `--selftest` breaks the view four ways and requires this file to go red.
 *
 * Exit code 1 if anything needs attention.
 */

// Pinned before anything reads the clock or resolves a wall time. The lead-time
// arithmetic below crosses a day boundary, and a zone well west of UTC is where
// an off-by-one in all-day handling is visible instead of cancelling out.
process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELFTEST = process.argv.includes('--selftest')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VIEW = path.join(root, 'src/views/InboxView.tsx')

/**
 * The known-bad versions, applied to the view's source text.
 *
 * Textual rather than a switch in the component, so the shipped file carries
 * no "make me wrong" flag: the guard proves it can catch a regression in code
 * that has no idea it is being tested.
 */
const BREAKAGES = [
  {
    name: 'extraction no longer memoised — it runs on every render',
    from: 'const dateHits = useMemo<DateHit[]>(() => {',
    to: 'const dateHits = ((cb, _deps) => cb())<DateHit[]>(() => {',
  },
  {
    name: 'extraction put back on the typing path',
    from: '  }, [openMessageId, openSubject, openReceivedAt, openText, openHtml, openIcsParts])',
    to: '  }, [openMessageId, openSubject, openReceivedAt, openText, openHtml, openIcsParts, findText])',
  },
  {
    name: 'the low-confidence question removed',
    from: "    if (hit.confidence === 'low') {",
    to: '    if (false) {',
  },
  {
    name: 'a low-confidence hit given the primary button back',
    from: '  const preferred = low\n    ? undefined',
    to: '  const preferred = false\n    ? undefined',
  },
]

let view = await readFile(VIEW, 'utf8')
if (SELFTEST) {
  for (const breakage of BREAKAGES) {
    if (!view.includes(breakage.from)) {
      console.error(`  SELFTEST CANNOT RUN: "${breakage.from}" is no longer in ${path.basename(VIEW)}.`)
      process.exit(1)
    }
    view = view.replace(breakage.from, breakage.to)
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
 * The body of the `useMemo` that holds the extraction, from the call through
 * to its dependency array.
 *
 * Sliced rather than pattern-matched in one regex so the two questions can be
 * asked separately: *is it memoised at all*, and *what is it keyed on*. Those
 * fail for different reasons and deserve different messages.
 */
function extractionMemo(text) {
  const start = text.indexOf('const dateHits =')
  if (start < 0) return null
  const end = text.indexOf('\n  }, [', start)
  if (end < 0) return null
  const depsEnd = text.indexOf('])', end)
  return text.slice(start, depsEnd + 2)
}

/** Every `useEffect(...)` body in the file, so "nothing on arrival" is checkable. */
function effectBodies(text) {
  const bodies = []
  let at = text.indexOf('useEffect(')
  while (at >= 0) {
    const end = text.indexOf('\n  }, [', at)
    bodies.push(text.slice(at, end < 0 ? text.length : end))
    at = text.indexOf('useEffect(', at + 1)
  }
  return bodies
}

/** One top-level CSS rule by exact selector. */
function ruleBody(source, selector) {
  const at = source.indexOf(`\n${selector} {`)
  if (at < 0) return null
  const end = source.indexOf('\n}', at)
  return end < 0 ? null : source.slice(at, end)
}

/** Keys defined by a locale file, in file order. */
function keysOf(source) {
  return [...source.matchAll(/^ {2}(['"])([^'"]+)\1\s*:/gm)].map((m) => m[2])
}

// ---------------------------------------------------------------------------
// 1. The extractor is genuinely invoked, and invoked in the right place
// ---------------------------------------------------------------------------

ok(
  'InboxView imports extractDates from the engine',
  /import\s*\{[^}]*\bextractDates\b[^}]*\}\s*from\s*'\.\.\/core\/dateExtract'/.test(view),
)
ok('InboxView actually calls extractDates', /\bextractDates\(\s*\{/.test(view))

const memo = extractionMemo(view)
ok('the extraction lives in a `dateHits` binding', memo !== null)

if (memo) {
  ok(
    'the extraction is memoised, not re-run on every render',
    /useMemo</.test(memo) || /useMemo\(/.test(memo),
    'six languages of matchers on every keystroke is the bottleneck this screen just had removed',
  )
  ok('the memo is the thing that calls extractDates', /extractDates\(/.test(memo))

  const deps = memo.slice(memo.lastIndexOf('}, ['))
  ok('the memo is keyed on the open message', /openMessageId/.test(deps), deps.trim())
  ok('…and on the body text it reads', /openText/.test(deps) && /openHtml/.test(deps))
  for (const typed of ['findText', 'deferredFind', 'query', 'deferredQuery']) {
    ok(
      `the memo is not keyed on \`${typed}\` — extraction must never be on the typing path`,
      !new RegExp(`\\b${typed}\\b`).test(deps),
      deps.trim(),
    )
  }
  ok(
    'the memo does not depend on the whole body object',
    !/\bopenBody\b/.test(deps),
    'openBody is replaced whenever an attachment finishes downloading',
  )
  ok(
    'the anchor is the message, never the wall clock',
    /receivedAt:\s*openReceivedAt/.test(memo) && !/receivedAt:\s*Date\.now\(\)/.test(memo),
    '"tomorrow at 3" means the day after the mail was sent, not the day after it was opened',
  )
  ok('any calendar part is handed through', /icsParts:/.test(memo))
  ok(
    'the calendar parts are compared by value, not by array identity',
    /JSON\.stringify\(openBody \? \(icsPartsOf/.test(view),
    'icsPartsOf filters, so a fresh array every render is a memo that never hits',
  )
  ok(
    'the platform language tag is passed, region subtag included',
    /locale:\s*platformLocale\(\)/.test(memo),
    'the region is the only thing that decides 03/04',
  )
}

ok(
  'the view does not reimplement the extractor',
  !/const\s+MONTHS?\s*[:=]/.test(view) && !/\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(view),
  'dates are read in core/dateExtract and nowhere else',
)

// ---------------------------------------------------------------------------
// 2. The offer is rendered in the reader, with the evidence that produced it
// ---------------------------------------------------------------------------

ok('the offers are rendered', /dateHits\.map\(/.test(view))
ok(
  'they are rendered in the reader, not as an interrupting dialog',
  /className="reader__dates"/.test(view),
)
ok(
  'the offers sit inside the open message, above its body',
  view.indexOf('reader__dates') < view.indexOf('<MessageBodyFrame'),
)
ok(
  'the resolved moment is shown',
  /datecard__when/.test(view) && /\bwhen=\{whenLabel\(hit\)\}/.test(view),
)
ok('what kind of moment it is, is shown', /inboxcal\.kind\./.test(view))
ok(
  'the evidence snippet is shown — the card has to justify itself',
  /hit\.evidence\.snippet/.test(view),
  'a date nobody can check is a date nobody can correct',
)
ok(
  'the evidence is rendered as text, not interpolated into markup',
  !/dangerouslySetInnerHTML/.test(view),
)

// ---------------------------------------------------------------------------
// 3. One press, through the machinery that already exists
// ---------------------------------------------------------------------------

ok(
  'the chain module is imported rather than reimplemented',
  /import\s*\{[^}]*\bbuildChain\b[^}]*\}\s*from\s*'\.\.\/core\/chain'/.test(view),
)
ok('the lead times offered are the app-wide ones', /CHAIN_STAGES\.filter\(/.test(view))
ok('a lead time is labelled by the shared helper', /leadLabelKey\(/.test(view))
ok('the job is built by buildChain', /buildChain\(base,\s*\[leadMs\],\s*now\)/.test(view))
ok('the job is handed to the app-wide scheduler', /await scheduleDraft\(job\)/.test(view))
ok(
  'there is exactly one place that schedules anything',
  (view.match(/scheduleDraft\(/g) ?? []).length === 1,
  'a second call site is a second set of rules to keep in step',
)
ok(
  'the reminder goes to the receiving mailbox, never back to the sender',
  /account\?\.fromAddress/.test(view) && /to:\s*\[to\]/.test(view),
)
ok(
  'a lead that would fire in the past is refused rather than fired now',
  /job\.recurrence\.startAt <= now/.test(view),
)
ok(
  'the toast reports when it will actually fire',
  /t\('inboxcal\.scheduled',\s*\{\s*when:\s*formatDateTime\(job\.recurrence\.startAt\)/.test(view),
  'reporting the lead that was asked for hides one buildChain dropped',
)

// Nothing on arrival. This is the app's standing rule and the reason the
// feature is a button rather than a background watcher.
const effects = effectBodies(view)
ok('there are effects in this file to check at all', effects.length > 0)
for (const forbidden of ['scheduleDraft', 'scheduleFromDate', 'onSchedule']) {
  ok(
    `no useEffect reaches \`${forbidden}\` — mail is never created without a press`,
    effects.every((body) => !body.includes(forbidden)),
  )
}
ok(
  'scheduling is reached from a click and nowhere else',
  /onSchedule=\{\(leadMs\) => void scheduleFromDate\(hit, leadMs\)\}/.test(view) &&
    /onClick=\{\(\) => onSchedule\(preferred\)\}/.test(view) &&
    /onClick=\{\(\) => onSchedule\(stage\.leadMs\)\}/.test(view),
)

// ---------------------------------------------------------------------------
// 4. `low` is visibly different, and is not the default action
// ---------------------------------------------------------------------------

ok("the view reads the hit's confidence", /confidence === 'low'/.test(view))
ok(
  'a low-confidence hit asks a second question before creating anything',
  /if \(hit\.confidence === 'low'\) \{[\s\S]{0,400}?await confirm\(/.test(view),
  'a wrong date silently scheduled is worse than no offer at all',
)
ok(
  'a low-confidence hit has no preferred lead time',
  /const preferred = low\s*\n?\s*\? undefined/.test(view),
)
ok(
  'the primary button exists only when there is a preferred lead',
  /preferred !== undefined \?[\s\S]{0,240}variant="primary"/.test(view),
)
ok(
  'and the primary button is the only primary on the card',
  (view.slice(view.indexOf('function DateOffer')).match(/variant="primary"/g) ?? []).length === 1,
)
ok('the card carries its confidence into the markup', /data-confidence=\{hit\.confidence\}/.test(view))
ok('a low reading says so in words as well', /inboxcal\.unsure/.test(view) && /inboxcal\.lowHint/.test(view))

// ---------------------------------------------------------------------------
// 5. Layout — the two things that break at 360px
// ---------------------------------------------------------------------------

const snippet = ruleBody(css, '.datecard__snippet')
ok('the evidence snippet has a rule of its own', snippet !== null)
if (snippet) {
  ok(
    'the snippet breaks anywhere',
    /overflow-wrap:\s*anywhere/.test(snippet),
    'break-word will not let the box shrink below an unbroken token — recorded twice in PROJECT-BRIEF §4',
  )
  ok('and never merely break-word', !/overflow-wrap:\s*break-word/.test(snippet))
  ok('the snippet is clamped to a sane number of lines', /line-clamp:\s*\d/.test(snippet))
}

const lead = ruleBody(css, '.datecard__lead')
ok('the lead-time chips have a rule of their own', lead !== null)
if (lead) {
  ok('a lead-time chip is a real touch target', /min-height:\s*var\(--tap-min\)/.test(lead))
}

const inset = ruleBody(css, '.modal__body--reader > .reader__dates')
ok('the block joins the reader’s own inset rather than editing that list', inset !== null)

const start = css.indexOf('/* --- B4 · 收件箱 → 日历')
const end = css.indexOf('/* --- end B4 · 收件箱 → 日历')
ok('the new stylesheet block is delimited', start >= 0 && end > start)
if (start >= 0 && end > start) {
  const block = css
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  ok(
    'nothing in the new block hard-codes a colour',
    !/#[0-9a-fA-F]{3,8}\b/.test(block) && !/\b(rgba?|hsla?|oklch|oklab)\(/.test(block),
    'six user-selectable styles exist; derive from the tokens',
  )
  ok('the confidence tiers are derived from existing tokens', /color-mix\(in srgb, var\(--/.test(block))
  ok('a low reading is styled differently from a confident one', /\[data-confidence='low'\]/.test(block))
  ok('the offers stack rather than sitting in columns', /flex-direction: column/.test(block))
  ok('there is a narrow-screen arrangement', /@media \(max-width: 560px\)/.test(block))
}

// ---------------------------------------------------------------------------
// 6. i18n — every key the view asks for exists in all six locales
// ---------------------------------------------------------------------------

const used = new Set(
  [...view.matchAll(/'(inboxcal\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
)
// The kind chip is built from a template literal, so add the four the type union
// can produce. A kind added to `DateHitKind` with no translation renders its own
// key on screen, which is the failure `advisoryKey` shipped once already.
for (const kind of ['invitation', 'meeting', 'deadline', 'appointment']) {
  used.add(`inboxcal.kind.${kind}`)
}
ok('the view asks for a meaningful number of new strings', used.size >= 20, `${used.size} keys`)

for (const locale of LOCALES) {
  const keys = new Set(keysOf(localeSources.get(locale)))
  const missing = [...used].filter((k) => !keys.has(k))
  ok(`${locale}.ts defines every inboxcal key`, missing.length === 0, missing.slice(0, 4).join(', '))
}

// The anchor the six files are edited at. If it goes, the next agent appends to
// the end of the file and the three concurrent workstreams start colliding.
for (const locale of LOCALES) {
  ok(
    `${locale}.ts still carries the delivery-inbox-ics anchor`,
    localeSources.get(locale).includes('// --- ANCHOR:delivery-inbox-ics (B3/B4/B5) ---'),
  )
}

// ---------------------------------------------------------------------------
// 7. The boundary: a hit from the extractor really becomes a job
//
// `check:dates` proves `extractDates` is right about the instant. `check:ics`
// once proved a round-trip preserved `Recurrence.month` and never handed it to
// the scheduler — and October's reminders went out in September for it. So the
// two modules are composed here exactly the way `scheduleFromDate` composes
// them, and the resulting fire time is asserted.
// ---------------------------------------------------------------------------

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-inboxcal-'))
try {
  const load = async (entry, name) => {
    const outfile = path.join(dir, `${name}.mjs`)
    await build({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      format: 'esm',
      outfile,
      platform: 'node',
      logLevel: 'error',
    })
    return import(pathToFileURL(outfile).href)
  }

  const { extractDates } = await load('src/core/dateExtract.ts', 'de')
  const { buildChain, CHAIN_STAGES, leadLabelKey } = await load('src/core/chain.ts', 'chain')

  const DAY = 86_400_000
  const RECEIVED = new Date(2026, 2, 4, 10, 0, 0).getTime()
  const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime()

  /** The view's own job shape, minus the parts the scheduler does not read. */
  const jobFor = (hit, leadMs, now) =>
    buildChain(
      {
        name: 'x',
        enabled: true,
        draft: { to: ['me@example.com'], cc: [], bcc: [], subject: 's', body: 'b', bodyFormat: 'plain', attachments: [], accountId: 'a', priority: 'normal', requestReadReceipt: false, individualDelivery: false },
        recurrence: {
          kind: 'once',
          startAt: hit.at,
          timeOfDay: '00:00',
          monthDayFallback: 'last',
          endMode: 'never',
          jitterSeconds: 0,
          skipWeekends: false,
          catchUp: 'fireOnce',
        },
        occurrences: [],
        runCount: 0,
        retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
        status: 'armed',
        createdAt: now,
        updatedAt: now,
      },
      [leadMs],
      now,
    )[0]

  const meeting = extractDates({
    subject: 'Project meeting',
    body: 'Our project meeting is on March 12, 2026 at 14:30 in Room B.',
    receivedAt: RECEIVED,
    locale: 'en-GB',
  })[0]

  ok('the engine still finds the meeting this guard is about', Boolean(meeting))
  if (meeting) {
    ok('…at the instant the mail states', meeting.at === L(2026, 3, 12, 14, 30))
    ok('…and it carries the evidence the card renders', Boolean(meeting.evidence?.snippet))

    const dayBefore = jobFor(meeting, DAY, RECEIVED)
    ok(
      'a "day before" lead produces a job that fires exactly one day before',
      dayBefore?.recurrence.startAt === meeting.at - DAY,
      `${dayBefore ? new Date(dayBefore.recurrence.startAt).toString() : 'nothing'}`,
    )
    ok('a single lead is not tagged as a chain', dayBefore?.chainId === undefined)

    const onTheDay = jobFor(meeting, 0, RECEIVED)
    ok('an "on the day" lead fires at the event itself', onTheDay?.recurrence.startAt === meeting.at)

    // A week before this meeting is 5 March, which is *after* the mail arrived
    // but the view only offers leads still in the future — checked here from the
    // other side: asked for one that has gone, buildChain falls back to the
    // event rather than firing now.
    const gone = jobFor(meeting, 30 * DAY, RECEIVED)
    ok(
      'a lead whose moment has already passed is never fired immediately',
      gone && gone.recurrence.startAt >= RECEIVED,
    )

    for (const stage of CHAIN_STAGES) {
      ok(
        `the lead ${stage.leadMs}ms has a label key`,
        typeof leadLabelKey(stage.leadMs) === 'string' && leadLabelKey(stage.leadMs).length > 0,
      )
    }
  }

  const deadline = extractDates({
    subject: 'Submission',
    body: 'The quarterly report is due in 3 days. Please send it to me directly.',
    receivedAt: RECEIVED,
    locale: 'en-GB',
  })[0]
  ok('an all-day deadline is found', Boolean(deadline) && deadline.allDay === true)
  if (deadline) {
    const dayBefore = jobFor(deadline, DAY, RECEIVED)
    ok(
      'a reminder for an all-day deadline fires at the start of the day before',
      dayBefore?.recurrence.startAt === L(2026, 3, 6),
      dayBefore ? new Date(dayBefore.recurrence.startAt).toString() : 'nothing',
    )
  }

  // The gate has to have something to gate. Bare `en` cannot decide 03/04, and
  // `dateExtract` says so by forcing the hit to `low` — if that ever stops
  // happening the low-confidence branch in the view becomes dead code.
  const ambiguous = extractDates({
    subject: 'Project meeting',
    body: 'The project meeting is on 03/04/2026.',
    receivedAt: RECEIVED,
    locale: 'en',
  })[0]
  ok(
    'the engine still produces a low-confidence reading for the view to gate',
    ambiguous?.confidence === 'low',
    ambiguous ? ambiguous.confidence : 'nothing',
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const line of problems) console.error(`  FAIL  ${line}`)

console.log(`\ncheck:inbox-calendar — ${checks - failures}/${checks} assertions passed`)

if (SELFTEST) {
  if (failures === 0) {
    console.error(
      `\nSELFTEST FAILED: the view was broken (${BREAKAGES.map((b) => b.name).join('; ')}) and nothing went red.`,
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
