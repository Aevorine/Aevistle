/**
 * The self-check, as a screen.
 *
 * All this does is collect facts and hand them to `core/selfcheck.ts`, which
 * owns every judgement. See that module for why the split exists — the short
 * version is that a diagnostic nobody can test is a diagnostic nobody should
 * believe, and the collection below is the only part that needs a device.
 *
 * Two rules about the collection worth stating, because both are easy to get
 * wrong in a way that makes the panel lie:
 *
 *   - **A probe that throws is a fact, not an exception.** Every bridge call is
 *     wrapped, and a rejection becomes `{ ok: false, error }` rather than
 *     aborting the run. A self-check that stops at the first failure is a
 *     self-check that can only ever report one thing, and the thing it reports
 *     is the thing the user already knew.
 *
 *   - **Nothing is judged from the absence of an answer.** A probe that was not
 *     run leaves its fact `undefined`, which the core turns into `skip`. The
 *     tempting shortcut — default to `false` and let it read as a failure — is
 *     how a panel ends up confidently blaming SMTP on a build that never called
 *     SMTP.
 */

import { useCallback, useState } from 'react'
import { getBridge } from '../core/bridge'
import type { AndroidPermissionApi } from '../core/bridge-android'
import { oauthState } from '../core/oauth'
import {
  missingAccountFields,
  runSelfCheck,
  summarise,
  type AccountFacts,
  type SelfCheckFacts,
  type SelfCheckRow,
  type SelfCheckStatus,
} from '../core/selfcheck'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { Button, Card, CardHeader } from './ui'

const STATUS_LABEL: Record<SelfCheckStatus, 'selfcheck.pass' | 'selfcheck.warn' | 'selfcheck.fail' | 'selfcheck.skip'> =
  {
    pass: 'selfcheck.pass',
    warn: 'selfcheck.warn',
    fail: 'selfcheck.fail',
    skip: 'selfcheck.skip',
  }

