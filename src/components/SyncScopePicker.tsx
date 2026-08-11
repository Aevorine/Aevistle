/**
 * Which parts of this install to offer another device.
 *
 * One row per `SyncScopeKey`, each a plain `Switch` — the same control
 * Settings already uses for every other on/off choice — with a one-line
 * consequence under it, so nobody checks "accounts" not knowing that can mean
 * a password leaving this machine. Deliberately dumb, like `PairingQr.tsx`: it
 * owns no session state, just a set of chosen scopes and a way to change it.
 * What is actually done with that set — building a `ScopePayload`
 * (`core/syncScope.ts`) or a pairing file (`core/pairingFile.ts`) — is the
 * caller's job.
 */

import { needsStoredPassword } from '../core/mail/accounts'
import { Switch } from './ui'
import { useI18n } from '../i18n'
import type { MailAccount } from '../core/types'
import type { SyncScopeKey } from '../core/sync/syncScope'

export interface SyncScopePickerProps {
  scopes: ReadonlySet<SyncScopeKey>
  onChange: (scopes: Set<SyncScopeKey>) => void
  accounts: MailAccount[]
  jobsCount: number
  contactsCount: number
  templatesCount: number
}

export function SyncScopePicker({
  scopes,
  onChange,
  accounts,
  jobsCount,
  contactsCount,
  templatesCount,
}: SyncScopePickerProps) {
  const { t } = useI18n()

  const toggle = (key: SyncScopeKey, on: boolean) => {
    const next = new Set(scopes)
    if (on) next.add(key)
    else next.delete(key)
    onChange(next)
  }

  return (
    <div className="scopepick">
      <div className="section-label">{t('sync.scope.title')}</div>

      <Switch
        checked={scopes.has('accounts')}
        onChange={(v) => toggle('accounts', v)}
        title={t('sync.scope.accounts')}
        description={t('sync.scope.accountsHint', { n: accounts.length })}
      />
      {scopes.has('accounts') && accounts.length > 0 ? (
        // Named, not just counted — a password is about to travel, and "3
        // accounts" does not say which three.
        <div className="field__hint">
          {accounts
            .map((a: MailAccount) => {
              const label = a.label || a.fromAddress
              /*
               * Three states, not two. An OAuth2 account is not an account with
               * no credential — it has one, and it is deliberately *not* being
               * sent: `sealAccountSecrets` carries the `smtp` and `imap` kinds
               * only. That is the right call and would be even if it were not,
               * because a Google refresh token is bound to the client id that
               * minted it and Android's client is not the desktop's, so a
               * transferred grant would be refused by the provider.
               *
               * What was wrong was saying "(none)" about it. The user reads
               * that as "this account has no password", pairs, and finds a
               * mailbox on the new device that cannot send and never said why.
               * Naming it as a sign-in that has to be done again turns a silent
               * surprise into a one-line instruction.
               */
              if (a.authMethod === 'oauth2') return `${label} (${t('sync.scope.signInAgain')})`
              return needsStoredPassword(a) ? `${label} (${t('common.none')})` : label
            })
            .join(' · ')}
        </div>
      ) : null}

      <Switch
        checked={scopes.has('schedule')}
        onChange={(v) => toggle('schedule', v)}
        title={t('sync.scope.schedule')}
        description={t('sync.scope.scheduleHint', { n: jobsCount })}
      />

      <Switch
        checked={scopes.has('contacts')}
        onChange={(v) => toggle('contacts', v)}
        title={t('sync.scope.contacts')}
        description={t('sync.scope.contactsHint', { n: contactsCount })}
      />

      <Switch
        checked={scopes.has('templates')}
        onChange={(v) => toggle('templates', v)}
        title={t('sync.scope.templates')}
        description={t('sync.scope.templatesHint', { n: templatesCount })}
      />

      <Switch
        checked={scopes.has('appearance')}
        onChange={(v) => toggle('appearance', v)}
        title={t('sync.scope.appearance')}
        description={t('sync.scope.appearanceHint')}
      />

      {scopes.size === 0 ? (
        <div className="field__hint field__hint--error">{t('sync.scope.selectAtLeastOne')}</div>
      ) : null}
    </div>
  )
}
