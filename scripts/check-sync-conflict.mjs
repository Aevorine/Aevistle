/**
 * Proves `core/sync/syncConflict.ts` — the code that decides which device's edit
 * wins when two paired devices changed the same reminder, contact, template
 * or account since they last synced — actually does what its module doc
 * promises, with concrete before/after state at each step.
 *
 * Four things checked, each against the real functions (bundled straight out
 * of `src/core/sync/syncConflict.ts` and `src/core/sync/syncScope.ts`, the same
 * `hashRecord` the module doc says conflict detection reuses), never a
 * hand-rolled stand-in:
 *
 *   - `detectConflicts` flags an id only when *both* sides changed it *and*
 *     they disagree — same id, same resulting content (a coincidental
 *     identical edit, or the same change arriving from two directions) is
 *     not a conflict, and an id only one side touched is not either;
 *   - `resolveConflicts` picks the newer `updatedAt`, adjusted by
 *     `clockOffsetMs` before comparing, and a tie after adjustment keeps
 *     `mine` — never a coin flip;
 *   - the loser is never discarded: `resolveConflicts` returns one
 *     `ConflictSnapshot` per conflict carrying the exact losing record, and
 *     `pushConflictSnapshots` prepends+caps at `CONFLICT_SNAPSHOT_CAP`
 *     (newest first, oldest dropped) rather than growing forever;
 *   - `conflictSummary` and `conflictsForSession` read out right for every
 *     `HashableKind`, so the sheet `SyncConflictList.tsx` renders actually
 *     names the record and groups it with the sync cycle it came from.
 *
 * Exit code 1 if anything needs attention.
 */

import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const dir = await mkdtemp(path.join(tmpdir(), 'aevistle-sync-conflict-'))

const entry = path.join(dir, 'entry.ts')
await writeFile(
  entry,
  [
    `export * from ${JSON.stringify(path.join(root, 'src/core/sync/syncConflict.ts'))};`,
    `export * from ${JSON.stringify(path.join(root, 'src/core/sync/syncScope.ts'))};`,
  ].join('\n'),
)

const bundle = path.join(dir, 'bundle.mjs')
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    logLevel: 'error',
  })
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const {
  detectConflicts,
  resolveConflicts,
  pushConflictSnapshots,
  conflictsForSession,
  conflictSummary,
  CONFLICT_SNAPSHOT_CAP,
  hashRecord,
} = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const failures = []
let checked = 0
const check = (what, ok) => {
  checked++
  if (!ok) failures.push(what)
}

// ---------------------------------------------------------------------------
// Fixtures — minimal shapes covering exactly the fields
// `syncScope.ts`'s `shapeForHash` and `syncConflict.ts`'s `conflictSummary`
// actually read for each kind.
// ---------------------------------------------------------------------------

const job = (id, overrides = {}) => ({
  id,
  name: 'Weekly status',
  draft: { subject: 'Status update', body: 'hello' },
  recurrence: { kind: 'weekly', dayOfWeek: 1 },
  retry: { maxAttempts: 3, backoffMs: 60_000 },
  updatedAt: 1_000,
  ...overrides,
})

const contact = (id, overrides = {}) => ({
  id,
  name: 'Ada Lovelace',
  address: 'ada@example.com',
  tags: ['vip'],
  updatedAt: 1_000,
  ...overrides,
})

const template = (id, overrides = {}) => ({
  id,
  name: 'Follow-up',
  subject: 'Following up',
  body: 'Just checking in.',
  updatedAt: 1_000,
  ...overrides,
})

const account = (id, overrides = {}) => ({
  id,
  fromAddress: 'me@example.com',
  host: 'smtp.example.com',
  port: 587,
  username: 'me@example.com',
  updatedAt: 1_000,
  ...overrides,
})

// ---------------------------------------------------------------------------
// detectConflicts — flags only "same id, both sides changed, content differs"
// ---------------------------------------------------------------------------

