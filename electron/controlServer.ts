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
 * window and wait — see `src/core/sync/control.ts` for why.
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
  auditContext,
  requiredScope,
  scopeRefusal,
  type ControlAuditEntry,
  type ControlEndpoint,
  type ControlOp,
  type ControlRequest,
  type ControlResponse,
} from '../src/core/sync/control'
import type { ControlScope } from '../src/core/types'
import { LOG_CAP_FALLBACK, LOG_CAP_MAX } from '../src/core/ops/logRetention'

export function homeControlDir(): string {
  return path.join(os.homedir(), HOME_CONTROL_DIR)
}

/** A request body larger than this is not a mistake we need to be polite about. */
const MAX_BODY = 2 * 1024 * 1024

export interface ControlHooks {
  /** Hand a request to the renderer and resolve with its answer. */
  execute(request: ControlRequest): Promise<ControlResponse>
  /**
   * Current settings. Read per request so a toggle takes effect immediately.
   *
   * `scopes` is already resolved — `effectiveControlScopes(settings)`, with
   * `send.immediate` folded in from `allowSending` — so nothing on this side
   * of the boundary needs to know that rule exists.
   */
  permissions(): { enabled: boolean; allowSending: boolean; scopes: ControlScope[] }
  /**
   * Durably record what became of one request, granted or refused. Awaited
   * before the caller answers — see `electron/store.ts`'s
   * `appendControlAudit`, which this is expected to call and which never
   * rejects on its own, so a disk hiccup here cannot be the reason a request
   * that actually succeeded gets reported as failed.
   */
  audit(entry: ControlAuditEntry): Promise<void>
  /** Where `control/` and `drop/` live. */
  dataRoot(): string
  log(level: 'info' | 'warn' | 'error', message: string, detail?: string): void
  /**
   * The same days-and-count policy `core/logRetention.ts`'s `pruneLogs`
   * applies to the activity log, reused here for the drop folder's `done/`
   * and `failed/` subfolders — see `pruneDropFolders` below for why that
   * folder needed the same treatment and never got it. Read fresh on every
   * prune pass rather than cached at startup, for the same reason
   * `permissions()` above is: a retention change in Settings should not
   * need Aevistle restarted to take effect.
   */
  retentionPolicy(): Promise<{ days: number; maxEntries: number }>

  // --- calendar subscribe ---------------------------------------------------
  // A second, independent doorway on the same server — see `GET /calendar.ics`
  // in `handle()` for why it is a separate hook rather than folded into
  // `permissions()`'s `enabled`.
  /** Current value of `Settings.calendarSubscribeEnabled`. Read per request. */
  calendarSubscribeEnabled(): boolean
  /**
   * The working calendar as an `.ics` file, or `null` when it could not be
   * built (no window to ask, or the app is between requests at startup).
   * Never the reminders themselves — see the header on `GET /calendar.ics`.
   */
  buildCalendarIcs(): Promise<string | null>
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
  /** Counts ticks of `dropTimer` — see `startDropWatcher` on why pruning rides it at 1/30th the rate. */
  private dropTicks = 0

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
   *
   * Two settings can each keep this server alive on their own — the control
   * interface and calendar subscribe are independent toggles (see
   * `Settings.calendarSubscribeEnabled`) sharing one loopback port, so the
   * server runs whenever *either* one wants it and stops only once *both* are
   * off.
   */
  async apply(): Promise<void> {
    const { enabled } = this.hooks.permissions()
    const shouldRun = enabled || this.hooks.calendarSubscribeEnabled()
    if (shouldRun && !this.server) await this.start()
    else if (!shouldRun && this.server) await this.stop()
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
    this.dropTimer = setInterval(() => {
      void this.drainDrop()
      /*
       * Pruning rides the same timer rather than getting a second one of its
       * own — one more interval is one more thing `dispose()` has to
       * remember to clear, for a job that does not need 2-second resolution.
       * `done/` and `failed/` gain at most one pair of files per *processed*
       * request — rare enough that checking every 2 seconds would mean
       * reading `state.json` (`retentionPolicy()`'s source, and a file that
       * can be large) far more often than either folder could plausibly have
       * changed. Every 30th tick is once a minute: prompt enough that a
       * retention setting takes effect the same session it was changed in,
       * without the file being read on every drop-folder poll.
       */
      this.dropTicks++
      if (this.dropTicks % 30 === 0) void this.pruneDropFolders()
    }, 2_000)
    await this.drainDrop()
    // Once at startup too, unthrottled — otherwise files left over from a
    // session that ended (or crashed) up to a minute before the last prune
    // sit there for up to another minute before the timer above catches them.
    await this.pruneDropFolders()
  }

