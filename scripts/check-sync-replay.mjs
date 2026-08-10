/**
 * Prove replay protection on the long-lived device-sync channel
 * (`src/core/syncLoop.ts`'s `SyncExchangePayload.seq`, `assertFreshSeq`, and
 * `src/core/pairedDevices.ts`'s `outgoingSeq`/`lastAcceptedSeq`/
 * `recordSyncSeq`) actually holds, the same way `check-pairing-crypto.mjs`
 * proves the one-time pairing handshake's climbing counter does.
 *
 * `sealWithRandomIv`/`openWithRandomIv` authenticate a message but say
 * nothing about *when* it was sent — a captured envelope re-sent later
 * decrypts exactly as it did the first time. What is checked below is the
 * layer built on top of that fact:
 *
 *   - a genuinely replayed (byte-identical) sealed payload is rejected the
 *     second time it is delivered, not silently re-processed;
 *   - a payload whose `seq` jumps forward (a dropped packet, or a gap left
 *     by a concurrent exchange with the same peer) is still accepted — the
 *     check is "strictly greater", not "exactly one more", on purpose;
 *   - two fresh peers with no prior history sync normally, end to end,
 *     through the real `SyncLoop`/`respondToSyncRequest` code paths rather
 *     than a hand-rolled stand-in for them;
 *   - `recordSyncSeq` never lets a counter regress, which is what keeps a
 *     race between two devices polling each other in the same window (see
 *     `syncLoop.ts`'s module doc) from reopening the replay window this
 *     feature exists to close.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-sync-replay-'))

const entry = join(out, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(join(root, 'src/core/pairingCrypto.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src/core/pairedDevices.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src/core/syncLoop.ts'))};`,
  ].join('\n'),
)

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      quote(entry),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${quote(join(out, 'bundle.mjs'))}`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: true },
  )
} catch (e) {
  console.error('esbuild failed:', e.message)
  process.exit(1)
}

const mod = await import(pathToFileURL(join(out, 'bundle.mjs')).href)
const {
  bytesToBase64,
  importLongLivedKey,
  sealWithRandomIv,
  assertFreshSeq,
  respondToSyncRequest,
  SyncLoop,
  recordSyncSeq,
  touchSynced,
} = mod

let failures = 0
let checked = 0
const ok = (label, cond) => {
  checked++
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    console.error(`  FAIL  ${label}`)
    failures++
  }
}

// Fixed, not derived via a real ECDH handshake — this file is proving the
// replay-protection layer built *on top of* the crypto, and a real pairing's
// key exchange is already covered by `check-pairing-crypto.mjs`. Both sides
// of a real 'ongoing' pairing share one symmetric key; so do these two.
const SYNC_KEY = bytesToBase64(new Uint8Array(32).map((_, i) => i * 5 + 3))

const CALENDAR = { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] }

function blankState(contacts = []) {
  return { accounts: [], jobs: [], contacts, templates: [], settings: {}, deletedJobs: [] }
}

/**
 * One side of a simulated pairing: its own state, its record of the peer,
 * and a clock it controls. `pairId` is the *shared* id both sides of a real
 * pairing agree on during the handshake (`core/pairing.ts`'s `pairId`,
 * carried onto each side's own `PairedDevice.id` — see that field's doc) —
 * not either side's own identity, and the same string is passed for both
 * `makeSide` calls that model one pairing.
 */
function makeSide(pairId, peerLabel, contacts = []) {
  return {
    now: 1_000_000,
    state: blankState(contacts),
    devices: [
      {
        id: pairId,
        label: peerLabel,
        platform: 'windows',
        pairedAt: 0,
        mode: 'ongoing',
        scopes: ['contacts'],
        keyRef: pairId,
        lastAddress: { host: '127.0.0.1', port: 48793 },
      },
    ],
  }
}

