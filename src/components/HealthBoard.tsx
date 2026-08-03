/**
 * The health strip on the compose screen.
 *
 * Deliberately at the top of the screen the user opens most, and deliberately
 * absent when there is nothing to say — a panel that is always there saying
 * "all good" trains people to stop reading it, which is exactly the habit that
 * makes the one day it says something useful the day it gets ignored.
 */

import { useMemo } from 'react'
import { collectHealth, type HealthIssue, type HealthLevel } from '../core/health'
import { IconActivity, IconAlert, IconCheckCircle, IconClock } from './icons'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'

/** Rows before the strip starts costing the compose form its single screen. */
const MAX_ROWS = 3

const ICONS: Record<HealthLevel, typeof IconAlert> = {
  danger: IconAlert,
  warning: IconAlert,
  info: IconClock,
}

export function HealthBoard({ onGo }: { onGo?: (where: NonNullable<HealthIssue['goTo']>) => void }) {
  const { state } = useApp()
  const { t } = useI18n()
  /**
   * Keyed on what it actually reads, not on the whole store.
   *
   * This strip lives on the compose screen, so without the memo it walked
   * every job, account and mailbox once per keystroke in the message body —
   * work whose answer cannot change while someone is typing a sentence.
   */
  const issues = useMemo(
    () => collectHealth(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.jobs, state.accounts, state.settings, state.inboxAccounts, state.logs],
  )

  // Nothing wrong and nothing scheduled is a new install, not a clean bill of
  // health; there is nothing worth taking up the space for.
  if (issues.length === 0) return null

  // When something is actually wrong, the informational lines are noise —
  // "3 sends due this week" is not what you need to read directly above
  // "1 account has no password". And the whole strip is capped at three rows
  // because it sits on top of the compose form, which has to stay on one
  // screen; a fourth problem is still counted, just not spelled out.
  const actionable = issues.filter((issue) => issue.level !== 'info')
  const relevant = actionable.length > 0 ? actionable : issues.slice(0, 1)
  const shown = relevant.slice(0, MAX_ROWS)
  const hidden = relevant.length - shown.length

  return (
    <div className="health" role="status">
      {shown.map((issue) => {
        const Icon = issue.level === 'info' && issue.id === 'upcoming' ? IconActivity : ICONS[issue.level]
        return (
          <div className="health__item" data-level={issue.level} key={issue.id}>
            <Icon size={16} className="health__icon" />
            <span className="health__text">{t(issue.key as TranslationKey, issue.values)}</span>
            {/* Only where there is something to do. "3 sends due this week"
                with a Fix link beside it reads like an accusation. */}
            {issue.goTo && onGo && issue.level !== 'info' ? (
              <button
                type="button"
                className="health__go"
                onClick={() => onGo(issue.goTo as NonNullable<HealthIssue['goTo']>)}
              >
                {t('health.go')}
              </button>
            ) : null}
          </div>
        )
      })}
      {hidden > 0 ? (
        <div className="health__more">{t('health.more', { n: hidden })}</div>
      ) : null}
    </div>
  )
}

/** The all-clear line, for the schedule screen where "nothing wrong" is news. */
export function HealthAllClear() {
  const { state } = useApp()
  const { t } = useI18n()
  /**
   * Keyed on what it actually reads, not on the whole store.
   *
   * This strip lives on the compose screen, so without the memo it walked
   * every job, account and mailbox once per keystroke in the message body —
   * work whose answer cannot change while someone is typing a sentence.
   */
  const issues = useMemo(
    () => collectHealth(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.jobs, state.accounts, state.settings, state.inboxAccounts, state.logs],
  )
  if (issues.some((i) => i.level !== 'info')) return null
  if (state.jobs.length === 0) return null
  return (
    <div className="health">
      <div className="health__item" data-level="ok">
        <IconCheckCircle size={16} className="health__icon" />
        <span className="health__text">{t('health.allClear')}</span>
      </div>
    </div>
  )
}
