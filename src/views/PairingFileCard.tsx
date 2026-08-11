/**
 * The offline fallback for pairing two devices — see `core/pairingFile.ts`
 * for why a file is sometimes the only option left. Lives next to
 * `BackupCard` for the same reason `ScheduleTransferCard` does: it answers a
 * neighbouring question with a deliberately different shape, and someone
 * looking for "move my setup to another device" should find both without
 * hunting.
 *
 * Export asks what to send (`SyncScopePicker`) and a PIN, twice, to encrypt
 * it with. Import reads the envelope first, asks for the PIN only once that
 * much is confirmed to be a real pairing file, and then — because the file
 * underneath is either a full scoped backup or a schedule-only transfer file
 * — hands off to exactly the same confirmation `BackupCard` or
 * `ScheduleTransferCard` would show, so restoring from a pairing file never
 * behaves differently from restoring from the file it is built on.
 */

import { useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  Field,
  StatusChip,
  useToast,
} from '../components/ui'
import { IconFolder, IconKey } from '../components/icons'
import { PinEntry } from '../components/PinEntry'
import { SyncScopePicker } from '../components/SyncScopePicker'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { accountLabel } from '../core/mail/accounts'
import { applyBackup, readBackup, summarise, type BackupFile, type BackupSummary } from '../core/ops/backup'
import { materialise, parseImport, type ParsedImport } from '../core/schedule/jobTransfer'
import { saveGeneratedFile } from '../core/platform/download'
import {
  buildPairingPayload,
  decryptPairingFile,
  detectPairingPayloadKind,
  encryptPairingFile,
  pairingFileName,
  readPairingFile,
  WrongPinError,
  type PairingFile,
} from '../core/sync/pairingFile'
import { SYNC_SCOPE_KEYS, type SyncScopeKey } from '../core/sync/syncScope'
import { DEFAULT_WORK_CALENDAR } from '../core/schedule/workCalendar'

declare const __APP_VERSION__: string

type Decrypted =
  | { kind: 'backup'; backup: BackupFile; summary: BackupSummary }
  | { kind: 'schedule'; parsed: ParsedImport }

