/**
 * The accepting side of ongoing sync — a `node:http` server that, unlike
 * `pairingServer.ts`'s ~2-minute handshake, lives as long as this machine has
 * a device it has agreed to keep in sync with.
 *
 * Not the app's whole run, which is what it used to be. Binding a LAN
 * interface is what makes Windows raise its elevated firewall prompt, and
 * doing that on a cold first launch asks an app sold as "offline-first, no
 * server" to justify a network permission before the user has opted into
 * anything — and if they answer Cancel, Windows writes a permanent block rule
 * for a feature they had not yet heard of. So `apply()` below is driven by
 * state: the listener comes up when an 'ongoing' pairing exists and goes back
 * down when the last one is revoked.
 *
 * Bound to a fixed, well-known port (`core/syncLoop.ts`'s `SYNC_SERVER_PORT`)
 * rather than an OS-assigned one, for the reason spelled out on that
 * constant: an ongoing pair has to find this listener again next week, after
 * both apps have restarted, with no discovery protocol to relearn a port
 * that moved. The port is not a secret; the long-lived AES-GCM key
 * exchanged at pairing time is what actually authenticates a request — this
 * server never even sees that key.
 *
 * Genuinely dumb, on purpose, the same as `controlServer.ts`: it does not
 * decrypt anything, does not touch application state, and does not know
 * which paired device a request is really from beyond the `pairId` it
 * declares. Every request is hedged on the renderer, which holds the actual
 * keys, the actual state, and the one reducer allowed to change either —
 * `execute()` below is the same "hand it to the window and wait" shape
 * `ControlServer` already uses.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  SYNC_SERVER_PORT,
  type SyncListenerError,
  type SyncListenerStatus,
  type SyncServerRequest,
  type SyncServerResponse,
} from '../src/core/syncLoop'
import { pickLanIPv4 } from './pairingServer'

const MAX_BODY = 512 * 1024

export interface SyncServerHooks {
  log(level: 'info' | 'warn' | 'error', message: string, detail?: string): void
  /** Cheap rejection of a request naming a device this machine has never heard of, without waking the renderer for it. */
  hasDevice(pairId: string): Promise<boolean>
  /** Hand the request to the renderer and resolve with its answer, or `null` if no window is available to ask. */
  execute(request: SyncServerRequest): Promise<SyncServerResponse | null>
}

export class SyncServer {
  private server: Server | null = null
  private lastStatus: SyncListenerStatus = { listening: false }

  constructor(private readonly hooks: SyncServerHooks) {}

  /**
   * Bring the listener up or down to match whether this machine has anything
   * to answer for. Safe to call repeatedly — the renderer calls it every time
   * the paired-device list changes.
   */
  async apply(enabled: boolean): Promise<SyncListenerStatus> {
    if (enabled) return this.start()
    await this.stop()
    return this.lastStatus
  }

  /** Fails soft: no LAN interface just means this device answers no sync requests until one appears — not a reason to block the rest of startup. */
  async start(): Promise<SyncListenerStatus> {
    if (this.server) return this.lastStatus
    const host = pickLanIPv4()
    if (!host) {
      this.hooks.log('warn', 'sync.noNetwork')
      return this.settle({ listening: false, error: 'noNetwork' })
    }

    const server = createServer((req, res) => void this.handle(req, res))
    const failure = await new Promise<Error | null>((resolve) => {
      const onError = (err: Error) => resolve(err)
      server.once('error', onError)
      server.listen(SYNC_SERVER_PORT, host, () => {
        server.off('error', onError)
        resolve(null)
      })
    })

    if (failure) {
      // A socket that never reached 'listening' still holds a handle; closing
      // it reports its own error, which is the one already being handled.
      server.close(() => {})
      const detail = failure.message
      this.hooks.log('warn', 'sync.listenFailed', detail)
      return this.settle({ listening: false, error: listenErrorKind(failure), detail })
    }

    this.server = server
    this.hooks.log('info', 'sync.started', `${host}:${SYNC_SERVER_PORT}`)
    return this.settle({ listening: true, address: `${host}:${SYNC_SERVER_PORT}` })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.lastStatus = { listening: false }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private settle(status: SyncListenerStatus): SyncListenerStatus {
    this.lastStatus = status
    return status
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
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
      const url = new URL(req.url ?? '/', 'http://sync.local')
      if (req.method !== 'POST' || url.pathname !== '/sync') {
        send(404, { ok: false, error: 'POST /sync' })
        return
      }

      const body = await readJson(req, MAX_BODY)
      const pairId = String(body.pairId ?? '')
      const envelope = body.envelope as { iv?: unknown; ciphertext?: unknown } | undefined
      if (!pairId || !envelope || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
        send(400, { ok: false, error: 'malformed sync request' })
        return
      }
      if (!(await this.hooks.hasDevice(pairId))) {
        send(404, { ok: false, error: 'unknown device' })
        return
      }

      const request: SyncServerRequest = {
        id: randomUUID(),
        pairId,
        envelope: { iv: envelope.iv, ciphertext: envelope.ciphertext },
      }
      const response = await this.hooks.execute(request)
      if (!response) {
        send(503, { ok: false, error: 'Aevistle is not ready to answer right now' })
        return
      }
      send(response.ok ? 200 : 400, response)
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function listenErrorKind(error: Error): SyncListenerError {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') return 'portInUse'
  if (code === 'EACCES' || code === 'EPERM') return 'blocked'
  return 'failed'
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