{
  // Device A changed the subject; device B changed the retry policy. Same
  // job id, both changed, content now disagrees: a real conflict.
  const mine = [job('j1', { draft: { subject: 'Status update (mine)', body: 'hello' } })]
  const theirs = [job('j1', { retry: { maxAttempts: 5, backoffMs: 60_000 } })]
  const conflicts = await detectConflicts('job', mine, theirs)
  check('same job id, disagreeing content on both sides: exactly one conflict reported', conflicts.length === 1)
  check('the conflict names the right id', conflicts[0]?.id === 'j1')
  check('the conflict carries this device\'s own record as "mine"', conflicts[0]?.mine === mine[0])
  check('the conflict carries the peer\'s record as "theirs"', conflicts[0]?.theirs === theirs[0])
}

{
  // Both sides made the exact same edit — same id, identical resulting
  // content. Not a conflict: nothing to reconcile.
  const mine = [job('j2', { name: 'Renamed both ways' })]
  const theirs = [job('j2', { name: 'Renamed both ways', updatedAt: 5_000 })] // updatedAt not part of the hash
  const conflicts = await detectConflicts('job', mine, theirs)
  check('same id, identical content (even with different updatedAt): not a conflict', conflicts.length === 0)
}

{
  // An id only one side touched is not a conflict — the other side never
  // disagreed with anything, it just never changed it.
  const mine = [job('j3', { name: 'Only mine changed' })]
  const theirs = [job('j4', { name: 'A completely different job' })]
  const conflicts = await detectConflicts('job', mine, theirs)
  check('an id present on only one side is never reported as a conflict', conflicts.length === 0)
}

{
  // Empty either side short-circuits to no conflicts, per the module's own
  // guard — proven directly rather than assumed.
  const c1 = await detectConflicts('job', [], [job('j5')])
  const c2 = await detectConflicts('job', [job('j5')], [])
  check('no local changes at all means no conflicts, regardless of the peer', c1.length === 0)
  check('no peer changes at all means no conflicts, regardless of local edits', c2.length === 0)
}

{
  // Mixed batch: some ids only on one side, some agreeing, some disagreeing
  // — only the disagreeing id should surface.
  const mine = [
    contact('c1', { name: 'Grace Hopper' }), // conflicts below
    contact('c2', { name: 'Only local' }),
  ]
  const theirs = [
    contact('c1', { name: 'Grace M. Hopper' }), // disagrees with mine
    contact('c3', { name: 'Only remote' }),
  ]
  const conflicts = await detectConflicts('contact', mine, theirs)
  check('a mixed batch surfaces exactly the ids that actually disagree', conflicts.length === 1 && conflicts[0].id === 'c1')
}

// ---------------------------------------------------------------------------
// resolveConflicts — newer updatedAt wins, clock-offset adjusted, tie keeps mine
// ---------------------------------------------------------------------------

{
  const mine = job('r1', { updatedAt: 2_000, name: 'Mine, newer' })
  const theirs = job('r1', { updatedAt: 1_000, name: 'Theirs, older' })
  const { winners, snapshots } = resolveConflicts([{ kind: 'job', id: 'r1', mine, theirs }], 'session-1')
  check('a strictly newer local edit wins', winners[0] === mine)
  check('exactly one snapshot is produced per conflict', snapshots.length === 1)
  check('the snapshot captures the losing (older) record, not the winner', snapshots[0].losing === theirs)
  check('the snapshot is tagged with the requested session id', snapshots[0].sessionId === 'session-1')
  check('the snapshot names the losing summary from the losing record', snapshots[0].losingSummary === conflictSummary('job', theirs))
  check('the snapshot names the winning summary from the winning record', snapshots[0].winningSummary === conflictSummary('job', mine))
}

{
  const mine = job('r2', { updatedAt: 1_000, name: 'Mine, older' })
  const theirs = job('r2', { updatedAt: 5_000, name: 'Theirs, newer' })
  const { winners, snapshots } = resolveConflicts([{ kind: 'job', id: 'r2', mine, theirs }], 'session-2')
  check('a strictly newer remote edit wins', winners[0] === theirs)
  check('the losing snapshot captures the local record that lost', snapshots[0].losing === mine)
}

