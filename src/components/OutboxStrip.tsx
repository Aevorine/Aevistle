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

/**
 * How many queued messages are listed individually before the rest become a
 * count.
 *
 * This is a performance fix and a layout fix at once, and it was measured
 * rather than guessed. The strip has no `max-height`, so a queue built up over
 * an offline afternoon rendered every item: 150 of them pushed the compose
 * editor entirely off the screen, and — because this component reads the whole
 * app state, and the draft lives in it — re-rendered all 150 rows on *every
 * keystroke*. Typing a subject line cost 65 ms of blocked main thread on
 * average and 244 ms at the 95th percentile, against a 16.7 ms frame. With the
 * queue empty and nothing else changed, the same typing cost 26 ms.
 *
 * Six, because the strip's job is to say the queue exists, what it is doing and
 * how to act on it — and the header already carries the totals. Enumerating the
 * seventh through hundred-and-fiftieth item adds nothing a person in that
 * situation is reading for.
 */
const VISIBLE = 6

export function OutboxStrip({ onRestore }: { onRestore?: () => void }) {
  const { state, dispatch, flushOutbox } = useApp()
  const { t, formatRelative } = useI18n()

  if (state.outbox.length === 0) return null
  const stats = summarise(state.outbox)

  /*
   * Failures first, then whichever will be tried soonest. The order matters
   * precisely *because* the list is truncated: an arbitrary six out of a
   * hundred would hide the only items that need a decision behind ninety-odd
   * that are simply waiting their turn.
   *
   * `slice()` before sorting — `state.outbox` belongs to the reducer, and
   * sorting it in place would reorder the stored queue as a side effect of
   * drawing it.
   */
  const shown = state.outbox
    .slice()
    .sort((a, b) => {
      const failed = Number(b.status === 'failed') - Number(a.status === 'failed')
      return failed || a.nextAttemptAt - b.nextAttemptAt
    })
    .slice(0, VISIBLE)
  const hidden = state.outbox.length - shown.length

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
        {shown.map((item) => (
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
        {/* Said out loud rather than simply cut. A list that silently stops at
            six would have the user believe six is the queue, and the number
            they are worried about is exactly the one that would be missing. */}
        {hidden > 0 ? <div className="outbox__more">{t('outbox.andMore', { n: hidden })}</div> : null}
      </div>
    </div>
  )
}
