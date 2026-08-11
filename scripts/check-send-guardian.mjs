/**
 * Adversarial corpus for `core/sendGuardian.ts`'s four pre-send heuristics.
 *
 * The stakes here are asymmetric on purpose: a missed catch costs nothing
 * (the send just goes out the way it would have without this feature at
 * all), but a false positive on a real, correctly-written message trains
 * someone to stop reading the banner — the same failure mode `HealthBoard`'s
 * doc comment describes for its own strip. So this file is deliberately
 * heavier on negative cases than positive ones: every positive case below is
 * paired with at least one negative case that looks similar on the surface
 * and must NOT be flagged, and several negative cases exist purely to prove
 * a specific disambiguation (Spanish "mañana" vs "esta mañana", Russian
 * "вложение" the investment vs "вложение" the attachment, the JS regex `\b`
 * word-boundary trap on Cyrillic/Arabic script) actually holds.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-send-guardian-'))

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'src/core/sendGuardian.ts')}"`,
      '--bundle',
      '--format=esm',
      `--outfile="${join(out, 'sg.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { checkMissingAttachment, checkStaleDatePhrase, checkTypoDomain, checkMassTo, runSendGuardian } = await import(
  pathToFileURL(join(out, 'sg.mjs')).href
)
rmSync(out, { recursive: true, force: true })

let passed = 0
let failed = 0
const problems = []

function check(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    passed++
  } else {
    failed++
    problems.push(`${name}: expected ${w}, got ${g}`)
  }
}

/** Any non-null finding, without pinning down its exact shape. */
function flagged(name, got) {
  check(name, got !== null && got !== undefined, true)
}
function clear(name, got) {
  check(name, got, null)
}

const DAY = 86_400_000
const now = Date.now()
const many = (n) => Array.from({ length: n }, (_, i) => `p${i}@example.com`)

// =============================================================================
// 1. Missing attachment
// =============================================================================

flagged('en "see attached" with nothing attached', checkMissingAttachment('Please see attached for details', 0))
flagged('en "please find attached"', checkMissingAttachment('Please find attached the report', 0))
flagged('en "I have attached"', checkMissingAttachment('I have attached the invoice', 0))
flagged('zh "附件" with nothing attached', checkMissingAttachment('请查看附件，谢谢', 0))
flagged('fr "pièce jointe"', checkMissingAttachment('Voir la pièce jointe pour les détails', 0))
flagged('fr "ci-joint"', checkMissingAttachment('Vous trouverez ci-joint le document', 0))
flagged('es "archivo adjunto"', checkMissingAttachment('Encontrarás el archivo adjunto aquí', 0))
flagged('ru "прикрепленный файл"', checkMissingAttachment('Смотрите прикрепленный файл', 0))
flagged('ru "во вложении"', checkMissingAttachment('Документ во вложении', 0))
flagged('ar "المرفق"', checkMissingAttachment('الرجاء الاطلاع على المرفق', 0))

clear('en mention, but a file really is attached', checkMissingAttachment('Please see attached for details', 1))
clear('en no mention at all', checkMissingAttachment('Lets grab lunch tomorrow, no files needed', 0))
clear('en explicit negation: "no attachment"', checkMissingAttachment('There is no attachment needed for this one', 0))
clear('zh explicit negation: "没有附件"', checkMissingAttachment('这次没有附件', 0))
clear('zh explicit negation: "不需要附件"', checkMissingAttachment('这次不需要附件', 0))
clear('fr explicit negation: "sans pièce jointe"', checkMissingAttachment('Ce message part sans pièce jointe', 0))
clear('es explicit negation: "sin adjunto"', checkMissingAttachment('Este correo va sin adjunto', 0))
clear('ru explicit negation: "не прикреплен"', checkMissingAttachment('Файл не прикреплен к письму', 0))
clear('ar explicit negation: "بدون مرفق"', checkMissingAttachment('هذه الرسالة بدون مرفق', 0))
clear('empty body', checkMissingAttachment('', 0))
clear(
  'ru "вложение" as investment, not attachment — must not false-positive on the ordinary financial sense',
  checkMissingAttachment('Инвестиции принесли большое вложение денег в этом квартале', 0),
)

// =============================================================================
// 2. Stale relative-date phrase
// =============================================================================

