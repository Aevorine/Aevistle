/**
 * Prove `src/core/sync/pairingCrypto.ts` and `src/core/sync/pairing.ts` correct.
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
 *
 * Since credentials learned to travel (`src/core/sync/secretTransport.ts`) there is
 * a second protocol here, and it needs the same treatment for a sharper
 * reason: what it moves is a mailbox password. So, below the handshake checks:
 *
 *   - the key credentials are sealed under must not be the sync key itself,
 *     asserted by requiring the plain sync key to *fail* on a credential
 *     envelope — a regression that quietly collapsed the two would otherwise
 *     be invisible, since everything would keep working;
 *   - a bundle must round-trip exactly, and must not open under a different
 *     pairing's key, a tampered ciphertext, or an unknown version;
 *   - the HKDF `info` and salt literals must match `SecretTransport.java`
 *     character for character. That one is a source-text check rather than a
 *     runtime one because the two implementations can never be in the same
 *     process, and a drift between them produces "the password synced but the
 *     account will not log in", which reads as a mail-server fault;
 *   - and, because the point of all of it is a *choice* the user made:
 *     `buildChangedPayload` must put nothing on the wire for a scope that was
 *     unchecked, and `attachAccountSecrets` must never claim `hasSecret` for
 *     an account the trusted layer did not actually seal a password for.
 */

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    `export * from ${JSON.stringify(join(root, 'src/core/sync/pairingCrypto.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src/core/sync/pairing.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src/core/sync/secretTransport.ts'))};`,
    `export * from ${JSON.stringify(join(root, 'src/core/sync/syncLoop.ts'))};`,
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
  ACCOUNT_SECRET_INFO,
  deriveAccountSecretKey,
  sealAccountSecrets,
  openAccountSecrets,
  importLongLivedKey,
  openWithRandomIv,
  sealWithRandomIv,
  applyExchange,
  attachAccountSecrets,
  buildChangedPayload,
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

// --- credential transport ----------------------------------------------------
//
// `src/core/sync/secretTransport.ts`. What moves here is a mailbox password, so the
// bar is not "it round-trips" but "it round-trips and nothing else opens it".

const SYNC_KEY_A = bytesToBase64(new Uint8Array(32).map((_, i) => i * 7 + 1))
const SYNC_KEY_B = bytesToBase64(new Uint8Array(32).map((_, i) => i * 11 + 3))

{
  const secrets = [
    { accountId: 'acc-1', smtp: 'hunter2', imap: 'hunter2-imap' },
    { accountId: 'acc-2', smtp: 'sp ace & symbols £ 中文' },
  ]
  const envelope = await sealAccountSecrets(SYNC_KEY_A, secrets)
  const opened = await openAccountSecrets(SYNC_KEY_A, envelope)
  ok(
    'a sealed credential bundle round-trips byte for byte',
    JSON.stringify(opened) === JSON.stringify(secrets),
  )

  // The whole reason `deriveAccountSecretKey` exists. If a refactor ever
  // collapsed it back onto the sync key, every test above would still pass and
  // credentials would silently become openable by anything that can open an
  // ordinary sync payload — so the assertion is that the sync key *fails*.
  let sameKeyRejected = false
  try {
    await openWithRandomIv(await importLongLivedKey(SYNC_KEY_A), envelope)
  } catch {
    sameKeyRejected = true
  }
  ok('a credential bundle does not open under the plain sync key', sameKeyRejected)

  // And the reverse: the credential key must not open an ordinary payload.
  const ordinary = await sealWithRandomIv(await importLongLivedKey(SYNC_KEY_A), { since: 1, changed: {} })
  let crossRejected = false
  try {
    await openAccountSecrets(SYNC_KEY_A, ordinary)
  } catch {
    crossRejected = true
  }
  ok('an ordinary sync payload does not open as a credential bundle', crossRejected)

  let wrongPairing = false
  try {
    await openAccountSecrets(SYNC_KEY_B, envelope)
  } catch {
    wrongPairing = true
  }
  ok("another pairing's key does not open this bundle", wrongPairing)

  let tamperRejected = false
  try {
    await openAccountSecrets(SYNC_KEY_A, {
      ...envelope,
      ciphertext: flipLastByte(envelope.ciphertext),
    })
  } catch {
    tamperRejected = true
  }
  ok('a tampered credential bundle fails to open', tamperRejected)

  // Version, not shape: an older build must refuse a future bundle loudly
  // rather than resolve empty, which the receiving side would read as "there
  // were no passwords" and record as `hasSecret: false`.
  const futureKey = await deriveAccountSecretKey(SYNC_KEY_A)
  const future = await sealWithRandomIv(futureKey, { v: 99, secrets: [] })
  let versionRejected = false
  try {
    await openAccountSecrets(SYNC_KEY_A, future)
  } catch {
    versionRejected = true
  }
  ok('a bundle from an unknown version is refused rather than read as empty', versionRejected)
}

