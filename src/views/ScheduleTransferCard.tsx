/**
 * Taking reminders to another machine.
 *
 * Distinct from the full backup card next to it, and worth having separately:
 * a backup is everything, restored onto the same install after something went
 * wrong. This is a handful of schedules moved onto a *different* install —
 * where the accounts are different, the file paths are different, and carrying
 * either across would produce reminders that look armed and cannot send.
 *
 * So the import asks two things a backup never has to: which local account
 * these belong to, and what to do about attachments that are not on this
 * machine. Both are answered before anything is written.
 */

import { useRef, useState } from 'react'
import { Button, Card, CardHeader, Field, StatusChip, useToast } from '../components/ui'
import { IconDownload, IconFolder } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { accountLabel } from '../core/accounts'
import { exportJobs, materialise, parseImport, type ParsedImport } from '../core/jobTransfer'

declare const __APP_VERSION__: string

function fileName(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `aevistle-reminders-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}.json`
}

export function ScheduleTransferCard() {
  const { state, dispatch, bridge } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  const [parsed, setParsed] = useState<ParsedImport | null>(null)
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [accountId, setAccountId] = useState('')
  const [error, setError] = useState('')

  const exportNow = () => {
    if (state.jobs.length === 0) return
    const file = exportJobs(state.jobs, __APP_VERSION__)
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName()
    link.click()
    // Revoking immediately can cancel the download in some builds.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.push({ tone: 'success', title: t('transfer.exported', { n: state.jobs.length }) })
  }

  const pick = async (file: File) => {
    setError('')
    setParsed(null)
    try {
      const result = parseImport(await file.text())
      setParsed(result)
      setAccountId(state.accounts[0]?.id ?? '')
      /*
       * Which attachments are actually here, checked *before* importing rather
       * than discovered at send time.
       *
       * This is the difference between "three of these files are not on this
       * machine, they will be left out" and a reminder that fires next month
       * and silently sends an empty message — which is the failure this whole
       * application is built to avoid.
       */
      if (bridge?.checkFiles && result.attachmentPaths.length > 0) {
        const presence = await bridge.checkFiles(result.attachmentPaths)
        setMissing(new Set(result.attachmentPaths.filter((p) => !presence[p])))
      } else {
        setMissing(new Set())
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      setError(t(`transfer.error.${reason}` as 'transfer.error.not-json'))
    }
  }

  const doImport = () => {
    if (!parsed || !accountId) return
    const { jobs, droppedAttachments } = materialise(
      parsed,
      accountId,
      (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      missing,
    )
    for (const job of jobs) dispatch({ type: 'upsertJob', job })
    setParsed(null)
    setMissing(new Set())
    toast.push({
      tone: 'success',
      title: t('transfer.imported', { n: jobs.length }),
      detail:
        droppedAttachments > 0 ? t('transfer.droppedAttachments', { n: droppedAttachments }) : undefined,
    })
  }

  return (
    <Card>
      <CardHeader title={t('transfer.title')} hint={t('transfer.hint')} />
      <div className="card__body form-rows">
        <div className="btn-row">
          <Button
            icon={<IconDownload size={15} />}
            onClick={exportNow}
            disabled={state.jobs.length === 0}
          >
            {t('transfer.export', { n: state.jobs.length })}
          </Button>
          <Button icon={<IconFolder size={15} />} onClick={() => fileInput.current?.click()}>
            {t('transfer.import')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Cleared so picking the same file twice in a row still fires.
              e.target.value = ''
              if (file) void pick(file)
            }}
          />
        </div>

        {/* Said plainly rather than left to be discovered: this file is safe to
            keep in a backup, and that is only true because of what it omits. */}
        <div className="field__hint">{t('transfer.noCredentials')}</div>

        {error ? <div className="field__hint field__hint--error">{error}</div> : null}

        {parsed ? (
          <>
            <Field label={t('transfer.found')}>
              <div className="btn-row">
                <StatusChip tone="accent" label={t('transfer.foundN', { n: parsed.jobs.length })} />
                {parsed.problems.length > 0 ? (
                  <StatusChip
                    tone="warning"
                    label={t('transfer.skippedN', { n: parsed.problems.length })}
                    title={parsed.problems
                      .map((p) => `#${p.index + 1}: ${p.reason}`)
                      .join('\n')}
                  />
                ) : null}
                {missing.size > 0 ? (
                  <StatusChip
                    tone="warning"
                    label={t('transfer.missingFilesN', { n: missing.size })}
                    title={[...missing].slice(0, 10).join('\n')}
                  />
                ) : null}
              </div>
            </Field>

            <Field label={t('transfer.attachTo')} hint={t('transfer.attachToHint')}>
              <select
                className="select"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {state.accounts.length === 0 ? (
                  <option value="">{t('transfer.noAccounts')}</option>
                ) : null}
                {state.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </Field>

            <div className="btn-row">
              <Button
                variant="primary"
                onClick={doImport}
                disabled={parsed.jobs.length === 0 || !accountId}
              >
                {t('transfer.confirmImport', { n: parsed.jobs.length })}
              </Button>
              <Button variant="ghost" onClick={() => setParsed(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Card>
  )
}
