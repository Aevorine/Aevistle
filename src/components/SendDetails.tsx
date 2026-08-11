/**
 * What the transport actually did — the ladder it climbed, and where it got to.
 *
 * All of this was already being computed and returned in `SendResult`; none of
 * it was ever shown. That is the worst combination: the application knows it
 * connected on 587 with STARTTLS after the chosen 465 was blackholed, and the
 * person watching sees a spinner that took nine seconds for no stated reason.
 *
 * Two rules the display follows:
 *
 * - **Never invent a rung that was not tried.** Rungs past the one that
 *   succeeded are drawn as "not needed", not as "passed". Showing four green
 *   ticks for one successful connection would be a lie told in a diagram.
 * - **The user's own choice is always first**, matching `endpointLadder`, so
 *   "the one I configured" and "the one at the top" are the same thing.
 */

import { endpointLadder } from '../core/mail/transport'
import { StatusChip } from './ui'
import { IconCheck, IconAlert, IconShield } from './icons'
import { useI18n, type TranslationKey } from '../i18n'
import type { MailAccount, SendResult, TransportSecurity } from '../core/types'

/** The stages a connection passes through, in order. Mirrors `TransportDiagnostics['stage']`. */
const STAGES: Array<TransportDiagnostics['stage']> = [
  'dns',
  'connect',
  'tls',
  'greeting',
  'auth',
  'done',
]
type TransportDiagnostics = NonNullable<SendResult['diagnostics']>

export function EndpointLadder({
  account,
  result,
}: {
  account: Pick<MailAccount, 'port' | 'security' | 'autoNegotiate'>
  result: SendResult
}) {
  const { t } = useI18n()
  const rungs = endpointLadder(account.port, account.security, account.autoNegotiate)
  const diag = result.diagnostics
  /** 1-based in the diagnostics; absent means the first rung is all we know about. */
  const used = diag?.attempts ?? 1

  const label = (security: TransportSecurity) =>
    security === 'ssl' ? 'SSL/TLS' : security === 'starttls' ? 'STARTTLS' : t('account.securityNone')

  return (
    <div className="ladder">
      {rungs.map((rung, i) => {
        const isUsed = diag !== undefined && i === used - 1
        const tried = i < used
        const state = isUsed ? (result.ok ? 'ok' : 'failed') : tried ? 'failed' : 'skipped'
        return (
          <div key={`${rung.port}-${rung.security}`} className="ladder__rung" data-state={state}>
            <span className="ladder__marker">
              {state === 'ok' ? (
                <IconCheck size={13} />
              ) : state === 'failed' ? (
                <IconAlert size={13} />
              ) : null}
            </span>
            <span className="ladder__endpoint">
              :{rung.port} · {label(rung.security)}
            </span>
            <span className="ladder__note">
              {i === 0 ? t('ladder.yourChoice') : null}
              {state === 'skipped' ? t('ladder.notNeeded') : null}
              {state === 'failed' && !isUsed ? t('ladder.failed') : null}
            </span>
          </div>
        )
      })}
      {diag?.adjusted ? (
        <div className="ladder__adjusted">
          <IconShield size={13} /> {t('ladder.adjusted')}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The full account of one send, for the moment "it failed" is not enough.
 *
 * Folded away by default: on a good day none of this is interesting, and a
 * panel of protocol detail under every successful send would make the screen
 * feel like a debugger. It is one click away on the day it matters.
 */
export function SendResultDetails({
  result,
  account,
}: {
  result: SendResult
  account?: Pick<MailAccount, 'port' | 'security' | 'autoNegotiate' | 'host'>
}) {
  const { t } = useI18n()
  const diag = result.diagnostics
  const reachedIndex = diag ? STAGES.indexOf(diag.stage) : -1

  return (
    <div className="senddetails">
      {/* How far it got. A failure at `tls` and a failure at `auth` are
          different problems with different fixes, and "send failed" hides
          which one you have.
          Absent entirely without diagnostics: a row of six grey "unknown"
          pills claims a shape of knowledge that is not there — the same rule
          the ladder follows about rungs that were never tried. */}
      {diag ? (
        <div className="senddetails__stages">
          {STAGES.map((stage, i) => (
            <span
              key={stage}
              className="senddetails__stage"
              data-state={
                i < reachedIndex
                  ? 'passed'
                  : i === reachedIndex
                    ? result.ok
                      ? 'passed'
                      : 'stopped'
                    : 'notreached'
              }
            >
              {t(`stage.${stage}` as TranslationKey)}
            </span>
          ))}
        </div>
      ) : null}

      <dl className="senddetails__facts">
        {diag ? (
          <>
            <dt>{t('senddetails.endpoint')}</dt>
            <dd>
              {diag.host}:{diag.port} · {diag.securityUsed.toUpperCase()}
            </dd>
          </>
        ) : null}
        <dt>{t('senddetails.duration')}</dt>
        <dd>{t('logs.duration', { ms: result.durationMs })}</dd>
        <dt>{t('senddetails.accepted')}</dt>
        <dd>{result.accepted.length > 0 ? result.accepted.join(', ') : '—'}</dd>
        {result.rejected.length > 0 ? (
          <>
            <dt>{t('senddetails.rejected')}</dt>
            <dd className="senddetails__bad">{result.rejected.join(', ')}</dd>
          </>
        ) : null}
        {result.messageId ? (
          <>
            <dt>{t('senddetails.messageId')}</dt>
            {/* The one durable handle for correlating a bounce later — see `core/receipts`. */}
            <dd className="mono">{result.messageId}</dd>
          </>
        ) : null}
        {result.error ? (
          <>
            <dt>{t('senddetails.error')}</dt>
            <dd className="mono senddetails__bad">{result.error}</dd>
          </>
        ) : null}
      </dl>

      {account && diag ? (
        <>
          <div className="section-label">{t('ladder.title')}</div>
          <EndpointLadder account={account} result={result} />
        </>
      ) : null}

      {result.skipped && result.skipReasonKey ? (
        <StatusChip
          tone="info"
          label={t(result.skipReasonKey as TranslationKey, result.skipReasonValues)}
        />
      ) : null}
    </div>
  )
}
