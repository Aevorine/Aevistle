/**
 * Does deleting a message actually stick?
 *
 * It did not. `deleteInboxMessages` dropped the row from the in-memory list
 * and deleted the cached body, and that was all. `syncInbox` rebuilds the list
 * from whatever the server currently holds — `fetchAll('${from}:${exists}')`,
 * the last N by sequence number — and the reducer replaces the account's
 * messages with the result. Nothing anywhere recorded that a message had been
 * removed, so five minutes later the automatic sync fetched it straight back
 * and the row the user had deleted reappeared on its own.
 *
 * That made "delete" cosmetic, and it mattered more the moment the typed
 * confirmation came off those buttons: an ineffective action that is easier to
 * trigger is worse than one that is hard to reach.
 *
 * Checked here:
 *   - a removal is written down, and survives the next sync result;
 *   - restoring puts the message back without waiting for a sync to rediscover
 *     it (it may have aged out of the window a sync looks at);
 *   - the bin is bounded, both by count and by age;
 *   - a server-side purge writes *no* tombstone, because there is nothing left
 *     to filter and nothing to restore from.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-removal-'))
const bundle = path.join(dir, 'inboxRemoval.mjs')
await build({
  entryPoints: ['src/core/inboxRemoval.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { rememberRemoved, withoutRemoved, restoreRemoved, pruneRemoved, mergeRemoved, removalKey } =
  await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const DAY = 86_400_000
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0)
const msg = (uid, extra = {}) => ({
  id: `m_${uid}`,
  uid,
  folderPath: 'INBOX',
  date: NOW - uid * 1000,
  subject: `subject ${uid}`,
  ...extra,
})

// --- the resurrection this file exists to prevent ---------------------------

const removed = rememberRemoved([], [msg(1), msg(2)], NOW)
check('removing two messages records two tombstones', removed.length === 2)

// The next sync reports everything the server still holds — including the two
// that were just removed, because removing them locally did not touch it.
const fromServer = [msg(1), msg(2), msg(3)]
const shown = withoutRemoved(fromServer, removed)
check('a sync must not resurrect a removed message', shown.length === 1)
check('the message that was never removed must survive the sync', shown[0].uid === 3)

// --- restore ---------------------------------------------------------------

const back = restoreRemoved(removed, [removalKey(msg(1))])
check('restoring returns the message itself, not just its key', back.restored[0]?.uid === 1)
check('restoring keeps the whole row, so it can be shown at once', back.restored[0]?.subject === 'subject 1')
check('restoring leaves the other tombstone alone', back.removed.length === 1)
check(
  'a restored message must survive the next sync',
  withoutRemoved(fromServer, back.removed).some((m) => m.uid === 1),
)

// --- uid identity is per folder --------------------------------------------

const crossFolder = rememberRemoved([], [msg(7)], NOW)
const otherFolder = [{ ...msg(7), folderPath: 'Archive', id: 'm_7_arch' }]
check(
  'the same uid in another folder is a different message',
  withoutRemoved(otherFolder, crossFolder).length === 1,
)

// --- bounds ----------------------------------------------------------------

const many = rememberRemoved(
  [],
  Array.from({ length: 600 }, (_, i) => msg(i + 100)),
  NOW,
)
check('the bin is capped', many.length === 500)

const stale = pruneRemoved(
  [
    { message: msg(1), at: NOW - 8 * DAY },
    { message: msg(2), at: NOW - 1 * DAY },
  ],
  NOW,
)
check('an entry past the retention window is swept', stale.length === 1)
check('a recent entry is kept', stale[0].message.uid === 2)
check(
  'a swept entry stops being filtered, so the message can come back',
  withoutRemoved([msg(1)], stale).length === 1,
)

// --- re-removing something already in the bin -------------------------------

const twice = rememberRemoved(removed, [msg(1)], NOW + 1000)
check('re-removing does not duplicate the tombstone', twice.filter((r) => r.message.uid === 1).length === 1)

// --- the in-flight-sync race ------------------------------------------------
//
// A sync carries a copy of the tombstone list as it looked when the sync
// started. Deleting something while one is in flight must not be undone by the
// arriving result.

const beforeSync = rememberRemoved([], [msg(1)], NOW)
const deletedMidFlight = rememberRemoved(beforeSync, [msg(9)], NOW + 5000)
const merged = mergeRemoved(deletedMidFlight, beforeSync, NOW + 6000)
check('a stale sync copy must not drop a tombstone written while it ran', merged.length === 2)
check(
  'the message deleted mid-sync must still be filtered out',
  withoutRemoved([msg(9)], merged).length === 0,
)

// --- wiring ----------------------------------------------------------------

const appState = read('src/state/AppState.tsx')
check(
  'removing must write a tombstone, not just filter the list',
  /case 'removeInboxMessages'[\s\S]{0,700}?rememberRemoved\(/.test(appState),
)
check(
  'every sync result must be filtered through the tombstone list',
  /case 'upsertInboxAccount'[\s\S]{0,2400}?withoutRemoved\(/.test(appState),
)
check(
  'a sync must merge tombstones, not overwrite them with its own stale copy',
  /case 'upsertInboxAccount'[\s\S]{0,1600}?mergeRemoved\(prior\?\.removed/.test(appState),
)
check(
  'a server-side purge must not leave a tombstone to restore from',
  /purge \? i\.removed : rememberRemoved\(/.test(appState),
)
check(
  'the server purge must report failure rather than swallow it',
  /purgeInboxMessages[\s\S]{0,900}?return \{ ok: false, error/.test(appState),
)

const imap = read('electron/imap.ts')
check('the desktop must have a real server-side delete', /export async function purgeMessages\(/.test(imap))
check(
  'a server that refuses must be an error, not a quiet success',
  /if \(!done\) throw new Error/.test(imap),
)

const fetcher = read('android/app/src/main/java/dev/aevistle/app/MailFetcher.java')
check('Android must have a real server-side delete', /static void purge\(/.test(fetcher))
check(
  'Android must not report deleting nothing as success',
  /did not recognise any of those messages/.test(fetcher),
)

const inbox = read('src/views/InboxView.tsx')
check(
  'the delete buttons must no longer demand typed confirmation',
  !/requireTypedConfirmation/.test(inbox),
)

// The same shape of bug, a third time. A sync captures the account config in
// a closure, awaits IMAP, and dispatches the reply back over the account —
// so anything the user changed while it was in flight is overwritten with the
// value from before. It cost us `removed` once; it would cost us the
// remote-image choice next, since that switch is flipped from the reader
// while a poll may well be running. The reducer has to know which writes come
// from a sync, and a sync is authoritative about the mailbox and nothing else.
check(
  'a sync must identify itself to the reducer',
  /type: 'upsertInboxAccount'; inbox: InboxAccountState; origin\?: 'sync'/.test(appState),
)
check(
  "both of syncInboxAccount's dispatches must be tagged, including the failure path",
  (appState.match(/origin: 'sync'/g) ?? []).length >= 2,
)
check(
  'a sync result must not carry the user-owned image fields',
  /action\.origin === 'sync' && prior[\s\S]{0,160}showRemoteImages: prior\.showRemoteImages[\s\S]{0,80}imageAllowlist: prior\.imageAllowlist/.test(
    appState,
  ),
)
// Computing the carry-forward and then not spreading it is the failure this
// guard exists to catch — it looks right in review and does nothing at run
// time. Assert the use, not just the declaration.
check(
  'the carried-forward fields must actually override the sync result',
  /\.\.\.action\.inbox,\s*\n\s*\.\.\.preferences,/.test(appState),
)

// ---------------------------------------------------------------------------

const label = 'deleting a message sticks'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
