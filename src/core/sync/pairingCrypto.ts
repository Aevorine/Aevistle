/**
 * WebCrypto-only primitives for LAN device pairing — zero new dependencies.
 *
 * `crypto.subtle` is not platform-specific here: it is the same global in the
 * Electron renderer, in the Capacitor Android WebView, and (since Electron
 * bundles a modern Node) in the Electron main process too. One implementation
 * runs unchanged wherever a pairing role happens to execute.
 *
 * The shape is ECDH on P-256 for an ephemeral per-session keypair, HKDF to turn
 * the raw shared secret into two directional AES-GCM keys, and a small sealed
 * envelope for everything sent afterwards. Two keys rather than one: both sides
 * derive the identical ECDH secret, so a single AES key would have the host and
 * the joiner encrypting under the same key from counter zero — a nonce collision
 * on the first message each way, which breaks GCM's confidentiality and
 * authenticity guarantees outright. Deriving `host->joiner` and `joiner->host`
 * as separate keys (via HKDF's `info` parameter) keeps every counter unique to
 * the key that used it.
 *
 * Not trusted on inspection: `scripts/check-pairing-crypto.mjs` round-trips a
 * known ECDH fixture and checks the derived keys, and the seal/open pair,
 * against fixed expectations.
 */

const HOST_TO_JOINER_INFO = 'aevistle-pair-v1:host->joiner'
const JOINER_TO_HOST_INFO = 'aevistle-pair-v1:joiner->host'
/** HKDF `info` for the long-lived 'ongoing' pairing key — see `deriveLongLivedKeyB64` below. */
const SYNC_KEY_INFO = 'aevistle-pair-v1:sync-key'

export type PairingRole = 'host' | 'joiner'

/**
 * `@types/node`'s global `Uint8Array<ArrayBufferLike>` and lib.dom's
 * `BufferSource` (which excludes `SharedArrayBuffer`-backed views) disagree
 * about every plain `Uint8Array` in this file, even ones that are provably
 * backed by a real `ArrayBuffer` at runtime — a typings conflict, not a real
 * type hazard. One cast at the boundary rather than one at every call site.
 */
function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource
}

/** `{iv, ciphertext}`, both base64 — the whole shape that crosses the wire. */
export interface PairingEnvelope {
  iv: string
  ciphertext: string
}

export interface SessionKeys {
  sendKey: CryptoKey
  receiveKey: CryptoKey
}

// --- base64 ------------------------------------------------------------------
// Written by hand rather than reached for `Buffer` (absent in a WebView) or
// assumed-global `btoa`/`atob` (present everywhere this runs today, but not a
// contract worth depending on for a security-relevant module).

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 0x3f]
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let bitBuffer = 0
  let bitCount = 0
  let outIndex = 0
  for (const char of clean) {
    const value = B64_CHARS.indexOf(char)
    if (value < 0) continue
    bitBuffer = (bitBuffer << 6) | value
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      bytes[outIndex++] = (bitBuffer >> bitCount) & 0xff
    }
  }
  return bytes.slice(0, outIndex)
}

// --- keys ----------------------------------------------------------------

/** 32 random bytes — the one-time pairing token carried in the QR payload. */
export function randomToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

export async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]) as Promise<CryptoKeyPair>
}

export async function exportPublicKeyB64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return bytesToBase64(new Uint8Array(raw))
}

export async function importPublicKeyB64(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toBufferSource(base64ToBytes(b64)),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
}

/**
 * ECDH + HKDF, salted with the pairing token so the same two devices pairing
 * twice never derive the same key twice, then split into the two directional
 * AES-256-GCM keys described above.
 */
export async function deriveSessionKeys(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  token: Uint8Array,
  role: PairingRole,
): Promise<SessionKeys> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
  const deriveDirectional = (info: string) =>
    crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toBufferSource(token),
        info: toBufferSource(new TextEncoder().encode(info)),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  const hostKey = await deriveDirectional(HOST_TO_JOINER_INFO)
  const joinerKey = await deriveDirectional(JOINER_TO_HOST_INFO)
  return role === 'host'
    ? { sendKey: hostKey, receiveKey: joinerKey }
    : { sendKey: joinerKey, receiveKey: hostKey }
}

