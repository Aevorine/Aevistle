/**
 * Send preview — what is about to leave, before it leaves.
 *
 * "Send" is the one button in this application with no undo. Everything else
 * can be edited, paused or deleted; a message that has reached the server is
 * gone. So this builds the whole picture from the same inputs the transport
 * will use: the resolved envelope, the merged text for a real recipient, the
 * attachments as they exist *on disk right now*, the byte count after
 * encoding, and every warning that is worth a second of someone's attention.
 *
 * It is a pure function over the draft. Nothing here sends, and nothing here
 * mutates the draft — a preview that changed what you were previewing would be
 * worse than no preview.
 */

import { needsStoredPassword } from './accounts'
import { evaluateConditions, type ConditionContext, type SendCondition } from '../schedule/conditions'
import { buildMergeMessages, hasVars, type MergeMessage } from './mergeVars'
import { oauthConfigProblem, type OAuthConnectionState } from './oauth'
import { attachmentLimitBytes, providerById } from './providers'
import { isQuiet, type QuietHours } from '../schedule/schedule'
import type { IsoDate, WorkCalendar } from '../schedule/workCalendar'
import type { Attachment, Contact, MailAccount, MessageDraft } from '../types'
import { encodedSize, isRiskyAttachment, hasDeceptiveName, totalAttachmentBytes } from './validate'

export interface PreflightWarning {
  /** Translation key. */
  key: string
  values?: Record<string, string | number>
  severity: 'info' | 'warning' | 'error'
}

export interface PreflightAttachment {
  attachment: Attachment
  /** `undefined` when the platform could not be asked (browser build). */
  present?: boolean
}

export interface PreflightReport {
  /** Envelope sender, exactly as it will appear. */
  from: string
  /** Where it connects and how — the two facts a bounce postmortem needs. */
  host: string
  port: number
  security: string

  /** One entry per message that will actually be handed to the server. */
  messages: MergeMessage[]
  /** How many separate messages this send produces. */
  messageCount: number
  /** Distinct addresses that will receive it, across To/Cc/Bcc. */
  recipientCount: number
  /** Addresses outside the sender's own domain — the ones a mistake is public in. */
  externalCount: number

  attachments: PreflightAttachment[]
  rawBytes: number
  /** Bytes after base64, which is what the provider's limit is measured in. */
  wireBytes: number
  limitBytes: number

  warnings: PreflightWarning[]
  /** True when at least one warning is fatal — the send button stays disabled. */
  blocked: boolean

  /** Only set for a scheduled send: when it would really go out. */
  heldUntil?: number
  /** Only set when the job carries conditions: what they say right now. */
  conditionReasonKey?: string
  conditionReasonValues?: Record<string, string | number>
}

export interface PreflightOptions {
  contacts: Contact[]
  /** Expand `{{name}}` per recipient rather than sending one shared message. */
  merge: boolean
  attachmentWarnMb: number
  attachmentMaxMb: number
  bulkConfirmThreshold: number
  quiet?: QuietHours
  /** Present on desktop; absent in the browser build, where fs is unreachable. */
  fileExists?: (path: string) => boolean
  /** Set when previewing a scheduled job rather than an immediate send. */
  scheduledFor?: number
  conditions?: SendCondition[]
  conditionContext?: Partial<ConditionContext>
  now?: number
  locale?: string
  /**
   * Supplies the calendar merge variables, so the preview shows the same text
   * the recipient will get. Omitting it leaves `{{nextWorkday}}` standing as a
   * token in the preview — which is the correct warning, not a bug.
   */
  calendar?: WorkCalendar
  holidayNames?: Map<IsoDate, string>
  /**
   * What the trusted layer says about this account's OAuth2 grant, from
   * `bridge.oauthStatus`.
   *
   * Only meaningful for `authMethod: 'oauth2'`, and optional so every existing
   * caller keeps the behaviour it had. Supplying it is what turns "the send
   * will fail at 03:00 and nobody will know why" into a red line on the preview
   * — see the `needsConsent` branch below for why nothing else in the app can
   * see that state.
   */
  oauthState?: OAuthConnectionState
}

function domainOf(address: string): string {
  return (address.split('@')[1] ?? '').toLowerCase()
}

