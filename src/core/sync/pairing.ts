/**
 * The LAN pairing handshake — one payload, two roles, one shared module.
 *
 * HOST and JOINER run the exact same code here; only the transport around it
 * differs. HOST needs a real TCP listener, which only `electron/pairingServer.ts`
 * can open (Node's `node:http`, bound to the LAN interface — see there). JOINER
 * only ever needs to send one POST, but the renderer's own CSP is `connect-src
 * 'self'`, so even that single request is relayed through a trusted layer (the
 * main process on desktop, the native plugin on Android) rather than issued by
 * `fetch()` in this module directly — see `PairingTransport` below.
 *
 * No mDNS, no SSDP, no discovery of any kind: the QR code already carries the
 * exact `host:port`, so there is nothing left to discover. Both devices must be
 * reachable on the same LAN or Wi-Fi Direct/hotspot link — this app has no
 * server and relays nothing through the internet, so there is deliberately no
 * fallback for two devices on different networks.
 */

import {
  base64ToBytes,
  bytesToBase64,
  deriveLongLivedKeyB64,
  deriveSessionKeys,
  exportPublicKeyB64,
  generateEphemeralKeyPair,
  importPublicKeyB64,
  PairingChannel,
  randomToken,
  type PairingEnvelope,
} from './pairingCrypto'

/** A pairing session lives for two minutes — long enough to scan, short enough that a screenshotted code is stale by the time anyone acts on it. */
export const PAIRING_SESSION_MS = 120_000

const QR_SCHEME = 'aevistle-pair:'

/**
 * `'once'` — the joiner receives the chosen scopes one time and the session
 * closes; nothing is kept afterwards but a receipt (see `core/receipts` usage
 * at the call site). `'ongoing'` — see `core/pairedDevices.ts`: a
 * `PairedDevice` record is kept, along with a second, long-lived key derived
 * alongside the ephemeral session keys below, so `core/syncLoop.ts` can find
 * this device again without a fresh QR scan.
 */
export type PairMode = 'once' | 'ongoing'

/** What the QR code encodes. `v` is a format version, not a protocol version — a future incompatible change can refuse to decode an old one by checking it. */
export interface PairingPayload {
  v: 1
  host: string
  port: number
  /** Base64, 32 random bytes. Single use — the host checks it once and closes. */
  token: string
  /** Base64 raw ECDH P-256 public key — the host's half of the key exchange. */
  epk: string
  /** Epoch ms. Past this, the host has stopped listening. */
  exp: number
  /** Chosen by the user on the host side before this code was drawn — see `PairMode`. */
  mode: PairMode
}

/** What the host derived for a completed 'ongoing' handshake — see `PairMode`. */
export interface OngoingPairingSecret {
  /**
   * Chosen by the host: a fresh id when this is a new pairing, or the
   * existing `PairedDevice.id` when this is `devices.regenerate` re-running
   * the handshake with a device already known — see `pairedDevices.ts`.
   */
  pairId: string
  longLivedKeyB64: string
  /** This side's estimate of "the other device's clock minus mine" — see `core/syncConflict.ts`. */
  clockOffsetMs: number
}

export type PairingEvent =
  | { type: 'listening'; payload: PairingPayload }
  | { type: 'connected'; ongoing?: OngoingPairingSecret }
  | { type: 'expired' }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

export function encodePairingText(payload: PairingPayload): string {
  return QR_SCHEME + JSON.stringify(payload)
}

export function decodePairingText(text: string): PairingPayload | null {
  if (!text.startsWith(QR_SCHEME)) return null
  try {
    const parsed = JSON.parse(text.slice(QR_SCHEME.length)) as Partial<PairingPayload>
    if (
      parsed.v === 1 &&
      typeof parsed.host === 'string' &&
      parsed.host.length > 0 &&
      typeof parsed.port === 'number' &&
      parsed.port > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.epk === 'string' &&
      parsed.epk.length > 0 &&
      typeof parsed.exp === 'number' &&
      (parsed.mode === 'once' || parsed.mode === 'ongoing')
    ) {
      return parsed as PairingPayload
    }
  } catch {
    // fall through to null — a QR code that is not ours, or is damaged
  }
  return null
}

