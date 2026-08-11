/**
 * Table-driven check of the natural-time parser — `npm run check:time`.
 *
 * There is no test runner in this project and this is not an argument for
 * adding one; it is one pure function whose failure mode is a reminder firing
 * on the wrong day, which is exactly the kind of thing a table of examples
 * catches and a type checker does not.
 *
 * "now" is pinned to a Wednesday at 14:20 so the weekday arithmetic has a
 * fixed answer to be right or wrong about. Left floating, "每周一" would pass
 * or fail depending on which day the check happened to run.
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'aevistle-nt-'))
const bundle = join(dir, 'naturalTime.mjs')
await build({
  entryPoints: ['src/core/schedule/naturalTime.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { parseNaturalTime } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const NOW = new Date(2026, 7, 5, 14, 20, 0, 0) // Wed 2026-08-05 14:20 local

const pad = (n) => String(n).padStart(2, '0')
const fmt = (ms) => {
  const d = new Date(ms)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${days[d.getDay()]}`
}

const CASES = [
  ['明天早上9点', 'once', '2026-08-06 09:00 Thu'],
  ['明天 9:30', 'once', '2026-08-06 09:30 Thu'],
  ['后天下午3点', 'once', '2026-08-07 15:00 Fri'],
  ['今天下午六点', 'once', '2026-08-05 18:00 Wed'],
  ['三天后', 'once', '2026-08-08 09:00 Sat'],
  ['2小时后', 'once', '2026-08-05 16:20 Wed'],
  ['30分钟后', 'once', '2026-08-05 14:50 Wed'],
  ['每周一 8:30', 'weekly', '2026-08-10 08:30 Mon'],
  ['每周一三五 早上八点', 'weekly', '2026-08-07 08:00 Fri'],
  ['每个工作日 9:00', 'weekly', '2026-08-06 09:00 Thu'],
  ['每天早上七点半', 'daily', '2026-08-06 07:30 Thu'],
  ['每月1号 10:00', 'monthly', '2026-09-01 10:00 Tue'],
  ['每15分钟', 'interval', '2026-08-05 14:35 Wed'],
  ['下周二 14:00', 'once', '2026-08-11 14:00 Tue'],
  ['8月20日 9点', 'once', '2026-08-20 09:00 Thu'],
  ['2027-01-15 09:30', 'once', '2027-01-15 09:30 Fri'],
  ['3月5日', 'once', '2027-03-05 09:00 Fri'], // already past this year → next year
  ['9:00', 'once', '2026-08-06 09:00 Thu'], // bare time already gone today
  ['16:00', 'once', '2026-08-05 16:00 Wed'],
  ['中午12点', 'once', '2026-08-06 12:00 Thu'],
  ['tomorrow at 9', 'once', '2026-08-06 09:00 Thu'],
  ['daily 8:00', 'daily', '2026-08-06 08:00 Thu'],
  ['随便写点什么', null, null],
  ['', null, null],
]

let pass = 0
const failures = []
for (const [input, kind, expected] of CASES) {
  const parsed = parseNaturalTime(input, NOW)
  if (kind === null) {
    if (parsed === null) {
      pass++
      console.log(`  ok    ${JSON.stringify(input).padEnd(24)} → (not understood)`)
    } else {
      failures.push(`${input}: expected no match, got ${fmt(parsed.recurrence.startAt)}`)
    }
    continue
  }
  if (!parsed) {
    failures.push(`${input}: expected ${kind} ${expected}, got no match`)
    continue
  }
  const got = fmt(parsed.recurrence.startAt)
  const okKind = parsed.recurrence.kind === kind
  const okTime = got === expected
  if (okKind && okTime) {
    pass++
    console.log(`  ok    ${input.padEnd(22)} → ${parsed.recurrence.kind.padEnd(8)} ${got}`)
  } else {
    failures.push(
      `${input}: expected ${kind} ${expected}, got ${parsed.recurrence.kind} ${got}` +
        (parsed.recurrence.weekdays ? ` weekdays=${parsed.recurrence.weekdays}` : ''),
    )
  }
}

console.log(`\n${pass}/${CASES.length} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
