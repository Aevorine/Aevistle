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
} from '../src/core/sync/pairing'
import { base64ToBytes } from '../src/core/sync/pairingCrypto'

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
  async start(mode: PairMode, pairId?: string, hostOverride?: string): Promise<PairingPayload> {
    await this.stop()

    const available = listLanIPv4()
    // An override is honoured only if this machine actually holds that address.
    // Anything else would hand the renderer a `server.listen(0, <arbitrary>)`,
    // and the interesting failure is not a bad literal — it is a hostname that
    // resolves somewhere, which is a bind attempt aimed by whatever answered
    // DNS. The list is the allowlist, and it is one this process built itself.
    const host = hostOverride && available.includes(hostOverride) ? hostOverride : available[0]
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
 * Interface names that are almost never the way a phone reaches this machine.
 *
 * Virtual adapters — VPN and proxy tunnels, hypervisor host-only networks,
 * container bridges — hold ordinary-looking private addresses on interfaces
 * that route nowhere near the Wi-Fi the other device is on. `os
 * .networkInterfaces()` reports every one of them as `internal: false`,
 * because to the kernel they are as real as the Wi-Fi card.
 *
 * Matched case-insensitively against the interface name, as a substring, and
 * kept deliberately broad: the cost of demoting a real interface is that it
 * sorts below another real interface, while the cost of *not* demoting a
 * virtual one is a pairing that cannot work and says nothing about why.
 */
const VIRTUAL_INTERFACE_HINTS = [
  'tun',
  'tap',
  'wsl',
  'vethernet',
  'docker',
  'vmware',
  'vmnet',
  'virtualbox',
  'vbox',
  'hyper-v',
  'loopback',
  'bluetooth',
  'teredo',
  'isatap',
  'zerotier',
  'tailscale',
  'wireguard',
  'openvpn',
  // The Chinese Windows names for the same things — this app ships in six
  // languages and the interface list comes from the OS, not from us.
  '蓝牙',
  '虚拟',
]

/** Lower sorts first. See `rankAddress`. */
function subnetRank(address: string): number {
  // 192.168/16 is what home and small-office routers hand out, and it is the
  // one range container runtimes and hypervisors stay out of by convention.
  if (address.startsWith('192.168.')) return 0
  // 10/8 is the other genuinely common LAN range — larger sites, and most
  // phone hotspots.
  if (address.startsWith('10.')) return 1
  const [a, b] = address.split('.', 2).map((n) => Number.parseInt(n, 10))
  // 172.16/12 is a real private range *and* Docker's default pool
  // (172.17–172.31). Real, so not excluded; overwhelmingly virtual in
  // practice, so it loses to anything above.
  if (a === 172 && b >= 16 && b <= 31) return 2
  return 3
}

/**
 * Every candidate address this machine might be reachable at, best first.
 *
 * This used to be "the first non-internal IPv4 wins", on the reasoning that a
 * machine on one LAN has exactly one such interface up. That reasoning does
 * not survive contact with a real desktop. A machine reporting *eighteen*
 * IPv4 addresses is not unusual: one Wi-Fi, one VPN tunnel, two hypervisor
 * host-only networks, and fourteen `169.254.x.x` stubs from adapters that
 * never got a DHCP lease. The first one the OS happened to list won, and the
 * QR code published it.
 *
 * The failure that produced was silent on the desktop and unreadable on the
 * phone: `failed to connect to /172.18.0.1 (port 10897) from
 * /192.168.1.42 (port 34478) after 4000ms` — a proxy tunnel's address, from
 * a phone one subnet away, with nothing anywhere saying which interface had
 * been chosen or that there had been a choice at all.
 *
 * So: exclude what cannot work, rank what is left, and return all of it.
 *
 *   - `169.254.0.0/16` is dropped outright. It is what Windows assigns when
 *     DHCP fails, it is per-link and unroutable, and a machine with a working
 *     network never needs to be reached at one.
 *   - Interfaces whose names look virtual sort last rather than being dropped,
 *     because someone genuinely pairing across a VPN should still be offered
 *     the address — just not handed it ahead of their Wi-Fi.
 *   - Among equals, the subnet decides, then the address itself, so the answer
 *     is stable across calls. An order that shifted between the QR code and
 *     the sync listener would pair on one address and then sync on another.
 *
 * The caller publishes `[0]` and shows the rest, so a wrong guess is now
 * something the user can see and correct instead of a timeout.
 */
export function listLanIPv4(): string[] {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ address: string; virtual: boolean }> = []

  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase()
    const virtual = VIRTUAL_INTERFACE_HINTS.some((hint) => lower.includes(hint))
    for (const info of interfaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      // Link-local: DHCP failed on this adapter. Not a route to anywhere.
      if (info.address.startsWith('169.254.')) continue
      candidates.push({ address: info.address, virtual })
    }
  }

  return candidates
    .sort(
      (a, b) =>
        Number(a.virtual) - Number(b.virtual) ||
        subnetRank(a.address) - subnetRank(b.address) ||
        a.address.localeCompare(b.address),
    )
    .map((c) => c.address)
}

/**
 * The single best address, or null when this machine is not on a network.
 *
 * Exported for `syncServer.ts`, which needs the exact same "which interface is
 * this device reachable on" answer for its own, longer-lived listener — and
 * needs it to agree with what pairing published, which is why both read one
 * ordering rather than each picking for themselves.
 */
export function pickLanIPv4(): string | null {
  return listLanIPv4()[0] ?? null
}
