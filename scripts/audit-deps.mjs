/**
 * Dependency advisories, against the real registry.
 *
 * Two reasons this is a script and not just `npm audit` in package.json:
 *
 * 1. `.npmrc` points at a regional mirror that does not implement the
 *    advisories endpoint at all, so a plain `npm audit` in this repo has
 *    always exited 1 with `[NOT_IMPLEMENTED]`. Which is why, until now, the
 *    project had `audit=false` set and had never once been audited.
 *
 * 2. A network blip must not read the same as a clean result — in either
 *    direction. Failing the whole `check` because a TLS handshake dropped
 *    trains people to rerun until it passes, and passing silently because the
 *    registry was unreachable is the fail-open weakening that `updater.ts`
 *    goes out of its way to avoid with checksum files. So: unreachable is
 *    reported loudly and does not fail the build; a real advisory at or above
 *    the threshold does.
 *
 * Exit code 1 only for advisories that were actually found.
 */

import { spawnSync } from 'node:child_process'

const THRESHOLD = process.argv[2] ?? 'high'
const ORDER = ['info', 'low', 'moderate', 'high', 'critical']
const ATTEMPTS = 2

function runAudit() {
  const result = spawnSync(
    'npm',
    ['audit', '--json', '--registry=https://registry.npmjs.org'],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Required on Windows since Node 18.20: `npm` is `npm.cmd`, and spawning
      // a `.cmd` without a shell now fails outright with EINVAL. Without this
      // the audit never ran at all and this script cheerfully reported
      // "could not reach the advisory database" — the exact fail-open it was
      // written to prevent, produced by the tool doing the preventing.
      shell: process.platform === 'win32',
    },
  )
  // A launch failure is not a network problem and must not be reported as one:
  // it means this check is broken, which is worth someone's attention.
  if (result.error) return { ok: false, broken: true, reason: result.error.message }
  const text = result.stdout ?? ''
  const start = text.indexOf('{')
  if (start < 0) return { ok: false, reason: (result.stderr || 'no output').trim().split('\n').pop() }
  try {
    const parsed = JSON.parse(text.slice(start))
    // npm reports transport failures *inside* the JSON as well as on stderr.
    if (parsed.error) return { ok: false, reason: parsed.error.summary ?? String(parsed.error) }
    if (!parsed.metadata) return { ok: false, reason: 'response had no vulnerability summary' }
    return { ok: true, report: parsed }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

let outcome = null
for (let i = 0; i < ATTEMPTS; i++) {
  outcome = runAudit()
  if (outcome.ok) break
}

console.log('\n  Dependency advisories')

if (!outcome.ok && outcome.broken) {
  // The check itself cannot run. That is a defect in the check, not a verdict
  // about the dependencies, and letting it pass would leave a permanently
  // dead audit reporting "not audited" forever without anyone acting on it.
  console.log(`  ✗ Could not run npm audit at all: ${outcome.reason}`)
  console.log('  This check is broken and is auditing nothing. Fix it.\n')
  process.exit(1)
}

if (!outcome.ok) {
  // Deliberately not exit 1. Nothing is known to be wrong; what is known is
  // that nothing was checked, and saying so is the whole point.
  console.log(`  ⚠ Could not reach the advisory database: ${outcome.reason}`)
  console.log('  Dependencies were NOT audited this run. Re-run `npm run audit:deps` before publishing.\n')
  process.exit(0)
}

const counts = outcome.report.metadata.vulnerabilities ?? {}
const cutoff = ORDER.indexOf(THRESHOLD)
const blocking = []
// npm calls this severity "moderate"; the rest of this project's tooling and
// its threshold argument call it "medium" — same thing, this is just the
// vocabulary `npm audit --json` actually uses.
const MEDIUM_SEVERITY = 'moderate'
const mediumFindings = []
for (const [name, v] of Object.entries(outcome.report.vulnerabilities ?? {})) {
  if (ORDER.indexOf(v.severity) >= cutoff) {
    blocking.push(`${v.severity.padEnd(9)} ${name}${v.isDirect ? '  (direct dependency)' : ''}`)
  } else if (v.severity === MEDIUM_SEVERITY) {
    // Below the default 'high' threshold, so this never fails the build on
    // its own — but "does not fail the build" and "invisible" used to be the
    // same thing here: a medium finding was folded into one aggregate count
    // in the summary line below and never named. Named individually here,
    // the same way a blocking finding already is, so someone skimming normal
    // `npm run check` output can actually tell what it is without having to
    // separately run `npm audit`.
    mediumFindings.push(`${v.severity.padEnd(9)} ${name}${v.isDirect ? '  (direct dependency)' : ''}`)
  }
}

const summary = ORDER.filter((s) => counts[s] > 0)
  .map((s) => `${counts[s]} ${s}`)
  .join(', ')
console.log(`  ${summary || 'none found'} · failing at ${THRESHOLD} and above`)

if (mediumFindings.length > 0) {
  console.log(
    `\n  ${mediumFindings.length} medium (moderate) severity ${mediumFindings.length === 1 ? 'advisory' : 'advisories'} — visible here, does not fail the build:`,
  )
  for (const line of mediumFindings) console.log(`  NOTE  ${line}`)
}

if (blocking.length === 0) {
  console.log(mediumFindings.length > 0 ? '\n  No advisories at or above the failing threshold.\n' : '\n  All clear.\n')
  process.exit(0)
}
console.log('')
for (const line of blocking) console.log(`  FAIL  ${line}`)
console.log('')
process.exit(1)
