/**
 * Prove `src/core/schedule/solarTerms.ts` against published astronomical instants.
 *
 * The four terms with a name everyone would recognise — the two equinoxes and
 * the two solstices — are also the four for which an independent published UTC
 * instant is easy to state and check without disputing anyone's transcription:
 * these are the commonly published times (e.g. timeanddate.com's "March
 * equinox" tables), accurate to the minute. The other twenty terms have no
 * comparable independent reference to check against by hand, so they get a
 * structural check instead — 24 a year, chronological, ~15 days apart, and the
 * boundary logic agrees with the direct lookup it is supposed to summarise.
 *
 * Bundled with esbuild rather than imported directly, same as `check-qr.mjs`:
 * this is a `.ts` module and the checker is plain Node.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// [year, term id, expected UTC instant, tolerance in minutes]. Tolerance is
// generous relative to the module's actual accuracy (observed under 3 minutes
// across this whole span) — it is here to catch a broken formula, not to
// chase the last digit of an ephemeris.
const KNOWN_INSTANTS = [
  ['2020', 'chunfen', '2020-03-20T03:50:00Z', 15],
  ['2021', 'chunfen', '2021-03-20T09:37:00Z', 15],
  ['2022', 'chunfen', '2022-03-20T15:33:00Z', 15],
  ['2023', 'chunfen', '2023-03-20T21:24:00Z', 15],
  ['2024', 'chunfen', '2024-03-20T03:06:00Z', 15],
  ['2025', 'chunfen', '2025-03-20T09:01:00Z', 15],
  ['2020', 'xiazhi', '2020-06-20T21:44:00Z', 15],
  ['2021', 'xiazhi', '2021-06-21T03:32:00Z', 15],
  ['2022', 'xiazhi', '2022-06-21T09:14:00Z', 15],
  ['2023', 'xiazhi', '2023-06-21T14:58:00Z', 15],
  ['2024', 'xiazhi', '2024-06-20T20:51:00Z', 15],
  ['2025', 'xiazhi', '2025-06-21T02:42:00Z', 15],
  ['2020', 'qiufen', '2020-09-22T13:31:00Z', 15],
  ['2021', 'qiufen', '2021-09-22T19:21:00Z', 15],
  ['2022', 'qiufen', '2022-09-23T01:04:00Z', 15],
  ['2023', 'qiufen', '2023-09-23T06:50:00Z', 15],
  ['2024', 'qiufen', '2024-09-22T12:44:00Z', 15],
  ['2025', 'qiufen', '2025-09-22T18:19:00Z', 15],
  ['2020', 'dongzhi', '2020-12-21T10:02:00Z', 15],
  ['2021', 'dongzhi', '2021-12-21T15:59:00Z', 15],
  ['2022', 'dongzhi', '2022-12-21T21:48:00Z', 15],
  ['2023', 'dongzhi', '2023-12-22T03:27:00Z', 15],
  ['2024', 'dongzhi', '2024-12-21T09:20:00Z', 15],
  ['2025', 'dongzhi', '2025-12-21T15:03:00Z', 15],
]

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-solarterms-'))

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      quote(join(root, 'src/core/schedule/solarTerms.ts')),
      '--bundle',
      '--format=esm',
      `--outfile=${quote(join(out, 'solarTerms.mjs'))}`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { termsForYear, activeSolarTerm, activeSolarTermForMonth } = await import(
  pathToFileURL(join(out, 'solarTerms.mjs')).href
)

rmSync(out, { recursive: true, force: true })

let failures = 0
let checked = 0

// --- the four named instants, against published UTC times ------------------
for (const [year, id, expectedIso, toleranceMin] of KNOWN_INSTANTS) {
  checked++
  const terms = termsForYear(Number(year))
  const term = terms.find((t) => t.id === id)
  if (!term) {
    console.error(`✗ ${year} produced no '${id}' term at all`)
    failures++
    continue
  }
  const diffMin = Math.abs(term.at - Date.parse(expectedIso)) / 60000
  if (diffMin > toleranceMin) {
    console.error(
      `✗ ${year} ${id}: got ${new Date(term.at).toISOString()}, expected ${expectedIso} ± ${toleranceMin}min (off by ${diffMin.toFixed(1)}min)`,
    )
    failures++
  } else {
    console.log(`  ok  ${year} ${id}  ${new Date(term.at).toISOString()}  (Δ ${diffMin.toFixed(1)}min)`)
  }
}

// --- structural shape: 24 a year, chronological, ~15 days apart -------------
for (const year of [1901, 1950, 2000, 2026, 2050, 2099]) {
  checked++
  const terms = termsForYear(year)
  if (terms.length !== 24) {
    console.error(`✗ ${year}: expected 24 terms, got ${terms.length}`)
    failures++
    continue
  }
  let ok = true
  for (let i = 1; i < terms.length; i++) {
    const gapDays = (terms[i].at - terms[i - 1].at) / 86400000
    if (gapDays < 13 || gapDays > 17) {
      console.error(
        `✗ ${year}: gap between ${terms[i - 1].id} and ${terms[i].id} is ${gapDays.toFixed(2)} days, expected ~14-16`,
      )
      ok = false
    }
  }
  const ids = new Set(terms.map((t) => t.id))
  if (ids.size !== 24) {
    console.error(`✗ ${year}: duplicate or missing term id, ${ids.size} distinct of 24`)
    ok = false
  }
  if (ok) {
    console.log(`  ok  ${year}: 24 distinct terms, all ~15 days apart, chronological`)
  } else {
    failures++
  }
}

// --- activeSolarTerm agrees with a direct lookup, including across New Year's Day ---
{
  checked++
  const y = 2024
  const terms = termsForYear(y)
  const chunfen = terms.find((t) => t.id === 'chunfen')
  const midway = new Date(chunfen.at + 5 * 86400000) // 5 days into the term, nowhere near its edges
  const got = activeSolarTerm(midway)
  if (got !== 'chunfen') {
    console.error(`✗ activeSolarTerm 5 days after 2024 chunfen returned '${got}', expected 'chunfen'`)
    failures++
  } else {
    console.log(`  ok  activeSolarTerm mid-term lookup: ${midway.toISOString()} -> chunfen`)
  }

  // 2 January: still under the *previous* year's 冬至, since that year's own
  // 小寒 does not land until early January.
  const newYearsWeek = new Date(Date.UTC(y, 0, 2))
  const gotNewYear = activeSolarTerm(newYearsWeek)
  const prevDongzhi = termsForYear(y - 1).find((t) => t.id === 'dongzhi')
  const expected = prevDongzhi.at <= newYearsWeek.getTime() ? 'dongzhi' : 'xiaohan'
  if (gotNewYear !== expected) {
    console.error(`✗ activeSolarTerm(${newYearsWeek.toISOString()}) returned '${gotNewYear}', expected '${expected}'`)
    failures++
  } else {
    console.log(`  ok  activeSolarTerm across New Year's Day -> ${gotNewYear}`)
  }
}

// --- activeSolarTermForMonth: April should read as qingming or guyu ---------
{
  checked++
  const got = activeSolarTermForMonth(2024, 3) // April, 0-indexed month
  if (got !== 'qingming' && got !== 'guyu') {
    console.error(`✗ activeSolarTermForMonth(2024, April) returned '${got}', expected 'qingming' or 'guyu'`)
    failures++
  } else {
    console.log(`  ok  activeSolarTermForMonth(2024, April) -> ${got}`)
  }
}

function quote(p) {
  return `"${p}"`
}

if (failures > 0) {
  console.error(`\ncheck:solarterms FAILED — ${failures} problem(s) across ${checked} checks`)
  process.exit(1)
}
console.log(`\ncheck:solarterms ok — ${checked} checks passed`)
