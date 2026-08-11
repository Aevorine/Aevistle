/**
 * The control protocol — how something outside Aevistle asks it to do
 * something. Claude Code is the intended caller; anything that can make an
 * HTTP request or write a file works the same way.
 *
 * Kept in `src/core` because all four participants import it: the HTTP server
 * in the main process, the executor in the renderer, the CLI, and the MCP
 * server under `mcp/`. One definition means an operation cannot be added on
 * one side and misspelled on another.
 *
 * ---------------------------------------------------------------------------
 * Why requests travel through the renderer
 * ---------------------------------------------------------------------------
 * The renderer owns application state; the main process only writes what the
 * renderer hands it, on a 350ms debounce. A control request that edited
 * `state.json` directly would be silently overwritten by the next save. So the
 * main process accepts the request, forwards it to the window, and waits for
 * the answer — which also means every control operation goes through exactly
 * the same reducer, validation and scheduler sync as a click would.
 *
 * ---------------------------------------------------------------------------
 * Security posture
 * ---------------------------------------------------------------------------
 * The server binds 127.0.0.1 and nothing else, requires a bearer token that is
 * regenerated on every launch, and is off until switched on in Settings.
 *
 * `send_now` is gated a second time, behind its own setting. Reading state and
 * scheduling a reminder are recoverable; sending mail as the user, right now,
 * to whoever the caller names, is not — and a token sitting in a file on the
 * same machine is a lower bar than the person at the keyboard.
 */

import type { ControlScope, InboxTag, Recurrence } from './types'
import { ALL_CONTROL_SCOPES } from './types'

/** Everything a caller may ask for. */
export type ControlOp =
  | 'status'
  | 'list_jobs'
  | 'create_reminder'
  | 'cancel_job'
  | 'toggle_job'
  | 'send_now'
  | 'list_logs'
  | 'list_contacts'
  | 'list_templates'
  | 'list_inbox'

/** Operations that change something rather than just reporting it. */
export const WRITING_OPS: readonly ControlOp[] = [
  'create_reminder',
  'cancel_job',
  'toggle_job',
  'send_now',
]

/** Operations refused unless `allowRemoteSend` is also on. */
export const SENDING_OPS: readonly ControlOp[] = ['send_now']

// ---------------------------------------------------------------------------
// Scopes — fine-grained permissions, checked in addition to the on/off
// switches above.
//
// One scope per operation, not a set per operation: every op here does
// exactly one kind of thing (read the schedule, change the schedule, read
// the inbox, read contacts/templates, or send), so "which scope does this
// need" has one answer, and `Record<ControlOp, ControlScope>` makes the
// compiler enforce that every op — including one added later — has an entry
// at all, rather than silently falling through to "no scope required".
// ---------------------------------------------------------------------------

export const OP_SCOPES: Record<ControlOp, ControlScope> = {
  status: 'read.schedule',
  list_jobs: 'read.schedule',
  list_logs: 'read.schedule',
  create_reminder: 'write.schedule',
  cancel_job: 'write.schedule',
  toggle_job: 'write.schedule',
  send_now: 'send.immediate',
  list_contacts: 'read.contacts',
  list_templates: 'read.contacts',
  list_inbox: 'read.inbox',
}

/**
 * The scopes a settings screen can actually offer a checkbox for.
 *
 * `send.immediate` is excluded — it is governed solely by
 * `Settings.controlAllowSending`, the switch that already existed before
 * scopes did, so it gets no second, redundant control (see that field's doc
 * in `core/types.ts`). `write.contacts` is excluded because no operation
 * needs it yet — see `ControlScope`'s doc.
 */
export const CONFIGURABLE_CONTROL_SCOPES: readonly ControlScope[] = [
  'read.schedule',
  'read.inbox',
  'read.contacts',
  'write.schedule',
]