function respondHooksFor(side) {
  return {
    findDevice: (pairId) => side.devices.find((d) => d.id === pairId),
    getSecret: async () => SYNC_KEY,
    getState: () => side.state,
    getCalendar: () => CALENDAR,
    now: () => side.now,
    // Mirrors AppState.tsx's `commitAcceptedSeq`: advance the mark alone,
    // synchronously, without the rest of `commit()`'s `touchSynced`/contacts
    // handling — this fires before an exchange has finished, deliberately
    // before this side has anything else to commit yet.
    commitAcceptedSeq: (pairId, seq) => {
      side.devices = recordSyncSeq(side.devices, pairId, { lastAcceptedSeq: seq })
    },
  }
}

/** Mirrors `AppState.tsx`'s `applySyncResult` reducer case: `touchSynced` then `recordSyncSeq`, plus landing whatever scoped data actually changed. */
function commit(side, device, patch, syncedAt) {
  side.devices = recordSyncSeq(
    touchSynced(side.devices, device.id, syncedAt, undefined, patch.remoteDeviceId),
    device.id,
    { outgoingSeq: patch.outgoingSeq, lastAcceptedSeq: patch.lastAcceptedSeq },
  )
  if (patch.contacts) side.state = { ...side.state, contacts: patch.contacts }
}

function deviceFor(side, peerId) {
  return side.devices.find((d) => d.id === peerId)
}

/** A `SyncLoop` wired to talk to `peer` in-process — `postJson` calls `respondToSyncRequest` directly instead of going over a real socket, the same substitution `check-pairing-crypto.mjs` makes for `pairingServer.ts`. */
function makeLoop(self, peer, { onError, onUnreachable, captureEnvelope } = {}) {
  return new SyncLoop({
    now: () => self.now,
    getState: () => self.state,
    getCalendar: () => CALENDAR,
    getPairedDevices: () => self.devices,
    getSecret: async () => SYNC_KEY,
    transport: {
      postJson: async (_url, body) => {
        captureEnvelope?.(body.envelope)
        const outcome = await respondToSyncRequest(respondHooksFor(peer), body.pairId, body.envelope)
        if ('error' in outcome) return { ok: false, error: outcome.error }
        commit(peer, outcome.outcome.device, outcome.outcome.patch, peer.now)
        return { ok: true, envelope: outcome.envelope }
      },
    },
    onSynced: (device, result, at) => commit(self, device, result.patch, at),
    onError: (device, message) => onError?.(message),
    onUnreachable: () => onUnreachable?.(),
  })
}

// --- assertFreshSeq, directly -------------------------------------------

{
  const device = { lastAcceptedSeq: 5 }
  const throws = (payload) => {
    try {
      assertFreshSeq(device, payload)
      return false
    } catch {
      return true
    }
  }
  ok('assertFreshSeq rejects a seq equal to the last accepted', throws({ seq: 5, since: 0, changed: {} }))
  ok('assertFreshSeq rejects a seq lower than the last accepted', throws({ seq: 4, since: 0, changed: {} }))
  ok('assertFreshSeq accepts a seq strictly greater than the last accepted', !throws({ seq: 6, since: 0, changed: {} }))
}
{
  const fresh = {}
  let threw = false
  try {
    assertFreshSeq(fresh, { seq: 1, since: 0, changed: {} })
  } catch {
    threw = true
  }
  ok('a device with no lastAcceptedSeq yet treats it as 0, so seq 1 is accepted', !threw)
  threw = false
  try {
    assertFreshSeq(fresh, { seq: 0, since: 0, changed: {} })
  } catch {
    threw = true
  }
  ok('a device with no lastAcceptedSeq yet still rejects seq 0 (not strictly greater than 0)', threw)
}

// --- recordSyncSeq never regresses a counter ----------------------------

