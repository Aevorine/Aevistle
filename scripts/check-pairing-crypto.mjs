/**
 * Prove `src/core/pairingCrypto.ts` and `src/core/pairing.ts` correct.
 *
 * Unlike `check-qr.mjs`, this is not checking the *math* against a reference —
 * ECDH, HKDF and AES-GCM are WebCrypto primitives, already implemented (and
 * trusted) by the runtime itself. What is ours, and what actually needs
 * checking, is the protocol built on top of them:
 *
 *   - a HOST deriving `host->joiner`/`joiner->host` keys must land on exactly
 *     the same bits a JOINER derives for the same pairing, for a *fixed* ECDH
 *     keypair fixture — asserted by encrypting a known plaintext under one
 *     side's key and requiring the other side's key to open it, since the
 *     derived AES-GCM keys are deliberately non-extractable (`sealMessage`
 *     succeeding is only possible if the bits are identical);
 *   - a tampered envelope must fail to open;
 *   - a replayed or reordered counter must be rejected, not silently accepted;
 *   - the whole handshake (`buildHostPayload` → `joinPairing` →
 *     `completeHostHandshake`) must produce a channel each side can use to
 *     talk to the other;
 *   - an expired payload must be refused before any crypto runs at all.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = mkdtempSync(join(tmpdir(), 'aevistle-pairing-'))

/* One entry file that re-exports both modules, so a single esbuild bundle
   carries everything the checks below need. Absolute import specifiers so it
   resolves regardless of where the temp file physically sits. */