export function PairingFileCard() {
  const { state, dispatch, bridge, scheduleDraft } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  // --- export ---------------------------------------------------------------
  const [scopes, setScopes] = useState<Set<SyncScopeKey>>(new Set(SYNC_SCOPE_KEYS))
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [exportError, setExportError] = useState('')

  const pinReady = pin.length === 6 && pin === pinConfirm

  const exportNow = async () => {
    setExportError('')
    if (scopes.size === 0) {
      setExportError(t('sync.scope.selectAtLeastOne'))
      return
    }
    if (pin.length !== 6) {
      setExportError(t('pairing.file.pinHint'))
      return
    }
    if (pin !== pinConfirm) {
      setExportError(t('pairing.file.wrongPin'))
      return
    }
    const calendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR
    const payload = buildPairingPayload(state, [...scopes], __APP_VERSION__, calendar)
    const file = await encryptPairingFile(payload, pin)
    const { outcome, unsupported } = await saveGeneratedFile(
      JSON.stringify(file, null, 2),
      pairingFileName(),
    )
    setPin('')
    setPinConfirm('')
    if (unsupported) {
      toast.push({ tone: 'error', title: t('download.androidUnsupported') })
      return
    }
    if (!outcome) {
      toast.push({ tone: 'success', title: t('pairing.file.export') })
      return
    }
    if (outcome.cancelled) {
      toast.push({ tone: 'info', title: t('download.cancelled') })
      return
    }
    toast.push(
      outcome.ok
        ? { tone: 'success', title: t('pairing.file.export'), detail: outcome.name }
        : { tone: 'error', title: t('download.failed'), detail: outcome.name },
    )
  }

  // --- import -----------------------------------------------------------------
  const [pending, setPending] = useState<PairingFile | null>(null)
  const [importPin, setImportPin] = useState('')
  const [importError, setImportError] = useState('')
  const [decrypted, setDecrypted] = useState<Decrypted | null>(null)
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [importAccountId, setImportAccountId] = useState('')

  const reset = () => {
    setPending(null)
    setImportPin('')
    setImportError('')
    setDecrypted(null)
    setMissing(new Set())
    setImportAccountId('')
  }

  const pick = async (file: File) => {
    reset()
    try {
      setPending(readPairingFile(await file.text()))
    } catch {
      // `not-json`, `not-a-pairing-file` and `too-new` all land here: every
      // one of them means "pick a different file", not "try a different PIN",
      // and a PIN prompt has not been shown yet for this to be about.
      setImportError(t('pairing.file.notAPairingFile'))
    }
  }

  const unlock = async () => {
    if (!pending) return
    setImportError('')
    try {
      const text = await decryptPairingFile(pending, importPin)
      if (detectPairingPayloadKind(text) === 'schedule') {
        const parsed = parseImport(text, state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR)
        setDecrypted({ kind: 'schedule', parsed })
        setImportAccountId(state.accounts[0]?.id ?? '')
        if (bridge?.checkFiles && parsed.attachmentPaths.length > 0) {
          const presence = await bridge.checkFiles(parsed.attachmentPaths)
          setMissing(new Set(parsed.attachmentPaths.filter((p) => !presence[p])))
        }
      } else {
        const backup = readBackup(text)
        setDecrypted({ kind: 'backup', backup, summary: summarise(backup) })
      }
    } catch (e) {
      setImportError(e instanceof WrongPinError ? t('pairing.file.wrongPin') : t('pairing.file.notAPairingFile'))
    }
  }

  const restoreBackup = (mode: 'merge' | 'replace') => {
    if (decrypted?.kind !== 'backup') return
    dispatch({ type: 'hydrate', state: applyBackup(state, decrypted.backup, mode) })
    reset()
    toast.push({ tone: 'success', title: t('backup.restored') })
  }

  const importSchedule = async () => {
    if (decrypted?.kind !== 'schedule' || !importAccountId) return
    const { jobs } = materialise(
      decrypted.parsed,
      importAccountId,
      (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      missing,
    )
    for (const job of jobs) await scheduleDraft(job)
    reset()
    toast.push({ tone: 'success', title: t('transfer.imported', { n: jobs.length }) })
  }

  return (
    <Card>
      <CardHeader title={t('pairing.file.export')} hint={t('pairing.file.pinHint')} />
      {/* No `form-rows`: nothing in this card wants the 5.5em label gutter, and
          carrying it made the two-PIN `.field__row` match both
          `.form-rows > .field__row` (a 104px inline-start margin) and, at
          ≥1000px, `.view--settings .card__body > *` (`flex: 1 0 100%`, which
          forbids shrinking). 104px plus the full content width, unable to give
          — the second PIN field hung off the card and the settings screen grew
          a horizontal scrollbar. */}
      <div className="card__body">
        <SyncScopePicker
          scopes={scopes}
          onChange={setScopes}
          accounts={state.accounts}
          jobsCount={state.jobs.length}
          contactsCount={state.contacts.length}
          templatesCount={state.templates.length}
        />

        <div className="field__row">
          <PinEntry value={pin} onChange={setPin} label={t('pairing.file.setPin')} />
          <PinEntry value={pinConfirm} onChange={setPinConfirm} label={t('pairing.file.enterPin')} />
        </div>

        {exportError ? <div className="field__hint field__hint--error">{exportError}</div> : null}

        <div className="btn-row">
          <Button
            icon={<IconKey size={15} />}
            variant="primary"
            disabled={scopes.size === 0 || !pinReady}
            onClick={() => void exportNow()}
          >
            {t('pairing.file.export')}
          </Button>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', margin: 'var(--sp-2) 0' }} />

        <div className="btn-row">
          <Button icon={<IconFolder size={15} />} onClick={() => fileInput.current?.click()}>
            {t('pairing.file.import')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".aevistlepair,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void pick(file)
            }}
          />
        </div>

        {importError ? <div className="field__hint field__hint--error">{importError}</div> : null}

        {pending && !decrypted ? (
          <div className="btn-row" style={{ alignItems: 'flex-end' }}>
            <PinEntry value={importPin} onChange={setImportPin} label={t('pairing.file.enterPin')} autoFocus />
            <Button variant="primary" disabled={importPin.length !== 6} onClick={() => void unlock()}>
              {t('common.confirm')}
            </Button>
          </div>
        ) : null}

        {decrypted?.kind === 'backup' ? (
          <>
            <div className="log__detail">
              {t('backup.writtenOn', {
                app: decrypted.summary.app,
                when: decrypted.summary.createdAt ? formatDateTime(decrypted.summary.createdAt) : '—',
              })}
            </div>
            <div className="btn-row">
              <StatusChip tone="accent" label={t('backup.countAccounts', { n: decrypted.summary.accounts })} />
              <StatusChip tone="accent" label={t('backup.countJobs', { n: decrypted.summary.jobs })} />
              <StatusChip tone="accent" label={t('backup.countContacts', { n: decrypted.summary.contacts })} />
              <StatusChip tone="accent" label={t('backup.countTemplates', { n: decrypted.summary.templates })} />
            </div>
            {decrypted.summary.needPassword > 0 ? (
              <Banner tone="warning" title={t('backup.passwordsTitle')}>
                {t('backup.passwordsHint', { n: decrypted.summary.needPassword })}
              </Banner>
            ) : null}
            <div className="btn-row">
              <Button onClick={() => restoreBackup('replace')}>{t('backup.replace')}</Button>
              <Button variant="primary" onClick={() => restoreBackup('merge')}>
                {t('backup.merge')}
              </Button>
              <Button variant="ghost" onClick={reset}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : null}

        {decrypted?.kind === 'schedule' ? (
          <>
            <div className="btn-row">
              <StatusChip tone="accent" label={t('transfer.foundN', { n: decrypted.parsed.jobs.length })} />
              {missing.size > 0 ? (
                <StatusChip tone="warning" label={t('transfer.missingFilesN', { n: missing.size })} />
              ) : null}
            </div>
            <Field label={t('transfer.attachTo')} hint={t('transfer.attachToHint')}>
              <select
                className="select"
                value={importAccountId}
                onChange={(e) => setImportAccountId(e.target.value)}
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
                disabled={!importAccountId || decrypted.parsed.jobs.length === 0}
                onClick={() => void importSchedule()}
              >
                {t('transfer.confirmImport', { n: decrypted.parsed.jobs.length })}
              </Button>
              <Button variant="ghost" onClick={reset}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Card>
  )
}
