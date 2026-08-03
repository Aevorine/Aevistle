/**
 * The renderer half of the control protocol: turning a request that arrived
 * over HTTP, from the drop folder or from the CLI into the same calls a click
 * would make.
 *
 * That reuse is the whole point. A control request that built a job object and
 * pushed it into state directly would skip attachment snapshotting, occurrence
 * computation, quiet hours and the scheduler sync — and would then sit in the
 * list looking correct until the moment it failed to fire. Everything here
 * goes through `scheduleDraft`, `toggleJob` and friends.
 *
 * Reads are deliberately shallow. `list_jobs` returns what a caller needs to
 * decide something and act on it, not the whole job including its attachment
 * blobs; the response travels through IPC and, for HTTP callers, onto a socket.
 */

import {
  parseWhen,
  type ControlRequest,
  type ControlResponse,
  type StatusResult,
} from '../core/control'
import {
  DEFAULT_RETRY,
  defaultRecurrence,
  emptyDraft,
  newId,
  type AppState,
  type MessageDraft,
  type Recurrence,
  type ScheduledJob,
  type SendResult,
} from '../core/types'

/** What the executor needs from `AppState`, named so the coupling is visible. */
export interface ControlDeps {
  state: AppState
  appVersion: string
  allowSending: boolean
  scheduleDraft(job: ScheduledJob): Promise<void>
  sendDraftNow(draft: MessageDraft): Promise<SendResult>
  toggleJob(id: string, enabled: boolean): Promise<void>
  deleteJob(id: string): Promise<void>
}

function asStringArray(value: unknown, field: string, required = true): string[] {
  if (value === undefined || value === null) {
    if (required) throw new Error(`\`${field}\` is required`)
    return []
  }
  const list = Array.isArray(value) ? value : [value]
  const out = list.map((entry) => String(entry).trim()).filter(Boolean)
  if (required && out.length === 0) throw new Error(`\`${field}\` is required`)
  return out
}

function pickAccount(state: AppState, requested: unknown): string {
  if (typeof requested === 'string' && requested) {
    const found = state.accounts.find(
      (a) => a.id === requested || a.fromAddress === requested || a.label === requested,
    )
    if (!found) throw new Error(`no account matches ${JSON.stringify(requested)}`)
    return found.id
  }
  const fallback =
    state.accounts.find((a) => a.id === state.settings.defaultAccountId) ?? state.accounts[0]
  if (!fallback) throw new Error('no sending account is configured yet')
  return fallback.id
}

function draftFrom(state: AppState, params: Record<string, unknown>): MessageDraft {
  const accountId = pickAccount(state, params.accountId)
  return {
    ...emptyDraft(accountId),
    to: asStringArray(params.to, 'to'),
    cc: asStringArray(params.cc, 'cc', false),
    bcc: asStringArray(params.bcc, 'bcc', false),
    subject: String(params.subject ?? '').trim(),
    body: String(params.body ?? ''),
  }
}

/**
 * Build the recurrence. A caller that gives only `at` gets a one-off; one that
 * gives a `recurrence` object gets it merged over a sane base, so it can say
 * `{"kind":"weekly","weekdays":[1]}` without also having to know that
 * `monthDayFallback` exists.
 */
function recurrenceFrom(params: Record<string, unknown>): Recurrence {
  const startAt = parseWhen(params.at)
  const when = new Date(startAt)
  const timeOfDay = `${String(when.getHours()).padStart(2, '0')}:${String(
    when.getMinutes(),
  ).padStart(2, '0')}`

  // Built from the app's own defaults rather than a literal, so a field added
  // to Recurrence later cannot leave control-created jobs missing it.
  const base: Recurrence = { ...defaultRecurrence(startAt), kind: 'once', startAt, timeOfDay }
  const supplied = params.recurrence
  if (!supplied || typeof supplied !== 'object') return base
  return { ...base, ...(supplied as Partial<Recurrence>), startAt, timeOfDay }
}

