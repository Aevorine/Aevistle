/**
 * Export and restore, in Settings.
 *
 * Importing is plain browser file handling — a hidden `<input type="file">`
 * needs no new hole in the preload bridge.
 *
 * Exporting used to make the same claim, and it was wrong. A Blob download
 * does *not* behave identically across the three builds: in the packaged
 * desktop app it saved as `<random-guid>.tmp` with the suggested name thrown
 * away (so the file could not even be picked back up by the importer above,
 * which filters on `.aevistle`), and in the Android WebView it does nothing at
 * all. `core/download.ts` handles that spread — the shell now owns the save
 * dialog and reports back, and Android says so rather than pretending.
 *
 * Restoring shows what is in the file *before* doing anything with it. A
 * restore is one of the few actions in this app that can quietly lose work,
 * and "12 reminders, 40 contacts, written on 2 August" is what tells someone
 * they picked last month's file by mistake.
 */

import { useRef, useState } from 'react'
import { Banner, Button, Card, CardHeader, Field, Modal, Switch, useToast } from '../components/ui'
import { IconDownload, IconFolder } from '../components/icons'
import { useApp } from '../state/AppState'
import { saveGeneratedFile } from '../core/download'
import { copyText } from '../core/clipboard'
import { useI18n } from '../i18n'
import {
  applyBackup,
  backupFileName,
  buildBackup,
  openBackupSecrets,
  readBackup,
  sealBackupSecrets,
  summarise,
  type BackupFile,
  type BackupSummary,
} from '../core/backup'

