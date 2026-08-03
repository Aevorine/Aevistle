/**
 * The outside edge of the control protocol: a loopback HTTP server and a
 * watched drop folder.
 *
 * Two ways in, because they fail in opposite directions. HTTP is immediate and
 * gives you an answer, but only while Aevistle is running. A JSON file dropped
 * in a folder is answered whenever the app next starts, which is what you want
 * from a script that fires at 3am on a laptop that was asleep.
 *
 * Neither of them touches application state. Both hand the request to the
 * window and wait — see `src/core/control.ts` for why.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CONTROL_DIR,
  DROP_DIR,
  ENDPOINT_FILE,
  HOME_CONTROL_DIR,
  SENDING_OPS,
  WRITING_OPS,
  type ControlEndpoint,
  type ControlOp,
  type ControlRequest,
  type ControlResponse,
} from '../src/core/control'

export function homeControlDir(): string {
  return path.join(os.homedir(), HOME_CONTROL_DIR)
}

/** A request body larger than this is not a mistake we need to be polite about. */
const MAX_BODY = 2 * 1024 * 1024

export interface ControlHooks {
  /** Hand a request to the renderer and resolve with its answer. */
  execute(request: ControlRequest): Promise<ControlResponse>
  /** Current settings. Read per request so a toggle takes effect immediately. */
  permissions(): { enabled: boolean; allowSending: boolean }
  /** Where `control/` and `drop/` live. */
  dataRoot(): string
  log(level: 'info' | 'warn' | 'error', message: string, detail?: string): void
}

const OPS = new Set<ControlOp>([
  'status',
  'list_jobs',
  'create_reminder',
  'cancel_job',
  'toggle_job',
  'send_now',
  'list_logs',
  'list_contacts',
  'list_templates',
  'list_inbox',
])

export class ControlServer {
  private server: Server | null = null
  private token = ''
  private dropTimer: NodeJS.Timeout | null = null
  private draining = false

  constructor(private readonly hooks: ControlHooks) {}

  private controlDir(): string {
    return path.join(this.hooks.dataRoot(), CONTROL_DIR)
  }

  dropDir(): string {
    return path.join(this.hooks.dataRoot(), DROP_DIR)
  }

  /**
   * Start or stop to match the current settings. Safe to call repeatedly — the
   * settings screen calls it on every change.
   */
  async apply(): Promise<void> {
    const { enabled } = this.hooks.permissions()
    if (enabled && !this.server) await this.start()
    else if (!enabled && this.server) await this.stop()
  }

  /**
   * The drop folder is watched even when the HTTP server is off: dropping a
   * file is a local filesystem action by someone who already has the user's
   * privileges, so it grants nothing the port does. It is the fallback that
   * works when the app was not running, which is most of the time.
   */
  async startDropWatcher(): Promise<void> {
    await fs.mkdir(this.dropDir(), { recursive: true }).catch(() => {})
    await fs.mkdir(path.join(this.dropDir(), 'done'), { recursive: true }).catch(() => {})
    await fs.mkdir(path.join(this.dropDir(), 'failed'), { recursive: true }).catch(() => {})
    // Polling rather than fs.watch: watchers are unreliable across network
    // shares and synced folders, and the data folder is explicitly allowed to
    // be either. Two seconds is well inside "I dropped a file, did it work?".
    this.dropTimer = setInterval(() => void this.drainDrop(), 2_000)
    await this.drainDrop()
  }

