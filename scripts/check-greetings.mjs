/**
 * Holiday greetings: does it name the day, and does it stay a *plan*?
 *
 * Two properties, and the second one is the reason this file is long.
 *
 * **It must name the day.** A greeting whose subject line is "Happy " is worse
 * than no greeting. So the names have to come from something that actually
 * knows them — the transcribed State Council tables for China, the fixed-date
 * presets elsewhere — and never from arithmetic on a calendar. A year nobody
 * has published falls back to fixed dates and *says so* in `source`, rather
 * than extrapolating last year's lunar dates onto this one. The 调休 make-up
 * workdays in the Chinese tables are working Saturdays and must never be
 * greeted. Nine consecutive days of Spring Festival are one occasion, not
 * nine messages in a week.
 *
 * **It must not send, and must not create behind the user's back.** This
 * application deliberately shipped without a daily send cap because "悄悄不发"
 * — quietly not sending — is the failure it exists to prevent; quietly
 * *sending* is the same failure with the sign flipped. So the module plans and
 * only plans, the screen shows the plan, a confirmation stands between the plan
 * and the schedule, and what lands in the schedule is ordinary visible jobs.
 * Those are source-level facts, not behavioural ones, and this guard asserts
 * them by reading the call site — a behavioural test of `planGreetings` alone
 * would pass with the whole thing wired to an auto-sender.
 *
 * The third thing checked here is the one that made `{{holiday}}` worth using:
 * the name map handed to the merge at send time must cover every country, not
 * only China, or the merge variable resolves to an empty string for everybody
 * else — the exact "silently blank" failure `mergeVars` is built to avoid.
 *
 * `--selftest` re-introduces each fault in turn and requires the matching
 * assertion to catch it.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'Asia/Shanghai'

import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SELFTEST = process.argv.includes('--selftest')

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-greet-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-greet-'))
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

const greet = await load('src/core/greetings.ts', 'greetings')

const greetSource = await readFile('src/core/greetings.ts', 'utf8')
const settingsView = await readFile('src/views/SettingsView.tsx', 'utf8')
const appState = await readFile('src/state/AppState.tsx', 'utf8')

const failures = []
let checked = 0
const ok = (what, pass) => {
  checked++
  if (!pass) failures.push(what)
  return pass
}
const eq = (what, actual, expected) =>
  ok(
    `${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected),
  )

const { planGreetings, holidaysForCountry, holidayNameMap, greetingJobId, GREETING_COUNTRIES } =
  greet

/** Well before any 2026 holiday, so nothing is filtered out for being past. */
const EARLY = new Date(2025, 11, 1, 9, 0, 0, 0).getTime()
const PLAIN = { weekend: [0, 6], holidays: [], workdays: [] }
const NOBODY = { statutoryCache: [] }

const cn = (n) => ({ address: `cn${n}@example.com`, name: `CN ${n}`, country: 'CN' })
const fr = (n) => ({ address: `fr${n}@example.com`, name: `FR ${n}`, country: 'FR' })

// ===========================================================================
// The names come from something that knows them
// ===========================================================================

