/**
 * The health strip on the compose screen.
 *
 * Deliberately at the top of the screen the user opens most, and deliberately
 * absent when there is nothing to say — a panel that is always there saying
 * "all good" trains people to stop reading it, which is exactly the habit that
 * makes the one day it says something useful the day it gets ignored.
 */

import { useCallback, useMemo, useState } from 'react'
import { collectHealth, type HealthIssue, type HealthLevel } from '../core/ops/health'
import { IconActivity, IconAlert, IconCheckCircle, IconClock } from './icons'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'

/** Rows before the strip starts costing the compose form its single screen. */
const MAX_ROWS = 3

/*
 * `MAX_ROWS` caps how many problems are listed and nothing capped how tall one
 * of them could be. Measured at 360x800 with no account configured: the strip
 * was 79px at the standard text size, 131px at `larger`, and 341px at `larger`
 * plus a 1.3x Android system font scale — seven lines of one message, which
 * left the compose message box at 230px, 42.8% of the view against an 85%
 * floor. The clamp itself is `.health__text[data-clamped]` in 11-status.css,
 * in lines rather than pixels; this file only decides which rows get it.
 */

const ICONS: Record<HealthLevel, typeof IconAlert> = {
  danger: IconAlert,
  warning: IconAlert,
  info: IconClock,
}

export function HealthBoard({ onGo }: { onGo?: (where: NonNullable<HealthIssue['goTo']>) => void }) {
  const { state, schedulerUnreachable, permissions, fixPermission, saveFailing } = useApp()
  const { t } = useI18n()
  /**
   * Keyed on what it actually reads, not on the whole store.
   *
   * This strip lives on the compose screen, so without the memo it walked
   * every job, account and mailbox once per keystroke in the message body —
   * work whose answer cannot change while someone is typing a sentence.
   */
  const issues = useMemo(
    () => collectHealth(state, Date.now(), schedulerUnreachable, permissions ?? undefined, saveFailing),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.jobs,
      state.accounts,
      state.settings,
      state.inboxAccounts,
      state.logs,
      schedulerUnreachable,
      saveFailing,
      permissions,
    ],
  )

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [overflowing, setOverflowing] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  /**
   * A ref callback per row, so the control appears only where the text really
   * is taller than the clamp.
   *
   * The measurement has to be taken on the *clamped* node. The first version
   * of this set `data-clamped` only once a row was known to overflow, which
   * meant it measured an unclamped element whose `scrollHeight` always equals
   * its `clientHeight` — nothing ever overflowed, the control never appeared,
   * and the strip stayed 255px tall. So the clamp is unconditional and the
   * expanded state is what lifts it.
   *
   * A row that is currently expanded is skipped rather than measured as
   * "fits": unclamped it reports no overflow, which would delete it from the
   * set and take away the control that collapses it again.
   *
   * `prev.has(id) === over` returns the same Set instance when nothing
   * changed, so React bails out of the re-render and the ref callback that
   * runs on every render cannot loop.
   */
  const measure = useCallback(
    (id: string, open: boolean) => (node: HTMLElement | null) => {
      if (node === null || open) return
      const over = node.scrollHeight - node.clientHeight > 1
      setOverflowing((prev) => {
        if (prev.has(id) === over) return prev
        const next = new Set(prev)
        if (over) next.add(id)
        else next.delete(id)
        return next
      })
    },
    [],
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
        const open = expanded.has(issue.id)
        return (
          <div className="health__item" data-level={issue.level} key={issue.id}>
            <Icon size={16} className="health__icon" />
            {/*
              Clamped to `CLAMP_LINES`, and only a message that is actually
              taller than that grows a control — measured on the node rather
              than guessed from string length, because the same sentence is one
              line at 360px and four at 320px with the system font at 1.3x.
            */}
            <span
              className="health__text"
              data-clamped={open ? undefined : 'true'}
              ref={measure(issue.id, open)}
            >
              {t(issue.key as TranslationKey, issue.values)}
            </span>
            {overflowing.has(issue.id) ? (
              <button
                type="button"
                className="health__expand"
                aria-expanded={open}
                onClick={() => toggle(issue.id)}
              >
                {t(open ? 'health.less' : 'health.expand')}
              </button>
            ) : null}
            {/* Only where there is something to do. "3 sends due this week"
                with a Fix link beside it reads like an accusation. */}
            {/* A fix that leaves the app entirely — the Android permission
                screens. It takes precedence over `goTo`: sending someone to a
                Settings tab that cannot grant the permission would be worse
                than saying nothing. */}
            {issue.fix ? (
              <button
                type="button"
                className="health__go"
                onClick={() => void fixPermission(issue.fix as NonNullable<HealthIssue['fix']>)}
              >
                {t((issue.fixKey ?? 'health.go') as TranslationKey)}
              </button>
            ) : issue.goTo && onGo && issue.level !== 'info' ? (
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
  const { state, schedulerUnreachable, permissions, saveFailing } = useApp()
  const { t } = useI18n()
  /**
   * Keyed on what it actually reads, not on the whole store.
   *
   * This strip lives on the compose screen, so without the memo it walked
   * every job, account and mailbox once per keystroke in the message body —
   * work whose answer cannot change while someone is typing a sentence.
   */
  const issues = useMemo(
    () => collectHealth(state, Date.now(), schedulerUnreachable, permissions ?? undefined, saveFailing),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.jobs,
      state.accounts,
      state.settings,
      state.inboxAccounts,
      state.logs,
      schedulerUnreachable,
      saveFailing,
      permissions,
    ],
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