  private async start(): Promise<void> {
    this.token = randomBytes(32).toString('hex')
    const server = createServer((req, res) => void this.handle(req, res))

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // Port 0: the OS picks a free one and we publish it. A fixed port would
      // collide with whatever else the user runs and would be guessable.
      server.listen(0, '127.0.0.1', () => resolve())
    })

    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const endpoint: ControlEndpoint = {
      port,
      token: this.token,
      dropDir: this.dropDir(),
      pid: process.pid,
      startedAt: Date.now(),
    }
    // Written twice: once beside the data it controls, and once at the fixed
    // `~/.aevistle` a caller can find without being told where the data folder
    // was moved to.
    for (const dir of [this.controlDir(), homeControlDir()]) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {})
      await fs
        .writeFile(
          path.join(dir, ENDPOINT_FILE),
          JSON.stringify(endpoint, null, 2),
          // Owner-only. Meaningless on most Windows filesystems, honoured
          // everywhere else, and free to ask for.
          { mode: 0o600 },
        )
        .catch(() => {})
    }
    this.hooks.log('info', 'control.started', `127.0.0.1:${port}`)
  }

  private async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.token = ''
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const dir of [this.controlDir(), homeControlDir()]) {
      await fs.rm(path.join(dir, ENDPOINT_FILE), { force: true }).catch(() => {})
    }
    this.hooks.log('info', 'control.stopped')
  }

  async dispose(): Promise<void> {
    if (this.dropTimer) clearInterval(this.dropTimer)
    this.dropTimer = null
    await this.stop()
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? ''
    const offered = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!offered || !this.token) return false
    const a = Buffer.from(offered)
    const b = Buffer.from(this.token)
    // Length has to be checked separately; timingSafeEqual throws on a
    // mismatch, and throwing on the first wrong byte is the leak it exists to
    // prevent.
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // Nothing here is meant for a browser page to read.
        'access-control-allow-origin': 'null',
        'x-content-type-options': 'nosniff',
      })
      res.end(text)
    }

    try {
      // A page on any origin can POST here without a preflight, so the token
      // is the only thing standing between a visited web page and this API.
      // Refusing browser-shaped requests outright costs nothing and removes
      // the class entirely.
      if (req.headers.origin || req.headers.referer) {
        send(403, { ok: false, error: 'browser origins are not accepted' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/health' && req.method === 'GET') {
        send(200, { ok: true, app: 'aevistle' })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/control') {
        send(404, { ok: false, error: 'POST /control' })
        return
      }
      if (!this.authorised(req)) {
        send(401, { ok: false, error: 'bad or missing bearer token' })
        return
      }

      const body = await readJson(req)
      const op = body.op as ControlOp
      if (!OPS.has(op)) {
        send(400, { ok: false, error: `unknown op: ${String(body.op)}` })
        return
      }

      const refusal = this.refuse(op)
      if (refusal) {
        send(403, { ok: false, error: refusal })
        return
      }

      const response = await this.hooks.execute({
        id: randomBytes(8).toString('hex'),
        op,
        params: (body.params as Record<string, unknown>) ?? {},
        via: 'http',
      })
      send(response.ok ? 200 : 400, response)
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Returns why an operation is not allowed, or null if it is. */
  private refuse(op: ControlOp): string | null {
    const { enabled, allowSending } = this.hooks.permissions()
    if (!enabled) return 'the control interface is switched off in Settings'
    if (SENDING_OPS.includes(op) && !allowSending) {
      return 'sending through the control interface is switched off in Settings'
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Drop folder
  // -------------------------------------------------------------------------

  private async drainDrop(): Promise<void> {
    // One pass at a time. A slow send must not have the next tick start the
    // same file again and schedule the reminder twice.
    if (this.draining) return
    this.draining = true
    try {
      const dir = this.dropDir()
      const names = await fs.readdir(dir).catch(() => [] as string[])
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.json')) continue
        const source = path.join(dir, name)
        // Claim the file by renaming it before doing anything with it: if the
        // app is killed mid-request the file is in `failed/` rather than back
        // in the queue to be run a second time.
        const claimed = path.join(dir, 'failed', `${Date.now()}-${name}`)
        try {
          await fs.rename(source, claimed)
        } catch {
          continue // someone else got it, or it is still being written
        }
        await this.runDropped(claimed, name)
      }
    } finally {
      this.draining = false
    }
  }

  private async runDropped(claimed: string, name: string): Promise<void> {
    const finish = async (response: ControlResponse) => {
      const target = response.ok
        ? path.join(this.dropDir(), 'done', `${Date.now()}-${name}`)
        : claimed
      await fs.writeFile(
        `${target}.result.json`,
        JSON.stringify(response, null, 2),
        'utf8',
      ).catch(() => {})
      if (response.ok) await fs.rename(claimed, target).catch(() => {})
      this.hooks.log(
        response.ok ? 'info' : 'warn',
        response.ok ? 'control.drop.ok' : 'control.drop.failed',
        `${name}${response.error ? `: ${response.error}` : ''}`,
      )
    }

    try {
      const raw = await fs.readFile(claimed, 'utf8')
      const body = JSON.parse(raw) as { op?: string; params?: Record<string, unknown> }
      const op = body.op as ControlOp
      if (!OPS.has(op)) throw new Error(`unknown op: ${String(body.op)}`)

      // The port's off-switch does not gate the drop folder, but the sending
      // switch does: it is about the action, not about the doorway.
      if (SENDING_OPS.includes(op) && !this.hooks.permissions().allowSending) {
        throw new Error('sending through the control interface is switched off in Settings')
      }

      const response = await this.hooks.execute({
        id: randomBytes(8).toString('hex'),
        op,
        params: body.params ?? {},
        via: 'drop',
      })
      await finish(response)
    } catch (error) {
      await finish({
        id: name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
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

/** Exported for the settings screen, which shows what a caller has to do. */
export { WRITING_OPS }
