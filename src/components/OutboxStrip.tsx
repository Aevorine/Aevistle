/**
 * What is waiting to go out, and why.
 *
 * The queue's whole value is that it is *visible*. A retry loop nobody can see
 * is indistinguishable from a message that was silently dropped, so this strip
 * appears the moment anything is queued, says when the next attempt is, and
 * offers the two things a person in that situation wants: try now, or give up
 * and put the text back in the editor.
 */

import { Button, IconButton, StatusChip } from './ui'
import { IconRefresh, IconSend, IconTrash } from './icons'
import { summarise } from '../core/outbox'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'

export function OutboxStrip({ onRestore }: { onRestore?: () => void }) {
  const { state, dispatch, flushOutbox } = useApp()
  const { t, formatRelative } = useI18n()

  if (state.outbox.length === 0) return null
  const stats = summarise(state.outbox)

  return (
    <div className="outbox" data-failed={stats.failed > 0}>
      <div className="outbox__head">
        <StatusChip
          tone={stats.failed > 0 ? 'danger' : 'warning'}
          dot={stats.failed === 0}
          label={
            stats.failed > 0
              ? t('outbox.someFailed', { n: stats.failed })
              : t('outbox.waiting', { n: stats.waiting })
          }
        />
        {stats.nextAttemptAt !== undefined && stats.failed === 0 ? (
          <span className="outbox__when">
            {t('outbox.nextTry', { when: formatRelative(stats.nextAttemptAt) })}
          </span>
        ) : null}
        <div className="outbox__actions">
          <Button
            variant="ghost"
            icon={<IconRefresh size={14} />}
            onClick={() => void flushOutbox()}
          >
            {t('outbox.tryNow')}
          </Button>
        </div>
      </div>

      <div className="outbox__list">
        {state.outbox.map((item) => (
          <div key={item.id} className="outbox__item" data-status={item.status}>
            <IconSend size={13} className="outbox__icon" />
            <div className="outbox__body">
              <div className="outbox__subject">
                {item.draft.subject || t('preflight.noSubjectShort')}
              </div>
              <div className="outbox__meta">
                <span>{item.draft.to.join(', ')}</span>
                {item.attempts > 0 ? <span>{t('outbox.attempts', { n: item.attempts })}</span> : null}
                {item.lastError ? <span className="outbox__error">{item.lastError}</span> : null}
              </div>
            </div>
            {onRestore ? (
              <IconButton
                label={t('outbox.editInstead')}
                onClick={() => {
                  // Back to the editor exactly as it was queued, and out of the
                  // queue — leaving both would send a copy the moment the
                  // network returned, while the user was still editing it.
                  dispatch({ type: 'setDraft', patch: { ...item.draft } })
                  dispatch({ type: 'dequeue', id: item.id })
                  onRestore()
                }}
              >
                <IconSend size={15} />
              </IconButton>
            ) : null}
            <IconButton
              label={t('outbox.discard')}
              onClick={() => dispatch({ type: 'dequeue', id: item.id })}
            >
              <IconTrash size={15} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  )
}
