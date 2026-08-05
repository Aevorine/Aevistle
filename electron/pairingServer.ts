/**
 * The HOST half of LAN device pairing — a `node:http` server bound to the
 * machine's LAN interface rather than loopback, mirroring the shape of
 * `controlServer.ts` but for a very different lifetime: this one lives for a
 * single ~2-minute pairing attempt, not the app's whole run.
 *
 * Bound to a real interface, not `127.0.0.1`, because the whole point is for
 * another device to reach it. Windows will show its usual one-time firewall
 * prompt the first time this listens — expected, not a bug, and the settings
 * screen says so.
 *
 * One connection, ever: the moment a request carrying the right token is
 * answered, the listener closes. A screenshotted or shoulder-surfed QR code is
 * useless a moment later because there is no socket left for it to reach — see
 * `handle()`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import {
  buildHostPayload,
  completeHostHandshake,
  PAIRING_SESSION_MS,
  type PairingEvent,
  type PairingPayload,
  type PairMode,
} from '../src/core/pairing'
import { base64ToBytes } from '../src/core/pairingCrypto'

/** A handshake body is a token and a raw P-256 public key — nowhere near this. */
const MAX_BODY = 64 * 1024

export interface PairingHooks {
  log(level: 'info' | 'warn' | 'error', message: string, detail?: string): void
}

interface ActiveSession {
  privateKey: CryptoKey
  token: Uint8Array
  exp: number
  mode: PairMode
  /** Only set for `mode === 'ongoing'` — see `core/pairing.ts`'s `completeHostHandshake`. */
  pairId?: string
}

export class PairingServer {
  private server: Server | null = null
  private expireTimer: ReturnType<typeof setTimeout> | null = null
  private session: ActiveSession | null = null
  private readonly listeners = new Set<(event: PairingEvent) => void>()

  constructor(private readonly hooks: PairingHooks) {}

  onEvent(handler: (event: PairingEvent) => void): () => void {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  private emit(event: PairingEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /**
   * Starting a session cancels whatever attempt was already in flight — the
   * screen only ever shows one QR code at a time.
   *
   * `pairId` is only meaningful when `mode === 'ongoing'`, and the caller
   * (the Settings screen) always supplies one: the existing
   * `PairedDevice.id` when `devices.regenerate` is re-running the handshake
   * with a device already known, or a freshly minted id for a first-time
   * pairing — see `core/pairing.ts`.
   */
  async start(mode: PairMode, pairId?: string): Promise<PairingPayload> {
    await this.stop()

    const host = pickLanIPv4()
    if (!host) {
      throw new Error('No network is available to pair over — connect to Wi-Fi or a LAN first.')
    }

    const { payload, privateKey } = await buildHostPayload(host, 0, mode, PAIRING_SESSION_MS)
    const server = createServer((req, res) => void this.handle(req, res))

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      // Port 0: the OS assigns one, published only in the QR code. A fixed
      // port would collide with whatever else is running and would be
      // guessable without ever scanning anything.
      server.listen(0, host, () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    payload.port = port
    this.server = server
    this.session = { privateKey, token: base64ToBytes(payload.token), exp: payload.exp, mode, pairId }
    this.expireTimer = setTimeout(() => void this.onExpire(), Math.max(0, payload.exp - Date.now()))
    this.hooks.log('info', 'pairing.started', `${host}:${port}`)
    this.emit({ type: 'listening', payload })
    return payload
  }

  /** Stops the listener, if any. Safe to call whether or not a session is running. */
  async stop(): Promise<void> {
    if (this.expireTimer) clearTimeout(this.expireTimer)
    this.expireTimer = null
    this.session = null
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async onExpire(): Promise<void> {
    if (!this.server) return
    this.hooks.log('info', 'pairing.expired')
    this.emit({ type: 'expired' })
    await this.stop()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // Nothing here is meant for a browser tab to read — same posture as
        // `controlServer.ts`.
        'access-control-allow-origin': 'null',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(body))
    }

    try {
      if (req.headers.origin || req.headers.referer) {
        send(403, { ok: false, error: 'browser origins are not accepted' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://pairing.local')
      if (req.method !== 'POST' || url.pathname !== '/pair') {
        send(404, { ok: false, error: 'POST /pair' })
        return
      }

      const session = this.session
      if (!session) {
        send(410, { ok: false, error: 'no pairing session is active' })
        return
      }
      // Checked before the token is even looked at, and against this
      // process's own clock rather than anything the request claims — see
      // `joinPairing`'s header comment on why the joiner is trusted to reason
      // about skew instead.
      if (Date.now() > session.exp) {
        send(410, { ok: false, error: 'this pairing code has expired' })
        void this.onExpire()
        return
      }

      const body = await readJson(req, MAX_BODY)
      const offeredToken = base64ToBytes(String(body.token ?? ''))
      if (!timingSafeEqualBytes(offeredToken, session.token)) {
        // Wrong token does not tear the session down — a stray probe should
        // not be able to deny service to the device actually holding the code.
        send(401, { ok: false, error: 'bad pairing code' })
        return
      }

      const epk = String(body.epk ?? '')
      if (!epk) {
        send(400, { ok: false, error: 'missing public key' })
        return
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
      send(200, result)
      this.emit({ type: 'connected', ongoing: result.ongoing })
      await this.stop()
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function readJson(req: IncomingMessage, maxBody: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBody) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Every non-internal IPv4 interface, first one wins. A machine tethered to a
 * phone hotspot or plugged into one LAN typically has exactly one such
 * interface up, and the chosen address is shown to the user (as the `host` in
 * the payload) so a multi-homed machine that guessed wrong is visible, not
 * silently unreachable.
 */
/** Exported for `syncServer.ts`, which needs the exact same "which interface is this device reachable on" answer for its own, longer-lived listener. */
export function pickLanIPv4(): string | null {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return null
}
