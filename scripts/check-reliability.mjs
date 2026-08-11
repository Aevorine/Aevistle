/**
 * The gate on the Reliability Center's triage logic (`src/core/ops/reliability.ts`)
 * and the dispatch-ledger stuck-entry detection it depends on
 * (`src/core/ops/dispatchLedger.ts`'s `isLedgerEntryStuck`/`getStuckLedgerEntries`).
 *
 * Adversarial on purpose, the same way `check-dispatch-ledger.mjs` is: this
 * screen exists specifically to answer "will my scheduled reminders actually
 * go out?", so a false negative here (a genuinely broken job that reads as
 * healthy) is the one outcome worse than the feature not existing at all —
 * it would tell someone everything is fine while it is not. Each collector
 * gets its boundary conditions and its "must NOT flag this" cases checked
 * with the same weight as its "must flag this" cases.
 *
 * `src/core/ops/reliability.ts` imports `classifyError` from `src/core/platform/bridge.ts`,
 * which re-exports lazily-bundled platform implementations
 * (`bridge-desktop.ts`/`bridge-android.ts`/`bridge-web.ts`) behind dynamic
 * `import()`s inside `getBridge()`. Bundling `reliability.ts` directly pulls
 * all of that in too, but esbuild wraps each dynamic import in a lazy loader
 * rather than executing it at module-eval time, so nothing in
 * `bridge-android.ts`'s Capacitor-only top-level code ever runs here — the
 * bundle imports cleanly in plain Node. (Verified by hand before writing this
 * comment; if a future refactor turns that dynamic import into a static one,
 * this script will start throwing on import and that assumption needs
 * revisiting.)
 *
 * Exit code 1 on any failure.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
let passed = 0
let checked = 0
const check = (name, got, want) => {
  checked++
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}
const assert = (name, ok) => {
  checked++
  if (ok) passed++
  else failures.push(name)
}

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-reliability-'))
const entry = path.join(dir, 'entry.ts')
await writeFile(
  entry,
  `export {
  collectUnhealthyJobs,
  collectStuckSends,
  collectAccountIssues,
  collectDeviceSyncIssues,
  DEVICE_STALE_MS,
} from ${JSON.stringify(path.resolve('src/core/ops/reliability.ts'))}
export {
  isLedgerEntryStuck,
  getStuckLedgerEntries,
  LEDGER_STUCK_THRESHOLD_MS,
} from ${JSON.stringify(path.resolve('src/core/ops/dispatchLedger.ts'))}
`,
  'utf8',
)
const bundle = path.join(dir, 'reliability.mjs')
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: bundle,
    logLevel: 'warning',
    platform: 'node',
  })
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

let mod
try {
  mod = await import(pathToFileURL(bundle).href)
} catch (e) {
  console.error('bundle threw on import:', e.message)
  process.exit(1)
} finally {
  await rm(dir, { recursive: true, force: true })
}

const {
  collectUnhealthyJobs,
  collectStuckSends,
  collectAccountIssues,
  collectDeviceSyncIssues,
  DEVICE_STALE_MS,
  isLedgerEntryStuck,
  getStuckLedgerEntries,
  LEDGER_STUCK_THRESHOLD_MS,
} = mod

// ---------------------------------------------------------------------------
// isLedgerEntryStuck / getStuckLedgerEntries
// ---------------------------------------------------------------------------

function ledgerEntry(overrides = {}) {
  return {
    claimKey: 'job-1:1000',
    jobId: 'job-1',
    occurrenceMs: 1000,
    state: 'claimed',
    messageId: '<job-1:1000.deadbeef@aevistle.local>',
    claimedAt: 1_000_000,
    attempts: 1,
    ...overrides,
  }
}

const NOW = 10_000_000

check(
  'claimed entry, well under the threshold, is not stuck',
  isLedgerEntryStuck(ledgerEntry({ claimedAt: NOW - 1000 }), NOW),
  false,
)
check(
  'claimed entry, past the threshold, is stuck',
  isLedgerEntryStuck(ledgerEntry({ claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1 }), NOW),
  true,
)
check(
  'exactly at the threshold counts as stuck (>=, not >)',
  isLedgerEntryStuck(ledgerEntry({ claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS }), NOW),
  true,
)
check(
  'one ms under the threshold does not count as stuck',
  isLedgerEntryStuck(ledgerEntry({ claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS + 1 }), NOW),
  false,
)
check(
  "sending state uses sendingAt, not claimedAt — an old claim with a fresh sendingAt is not stuck",
  isLedgerEntryStuck(
    ledgerEntry({ state: 'sending', claimedAt: NOW - 100 * LEDGER_STUCK_THRESHOLD_MS, sendingAt: NOW - 1000 }),
    NOW,
  ),
  false,
)
check(
  'sending state, old sendingAt, is stuck',
  isLedgerEntryStuck(
    ledgerEntry({ state: 'sending', claimedAt: NOW - 1000, sendingAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1 }),
    NOW,
  ),
  true,
)
check(
  'sending state with sendingAt missing (inconsistent write) falls back to claimedAt',
  isLedgerEntryStuck(
    ledgerEntry({ state: 'sending', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1, sendingAt: undefined }),
    NOW,
  ),
  true,
)
check(
  'a custom threshold is honoured',
  isLedgerEntryStuck(ledgerEntry({ claimedAt: NOW - 5000 }), NOW, 1000),
  true,
)

{
  const entries = [
    ledgerEntry({ claimKey: 'a', claimedAt: NOW - 1000 }), // fresh
    ledgerEntry({ claimKey: 'b', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1 }), // stuck
    ledgerEntry({ claimKey: 'c', state: 'accepted', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1, acceptedAt: NOW - LEDGER_STUCK_THRESHOLD_MS }), // stuck-looking but should still be caught — nothing exempts 'accepted' by construction
  ]
  const stuck = getStuckLedgerEntries(entries, NOW).map((e) => e.claimKey).sort()
  check('getStuckLedgerEntries returns exactly the stuck ones', stuck, ['b', 'c'])
}
{
  // Empty input must not throw and must return an empty array.
  check('getStuckLedgerEntries on an empty ledger', getStuckLedgerEntries([], NOW), [])
}

// ---------------------------------------------------------------------------
// collectUnhealthyJobs
// ---------------------------------------------------------------------------

function job(overrides = {}) {
  return {
    id: 'j1',
    name: 'Weekly report',
    enabled: true,
    draft: { accountId: 'a1' },
    recurrence: {},
    occurrences: [],
    runCount: 0,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
    status: 'armed',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

{
  // A perfectly healthy job must not appear at all.
  const out = collectUnhealthyJobs([job()], [], 'device-me', [], NOW)
  check('a healthy job is excluded entirely', out, [])
}
{
  const out = collectUnhealthyJobs([job({ enabled: false })], [], 'device-me', [], NOW)
  assert('a paused job is reported', out.length === 1)
  check('a paused job is flagged paused, nothing else', out[0]?.kinds, ['paused'])
}
{
  const out = collectUnhealthyJobs([job({ lastResult: 'failed', lastError: 'boom' })], [], 'device-me', [], NOW)
  assert('a failing job is reported', out.length === 1)
  check('a failing job is flagged failing', out[0]?.kinds, ['failing'])
  assert('the error text travels with it', out[0]?.lastError === 'boom')
}
{
  // A DISABLED job whose stale `lastResult` says 'failed' from before it was
  // paused must report only 'paused', not 'failing' too — mirrors
  // `health.ts`'s own `failing` check, which is gated on `j.enabled` for the
  // same reason: a paused job never runs again to fail at, so surfacing a
  // 'failing' badge on it would describe history, not a live risk, and would
  // contradict what "paused" already fully explains.
  const out = collectUnhealthyJobs(
    [job({ enabled: false, lastResult: 'failed' })],
    [],
    'device-me',
    [],
    NOW,
  )
  check('a paused job with a stale failed result reports only paused', out[0]?.kinds, ['paused'])
}
{
  // A fresh, non-stuck ledger entry -> 'retrying', not 'stuckSend'.
  const entries = [ledgerEntry({ jobId: 'j1', claimedAt: NOW - 1000 })]
  const out = collectUnhealthyJobs([job()], [], 'device-me', entries, NOW)
  check('an in-flight send is flagged retrying', out[0]?.kinds, ['retrying'])
}
{
  // A stuck ledger entry -> 'stuckSend', not 'retrying'.
  const entries = [ledgerEntry({ jobId: 'j1', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1 })]
  const out = collectUnhealthyJobs([job()], [], 'device-me', entries, NOW)
  check('a wedged send is flagged stuckSend', out[0]?.kinds, ['stuckSend'])
}
{
  // Two occurrences of the same job in flight at once: one fresh, one stuck —
  // both kinds must show, not just the first one found.
  const entries = [
    ledgerEntry({ claimKey: 'j1:1', jobId: 'j1', claimedAt: NOW - 1000 }),
    ledgerEntry({ claimKey: 'j1:2', jobId: 'j1', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1 }),
  ]
  const out = collectUnhealthyJobs([job()], [], 'device-me', entries, NOW)
  check('both retrying and stuckSend can be true for one job at once', out[0]?.kinds.sort(), ['retrying', 'stuckSend'].sort())
}
{
  // A ledger entry for a DIFFERENT job must never leak onto this one.
  const entries = [ledgerEntry({ jobId: 'some-other-job', claimedAt: NOW - 1000 })]
  const out = collectUnhealthyJobs([job()], [], 'device-me', entries, NOW)
  check('a ledger entry for a different job is ignored', out, [])
}

// --- executor gating ---------------------------------------------------------

const devices = [
  { id: 'p1', label: 'Kitchen phone', platform: 'android', pairedAt: 0, mode: 'ongoing', scopes: [], keyRef: 'p1', remoteDeviceId: 'device-phone', lastSyncedAt: NOW - 1000 },
  { id: 'p2', label: 'Old laptop', platform: 'windows', pairedAt: 0, mode: 'ongoing', scopes: [], keyRef: 'p2', remoteDeviceId: 'device-old', lastSyncedAt: NOW - DEVICE_STALE_MS - 1 },
  { id: 'p3', label: 'Never opened', platform: 'android', pairedAt: 0, mode: 'ongoing', scopes: [], keyRef: 'p3', remoteDeviceId: 'device-never' },
]

{
  const out = collectUnhealthyJobs(
    [job({ executorDeviceId: 'device-phone' })],
    devices,
    'device-me',
    [],
    NOW,
  )
  check('a job pinned to a recently-synced peer is not flagged', out, [])
}
{
  const out = collectUnhealthyJobs(
    [job({ executorDeviceId: 'device-old' })],
    devices,
    'device-me',
    [],
    NOW,
  )
  assert('a job pinned to a stale peer is reported', out.length === 1)
  check('flagged executorUnsynced', out[0]?.kinds, ['executorUnsynced'])
  assert('carries the device label', out[0]?.executorLabel === 'Old laptop')
}
{
  const out = collectUnhealthyJobs(
    [job({ executorDeviceId: 'device-never' })],
    devices,
    'device-me',
    [],
    NOW,
  )
  check('a job pinned to a peer that has never synced is flagged executorUnsynced', out[0]?.kinds, ['executorUnsynced'])
}
{
  // No PairedDevice record matches this executorDeviceId at all.
  const out = collectUnhealthyJobs(
    [job({ executorDeviceId: 'device-unknown-entirely' })],
    devices,
    'device-me',
    [],
    NOW,
  )
  check('an executor with no matching paired-device record is flagged', out[0]?.kinds, ['executorUnsynced'])
  assert('no device label to offer', out[0]?.executorLabel === undefined)
}
{
  // executorDeviceId equal to THIS device must never be flagged.
  const out = collectUnhealthyJobs(
    [job({ executorDeviceId: 'device-me' })],
    devices,
    'device-me',
    [],
    NOW,
  )
  check('this device as its own executor is never flagged', out, [])
}
{
  // executorDeviceId absent entirely — "whichever device has it enabled".
  const out = collectUnhealthyJobs([job({ executorDeviceId: undefined })], devices, 'device-me', [], NOW)
  check('no executor set at all is never flagged', out, [])
}
{
  // A PAUSED job pinned to a stale executor must show only 'paused' — the
  // executor question is moot while the job cannot fire on its own anyway,
  // and reporting it too would be noise on top of a row already explained.
  const out = collectUnhealthyJobs(
    [job({ enabled: false, executorDeviceId: 'device-old' })],
    devices,
    'device-me',
    [],
    NOW,
  )
  check('a paused job does not also get executorUnsynced', out[0]?.kinds, ['paused'])
}

// --- severity ordering --------------------------------------------------------

{
  const jobs = [
    job({ id: 'paused-only', name: 'z-paused', enabled: false }),
    job({ id: 'failing-one', name: 'a-failing', lastResult: 'failed' }),
  ]
  const out = collectUnhealthyJobs(jobs, [], 'device-me', [], NOW)
  check('a failing job outranks a paused one regardless of array/name order', out.map((j) => j.jobId), ['failing-one', 'paused-only'])
}

// ---------------------------------------------------------------------------
// collectStuckSends
// ---------------------------------------------------------------------------

{
  const jobs = [job({ id: 'j1', name: 'Weekly report' })]
  const entries = [
    ledgerEntry({ claimKey: 'j1:1', jobId: 'j1', state: 'sending', claimedAt: NOW - 10_000, sendingAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 60_000, attempts: 2 }),
    ledgerEntry({ claimKey: 'j1:2', jobId: 'j1', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 5_000, attempts: 1 }),
    ledgerEntry({ claimKey: 'j1:3', jobId: 'j1', claimedAt: NOW - 500 }), // fresh, excluded
  ]
  const out = collectStuckSends(entries, jobs, NOW)
  assert('only the two stuck entries are returned', out.length === 2)
  check('sorted oldest (largest ageMs) first', out.map((s) => s.claimKey), ['j1:1', 'j1:2'])
  assert('job name is resolved', out[0].jobName === 'Weekly report')
  assert('attempts pass through', out[0].attempts === 2)
}
{
  // A job that has since been deleted still surfaces its claimKey, falling
  // back to the bare jobId as its name.
  const entries = [ledgerEntry({ claimKey: 'ghost:1', jobId: 'ghost', claimedAt: NOW - LEDGER_STUCK_THRESHOLD_MS - 1 })]
  const out = collectStuckSends(entries, [], NOW)
  check('a deleted job falls back to its bare id as the name', out[0]?.jobName, 'ghost')
}
{
  check('no entries at all', collectStuckSends([], [], NOW), [])
}
{
  // A custom threshold is honoured, not just the default.
  const entries = [ledgerEntry({ claimedAt: NOW - 5000 })]
  check('a very large custom threshold reports nothing stuck', collectStuckSends(entries, [], NOW, 10_000_000), [])
  assert('a threshold of 0 reports everything as stuck', collectStuckSends(entries, [], NOW, 0).length === 1)
}

// ---------------------------------------------------------------------------
// collectAccountIssues
// ---------------------------------------------------------------------------

function account(overrides = {}) {
  return {
    id: 'acc1',
    label: 'Work',
    fromName: 'Me',
    fromAddress: 'me@example.com',
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.com',
    authMethod: 'password',
    hasSecret: true,
    timeoutMs: 20000,
    autoNegotiate: true,
    allowInvalidCert: false,
    poolMaxMessages: 100,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

{
  check('a fully healthy password account has no issues', collectAccountIssues([account()], [], {}), [])
}
{
  const out = collectAccountIssues([account({ hasSecret: false })], [], {})
  check('a password account with no stored secret is flagged noSecret', out.map((i) => i.kind), ['noSecret'])
}
{
  // authMethod 'none' (an IP-authenticated relay) never had a password to
  // store, and must never be flagged for lacking one.
  const out = collectAccountIssues([account({ authMethod: 'none', hasSecret: false })], [], {})
  check("an authMethod:'none' account is never flagged noSecret", out, [])
}
{
  const out = collectAccountIssues(
    [account({ authMethod: 'oauth2', hasSecret: false, id: 'o1' })],
    [],
    { o1: 'disconnected' },
  )
  check('an oauth2 account that has never signed in is flagged oauthDisconnected', out.map((i) => i.kind), ['oauthDisconnected'])
}
{
  const out = collectAccountIssues(
    [account({ authMethod: 'oauth2', hasSecret: false, id: 'o1' })],
    [],
    { o1: 'needsConsent' },
  )
  check('a revoked/expired oauth2 grant is flagged oauthNeedsConsent', out.map((i) => i.kind), ['oauthNeedsConsent'])
}
{
  const out = collectAccountIssues(
    [account({ authMethod: 'oauth2', hasSecret: false, id: 'o1' })],
    [],
    { o1: 'unconfigured' },
  )
  check('a build with no client id is flagged oauthUnconfigured', out.map((i) => i.kind), ['oauthUnconfigured'])
}
{
  const out = collectAccountIssues(
    [account({ authMethod: 'oauth2', hasSecret: false, id: 'o1' })],
    [],
    { o1: 'connected' },
  )
  check('a healthy, connected oauth2 account has no issues', out, [])
}
{
  const jobs = [
    job({ id: 'j1', draft: { accountId: 'acc1' }, lastResult: 'failed', lastError: '535 5.7.8 Username and Password not accepted' }),
  ]
  const out = collectAccountIssues([account()], jobs, {})
  assert('a job whose lastError looks like an auth failure flags the account', out.some((i) => i.kind === 'authFailure'))
  const authIssue = out.find((i) => i.kind === 'authFailure')
  assert('the raw server text is kept as the detail', authIssue?.detail === '535 5.7.8 Username and Password not accepted')
}
{
  const jobs = [job({ id: 'j1', draft: { accountId: 'acc1' }, lastResult: 'failed', lastError: 'ETIMEDOUT' })]
  const out = collectAccountIssues([account()], jobs, {})
  check('a timeout failure is NOT misclassified as an auth failure', out, [])
}
{
  const jobs = [job({ id: 'j1', draft: { accountId: 'acc1' }, lastResult: 'ok', lastError: undefined })]
  const out = collectAccountIssues([account()], jobs, {})
  check('a job that is currently succeeding does not flag a stale old error', out, [])
}
{
  // Two accounts, only one has a failing auth job — must not cross-contaminate.
  const jobs = [
    job({ id: 'j1', draft: { accountId: 'acc1' }, lastResult: 'failed', lastError: '535 auth failed' }),
  ]
  const out = collectAccountIssues([account({ id: 'acc1' }), account({ id: 'acc2', label: 'Personal' })], jobs, {})
  check('only the account whose job actually failed is flagged', out.map((i) => i.accountId), ['acc1'])
}

// ---------------------------------------------------------------------------
// collectDeviceSyncIssues
// ---------------------------------------------------------------------------

{
  const list = [{ id: 'd1', label: 'Phone', mode: 'ongoing', lastSyncedAt: NOW - 1000, pairedAt: 0, platform: 'android', scopes: [], keyRef: 'd1' }]
  check('a recently-synced ongoing device has no issue', collectDeviceSyncIssues(list, NOW), [])
}
{
  const list = [{ id: 'd1', label: 'Phone', mode: 'ongoing', lastSyncedAt: NOW - DEVICE_STALE_MS - 1, pairedAt: 0, platform: 'android', scopes: [], keyRef: 'd1' }]
  const out = collectDeviceSyncIssues(list, NOW)
  check('a stale ongoing device is flagged', out.map((d) => d.deviceId), ['d1'])
}
{
  const list = [{ id: 'd1', label: 'Phone', mode: 'ongoing', pairedAt: 0, platform: 'android', scopes: [], keyRef: 'd1' }]
  const out = collectDeviceSyncIssues(list, NOW)
  check('a device that has never synced at all is flagged', out.map((d) => d.deviceId), ['d1'])
  assert('lastSyncedAt stays undefined rather than being coerced to 0', out[0]?.lastSyncedAt === undefined)
}
{
  // A 'once' pairing keeps no ongoing sync obligation and must never be flagged.
  const list = [{ id: 'd1', label: 'One-off transfer', mode: 'once', pairedAt: 0, platform: 'android', scopes: [], keyRef: 'd1' }]
  check("a 'once' pairing is never reported, however old", collectDeviceSyncIssues(list, NOW), [])
}
{
  const list = [{ id: 'd1', label: 'Phone', mode: 'ongoing', lastSyncedAt: NOW - 5000, pairedAt: 0, platform: 'android', scopes: [], keyRef: 'd1' }]
  assert('a custom threshold is honoured', collectDeviceSyncIssues(list, NOW, 1000).length === 1)
  check('a very large custom threshold reports nothing', collectDeviceSyncIssues(list, NOW, 10_000_000), [])
}

// ---------------------------------------------------------------------------

const total = passed + failures.length
for (const line of failures) console.error(`  FAIL  ${line}`)
console.log(`\ncheck:reliability — ${passed}/${total} passed (${checked} assertions)`)

if (failures.length > 0) {
  console.error('\nFAILED')
  process.exit(1)
}
console.log('All clear.')