  /**
   * Apply the log's own retention policy to `done/` and `failed/`.
   *
   * Nothing pruned these before this existed: `drainDrop` only ever adds
   * files to them, so a control interface used daily accumulated one
   * `<timestamp>-<name>` and one `<timestamp>-<name>.result.json` per
   * request forever, unlike the activity log this project already promises a
   * retention policy for. Reusing that exact policy — the same
   * `logRetentionDays`/`logMaxEntries` a user already set, rather than a
   * second pair of settings nobody knew to look for — is the point: one
   * promise ("old records get cleaned up"), kept in two places instead of
   * one.
   */
  private async pruneDropFolders(): Promise<void> {
    const policy = await this.hooks.retentionPolicy()
    const now = Date.now()
    await pruneEntryFolder(path.join(this.dropDir(), 'done'), policy, now)
    await pruneEntryFolder(path.join(this.dropDir(), 'failed'), policy, now)
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
    /*
     * Written to `~/.aevistle` only.
     *
     * It used to be written to the data folder as well, "beside the data it
     * controls". But this file carries the live bearer token, and the data
     * folder is explicitly allowed to be a synced or network location — the
     * documentation for that setting says so. Putting a credential there means
     * OneDrive or Dropbox uploads it, and it stays in that provider's version
     * history long after the token itself has rotated.
     *
     * Nothing is lost: `~/.aevistle` is the fixed location precisely so a
     * caller can find the endpoint without being told where the data folder
     * went, and it was always written here too.
     */
    await fs.mkdir(homeControlDir(), { recursive: true }).catch(() => {})
    await fs
      .writeFile(
        path.join(homeControlDir(), ENDPOINT_FILE),
        JSON.stringify(endpoint, null, 2),
        // Owner-only. Meaningless on most Windows filesystems, honoured
        // everywhere else, and free to ask for.
        { mode: 0o600 },
      )
      .catch(() => {})
    // Any endpoint file an older version left in the data folder is a stale
    // token sitting in a synced directory; clear it rather than leave it.
    await fs.rm(path.join(this.controlDir(), ENDPOINT_FILE), { force: true }).catch(() => {})
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

      /*
       * `GET /calendar.ics` — deliberately unauthenticated. Design decision,
       * not an oversight:
       *
       * The bearer token above exists because `/control` can create reminders
       * and, with sending switched on, send mail — actions worth gating hard.
       * This route only ever reads back `buildCalendarIcs()`, which is the
       * working calendar's holidays and make-up days: the same thing
       * `exportCalendarIcs` already writes to a file with no login on your
       * disk either. Never the reminders — those carry recipients and
       * subjects, which is exactly the sensitive half this route stays away
       * from.
       *
       * More to the point, a token would not *work* here. The whole appeal of
       * "subscribe" is `webcal://127.0.0.1:PORT/calendar.ics` handed to
       * Outlook, Thunderbird or Apple Calendar's own subscribe dialog, which
       * polls it on its own schedule — none of them offer a place to put a
       * custom `Authorization` header, because the convention they all follow
       * has none. Requiring one would just mean the feature does not work
       * with a real calendar app, in exchange for protection an attacker does
       * not need anyway: the port is loopback-only, so reaching it already
       * means code running as the same OS user, who could read the exported
       * file — or the settings themselves — directly.
       *
       * What *does* stand between this and a malicious web page open in a
       * browser tab is the response headers `send()` already sets below:
       * `access-control-allow-origin: null` refuses every origin, so a page's
       * own `fetch()` cannot read the body back even though the request
       * reaches the loopback port. That, the off-by-default setting, and the
       * loopback bind are the three guards this route gets; a bearer token
       * would be a fourth that breaks the one thing the feature is for.
       */
      if (url.pathname === '/calendar.ics' && req.method === 'GET') {
        if (!this.hooks.calendarSubscribeEnabled()) {
          send(404, { ok: false, error: 'calendar subscribe is switched off in Settings' })
          return
        }
        const ics = await this.hooks.buildCalendarIcs()
        res.writeHead(200, {
          'content-type': 'text/calendar; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': 'null',
          'x-content-type-options': 'nosniff',
        })
        res.end(ics ?? '')
        return
      }

      if (req.method !== 'POST' || url.pathname !== '/control') {
        send(404, { ok: false, error: 'POST /control' })
        return
      }
      if (!this.authorised(req)) {
        await this.audit({
          via: 'http',
          op: null,
          scope: null,
          granted: false,
          reason: 'bad or missing bearer token',
        })
        send(401, { ok: false, error: 'bad or missing bearer token' })
        return
      }

      // Its own try/catch, not the outer one: a malformed body is a request
      // that *reached* `/control` authenticated, and belongs in the audit
      // trail the same as any other refusal — the outer catch also covers
      // failures that have nothing to do with a control request at all (a
      // thrown `buildCalendarIcs`, a bad URL), which must not be recorded as
      // one.
      let body: Record<string, unknown>
      try {
        body = await readJson(req)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.audit({ via: 'http', op: null, scope: null, granted: false, reason })
        send(400, { ok: false, error: reason })
        return
      }
      const op = body.op as ControlOp
      if (!OPS.has(op)) {
        const reason = `unknown op: ${String(body.op)}`
        await this.audit({
          via: 'http',
          op: body.op === undefined || body.op === null ? null : String(body.op),
          scope: null,
          granted: false,
          reason,
        })
        send(400, { ok: false, error: reason })
        return
      }

      const refusal = this.refuse(op)
      if (refusal) {
        await this.audit({ via: 'http', op, scope: requiredScope(op), granted: false, reason: refusal })
        send(403, { ok: false, error: refusal })
        return
      }

      const response = await this.hooks.execute({
        id: randomBytes(8).toString('hex'),
        op,
        params: (body.params as Record<string, unknown>) ?? {},
        via: 'http',
      })
      await this.audit({
        via: 'http',
        op,
        scope: requiredScope(op),
        granted: response.ok,
        reason: response.ok ? undefined : response.error,
        context: auditContext(op, response),
      })
      send(response.ok ? 200 : 400, response)
    } catch (error) {
      send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Returns why an operation is not allowed, or null if it is.
   *
   * Scope is checked last and separately from the two switches above it —
   * `enabled`/`allowSending` gate the *doorway*, the scope check gates the
   * *action*, and keeping them as distinct `if`s (rather than folding the
   * scope check into `SENDING_OPS`'s condition) is what lets `runDropped`
   * reuse the exact same `scopeRefusal` call below even though it
   * deliberately does not go through this method — see its own comment on
   * why the doorway checks and the action checks are not the same list.
   */
  private refuse(op: ControlOp): string | null {
    const { enabled, allowSending, scopes } = this.hooks.permissions()
    if (!enabled) return 'the control interface is switched off in Settings'
    if (SENDING_OPS.includes(op) && !allowSending) {
      return 'sending through the control interface is switched off in Settings'
    }
    return scopeRefusal(op, scopes)
  }

  /**
   * Append one durable audit entry. Fire-and-forget from the caller's point of
   * view is deliberately not offered — every call site `await`s this, so the
   * record is on disk before the caller answers the request it describes.
   */
  private audit(entry: {
    via: ControlRequest['via']
    op: string | null
    scope: ControlScope | null
    granted: boolean
    reason?: string
    context?: string
  }): Promise<void> {
    return this.hooks
      .audit({ id: randomBytes(8).toString('hex'), at: Date.now(), ...entry })
      .catch(() => {})
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
    // Set as soon as the body is parseable enough to read `.op` off it, so
    // even a request naming an unrecognised op is audited as what it
    // actually asked for — see `ControlAuditEntry.op`'s doc. Stays `null` for
    // a file that was not valid JSON at all.
    let auditOp: string | null = null

    const finish = async (response: ControlResponse) => {
      // Move first, report after — and report what actually happened, not
      // what the op reported before the move was attempted. This used to
      // write `<done path>.result.json` with `ok:true`, then attempt the
      // rename into `done/` and swallow a failure there with `.catch(() =>
      // {})` — an external script watching `done/*.result.json` would read
      // success while the source file it names was still sitting wherever
      // it had been claimed to, never actually in `done/`.
      let target = claimed
      let effective = response
      if (response.ok) {
        const donePath = path.join(this.dropDir(), 'done', `${Date.now()}-${name}`)
        try {
          await fs.mkdir(path.dirname(donePath), { recursive: true })
          await fs.rename(claimed, donePath)
          target = donePath
        } catch (moveError) {
          effective = {
            ...response,
            ok: false,
            error: `succeeded but could not move into done/: ${
              moveError instanceof Error ? moveError.message : String(moveError)
            }`,
          }
        }
      }
      await fs.writeFile(
        `${target}.result.json`,
        JSON.stringify(effective, null, 2),
        'utf8',
      ).catch((writeError) => {
        this.hooks.log(
          'warn',
          'control.drop.result-write-failed',
          `${name}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        )
      })
      await this.audit({
        via: 'drop',
        op: auditOp,
        scope: auditOp ? requiredScope(auditOp) : null,
        granted: effective.ok,
        reason: effective.ok ? undefined : effective.error,
        context: auditOp ? auditContext(auditOp, effective) : undefined,
      })
      this.hooks.log(
        effective.ok ? 'info' : 'warn',
        effective.ok ? 'control.drop.ok' : 'control.drop.failed',
        `${name}${effective.error ? `: ${effective.error}` : ''}`,
      )
    }

    try {
      const raw = await fs.readFile(claimed, 'utf8')
      const body = JSON.parse(raw) as { op?: string; params?: Record<string, unknown> }
      auditOp = typeof body.op === 'string' ? body.op : null
      const op = body.op as ControlOp
      if (!OPS.has(op)) throw new Error(`unknown op: ${String(body.op)}`)

      // The port's off-switch does not gate the drop folder, but the sending
      // switch — and every other scope — does: it is about the action, not
      // about the doorway. The explicit sending check stays alongside the
      // general scope check rather than being folded into it, the same
      // defense-in-depth `controlExecutor.ts`'s `send_now` case keeps for
      // itself: two independent readers of "is sending actually allowed"
      // agreeing is what makes one of them being wrong someday survivable.
      if (SENDING_OPS.includes(op) && !this.hooks.permissions().allowSending) {
        throw new Error('sending through the control interface is switched off in Settings')
      }
      const refusal = scopeRefusal(op, this.hooks.permissions().scopes)
      if (refusal) throw new Error(refusal)

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

/**
 * The cutoff and cap `core/logRetention.ts`'s `pruneLogs` computes for the
 * activity log, computed the same way here.
 *
 * Not a call to `pruneLogs` itself: that function takes a full `LogEntry[]`
 * (`kind`, `level`, `title`, …), and inventing values for fields a filesystem
 * entry does not have would be forcing a shape onto data that was never a
 * log line to begin with. The arithmetic — an unusable `days`/`maxEntries`
 * falls back rather than being taken literally, `LOG_CAP_MAX` bounds a
 * user-typed cap — is copied from there instead of re-derived, and
 * `LOG_CAP_FALLBACK`/`LOG_CAP_MAX` are imported rather than restated so a
 * later change to either only has to be made in one place to be noticed
 * here too.
 *
 * Exported for a check script the same way `imap.ts`'s `buildClient` is —
 * this and `pruneEntryFolder` below are the only two functions in this file
 * with no I/O side effects, and them being unreachable from `ControlServer`
 * itself is what makes an automated check for "old entries actually get
 * deleted" worth writing.
 */
export function retentionCutoffAndCap(
  policy: { days: number; maxEntries: number },
  now: number,
): { cutoff: number; cap: number } {
  const days = Number(policy.days)
  const max = Number(policy.maxEntries)
  const cutoff = Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : -Infinity
  const cap =
    Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), LOG_CAP_MAX) : LOG_CAP_FALLBACK
  return { cutoff, cap }
}

/**
 * Apply the retention policy to one of `done/`/`failed/`.
 *
 * A processed request leaves two files behind in the same directory — the
 * moved request, named `<timestamp>-<original name>`, and its
 * `<timestamp>-<original name>.result.json` — so this treats the pair as one
 * dated entry (`at` read back off the filename's own timestamp prefix, the
 * same value `Date.now()` wrote into it in `runDropped`'s `finish`) and
 * removes both together. Deleting only the primary file would have left an
 * orphaned `.result.json` for an external script to trip over; deleting only
 * the result would have left a request with no record of what happened to
 * it, which is the one thing this whole mechanism exists to preserve.
 *
 * Anything whose name does not start with a parseable timestamp is left
 * alone rather than guessed at — this folder is also where a human might
 * drop something by hand while poking around, and a prune pass is not the
 * place to decide that is safe to delete.
 */
export async function pruneEntryFolder(
  dir: string,
  policy: { days: number; maxEntries: number },
  now: number,
): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const entries: Array<{ primary: string; at: number }> = []
  for (const name of names) {
    if (name.endsWith('.result.json')) continue // the primary file's pair, handled alongside it
    const at = Number(name.split('-', 1)[0])
    if (!Number.isFinite(at)) continue
    entries.push({ primary: name, at })
  }
  // Newest first, matching `pruneLogs`'s own assumption about the order it
  // is handed — the cap below keeps the *first* `cap` entries after this.
  entries.sort((a, b) => b.at - a.at)

  const { cutoff, cap } = retentionCutoffAndCap(policy, now)
  const keep = new Set(
    entries
      .filter((entry) => entry.at >= cutoff)
      .slice(0, cap)
      .map((entry) => entry.primary),
  )

  for (const entry of entries) {
    if (keep.has(entry.primary)) continue
    await fs.rm(path.join(dir, entry.primary), { force: true }).catch(() => {})
    await fs.rm(path.join(dir, `${entry.primary}.result.json`), { force: true }).catch(() => {})
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
