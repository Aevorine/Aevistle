/**
 * The question asked once, on first launch: where should everything be kept?
 *
 * Existed only in Settings before, which meant the default folder was chosen
 * for the user by not asking — and a folder is much cheaper to pick before
 * there is any data in it than to change afterwards, when picking it also
 * means moving files and rewriting the attachment paths inside every saved
 * schedule.
 *
 * Shown only when the platform can actually offer a free choice, and only
 * while the app is still empty; a returning user is never interrupted.
 */

import { useEffect, useState } from 'react'
import { Banner, Button, Modal } from './ui'
import { IconFolder, IconShield } from './icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import type { DataFolder } from '../core/bridge'

const SEEN_KEY = 'aevistle.dataFolder.asked'

export function DataFolderSetup() {
  const { state, ready, bridge, relocateData } = useApp()
  const { t } = useI18n()

  const [folder, setFolder] = useState<DataFolder | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!ready || !bridge) return
    if (localStorage.getItem(SEEN_KEY) === '1') return
    // "Empty" is the honest test for a first run: a state file can exist from a
    // crashed launch, but an account means the user has already set this up.
    if (state.accounts.length > 0 || state.jobs.length > 0) {
      localStorage.setItem(SEEN_KEY, '1')
      return
    }

    void bridge
      .dataFolder()
      .then((current) => {
        if (!current.canPickAny) {
          localStorage.setItem(SEEN_KEY, '1')
          return
        }
        setFolder(current)
        setOpen(true)
      })
      .catch(() => {})
  }, [ready, bridge, state.accounts.length, state.jobs.length])

  const dismiss = () => {
    localStorage.setItem(SEEN_KEY, '1')
    setOpen(false)
  }

  const choose = async () => {
    if (!bridge || busy) return
    setBusy(true)
    const previous = folder?.path ?? ''
    try {
      // Nothing has been written yet, so there is nothing to move and no
      // reason to ask a second question about it.
      const change = await bridge.chooseDataFolder(false)
      if (change.changed) {
        await relocateData(change, previous)
      }
      dismiss()
    } catch {
      // The picker was closed, or the folder was not writable. Leaving the
      // dialog open lets them try again or take the default.
    } finally {
      setBusy(false)
    }
  }

  if (!open || !folder) return null

  return (
    <Modal
      open
      title={t('data.setupTitle')}
      onClose={dismiss}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" onClick={dismiss}>
            {t('data.setupDefault')}
          </Button>
          <div className="modal__footer-spacer" />
          <Button
            variant="primary"
            icon={<IconFolder size={16} />}
            loading={busy}
            onClick={choose}
          >
            {t('data.setupChoose')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 'var(--leading-relaxed)' }}>
        {t('data.setupBody')}
      </p>

      <div className="path-row" style={{ marginTop: 'var(--sp-4)' }}>
        <code className="path-row__value">{folder.path}</code>
        <span className="chip">{t('data.setupCurrent')}</span>
      </div>

      {folder.staysBehind.includes('secrets') ? (
        <Banner tone="info">
          <IconShield size={13} style={{ verticalAlign: -2, marginInlineEnd: 4 }} />
          {t('data.stays.secrets')}
        </Banner>
      ) : null}
    </Modal>
  )
}