/**
 * Turn whatever is sitting in `Settings.controlScopes` into a real
 * `ControlScope[]`, never trusting its shape.
 *
 * `undefined` — the field did not exist yet, or the user has never touched
 * these checkboxes — reads as "every scope", the same thing `controlEnabled`
 * used to grant unconditionally before this feature existed; that is a
 * deliberate, documented default (see `Settings.controlScopes`), not a gap.
 * Anything else that is not actually an array — a corrupted settings file, a
 * hand edit, a future type that changed shape — reads as *no* scopes, which
 * is the fail-closed direction: a malformed grant list must never be read as
 * "grant everything". Individual entries that are not a real `ControlScope`
 * are dropped rather than trusted.
 */
export function normalizeControlScopes(value: unknown): ControlScope[] {
  if (value === undefined) return [...ALL_CONTROL_SCOPES]
  if (!Array.isArray(value)) return []
  return value.filter((v): v is ControlScope => ALL_CONTROL_SCOPES.includes(v as ControlScope))
}

/**
 * The scopes actually in force right now, folding `controlAllowSending` in
 * as the sole source of truth for `send.immediate` — see
 * `Settings.controlAllowSending`'s doc for why that scope is not read out of
 * `controlScopes` at all. Whatever `controlScopes` claims about
 * `send.immediate` is overridden, in both directions, by the dedicated
 * switch.
 */
export function effectiveControlScopes(settings: {
  controlScopes?: unknown
  controlAllowSending?: boolean
}): ControlScope[] {
  const base = normalizeControlScopes(settings.controlScopes).filter((s) => s !== 'send.immediate')
  return settings.controlAllowSending === true ? [...base, 'send.immediate'] : base
}

/**
 * The scope `op` requires, or `null` if `op` is not a recognised operation at
 * all — which must never be read as "needs no scope, so allow it". Every
 * caller of this treats `null` as "refuse", the same as a scope the caller
 * does not have.
 */
export function requiredScope(op: string): ControlScope | null {
  return (OP_SCOPES as Record<string, ControlScope | undefined>)[op] ?? null
}

/**
 * Why `op` is refused given `granted`, or `null` if it is allowed.
 *
 * The one place this message is built, so the HTTP server, the drop folder
 * and the renderer executor — the three doorways a request can arrive
 * through — say the exact same sentence for the exact same reason, the same
 * way `WRITING_OPS`/`SENDING_OPS` already keep "sending is switched off" in
 * sync across all of them.
 */
export function scopeRefusal(op: string, granted: readonly ControlScope[]): string | null {
  const need = requiredScope(op)
  if (!need) return `unrecognised operation: ${op}`
  if (!granted.includes(need)) return `the '${need}' scope is not granted to the control interface`
  return null
}

export interface ControlRequest {
  /** Correlates the reply. Generated by whoever accepted the request. */
  id: string
  op: ControlOp
  params: Record<string, unknown>
  /** How the request arrived, for the activity log. */
  via: 'http' | 'drop' | 'cli'
}

export interface ControlResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// Audit log
//
// Every request that reaches the control server, whatever became of it. Kept
// durably on disk (`electron/store.ts`'s `loadControlAudit`/
// `appendControlAudit`) independently of `state.json` — a refusal at the
// token or scope gate never reaches the renderer at all (see
// `electron/controlServer.ts`), so anything that waited for a round trip
// through application state would simply never see it.
// ---------------------------------------------------------------------------

export interface ControlAuditEntry {
  id: string
  /** Epoch ms. */
  at: number
  via: ControlRequest['via']
  /**
   * The raw op string as it arrived — deliberately not narrowed to
   * `ControlOp`, so an unrecognised op (which is refused, not executed) is
   * still recorded as what was actually asked for. `null` only for a request
   * refused before an op was even parsed — a bad bearer token.
   */
  op: string | null
  /** `null` when `op` did not resolve to a real operation. */
  scope: ControlScope | null
  granted: boolean
  /** Why refused, or the executor's own error. Absent for a plain success. */
  reason?: string
  /**
   * What actually happened, deliberately shallow — a job id, a row count, a
   * count of accepted recipients. Never a subject, a body, an address or a
   * credential; see `auditContext`, the one place this is built.
   */
  context?: string
}