export function BackupCard() {
  const { state, dispatch, bridge } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ backup: BackupFile; summary: BackupSummary } | null>(null)
  const [error, setError] = useState('')
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('')
  const [recoveryKeyShown, setRecoveryKeyShown] = useState<string | null>(null)

  /** Only accounts that actually hold a password on this machine are worth
   *  sealing — everything else would just be an empty envelope. */
  const accountIdsWithSecret = state.accounts.filter((a) => a.hasSecret).map((a) => a.id)
  const canSealPasswords = Boolean(bridge?.sealAccountSecrets) && accountIdsWithSecret.length > 0
  const [includePasswords, setIncludePasswords] = useState(true)

  const exportNow = async () => {
    let secrets: BackupFile['secrets']
    let recoveryKey: string | null = null
    // Sealed before the file is built, not after: a failed seal should not
    // silently produce a backup that looks like it carries passwords and
    // does not.
    if (includePasswords && canSealPasswords && bridge) {
      const sealed = await sealBackupSecrets(bridge, accountIdsWithSecret)
      if (sealed) {
        secrets = sealed.secrets
        recoveryKey = sealed.recoveryKey
      }
    }
    const backup: BackupFile = { ...buildBackup(state, __APP_VERSION__), ...(secrets ? { secrets } : {}) }
    // The toast waits for the shell's verdict. It used to fire on the click,
    // which said "exported" even when the save dialog was cancelled — and
    // that false success is part of why this feature read as broken.
    const { outcome, unsupported } = await saveGeneratedFile(
      JSON.stringify(backup, null, 2),
      backupFileName(),
    )
    if (unsupported) {
      toast.push({ tone: 'error', title: t('download.androidUnsupported') })
      return
    }
    if (!outcome) {
      toast.push({ tone: 'success', title: t('backup.exported') })
      if (recoveryKey) setRecoveryKeyShown(recoveryKey)
      return
    }
    if (outcome.cancelled) {
      toast.push({ tone: 'info', title: t('download.cancelled') })
      return
    }
    toast.push(
      outcome.ok
        ? { tone: 'success', title: t('backup.exported'), detail: outcome.name }
        : { tone: 'error', title: t('download.failed'), detail: outcome.name },
    )
    // Shown only once the file actually landed — a recovery key for a backup
    // that was never written would just be a key to nothing.
    if (outcome.ok && recoveryKey) setRecoveryKeyShown(recoveryKey)
  }

  const pick = async (file: File) => {
    setError('')
    setRecoveryKeyInput('')
    try {
      const backup = readBackup(await file.text())
      setPending({ backup, summary: summarise(backup) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const restore = async (mode: 'merge' | 'replace') => {
    if (!pending) return
    const restored = applyBackup(state, pending.backup, mode)
    dispatch({ type: 'hydrate', state: restored })

    const key = recoveryKeyInput.trim()
    if (key && pending.backup.secrets && bridge) {
      const written = await openBackupSecrets(bridge, key, pending.backup.secrets)
      if (written.length > 0) {
        const writtenIds = new Set(written)
        // A second, narrower hydrate rather than folding this into the one
        // above: `restored` is computed before the (async) unsealing even
        // starts, so `hasSecret` has to be patched onto it afterwards rather
        // than baked in up front.
        dispatch({
          type: 'hydrate',
          state: {
            ...restored,
            accounts: restored.accounts.map((a) => (writtenIds.has(a.id) ? { ...a, hasSecret: true } : a)),
          },
        })
        toast.push({ tone: 'success', title: t('backup.passwordsRestored', { n: written.length }) })
      } else {
        toast.push({ tone: 'error', title: t('backup.passwordsWrongKey') })
      }
    }

    setPending(null)
    setRecoveryKeyInput('')
    toast.push({ tone: 'success', title: t('backup.restored') })
  }

  return (
    <Card>
      <CardHeader title={t('backup.title')} hint={t('backup.hint')} />

      {/* Same body wrapper as every other settings card, so this one lays out
          on the same grid instead of on its own ad-hoc stack. */}
      <div className="card__body">
      {/* Only offered where sealing is possible and there is at least one
          password worth sealing — a toggle that would always come back
          empty is worse than no toggle. */}
      {canSealPasswords ? (
        <Switch
          checked={includePasswords}
          onChange={setIncludePasswords}
          title={t('backup.includePasswords')}
          description={t('backup.includePasswordsHint')}
        />
      ) : null}
      <div className="btn-row">
        <Button icon={<IconDownload size={15} />} onClick={() => void exportNow()}>
          {t('backup.export')}
        </Button>
        <Button icon={<IconFolder size={15} />} onClick={() => fileInput.current?.click()}>
          {t('backup.import')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".aevistle,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Cleared so picking the same file twice in a row still fires.
            e.target.value = ''
            if (file) void pick(file)
          }}
        />
      </div>

      {error ? (
        <Banner tone="danger" title={t('backup.cannotRead')}>
          {error}
        </Banner>
      ) : null}
      </div>

      <Modal
        open={pending !== null}
        title={t('backup.confirmTitle')}
        onClose={() => setPending(null)}
        closeLabel={t('common.cancel')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void restore('replace')}>{t('backup.replace')}</Button>
            <Button variant="primary" onClick={() => void restore('merge')}>
              {t('backup.merge')}
            </Button>
          </>
        }
      >
        {pending ? (
          <>
            <div className="log__detail">
              {t('backup.writtenOn', {
                app: pending.summary.app,
                when: pending.summary.createdAt ? formatDateTime(pending.summary.createdAt) : '—',
              })}
            </div>
            <ul className="prose">
              <li>{t('backup.countAccounts', { n: pending.summary.accounts })}</li>
              <li>{t('backup.countJobs', { n: pending.summary.jobs })}</li>
              <li>{t('backup.countContacts', { n: pending.summary.contacts })}</li>
              <li>{t('backup.countTemplates', { n: pending.summary.templates })}</li>
            </ul>

            {/* Only when this platform can even open a sealed envelope — a
                text field promising auto-import on a build that cannot do it
                would be a control that lies about what it does. */}
            {pending.summary.securedPasswords > 0 && bridge?.openAccountSecrets ? (
              <>
                <Banner
                  tone="info"
                  title={t('backup.securedPasswordsTitle', { n: pending.summary.securedPasswords })}
                >
                  {t('backup.securedPasswordsHint')}
                </Banner>
                <Field label={t('backup.recoveryKeyInputLabel')} hint={t('backup.recoveryKeyInputHint')}>
                  <input
                    className="input"
                    value={recoveryKeyInput}
                    onChange={(e) => setRecoveryKeyInput(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </Field>
              </>
            ) : null}

            {/* Said before the restore, not discovered after it. */}
            {pending.summary.needPassword > 0 ? (
              <Banner tone="warning" title={t('backup.passwordsTitle')}>
                {t('backup.passwordsHint', { n: pending.summary.needPassword })}
              </Banner>
            ) : null}
            {pending.summary.jobsWithAttachments > 0 ? (
              <Banner tone="info" title={t('backup.attachmentsTitle')}>
                {t('backup.attachmentsHint', { n: pending.summary.jobsWithAttachments })}
              </Banner>
            ) : null}
            <p className="log__detail">{t('backup.modeHint')}</p>
          </>
        ) : null}
      </Modal>

      {/* A separate dialog from the export button's toast: the key is the
          one thing here that cannot be fetched again if this closes without
          it being saved, so it gets its own modal rather than a line in a
          toast that times out. */}
      <Modal
        open={recoveryKeyShown !== null}
        title={t('backup.recoveryKeyTitle')}
        onClose={() => setRecoveryKeyShown(null)}
        closeLabel={t('common.close')}
        footer={
          <Button variant="primary" onClick={() => setRecoveryKeyShown(null)}>
            {t('backup.recoveryKeyDone')}
          </Button>
        }
      >
        {recoveryKeyShown ? (
          <>
            <p className="log__detail">{t('backup.recoveryKeyHint')}</p>
            <div className="recoverykey">
              <code className="recoverykey__value">{recoveryKeyShown}</code>
              <Button
                variant="ghost"
                onClick={() => {
                  void copyText(recoveryKeyShown).then((ok) => {
                    if (ok) toast.push({ tone: 'success', title: t('backup.recoveryKeyCopied') })
                  })
                }}
              >
                {t('backup.recoveryKeyCopy')}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </Card>
  )
}
