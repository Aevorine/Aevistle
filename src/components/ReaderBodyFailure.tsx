/**
 * What the reader shows when the message body did not arrive.
 *
 * ## Why this component exists at all
 *
 * Because for its whole life the answer was `null`. `InboxView` rendered the
 * body region as `loading ? skeleton : body ? body : null`, so a failed fetch
 * produced a message with a subject, a sender, a date — and nothing
 * underneath. A toast said so for four seconds and then that was gone too.
 *
 * An empty panel is not a neutral outcome. It is indistinguishable from an
 * empty message, so the reader was quietly asserting something false about the
 * mail, and there was no control anywhere on the screen that could change it.
 *
 * ## What it says
 *
 * Three things, in the order they are useful:
 *
 *   1. that the content is missing rather than absent — the heading;
 *   2. why, in the engine's own words, untranslated. "No IMAP password stored
 *      for this account" and "connect ETIMEDOUT" are different problems with
 *      different fixes, and translating them would help nobody paste one into
 *      a bug report;
 *   3. the one button that can change the answer.
 *
 * The reason is `null` when there was no error to record — the load has not
 * been attempted, or was retired by a newer one. The heading changes; the
 * retry stays, because the correct action is the same either way.
 *
 * ## Why it is not an `EmptyState`
 *
 * `EmptyState` says "there is nothing here", which is the sentence this
 * component exists to stop the app from saying by accident.
 */

import { Button } from './ui'
import { IconAlert, IconRefresh } from './icons'
import { useI18n } from '../i18n'

export function ReaderBodyFailure({
  detail,
  snippet,
  onRetry,
}: {
  /** The engine's message, or `null` when nothing was recorded. */
  detail: string | null
  /**
   * The preview line the last sync stored for this message.
   *
   * It is already on this device — it is what the list row shows — and it is
   * the difference between "the content is gone" and "here is the first line
   * of it, and the rest needs the server". Shown under a label that says
   * exactly what it is, because a snippet presented as a body would be the
   * app quietly lying about how much of the message it has.
   */
  snippet?: string
  onRetry: () => void
}) {
  const { t } = useI18n()

  return (
    /* `role="status"` rather than `alert`: this appears where content was
       expected, in a region the reader has already moved focus to, so it does
       not need to interrupt — it needs to be read when the reader gets there. */
    <div className="readerfail" role="status" data-has-detail={detail ? 'true' : undefined}>
      <span className="readerfail__mark" aria-hidden="true">
        <IconAlert size={22} />
      </span>
      <h3 className="readerfail__title">
        {detail ? t('inbox.bodyFailedTitle') : t('inbox.bodyMissingTitle')}
      </h3>
      <p className="readerfail__hint">{t('inbox.bodyFailedHint')}</p>
      {snippet && snippet.trim().length > 0 ? (
        <figure className="readerfail__snippet">
          <figcaption className="readerfail__snippetLabel">{t('inbox.bodySnippetLabel')}</figcaption>
          <blockquote className="readerfail__snippetText">{snippet}</blockquote>
        </figure>
      ) : null}
      {detail ? (
        /* Untranslated on purpose, and selectable: this is the line that gets
           pasted into a report. Same reasoning as `.bootfail__tech`. */
        <p className="readerfail__tech">{detail}</p>
      ) : null}
      <Button variant="primary" icon={<IconRefresh size={15} />} onClick={onRetry}>
        {t('inbox.bodyRetry')}
      </Button>
    </div>
  )
}