// --- the two implementations must derive the same key ------------------------
//
// Source text, not runtime: the TypeScript runs on one device and the Java on
// the other, so nothing in any one process can catch a drift between them. It
// would surface as "the password synced but the account will not log in".

{
  /**
   * Java has no `crypto.subtle`, so `SecretTransport.java` writes RFC 5869 out
   * by hand over `Mac` — extract, then one 32-byte expand block. This is that
   * same arithmetic in Node, checked against what WebCrypto's `HKDF` actually
   * produces for the same inputs. If they ever disagree, a phone and a desktop
   * derive different keys from the same stored pairing, and the only symptom
   * is a synced password that will not log in.
   */
  const ikm = base64ToBytes(SYNC_KEY_A)
  const salt = new TextEncoder().encode('aevistle-sync-v1')
  const info = new TextEncoder().encode(ACCOUNT_SECRET_INFO)
  const prk = createHmac('sha256', Buffer.from(salt)).update(Buffer.from(ikm)).digest()
  const expanded = createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest()
  const viaWebCrypto = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
      256,
    ),
  )
  ok(
    "the Java side's hand-written HKDF derives the same 32 bytes WebCrypto does",
    Buffer.from(viaWebCrypto).equals(expanded),
  )

  // And end to end: a bundle sealed under a key derived that way must open
  // through the ordinary TypeScript path, which is what a phone sealing for a
  // desktop actually asks of these two implementations.
  const javaSideKey = await crypto.subtle.importKey(
    'raw',
    expanded,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const fromJava = await sealWithRandomIv(javaSideKey, {
    v: 1,
    secrets: [{ accountId: 'acc-1', smtp: 'from-the-phone' }],
  })
  const readByTs = await openAccountSecrets(SYNC_KEY_A, fromJava)
  ok(
    'a bundle sealed the Java way opens through the TypeScript path',
    readByTs[0]?.smtp === 'from-the-phone',
  )

  const java = readFileSync(join(root, 'android/app/src/main/java/dev/aevistle/app/SecretTransport.java'), 'utf8')
  ok(
    `SecretTransport.java uses the same HKDF info as secretTransport.ts ('${ACCOUNT_SECRET_INFO}')`,
    java.includes(`"${ACCOUNT_SECRET_INFO}"`),
  )
  const ts = readFileSync(join(root, 'src/core/sync/secretTransport.ts'), 'utf8')
  const declaredSalt = /ACCOUNT_SECRET_SALT = '([^']+)'/.exec(ts)?.[1]
  ok('secretTransport.ts declares an HKDF salt constant', Boolean(declaredSalt))
  ok(
    `SecretTransport.java uses the same HKDF salt ('${declaredSalt ?? '?'}')`,
    Boolean(declaredSalt) && java.includes(`String SALT = "${declaredSalt}"`),
  )
  // The literal the runtime check above pinned must be the one the source
  // declares, or that check is proving something about a constant nothing uses.
  ok(
    'the salt this check derived with is the one secretTransport.ts declares',
    declaredSalt === 'aevistle-sync-v1',
  )
}

// --- scope is honoured on the wire, not on receipt ---------------------------
//
// The user's choice in `SyncScopePicker` is only worth anything if an
// unchecked category never leaves the device. Asserted against the payload
// builder itself rather than against the UI, because that is the last place
// the choice can still be ignored.

const sampleState = {
  accounts: [
    { id: 'acc-1', label: 'Work', fromAddress: 'a@example.com', host: 'smtp.example.com', port: 465, username: 'a', hasSecret: true, updatedAt: 10 },
    { id: 'acc-2', label: 'Spare', fromAddress: 'b@example.com', host: 'smtp.example.com', port: 465, username: 'b', hasSecret: false, updatedAt: 10 },
  ],
  jobs: [{ id: 'job-1', name: 'Standup', updatedAt: 10, draft: {}, recurrence: {} }],
  contacts: [{ id: 'con-1', name: 'Ada', address: 'ada@example.com', updatedAt: 10 }],
  templates: [{ id: 'tpl-1', name: 'Weekly', subject: 's', body: 'b', updatedAt: 10 }],
  settings: {},
  deletedJobs: [],
}
const calendar = { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] }

