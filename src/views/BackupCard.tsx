/**
 * Export and restore, in Settings.
 *
 * Both halves are plain browser file handling rather than an IPC round trip:
 * a Blob download and a hidden `<input type="file">` work identically in the
 * desktop build, the Android build and the browser preview, and they do not
 * need a new hole in the preload bridge to exist.
 *
 * Restoring shows what is in the file *before* doing anything with it. A
 * restore is one of the few actions in this app that can quietly lose work,
 * and "12 reminders, 40 contacts, written on 2 August" is what tells someone
 * they picked last month's file by mistake.
 */

import { useRef, useState } from 'react'
import { Banner, Button, Card, CardHeader, Modal, useToast } from '../components/ui'
import { IconDownload, IconFolder } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import {
  applyBackup,
  backupFileName,
  buildBackup,
  readBackup,
  summarise,
  type BackupFile,
  type BackupSummary,
} from '../core/backup'

export function BackupCard() {
  const { state, dispatch } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ backup: BackupFile; summary: BackupSummary } | null>(null)
  const [error, setError] = useState('')

  const exportNow = () => {
    const backup = buildBackup(state, __APP_VERSION__)
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = backupFileName()
    link.click()
    // Revoking immediately can cancel the download in some builds; a tick is
    // enough for the browser to have taken the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.push({ tone: 'success', title: t('backup.exported') })
  }

  const pick = async (file: File) => {
    setError('')
    try {
      const backup = readBackup(await file.text())
      setPending({ backup, summary: summarise(backup) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const restore = (mode: 'merge' | 'replace') => {
    if (!pending) return
    dispatch({ type: 'hydrate', state: applyBackup(state, pending.backup, mode) })
    setPending(null)
    toast.push({ tone: 'success', title: t('backup.restored') })
  }

  return (
    <Card>
      <CardHeader title={t('backup.title')} hint={t('backup.hint')} />

      {/* Same body wrapper as every other settings card, so this one lays out
          on the same grid instead of on its own ad-hoc stack. */}
      <div className="card__body">
      <div className="btn-row">
        <Button icon={<IconDownload size={15} />} onClick={exportNow}>
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
            <Button onClick={() => restore('replace')}>{t('backup.replace')}</Button>
            <Button variant="primary" onClick={() => restore('merge')}>
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
    </Card>
  )
}
