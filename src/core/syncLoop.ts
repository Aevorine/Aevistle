/**
 * Ongoing sync — the periodic, silent cousin of a live pairing session.
 *
 * A `'once'` pairing (`core/pairing.ts`) is a single exchange over a session
 * key that is thrown away the moment it ends. `'ongoing'` keeps the device
 * (`core/pairedDevices.ts`) and a long-lived key, and this file is what uses
 * them afterwards: while the app is open, retry the device's last-known LAN
 * address every so often, exchange whatever changed since the last time, and
 * quietly do nothing when it cannot be reached.
 *
 * **No push, no relay, no discovery.** This app has no server. A cycle that
 * cannot reach the address it has is not queued, not retried on a schedule of
 * its own, not escalated — it is skipped, and the next timer tick tries
 * again. On Android that also means: sync only happens while both apps are
 * open at the same time. There is no persistent background service in this
 * app beyond `AlarmManager` firing scheduled sends (see `AlarmReceiver.java`
 * /`BootReceiver.java`) — nothing wakes the app to poll on its own, and
 * `SyncLoop` does not pretend otherwise. The Settings screen says the same
 * thing in plain language; see `devices.ongoingHint`.
 *
 * **Only additive.** A sync cycle merges records forward — `backup.ts`'s
 * `mergeById`, later `updatedAt` wins, ties broken by `core/syncConflict.ts`
 * — the same rule an ordinary backup restore already uses. Nothing here
 * deletes a record because the other side no longer has it: that would make
 * "uninstall the app on your phone" delete every contact on your desktop the
 * next time they happened to be open together, which is not what anyone
 * pairing two devices is asking for.
 *
 * **Symmetry.** The wire payload (`SyncExchangePayload`) is the same shape in
 * both directions: "since when, and what changed since then". The device
 * that reaches out (`SyncLoop.runCycle`, driven by a timer) and the device
 * that answers (`respondToSyncRequest`, driven by `electron/syncServer.ts`
 * handing it a request over IPC) run the identical `performExchange` on
 * their own state. Only Electron main can hold a LAN socket open to *answer*
 * a request — see `electron/syncServer.ts` — but *asking* only needs
 * `SyncTransport.postJson`, which every platform already has a working
 * implementation of via `pairingJoinRequest`'s sibling, `syncRequest`.
 */

import { accountFields, appearanceSettings, mergeById, type AppearanceSettings } from './backup'
import {
  importLongLivedKey,
  openWithRandomIv,
  sealWithRandomIv,
  type PairingEnvelope,
} from './pairingCrypto'
import type { PairedDevice } from './pairedDevices'
import {
  conflictSummary as _conflictSummary,
  detectConflicts,
  resolveConflicts,
  type ConflictSnapshot,
} from './syncConflict'
import { SYNC_SCOPE_KEYS, type HashableKind, type ScopePayload, type SyncScopeKey } from './syncScope'
import type { AppState, Contact, MailAccount, ScheduledJob, Template } from './types'
import type { WorkCalendar } from './workCalendar'

export { _conflictSummary as conflictSummary }

/**
 * Fixed rather than OS-assigned (unlike `pairingServer.ts`'s ephemeral port
 * for the ~2-minute handshake). A one-shot session hands its port to the QR
 * code and never needs it again; an ongoing sync has to find the same
 * listener next week, after both apps have restarted, with no discovery
 * protocol to relearn it. A well-known constant is the entire mechanism — the
 * key exchanged at pairing time is what actually authenticates a request,
 * exactly as it would be at any other port.
 */
export const SYNC_SERVER_PORT = 48793

/** How often a running `SyncLoop` retries its paired devices. Not configurable — see the module doc on why a missed cycle is never a problem worth a setting. */
export const SYNC_POLL_INTERVAL_MS = 90_000