flagged(
  'en "tomorrow" scheduled 9 days out (the motivating example)',
  checkStaleDatePhrase('See you tomorrow!', now + 9 * DAY, now),
)
check(
  'stale-date finding carries the day count',
  checkStaleDatePhrase('See you tomorrow!', now + 9 * DAY, now),
  { rule: 'staleDate', key: 'sendGuardian.staleDate', severity: 'warning', values: { days: 9 } },
)
flagged('en "today" scheduled 5 days out', checkStaleDatePhrase("Today's the day!", now + 5 * DAY, now))
flagged('en "next Monday" scheduled 30 days out', checkStaleDatePhrase('Next Monday we start', now + 30 * DAY, now))
flagged('zh "明天" scheduled 10 days out', checkStaleDatePhrase('明天见！', now + 10 * DAY, now))
flagged('fr "demain" scheduled 10 days out', checkStaleDatePhrase('On se voit demain', now + 10 * DAY, now))
flagged(
  'es bare "mañana" (tomorrow sense) scheduled 10 days out',
  checkStaleDatePhrase('Nos vemos mañana en la oficina', now + 10 * DAY, now),
)
flagged('ru "завтра" scheduled 10 days out', checkStaleDatePhrase('Увидимся завтра вечером', now + 10 * DAY, now))
flagged('ar "غدا" scheduled 10 days out', checkStaleDatePhrase('أراك غدا في المكتب', now + 10 * DAY, now))

clear('en "tomorrow" scheduled 1 day out — exactly what it says', checkStaleDatePhrase('See you tomorrow!', now + 1 * DAY, now))
clear('en "tomorrow" with no schedule at all (immediate send)', checkStaleDatePhrase('See you tomorrow!', undefined, now))
clear('en "today" scheduled 1 hour out', checkStaleDatePhrase("Today's the day!", now + 3_600_000, now))
clear(
  'en "next week" scheduled only 5 days out — under the generous next-period threshold',
  checkStaleDatePhrase('Next week we start planning', now + 5 * DAY, now),
)
clear('no relative-date phrase at all, scheduled far out', checkStaleDatePhrase('Just checking in on the project status', now + 60 * DAY, now))
clear(
  'es "esta mañana" (this-morning sense) must not be read as "tomorrow"',
  checkStaleDatePhrase('Buenos días, esta mañana revisamos el informe', now + 10 * DAY, now),
)
clear(
  'es "por la mañana" (in-the-morning sense) must not be read as "tomorrow"',
  checkStaleDatePhrase('Nos vemos por la mañana para el café', now + 10 * DAY, now),
)
clear('a scheduled time already in the past', checkStaleDatePhrase('See you tomorrow!', now - 1000, now))

// =============================================================================
// 3. Recipient domain resembling a familiar one (typo)
// =============================================================================

const gmailHistory = [{ address: 'me@gmail.com', count: 20 }]

check(
  'gmail.com -> gmial.com (transposition) is caught, with both names in the finding',
  checkTypoDomain(['someone@gmial.com'], gmailHistory),
  {
    rule: 'typoDomain',
    key: 'sendGuardian.typoDomain',
    severity: 'warning',
    values: { typo: 'gmial.com', suggestion: 'gmail.com' },
  },
)
flagged('outlook.com -> outlok.com (dropped letter)', checkTypoDomain(['x@outlok.com'], [{ address: 'a@outlook.com', count: 5 }]))
flagged('company.com -> compnay.com (two-letter swap, distance 2)', checkTypoDomain(['x@compnay.com'], [{ address: 'a@company.com', count: 10 }]))
flagged(
  'the familiar domain can come from several history rows, summed',
  checkTypoDomain(['x@gmial.com'], [{ address: 'a@gmail.com', count: 2 }, { address: 'b@gmail.com', count: 2 }]),
)

clear('an exact match against history is never a typo', checkTypoDomain(['me@gmail.com'], gmailHistory))
clear(
  'a domain used only once before is not "often" — no flag even though it is a near-miss',
  checkTypoDomain(['x@gmial.com'], [{ address: 'a@gmail.com', count: 1 }]),
)
clear(
  'the candidate domain is itself well-established, despite resembling another familiar one',
  checkTypoDomain(
    ['x@acme-corp.co'],
    [
      { address: 'a@acme-corp.com', count: 10 },
      { address: 'b@acme-corp.co', count: 8 },
    ],
  ),
)
clear('a genuinely unrelated domain (large edit distance)', checkTypoDomain(['x@yahoo.com'], gmailHistory))
clear(
  'very short domains are excluded — a 1-char edit there is noise, not signal',
  checkTypoDomain(['x@y.co'], [{ address: 'a@x.co', count: 10 }]),
)
clear('no history at all', checkTypoDomain(['x@gmial.com'], []))
clear('no recipients at all', checkTypoDomain([], gmailHistory))