export function buildPreflight(
  draft: MessageDraft,
  account: MailAccount | undefined,
  opts: PreflightOptions,
): PreflightReport {
  const now = opts.now ?? Date.now()
  const warnings: PreflightWarning[] = []

  const messages = buildMergeMessages(draft, opts.contacts, {
    enabled: opts.merge,
    // The preview is of the message as it will be *sent*, so the calendar
    // variables have to resolve against the send time, not against now.
    now: opts.scheduledFor ?? now,
    locale: opts.locale,
    calendar: opts.calendar,
    holidayNames: opts.holidayNames,
  })

  const allRecipients = [...new Set([...draft.to, ...draft.cc, ...draft.bcc])]
  const ownDomain = domainOf(account?.fromAddress ?? '')
  const externalCount = ownDomain
    ? allRecipients.filter((a) => domainOf(a) !== ownDomain).length
    : allRecipients.length

  // `individualDelivery` and merge both produce one message per To: entry; the
  // transport does the former, this file does the latter. Counting them the
  // same way is what makes "23 messages will be sent" true in both cases.
  const messageCount = opts.merge
    ? messages.length
    : draft.individualDelivery
      ? Math.max(1, draft.to.length)
      : 1

  const attachments: PreflightAttachment[] = draft.attachments.map((a) => ({
    attachment: a,
    present: opts.fileExists ? opts.fileExists(a.path) : undefined,
  }))

  const rawBytes = totalAttachmentBytes(draft.attachments)
  const wireBytes = encodedSize(rawBytes)
  const limitBytes = attachmentLimitBytes(account?.providerId, opts.attachmentMaxMb)

  // --- warnings, in the order someone would want to read them --------------

  if (!account) {
    warnings.push({ key: 'preflight.warn.noAccount', severity: 'error' })
  } else if (account.authMethod === 'oauth2') {
    /*
     * "There is a credential" and "the credential still works" are different
     * questions, and until now only the first was ever asked.
     *
     * `hasSecret` cannot answer either one here. It reports on the `smtp`
     * keystore entry, and an OAuth2 account's grant lives under a different key
     * (see `electron/oauth.ts`), so `hasSecret` is false for a perfectly
     * connected account — reusing the branch below would block every OAuth send
     * with "no password saved".
     *
     * So the state comes from `opts.oauthState`, which the caller gets from the
     * trusted layer, and the two build-level problems are derived here because
     * they are true without asking anyone. A caller that supplies nothing gets
     * no warning rather than a guess: a false "not connected" on a working
     * account would stop mail that was going to be delivered, which is a worse
     * outcome than the silent failure this is meant to replace.
     */
    const state = opts.oauthState ?? oauthConfigProblem(account.providerId)
    if (state === 'unsupported') {
      warnings.push({ key: 'preflight.warn.oauthUnsupported', severity: 'error' })
    } else if (state === 'unconfigured') {
      warnings.push({ key: 'preflight.warn.oauthUnconfigured', severity: 'error' })
    } else if (state === 'needsConsent') {
      // The whole reason this file grew a notion of a stale credential. A
      // revoked refresh token is indistinguishable from a working one by every
      // other check in the app, and the first symptom without this is a
      // scheduled send that failed at an hour nobody was watching.
      warnings.push({ key: 'preflight.warn.oauthNeedsConsent', severity: 'error' })
    } else if (state === 'disconnected') {
      warnings.push({ key: 'preflight.warn.oauthNotConnected', severity: 'error' })
    }
    // Reached only for non-OAuth accounts, so this was already correct — it
    // uses the shared predicate now so the three call sites cannot drift apart
    // again, which is how the other two came to be wrong.
  } else if (needsStoredPassword(account)) {
    warnings.push({ key: 'preflight.warn.noPassword', severity: 'error' })
  }

  if (allRecipients.length === 0) {
    warnings.push({ key: 'preflight.warn.noRecipients', severity: 'error' })
  }

  const missingFiles = attachments.filter((a) => a.present === false)
  if (missingFiles.length > 0) {
    warnings.push({
      key: 'preflight.warn.missingFiles',
      values: { names: missingFiles.map((a) => a.attachment.name).join('、') },
      severity: 'error',
    })
  }

  if (wireBytes > limitBytes) {
    warnings.push({
      key: 'preflight.warn.tooBig',
      values: { limit: Math.round(limitBytes / 1048576) },
      severity: 'error',
    })
  } else if (rawBytes > opts.attachmentWarnMb * 1048576) {
    warnings.push({
      key: 'preflight.warn.large',
      values: { mb: opts.attachmentWarnMb },
      severity: 'warning',
    })
  }

  // Unfilled variables are the mail-merge failure everyone has received at
  // least once: "Dear {{name}},". Fatal *only when merging* — that is when the
  // application has promised to fill them in and cannot. With merging off,
  // `{{like this}}` is text the user typed and may well have meant, so it gets
  // the one warning below and no more: refusing to send someone's literal
  // braces would be the tool overruling them about their own message.
  const unfilled = [...new Set(messages.flatMap((m) => m.missing))]
  if (opts.merge && unfilled.length > 0) {
    warnings.push({
      key: 'preflight.warn.unfilledVars',
      values: { names: unfilled.map((n) => `{{${n}}}`).join(' ') },
      severity: 'error',
    })
  } else if (!opts.merge && hasVars(draft)) {
    warnings.push({ key: 'preflight.warn.varsWithoutMerge', severity: 'warning' })
  }

  if (draft.subject.trim().length === 0) {
    warnings.push({ key: 'preflight.warn.noSubject', severity: 'warning' })
  }
  if (draft.body.trim().length === 0) {
    warnings.push({ key: 'preflight.warn.emptyBody', severity: 'warning' })
  }

  if (allRecipients.length > opts.bulkConfirmThreshold) {
    warnings.push({
      key: 'preflight.warn.bulk',
      values: { n: allRecipients.length },
      severity: 'warning',
    })
  }
  // Everyone visible to everyone else. Only worth saying when it is a group:
  // two colleagues on the same thread is not a privacy incident.
  if (!opts.merge && !draft.individualDelivery && draft.to.length + draft.cc.length > 5) {
    warnings.push({
      key: 'preflight.warn.addressesVisible',
      values: { n: draft.to.length + draft.cc.length },
      severity: 'warning',
    })
  }
  if (externalCount > 0 && ownDomain) {
    warnings.push({
      key: 'preflight.warn.external',
      values: { n: externalCount, domain: ownDomain },
      severity: 'info',
    })
  }

  for (const a of draft.attachments) {
    if (isRiskyAttachment(a.name)) {
      warnings.push({
        key: 'preflight.warn.riskyAttachment',
        values: { name: a.name },
        severity: 'warning',
      })
    }
    if (hasDeceptiveName(a.name)) {
      warnings.push({
        key: 'preflight.warn.deceptiveName',
        values: { name: a.name },
        severity: 'warning',
      })
    }
  }

  const preset = providerById(account?.providerId)
  if (preset?.dailyLimit && messageCount > preset.dailyLimit) {
    warnings.push({
      key: 'preflight.warn.overDailyLimit',
      values: { n: messageCount, limit: preset.dailyLimit },
      severity: 'warning',
    })
  }

  // --- scheduled-only facts -----------------------------------------------

  let heldUntil: number | undefined
  if (opts.scheduledFor !== undefined && opts.quiet?.enabled && isQuiet(opts.scheduledFor, opts.quiet)) {
    warnings.push({
      key: 'preflight.warn.quietHours',
      values: { until: opts.quiet.end },
      severity: 'info',
    })
    heldUntil = opts.scheduledFor
  }

  let conditionReasonKey: string | undefined
  let conditionReasonValues: Record<string, string | number> | undefined
  if (opts.conditions && opts.conditions.length > 0) {
    const verdict = evaluateConditions(opts.conditions, draft, {
      now,
      fileExists: opts.fileExists,
      ...opts.conditionContext,
    })
    if (!verdict.send) {
      conditionReasonKey = verdict.reasonKey
      conditionReasonValues = verdict.reasonValues
      warnings.push({
        key: 'preflight.warn.conditionBlocks',
        severity: 'info',
      })
    }
  }

  return {
    from: account ? `${account.fromName} <${account.fromAddress}>`.trim() : '',
    host: account?.host ?? '',
    port: account?.port ?? 0,
    security: account?.security ?? 'ssl',
    messages,
    messageCount,
    recipientCount: allRecipients.length,
    externalCount,
    attachments,
    rawBytes,
    wireBytes,
    limitBytes,
    warnings,
    blocked: warnings.some((w) => w.severity === 'error'),
    heldUntil,
    conditionReasonKey,
    conditionReasonValues,
  }
}
