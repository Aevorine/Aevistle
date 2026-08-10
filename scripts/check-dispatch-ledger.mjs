/**
 * The gate on the dispatch ledger's restart-recovery decision table.
 *
 * This is the single most important thing in the whole feature to get right:
 * `resolveLedgerEntryOnRestart` is the one function that decides, after a
 * crash, whether an occurrence gets resent or left alone. Get it wrong in one
 * direction and a reminder silently never arrives — the exact failure this
 * ledger replaces a mechanism specifically to stop. Get it wrong in the other
 * direction and every crash starts sending duplicates. So this corpus is
 * adversarial on purpose: it does not just check the three documented states,
 * it checks that stray fields (an old `claimedAt`, a missing `acceptedAt`, a
 * corrupted `state` string that should never exist on disk) cannot flip the
 * answer — the function must key off `state` and nothing else, and an unknown
 * `state` must fail *safe*, meaning towards a resend, not towards silence.
 *
 * The last block checks the property that makes this "purely additive":
 * an occurrence with no ledger entry at all — a job that has never been
 * touched by any of this — must never be treated as claimed or fired by
 * restart recovery. `resolveLedgerEntryOnRestart` only ever sees entries that
 * exist, so that guarantee is checked the way `Scheduler.restoreDispatchLedger`
 * actually provides it: by running its exact iterate-and-partition shape over
 * a set of entries that does not include the occurrence in question, and
 * confirming nothing about it ends up in either bucket.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-ledger-'))

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      `"${join(root, 'src/core/dispatchLedger.ts')}"`,
      '--bundle',
      '--format=esm',
      `--outfile="${join(out, 'dl.mjs')}"`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const { resolveLedgerEntryOnRestart, mintMessageId, spliceForcedResends } = await import(
  pathToFileURL(join(out, 'dl.mjs')).href
)
rmSync(out, { recursive: true, force: true })

let passed = 0
let failed = 0
const problems = []

function entry(overrides = {}) {
  return {
    claimKey: 'job-1:1000',
    jobId: 'job-1',
    occurrenceMs: 1000,
    state: 'claimed',
    messageId: '<job-1:1000.deadbeef@aevistle.local>',
    claimedAt: 1000,
    attempts: 1,
    ...overrides,
  }
}

function check(name, got, want) {
  if (got === want) {
    passed++
  } else {
    failed++
    problems.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// --- the documented decision table, exactly ---------------------------------

check('claimed -> resend', resolveLedgerEntryOnRestart(entry({ state: 'claimed' })), 'resend')
check('sending -> resend', resolveLedgerEntryOnRestart(entry({ state: 'sending', sendingAt: 2000 })), 'resend')
check(
  'accepted -> complete-bookkeeping-only',
  resolveLedgerEntryOnRestart(entry({ state: 'accepted', sendingAt: 2000, acceptedAt: 3000 })),
  'complete-bookkeeping-only',
)

// --- adversarial: only `state` may drive the answer -------------------------

check(
  'accepted, but claimedAt is a year old — age must not override positive proof',
  resolveLedgerEntryOnRestart(entry({ state: 'accepted', claimedAt: Date.now() - 365 * 24 * 60 * 60 * 1000, acceptedAt: Date.now() })),
  'complete-bookkeeping-only',
)
check(
  'accepted, but sendingAt/acceptedAt are both absent — the state field alone must decide',
  resolveLedgerEntryOnRestart(entry({ state: 'accepted', sendingAt: undefined, acceptedAt: undefined })),
  'complete-bookkeeping-only',
)
check(
  'sending, attempts is high (many prior crashes) — still resend, not "give up and complete"',
  resolveLedgerEntryOnRestart(entry({ state: 'sending', sendingAt: 5000, attempts: 40 })),
  'resend',
)
check(
  'claimed, but sendingAt is somehow already set (stale/inconsistent write) — state still wins',
  resolveLedgerEntryOnRestart(entry({ state: 'claimed', sendingAt: 4000 })),
  'resend',
)
check(
  'unknown/corrupted state string must fail SAFE — towards resend, never towards silence',
  resolveLedgerEntryOnRestart(entry({ state: 'bogus-corrupted-state' })),
  'resend',
)
check(
  'empty-string state must fail safe too',
  resolveLedgerEntryOnRestart(entry({ state: '' })),
  'resend',
)

// --- mintMessageId ------------------------------------------------------------

{
  const id = mintMessageId('job-9:12345')
  const RFC5322_SHAPED = /^<job-9:12345\.[0-9a-f]{16}@aevistle\.local>$/
  if (!RFC5322_SHAPED.test(id)) {
    failed++
    problems.push(`mintMessageId shape: "${id}" does not match ${RFC5322_SHAPED}`)
  } else {
    passed++
  }
}
{
  // Two mints for the *same* claimKey must not collide — the random suffix is
  // what makes reuse-vs-mint-fresh a real choice for the caller, not a no-op.
  const a = mintMessageId('job-9:12345')
  const b = mintMessageId('job-9:12345')
  if (a === b) {
    failed++
    problems.push(`mintMessageId is not random per call: two mints of the same claimKey produced ${a}`)
  } else {
    passed++
  }
}
{
  // A thousand distinct claimKeys must produce a thousand distinct ids —
  // no cross-claimKey collision.
  const ids = new Set()
  for (let i = 0; i < 1000; i++) ids.add(mintMessageId(`job-${i}:${i}`))
  if (ids.size !== 1000) {
    failed++
    problems.push(`mintMessageId collided across claimKeys: only ${ids.size}/1000 unique`)
  } else {
    passed++
  }
}

// --- purely additive: a MISSING entry must behave exactly as "never claimed" -

{
  /*
   * Mirrors `Scheduler.restoreDispatchLedger`'s own iterate-and-partition
   * shape (see electron/scheduler.ts): every entry actually on disk gets
   * resolved into either "dropped, occurrence fires normally" or "protected
   * from resend, bookkeeping-only". An occurrence this device never claimed
   * has no entry in that list at all — it is never visited by either branch,
   * so it must land in neither bucket. That is what "purely additive" means:
   * a job with zero ledger history schedules and fires exactly as it did
   * before this feature existed, because nothing here ever touches it.
   */
  const onDiskEntries = [
    entry({ claimKey: 'job-A:1000', jobId: 'job-A', occurrenceMs: 1000, state: 'claimed' }),
    entry({ claimKey: 'job-B:2000', jobId: 'job-B', occurrenceMs: 2000, state: 'accepted', acceptedAt: 2500 }),
  ]
  const untouchedClaimKey = 'job-C:3000' // never claimed by anything — no entry exists for it

  const droppedForResend = new Set()
  const protectedFromResend = new Set()
  for (const e of onDiskEntries) {
    if (resolveLedgerEntryOnRestart(e) === 'resend') droppedForResend.add(e.claimKey)
    else protectedFromResend.add(e.claimKey)
  }

  if (droppedForResend.has(untouchedClaimKey) || protectedFromResend.has(untouchedClaimKey)) {
    failed++
    problems.push('a claimKey with no ledger entry was treated as claimed by restart recovery')
  } else {
    passed++
  }
  // And the two entries that *do* exist landed in the buckets they should have.
  check('job-A (claimed) lands in the resend bucket', droppedForResend.has('job-A:1000'), true)
  check('job-B (accepted) lands in the protected bucket', protectedFromResend.has('job-B:2000'), true)
}

