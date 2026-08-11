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
import { accountLabel } from '../core/mail/accounts'
import { exportJobs, materialise, parseImport, type ParsedImport } from '../core/schedule/jobTransfer'
import { DEFAULT_WORK_CALENDAR, mergeCalendars } from '../core/schedule/workCalendar'
import { saveGeneratedFile } from '../core/platform/download'

declare const __APP_VERSION__: string

function fileName(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `aevistle-reminders-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}.json`
}

export function ScheduleTransferCard() {
  const { state, dispatch, bridge, scheduleDraft } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  const [parsed, setParsed] = useState<ParsedImport | null>(null)
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [accountId, setAccountId] = useState('')
  const [error, setError] = useState('')

  const exportNow = async () => {
    if (state.jobs.length === 0) return
    // The calendar rides along whenever a job in the file reads it — a
    // `workdayPolicy` that lands on an install with no matching holiday list is
    // a reminder pointing at days that do not exist there.
    const file = exportJobs(
      state.jobs,
      __APP_VERSION__,
      Date.now(),
      state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
    )
    // Same reason as the backup card: the shell owns the save dialog, so it
    // is the only party that can tell us a recognisable file exists on disk.
    const { outcome, unsupported } = await saveGeneratedFile(JSON.stringify(file, null, 2), fileName())
    if (unsupported) {
      toast.push({ tone: 'error', title: t('download.androidUnsupported') })
      return
    }
    if (!outcome) {
      toast.push({ tone: 'success', title: t('transfer.exported', { n: state.jobs.length }) })
      return
    }
    if (outcome.cancelled) {
      toast.push({ tone: 'info', title: t('download.cancelled') })
      return
    }
    toast.push(
      outcome.ok
        ? {
            tone: 'success',
            title: t('transfer.exported', { n: state.jobs.length }),
            detail: outcome.name,
          }
        : { tone: 'error', title: t('download.failed'), detail: outcome.name },
    )
  }

  const pick = async (file: File) => {
    setError('')
    setParsed(null)
    try {
      const result = parseImport(
        await file.text(),
        state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
      )
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

  const doImport = async () => {
    if (!parsed || !accountId) return
    const { jobs, droppedAttachments } = materialise(
      parsed,
      accountId,
      (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      missing,
    )
    /*
     * The calendar is merged *before* the jobs, and only ever additively.
     *
     * `'merge'` adds the file's holidays and make-up days and keeps this
     * machine's working week, so nothing the user already had is removed and
     * no reminder unrelated to this import changes shape. Adopting the file's
     * `weekend` wholesale is the one thing that would do real damage — a
     * colleague's Friday/Saturday week silently rewriting every schedule here —
     * so it is deliberately not done without being asked, and the ask is a
     * dialog this card does not have yet. `parsed.calendar.diff.weekendDiffers`
     * is what that dialog would branch on.
     */
    let mergedDates = 0
    if (parsed.workCalendar) {
      const local = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR
      const next = mergeCalendars(local, parsed.workCalendar, 'merge')
      mergedDates =
        next.holidays.length - local.holidays.length + (next.workdays.length - local.workdays.length)
      if (mergedDates > 0) dispatch({ type: 'patchSettings', patch: { workCalendar: next } })
    }

    /*
     * `scheduleDraft`, not a bare `upsertJob`.
     *
     * The reducer stores a job exactly as given and computes nothing, so an
     * imported job kept the empty `occurrences` array `materialise` hands
     * back. The row then said "armed" with no next send, the health strip
     * counted it among the reminders that can no longer fire, and on Android —
     * where the alarm is set from `job.occurrences` — not one alarm was
     * registered. Everything looked right and nothing was scheduled.
     */
    for (const job of jobs) await scheduleDraft(job)
    setParsed(null)
    setMissing(new Set())
    const notes = [
      droppedAttachments > 0 ? t('transfer.droppedAttachments', { n: droppedAttachments }) : '',
      mergedDates > 0 ? t('transfer.calendarMerged', { n: mergedDates }) : '',
      parsed.calendar?.missing ? t('transfer.calendarMissing') : '',
    ].filter(Boolean)
    toast.push({
      tone: 'success',
      title: t('transfer.imported', { n: jobs.length }),
      detail: notes.length > 0 ? notes.join(' · ') : undefined,
    })
  }

  return (
    <Card>
      <CardHeader title={t('transfer.title')} hint={t('transfer.hint')} />
      <div className="card__body form-rows">
        <div className="btn-row">
          <Button
            icon={<IconDownload size={15} />}
            onClick={() => void exportNow()}
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
                {/* Said before the import, not after: a reminder that depends
                    on a calendar this machine does not have will move to days
                    nobody chose, and that is not visible once it is armed. */}
                {parsed.calendar?.missing ? (
                  <StatusChip tone="warning" label={t('transfer.calendarMissing')} />
                ) : null}
                {parsed.calendar?.diff && !parsed.calendar.diff.identical ? (
                  <StatusChip
                    tone="accent"
                    label={t('transfer.calendarInFile', {
                      n:
                        parsed.calendar.diff.newHolidays.length +
                        parsed.calendar.diff.newWorkdays.length,
                    })}
                    title={
                      parsed.calendar.diff.weekendDiffers
                        ? t('transfer.calendarWeekendDiffers')
                        : undefined
                    }
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
                onClick={() => void doImport()}
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