export function isExpired(payload: Pick<PairingPayload, 'exp'>, now = Date.now()): boolean {
  return now >= payload.exp
}

export function msRemaining(payload: Pick<PairingPayload, 'exp'>, now = Date.now()): number {
  return Math.max(0, payload.exp - now)
}

// ---------------------------------------------------------------------------
// HOST — called from electron/pairingServer.ts, never from the renderer
// directly (it does not have a socket to listen on).
// ---------------------------------------------------------------------------

export interface HostSession {
  payload: PairingPayload
  privateKey: CryptoKey
}

/**
 * Build the payload and keep the private key back — `payload` is what gets
 * QR-encoded and handed to a camera; `privateKey` never leaves this process.
 */
export async function buildHostPayload(
  host: string,
  port: number,
  mode: PairMode,
  sessionMs = PAIRING_SESSION_MS,
): Promise<HostSession> {
  const keyPair = await generateEphemeralKeyPair()
  const epk = await exportPublicKeyB64(keyPair.publicKey)
  const token = randomToken()
  return {
    payload: { v: 1, host, port, token: bytesToBase64(token), epk, exp: Date.now() + sessionMs, mode },
    privateKey: keyPair.privateKey,
  }
}

export interface HostHandshakeResult {
  ok: true
  /** Offset, not a timestamp — see the clock-skew note on `joinPairing`. */
  ttlMsRemaining: number
  /** Proof the host derived the same key: the joiner must be able to open this. */
  confirmation: PairingEnvelope
  /** Set only when `mode` was `'ongoing'` — see `OngoingPairingSecret`. */
  ongoing?: OngoingPairingSecret
}

/** What the sealed confirmation actually carries — `pairId`/`hostNow` only matter for 'ongoing'. */
interface ConfirmationPayload {
  v: 1
  hello: 'aevistle-pair'
  mode: PairMode
  pairId?: string
  /** The host's own clock at the moment this was sealed — see `joinPairing`'s clock-offset note. */
  hostNow: number
}

/**
 * Turn one verified joiner POST into an established `PairingChannel`.
 *
 * Verifying the token and `exp` is the caller's job (`pairingServer.ts`),
 * because only the caller knows *when* the request arrived — this function is
 * pure and does not read the clock for anything but the TTL it reports back
 * and the offset estimate sealed into the confirmation.
 *
 * `joinerNow` is the joiner's own clock, sent alongside its public key in the
 * `/pair` POST — see `joinPairing`. Comparing it against this process's clock
 * *now*, at the moment the confirmation is sealed, is as close as two devices
 * that have never talked before can get to a clock-offset estimate without a
 * full round-trip protocol; `core/syncConflict.ts` treats it as an estimate,
 * not a guarantee.
 *
 * `pairId` is required when `mode === 'ongoing'`: a fresh id for a first-time
 * pairing, or an existing `PairedDevice.id` when `devices.regenerate` is
 * re-running this handshake with a device already known. Omitted for
 * `'once'`, which keeps no record to identify.
 */
export async function completeHostHandshake(
  hostPrivateKey: CryptoKey,
  token: Uint8Array,
  exp: number,
  joinerEpkB64: string,
  mode: PairMode,
  joinerNow: number,
  pairId?: string,
): Promise<{ channel: PairingChannel; result: HostHandshakeResult }> {
  const joinerPublicKey = await importPublicKeyB64(joinerEpkB64)
  const keys = await deriveSessionKeys(hostPrivateKey, joinerPublicKey, token, 'host')
  const channel = new PairingChannel(keys.sendKey, keys.receiveKey)
  const hostNow = Date.now()
  const confirmationPayload: ConfirmationPayload = {
    v: 1,
    hello: 'aevistle-pair',
    mode,
    hostNow,
    ...(mode === 'ongoing' && pairId ? { pairId } : {}),
  }
  const confirmation = await channel.seal(confirmationPayload)

  let ongoing: OngoingPairingSecret | undefined
  if (mode === 'ongoing' && pairId) {
    const longLivedKeyB64 = await deriveLongLivedKeyB64(hostPrivateKey, joinerPublicKey, token)
    ongoing = { pairId, longLivedKeyB64, clockOffsetMs: joinerNow - hostNow }
  }

  return {
    channel,
    result: { ok: true, ttlMsRemaining: Math.max(0, exp - Date.now()), confirmation, ongoing },
  }
}