/** Run `probe`, and turn any failure into the string the panel will show. */
async function attempt(probe: () => Promise<{ ok: boolean; error?: string }>): Promise<{
  ok: boolean
  error?: string
}> {
  try {
    return await probe()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function SelfCheckPanel(): React.ReactElement {
  const { t } = useI18n()
  const { state } = useApp()
  const [rows, setRows] = useState<SelfCheckRow[] | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    try {
      const bridge = await getBridge()
      const platform = bridge.platform

      /*
       * The bridge is probed with a call that has to reach Java and come back
       * with something, rather than by checking whether a method *exists*. On
       * the failure this whole panel was written for, the JavaScript object is
       * fully formed and every method is present — it is the plugin behind them
       * that never registered, so `typeof bridge.hasSecret === 'function'` is
       * true and useless. Only a round trip can tell the two apart.
       */
      let native: SelfCheckFacts['native'] = 'ok'
      let nativeError: string | undefined
      let permissions: SelfCheckFacts['permissions']
      if (platform === 'android') {
        const android = bridge as Partial<AndroidPermissionApi>
        try {
          if (!android.permissionState) {
            native = 'missing'
          } else {
            const p = await android.permissionState()
            permissions = { notifications: p.notifications, exactAlarms: p.exactAlarms }
          }
        } catch (e) {
          native = 'error'
          nativeError = e instanceof Error ? e.message : String(e)
        }
      }

      const accounts: AccountFacts[] = []
      for (const account of state.accounts) {
        const inbox = state.inboxAccounts.find((i) => i.accountId === account.id)
        const imapConfigured = Boolean(inbox?.enabled && inbox.imapHost?.trim())
        const facts: AccountFacts = {
          id: account.id,
          label: account.label || account.fromAddress || account.id,
          authMethod: account.authMethod,
          missingFields: missingAccountFields(account),
          imapConfigured,
        }

        if (account.authMethod === 'oauth2') {
          try {
            facts.oauthState = bridge.oauthStatus
              ? (await bridge.oauthStatus(account.id, account.providerId ?? '')).state
              : oauthState(account.providerId, false, false, platform === 'android' ? 'android' : 'desktop')
          } catch {
            // Left undefined — see the module doc. "We could not ask" is not
            // the same fact as "there is no grant", and only one of them is true.
          }
        } else if (account.authMethod === 'password') {
          try {
            facts.hasSecret = await bridge.hasSecret(account.id, 'smtp')
          } catch {
            /* same reasoning: undefined means unasked, and reads as `skip` */
          }
        }

        /*
         * The live probes are skipped when a layer beneath them is already
         * down, and when the account is missing the fields the probe would need
         * to even build a connection. Running them anyway would produce a
         * second, louder, less accurate description of a fault already reported
         * one row above.
         */
        const canProbe = native === 'ok' && facts.missingFields.length === 0
        if (canProbe) {
          facts.smtp = await attempt(async () => {
            const result = await bridge.testConnection(account)
            return { ok: result.ok, error: result.ok ? undefined : result.error }
          })
          if (imapConfigured && bridge.testInbox && inbox) {
            facts.imap = await attempt(async () => {
              const result = await bridge.testInbox!(inbox)
              return { ok: result.ok, error: result.ok ? undefined : result.error }
            })
          }
        }

        accounts.push(facts)
      }

      const enabled = state.jobs.filter((j) => j.enabled)
      setRows(
        runSelfCheck({
          platform,
          native,
          nativeError,
          permissions,
          accounts,
          enabledJobs: enabled.length,
          armedJobs: enabled.filter((j) => (j.occurrences?.length ?? 0) > 0).length,
          deadOutbox: state.outbox.filter((o) => o.status === 'failed').length,
        }),
      )
    } finally {
      setBusy(false)
    }
  }, [state.accounts, state.inboxAccounts, state.jobs, state.outbox])

  const summary = rows ? summarise(rows) : null

  /*
   * A `Card`, like every other Home feature dialog. Not decoration: the four
   * neighbours all sit in one, and a diagnostic that arrived in a bare frame
   * would read as a different *kind* of thing — a debug screen that escaped —
   * on the one occasion the user is least inclined to trust what they see.
   */
  return (
    <Card className="selfcheck" >
      <CardHeader title={t('selfcheck.title')} hint={t('selfcheck.intro')} />
      <div data-view="selfcheck">
      <p className="field__hint">{t('selfcheck.live')}</p>

      <Button onClick={() => void run()} disabled={busy} data-testid="selfcheck-run">
        {busy ? t('selfcheck.running') : rows ? t('selfcheck.rerun') : t('selfcheck.run')}
      </Button>

      {summary ? (
        <div className="selfcheck__summary" role="status">
          {summary.fail === 0 && summary.warn === 0
            ? t('selfcheck.allClear')
            : t('selfcheck.summary', {
                pass: summary.pass,
                warn: summary.warn,
                fail: summary.fail,
                skip: summary.skip,
              })}
        </div>
      ) : null}

      {rows ? (
        <ul className="selfcheck__list">
          {rows.map((row) => (
            <li key={row.id} className="selfcheck__row" data-status={row.status} data-check={row.id}>
              <span className="selfcheck__badge" data-status={row.status}>
                {t(STATUS_LABEL[row.status])}
              </span>
              <div className="selfcheck__body">
                <div className="selfcheck__label">
                  {t(row.labelKey)}
                  {row.accountLabel ? <span className="chip">{row.accountLabel}</span> : null}
                </div>
                {/* The server's own words, in a monospace block so they read as
                    machine output rather than as this app's advice. */}
                {row.detail ? <div className="selfcheck__detail mono">{row.detail}</div> : null}
                {row.hintKey ? <div className="selfcheck__hint">{t(row.hintKey)}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      </div>
    </Card>
  )
}