export async function executeControl(
  request: ControlRequest,
  deps: ControlDeps,
): Promise<ControlResponse> {
  const { state } = deps
  const params = request.params ?? {}
  const limit = Math.min(Number(params.limit) || 50, 500)
  const ok = (result: unknown): ControlResponse => ({ id: request.id, ok: true, result })

  try {
    switch (request.op) {
      case 'status': {
        const messages = state.inboxAccounts.flatMap((i) => i.messages)
        const status: StatusResult = {
          app: 'Aevistle',
          version: deps.appVersion,
          accounts: state.accounts.length,
          jobs: {
            total: state.jobs.length,
            armed: state.jobs.filter((j) => j.enabled && j.occurrences.length > 0).length,
          },
          logs: state.logs.length,
          contacts: state.contacts.length,
          templates: state.templates.length,
          inbox: {
            accounts: state.inboxAccounts.length,
            messages: messages.length,
            unread: messages.filter((m) => !m.seen).length,
          },
          sendingAllowed: deps.allowSending,
        }
        return ok(status)
      }

      case 'list_jobs':
        return ok(
          state.jobs.slice(0, limit).map((job) => ({
            id: job.id,
            name: job.name,
            enabled: job.enabled,
            subject: job.draft.subject,
            to: job.draft.to,
            recurrence: job.recurrence.kind,
            nextRun: job.occurrences[0] ?? null,
            runCount: job.runCount,
            lastResult: job.lastResult ?? null,
            lastError: job.lastError ?? null,
            attachments: job.draft.attachments.length,
          })),
        )

      case 'create_reminder': {
        const draft = draftFrom(state, params)
        if (!draft.subject) throw new Error('`subject` is required')
        const recurrence = recurrenceFrom(params)
        const now = Date.now()
        const job: ScheduledJob = {
          id: newId('job'),
          name: String(params.name ?? draft.subject),
          enabled: true,
          draft,
          recurrence,
          occurrences: [],
          runCount: 0,
          retry: DEFAULT_RETRY,
          status: 'armed',
          createdAt: now,
          updatedAt: now,
        }
        // `scheduleDraft` fills in occurrences, applies quiet hours and pushes
        // the result to the platform scheduler.
        await deps.scheduleDraft(job)
        return ok({ id: job.id, name: job.name, at: recurrence.startAt })
      }

      case 'cancel_job': {
        const id = String(params.id ?? '')
        if (!state.jobs.some((j) => j.id === id)) throw new Error(`no job with id ${id}`)
        await deps.deleteJob(id)
        return ok({ id, cancelled: true })
      }

      case 'toggle_job': {
        const id = String(params.id ?? '')
        const job = state.jobs.find((j) => j.id === id)
        if (!job) throw new Error(`no job with id ${id}`)
        const enabled = params.enabled === undefined ? !job.enabled : Boolean(params.enabled)
        await deps.toggleJob(id, enabled)
        return ok({ id, enabled })
      }

      case 'send_now': {
        // The server refuses this before we are reached; checked again here
        // because the drop folder and the CLI are separate doorways and a
        // permission enforced in only one of them is not enforced.
        if (!deps.allowSending) {
          throw new Error('sending through the control interface is switched off in Settings')
        }
        const draft = draftFrom(state, params)
        if (!draft.subject) throw new Error('`subject` is required')
        const result = await deps.sendDraftNow(draft)
        if (!result.ok) throw new Error(result.error ?? 'send failed')
        return ok({ accepted: result.accepted, durationMs: result.durationMs })
      }

      case 'list_logs':
        return ok(
          [...state.logs]
            .sort((a, b) => b.at - a.at)
            .slice(0, limit)
            .map((entry) => ({
              at: entry.at,
              kind: entry.kind,
              level: entry.level,
              title: entry.title,
              detail: entry.detail ?? null,
              durationMs: entry.durationMs ?? null,
            })),
        )

      case 'list_contacts':
        return ok(
          state.contacts.slice(0, limit).map((c) => ({
            id: c.id,
            name: c.name,
            address: c.address,
            tags: c.tags,
          })),
        )

      case 'list_templates':
        return ok(
          state.templates.slice(0, limit).map((tpl) => ({
            id: tpl.id,
            name: tpl.name,
            subject: tpl.subject,
            updatedAt: tpl.updatedAt,
          })),
        )

      case 'list_inbox': {
        const unreadOnly = Boolean(params.unreadOnly)
        const tag = params.tag
        const rows = state.inboxAccounts
          .flatMap((account) => account.messages.map((m) => ({ ...m, accountId: account.accountId })))
          .filter((m) => (unreadOnly ? !m.seen : true))
          .filter((m) => (typeof tag === 'string' && tag ? m.tag === tag : true))
          .sort((a, b) => b.date - a.date)
          .slice(0, limit)
        return ok(
          rows.map((m) => ({
            id: m.id,
            accountId: m.accountId,
            from: m.from,
            subject: m.subject,
            date: m.date,
            seen: m.seen,
            tag: m.tag,
          })),
        )
      }

      default:
        throw new Error(`unhandled op: ${String(request.op)}`)
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