// --- spliceForcedResends: the catchUp:'skip' silent-drop bug, adversarially -

{
  // The bug this closes: a job with `catchUp: 'skip'` has `rearm()` drop
  // every missed occurrence, including one the ledger says was claimed or
  // mid-send when the process died. Modelling that exactly: `rearm()` already
  // ran and produced an empty `occurrences` array (what a skip-policy job's
  // real `owed`/`upcoming` looks like after a missed, unconfirmed send), and
  // `spliceForcedResends` is the only thing standing between that and a
  // silent, permanent miss.
  const pending = [{ jobId: 'job-1', occurrenceMs: 1000 }]
  check(
    'a catchUp:skip job with an empty occurrences array still gets its pending resend forced in',
    JSON.stringify(spliceForcedResends([], 'job-1', pending)),
    JSON.stringify([1000]),
  )
}
{
  // Must not duplicate an occurrence `rearm()` already carried through on its
  // own (e.g. a catchUp:'fireOnce' job, or a skip-policy job whose missed
  // occurrence rearm kept for some other reason) — the resend is a fallback,
  // not an unconditional prepend.
  const pending = [{ jobId: 'job-1', occurrenceMs: 1000 }]
  check(
    'an occurrence rearm() already kept is not duplicated',
    JSON.stringify(spliceForcedResends([1000, 2000], 'job-1', pending)),
    JSON.stringify([1000, 2000]),
  )
}
{
  // A pending resend for a DIFFERENT job must never leak onto this one —
  // the whole point is per-job, per-occurrence targeting.
  const pending = [{ jobId: 'job-OTHER', occurrenceMs: 9999 }]
  check(
    "a pending resend for a different job's occurrence is not spliced in",
    JSON.stringify(spliceForcedResends([1000], 'job-1', pending)),
    JSON.stringify([1000]),
  )
}
{
  // Multiple pending entries for the same job, one already present.
  const pending = [
    { jobId: 'job-1', occurrenceMs: 1000 },
    { jobId: 'job-1', occurrenceMs: 3000 },
  ]
  check(
    'multiple pending resends for the same job: only the missing one is added',
    JSON.stringify(spliceForcedResends([1000], 'job-1', pending).sort((a, b) => a - b)),
    JSON.stringify([1000, 3000]),
  )
}
{
  // No pending resends at all — the array must come back unchanged in value.
  check(
    'no pending resends: occurrences pass through untouched',
    JSON.stringify(spliceForcedResends([1000, 2000], 'job-1', [])),
    JSON.stringify([1000, 2000]),
  )
}

