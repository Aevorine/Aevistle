/**
 * Input validation and hardening.
 *
 * This file is deliberately paranoid. Everything here defends against a
 * specific, real failure mode rather than "being careful in general":
 *
 *  - SMTP header injection — a newline inside a subject or address lets an
 *    attacker append their own headers (Bcc:, Content-Type:) and turn the app
 *    into an open relay. This is the single highest-impact bug class in any
 *    mail client, so addresses and header-bound strings are rejected outright
 *    if they contain CR, LF or NUL.
 *  - HTML injection into the body — when the body is rendered as HTML we
 *    escape by default and only allow a known-safe subset.
 *  - Attachment path abuse — a crafted saved job could point at
 *    C:\Users\...\.ssh\id_rsa and mail it out. Paths are checked and the UI
 *    always shows the resolved name and size before a send.
 *  - Oversized payloads — providers hard-reject past ~25 MB, and a 2 GB
 *    attachment would OOM the renderer before we ever reach the network.
 */

import type { Attachment, BurstPolicy, MailAccount, MessageDraft, Recurrence } from './types'
import { MAX_BURST_COUNT } from './types'
import { validateCron } from './schedule'

export interface Issue {
  /** i18n key. */
  key: string
  severity: 'error' | 'warning'
  field?: string
  values?: Record<string, string | number>
}

const CONTROL_CHARS = /[\r\n\u0000\u000b\u000c\u2028\u2029]/

/**
 * Practical address check. Intentionally stricter than RFC 5322 — we do not
 * accept quoted local parts or comments, because every real provider rejects
 * them anyway and permissive parsing is where injection bugs hide.
 */
const ADDRESS_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

export function isValidAddress(address: string): boolean {
  const a = address.trim()
  if (!a || a.length > 254) return false
  if (CONTROL_CHARS.test(a)) return false
  const at = a.lastIndexOf('@')
  if (at < 1) return false
  if (a.slice(0, at).length > 64) return false
  return ADDRESS_RE.test(a)
}

/** True when a string is safe to place into a MIME header. */
export function isHeaderSafe(value: string): boolean {
  return !CONTROL_CHARS.test(value)
}

/** Strip anything that could break out of a header. Used as a last resort. */
export function sanitizeHeader(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').trim()
}

/** Split a pasted blob of addresses on commas, semicolons and whitespace. */
export function parseAddressList(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().replace(/^[<]|[>]$/g, ''))
    .filter(Boolean)
}

export function dedupeAddresses(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of list) {
    const k = a.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(a)
  }
  return out
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/**
 * Convert the plain-text body to HTML for the preview pane and for the
 * multipart/alternative HTML part. Escapes first, then linkifies — never the
 * other way round, or the link text itself becomes an injection point.
 */
