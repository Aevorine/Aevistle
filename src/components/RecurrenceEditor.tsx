/**
 * The scheduling panel.
 *
 * Everything here is optional except "when" — the advanced block stays folded
 * away so the common case (send this once, next Tuesday at 9) is three
 * controls, while jitter, weekend skipping, catch-up policy and retry are one
 * click away for people who need them.
 *
 * Above all of it is a plain-language box: type 「每周一 8:30」and the controls
 * below fill themselves in. It sets the same fields a person would, and leaves
 * them visible and editable — so a misreading is something you correct in
 * front of you, not something you discover when the wrong thing goes out.
 */

import { useMemo, useState } from 'react'
import { Field, Segmented, Switch } from './ui'
import { useApp } from '../state/AppState'
import { parseNaturalTime } from '../core/naturalTime'
import { nextComposeStart } from '../core/composeSeed'
import { useI18n, type TranslationKey } from '../i18n'
import { applyQuietHours, computeOccurrences, summarizeRecurrence, validateCron } from '../core/schedule'
import {
  applyWorkCalendarDetailed,
  calendarWarning,
  DEFAULT_WORK_CALENDAR,
} from '../core/workCalendar'
import { validateBurst, validateRecurrence } from '../core/validate'
import type { WorkdayPolicy } from '../core/workCalendar'
import {
  DEFAULT_BURST,
  MAX_BURST_COUNT,
  pad2,
  type BurstPolicy,
  type Recurrence,
  type RecurrenceKind,
  type RetryPolicy,
} from '../core/types'

/**
 * Exported because the compose screen sets a send time inline now, and a
 * second copy of this would be a second chance to get the timezone wrong:
 * `toISOString().slice(0,16)` is the obvious spelling and it is UTC, which
 * silently shifts every time a user picks by up to half a day.
 */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function fromLocalInput(value: string, fallback: number): number {
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : fallback
}

/**
 * The next whole hour, seconds zeroed — or the day the calendar asked for.
 *
 * The seed for a new reminder's send time. It used to be "five minutes from
 * now", which is a fine internal default and a poor thing to show anyone: the
 * compose screen displayed it as `14:37` and the schedule dialog agreed, so
 * every reminder that was scheduled without touching the time went out at a
 * minute nobody chose. A whole hour is a time a person would have picked.
 *
 * It is also the *single point* every new reminder's start time comes through,
 * which is why "double-click the 15th on the working calendar and get a
 * reminder for the 15th" is implemented here rather than by a second seeding
 * path that would have to be kept in step with this one. See
 * `core/composeSeed.ts`: with nothing waiting there, this is the function it
 * has always been.
 */
export function nextWholeHour(now: number): number {
  return nextComposeStart(now)
}

/** `HH:mm` in local time — the shape `Recurrence.timeOfDay` stores. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * The four start times people actually pick, as one tap each.
 *
 * Built from the current clock rather than from constants, and *not*
 * memoised on mount: a window left open overnight would otherwise offer
 * "tomorrow morning" for a tomorrow that is now today. Each entry is computed
 * when the row renders.
 *
 * Every one of them lands on a whole minute with seconds zeroed. A reminder
 * whose stored time carries the 37 seconds that happened to be on the clock
 * when the chip was tapped fires at 09:00:37, which is not what "tomorrow at
 * nine" means to anyone.
 */
export function quickTimes(now: number): Array<{ key: string; at: number }> {
  const at = (dayOffset: number, hour: number, minute = 0) => {
    const d = new Date(now)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(hour, minute, 0, 0)
    return d.getTime()
  }
  const tonight = at(0, 20)
  const nextMonday = () => {
    const d = new Date(now)
    // 1 = Monday. `|| 7` turns Sunday's 0 into "one day away" rather than
    // "today", and the `|| 7` on the difference keeps "it is Monday" meaning
    // next Monday rather than this morning, which has already gone.
    const delta = ((1 - d.getDay() + 7) % 7) || 7
    d.setDate(d.getDate() + delta)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  return [
    { key: 'quick.hour', at: Math.ceil((now + 3_600_000) / 60_000) * 60_000 },
    // Offered only while it is still ahead — a chip that silently schedules
    // something in the past is worse than one that is not there.
    ...(tonight > now ? [{ key: 'quick.tonight', at: tonight }] : []),
    { key: 'quick.tomorrow', at: at(1, 9) },
    { key: 'quick.nextWeek', at: nextMonday() },
  ]
}

function QuickTimes({
  t,
  startAt,
  onPick,
}: {
  t: (key: TranslationKey) => string
  startAt: number
  onPick: (at: number) => void
}) {
  const options = quickTimes(Date.now())
  return (
    <div className="chiprow" role="group" aria-label={t('schedule.quickTimes')}>
      <span className="chiprow__label">{t('schedule.quickTimes')}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className="chip chip--toggle"
          aria-pressed={Math.abs(startAt - o.at) < 60_000}
          onClick={() => onPick(o.at)}
        >
          {t(o.key as TranslationKey)}
        </button>
      ))}
    </div>
  )
}