// --- structural: the raw-vs-live-job bug can't silently come back ----------
//
// `electron/scheduler.ts` imports `electron`-dependent code and cannot be
// executed standalone here (see `electron/store.ts`'s `import ... from
// 'electron'`) — this mirrors `scripts/audit.mjs`'s established pattern for
// exactly that situation: a targeted structural check on the source itself,
// for the one bug class a unit test on the pure functions above cannot catch
// (this was a data-flow bug — the wrong *object* being checked — not a
// wrong-algorithm bug). Finding: `completeAcceptedRecovery` was checking
// `job.occurrences` (the scheduler's own post-`owed`-filter copy, which had
// already had this exact occurrence stripped out by the very `fired`-set
// membership recovery itself seeded) instead of the renderer's raw,
// unfiltered state — making the accepted-entry bookkeeping path dead code.

{
  const scheduler = readFileSync(new URL('../electron/scheduler.ts', import.meta.url), 'utf8')
  const fn = scheduler.match(/private async completeAcceptedRecovery\([\s\S]*?\n  \}/)
  if (!fn) {
    failed++
    problems.push('completeAcceptedRecovery not found in electron/scheduler.ts — has it been renamed or moved?')
  } else {
    check('completeAcceptedRecovery checks rawJob.occurrences, not job.occurrences', /rawJob\.occurrences\.includes/.test(fn[0]), true)
    // Case-sensitive and un-word-bounded on purpose: "rawJob.occurrences..."
    // has a capital J at this position, so a lowercase, boundary-anchored
    // `job.occurrences...` cannot accidentally match inside it — this only
    // fires on a genuine standalone `job.occurrences.includes(...)` call.
    check(
      'completeAcceptedRecovery does NOT check job.occurrences (the bug pattern)',
      /\bjob\.occurrences\.includes\(entry\.occurrenceMs\)/.test(fn[0]),
      false,
    )
  }
  check(
    'resolvePendingLedgerRecovery is called with the raw jobs argument, not this.jobs',
    /this\.resolvePendingLedgerRecovery\(jobs\)/.test(scheduler),
    true,
  )
  check(
    'resolvePendingLedgerRecovery is NOT called with this.jobs (the bug pattern)',
    /this\.resolvePendingLedgerRecovery\(this\.jobs\)/.test(scheduler),
    false,
  )
}

const total = passed + failed
for (const line of problems) console.error(`  FAIL  ${line}`)
console.log(`\ncheck:dispatch-ledger — ${passed}/${total} passed`)

if (failed > 0) {
  console.error('\nFAILED')
  process.exit(1)
}
console.log('All clear.')