if (ok('holidaysForCountry is exported', typeof holidaysForCountry === 'function')) {
  const china = holidaysForCountry('CN', 2026, NOBODY)
  const byDate = new Map(china.map((h) => [h.date, h]))

  ok('cn: 2026 comes from the transcribed table', china.every((h) => h.source === 'statutory'))
  eq('cn: Spring Festival is named', byDate.get('2026-02-15')?.name, '春节')
  ok('cn: nine days off are one occasion, not nine', !byDate.has('2026-02-16'))
  ok('cn: and not the day after the block either', !byDate.has('2026-02-24'))
  ok(
    'cn: a 调休 make-up workday is never greeted',
    !byDate.has('2026-02-14') && !byDate.has('2026-02-28'),
  )
  eq('cn: National Day starts on 1 October', byDate.get('2026-10-01')?.name, '国庆节')
  ok('cn: and 2–7 October do not each get their own', !byDate.has('2026-10-03'))
  eq('cn: Mid-Autumn is its own occasion', byDate.get('2026-09-25')?.name, '中秋节')
  eq('cn: 元旦 opens the year', byDate.get('2026-01-01')?.name, '元旦')

  // The whole point of the Chinese tables: a year nobody has announced is not
  // guessed. It degrades to the fixed dates and labels itself as such.
  const unannounced = holidaysForCountry('CN', 2031, NOBODY)
  ok('cn: an unpublished year falls back', unannounced.length > 0)
  ok('cn: and says the dates are the fixed-date list', unannounced.every((h) => h.source === 'preset'))
  ok(
    'cn: which means no lunar dates are invented',
    !unannounced.some((h) => h.name === '春节'),
  )

  const france = holidaysForCountry('FR', 2026, NOBODY)
  ok(
    'fr: the French names are the French ones',
    france.some((h) => h.date === '2026-07-14' && h.name === 'Fête nationale'),
  )
  ok('fr: from the fixed-date list', france.every((h) => h.source === 'preset'))

  // Russia's New Year block is 1–8 January with Christmas on the 7th: two runs
  // of the same name with a different holiday wedged between them.
  const russia = holidaysForCountry('RU', 2026, NOBODY)
  const ruDates = russia.map((h) => h.date)
  ok('ru: the New Year block collapses', !ruDates.includes('2026-01-03'))
  ok('ru: Christmas on the 7th survives on its own', ruDates.includes('2026-01-07'))
  ok('ru: and the 8th is a new run of the block', ruDates.includes('2026-01-08'))

  eq('a country nobody has a table for produces nothing', holidaysForCountry('ZZ', 2026, NOBODY), [])
}

// ===========================================================================
// The plan
// ===========================================================================

if (ok('planGreetings is exported', typeof planGreetings === 'function')) {
  const plan = planGreetings([cn(1), cn(2), fr(1)], 2026, {
    now: EARLY,
    calendar: PLAIN,
    timeOfDay: '09:00',
    defaultCountry: 'CN',
    statutoryCache: [],
  })

  ok('plan: something is planned', plan.length > 0)
  ok('plan: it is in date order', plan.every((o, i, a) => i === 0 || o.at >= a[i - 1].at))
  ok('plan: nothing is in the past', plan.every((o) => o.at > EARLY))
  ok(
    'plan: every occasion carries a name, never a bare date',
    plan.every((o) => typeof o.name === 'string' && o.name.length > 0 && o.name !== o.date),
  )
  ok(
    'plan: the send instant honours the requested time of day',
    plan.every((o) => new Date(o.at).getHours() === 9),
  )
  ok(
    'plan: the gap in the data is carried, not hidden',
    plan.every((o) => o.hasMovingDates === true),
  )

  // Two countries, one date, two different names — this is the case a single
  // global holiday list gets wrong.
  const newYear = plan.filter((o) => o.date === '2026-01-01')
  eq('plan: 1 January is planned once per country', newYear.length, 2)
  ok(
    'plan: and each country gets its own name',
    new Set(newYear.map((o) => o.name)).size === 2,
  )
  const chineseNewYear = newYear.find((o) => o.country === 'CN')
  eq('plan: the Chinese contacts get the Chinese name', chineseNewYear?.name, '元旦')
  eq('plan: and both of them', chineseNewYear?.recipients.length, 2)
  eq(
    'plan: while the French contact is on the French one',
    newYear.find((o) => o.country === 'FR')?.recipients.length,
    1,
  )

  // A contact with no country of its own falls back; a contact with a country
  // nobody has a table for does too, rather than vanishing.
  const fallback = planGreetings(
    [{ address: 'nowhere@example.com' }, { address: 'made-up@example.com', country: 'ZZ' }],
    2026,
    { now: EARLY, calendar: PLAIN, defaultCountry: 'FR', statutoryCache: [] },
  )
  ok('plan: a contact with no country uses the default', fallback.length > 0)
  ok('plan: which really is the default country', fallback.every((o) => o.country === 'FR'))
  eq('plan: and nobody is dropped', fallback[0]?.recipients.length, 2)

  // With no default and no country, there is nothing to plan — and that has to
  // be an empty list rather than a guess at which country was meant.
  eq(
    'plan: with no country anywhere, nothing is invented',
    planGreetings([{ address: 'x@example.com' }], 2026, {
      now: EARLY,
      calendar: PLAIN,
      statutoryCache: [],
    }),
    [],
  )

  // Dates already gone are not offered. Read on 1 October 2026, the 1st has
  // passed at 09:00 and Spring Festival is eight months behind.
  const late = planGreetings([cn(1)], 2026, {
    now: new Date(2026, 9, 1, 12, 0).getTime(),
    calendar: PLAIN,
    statutoryCache: [],
  })
  ok('plan: a holiday earlier today is not offered', !late.some((o) => o.date === '2026-10-01'))
  ok('plan: nor one from February', !late.some((o) => o.date.startsWith('2026-02')))

  // The working calendar is consulted, and reported rather than acted on.
  const marked = planGreetings([cn(1)], 2026, {
    now: EARLY,
    calendar: PLAIN,
    statutoryCache: [],
  })
  ok(
    'plan: whether the date is one of your working days is reported',
    marked.every((o) => typeof o.yourWorkingDay === 'boolean'),
  )
  eq('plan: 2026-01-01 is a Thursday, so it is a working day here',
     marked.find((o) => o.date === '2026-01-01')?.yourWorkingDay, true)

  eq('countries: exactly the six with a preset', GREETING_COUNTRIES.length, 6)
  ok('countries: China among them', GREETING_COUNTRIES.includes('CN'))
}

