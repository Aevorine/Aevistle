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
import { Banner, Button, Card, CardHeader, Modal, useToast } from '../components/ui'
import { IconDownload, IconFolder } from '../components/icons'
import { useApp } from '../state/AppState'
import { saveGeneratedFile } from '../core/download'
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

  const exportNow = async () => {
    const backup = buildBackup(state, __APP_VERSION__)
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