type IntervalUnit = 'ms' | 's' | 'min' | 'hour' | 'day' | 'week' | 'month' | 'year'

const UNIT_MS: Record<IntervalUnit, number> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
}

/** Pick the largest unit that divides the stored ms evenly, so an existing
 * "every 2 days" job still reads as "2 days" rather than "172800000 ms". */
function guessUnit(ms: number): IntervalUnit {
  const order: IntervalUnit[] = ['year', 'month', 'week', 'day', 'hour', 'min', 's', 'ms']
  for (const u of order) {
    if (ms >= UNIT_MS[u] && ms % UNIT_MS[u] === 0) return u
  }
  return 'ms'
}

export function RecurrenceEditor({
  recurrence,
  onChange,
  retry,
  onRetryChange,
  burst,
  onBurstChange,
  runsSoFar = 0,
}: {
  recurrence: Recurrence
  onChange: (r: Recurrence) => void
  retry: RetryPolicy
  onRetryChange: (r: RetryPolicy) => void
  burst?: BurstPolicy
  onBurstChange: (b: BurstPolicy) => void
  runsSoFar?: number
}) {
  const { t, formatDateTime } = useI18n()
  const { state } = useApp()
  const settings = state.settings
  const [showAdvanced, setShowAdvanced] = useState(false)
  const effectiveBurst = burst ?? DEFAULT_BURST
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(() =>
    guessUnit(recurrence.intervalMs ?? (recurrence.intervalMinutes ?? 60) * 60_000),
  )

  const patch = (p: Partial<Recurrence>) => onChange({ ...recurrence, ...p })
  const patchBurst = (p: Partial<BurstPolicy>) => onBurstChange({ ...effectiveBurst, ...p })

  const issues = useMemo(
    () => [...validateRecurrence(recurrence), ...validateBurst(burst)],
    [recurrence, burst],
  )
  /**
   * The times this rule will *actually* produce.
   *
   * Shaped by the working calendar and quiet hours before being shown, because
   * those two rewrite the occurrence list downstream (see `AppState`'s
   * `shapeOccurrences`). A preview that skipped them would list 02:00 on a
   * public holiday and then deliver at 07:00 the following Monday — the one
   * kind of mistake a preview exists to prevent.
   */
  const rawPreview = useMemo(
    () => computeOccurrences(recurrence, { runsSoFar, count: 4 }),
    [recurrence, runsSoFar],
  )
  const calendar = settings.workCalendar ?? DEFAULT_WORK_CALENDAR
  /**
   * The preview, and what it cost.
   *
   * `applyWorkCalendarDetailed` rather than `applyWorkCalendar`, because the
   * plain one throws away the half of the answer that matters here: a fire time
   * the calendar had **no working day to move to** simply vanishes from the
   * list, and a preview showing three dates instead of four with no explanation
   * is exactly how a reminder disappears in silence. The detailed call reports
   * it; the block below prints it.
   */
  const { preview, warning } = useMemo(() => {
    const detailed = applyWorkCalendarDetailed(
      rawPreview,
      recurrence.workdayPolicy ?? 'off',
      calendar,
    )
    const quieted = applyQuietHours(detailed.occurrences, {
      enabled: settings.quietHoursEnabled,
      start: settings.quietStart,
      end: settings.quietEnd,
    })
    return {
      preview: quieted.slice(0, 4),
      warning: calendarWarning(detailed.adjustment),
    }
  }, [rawPreview, recurrence.workdayPolicy, calendar, settings])

  /** Did the calendar or the quiet window move anything? Worth saying if so. */
  const shifted = preview.length !== rawPreview.length || preview.some((t, i) => t !== rawPreview[i])

  const summary = summarizeRecurrence(recurrence)

  /**
   * The rule as one sentence.
   *
   * The list of dates below answers "when", and only for the next four. This
   * answers "what did I just set up", including the parts with no visible
   * consequence in four entries: an end condition twelve runs away, a jitter
   * window, a holiday policy that will not bite until October.
   */
  const clauses: string[] = [t(summary.key as 'recur.summary.once', summary.values)]
  if (recurrence.kind === 'weekly') {
    // With no day ticked the engine falls back to the start date's weekday
    // (see `calendarDayMatches`). Saying "weekly at 18:34" and leaving the
    // reader to work out *which* day from the four dates below is exactly the
    // guessing this sentence exists to remove.
    const days =
      recurrence.weekdays && recurrence.weekdays.length > 0
        ? [...recurrence.weekdays].sort()
        : [new Date(recurrence.startAt).getDay()]
    clauses.push(days.map((d) => t(`weekday.${d}` as TranslationKey)).join('、'))
  }
  if ((recurrence.workdayPolicy ?? 'off') !== 'off') {
    clauses.push(t(`workday.${recurrence.workdayPolicy}` as TranslationKey))
  } else if (recurrence.skipWeekends) {
    clauses.push(t('schedule.skipWeekends'))
  }
  if (settings.quietHoursEnabled) {
    clauses.push(t('describe.quiet', { start: settings.quietStart, end: settings.quietEnd }))
  }
  if (recurrence.jitterSeconds > 0) {
    clauses.push(t('describe.jitter', { n: recurrence.jitterSeconds }))
  }
  if (recurrence.endMode === 'afterCount' && recurrence.maxRuns !== undefined) {
    clauses.push(t('describe.endAfter', { n: recurrence.maxRuns }))
  } else if (recurrence.endMode === 'onDate' && recurrence.endDate !== undefined) {
    clauses.push(t('describe.endOn', { when: formatDateTime(recurrence.endDate) }))
  }
  if (effectiveBurst.enabled && effectiveBurst.count > 1) {
    clauses.push(t('describe.burst', { n: effectiveBurst.count }))
  }

  const cronCheck = recurrence.kind === 'cron' ? validateCron(recurrence.cron ?? '') : null

  const kinds: Array<{ value: RecurrenceKind; label: string }> = [
    { value: 'once', label: t('recur.once') },
    { value: 'daily', label: t('recur.daily') },
    { value: 'weekly', label: t('recur.weekly') },
    { value: 'monthly', label: t('recur.monthly') },
    { value: 'yearly', label: t('recur.yearly') },
    { value: 'interval', label: t('recur.interval') },
    { value: 'cron', label: t('recur.cron') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      {/*
        When, before how often.

        The repeat rule used to come first and the start time after it, which
        put the one field every single reminder needs below a control most of
        them leave on "once". "The moment it goes out" is the answer the user
        came here to give.
      */}
      <div className="field__row">
        <Field label={t('schedule.startAt')}>
          <input
            className="input"
            type="datetime-local"
            value={toLocalInput(recurrence.startAt)}
            onChange={(e) => patch({ startAt: fromLocalInput(e.target.value, recurrence.startAt) })}
          />
        </Field>

        {recurrence.kind !== 'once' && recurrence.kind !== 'interval' ? (
          <Field label={t('schedule.timeOfDay')}>
            <input
              className="input"
              type="time"
              value={recurrence.timeOfDay}
              onChange={(e) => patch({ timeOfDay: e.target.value })}
            />
          </Field>
        ) : null}
      </div>

      <QuickTimes
        t={t}
        startAt={recurrence.startAt}
        onPick={(at) => patch({ startAt: at, timeOfDay: hhmm(at) })}
      />

      <NaturalTimeInput onParsed={onChange} />

      <Field label={t('schedule.repeat')}>
        <div className="segmented" role="group" aria-label={t('schedule.repeat')}>
          {kinds.map((k) => (
            <button
              key={k.value}
              type="button"
              className="segmented__item"
              aria-pressed={recurrence.kind === k.value}
              onClick={() => {
                // The interval field displays a default (1 <unit>) even before
                // the user touches it — seed the real value to match, or the
                // unedited default reads as "0" to validation and blocks send.
                const needsSeed =
                  k.value === 'interval' &&
                  recurrence.intervalMs === undefined &&
                  recurrence.intervalMinutes === undefined
                patch(needsSeed ? { kind: k.value, intervalMs: UNIT_MS[intervalUnit] } : { kind: k.value })
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      </Field>

      {/* --- how often, in the units the chosen kind uses ------------------- */}

      <div className="field__row">
        {recurrence.kind === 'interval' ? (
          <Field label={t('schedule.interval')}>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <input
                className="input"
                type="number"
                min={1}
                max={1_000_000}
                value={Math.round(
                  (recurrence.intervalMs ?? (recurrence.intervalMinutes ?? 60) * 60_000) /
                    UNIT_MS[intervalUnit],
                )}
                onChange={(e) => {
                  const amount = Math.max(1, Number(e.target.value) || 1)
                  patch({ intervalMs: amount * UNIT_MS[intervalUnit] })
                }}
              />
              <select
                className="input"
                value={intervalUnit}
                onChange={(e) => {
                  const unit = e.target.value as IntervalUnit
                  const amount = Math.max(
                    1,
                    Math.round(
                      (recurrence.intervalMs ?? (recurrence.intervalMinutes ?? 60) * 60_000) /
                        UNIT_MS[intervalUnit],
                    ),
                  )
                  setIntervalUnit(unit)
                  patch({ intervalMs: amount * UNIT_MS[unit] })
                }}
              >
                <option value="ms">{t('schedule.unitMs')}</option>
                <option value="s">{t('schedule.unitSeconds')}</option>
                <option value="min">{t('schedule.unitMinutes')}</option>
                <option value="hour">{t('schedule.unitHours')}</option>
                <option value="day">{t('schedule.unitDays')}</option>
                <option value="week">{t('schedule.unitWeeks')}</option>
                <option value="month">{t('schedule.unitMonths')}</option>
                <option value="year">{t('schedule.unitYears')}</option>
              </select>
            </div>
          </Field>
        ) : null}

        {recurrence.kind === 'monthly' || recurrence.kind === 'yearly' ? (
          <Field label={t('schedule.dayOfMonth')}>
            <input
              className="input"
              type="number"
              min={1}
              max={31}
              value={recurrence.dayOfMonth ?? new Date(recurrence.startAt).getDate()}
              onChange={(e) => patch({ dayOfMonth: Number(e.target.value) })}
            />
          </Field>
        ) : null}
      </div>

      {recurrence.kind === 'weekly' ? (
        <Field label={t('schedule.weekdays')}>
          <div className="daypicker">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const selected = (recurrence.weekdays ?? []).includes(d)
              return (
                <button
                  key={d}
                  type="button"
                  className="daypicker__day"
                  aria-pressed={selected}
                  onClick={() => {
                    const current = recurrence.weekdays ?? []
                    patch({
                      weekdays: selected ? current.filter((x) => x !== d) : [...current, d].sort(),
                    })
                  }}
                >
                  {t(`weekday.${d}` as 'weekday.0')}
                </button>
              )
            })}
          </div>
        </Field>
      ) : null}

      {recurrence.kind === 'cron' ? (
        <Field
          label={t('schedule.cronExpr')}
          hint={
            cronCheck && !cronCheck.ok ? (
              <span style={{ color: 'var(--danger)' }}>{cronCheck.error}</span>
            ) : (
              t('schedule.cronHint')
            )
          }
        >
          <input
            className="input textarea--mono"
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            aria-invalid={cronCheck ? !cronCheck.ok : undefined}
            value={recurrence.cron ?? ''}
            onChange={(e) => patch({ cron: e.target.value })}
          />
        </Field>
      ) : null}

      {/* --- end condition ------------------------------------------------- */}

      {recurrence.kind !== 'once' ? (
        <div className="field__row">
          <Field label={t('schedule.ends')}>
            <Segmented
              value={recurrence.endMode}
              onChange={(v) => patch({ endMode: v })}
              options={[
                { value: 'never', label: t('schedule.endNever') },
                { value: 'onDate', label: t('schedule.endOnDate') },
                { value: 'afterCount', label: t('schedule.endAfter') },
              ]}
            />
          </Field>

          {recurrence.endMode === 'onDate' ? (
            <Field label={t('schedule.ends')}>
              <input
                className="input"
                type="datetime-local"
                value={toLocalInput(recurrence.endDate ?? recurrence.startAt + 86_400_000 * 30)}
                onChange={(e) =>
                  patch({ endDate: fromLocalInput(e.target.value, recurrence.startAt) })
                }
              />
            </Field>
          ) : null}

          {recurrence.endMode === 'afterCount' ? (
            <Field label={t('schedule.maxRuns')}>
              <input
                className="input"
                type="number"
                min={1}
                max={9999}
                value={recurrence.maxRuns ?? 10}
                onChange={(e) => patch({ maxRuns: Number(e.target.value) })}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {/* --- preview ------------------------------------------------------- */}

      <div
        className="card"
        style={{ background: 'var(--surface-inset)', boxShadow: 'none' }}
      >
        <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
          <div className="section-label" style={{ marginBottom: 'var(--sp-2)' }}>
            {t('schedule.upcoming')}
          </div>
          {/* The rule in one sentence, above the dates it produces. */}
          <div
            style={{
              marginBottom: 'var(--sp-2)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-1)',
              lineHeight: 'var(--leading-normal)',
            }}
          >
            {clauses.join(' · ')}
          </div>
          {shifted ? (
            <div
              style={{
                marginBottom: 'var(--sp-2)',
                fontSize: 'var(--text-xs)',
                color: 'var(--warning)',
              }}
            >
              {t('describe.shifted')}
            </div>
          ) : null}
          {/*
            The sends that will not happen, named at the point they are being
            created rather than discovered on the day they do not arrive.
            `CalendarWarning` has been computed on every save since the calendar
            shipped and rendered by nothing at all.
          */}
          {warning ? (
            <div className="banner banner--danger" style={{ marginBottom: 'var(--sp-2)' }} role="alert">
              <span className="banner__body">
                {warning.dropped.length > 0
                  ? t('cal.job.dropped', {
                      n: warning.dropped.length,
                      when: formatDateTime(warning.dropped[0]),
                    })
                  : warning.crowded > 0
                    ? t('cal.job.crowded', { n: warning.crowded })
                    : t('cal.job.spread', { min: Math.round(warning.spreadMs / 60_000) })}
              </span>
            </div>
          ) : null}
          {preview.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>
              {t('schedule.noMoreRuns')}
            </div>
          ) : (
            <ol
              style={{
                margin: 0,
                paddingInlineStart: 'var(--sp-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                fontSize: 'var(--text-sm)',
                color: 'var(--text-2)',
              }}
            >
              {preview.map((ms) => (
                <li key={ms}>{formatDateTime(ms)}</li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {issues.length > 0 ? (
        <div className="issues">
          {issues.map((issue, i) => (
            <div
              key={`${issue.key}-${i}`}
              className={`banner banner--${issue.severity === 'error' ? 'danger' : 'warning'}`}
            >
              <span className="banner__body">
                {t(issue.key as 'validate.noCron', issue.values)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* --- advanced ------------------------------------------------------ */}

      <button type="button" className="link" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? '−' : '+'} {t('common.advanced')}
      </button>

      {showAdvanced ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <div className="field__row">
            <Field label={t('schedule.jitter')} hint={t('schedule.jitterHint')}>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={3600}
                  value={recurrence.jitterSeconds}
                  onChange={(e) => patch({ jitterSeconds: Number(e.target.value) })}
                />
                <span style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>
                  {t('schedule.seconds')}
                </span>
              </div>
            </Field>

            <Field label={t('schedule.catchUp')}>
              <Segmented
                value={recurrence.catchUp}
                onChange={(v) => patch({ catchUp: v })}
                options={[
                  { value: 'fireOnce', label: t('schedule.catchUpFire') },
                  { value: 'skip', label: t('schedule.catchUpSkip') },
                ]}
              />
            </Field>
          </div>

          {/* Working days.
              `skipWeekends` above is the older, narrower switch and is kept
              for the schedules that already use it; this picker knows about
              public holidays and make-up workdays too, and can move a
              reminder *earlier*, which "push to Monday" cannot. Choosing
              anything other than "off" here supersedes it. */}
          <Field label={t('workday.title')} hint={t('workday.hint')}>
            <Segmented
              value={recurrence.workdayPolicy ?? 'off'}
              onChange={(v: WorkdayPolicy) => patch({ workdayPolicy: v })}
              ariaLabel={t('workday.title')}
              options={[
                { value: 'off', label: t('workday.off') },
                { value: 'skip', label: t('workday.skip') },
                { value: 'before', label: t('workday.before') },
                { value: 'after', label: t('workday.after') },
              ]}
            />
          </Field>

          {(recurrence.workdayPolicy ?? 'off') === 'off' ? (
            <Switch
              checked={recurrence.skipWeekends}
              onChange={(v) => patch({ skipWeekends: v })}
              title={t('schedule.skipWeekends')}
            />
          ) : (
            /*
              Only shown once the policy is on, and it says what the calendar
              currently contains rather than just naming it.

              The gap this closes: the switch above is the *only* thing that
              makes the working calendar do anything, and until now nothing
              connected the two — someone could turn this on with an empty
              calendar and get identical behaviour to leaving it off, because
              an empty calendar's only rule is the weekend.
            */
            <div className="field__hint">
              {calendar.holidays.length === 0 && calendar.workdays.length === 0
                ? t('workday.calendarEmpty')
                : t('workday.calendarSummary', {
                    h: calendar.holidays.length,
                    w: calendar.workdays.length,
                  })}
            </div>
          )}

          <Field label={t('schedule.retry')}>
            <div className="field__row">
              <div>
                <div className="field__hint">{t('schedule.retryAttempts')}</div>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={retry.maxAttempts}
                  onChange={(e) => onRetryChange({ ...retry, maxAttempts: Number(e.target.value) })}
                />
              </div>
              <div>
                <div className="field__hint">{t('schedule.retryBackoff')}</div>
                <input
                  className="input"
                  type="number"
                  min={5}
                  max={3600}
                  value={retry.backoffSeconds}
                  onChange={(e) =>
                    onRetryChange({ ...retry, backoffSeconds: Number(e.target.value) })
                  }
                />
              </div>
            </div>
          </Field>

          <Field label={t('schedule.burst')} hint={t('schedule.burstHint')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <Switch
                checked={effectiveBurst.enabled}
                onChange={(v) => patchBurst({ enabled: v })}
                title={t('schedule.burst')}
              />
              {effectiveBurst.enabled ? (
                <div className="field__row">
                  <div>
                    <div className="field__hint">{t('schedule.burstCount')}</div>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={MAX_BURST_COUNT}
                      value={effectiveBurst.count}
                      onChange={(e) => patchBurst({ count: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <div className="field__hint">{t('schedule.burstPacing')}</div>
                    <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={effectiveBurst.pacingMs}
                        onChange={(e) => patchBurst({ pacingMs: Number(e.target.value) })}
                      />
                      <span style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>
                        {t('schedule.burstPacingMs')}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </Field>
        </div>
      ) : null}
    </div>
  )
}


/**
 * The plain-language box.
 *
 * It never applies anything on its own. What it understood is shown first —
 * the next four fire times, in full — and applying is a deliberate click or an
 * Enter press. Auto-applying as you type looked good in isolation and was
 * awful in practice: half-typed 「每周」means "every week" for a keystroke or
 * two before it means 「每周一」, and watching the panel below thrash is worse
 * than typing the extra Enter.
 */
function NaturalTimeInput({ onParsed }: { onParsed: (r: Recurrence) => void }) {
  const { t, formatDateTime } = useI18n()
  const [text, setText] = useState('')

  const parsed = useMemo(() => (text.trim() ? parseNaturalTime(text) : null), [text])
  const preview = useMemo(
    () => (parsed ? computeOccurrences(parsed.recurrence, { count: 3 }) : []),
    [parsed],
  )

  const apply = () => {
    if (!parsed) return
    onParsed(parsed.recurrence)
    setText('')
  }

  return (
    <Field label={t('recur.natural')} hint={t('recur.naturalHint')}>
      <div className="btn-row">
        <input
          className="input"
          value={text}
          placeholder={t('recur.naturalPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
        />
        <button type="button" className="btn btn--secondary" disabled={!parsed} onClick={apply}>
          {t('recur.naturalApply')}
        </button>
      </div>

      {text.trim() ? (
        parsed ? (
          <div className="field__hint" style={{ color: 'var(--success)' }}>
            {t('recur.naturalUnderstood', { text: parsed.matched })}
            {preview.length > 0 ? ` — ${preview.map((ms) => formatDateTime(ms)).join(' · ')}` : ''}
          </div>
        ) : (
          <div className="field__hint" style={{ color: 'var(--warning)' }}>
            {t('recur.naturalUnknown')}
          </div>
        )
      ) : null}
    </Field>
  )
}