{
  // Peer clock runs 10 minutes ahead: without adjustment their 1:00 stamp
  // would beat our 12:55 one, even though ours actually happened later in
  // real time. clockOffsetMs subtracts that skew before comparing.
  const TEN_MIN = 10 * 60_000
  const mine = job('r3', { updatedAt: 100_000, name: 'Mine, actually later' })
  const theirs = job('r3', { updatedAt: 100_000 + TEN_MIN - 1, name: 'Theirs, clock-skewed' })
  const noAdjust = resolveConflicts([{ kind: 'job', id: 'r3', mine, theirs }], 's', 0)
  check('with no clock offset assumed, the later raw timestamp (theirs) wins', noAdjust.winners[0] === theirs)
  const adjusted = resolveConflicts([{ kind: 'job', id: 'r3', mine, theirs }], 's', TEN_MIN)
  check('once the peer\'s known clock skew is subtracted, the true-later edit (mine) wins', adjusted.winners[0] === mine)
}

{
  // Exact tie after adjustment: mine wins, per the module doc ("no visible
  // change beats a coin flip").
  const mine = job('r4', { updatedAt: 3_000, name: 'Mine' })
  const theirs = job('r4', { updatedAt: 3_000, name: 'Theirs' })
  const { winners } = resolveConflicts([{ kind: 'job', id: 'r4', mine, theirs }], 's')
  check('a tie after clock-offset adjustment keeps the local record', winners[0] === mine)
}

{
  // Missing updatedAt on both sides is treated as 0 on both — still a tie,
  // still resolves to mine, never throws.
  const mine = job('r5', { updatedAt: undefined, name: 'Mine, no timestamp' })
  const theirs = job('r5', { updatedAt: undefined, name: 'Theirs, no timestamp' })
  const { winners } = resolveConflicts([{ kind: 'job', id: 'r5', mine, theirs }], 's')
  check('missing updatedAt on both sides does not throw and keeps mine', winners[0] === mine)
}

{
  // Multiple conflicts resolved in one call preserve order and each get
  // their own snapshot.
  const pairs = [
    { kind: 'contact', id: 'm1', mine: contact('m1', { updatedAt: 10 }), theirs: contact('m1', { updatedAt: 20, name: 'Newer remote' }) },
    { kind: 'template', id: 'm2', mine: template('m2', { updatedAt: 20, name: 'Newer local' }), theirs: template('m2', { updatedAt: 10 }) },
  ]
  const { winners, snapshots } = resolveConflicts(pairs, 'batch-session')
  check('a batch resolves in the same order as the input, per pair', winners.length === 2 && winners[0] === pairs[0].theirs && winners[1] === pairs[1].mine)
  check('a batch produces one snapshot per conflict, all tagged with the same session', snapshots.length === 2 && snapshots.every((s) => s.sessionId === 'batch-session'))
  check('each snapshot in a batch has a distinct id', snapshots[0].id !== snapshots[1].id)
}

// ---------------------------------------------------------------------------
// conflictSummary — the one-line label per HashableKind
// ---------------------------------------------------------------------------

{
  const withSubject = job('s1', { draft: { subject: '  Q3 report  ' } })
  check('job summary prefers the (trimmed) draft subject', conflictSummary('job', withSubject) === 'Q3 report')
  const noSubject = job('s2', { draft: { subject: '' }, name: 'Fallback job name' })
  check('job summary falls back to the job name when the subject is blank', conflictSummary('job', noSubject) === 'Fallback job name')
  check('account summary is the from-address', conflictSummary('account', account('s3', { fromAddress: 'boss@example.com' })) === 'boss@example.com')
  check('contact summary prefers the name', conflictSummary('contact', contact('s4', { name: 'Grace' })) === 'Grace')
  check('contact summary falls back to the address when name is empty', conflictSummary('contact', contact('s5', { name: '' })) === contact('s5').address)
  check('template summary is the template name', conflictSummary('template', template('s6', { name: 'Reminder' })) === 'Reminder')
}

// ---------------------------------------------------------------------------
// pushConflictSnapshots — prepend, newest first, capped, never mutates input
// ---------------------------------------------------------------------------

{
  const mk = (id) => ({ id, sessionId: 's', kind: 'job', recordId: id, at: 0, losing: {}, winningSummary: '', losingSummary: '' })
  const history = [mk('old-2'), mk('old-1')]
  const fresh = [mk('new-1')]
  const next = pushConflictSnapshots(history, fresh)
  check('fresh snapshots land at the front, newest first', next[0].id === 'new-1')
  check('older history follows behind, order preserved', next[1].id === 'old-2' && next[2].id === 'old-1')
  check('pushConflictSnapshots does not mutate the history array it was handed', history.length === 2)
  check('pushing an empty fresh list returns an equivalent, but not the same, array', pushConflictSnapshots(history, []).length === 2 && pushConflictSnapshots(history, []) !== history)
}

