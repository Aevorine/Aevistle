/**
 * A mailbox slower than the gap between syncs must not sync itself to death —
 * `npm run check:sync-overlap`.
 *
 * The failure this covers took three days to notice and was invisible in every
 * individual piece. One Gmail account on the reporting user's install needed
 * **152 s** for a full sync — the server authenticates it in 36.7 s where four
 * other accounts on the same host take 1-5 s. The sync interval was one minute.
 *
 * So the timer started a second sync while the first was still connecting, and
 * a third while both were, each opening its own connections to the same
 * mailbox. A provider that is already slow answers a growing pile of
 * simultaneous connections more slowly still, so the account's own retries were
 * what kept it failing. The evidence for that is exact: adding a 90 s patient
 * connect for this account moved the recorded error from "No answer from the
 * server within 10 seconds" to "within 90 seconds" and it still never synced,
 * while the identical `syncInbox` call made once, alone, succeeded in 152 s.
 * More patience could not win a race against the app's own traffic.
 *
 * Three properties, and the third is the one that bites on the way out:
 *
 *   1. A second sync for an account already syncing does not start.
 *   2. A sync whose settings just changed (`override`) does start, because the
 *      one in flight is asking with credentials the user has just replaced.
 *   3. The marker is released on **failure** as well as success. A guard freed
 *      only on the happy path turns one failed sync into an account that never
 *      syncs again — the same outage, wearing the opposite mask, and harder to
 *      find because the logs go quiet instead of noisy.
 *
 * Checked by reading the source rather than by running React: what matters is
 * the shape of the guard, and the shape is what a refactor drops.
 *
 * `--selftest` moves the release out of the `finally` and requires this to go
 * red.
 */

import { readFile } from 'node:fs/promises'

const selftest = process.argv.includes('--selftest')

let failed = 0
const checks = []
const check = (name, ok, detail = '') => {
  checks.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

let src = await readFile('src/state/AppState.tsx', 'utf8')

if (selftest) {
  // The plausible-looking version: release only where the sync succeeded.
  src = src
    .replace(/\}\s*finally\s*\{[\s\S]*?syncInFlight\.current\.delete\(accountId\)[\s\S]*?\n\s*\}/, '}')
    .replace(
      'return { ok: !result.lastSyncError, error: result.lastSyncError, inbox: result }',
      'syncInFlight.current.delete(accountId)\n        return { ok: !result.lastSyncError, error: result.lastSyncError, inbox: result }',
    )
}

const fn = /const syncInboxAccount = useCallback\([\s\S]*?\n  \)/.exec(src)?.[0] ?? ''
check('syncInboxAccount is still there to guard', fn.length > 0)

// --- 1. a second sync does not start ----------------------------------------

check(
  'an account already syncing is not asked again',
  /if \(!override && syncInFlight\.current\.has\(accountId\)\) return/.test(fn),
  /syncInFlight/.test(fn) ? '' : 'no in-flight tracking at all',
)
check(
  'the marker is set before the first await, not after',
  fn.indexOf('syncInFlight.current.add(accountId)') < fn.indexOf('await flushPendingSeen'),
  'a marker set after an await leaves the window it exists to close',
)

// --- 2. changed settings still get through ----------------------------------

check(
  'a sync carrying new settings is never skipped',
  /!override && syncInFlight/.test(fn),
  'without the override exception, saving an account would not re-sync it',
)

// --- 3. released on failure too ---------------------------------------------

check(
  'the marker is released in a finally',
  /finally \{[\s\S]{0,400}?syncInFlight\.current\.delete\(accountId\)/.test(fn),
  'released only on success means one failure ends syncing for good',
)
check(
  'and released exactly once, not sprinkled per return path',
  (fn.match(/syncInFlight\.current\.delete\(accountId\)/g) ?? []).length === 1,
  `${(fn.match(/syncInFlight\.current\.delete\(accountId\)/g) ?? []).length} release site(s)`,
)
check(
  'everything that can throw is inside the guarded region',
  fn.indexOf('await flushPendingSeen') > fn.indexOf('try {') &&
    fn.indexOf('await bridge.syncInbox') > fn.indexOf('try {'),
  'a throw outside the try skips the finally and marks the account busy forever',
)

console.log('')

const label = 'a slow mailbox does not sync itself to death'

if (selftest) {
  console.log(`  ${label}\n  ${checks.length} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: a success-only release was not caught.\n')
    process.exit(1)
  }
  console.log('  Selftest OK — the injected fault was caught.\n')
  process.exit(0)
}

if (failed === 0) {
  console.log(`  ${label}\n  ${checks.length} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`  ${label}\n  ${checks.length} checks, ${failed} failed\n`)
process.exit(1)