{
  const only = buildChangedPayload(sampleState, calendar, ['contacts'], 0)
  ok('an unchecked scope puts nothing on the wire: no accounts', only.accounts === undefined)
  ok('an unchecked scope puts nothing on the wire: no schedule', only.schedule === undefined)
  ok('an unchecked scope puts nothing on the wire: no templates', only.templates === undefined)
  ok('an unchecked scope puts nothing on the wire: no appearance', only.appearance === undefined)
  ok('the one checked scope does travel', only.contacts?.length === 1)

  const all = buildChangedPayload(sampleState, calendar, ['accounts', 'schedule', 'templates'], 0)
  ok('every checked scope travels', Boolean(all.accounts && all.schedule && all.templates))
  ok('an unchecked scope alongside checked ones still does not', all.contacts === undefined)
}

// --- credentials ride the payload, and only when they were really sealed -----

{
  // Stands in for Electron main / the Android plugin: the only thing in this
  // design that ever touches a plaintext password.
  const vault = { 'acc-1': { smtp: 'hunter2' } }
  const transport = {
    async seal(accountIds) {
      const held = accountIds.filter((id) => vault[id])
      if (held.length === 0) return null
      return {
        envelope: await sealAccountSecrets(
          SYNC_KEY_A,
          held.map((id) => ({ accountId: id, ...vault[id] })),
        ),
        accountIds: held,
      }
    },
    async open(envelope) {
      const opened = await openAccountSecrets(SYNC_KEY_A, envelope)
      for (const s of opened) vault[s.accountId] = { smtp: s.smtp, imap: s.imap }
      return opened.map((s) => s.accountId)
    },
  }

  const payload = buildChangedPayload(sampleState, calendar, ['accounts'], 0)
  ok('accounts leave with hasSecret false until something seals them', payload.accounts.every((a) => !a.hasSecret))

  await attachAccountSecrets(payload, transport, sampleState)
  ok('a sealed envelope is attached to the payload', Boolean(payload.accountSecrets?.ciphertext))
  ok(
    'only the account whose password was actually sealed may claim hasSecret',
    payload.accounts.find((a) => a.id === 'acc-1').hasSecret === true &&
      payload.accounts.find((a) => a.id === 'acc-2').hasSecret === false,
  )
  // The one thing that must never be true of this payload.
  ok(
    'no plaintext password appears anywhere in the payload',
    !JSON.stringify(payload).includes('hunter2'),
  )

  // Receiving it, on a device that holds nothing yet.
  const emptyVault = {}
  const receiver = {
    seal: async () => null,
    async open(envelope) {
      const opened = await openAccountSecrets(SYNC_KEY_A, envelope)
      for (const s of opened) emptyVault[s.accountId] = s
      return opened.map((s) => s.accountId)
    },
  }
  const blank = { accounts: [], jobs: [], contacts: [], templates: [], settings: {}, deletedJobs: [] }
  const applied = await applyExchange(blank, payload, 0, 'session-1', 0, receiver)
  ok('the receiving side writes the password to its own keystore', emptyVault['acc-1']?.smtp === 'hunter2')
  ok(
    'the received account records that it now has a password',
    applied.patch.accounts.find((a) => a.id === 'acc-1').hasSecret === true,
  )
  ok(
    'an account whose password did not travel does not claim to have one',
    applied.patch.accounts.find((a) => a.id === 'acc-2').hasSecret === false,
  )
  ok(
    'no plaintext password reaches the state patch',
    !JSON.stringify(applied.patch).includes('hunter2'),
  )

  // A build with no trusted layer to open the envelope must still take the
  // accounts, and must not pretend it took the passwords with them.
  const noTransport = await applyExchange(blank, payload, 0, 'session-2', 0, undefined)
  ok(
    'a device that cannot open credentials still receives the accounts',
    noTransport.patch.accounts.length === 2,
  )
  ok(
    'a device that cannot open credentials reports no password on them',
    noTransport.patch.accounts.every((a) => !a.hasSecret),
  )
}

// --- the manual fallback has something to fall back to -----------------------
//
// `PairingScanner` has always offered "paste code instead", and both
// `pairing.cameraDeniedHint` and `devices.joinHint` tell the user to paste the
// text the other device is showing. `PairingQr.tsx` drew only the QR, so there
// was no such text anywhere in the app. Asserted here so it cannot silently go
// away again.

{
  const qrView = readFileSync(join(root, 'src/components/PairingQr.tsx'), 'utf8')
  ok(
    'PairingQr.tsx renders the pairing code as text, for a device that cannot scan',
    qrView.includes('encodePairingText') && qrView.includes('pairing.showCodeText'),
  )
  const scanner = readFileSync(join(root, 'src/components/PairingScanner.tsx'), 'utf8')
  ok(
    'PairingScanner.tsx still accepts that text by hand',
    scanner.includes('decodePairingText') && scanner.includes('pasteCodeInstead'),
  )
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
