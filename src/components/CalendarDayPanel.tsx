/**
 * One day, in full — and the reminder that lands on it, opened.
 *
 * The month grid can only say *how many* reminders a square holds; at 40px a
 * square that is the most it can honestly say. Everything a person actually
 * wants next — which reminder, at what time, was it moved here, can I move it
 * somewhere else, is it about to collide with three others — needs a surface
 * with room, and that is this.
 *
 * It is also the answer to "the badge is not clickable". A count that cannot be
 * opened is a dead end: you can see that something happens on the 2nd and have
 * no way to find out what.
 *
 * Everything here works without a pointer. The rows are drag *sources* for the
 * grid, but every drag has a button beside it that does the same thing through
 * a date field — a reschedule you can only perform by dragging is a reschedule
 * half the users of this app cannot perform at all.
 */

import { useState } from 'react'
import { Button, IconButton, Modal, StatusChip } from './ui'
import { IconAlert, IconCalendar, IconClock, IconExternal, IconPause, IconPlay, IconPlus } from './icons'
import { DRAG_TYPE, dragPayload } from './MonthGrid'
import { useI18n, type TranslationKey } from '../i18n'
import { summarizeRecurrence } from '../core/schedule'
import { toIsoDate, type CalendarWarning, type WorkdayPolicy } from '../core/workCalendar'
import type { Conflict } from '../core/conflicts'
import type { ScheduledJob } from '../core/types'

/** One send, on one day. */
export interface DayEntry {
  job: ScheduledJob
  /** When it fires, after the calendar and quiet hours have had their say. */
  at: number
  /** True when this day is not the day the rule asked for. */
  shifted: boolean
  /** The day the rule originally asked for, when it was moved. */
  originalIso?: string
}