{
  // Cap enforcement: push past CONFLICT_SNAPSHOT_CAP and the oldest entries
  // fall off the end.
  check('CONFLICT_SNAPSHOT_CAP is 50, per the module doc mirroring snapshots.ts', CONFLICT_SNAPSHOT_CAP === 50)
  const mk = (id) => ({ id, sessionId: 's', kind: 'job', recordId: id, at: 0, losing: {}, winningSummary: '', losingSummary: '' })
  let history = []
  for (let i = 0; i < CONFLICT_SNAPSHOT_CAP; i++) history = pushConflictSnapshots(history, [mk(`e${i}`)])
  check(`history fills to exactly the cap (${CONFLICT_SNAPSHOT_CAP}) and no further`, history.length === CONFLICT_SNAPSHOT_CAP)
  check('at the cap, the most recent push is still at the front', history[0].id === `e${CONFLICT_SNAPSHOT_CAP - 1}`)
  const overflowed = pushConflictSnapshots(history, [mk('overflow')])
  check('one more push past the cap still caps the length, does not grow past it', overflowed.length === CONFLICT_SNAPSHOT_CAP)
  check('the overflow push evicts the single oldest entry, not an arbitrary one', overflowed[overflowed.length - 1].id === 'e1' && overflowed.every((s) => s.id !== 'e0'))
  check('the newest snapshot is still first after overflow', overflowed[0].id === 'overflow')
}

// ---------------------------------------------------------------------------
// conflictsForSession — groups one sync cycle's snapshots together
// ---------------------------------------------------------------------------

{
  const mk = (id, sessionId) => ({ id, sessionId, kind: 'job', recordId: id, at: 0, losing: {}, winningSummary: '', losingSummary: '' })
  const history = [mk('a', 'session-A'), mk('b', 'session-B'), mk('c', 'session-A')]
  const forA = conflictsForSession(history, 'session-A')
  check('conflictsForSession returns only snapshots from the requested session', forA.length === 2 && forA.every((s) => s.sessionId === 'session-A'))
  check('conflictsForSession preserves history order (newest-first) within the session', forA[0].id === 'a' && forA[1].id === 'c')
  check('a session id with no matching snapshots returns an empty list, not undefined', Array.isArray(conflictsForSession(history, 'session-Z')) && conflictsForSession(history, 'session-Z').length === 0)
}

// ---------------------------------------------------------------------------
// End-to-end: detect → resolve → push, the real flow one sync cycle runs
// ---------------------------------------------------------------------------

{
  const localJob = job('e2e-1', { updatedAt: 1_000, draft: { subject: 'Local edit', body: 'x' } })
  const remoteJob = job('e2e-1', { updatedAt: 9_000, draft: { subject: 'Remote edit, and it is newer', body: 'x' } })
  const conflicts = await detectConflicts('job', [localJob], [remoteJob])
  check('e2e: a disagreeing edit on the same id is detected', conflicts.length === 1)
  const { winners, snapshots } = resolveConflicts(conflicts, 'e2e-session')
  check('e2e: the newer remote edit is the winner headed into local state', winners[0] === remoteJob)
  check('e2e: the older local edit is preserved as a restorable snapshot, not silently discarded', snapshots[0].losing === localJob)
  const grown = pushConflictSnapshots([], snapshots)
  check('e2e: the snapshot lands in history and can be found by its session', conflictsForSession(grown, 'e2e-session').length === 1)
}

// ---------------------------------------------------------------------------
// hashRecord sanity — the primitive detectConflicts is actually built on
// ---------------------------------------------------------------------------

{
  const a = await hashRecord('job', job('h1', { updatedAt: 111 }))
  const b = await hashRecord('job', job('h1', { updatedAt: 222 }))
  check('hashRecord ignores updatedAt (bookkeeping, not content) for jobs', a === b)
  const c = await hashRecord('job', job('h1', { name: 'Different name' }))
  check('hashRecord changes when actual content (name) changes', a !== c)
}

// ---------------------------------------------------------------------------

const label = 'syncConflict.ts resolves same-record edits without silently losing either side'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
