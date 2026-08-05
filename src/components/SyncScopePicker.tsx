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

import { Switch } from './ui'
import { useI18n } from '../i18n'
import type { MailAccount } from '../core/types'
import type { SyncScopeKey } from '../core/syncScope'

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
              return a.hasSecret ? label : `${label} (${t('common.none')})`
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