/**
 * A second key from the same ECDH secret, for 'ongoing' pairing only.
 *
 * `deriveSessionKeys` above produces two keys that live exactly as long as the
 * `PairingChannel` holding them — gone the moment the pairing screen closes.
 * An 'ongoing' pair needs the opposite: a key that survives the app quitting
 * and restarting, so `core/syncLoop.ts` can reach the other device again next
 * week without a fresh QR scan. Same ECDH shared secret, different HKDF
 * `info` — deriving it is free, and it costs nothing to compute even when the
 * mode turns out to be 'once' and it is never stored.
 *
 * Returned as base64 raw bytes rather than a `CryptoKey` because this is what
 * `keyRef`'s secret actually *is* — the thing `setSecret` writes to the OS
 * keystore, the same shape a password takes. `importLongLivedKey` turns it
 * back into an AES-GCM key at the point it is actually used.
 */
export async function deriveLongLivedKeyB64(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  token: Uint8Array,
): Promise<string> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBufferSource(token),
      info: toBufferSource(new TextEncoder().encode(SYNC_KEY_INFO)),
    },
    hkdfKey,
    256,
  )
  return bytesToBase64(new Uint8Array(bits))
}

export async function importLongLivedKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toBufferSource(base64ToBytes(b64)),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Seal/open with a random 96-bit IV rather than `PairingChannel`'s climbing
 * counter.
 *
 * The counter scheme above is safe only because a `PairingChannel` lives in
 * memory for one short session — the counter and the key are born and die
 * together. A long-lived sync key is the opposite: it survives restarts, and
 * nothing durable tracks how many messages were sealed under it across all of
 * them. Reusing counter 0 after a restart would reuse an IV, which breaks
 * AES-GCM outright. A fresh random IV per message has no such requirement —
 * the birthday bound on 96 random bits is astronomically past anything a
 * periodic LAN poll will ever send under one key.
 */
export async function sealWithRandomIv(key: CryptoKey, payload: unknown): Promise<PairingEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(plaintext),
  )
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }
}

export async function openWithRandomIv<T>(key: CryptoKey, envelope: PairingEnvelope): Promise<T> {
  const iv = base64ToBytes(envelope.iv)
  const ciphertext = base64ToBytes(envelope.ciphertext)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

// --- sealed messages -------------------------------------------------------

/**
 * The IV *is* the counter (first 4 of its 12 bytes, big-endian; the rest zero)
 * rather than a separate field next to it — a message with counter 7 can only
 * ever be encrypted under one IV, so the receiver checking the counter is
 * checking the IV. Safe against nonce reuse because a `PairingChannel` counter
 * only ever climbs, and safe against replay because the receiver requires it
 * to climb by exactly one.
 */
function counterToIv(counter: number): Uint8Array {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setUint32(0, counter, false)
  return iv
}

function ivToCounter(iv: Uint8Array): number {
  return new DataView(iv.buffer, iv.byteOffset, iv.byteLength).getUint32(0, false)
}

export async function sealMessage(
  key: CryptoKey,
  counter: number,
  payload: unknown,
): Promise<PairingEnvelope> {
  const iv = counterToIv(counter)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(plaintext),
  )
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }
}

export async function openMessage<T>(
  key: CryptoKey,
  envelope: PairingEnvelope,
  expectedCounter: number,
): Promise<T> {
  const iv = base64ToBytes(envelope.iv)
  if (iv.length !== 12) throw new Error('malformed pairing envelope')
  const counter = ivToCounter(iv)
  if (counter !== expectedCounter) {
    throw new Error('out-of-sequence pairing message — possible replay')
  }
  const ciphertext = base64ToBytes(envelope.ciphertext)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

/**
 * One end of a session: a send key with its own climbing counter, a receive
 * key with its own. Reused across every message so a caller never has to
 * thread counters through by hand.
 */
export class PairingChannel {
  private sendCounter = 0
  private receiveCounter = 0

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
  ) {}

  async seal(payload: unknown): Promise<PairingEnvelope> {
    const envelope = await sealMessage(this.sendKey, this.sendCounter, payload)
    this.sendCounter++
    return envelope
  }

  async open<T>(envelope: PairingEnvelope): Promise<T> {
    const value = await openMessage<T>(this.receiveKey, envelope, this.receiveCounter)
    this.receiveCounter++
    return value
  }
}
