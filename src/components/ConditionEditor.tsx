/**
 * "Only send if…" — the conditions checked at fire time.
 *
 * Presented as a short list of ticked rules rather than a rule builder. Every
 * general condition editor ever shipped ends up being a small programming
 * language nobody wants to learn, and the four or five checks people actually
 * ask for fit on one screen with no syntax at all.
 *
 * Each row states plainly what happens when the check fails, because "only
 * send if the attachment exists" and "don't send if the attachment is missing"
 * are the same sentence, and only one of them makes the consequence obvious.
 */

import { Field, StatusChip } from './ui'
import { CONDITION_KINDS, type ConditionKind, type SendCondition } from '../core/conditions'
import { useI18n, type TranslationKey } from '../i18n'

/** Which conditions the platform doing the sending can actually answer. */
const NEEDS_FILESYSTEM: ConditionKind[] = ['attachmentsPresent', 'fileExists', 'fileMissing']
const NEEDS_INBOX: ConditionKind[] = ['noReplySince']

export function ConditionEditor({
  conditions,
  onChange,
  /** False on Android and in the browser build, where no filesystem is reachable. */
  filesystemAvailable = true,
  inboxAvailable = false,
}: {
  conditions: SendCondition[]
  onChange: (next: SendCondition[]) => void
  filesystemAvailable?: boolean
  inboxAvailable?: boolean
}) {
  const { t } = useI18n()

  const find = (kind: ConditionKind) => conditions.find((c) => c.kind === kind)

  const toggle = (kind: ConditionKind) => {
    onChange(
      find(kind)
        ? conditions.filter((c) => c.kind !== kind)
        : [...conditions, { kind, from: '09:00', to: '18:00' }],
    )
  }

  const patch = (kind: ConditionKind, p: Partial<SendCondition>) => {
    onChange(conditions.map((c) => (c.kind === kind ? { ...c, ...p } : c)))
  }

  return (
    <Field label={t('condition.title')} hint={t('condition.hint')}>
      <div className="conditions">
        {CONDITION_KINDS.map((kind) => {
          const active = find(kind)
          // "Cannot be checked here" is said up front, not discovered later in
          // a log line. A condition that silently never applies is worse than
          // one the UI refused to offer.
          const unavailable =
            (NEEDS_FILESYSTEM.includes(kind) && !filesystemAvailable) ||
            (NEEDS_INBOX.includes(kind) && !inboxAvailable)

          return (
            <div key={kind} className="condition" data-on={!!active}>
              <label className="condition__head">
                <input
                  type="checkbox"
                  checked={!!active}
                  onChange={() => toggle(kind)}
                  disabled={unavailable}
                />
                <span className="condition__name">{t(`condition.kind.${kind}` as TranslationKey)}</span>
                {unavailable ? (
                  <StatusChip tone="neutral" label={t('condition.unavailable')} />
                ) : null}
              </label>

              {active ? (
                <div className="condition__detail">
                  <div className="condition__effect">
                    {t(`condition.effect.${kind}` as TranslationKey)}
                  </div>

                  {kind === 'fileExists' || kind === 'fileMissing' ? (
                    <input
                      className="input"
                      value={active.path ?? ''}
                      placeholder={t('condition.pathPlaceholder')}
                      onChange={(e) => patch(kind, { path: e.target.value })}
                    />
                  ) : null}

                  {kind === 'timeWindow' ? (
                    <div className="condition__times">
                      <input
                        className="input"
                        type="time"
                        value={active.from ?? '09:00'}
                        onChange={(e) => patch(kind, { from: e.target.value })}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        className="input"
                        type="time"
                        value={active.to ?? '18:00'}
                        onChange={(e) => patch(kind, { to: e.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </Field>
  )
}
