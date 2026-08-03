/**
 * Delivery tracking — what happened *after* the server said "250 OK".
 *
 * The honest starting point: SMTP's success reply means the next hop accepted
 * responsibility, and nothing more. A bounce arrives minutes later, as a
 * separate message, in the inbox. A read receipt arrives only if the recipient
 * agrees to send one. Neither reaches back to the send that caused it.
 *
 * So this correlates them, using what is actually available in the cached
 * inbox rows — sender, subject, snippet — and it is careful about the
 * distinction that matters:
 *
 * - `sent`      — the server accepted it. What every mail client shows.
 * - `bounced`   — a delivery status notification came back. Something is wrong.
 * - `read`      — a disposition notification came back. Weak evidence at best:
 *                 most clients never send one, so "not read" means nothing.
 *
 * **Absence is never evidence here.** No bounce after ten minutes is not proof
 * of delivery, and this file never claims it is: `sent` stays `sent`. Reporting
 * a confident "delivered" the application cannot actually observe would be a
 * more comfortable lie than the truth it replaces.
 */

import type { InboxMessage, LogEntry } from './types'

export type ReceiptStatus = 'sent' | 'bounced' | 'read'

export interface ReceiptEvidence {
  status: ReceiptStatus
  /** The inbox row that proves it, when there is one. */
  messageId?: string
  at?: number
  /** What the bounce actually said, trimmed to something readable. */
  detail?: string
}

/**
 * Machine-generated senders. Matched on the local part so that
 * `MAILER-DAEMON@anything` and `postmaster@anything` both hit, which is what
 * RFC 5321 §4.5.1 requires every domain to provide.
 */
const DAEMON_LOCALS = [
  'mailer-daemon',
  'postmaster',
  'mail-daemon',
  'mailerdaemon',
  'bounce',
  'bounces',
  'no-reply',
  'noreply',
]

/**
 * Subjects that mean "this did not arrive", in the six UI languages plus the
 * wordings the big providers actually emit. Deliberately broad: a false
 * positive shows an extra "check this" chip, a false negative hides the one
 * fact the user needed.
 */
const BOUNCE_SUBJECT =
  /(undeliver|delivery (status notification|failure|has failed)|failure notice|returned mail|mail delivery (failed|subsystem)|message not delivered|no se pudo entregar|échec de (la )?remise|non remis|не доставлено|недоставленное|فشل التسليم|لم يتم التسليم|退信|无法投递|投递失败|发送失败通知)/i

/** Read/disposition notifications. `Read:` and `已读` are the two common shapes. */
const READ_SUBJECT =
  /(^\s*(read|gelesen|lu)\s*:|read receipt|disposition[- ]notification|return receipt|已读回执|阅读回执|已读[：:]|confirmación de lectura|accusé de réception|уведомление о прочтении|إشعار بالقراءة)/i

function localPart(address: string): string {
  const at = address.lastIndexOf('@')
  const inner = /<([^>]+)>/.exec(address)
  const bare = inner ? inner[1] : address
  const idx = bare.lastIndexOf('@')
  return (idx >= 0 ? bare.slice(0, idx) : bare.slice(0, at >= 0 ? at : undefined))
    .trim()
    .toLowerCase()
}

export function looksLikeDaemon(from: string): boolean {
  const local = localPart(from)
  return DAEMON_LOCALS.some((d) => local === d || local.startsWith(`${d}+`) || local.startsWith(`${d}-`))
}

export type ReportKind = 'bounce' | 'read' | null

/** Classify one inbox row without reference to any particular send. */
export function classifyReport(message: Pick<InboxMessage, 'from' | 'subject'>): ReportKind {
  if (BOUNCE_SUBJECT.test(message.subject)) return 'bounce'
  if (READ_SUBJECT.test(message.subject)) return 'read'
  // A bare "Delivery Status Notification" with an unhelpful subject still comes
  // from a daemon address, and nothing else does.
  if (looksLikeDaemon(message.from)) return 'bounce'
  return null
}

/**
 * Strip the report prefixes so `Re: Read: Fwd: Weekly report` compares equal to
 * `Weekly report`. Also drops the punctuation and case differences that make a
 * plain `includes` miss the match it should have found.
 */
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|read|回复|答复|转发|已读|转)\s*[::]\s*)+/i, '')
    .replace(/[\s　]+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Does this report concern that send?
 *
 * Message-ID is the reliable link — a DSN quotes the original headers, so the
 * id normally appears verbatim in the returned body, which is what the cached
 * snippet holds the start of. Subject matching is the fallback for the
 * providers that summarise instead of quoting, and it requires a non-trivial
 * subject: matching on an empty subject would tie every bounce to every
 * subject-less send.
 */
export function reportMatches(
  report: Pick<InboxMessage, 'subject' | 'snippet'>,
  sent: { messageId?: string; subject?: string },
): boolean {
  if (sent.messageId) {
    const bare = sent.messageId.replace(/^<|>$/g, '')
    if (bare && report.snippet.includes(bare)) return true
  }
  const wanted = normaliseSubject(sent.subject ?? '')
  if (wanted.length >= 4 && normaliseSubject(report.subject).includes(wanted)) return true
  return false
}

export interface TrackedSend {
  logId: string
  at: number
  subject?: string
  messageId?: string
}

/**
 * Correlate every tracked send against the cached inbox.
 *
 * Reports dated before the send are ignored outright: a bounce cannot precede
 * the message it bounced, and without that guard a weekly reminder inherits
 * last week's bounce forever.
 */
export function trackReceipts(
  sends: TrackedSend[],
  inbox: InboxMessage[],
): Map<string, ReceiptEvidence> {
  const out = new Map<string, ReceiptEvidence>()
  const reports = inbox
    .map((m) => ({ message: m, kind: classifyReport(m) }))
    .filter((r): r is { message: InboxMessage; kind: 'bounce' | 'read' } => r.kind !== null)

  for (const send of sends) {
    let best: ReceiptEvidence = { status: 'sent' }
    for (const { message, kind } of reports) {
      if (message.date < send.at) continue
      if (!reportMatches(message, send)) continue
      // A bounce outranks a read receipt: some clients send a disposition
      // notification for a message that a later hop then rejected, and "it did
      // not arrive" is the fact that needs acting on.
      if (kind === 'bounce') {
        best = {
          status: 'bounced',
          messageId: message.id,
          at: message.date,
          detail: message.snippet.slice(0, 240),
        }
        break
      }
      if (best.status === 'sent') {
        best = { status: 'read', messageId: message.id, at: message.date }
      }
    }
    out.set(send.logId, best)
  }

  return out
}

/** Pull the trackable sends out of the activity log. */
export function sendsFromLogs(logs: LogEntry[]): TrackedSend[] {
  return logs
    .filter((l) => l.kind === 'send' && l.level !== 'error')
    .map((l) => ({ logId: l.id, at: l.at, subject: l.title, messageId: l.messageId }))
}

/** Counts for the summary strip, so the screen can say "2 bounced" without recomputing. */
export function summariseReceipts(map: Map<string, ReceiptEvidence>): {
  sent: number
  read: number
  bounced: number
} {
  let sent = 0
  let read = 0
  let bounced = 0
  for (const e of map.values()) {
    if (e.status === 'bounced') bounced++
    else if (e.status === 'read') read++
    else sent++
  }
  return { sent, read, bounced }
}