{
  const devices = [
    { id: 'x', label: 'X', platform: 'windows', pairedAt: 0, mode: 'ongoing', scopes: [], keyRef: 'x', outgoingSeq: 10, lastAcceptedSeq: 10 },
  ]
  const staleWrite = recordSyncSeq(devices, 'x', { outgoingSeq: 3, lastAcceptedSeq: 3 })
  ok(
    'recordSyncSeq never regresses a counter a previous write already advanced past',
    staleWrite[0].outgoingSeq === 10 && staleWrite[0].lastAcceptedSeq === 10,
  )
  const freshWrite = recordSyncSeq(devices, 'x', { outgoingSeq: 15, lastAcceptedSeq: 12 })
  ok(
    'recordSyncSeq advances a counter when the new value actually is higher',
    freshWrite[0].outgoingSeq === 15 && freshWrite[0].lastAcceptedSeq === 12,
  )
  const untouched = recordSyncSeq(devices, 'x', {})
  ok('recordSyncSeq is a no-op when neither counter is supplied', untouched[0].outgoingSeq === 10 && untouched[0].lastAcceptedSeq === 10)
}

// --- normal back-and-forth between two fresh peers, no prior history -----

{
  const pairId = 'pair-ab'
  const a = makeSide(pairId, 'B', [{ id: 'c1', name: 'Ada', address: 'ada@example.com', updatedAt: 500 }])
  const b = makeSide(pairId, 'A', [])
  let error = null
  const loop = makeLoop(a, b, { onError: (m) => (error = m) })

  await loop.runCycle()

  ok('a fresh sync cycle between two never-synced peers reports no error', error === null)
  ok("the changed contact actually reaches the peer's state", b.state.contacts.some((c) => c.id === 'c1'))
  ok(
    "the initiator's own outgoing counter for this peer is now 1 (the request it just sent)",
    deviceFor(a, pairId).outgoingSeq === 1,
  )
  ok(
    "the initiator's high-water mark for the peer is now 1 (the reply it just accepted)",
    deviceFor(a, pairId).lastAcceptedSeq === 1,
  )
  ok(
    "the responder's high-water mark for the initiator is now 1 (the request it just accepted)",
    deviceFor(b, pairId).lastAcceptedSeq === 1,
  )
  ok(
    "the responder's own outgoing counter for the initiator is now 1 (the reply it just sealed)",
    deviceFor(b, pairId).outgoingSeq === 1,
  )

  // A second, ordinary cycle right after — proves the feature does not
  // break the steady state where nothing new happened either side.
  a.now += 90_000
  b.now += 90_000
  error = null
  await loop.runCycle()
  ok('a second ordinary cycle (nothing new to sync) still reports no error', error === null)
  ok(
    'the second cycle climbs both counters by exactly one more',
    deviceFor(a, pairId).outgoingSeq === 2 && deviceFor(b, pairId).lastAcceptedSeq === 2,
  )
}

// --- a genuinely replayed (byte-identical) payload is rejected -----------

{
  const pairId = 'pair-ab2'
  const a = makeSide(pairId, 'B2', [{ id: 'c2', name: 'Bo', address: 'bo@example.com', updatedAt: 500 }])
  const b = makeSide(pairId, 'A2', [])
  let captured = null
  let error = null
  const loop = makeLoop(a, b, { onError: (m) => (error = m), captureEnvelope: (e) => (captured = e) })

  await loop.runCycle()
  ok('setup: the first (genuine) request is accepted', error === null && captured !== null)
  const acceptedAt = deviceFor(b, pairId).lastAcceptedSeq

  // Replay the exact same envelope object — same iv, same ciphertext bytes —
  // straight at the responder, as an attacker who captured it off the LAN
  // would.
  const replay = await respondToSyncRequest(respondHooksFor(b), pairId, captured)
  ok('a byte-identical replayed envelope is rejected on second delivery', 'error' in replay)
  ok(
    "the rejected replay does not advance the responder's high-water mark",
    deviceFor(b, pairId).lastAcceptedSeq === acceptedAt,
  )

  // And the peer can still make forward progress afterwards — a rejected
  // replay must not wedge the pairing.
  a.now += 90_000
  b.now += 90_000
  error = null
  await loop.runCycle()
  ok('a normal cycle right after a rejected replay still succeeds', error === null)
  ok('...and climbs the counter past where the replay left it', deviceFor(b, pairId).lastAcceptedSeq === acceptedAt + 1)
}