// ===========================================================================
// Pressing the button twice must not send twice
// ===========================================================================

{
  const a = greetingJobId({ country: 'CN', date: '2026-10-01' })
  const b = greetingJobId({ country: 'CN', date: '2026-10-01' })
  eq('ids: the same occasion is the same job', a, b)
  ok(
    'ids: a different date is a different job',
    a !== greetingJobId({ country: 'CN', date: '2026-01-01' }),
  )
  ok(
    'ids: and so is a different country on the same date',
    a !== greetingJobId({ country: 'US', date: '2026-10-01' }),
  )
}

// ===========================================================================
// `{{holiday}}` has to resolve for everybody, not only for China
// ===========================================================================

if (ok('holidayNameMap is exported', typeof holidayNameMap === 'function')) {
  const map = holidayNameMap({ years: [2026], prefer: 'CN', statutoryCache: [] })

  eq('names: a Chinese statutory date wins outright', map.get('2026-02-17'), '春节')
  eq('names: a date only France has is French', map.get('2026-07-14'), 'Fête nationale')
  eq('names: a date only Saudi Arabia has', map.get('2026-09-23'), 'Saudi National Day')
  // 1 May is in the Chinese table, so it is not a test of the preference — the
  // exact-date source is meant to beat every preset. 11 November is: the US
  // calls it Veterans Day and France calls it Armistice, and nothing else knows
  // it at all.
  eq('names: an exact statutory date beats the preference', map.get('2026-05-01'), '劳动节')
  ok('names: a shared date resolves rather than staying blank', Boolean(map.get('2026-11-11')))
  eq(
    'names: and it follows the preferred country',
    holidayNameMap({ years: [2026], prefer: 'US', statutoryCache: [] }).get('2026-11-11'),
    'Veterans Day',
  )
  eq(
    'names: change the preference and the shared date follows it',
    holidayNameMap({ years: [2026], prefer: 'FR', statutoryCache: [] }).get('2026-11-11'),
    'Armistice',
  )
  eq('names: an ordinary Tuesday has none', map.get('2026-06-16'), undefined)

  eq(
    'names: the years asked for are the years covered',
    holidayNameMap({ years: [2027], prefer: 'FR', statutoryCache: [] }).get('2027-07-14'),
    'Fête nationale',
  )
  eq('years: three of them, around now', greet.greetingYears(EARLY), [2024, 2025, 2026])
}

// ===========================================================================
// It plans. It does not send, and it does not create by itself.
// ===========================================================================

const source = (what, haystack, re) => ok(what, re.test(haystack))
const absent = (what, haystack, re) => ok(what, !re.test(haystack))

absent('honesty: the planner cannot send', greetSource, /sendNow|sendDraftNow|sendMail/)
absent('honesty: the planner cannot write to state', greetSource, /dispatch|upsertJob|scheduleDraft/)