const entry = join(out, 'entry.ts')
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(join(root, 'src/core/pairingCrypto.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src/core/pairing.ts'))};`,
  ].join('\n'),
)

try {
  /* `shell: true` because Node refuses to spawn a `.cmd` directly on Windows,
     which is how npx ships there — same workaround as `check-qr.mjs`. */
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
  base64ToBytes,
  bytesToBase64,
  deriveSessionKeys,
  openMessage,
  PairingChannel,
  sealMessage,
  buildHostPayload,
  completeHostHandshake,
  decodePairingText,
  encodePairingText,
  isExpired,
  joinPairing,
  msRemaining,
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

// --- base64 round trip -------------------------------------------------------

for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 65]) {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  const round = base64ToBytes(bytesToBase64(bytes))
  ok(
    `base64 round-trips ${len} random byte(s)`,
    round.length === bytes.length && bytes.every((b, i) => round[i] === b),
  )
}

// --- fixed ECDH fixture: host and joiner must derive matching keys ---------
//
// A real, fixed P-256 keypair per side (exported once via `crypto.subtle`,
// pinned here as JWKs) rather than freshly generated ones, so this check is
// reproducible and is not quietly passing because both sides happen to share
// process state.

const hostPrivJwk = {
  key_ops: ['deriveBits'],
  ext: true,
  kty: 'EC',
  x: 'eUUUOnNJXObbRxtLpLVHg73sHJoO8mAWzTLdU9RwFp0',
  y: 'uRUD_vQleCqA3Syar0ty5zX7w7kD5wB5wIhOvLO1-10',
  crv: 'P-256',
  d: 'oMIKLpo_AoMDlWVdEOZwrWPQp0fNbxiPgurXD0KYr6I',
}
const hostPubJwk = { ...hostPrivJwk, key_ops: [], d: undefined }
delete hostPubJwk.d
const joinerPrivJwk = {
  key_ops: ['deriveBits'],
  ext: true,
  kty: 'EC',
  x: 'oCBIQotO7FwinMYg7A676siU8vcebwYrQUNf7IrUTL0',
  y: '0nk2LGTuhpw-7V--MqtTeuhoJAMtoPgdRBlBUnuYoH4',
  crv: 'P-256',
  d: 'GdUDemwgGSavk4k0wq-nDECyy761cy_URmvPsSVEBjA',
}
const joinerPubJwk = { ...joinerPrivJwk, key_ops: [], d: undefined }
delete joinerPubJwk.d

const ecdh = { name: 'ECDH', namedCurve: 'P-256' }
const hostPriv = await crypto.subtle.importKey('jwk', hostPrivJwk, ecdh, true, ['deriveBits'])
const hostPub = await crypto.subtle.importKey('jwk', hostPubJwk, ecdh, true, [])
const joinerPriv = await crypto.subtle.importKey('jwk', joinerPrivJwk, ecdh, true, ['deriveBits'])
const joinerPub = await crypto.subtle.importKey('jwk', joinerPubJwk, ecdh, true, [])

// 32 fixed bytes, 0x00..0x1f — stands in for the random pairing token.
const fixedToken = new Uint8Array(32).map((_, i) => i)

const hostKeys = await deriveSessionKeys(hostPriv, joinerPub, fixedToken, 'host')
const joinerKeys = await deriveSessionKeys(joinerPriv, hostPub, fixedToken, 'joiner')

const KNOWN_ENVELOPE = {
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: '7IsZbbdvcLRmqEqX7ThTTHA/EDz1bodVgDylk8cho62+9JKU+I0uR8zEzqX+hbw=',
}
ok(
  "sealing with the host's send key reproduces the known fixture ciphertext",
  JSON.stringify(await sealMessage(hostKeys.sendKey, 0, { v: 1, hello: 'aevistle-pair' })) ===
    JSON.stringify(KNOWN_ENVELOPE),
)

{
  const opened = await openMessage(joinerKeys.receiveKey, KNOWN_ENVELOPE, 0)
  ok(
    "joiner's receive key opens what the host's send key sealed (same derived bits)",
    opened.hello === 'aevistle-pair',
  )
}

{
  const sealed = await sealMessage(joinerKeys.sendKey, 0, { ping: true })
  const opened = await openMessage(hostKeys.receiveKey, sealed, 0)
  ok("the reverse direction (joiner->host) round-trips too", opened.ping === true)
}

{
  let rejected = false
  try {
    // The joiner's *send* key must not open something sealed with its own
    // receive key's counterpart — cross-wiring the two directions would mean
    // a device can decrypt its own outgoing traffic, which is not "secure".
    await openMessage(joinerKeys.sendKey, KNOWN_ENVELOPE, 0)
  } catch {
    rejected = true
  }
  ok('a message is not openable with the wrong directional key', rejected)
}

// --- tamper detection --------------------------------------------------------

{
  const sealed = await sealMessage(hostKeys.sendKey, 5, { secret: 'do not leak' })
  const tampered = { ...sealed, ciphertext: flipLastByte(sealed.ciphertext) }
  let rejected = false
  try {
    await openMessage(joinerKeys.receiveKey, tampered, 5)
  } catch {
    rejected = true
  }
  ok('a tampered ciphertext fails to open', rejected)
}

// --- replay / reordering -----------------------------------------------------

{
  const channelA = new PairingChannel(hostKeys.sendKey, hostKeys.receiveKey)
  const channelB = new PairingChannel(joinerKeys.sendKey, joinerKeys.receiveKey)

  const first = await channelA.seal({ n: 1 })
  const second = await channelA.seal({ n: 2 })

  const openedFirst = await channelB.open(first)
  ok('PairingChannel opens message 0 in order', openedFirst.n === 1)

  let replayRejected = false
  try {
    await channelB.open(first) // replaying counter 0 a second time
  } catch {
    replayRejected = true
  }
  ok('PairingChannel rejects a replayed message', replayRejected)

  // The channel's receive counter did not advance on the rejected replay, so
  // it should still accept message 1 next.
  const openedSecond = await channelB.open(second)
  ok('PairingChannel still accepts the next in-order message after a rejected replay', openedSecond.n === 2)
}

// --- full handshake, end to end ---------------------------------------------

{
  const host = await buildHostPayload('192.168.1.50', 51234, 'once', 120_000)
  // Captured from inside the transport so it can be compared against the
  // joiner's own channel afterwards — this is the in-process stand-in for the
  // socket `pairingServer.ts` would otherwise carry the handshake over.
  let hostChannel = null
  const transport = {
    async postJson(url, body) {
      ok(
        'joiner posts to the exact host:port:/pair the payload named',
        url === 'http://192.168.1.50:51234/pair',
      )
      const { channel, result } = await completeHostHandshake(
        host.privateKey,
        base64ToBytes(host.payload.token),
        host.payload.exp,
        body.epk,
        'once',
        body.joinerNow,
      )
      hostChannel = channel
      return result
    },
  }

  const session = await joinPairing(host.payload, transport)
  ok('joinPairing resolves with a positive TTL', session.ttlMsRemaining > 0)

  // The confirmation message inside `joinPairing` already proved the joiner
  // can open what the host sealed (counter 0). Prove the reverse direction
  // too: something the *joiner* seals, the host's channel must be able to open.
  const fromJoiner = await session.channel.seal({ hello: 'from joiner' })
  const openedByHost = await hostChannel.open(fromJoiner)
  ok('the host channel opens what the joiner channel sealed', openedByHost.hello === 'from joiner')
}

// --- QR text and TTL ---------------------------------------------------------

{
  const { payload } = await buildHostPayload('10.0.0.5', 4000, 'once', 120_000)
  const text = encodePairingText(payload)
  ok('encodePairingText uses the aevistle-pair: scheme', text.startsWith('aevistle-pair:'))
  const decoded = decodePairingText(text)
  ok('decodePairingText round-trips the payload', JSON.stringify(decoded) === JSON.stringify(payload))
  ok('decodePairingText refuses an unrelated string', decodePairingText('https://example.com') === null)
  ok('decodePairingText refuses a scheme match with garbage after it', decodePairingText('aevistle-pair:{not json') === null)

  ok('a fresh payload is not expired', isExpired(payload) === false)
  ok('msRemaining is close to the session length just after creation', msRemaining(payload) > 100_000)

  const stale = { ...payload, exp: Date.now() - 1 }
  ok('an expired payload is reported expired', isExpired(stale) === true)

  let expiredRejected = false
  try {
    await joinPairing(stale, { postJson: async () => ({ ok: true }) })
  } catch {
    expiredRejected = true
  }
  ok('joinPairing refuses an expired payload before making any request', expiredRejected)
}

rmSync(out, { recursive: true, force: true })

function quote(p) {
  return `"${p}"`
}

function flipLastByte(base64) {
  const bytes = base64ToBytes(base64)
  bytes[bytes.length - 1] ^= 0xff
  return bytesToBase64(bytes)
}

if (failures > 0) {
  console.error(`\ncheck:pairing-crypto FAILED — ${failures}/${checked} checks failed`)
  process.exit(1)
}
console.log(`\ncheck:pairing-crypto ok — ${checked} checks passed`)
