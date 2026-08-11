/**
 * The compose screen's undo of last resort.
 *
 * Deliberately a list of *versions*, not a timeline of edits. Nobody wants to
 * replay keystrokes; they want the paragraph they had before they pasted the
 * template over it. So each row is a whole draft, described by the one line a
 * person would recognise it from, and restoring one is a single click.
 */

import { Button, EmptyState, IconButton, Modal, StatusChip } from './ui'
import { IconCopy, IconFileText, IconTrash } from './icons'
import { snapshotPreview, type DraftSnapshot, type SnapshotReason } from '../core/sync/snapshots'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'

const REASON_KEY: Record<SnapshotReason, TranslationKey> = {
  auto: 'history.reasonAuto',
  manual: 'history.reasonManual',
  beforeSend: 'history.reasonBeforeSend',
  beforeTemplate: 'history.reasonBeforeTemplate',
  beforeClear: 'history.reasonBeforeClear',
  beforeRestore: 'history.reasonBeforeRestore',
}

function summarise(snapshot: DraftSnapshot): string {
  const d = snapshot.draft
  const bits: string[] = []
  if (d.to.length > 0) bits.push(d.to.join(', '))
  if (d.attachments.length > 0) bits.push(`📎 ${d.attachments.length}`)
  // Deliberately no character count: a bare "38" next to a recipient list
  // reads as an error code. If the length matters, the preview line above
  // already shows what the draft actually said.
  return bits.join(' · ')
}

export function DraftHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch, restoreSnapshot } = useApp()
  const { t, formatDateTime } = useI18n()
  const history = state.draftSnapshots

  return (
    <Modal
      open={open}
      title={t('history.title')}
      onClose={onClose}
      closeLabel={t('common.close')}
      footer={
        <>
          {history.length > 0 ? (
            <Button variant="ghost" onClick={() => dispatch({ type: 'clearSnapshots' })}>
              {t('history.clear')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {history.length === 0 ? (
        <EmptyState
          icon={<IconFileText size={22} />}
          title={t('history.empty')}
          hint={t('history.emptyHint')}
        />
      ) : (
        <div className="history">
          {history.map((snapshot) => (
            <div key={snapshot.id} className="history__row">
              <div className="history__body">
                <div className="history__title">{snapshotPreview(snapshot)}</div>
                <div className="history__meta">
                  <StatusChip
                    tone={snapshot.reason === 'auto' ? 'neutral' : 'accent'}
                    label={t(REASON_KEY[snapshot.reason])}
                  />
                  {/* An absolute time, not a relative one. `formatRelative`
                      is built for *upcoming* fire times and renders anything
                      in the past as "overdue" — which, on a list of past
                      versions, is every row and means nothing. */}
                  <span title={formatDateTime(snapshot.at, { dateStyle: 'full' })}>
                    {formatDateTime(snapshot.at, { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                  <span>{summarise(snapshot)}</span>
                </div>
              </div>
              <IconButton
                label={t('history.restore')}
                onClick={() => {
                  restoreSnapshot(snapshot.id)
                  onClose()
                }}
              >
                <IconCopy size={16} />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      {/* Said once, here, rather than as a warning on every restore: the list
          holds references to attachments, not the files themselves. */}
      {history.some((s) => s.draft.attachments.length > 0) ? (
        <div className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>
          <IconTrash size={12} /> {t('history.attachmentNote')}
        </div>
      ) : null}
    </Modal>
  )
}