/**
 * The `context` field for one audit entry, built from the *response* a
 * granted request produced — never from the request's own params, which is
 * what keeps a recipient address or a message body out of this file. Absent
 * for a refused request (nothing ran) and for an op this does not have
 * something worth naming for.
 */
export function auditContext(op: string, response: ControlResponse): string | undefined {
  if (!response.ok || response.result === undefined || response.result === null) return undefined
  const r = response.result as Record<string, unknown>
  switch (op) {
    case 'create_reminder':
    case 'cancel_job':
    case 'toggle_job':
      return typeof r.id === 'string' ? `job ${r.id}` : undefined
    case 'send_now':
      return Array.isArray(r.accepted) ? `${r.accepted.length} recipient(s) accepted` : undefined
    case 'list_jobs':
    case 'list_logs':
    case 'list_contacts':
    case 'list_templates':
    case 'list_inbox':
      return Array.isArray(response.result) ? `${response.result.length} row(s)` : undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Parameter shapes
//
// Declared rather than inferred so the MCP server can publish a schema that
// matches what the executor actually reads.
// ---------------------------------------------------------------------------

export interface CreateReminderParams {
  to: string[]
  subject: string
  body?: string
  cc?: string[]
  bcc?: string[]
  /** ISO 8601, or `YYYY-MM-DD HH:mm`. Interpreted in the app's local zone. */
  at: string
  /** Omit for a one-off. */
  recurrence?: Recurrence
  /** Defaults to the first configured account. */
  accountId?: string
  /** Shown in the schedule list. Defaults to the subject. */
  name?: string
}

export interface SendNowParams {
  to: string[]
  subject: string
  body?: string
  cc?: string[]
  bcc?: string[]
  accountId?: string
}

export interface ListParams {
  limit?: number
}

export interface ListInboxParams extends ListParams {
  unreadOnly?: boolean
  tag?: InboxTag
}

export interface StatusResult {
  app: string
  version: string
  accounts: number
  jobs: { total: number; armed: number }
  logs: number
  contacts: number
  templates: number
  inbox: { accounts: number; messages: number; unread: number }
  /** False when `send_now` will be refused. */
  sendingAllowed: boolean
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * What gets written to `<dataRoot>/control/endpoint.json` when the server is
 * running, so a caller does not have to be told the port. Deleted on shutdown;
 * a stale file is detected by the token no longer being accepted.
 */
export interface ControlEndpoint {
  port: number
  token: string
  /** Absolute path of the drop folder, which works whether or not we are up. */
  dropDir: string
  pid: number
  startedAt: number
}

export const CONTROL_DIR = 'control'
export const ENDPOINT_FILE = 'endpoint.json'
export const DROP_DIR = 'drop'

/**
 * The one path a caller can rely on without being told anything.
 *
 * The endpoint file is also written inside the data folder, but the data
 * folder is user-relocatable — it can be on a second drive or a synced share —
 * so a client that only knew about it would have nothing to look up. `~` is
 * the fixed point, and it is where the project already keeps its signing
 * material, so it is not a new place to know about.
 */
export const HOME_CONTROL_DIR = '.aevistle'

/**
 * Parse the `at` field of a reminder.
 *
 * Deliberately strict about one thing: a bare `YYYY-MM-DD HH:mm` is read as
 * local time, not UTC. `new Date('2026-08-10 09:00')` already does that, but
 * `new Date('2026-08-10T09:00')` does too while `...T09:00Z` does not, and a
 * reminder that fires eight hours out is worse than one that refuses to be
 * created. Anything unparseable is an error, never a silent "now".
 */
export function parseWhen(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('`at` is required: an ISO timestamp or "YYYY-MM-DD HH:mm"')
  }
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'))
  if (!Number.isFinite(parsed)) {
    throw new Error(`could not read \`at\` as a date: ${JSON.stringify(value)}`)
  }
  return parsed
}