export function plainToHtml(text: string): string {
  const escaped = escapeHtml(text)
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`,
  )
  return linked.replace(/\r?\n/g, '<br>')
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Extensions that mail providers and gateways routinely quarantine. */
const RISKY_EXTENSIONS = new Set([
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'msi', 'jar', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'reg', 'hta', 'cpl', 'lnk',
  'dll', 'sys', 'iso', 'img', 'apk',
])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isRiskyAttachment(name: string): boolean {
  return RISKY_EXTENSIONS.has(extensionOf(name))
}

/**
 * A double extension like `invoice.pdf.exe` is the classic disguise. Flag it
 * separately because the file name alone looks harmless in most mail clients.
 */
export function hasDeceptiveName(name: string): boolean {
  const parts = name.toLowerCase().split('.')
  if (parts.length < 3) return false
  const last = parts[parts.length - 1]
  const secondLast = parts[parts.length - 2]
  const documentLike = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'jpg', 'png'])
  return RISKY_EXTENSIONS.has(last) && documentLike.has(secondLast)
}

export function totalAttachmentBytes(attachments: Attachment[]): number {
  return attachments.reduce((sum, a) => sum + (a.size || 0), 0)
}

/**
 * Base64 inflates a MIME payload by 4/3 plus line breaks. A 20 MB file becomes
 * roughly 27 MB on the wire, which is why "under the limit" attachments still
 * get rejected. We check the encoded size, not the raw size.
 */
export function encodedSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4 + Math.ceil(rawBytes / 57) * 2
}

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

export interface ValidateDraftOptions {
  attachmentWarnBytes: number
  attachmentMaxBytes: number
  bulkConfirmThreshold: number
}

export function validateDraft(
  draft: MessageDraft,
  account: MailAccount | undefined,
  opts: ValidateDraftOptions,
): Issue[] {
  const issues: Issue[] = []

  if (!account) {
    issues.push({ key: 'validate.noAccount', severity: 'error', field: 'accountId' })
  }

  const all = [...draft.to, ...draft.cc, ...draft.bcc]
  if (all.length === 0) {
    issues.push({ key: 'validate.noRecipients', severity: 'error', field: 'to' })
  }

  for (const address of all) {
    if (!isValidAddress(address)) {
      issues.push({
        key: 'validate.badAddress',
        severity: 'error',
        field: 'to',
        values: { address },
      })
    }
  }

  const duplicates = all.length - dedupeAddresses(all).length
  if (duplicates > 0) {
    issues.push({ key: 'validate.duplicateRecipients', severity: 'warning', values: { n: duplicates } })
  }

  if (all.length > opts.bulkConfirmThreshold) {
    issues.push({
      key: 'validate.bulkRecipients',
      severity: 'warning',
      values: { n: all.length },
    })
  }

  if (draft.to.length > 1 && draft.bcc.length === 0 && !draft.individualDelivery) {
    issues.push({ key: 'validate.exposedRecipients', severity: 'warning', field: 'to' })
  }

  if (!draft.subject.trim()) {
    issues.push({ key: 'validate.noSubject', severity: 'warning', field: 'subject' })
  }
  if (!isHeaderSafe(draft.subject)) {
    issues.push({ key: 'validate.subjectInjection', severity: 'error', field: 'subject' })
  }
  if (draft.subject.length > 900) {
    issues.push({ key: 'validate.subjectTooLong', severity: 'warning', field: 'subject' })
  }

  if (!draft.body.trim() && draft.attachments.length === 0) {
    issues.push({ key: 'validate.emptyBody', severity: 'warning', field: 'body' })
  }

  const raw = totalAttachmentBytes(draft.attachments)
  const wire = encodedSize(raw)
  if (wire > opts.attachmentMaxBytes) {
    issues.push({
      key: 'validate.attachmentsTooLarge',
      severity: 'error',
      field: 'attachments',
      values: { mb: (wire / 1048576).toFixed(1), limit: (opts.attachmentMaxBytes / 1048576).toFixed(0) },
    })
  } else if (wire > opts.attachmentWarnBytes) {
    issues.push({
      key: 'validate.attachmentsLarge',
      severity: 'warning',
      field: 'attachments',
      values: { mb: (wire / 1048576).toFixed(1) },
    })
  }

  for (const a of draft.attachments) {
    if (!isHeaderSafe(a.name)) {
      issues.push({
        key: 'validate.attachmentNameInjection',
        severity: 'error',
        field: 'attachments',
        values: { name: a.name },
      })
    }
    if (hasDeceptiveName(a.name)) {
      issues.push({
        key: 'validate.attachmentDeceptive',
        severity: 'warning',
        field: 'attachments',
        values: { name: a.name },
      })
    } else if (isRiskyAttachment(a.name)) {
      issues.push({
        key: 'validate.attachmentRisky',
        severity: 'warning',
        field: 'attachments',
        values: { name: a.name, ext: extensionOf(a.name) },
      })
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// Account validation
// ---------------------------------------------------------------------------

export function validateAccount(account: MailAccount): Issue[] {
  const issues: Issue[] = []

  if (!account.label.trim()) {
    issues.push({ key: 'validate.accountNoLabel', severity: 'warning', field: 'label' })
  }
  if (!isValidAddress(account.fromAddress)) {
    issues.push({ key: 'validate.accountBadFrom', severity: 'error', field: 'fromAddress' })
  }
  if (account.replyTo && !isValidAddress(account.replyTo)) {
    issues.push({ key: 'validate.accountBadReplyTo', severity: 'error', field: 'replyTo' })
  }
  if (!isHeaderSafe(account.fromName)) {
    issues.push({ key: 'validate.accountNameInjection', severity: 'error', field: 'fromName' })
  }
  if (!account.host.trim()) {
    issues.push({ key: 'validate.accountNoHost', severity: 'error', field: 'host' })
  } else if (!/^[A-Za-z0-9.\-_]+$/.test(account.host.trim())) {
    issues.push({ key: 'validate.accountBadHost', severity: 'error', field: 'host' })
  }
  if (!Number.isInteger(account.port) || account.port < 1 || account.port > 65535) {
    issues.push({ key: 'validate.accountBadPort', severity: 'error', field: 'port' })
  }
  if (account.security === 'none') {
    issues.push({ key: 'validate.accountPlaintext', severity: 'warning', field: 'security' })
  }
  if (account.allowInvalidCert) {
    issues.push({ key: 'validate.accountInsecureTls', severity: 'warning', field: 'allowInvalidCert' })
  }
  if (account.authMethod === 'password' && !account.username.trim()) {
    issues.push({ key: 'validate.accountNoUser', severity: 'error', field: 'username' })
  }

  return issues
}

// ---------------------------------------------------------------------------
// Recurrence validation
// ---------------------------------------------------------------------------

export function validateRecurrence(rec: Recurrence, now = Date.now()): Issue[] {
  const issues: Issue[] = []

  if (rec.kind === 'once' && rec.startAt <= now) {
    issues.push({ key: 'validate.startInPast', severity: 'error', field: 'startAt' })
  }

  if (rec.kind === 'interval') {
    if (rec.intervalMs !== undefined) {
      if (!Number.isInteger(rec.intervalMs) || rec.intervalMs < 1) {
        issues.push({ key: 'validate.intervalTooSmall', severity: 'error', field: 'intervalMs' })
      } else if (rec.intervalMs < 1000) {
        // Sub-second is a real, deliberately-supported cadence — see the
        // hybrid scheduler — but still worth a warning: this is the trigger
        // rate, not a promise about real network delivery (see BurstPolicy).
        issues.push({ key: 'validate.intervalAggressive', severity: 'warning', field: 'intervalMs' })
      }
    } else {
      const m = rec.intervalMinutes ?? 0
      if (!Number.isInteger(m) || m < 1) {
        issues.push({ key: 'validate.intervalTooSmall', severity: 'error', field: 'intervalMinutes' })
      } else if (m < 5) {
        issues.push({ key: 'validate.intervalAggressive', severity: 'warning', field: 'intervalMinutes' })
      }
    }
  }

  if (rec.kind === 'weekly' && (!rec.weekdays || rec.weekdays.length === 0)) {
    issues.push({ key: 'validate.noWeekdays', severity: 'error', field: 'weekdays' })
  }

  if (rec.kind === 'monthly') {
    const d = rec.dayOfMonth ?? 0
    if (d < 1 || d > 31) {
      issues.push({ key: 'validate.badDayOfMonth', severity: 'error', field: 'dayOfMonth' })
    } else if (d > 28) {
      issues.push({ key: 'validate.shortMonthWarning', severity: 'warning', field: 'dayOfMonth' })
    }
  }

  if (rec.kind === 'cron') {
    if (!rec.cron?.trim()) {
      issues.push({ key: 'validate.noCron', severity: 'error', field: 'cron' })
    } else {
      const r = validateCron(rec.cron)
      if (!r.ok) {
        issues.push({ key: 'validate.badCron', severity: 'error', field: 'cron', values: { error: r.error } })
      }
    }
  }

  if (rec.endMode === 'onDate' && (rec.endDate === undefined || rec.endDate <= rec.startAt)) {
    issues.push({ key: 'validate.endBeforeStart', severity: 'error', field: 'endDate' })
  }
  if (rec.endMode === 'afterCount' && (!rec.maxRuns || rec.maxRuns < 1)) {
    issues.push({ key: 'validate.badMaxRuns', severity: 'error', field: 'maxRuns' })
  }
  if (rec.jitterSeconds < 0 || rec.jitterSeconds > 3600) {
    issues.push({ key: 'validate.badJitter', severity: 'error', field: 'jitterSeconds' })
  }

  return issues
}

// ---------------------------------------------------------------------------
// Burst (repeat-N-times-per-fire) validation
// ---------------------------------------------------------------------------

/**
 * `count` is capped outright, not just warned about — a fat-fingered 50000
 * should be rejected, not silently attempted and left to burn through a
 * provider's rate limit. `pacingMs` gets a warning floor instead, because a
 * legitimate stress-test of the local dispatch queue really does want a very
 * small number here; the network side is already paced by the account's warm
 * connection regardless of what this field says (see scheduler.ts).
 */
export function validateBurst(burst: BurstPolicy | undefined): Issue[] {
  const issues: Issue[] = []
  if (!burst?.enabled) return issues

  if (!Number.isInteger(burst.count) || burst.count < 1 || burst.count > MAX_BURST_COUNT) {
    issues.push({
      key: 'validate.burstCountTooHigh',
      severity: 'error',
      field: 'burst.count',
      values: { max: MAX_BURST_COUNT },
    })
  }

  if (!Number.isInteger(burst.pacingMs) || burst.pacingMs < 0) {
    issues.push({ key: 'validate.burstPacingInvalid', severity: 'error', field: 'burst.pacingMs' })
  } else if (burst.pacingMs < 50) {
    issues.push({ key: 'validate.burstPacingAggressive', severity: 'warning', field: 'burst.pacingMs' })
  }

  return issues
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}