export function CalendarDayPanel({
  iso,
  entries,
  working,
  holidayName,
  conflicts,
  onToggleDay,
  onMove,
  onOpenJob,
  onCreate,
  onDeStagger,
  staggerWindowMinutes,
}: {
  iso: string
  entries: DayEntry[]
  working: boolean
  holidayName?: string
  conflicts: Conflict[]
  onToggleDay: (iso: string) => void
  /** Ask to move a reminder from this day to another. */
  onMove: (jobId: string, fromIso: string, toIso: string) => void
  onOpenJob: (jobId: string) => void
  /** Start a new reminder for this day. */
  onCreate?: (iso: string) => void
  /** Spread a pile-up on one minute across a window. See `spreadSameMinute`. */
  onDeStagger?: (conflict: Conflict) => void
  /** How wide that window is, for the button's own sentence. */
  staggerWindowMinutes?: number
}) {
  const { t, formatDateTime } = useI18n()
  const [movingId, setMovingId] = useState<string | null>(null)
  const [movingTo, setMovingTo] = useState(iso)

  const worst = conflicts.some((c) => c.severity === 'error')
    ? 'error'
    : conflicts.length > 0
      ? 'warning'
      : null

  /*
   * The pile-ups on this day, and the one action that can undo them.
   *
   * `sameMinute` is the only conflict kind with a fix that does not require a
   * decision from the user about what they meant — the other four are "this
   * will not send" and "there is nowhere to move it to", which no button can
   * answer. Offering a fix beside the three that have none would be worse than
   * offering none at all.
   */
  const pileUps = onDeStagger ? conflicts.filter((c) => c.kind === 'sameMinute') : []

  return (
    <div className="dayview">
      <div className="dayview__head">
        <div className="dayview__date">
          <IconCalendar size={16} />
          <span>{formatDateTime(new Date(`${iso}T12:00:00`).getTime(), { dateStyle: 'full', timeStyle: undefined })}</span>
        </div>
        <div className="dayview__chips">
          <StatusChip
            tone={working ? 'success' : 'neutral'}
            dot
            label={working ? t('workcal.dayWorking') : t('workcal.dayOff')}
          />
          {holidayName ? <StatusChip tone="info" label={holidayName} /> : null}
          {worst ? (
            <StatusChip
              tone={worst === 'error' ? 'danger' : 'warning'}
              label={t('cal.conflict.count', { n: conflicts.length })}
            />
          ) : null}
        </div>
        <div className="btn-row dayview__actions">
          {onCreate ? (
            <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => onCreate(iso)}>
              {t('cal.day.create')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onToggleDay(iso)}>
            {working ? t('cal.day.markOff') : t('cal.day.markWorking')}
          </Button>
        </div>
      </div>

      {pileUps.length > 0 ? (
        <div className="banner banner--warning dayview__pileup">
          <IconAlert size={16} />
          <div className="banner__body">
            {pileUps.map((conflict, i) => (
              <div key={i} className="dayview__pileuprow">
                <span>
                  {t('cal.conflict.sameMinute', {
                    n: conflict.count,
                    when: conflict.at !== undefined ? formatDateTime(conflict.at) : iso,
                  })}
                </span>
                <Button variant="secondary" onClick={() => onDeStagger?.(conflict)}>
                  {t('cal.stagger.action', { min: staggerWindowMinutes ?? 5 })}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="dayview__empty">{t('cal.day.none')}</p>
      ) : (
        <ul className="dayview__list">
          {entries
            .slice()
            .sort((a, b) => a.at - b.at)
            .map((entry) => {
              const summary = summarizeRecurrence(entry.job.recurrence)
              return (
              <li
                key={`${entry.job.id}-${entry.at}`}
                className="dayrow"
                data-shifted={entry.shifted}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, dragPayload(entry.job.id, iso))
                  event.dataTransfer.effectAllowed = 'move'
                }}
              >
                <span className="dayrow__time">
                  <IconClock size={14} />
                  {formatDateTime(entry.at, { timeStyle: 'short', dateStyle: undefined })}
                </span>
                <span className="dayrow__body">
                  <button type="button" className="dayrow__name link" onClick={() => onOpenJob(entry.job.id)}>
                    {entry.job.name}
                  </button>
                  {/*
                    Who it goes to and what it says — the two things the square
                    upstairs can only show a truncated version of, at full
                    length, which is what this panel is for. `.mono`-style
                    wrapping on the subject because a subject can be one
                    unbroken token (a reference number, a URL) and ordinary
                    wrapping only breaks at spaces.
                  */}
                  <span className="dayrow__who">
                    {entry.job.draft.to.length > 0
                      ? entry.job.draft.to.join(', ')
                      : t('cal.day.noRecipient')}
                  </span>
                  <span className="dayrow__subject">
                    {entry.job.draft.subject || t('cal.day.noSubject')}
                  </span>
                  <span className="dayrow__meta">
                    {t(summary.key as 'recur.summary.once', summary.values)}
                    {entry.shifted && entry.originalIso ? (
                      <> · {t('cal.day.movedFrom', { from: entry.originalIso })}</>
                    ) : null}
                  </span>
                </span>
                <span className="dayrow__actions">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMovingId(entry.job.id)
                      setMovingTo(iso)
                    }}
                  >
                    {t('cal.day.move')}
                  </Button>
                  <IconButton label={t('cal.day.open')} onClick={() => onOpenJob(entry.job.id)}>
                    <IconExternal size={15} />
                  </IconButton>
                </span>
              </li>
              )
            })}
        </ul>
      )}

      {movingId ? (
        <div className="dayview__move">
          <label className="field__label" htmlFor="cal-move-to">
            {t('cal.move.picker')}
          </label>
          <div className="btn-row">
            <input
              id="cal-move-to"
              className="input"
              type="date"
              value={movingTo}
              onChange={(event) => setMovingTo(event.target.value)}
            />
            <Button
              variant="primary"
              disabled={!movingTo || movingTo === iso}
              onClick={() => {
                onMove(movingId, iso, movingTo)
                setMovingId(null)
              }}
            >
              {t('cal.move.confirm')}
            </Button>
            <Button variant="ghost" onClick={() => setMovingId(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * A reminder, opened from the calendar.
 *
 * Small on purpose. It is not a second schedule editor — it answers the three
 * questions someone has when they click a number on a calendar square ("which
 * reminder is that", "when does it actually go out", "why has it been moved")
 * and offers the two controls that belong to *this* screen: pause, and the
 * working-day policy that decides whether the calendar applies to it at all.
 *
 * The warning block is the part that did not exist anywhere until now.
 * `ScheduledJob.calendarWarning` has been populated on every recompute and
 * rendered by nothing, which means a reminder with no working day to move to
 * was already being dropped in complete silence.
 */
export function JobSheet({
  job,
  warning,
  conflicts,
  onClose,
  onTogglePaused,
  onPolicyChange,
}: {
  job: ScheduledJob
  warning?: CalendarWarning
  conflicts: Conflict[]
  onClose: () => void
  onTogglePaused: () => void
  onPolicyChange: (policy: WorkdayPolicy) => void
}) {
  const { t, formatDateTime } = useI18n()
  const summary = summarizeRecurrence(job.recurrence)
  const policy = job.recurrence.workdayPolicy ?? 'off'
  const recipients = job.draft.to.length + job.draft.cc.length + job.draft.bcc.length

  return (
    <Modal open title={job.name} onClose={onClose} closeLabel={t('common.close')} wide>
      <div className="jobsheet">
        <div className="jobsheet__row">
          <StatusChip
            tone={job.enabled ? 'accent' : 'neutral'}
            dot={job.enabled}
            label={job.enabled ? t('status.armed') : t('status.paused')}
          />
          <span>{t(summary.key as 'recur.summary.once', summary.values)}</span>
          <span>{t('logs.recipients', { n: recipients })}</span>
        </div>

        {job.draft.subject ? <div className="jobsheet__subject">{job.draft.subject}</div> : null}

        {warning ? (
          <div className="banner banner--danger" role="alert">
            <div className="banner__body">
              <div className="banner__title">{t('cal.job.warningTitle')}</div>
              {warning.dropped.length > 0 ? (
                <div>
                  {t('cal.job.dropped', {
                    n: warning.dropped.length,
                    when: formatDateTime(warning.dropped[0]),
                  })}
                </div>
              ) : null}
              {warning.crowded > 0 ? <div>{t('cal.job.crowded', { n: warning.crowded })}</div> : null}
              {warning.spreadMs > 0 ? (
                <div>{t('cal.job.spread', { min: Math.round(warning.spreadMs / 60_000) })}</div>
              ) : null}
              <div className="jobsheet__stamp">
                {t('cal.job.checkedAt', { when: formatDateTime(warning.at) })}
              </div>
            </div>
          </div>
        ) : null}

        {conflicts.length > 0 ? (
          <div className="banner banner--warning">
            <div className="banner__body">
              {conflicts.map((conflict, i) => (
                <div key={i}>{conflictLine(conflict, t, formatDateTime, job.name)}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="jobsheet__section">
          <div className="section-label">{t('cal.job.next')}</div>
          {job.occurrences.length === 0 ? (
            <div className="field__hint">{t('schedule.noMoreRuns')}</div>
          ) : (
            <ol className="jobsheet__times">
              {job.occurrences.slice(0, 6).map((at) => (
                <li key={at}>{formatDateTime(at)}</li>
              ))}
            </ol>
          )}
        </div>

        <div className="jobsheet__section">
          <div className="section-label">{t('workday.title')}</div>
          <div className="segmented" role="group" aria-label={t('workday.title')}>
            {(['off', 'skip', 'before', 'after'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="segmented__item"
                aria-pressed={policy === value}
                onClick={() => onPolicyChange(value)}
              >
                {t(`workday.${value}` as TranslationKey)}
              </button>
            ))}
          </div>
          <div className="field__hint">{t('workday.hint')}</div>
        </div>

        <div className="btn-row">
          <Button
            variant="secondary"
            icon={job.enabled ? <IconPause size={15} /> : <IconPlay size={15} />}
            onClick={onTogglePaused}
          >
            {job.enabled ? t('schedule.pause') : t('schedule.resume')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** One conflict as a sentence. Shared by the sheet and the conflict card. */
export function conflictLine(
  conflict: Conflict,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  formatDateTime: (ms: number, opts?: Intl.DateTimeFormatOptions) => string,
  name: string,
): string {
  const when = conflict.at !== undefined ? formatDateTime(conflict.at) : (conflict.date ?? '')
  switch (conflict.kind) {
    case 'sameMinute':
      return t('cal.conflict.sameMinute', { n: conflict.count, when })
    case 'allSkipped':
      return t('cal.conflict.allSkipped', { name })
    case 'nowhereToGo':
      return t('cal.conflict.nowhereToGo', { n: conflict.count, name })
    case 'crowded':
      return t('cal.conflict.crowded', { n: conflict.count, name })
    case 'spread':
      return t('cal.conflict.spread', { min: Math.round((conflict.ms ?? 0) / 60_000), name })
  }
}

/** `YYYY-MM-DD` for an instant — re-exported so callers need one import fewer. */
export const isoOf = toIsoDate
