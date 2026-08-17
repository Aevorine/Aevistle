/**
 * A failed sync must not erase a successful one — `npm run check:sync-rollback`.
 *
 * Observed, not theorised. On the reporting user's install, one slow account
 * synced cleanly at 17:43:03 — its cached message count went from 29 to 42 and
 * its error cleared — and by 17:45:32 the same row read 29 messages again, with
 * `lastSyncAt` back to three days earlier and the old timeout error restored.
 * No mail had been deleted. A sync that had *started* before that success
 * finally failed, and its error branch wrote the account snapshot it had been
 * holding since it began straight over the fresh one.
 *
 * The snapshot is stale by construction, which is what makes this so easy to
 * write and so hard to see. `syncInboxAccount` reads `config` out of
 * `state.inboxAccounts` as captured by its own closure, and the sync timer
 * holds one such closure across many ticks — so on a slow account `config` can
 * be minutes and several completed syncs old. The success path replaces the row
 * with the server's answer, so it is immune; the failure path is the only one
 * that writes a remembered value back, and a remembered value is the one thing
 * a failure has no right to have an opinion about.
 *
 * The rule this enforces: **a failed sync may write its error and nothing
 * else.** The row it attaches that error to must come from the live state, not
 * from the closure.
 *
 * Why a gate and not a comment: the bug is invisible in the diff (`{ ...config,
 * lastSyncError: error }` reads as obviously correct), invisible in a short
 * test (it needs one sync to outlive another), and its symptom — mail that was
 * there and then is not — looks like a server problem or a cache bug, never
 * like the error handler.
 *
 * `--selftest` restores the closure-snapshot dispatch and requires this to go
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
  src = src
    .replace(
      /const live =\s*\n?\s*liveRef\.current\.inboxAccounts\.find\(\(i\) => i\.accountId === accountId\) \?\? config\n\s*/,
      '',
    )
    .replace('inbox: { ...live, lastSyncError: error },', 'inbox: { ...config, lastSyncError: error },')
}

const fn = /const syncInboxAccount = useCallback\([\s\S]*?\n  \)/.exec(src)?.[0] ?? ''
check('syncInboxAccount is still there to guard', fn.length > 0)

// The failure branch: everything from `} catch (e) {` to the end of the callback.
const failure = /\} catch \(e\) \{[\s\S]*$/.exec(fn)?.[0] ?? ''
check('it still has a failure branch', failure.length > 0)

check(
  'a failed sync attaches its error to the live row',
  /liveRef\.current\.inboxAccounts\.find\(\(i\) => i\.accountId === accountId\)/.test(failure),
  'without this it writes whatever the closure was holding',
)
check(
  'and does not write the closure snapshot back',
  !/inbox: \{ \.\.\.config, lastSyncError/.test(failure),
  /inbox: \{ \.\.\.config, lastSyncError/.test(failure)
    ? 'found `{ ...config, lastSyncError }` — this is the rollback'
    : '',
)
check(
  'the only field a failure writes is the error',
  /inbox: \{ \.\.\.live, lastSyncError: error \}/.test(failure),
)

// The success path is allowed to write the whole row — that is the server's
// answer. Asserted so a future "fix" does not make both paths cautious and
// leave nothing able to update the mailbox at all.
check(
  'a successful sync still replaces the row wholesale',
  /inbox: result,/.test(fn),
  'the success path must keep writing the server answer',
)

// The staleness this guards against comes from the timer holding one closure.
// If that ever changes the guard is still correct, but the reasoning above
// stops applying, so the note has to travel with it.
check(
  'the reason the snapshot is stale is written down next to the fix',
  /closure/i.test(failure) && /stale/i.test(failure),
  'a future reader must not "simplify" this back',
)

console.log('')

const label = 'a failed sync cannot un-fetch mail'

if (selftest) {
  console.log(`  ${label}\n  ${checks.length} checks, ${failed} failed\n`)
  if (failed === 0) {
    console.log('  SELFTEST FAILED: the closure-snapshot rollback was not caught.\n')
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