export function syncUrl(host: string, port = SYNC_SERVER_PORT): string {
  return `http://${host}:${port}/sync`
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface SyncTransport {
  postJson(url: string, body: unknown): Promise<unknown>
}

/** Symmetric — see the module doc. `since` is the sender's own clock, for the receiver's records only (never compared to the receiver's own clock; see `applyExchange`'s `clockOffsetMs` parameter). */
export interface SyncExchangePayload {
  since: number
  changed: ScopePayload
}

/** What crosses the relay in `electron/syncServer.ts` — main process never sees the plaintext, only this envelope and the `pairId` that says which key answers it. */
export interface SyncServerRequest {
  id: string
  pairId: string
  envelope: PairingEnvelope
}

export interface SyncServerResponse {
  id: string
  ok: boolean
  envelope?: PairingEnvelope
  error?: string
}

/**
 * Why the accepting side is not listening, in terms a settings screen can put
 * into a sentence.
 *
 * `'blocked'` covers only what `listen` itself refuses (`EACCES`/`EPERM`).
 * Windows Firewall's "Cancel" writes a rule that *drops inbound packets*
 * rather than failing the bind, so a listener the firewall is quietly
 * swallowing still reports `listening: true` — nothing in this process can
 * tell that apart from "nobody has tried to sync yet". That is why the
 * blocked copy is also offered as advice next to a listener that came up but
 * never hears from anyone.
 */
export type SyncListenerError = 'noNetwork' | 'portInUse' | 'blocked' | 'failed'

export interface SyncListenerStatus {
  listening: boolean
  /** `host:port` this device is reachable at — only set while `listening`. */
  address?: string
  error?: SyncListenerError
  /** The OS's own words, for the activity log rather than the screen. */
  detail?: string
}

// ---------------------------------------------------------------------------
// Building what changed
// ---------------------------------------------------------------------------

function changedSince<T extends { updatedAt?: number }>(records: readonly T[], sinceLocal: number): T[] {
  return records.filter((r) => (r.updatedAt ?? 0) > sinceLocal)
}

/**
 * The outgoing half of a cycle: everything in the device's agreed scopes that
 * changed after `sinceLocal` (this device's own clock — `device.lastSyncedAt`,
 * or 0 the first time). Reuses `accountFields`/`appearanceSettings` from
 * `backup.ts`, the same "safe to hand to another device" shaping
 * `core/syncScope.ts`'s live-session payload already uses — see that file's
 * doc for why 'accounts' here never carries a password: an ongoing sync is a
 * background poll, not a moment someone is watching, so smuggling a secret
 * across it would be silent in exactly the way this app tries never to be.
 */
export function buildChangedPayload(
  state: AppState,
  calendar: WorkCalendar,
  scopes: readonly SyncScopeKey[],
  sinceLocal: number,
): ScopePayload {
  const want = new Set(scopes)
  const payload: ScopePayload = {}

  if (want.has('accounts')) {
    const changed = changedSince(state.accounts, sinceLocal)
    if (changed.length > 0) payload.accounts = accountFields(changed)
  }
  if (want.has('schedule')) {
    const jobs = changedSince(state.jobs, sinceLocal)
    if (jobs.length > 0) payload.schedule = { jobs, workCalendar: calendar }
  }
  if (want.has('contacts')) {
    const changed = changedSince(state.contacts, sinceLocal)
    if (changed.length > 0) payload.contacts = changed
  }
  if (want.has('templates')) {
    const changed = changedSince(state.templates, sinceLocal)
    if (changed.length > 0) payload.templates = changed
  }
  if (want.has('appearance')) {
    // Settings carry no per-field `updatedAt`, so appearance travels whole
    // every cycle rather than being diffed — small enough that this costs
    // nothing, and "match my theme" is meant to converge, not merge.
    payload.appearance = appearanceSettings(state.settings)
  }

  return payload
}

// ---------------------------------------------------------------------------
// Applying what changed
// ---------------------------------------------------------------------------

export interface SyncApplyPatch {
  accounts?: MailAccount[]
  jobs?: ScheduledJob[]
  workCalendar?: WorkCalendar
  contacts?: Contact[]
  templates?: Template[]
  appearance?: AppearanceSettings
}

export interface ExchangeOutcome {
  patch: SyncApplyPatch
  conflicts: ConflictSnapshot[]
}

async function reconcileArray<T extends { id: string; updatedAt?: number }>(
  kind: HashableKind,
  local: readonly T[],
  incomingChanged: readonly T[] | undefined,
  sinceLocal: number,
  sessionId: string,
  clockOffsetMs: number,
): Promise<{ merged: T[] | undefined; conflicts: ConflictSnapshot[] }> {
  if (!incomingChanged || incomingChanged.length === 0) return { merged: undefined, conflicts: [] }

  const mineChanged = changedSince(local, sinceLocal)
  const conflicts = await detectConflicts<T>(kind, mineChanged, incomingChanged)
  const conflictIds = new Set(conflicts.map((c) => c.id))
  const { winners, snapshots } = resolveConflicts(conflicts, sessionId, clockOffsetMs)
  const winnerById = new Map(winners.map((w) => [w.id, w]))
  const nonConflicting = incomingChanged.filter((r) => !conflictIds.has(r.id))
  const toApply = [...nonConflicting, ...winnerById.values()]

  return { merged: mergeById(local, toApply), conflicts: snapshots }
}

/**
 * Turn one side's `SyncExchangePayload.changed` into a patch this device can
 * apply, plus any conflicts it produced. `sinceLocal` is *this* device's own
 * `lastSyncedAt` for the peer — never the `since` the peer sent, which
 * describes their clock, not this one (see `PairedDevice.clockOffsetMs`'s
 * doc). Account secrets are stripped before anything touches
 * `AppState.accounts`; the caller is responsible for writing them to the
 * keystore first — see `SyncLoop.runCycle`'s `hooks.applySecret`.
 */
export async function applyExchange(
  state: AppState,
  incoming: ScopePayload,
  sinceLocal: number,
  sessionId: string,
  clockOffsetMs: number,
): Promise<ExchangeOutcome & { accountSecrets: Array<{ accountId: string; secret: string }> }> {
  const patch: SyncApplyPatch = {}
  let conflicts: ConflictSnapshot[] = []
  const accountSecrets: Array<{ accountId: string; secret: string }> = []

  if (incoming.accounts) {
    const stripped = incoming.accounts.map((a) => {
      const { secret, ...rest } = a
      if (secret) accountSecrets.push({ accountId: a.id, secret })
      return { ...rest, hasSecret: rest.hasSecret && Boolean(secret) }
    })
    const result = await reconcileArray('account', state.accounts, stripped, sinceLocal, sessionId, clockOffsetMs)
    if (result.merged) patch.accounts = result.merged
    conflicts = conflicts.concat(result.conflicts)
  }

  if (incoming.schedule) {
    const result = await reconcileArray(
      'job',
      state.jobs,
      incoming.schedule.jobs,
      sinceLocal,
      sessionId,
      clockOffsetMs,
    )
    if (result.merged) patch.jobs = result.merged
    if (incoming.schedule.workCalendar) patch.workCalendar = incoming.schedule.workCalendar
    conflicts = conflicts.concat(result.conflicts)
  }

  if (incoming.contacts) {
    const result = await reconcileArray(
      'contact',
      state.contacts,
      incoming.contacts,
      sinceLocal,
      sessionId,
      clockOffsetMs,
    )
    if (result.merged) patch.contacts = result.merged
    conflicts = conflicts.concat(result.conflicts)
  }

  if (incoming.templates) {
    const result = await reconcileArray(
      'template',
      state.templates,
      incoming.templates,
      sinceLocal,
      sessionId,
      clockOffsetMs,
    )
    if (result.merged) patch.templates = result.merged
    conflicts = conflicts.concat(result.conflicts)
  }

  if (incoming.appearance) patch.appearance = incoming.appearance

  return { patch, conflicts, accountSecrets }
}

// ---------------------------------------------------------------------------
// One exchange, either direction
// ---------------------------------------------------------------------------

export interface PerformExchangeResult extends ExchangeOutcome {
  outgoing: SyncExchangePayload
  accountSecrets: Array<{ accountId: string; secret: string }>
}

/**
 * Given the other side's `SyncExchangePayload`, apply it and build this
 * device's own reply — the one function both `SyncLoop.runCycle` (after
 * getting a response) and `respondToSyncRequest` (after getting a request)
 * call, so the two directions cannot quietly drift into different rules.
 */
export async function performExchange(
  state: AppState,
  calendar: WorkCalendar,
  device: PairedDevice,
  incoming: SyncExchangePayload,
  now: number,
): Promise<PerformExchangeResult> {
  const sessionId = `${device.id}:${now}`
  const sinceLocal = device.lastSyncedAt ?? 0
  const { patch, conflicts, accountSecrets } = await applyExchange(
    state,
    incoming.changed,
    sinceLocal,
    sessionId,
    device.clockOffsetMs ?? 0,
  )
  const outgoing: SyncExchangePayload = {
    since: now,
    changed: buildChangedPayload(state, calendar, device.scopes, sinceLocal),
  }
  return { patch, conflicts, accountSecrets, outgoing }
}

// ---------------------------------------------------------------------------
// The responder — driven by `electron/syncServer.ts` via IPC
// ---------------------------------------------------------------------------

export interface RespondHooks {
  findDevice(pairId: string): PairedDevice | undefined
  getSecret(keyRef: string): Promise<string | null>
  getState(): AppState
  getCalendar(): WorkCalendar
  now(): number
}

/** Everything a caller needs to actually commit the exchange to state and the keystore — kept separate from the sealed reply so `respondToSyncRequest` can answer before the renderer has finished dispatching. */
export interface RespondOutcome extends PerformExchangeResult {
  device: PairedDevice
}

export async function respondToSyncRequest(
  hooks: RespondHooks,
  pairId: string,
  envelope: PairingEnvelope,
): Promise<{ envelope: PairingEnvelope; outcome: RespondOutcome } | { error: string }> {
  const device = hooks.findDevice(pairId)
  if (!device || device.mode !== 'ongoing') return { error: 'unknown device' }
  const keyB64 = await hooks.getSecret(device.keyRef)
  if (!keyB64) return { error: 'no key for this device' }

  let key: CryptoKey
  let incoming: SyncExchangePayload
  try {
    key = await importLongLivedKey(keyB64)
    incoming = await openWithRandomIv<SyncExchangePayload>(key, envelope)
  } catch {
    return { error: 'could not open the request' }
  }

  const now = hooks.now()
  const result = await performExchange(hooks.getState(), hooks.getCalendar(), device, incoming, now)
  const replyEnvelope = await sealWithRandomIv(key, result.outgoing)
  return { envelope: replyEnvelope, outcome: { ...result, device } }
}

// ---------------------------------------------------------------------------
// The initiator — a foreground-only timer
// ---------------------------------------------------------------------------

export interface SyncLoopHooks {
  now(): number
  getState(): AppState
  getCalendar(): WorkCalendar
  getPairedDevices(): PairedDevice[]
  getSecret(keyRef: string): Promise<string | null>
  transport: SyncTransport
  /** Called once a device's exchange succeeds — the caller dispatches the patch, records the conflicts, and updates the device's `lastSyncedAt`. */
  onSynced(device: PairedDevice, result: PerformExchangeResult, at: number): void
  /** The device could not be reached this cycle — logged, never queued. See the module doc. */
  onUnreachable?(device: PairedDevice): void
  onError?(device: PairedDevice, message: string): void
  log?(level: 'info' | 'warn' | 'error', message: string, detail?: string): void
}

/**
 * A `setInterval` that only exists while something holds a reference to it —
 * there is nothing here that keeps the process alive on its own, which is
 * exactly the "runs only while the app is open" behaviour the module doc
 * promises. See `state/AppState.tsx` for where this is constructed and torn
 * down alongside the rest of the app's lifecycle.
 */
export class SyncLoop {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly hooks: SyncLoopHooks) {}

  start(intervalMs = SYNC_POLL_INTERVAL_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.runCycle(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Every 'ongoing' device with a known address, one at a time — a LAN poll is cheap, but running them concurrently just means more sockets in flight for no benefit anyone would notice. */
  async runCycle(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const device of this.hooks.getPairedDevices()) {
        if (device.mode !== 'ongoing' || !device.lastAddress) continue
        await this.runDeviceCycle(device)
      }
    } finally {
      this.running = false
    }
  }

  private async runDeviceCycle(device: PairedDevice): Promise<void> {
    try {
      const keyB64 = await this.hooks.getSecret(device.keyRef)
      if (!keyB64) {
        this.hooks.onError?.(device, 'no key stored for this device')
        return
      }
      const key = await importLongLivedKey(keyB64)
      const now = this.hooks.now()
      const sinceLocal = device.lastSyncedAt ?? 0
      const outgoing: SyncExchangePayload = {
        since: now,
        changed: buildChangedPayload(this.hooks.getState(), this.hooks.getCalendar(), device.scopes, sinceLocal),
      }
      const requestEnvelope = await sealWithRandomIv(key, outgoing)

      let raw: unknown
      try {
        raw = await this.hooks.transport.postJson(syncUrl(device.lastAddress!.host), {
          pairId: device.id,
          envelope: requestEnvelope,
        })
      } catch {
        // Unreachable this cycle — not a failure, and not queued. See the module doc.
        this.hooks.onUnreachable?.(device)
        return
      }

      const response = raw as { ok?: boolean; envelope?: PairingEnvelope; error?: string }
      if (!response.ok || !response.envelope) {
        this.hooks.onError?.(device, response.error ?? 'the other device refused the request')
        return
      }

      const theirs = await openWithRandomIv<SyncExchangePayload>(key, response.envelope)
      const result = await performExchange(this.hooks.getState(), this.hooks.getCalendar(), device, theirs, now)
      this.hooks.onSynced(device, result, now)
    } catch (e) {
      this.hooks.onError?.(device, e instanceof Error ? e.message : String(e))
    }
  }
}

/** Every scope that means anything to `buildChangedPayload`/`applyExchange` — re-exported so callers do not have to import both this file and `syncScope.ts` for the same list. */
export { SYNC_SCOPE_KEYS }
