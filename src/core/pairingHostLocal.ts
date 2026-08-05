/**
 * The HOST half of LAN pairing, run inside the app rather than beside it.
 *
 * `electron/pairingServer.ts` is the same state machine written for a platform
 * that has `node:http` and `node:crypto` in the same process as the socket. On
 * Android neither of those is true: the socket has to be a Java
 * `ServerSocket` (see `LanServer.java`), and the WebCrypto that
 * `core/pairing.ts` runs on lives in the WebView. Reimplementing the handshake
 * in Java to put both on one side of the fence would mean two independent
 * implementations of a key exchange, and the one that is wrong is the one
 * nobody is looking at.
 *
 * So the fence moves instead: Java owns the socket and nothing else, and this
 * module — the same `core/pairing.ts` functions the desktop server calls, in
 * the same order — owns the session. The native side hands over a request
 * body and takes back a status and a body, which is the mirror image of the
 * relay `pairingRequest` already provides for the JOINER role, and exactly the
 * "genuinely dumb, on purpose" posture `electron/syncServer.ts` describes.
 *
 * Deliberately platform-agnostic. It imports nothing from Capacitor and knows
 * nothing about how the bytes reached it, so `scripts/check-pairing-crypto.mjs`
 * can drive it directly and a second host platform would need no changes here.
 *
 * ## What it refuses, and why here
 *
 * The token check, the expiry check and the one-connection rule are all in this
 * file rather than in Java, for the reason `pairingServer.ts` gives for keeping
 * them out of `core/pairing.ts`: they are decisions about *this* attempt, and
 * the party holding the private key is the only one that can make them
 * coherently. A Java-side token comparison would also be a second copy of the
 * one rule that decides whether a stranger on the Wi-Fi gets a sealed channel.
 */

import {
  buildHostPayload,
  completeHostHandshake,
  PAIRING_SESSION_MS,
  type PairingEvent,
  type PairingPayload,
  type PairMode,
} from './pairing'
import { base64ToBytes } from './pairingCrypto'

/** A handshake body is a token and a raw P-256 public key — the same ceiling `pairingServer.ts` sets, for the same reason. */
export const MAX_PAIR_BODY = 64 * 1024

/** What `handle()` answers with. The caller writes it to a socket verbatim. */
export interface LocalPairingReply {
  status: number
  body: unknown
}

interface ActiveSession {
  privateKey: CryptoKey
  token: Uint8Array
  exp: number
  mode: PairMode
  pairId?: string
}