source(
  'wiring: the settings screen uses the planner',
  settingsView,
  /import \{[\s\S]{0,200}?planGreetings[\s\S]{0,200}?\} from '\.\.\/core\/greetings'/,
)
source(
  'wiring: the plan starts empty and appears only when asked for',
  settingsView,
  /useState<GreetingOccasion\[\] \| null>\(null\)/,
)
source(
  'wiring: creating is behind a confirmation',
  settingsView,
  /const createGreetings = async \(\) => \{[\s\S]{0,400}?await confirm\(/,
)
source(
  'wiring: and the confirmation says how many',
  settingsView,
  /confirmLabel: t\('settings\.greetCreate', \{ n: greetPlan\.length \}\)/,
)
source(
  'wiring: what it creates is a scheduled job, not a send',
  settingsView,
  /const createGreetings = async \(\) => \{[\s\S]{0,2400}?await scheduleDraft\(\{/,
)
source(
  'wiring: with the deterministic id, so a second press replaces rather than duplicates',
  settingsView,
  /id: greetingJobId\(occasion\)/,
)
source(
  'wiring: the template keeps its merge variables instead of being flattened now',
  settingsView,
  /mergeEnabled: true/,
)
absent(
  'wiring: the greetings card never reaches for the mailer',
  settingsView,
  /sendDraftNow|bridge\.sendNow/,
)

// The cross-module half of `{{holiday}}`: a name map that never reaches the
// merge is a name map that changes nothing.
source(
  'wiring: AppState imports the name map',
  appState,
  /import \{[^}]*holidayNameMap[^}]*\} from '\.\.\/core\/greetings'/,
)
source(
  'wiring: and hands it to the merge as holidayNames',
  appState,
  /holidayNames: holidayNameMap\(\{/,
)
source(
  'wiring: preferring the country the user configured',
  appState,
  /holidayNameMap\(\{[\s\S]{0,160}?prefer: live\.settings\.greetingCountry/,
)

// ===========================================================================
// Self-test
// ===========================================================================

if (SELFTEST) {
  let caught = 0
  const probes = [
    [
      'greeting every day of a nine-day holiday',
      () => holidaysForCountry('CN', 2026, NOBODY).some((h) => h.date === '2026-02-16'),
    ],
    [
      'greeting a 调休 make-up workday',
      () => holidaysForCountry('CN', 2026, NOBODY).some((h) => h.date === '2026-02-14'),
    ],
    [
      'extrapolating a year nobody has published',
      () => holidaysForCountry('CN', 2031, NOBODY).some((h) => h.source === 'statutory'),
    ],
    [
      'offering a date that has already gone',
      () =>
        planGreetings([cn(1)], 2026, {
          now: new Date(2026, 9, 1, 12, 0).getTime(),
          calendar: PLAIN,
          statutoryCache: [],
        }).some((o) => o.date === '2026-10-01'),
    ],
    [
      'giving French contacts the Chinese name for 1 January',
      () => {
        const plan = planGreetings([cn(1), fr(1)], 2026, {
          now: EARLY,
          calendar: PLAIN,
          statutoryCache: [],
          defaultCountry: 'CN',
        })
        const one = plan.filter((o) => o.date === '2026-01-01')
        return new Set(one.map((o) => o.name)).size < 2
      },
    ],
    [
      'a name map that only knows China, leaving {{holiday}} blank elsewhere',
      () =>
        holidayNameMap({ years: [2026], prefer: 'CN', statutoryCache: [] }).get('2026-07-14') ===
        undefined,
    ],
    [
      'the planner reaching for the mailer',
      () => /sendNow|sendDraftNow|sendMail/.test(greetSource),
    ],
    [
      'creating reminders with no confirmation',
      () =>
        !/const createGreetings = async \(\) => \{[\s\S]{0,400}?await confirm\(/.test(settingsView),
    ],
    [
      'the settings card sending rather than scheduling',
      () => /sendDraftNow|bridge\.sendNow/.test(settingsView),
    ],
  ]
  for (const [label, isBroken] of probes) {
    if (isBroken()) console.error(`SELFTEST FAIL  ${label} was not caught`)
    else caught++
  }
  console.log(`selftest: ${caught}/${probes.length} broken states would be caught`)
  if (caught !== probes.length) failures.push('selftest')
}

// ---------------------------------------------------------------------------

await rm(dir, { recursive: true, force: true })

const label = 'holiday greetings name the day, and never send by themselves'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