// ---------------------------------------------------------------------------
// JOINER — runs wherever the "scan a code" screen is: the Electron renderer
// or the Android WebView. Both are CSP-restricted to `connect-src 'self'`, so
// the one HTTP request this role makes is handed to `transport.postJson`
// rather than issued with `fetch()` here — see `bridge.ts`'s
// `pairingJoinRequest` and its implementations.
// ---------------------------------------------------------------------------

export interface PairingTransport {
  postJson(url: string, body: unknown): Promise<unknown>
}

export interface PairingSession {
  channel: PairingChannel
  /** How long the host said its session had left *at the moment it answered* — see the clock-skew note below. */
  ttlMsRemaining: number
  /** Set only when the host's payload said `mode: 'ongoing'` — see `OngoingPairingSecret`. */
  ongoing?: OngoingPairingSecret
}

interface JoinResponse {
  ok?: boolean
  error?: string
  ttlMsRemaining?: number
  confirmation?: PairingEnvelope
}

/**
 * Clock skew between two machines is not a rare edge case — it is the default
 * state of two unrelated devices. Comparing this device's clock against the
 * host's `exp` (baked into the QR code) would make an accurate host and a
 * five-minutes-fast joiner disagree about whether the code is still good. So
 * the joiner never compares wall clocks: it takes `ttlMsRemaining`, the host's
 * own answer to "how long is left", as an *offset* from the moment the joiner
 * gets it, and everything after that is measured against the joiner's own
 * clock consistently.
 */
export async function joinPairing(
  payload: PairingPayload,
  transport: PairingTransport,
): Promise<PairingSession> {
  if (isExpired(payload)) {
    throw new Error('This pairing code has expired. Ask the other device for a new one.')
  }

  const keyPair = await generateEphemeralKeyPair()
  const epk = await exportPublicKeyB64(keyPair.publicKey)
  const hostPublicKey = await importPublicKeyB64(payload.epk)
  const token = base64ToBytes(payload.token)
  const keys = await deriveSessionKeys(keyPair.privateKey, hostPublicKey, token, 'joiner')
  const channel = new PairingChannel(keys.sendKey, keys.receiveKey)

  const joinerNow = Date.now()
  const url = `http://${payload.host}:${payload.port}/pair`
  const raw = await transport.postJson(url, { token: payload.token, epk, joinerNow })
  const response = raw as JoinResponse
  if (!response.ok) {
    throw new Error(response.error ?? 'The other device refused the pairing request.')
  }
  if (!response.confirmation) {
    throw new Error('The other device did not confirm the secure channel.')
  }

  const opened = await channel.open<{ v: number; hello: string; mode?: PairMode; pairId?: string; hostNow?: number }>(
    response.confirmation,
  )
  if (opened.hello !== 'aevistle-pair') {
    throw new Error('Could not verify the secure channel with the other device.')
  }

  let ongoing: OngoingPairingSecret | undefined
  if (opened.mode === 'ongoing' && opened.pairId) {
    const longLivedKeyB64 = await deriveLongLivedKeyB64(keyPair.privateKey, hostPublicKey, token)
    ongoing = {
      pairId: opened.pairId,
      longLivedKeyB64,
      // The mirror of the host's own estimate — see `completeHostHandshake`.
      clockOffsetMs: (opened.hostNow ?? Date.now()) - joinerNow,
    }
  }

  return { channel, ttlMsRemaining: response.ttlMsRemaining ?? 0, ongoing }
}