/**
 * Constant-time byte comparison.
 *
 * `node:crypto`'s `timingSafeEqual` is what the desktop uses and there is no
 * WebCrypto equivalent, so this is the hand-written one. The threat is modest —
 * an attacker would need to be on the LAN, guessing a 32-byte single-use token
 * inside a two-minute window, against a socket that closes on first success —
 * but a plain `===` on secrets is the kind of thing that is only ever noticed
 * in the audit that follows it going wrong, and the loop below costs nothing.
 *
 * The length check leaks the length, which is a constant of the protocol and
 * therefore not a secret.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export class LocalPairingHost {
  private session: ActiveSession | null = null
  private expireTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(event: PairingEvent) => void>()

  /**
   * Called when a session ends for any reason, so the owner can drop the
   * socket it opened. Separate from the event listeners because it is not a
   * notification — it is the other half of `start`, and it has to run exactly
   * once per socket even if nothing is subscribed.
   */
  constructor(private readonly closeSocket: () => Promise<void> | void) {}

  onEvent(handler: (event: PairingEvent) => void): () => void {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  private emit(event: PairingEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  get active(): boolean {
    return this.session !== null
  }

  /**
   * Arm a session for a socket the caller has already opened.
   *
   * Address and port come in rather than being chosen here: the payload has to
   * carry the port the OS actually assigned, which is only knowable after the
   * bind. That ordering is why this is not simply `buildHostPayload` — the
   * caller binds, then arms, then shows the code.
   */
  async start(
    host: string,
    port: number,
    mode: PairMode,
    pairId?: string,
    sessionMs = PAIRING_SESSION_MS,
  ): Promise<PairingPayload> {
    this.clearTimer()
    const { payload, privateKey } = await buildHostPayload(host, port, mode, sessionMs)
    this.session = { privateKey, token: base64ToBytes(payload.token), exp: payload.exp, mode, pairId }
    this.expireTimer = setTimeout(() => void this.expire(), Math.max(0, payload.exp - Date.now()))
    this.emit({ type: 'listening', payload })
    return payload
  }

  /**
   * Give up early. Safe whether or not a session is armed; emits nothing,
   * because the caller asked for this.
   *
   * Closes the socket unconditionally rather than only when a session was
   * armed. The two can disagree: the caller binds before it arms (it has to —
   * the payload carries the assigned port), so a `start` that threw between
   * those two steps leaves a listener up with no session behind it. Tying the
   * close to `session !== null` would leave that socket accepting for the full
   * two minutes with nothing able to answer on it.
   */
  async stop(): Promise<void> {
    this.clearTimer()
    this.session = null
    await this.closeSocket()
  }

  private clearTimer(): void {
    if (this.expireTimer) clearTimeout(this.expireTimer)
    this.expireTimer = null
  }

  private async expire(): Promise<void> {
    if (!this.session) return
    this.clearTimer()
    this.session = null
    this.emit({ type: 'expired' })
    await this.closeSocket()
  }

  /**
   * One `POST /pair` body in, one reply out.
   *
   * `raw` is the request body as text, exactly as it came off the socket —
   * parsing it here rather than in Java means a body that is not JSON produces
   * the same 400 a desktop joiner would get instead of a native-side throw
   * with no HTTP status to carry it.
   *
   * Never throws. The caller is a socket handler with a client waiting on it,
   * and a rejected promise there is a connection that hangs until the joiner's
   * own read timeout — four seconds of "connecting…" and then a message about
   * the network, for what is actually a malformed request.
   */
  async handle(raw: string): Promise<LocalPairingReply> {
    try {
      if (raw.length > MAX_PAIR_BODY) {
        return { status: 413, body: { ok: false, error: 'request body too large' } }
      }

      const session = this.session
      if (!session) {
        return { status: 410, body: { ok: false, error: 'no pairing session is active' } }
      }
      // Before the token is looked at, and against this device's own clock
      // rather than anything the request claims — see `joinPairing`'s header
      // comment on why the joiner is the side trusted to reason about skew.
      if (Date.now() > session.exp) {
        void this.expire()
        return { status: 410, body: { ok: false, error: 'this pairing code has expired' } }
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>
      } catch {
        return { status: 400, body: { ok: false, error: 'body is not valid JSON' } }
      }

      const offered = base64ToBytes(String(body.token ?? ''))
      if (!timingSafeEqualBytes(offered, session.token)) {
        // A wrong token does not tear the session down: a stray probe on the
        // Wi-Fi must not be able to deny service to the device actually
        // holding the code.
        return { status: 401, body: { ok: false, error: 'bad pairing code' } }
      }

      const epk = String(body.epk ?? '')
      if (!epk) {
        return { status: 400, body: { ok: false, error: 'missing public key' } }
      }
      const joinerNow = typeof body.joinerNow === 'number' ? body.joinerNow : Date.now()

      const { result } = await completeHostHandshake(
        session.privateKey,
        session.token,
        session.exp,
        epk,
        session.mode,
        joinerNow,
        session.pairId,
      )

      // The session is finished the moment it is answered — one connection,
      // ever, so a shoulder-surfed code has nothing left to reach. Cleared
      // before the socket closes so a second request racing the close finds no
      // session rather than a live one.
      this.clearTimer()
      this.session = null
      this.emit({ type: 'connected', ongoing: result.ongoing })
      // Not awaited, deliberately: the caller still has to write this reply to
      // the joiner, and making it wait on a round trip to the platform first
      // adds that latency to a joiner already counting down its own read
      // timeout. Closing the *listening* socket cannot affect the connection
      // the reply goes out on, so there is nothing to order here.
      void Promise.resolve(this.closeSocket()).catch(() => {
        // A socket that will not close is not a reason to fail a handshake
        // that already succeeded; the platform's own one-shot rule closes it.
      })
      return { status: 200, body: result }
    } catch (error) {
      return {
        status: 400,
        body: { ok: false, error: error instanceof Error ? error.message : String(error) },
      }
    }
  }
}
