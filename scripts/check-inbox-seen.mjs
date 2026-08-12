/**
 * Does a message that was read stay read?
 *
 * It did not. `upsertInboxAccount` replaced an account's message list wholesale
 * with whatever the last sync returned, and a sync returns the server's
 * `\Seen` flags. Marking a message read is optimistic — the row flips locally
 * first and the `\Seen` push follows over the network — and syncs are frequent:
 * every five minutes, on every IMAP IDLE notification, and on every single
 * `visibilitychange`. So a message read a moment ago, whose push had not landed
 * yet (or had failed silently, which both platforms used to allow), came back
 * from the next sync marked unread. Minutes later, on its own, with nothing on
 * screen explaining it. Users reported it as "the app forgets what I've read".
 *
 * The reducer already carried two things forward past a sync result — the
 * removal tombstones and the per-account image preference — on the stated
 * grounds that "a sync result is authoritative about the mailbox and about
 * nothing else". `seen` is the one mailbox field the user changes locally
 * before the server hears about it, so it needed that protection most, and had
 * none.
 *
 * Checked here, by driving the real reducer rather than by reading its source:
 *   - a stale sync cannot turn a locally-read message back to unread;
 *   - a server that genuinely reports read is still believed, so the rule is a
 *     merge and not a lock;
 *   - writes that are not sync results are untouched by any of it;
 *   - a renumbered folder (UIDVALIDITY rolled) carries nothing forward, because
 *     the same uid now means a different message;
 *   - a push still in flight wins in *both* directions, so marking something
 *     unread does not flip back either;
 *   - a queued push from a renumbered folder is discarded rather than replayed
 *     onto whatever now holds that uid.
 *
 * Source-text assertions were considered and rejected. A regex over
 * `AppState.tsx` catches a rename and nothing else: someone restoring the old
 * one-line replacement would leave every pattern here still matching. The
 * assertions below fail when the behaviour changes, which was confirmed by
 * breaking `mergeSeenFlags` on purpose and watching two of them go red.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Inside `node_modules`, not the OS temp directory: the bundle leaves `react`
// external (it is never called — only the reducer is), and a bare `react`
// specifier only resolves from a path that has `node_modules` above it.
const dir = await mkdtemp(path.join(ROOT, 'node_modules', '.aevistle-seen-'))
const bundle = path.join(dir, 'appState.mjs')
await build({
  entryPoints: [path.join(ROOT, 'src/state/AppState.tsx')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  platform: 'node',
  external: ['react', 'react-dom'],
  define: { __APP_VERSION__: '"0.0.0-check"' },
  logLevel: 'error',
})
const { reducer } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

const ACCOUNT = 'acct_1'
const UIDVALIDITY = 100

const msg = (uid, seen, extra = {}) => ({
  id: `${ACCOUNT}:INBOX:${uid}`,
  accountId: ACCOUNT,
  folderPath: 'INBOX',
  uid,
  uidValidity: UIDVALIDITY,
  messageId: `<${uid}@example.com>`,
  from: 'sender@example.com',
  to: 'me@example.com',
  subject: `subject ${uid}`,
  date: Date.UTC(2026, 7, 12, 9, 0, uid),
  snippet: '',
  sizeBytes: 1024,
  hasAttachments: false,
  seen,
  tag: 'none',
  bodyCached: false,
  ...extra,
})

const inbox = (messages, uidValidity = UIDVALIDITY) => ({
  accountId: ACCOUNT,
  enabled: true,
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecurity: 'ssl',
  imapUsername: 'me@example.com',
  imapAllowInvalidCert: false,
  folders: [
    {
      id: `${ACCOUNT}:INBOX`,
      accountId: ACCOUNT,
      path: 'INBOX',
      displayName: 'INBOX',
      uidValidity,
      unreadCount: messages.filter((m) => !m.seen).length,
      totalCount: messages.length,
    },
  ],
  messages,
  showRemoteImages: 'never',
  imageAllowlist: [],
})

const base = {
  accounts: [{ id: ACCOUNT }],
  jobs: [],
  contacts: [],
  templates: [],
  logs: [],
  settings: {},
  draft: {},
  inboxAccounts: [],
  draftSnapshots: [],
  outbox: [],
  codeHits: [],
  recentRecipients: [],
  pairedDevices: [],
  syncConflicts: [],
  deletedJobs: [],
  schemaVersion: 1,
}

const seenOf = (state, uid) =>
  state.inboxAccounts[0]?.messages.find((m) => m.uid === uid)?.seen

const markRead = (state, uid, seen) =>
  reducer(state, {
    type: 'patchInboxMessages',
    accountId: ACCOUNT,
    ids: [`${ACCOUNT}:INBOX:${uid}`],
    patch: { seen },
  })

const sync = (state, messages, extra = {}) =>
  reducer(state, { type: 'upsertInboxAccount', inbox: inbox(messages), origin: 'sync', ...extra })

// --- the bug this file exists to prevent ------------------------------------

let s = reducer(base, { type: 'upsertInboxAccount', inbox: inbox([msg(1, false)]) })
s = markRead(s, 1, true)
check('marking a message read updates it immediately', seenOf(s, 1) === true)

s = sync(s, [msg(1, false)])
check('a sync reporting unread must not undo a local read', seenOf(s, 1) === true)

// --- and the merge must still be a merge ------------------------------------

let t = reducer(base, { type: 'upsertInboxAccount', inbox: inbox([msg(2, false)]) })
t = sync(t, [msg(2, true)])
check('a sync reporting read is believed', seenOf(t, 2) === true)

let u = reducer(base, { type: 'upsertInboxAccount', inbox: inbox([msg(3, true)]) })
u = reducer(u, { type: 'upsertInboxAccount', inbox: inbox([msg(3, false)]) })
check('a write that is not a sync result is left alone', seenOf(u, 3) === false)

// UIDVALIDITY is the mailbox saying "my uids mean something else now". Carrying
// read state across that pins it to whichever message inherited the number.
let v = reducer(base, { type: 'upsertInboxAccount', inbox: inbox([msg(4, true)]) })
v = reducer(v, {
  type: 'upsertInboxAccount',
  inbox: inbox([msg(4, false, { uidValidity: 200 })], 200),
  origin: 'sync',
})
check('a renumbered folder inherits no read state', seenOf(v, 4) === false)

// --- pushes still in flight -------------------------------------------------

let w = reducer(base, { type: 'upsertInboxAccount', inbox: inbox([msg(5, true)]) })
w = markRead(w, 5, false)
check('marking a message unread updates it immediately', seenOf(w, 5) === false)

const queued = [
  { id: `${ACCOUNT}:INBOX:5`, folderPath: 'INBOX', uid: 5, uidValidity: UIDVALIDITY, seen: false },
]
check(
  'a mark-unread still in flight survives a sync that disagrees',
  seenOf(sync(w, [msg(5, true)], { pendingSeen: queued }), 5) === false,
)

const stale = [
  { id: `${ACCOUNT}:INBOX:5`, folderPath: 'INBOX', uid: 5, uidValidity: 999, seen: false },
]
check(
  'a queued push from a renumbered folder is discarded, not replayed',
  seenOf(sync(w, [msg(5, true)], { pendingSeen: stale }), 5) === true,
)

// --- the neighbouring carry-forwards are undisturbed ------------------------

let x = reducer(base, { type: 'upsertInboxAccount', inbox: inbox([msg(7, false)]) })
x = reducer(x, { type: 'removeInboxMessages', accountId: ACCOUNT, ids: [`${ACCOUNT}:INBOX:7`] })
x = sync(x, [msg(7, false)])
check('tombstones still outlive a sync result', x.inboxAccounts[0].messages.length === 0)

// ---------------------------------------------------------------------------

const label = 'a message that was read stays read'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