// =============================================================================
// 4. Many recipients, all in To
// =============================================================================

flagged('15 recipients, all in To, no Bcc', checkMassTo({ to: many(15), bcc: [], individualDelivery: false, mergeEnabled: false }))
check(
  'mass-To finding carries the recipient count',
  checkMassTo({ to: many(20), bcc: [], individualDelivery: false, mergeEnabled: false }),
  { rule: 'massTo', key: 'sendGuardian.massTo', severity: 'warning', values: { n: 20 } },
)

clear('14 recipients — just under the threshold', checkMassTo({ to: many(14), bcc: [], individualDelivery: false, mergeEnabled: false }))
clear(
  'individual delivery already sends one message per recipient — nothing exposed',
  checkMassTo({ to: many(20), bcc: [], individualDelivery: true, mergeEnabled: false }),
)
clear(
  'mail merge already sends one message per recipient — nothing exposed',
  checkMassTo({ to: many(20), bcc: [], individualDelivery: false, mergeEnabled: true }),
)
clear(
  'Bcc is already in use — the draft already has the right idea',
  checkMassTo({ to: many(20), bcc: ['someone@example.com'], individualDelivery: false, mergeEnabled: false }),
)
clear('two colleagues on one thread — not a crowd', checkMassTo({ to: many(2), bcc: [], individualDelivery: false, mergeEnabled: false }))

// =============================================================================
// Aggregate: runSendGuardian
// =============================================================================

{
  const findings = runSendGuardian({
    body: 'Please see attached. See you tomorrow!',
    to: many(16),
    cc: [],
    bcc: [],
    attachmentCount: 0,
    individualDelivery: false,
    mergeEnabled: false,
    scheduledAt: now + 9 * DAY,
    recipientHistory: [],
    now,
  })
  const rules = findings.map((f) => f.rule).sort()
  check(
    'a draft tripping three separate checks reports all three, and only those three',
    rules,
    ['massTo', 'missingAttachment', 'staleDate'],
  )
}

{
  // The whole point of wrapping each check: one broken input must not cost
  // the other three their findings, and must not throw at all. `address` is
  // a getter that throws the instant it is read — the same shape a corrupted
  // `state.json` entry or a future schema change could produce, and something
  // no static type ever protects a *runtime* value against.
  const evilHistory = [
    {
      get address() {
        throw new Error('simulated corrupt history entry')
      },
      count: 1,
    },
  ]
  let findings
  let threw = false
  try {
    findings = runSendGuardian({
      body: 'Please see attached. See you tomorrow!',
      to: many(16),
      cc: [],
      bcc: [],
      attachmentCount: 0,
      individualDelivery: false,
      mergeEnabled: false,
      scheduledAt: now + 9 * DAY,
      recipientHistory: evilHistory,
      now,
    })
  } catch {
    threw = true
  }
  check('runSendGuardian never throws, even when one check`s input blows up', threw, false)
  const rules = (findings ?? []).map((f) => f.rule).sort()
  check(
    'the three unaffected checks still report, with only typoDomain silently dropped',
    rules,
    ['massTo', 'missingAttachment', 'staleDate'],
  )
}

{
  // A completely empty, untouched draft: nothing should ever fire. This is
  // the state the compose screen is actually in most often, and it is the
  // one case every one of the four checks must independently agree is quiet.
  const findings = runSendGuardian({
    body: '',
    to: [],
    cc: [],
    bcc: [],
    attachmentCount: 0,
    individualDelivery: false,
    mergeEnabled: false,
    scheduledAt: undefined,
    recipientHistory: [],
    now,
  })
  check('an empty draft produces no findings at all', findings, [])
}

{
  // A normal, correctly-written, everyday message: a short note to one
  // familiar colleague, no attachment mentioned, no relative dates, sent
  // right now. If this ever starts producing a finding, one of the four
  // heuristics has drifted loose.
  const findings = runSendGuardian({
    body: 'Hi Sam, sounds good — talk soon.',
    to: ['sam@company.com'],
    cc: [],
    bcc: [],
    attachmentCount: 0,
    individualDelivery: false,
    mergeEnabled: false,
    scheduledAt: undefined,
    recipientHistory: [{ address: 'sam@company.com', count: 40 }],
    now,
  })
  check('an ordinary, correct everyday message produces no findings', findings, [])
}

// =============================================================================

const total = passed + failed
for (const line of problems) console.error(`  FAIL  ${line}`)
console.log(`\ncheck:send-guardian — ${passed}/${total} passed`)

if (failed > 0) {
  console.error('\nFAILED')
  process.exit(1)
}
console.log('All clear.')