// --- an out-of-order-but-not-replayed payload (seq jumps forward) --------

{
  const pairId = 'pair-ab3'
  const a = makeSide(pairId, 'B3', [])
  const b = makeSide(pairId, 'A3', [])

  // A dropped packet, or a gap left by a concurrent exchange with the same
  // peer: this device's real outgoingSeq for this peer is 0 (nothing sent
  // yet), but the message that actually arrives claims seq 5 — as if four
  // earlier ones never made it.
  const jumped = await sealWithRandomIv(await importLongLivedKey(SYNC_KEY), {
    since: a.now,
    changed: {},
    selfDeviceId: 'a-identity',
    seq: 5,
  })
  const outcome = await respondToSyncRequest(respondHooksFor(b), pairId, jumped)
  ok('an out-of-order payload whose seq jumps forward is still accepted', !('error' in outcome))
  if (!('error' in outcome)) commit(b, outcome.outcome.device, outcome.outcome.patch, b.now)
  ok('...and becomes the new high-water mark', deviceFor(b, pairId).lastAcceptedSeq === 5)

  // A later message reusing that same seq 5 — different envelope, same
  // number — must still be rejected: the check is on the number, not on the
  // envelope's bytes.
  const reused = await sealWithRandomIv(await importLongLivedKey(SYNC_KEY), {
    since: a.now,
    changed: {},
    selfDeviceId: 'a-identity',
    seq: 5,
  })
  const reusedOutcome = await respondToSyncRequest(respondHooksFor(b), pairId, reused)
  ok('a different payload that reuses an already-accepted seq is rejected too', 'error' in reusedOutcome)

  // And the very next number climbs normally.
  const next = await sealWithRandomIv(await importLongLivedKey(SYNC_KEY), {
    since: a.now,
    changed: {},
    selfDeviceId: 'a-identity',
    seq: 6,
  })
  const nextOutcome = await respondToSyncRequest(respondHooksFor(b), pairId, next)
  ok('the next seq after the jump is accepted normally', !('error' in nextOutcome))
}

// --- concurrent delivery of the same envelope must not double-accept -----
//
// The sequential case above (replay only after the first delivery has fully
// finished) was never the hard part — `assertFreshSeq` alone always caught
// that. The real risk this section exists for: two copies of the same
// captured envelope, delivered close enough together that both reach
// `assertFreshSeq` before either has advanced the high-water mark. A slow
// `getSecret` stands in for the real OS-keystore IPC round trip that gave
// this window its real-world width.

{
  const pairId = 'pair-ab4'
  const b = makeSide(pairId, 'A4', [])

  const envelope = await sealWithRandomIv(await importLongLivedKey(SYNC_KEY), {
    since: 1_000_000,
    changed: {},
    selfDeviceId: 'a-identity',
    seq: 1,
  })

  const slowHooksFor = (side) => ({
    ...respondHooksFor(side),
    getSecret: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return SYNC_KEY
    },
  })

  const [first, second] = await Promise.all([
    respondToSyncRequest(slowHooksFor(b), pairId, envelope),
    respondToSyncRequest(slowHooksFor(b), pairId, envelope),
  ])
  const firstOk = !('error' in first)
  const secondOk = !('error' in second)
  ok('two concurrent deliveries of the same envelope are not both accepted', !(firstOk && secondOk))
  ok('...but exactly one of them is (this is not both failing for an unrelated reason)', firstOk !== secondOk)
  ok("the peer's high-water mark advances by exactly one, not zero or two", deviceFor(b, pairId).lastAcceptedSeq === 1)
}

rmSync(out, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\ncheck:sync-replay FAILED — ${failures}/${checked} checks failed`)
  process.exit(1)
}
console.log(`\ncheck:sync-replay ok — ${checked} checks passed`)

function quote(p) {
  return `"${p}"`
}
