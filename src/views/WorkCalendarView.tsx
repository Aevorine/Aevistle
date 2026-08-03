/**
 * The working calendar, as a screen of its own.
 *
 * It used to be one card near the bottom of Settings, and it had a problem no
 * amount of positioning would have fixed: **every reminder ignores it by
 * default.** `workdayPolicy` defaults to `'off'`, so someone could configure
 * eleven public holidays and a make-up Saturday, look at the result, and see
 * absolutely nothing change — which reads exactly like a broken feature.
 *
 * So promoting it is only half the job. The other half is on this screen:
 *
 *   - a month grid, so "is the 2nd a working day" has a visible answer;
 *   - country presets, so the first useful state is one click away instead of
 *     ten minutes of typing dates out of a government notice;
 *   - an impact preview that marks which reminders land on which days and
 *     which ones the calendar *moved* — the only thing that actually answers
 *     "did configuring this do anything";
 *   - a plain count of how many reminders currently use it, with a way to
 *     switch one on, because zero is the number it starts at.
 */

import { useMemo, useState } from 'react'
import { MonthGrid, type DayMark } from '../components/MonthGrid'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  PageHead,
  StatusChip,
  useToast,
} from '../components/ui'
import { IconCalendar, IconChevronLeft, IconChevronRight, IconPlus, IconX } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import { computeOccurrences } from '../core/schedule'
import { applyPreset, HOLIDAY_PRESETS } from '../core/holidayPresets'
import {
  applyWorkCalendar,
  DEFAULT_WORK_CALENDAR,
  isWorkingDay,
  parseDateList,
  toIsoDate,
  type WorkCalendar,
} from '../core/workCalendar'

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
/** How far ahead the impact preview looks. */
const PREVIEW_OCCURRENCES = 60

export function WorkCalendarView() {
  const { state, dispatch } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const calendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR

  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [paste, setPaste] = useState('')
  const [target, setTarget] = useState<'holidays' | 'workdays'>('holidays')

  const save = (patch: Partial<WorkCalendar>) => {
    dispatch({ type: 'patchSettings', patch: { workCalendar: { ...calendar, ...patch } } })
  }

  /**
   * One click, and the app works out which list the day belongs in.
   *
   * The user thinks "the 2nd is a day off" and "that Saturday we work". They
   * do not think "add to holidays" and "add to workdays", and making them pick
   * the right list is how a make-up day ends up in the holiday list, silently
   * doing the opposite of what was meant.
   */
  const toggleDay = (iso: string) => {
    const ms = new Date(iso).getTime()
    const isWeekendDay = calendar.weekend.includes(new Date(ms).getDay())
    if (calendar.holidays.includes(iso)) {
      save({ holidays: calendar.holidays.filter((d) => d !== iso) })
    } else if (calendar.workdays.includes(iso)) {
      save({ workdays: calendar.workdays.filter((d) => d !== iso) })
    } else if (isWeekendDay) {
      save({ workdays: [...calendar.workdays, iso].sort() })
    } else {
      save({ holidays: [...calendar.holidays, iso].sort() })
    }
  }

  const addPasted = () => {
    const { dates, rejected } = parseDateList(paste)
    if (dates.length === 0) {
      toast.push({ tone: 'error', title: t('workcal.noneParsed') })
      return
    }
    const existing = calendar[target]
    const merged = [...new Set([...existing, ...dates])].sort()
    save({ [target]: merged } as Partial<WorkCalendar>)
    setPaste('')
    toast.push({
      tone: rejected.length > 0 ? 'info' : 'success',
      title: t('workcal.added', { n: merged.length - existing.length }),
      detail:
        rejected.length > 0
          ? t('workcal.rejected', { n: rejected.length, list: rejected.slice(0, 5).join(' ') })
          : undefined,
    })
  }

  const usePreset = (id: string) => {
    const preset = HOLIDAY_PRESETS.find((p) => p.id === id)
    if (!preset) return
    const before = calendar.holidays.length
    const next = applyPreset(calendar, preset, cursor.year)
    save(next)
    toast.push({
      tone: 'success',
      title: t('workcal.presetApplied', {
        n: next.holidays.length - before,
        year: cursor.year,
      }),
      // Never presented as a complete calendar. Every one of these countries
      // has dates that move, and letting the user believe otherwise is how a
      // reminder ends up going out on a public holiday.
      detail: preset.hasMovingDates ? t('workcal.presetPartial') : undefined,
    })
  }

  // --- who actually uses this calendar --------------------------------------

  const users = state.jobs.filter((j) => (j.recurrence.workdayPolicy ?? 'off') !== 'off')

  /**
   * Where the next couple of months of reminders land, and which of them the
   * calendar moved.
   *
   * Computed twice per job on purpose — once with the policy off and once with
   * it on — because "moved" is not something a single occurrence list can
   * report. Comparing the two is the only way to mark the day it came *from*
   * as well as the day it landed on.
   */
  const marks = useMemo(() => {
    const out = new Map<string, DayMark>()
    const bump = (iso: string, shifted: boolean) => {
      const existing = out.get(iso)
      if (existing) {
        existing.count += 1
        existing.shifted = existing.shifted || shifted
      } else {
        out.set(iso, { count: 1, shifted })
      }
    }
    for (const job of users) {
      if (!job.enabled) continue
      const raw = computeOccurrences(job.recurrence, { count: PREVIEW_OCCURRENCES })
      const shaped = applyWorkCalendar(raw, job.recurrence.workdayPolicy ?? 'off', calendar)
      const rawSet = new Set(raw.map(toIsoDate))
      for (const at of shaped) {
        const iso = toIsoDate(at)
        bump(iso, !rawSet.has(iso))
      }
    }
    return out
  }, [users, calendar])

  const monthLabel = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(
    new Date(cursor.year, cursor.month, 1),
  )
  const shiftMonth = (by: number) => {
    const d = new Date(cursor.year, cursor.month + by, 1)
    setCursor({ year: d.getFullYear(), month: d.getMonth() })
  }

  const todayWorking = isWorkingDay(Date.now(), calendar)

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('workcal.title')}
          subtitle={t('workcal.subtitle')}
          action={
            <StatusChip
              tone={todayWorking ? 'success' : 'neutral'}
              dot
              label={todayWorking ? t('workcal.todayWorking') : t('workcal.todayOff')}
              title={toIsoDate(Date.now())}
            />
          }
        />

        {/*
          Said before anything else, because it is the answer to "I configured
          this and nothing happened". Zero is where every install starts.
        */}
        {users.length === 0 ? (
          <div className="banner banner--info">
            <IconCalendar size={16} />
            <div>
              <strong>{t('workcal.unusedTitle')}</strong>
              <div>{t('workcal.unusedBody')}</div>
            </div>
          </div>
        ) : (
          <div className="banner banner--success">
            <IconCalendar size={16} />
            <div>{t('workcal.usedBy', { n: users.length })}</div>
          </div>
        )}

        <div className="list-pane workcal__panes">
          <Card>
            <CardHeader
              title={monthLabel}
              hint={t('workcal.gridHint')}
              action={
                <div className="btn-row">
                  <IconButton label={t('workcal.prevMonth')} onClick={() => shiftMonth(-1)}>
                    <IconChevronLeft size={16} />
                  </IconButton>
                  <Button variant="ghost" onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}>
                    {t('workcal.today')}
                  </Button>
                  <IconButton label={t('workcal.nextMonth')} onClick={() => shiftMonth(1)}>
                    <IconChevronRight size={16} />
                  </IconButton>
                </div>
              }
            />
            <div className="card__body">
              <MonthGrid
                year={cursor.year}
                month={cursor.month}
                calendar={calendar}
                marks={marks}
                onToggle={toggleDay}
                weekdayLabel={(day) =>
                  new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(
                    // 2024-01-07 was a Sunday, so this indexes weekdays without
                    // depending on what today happens to be.
                    new Date(2024, 0, 7 + day),
                  )
                }
                dayTitle={(iso, working, mark) => {
                  const parts = [
                    formatDateTime(new Date(iso).getTime(), {
                      dateStyle: 'full',
                      timeStyle: undefined,
                    }),
                    working ? t('workcal.dayWorking') : t('workcal.dayOff'),
                  ]
                  if (mark?.count) {
                    parts.push(t('workcal.dayReminders', { n: mark.count }))
                    if (mark.shifted) parts.push(t('workcal.dayShifted'))
                  }
                  return parts.join(' · ')
                }}
              />
              <div className="monthgrid__legend">
                <span><i className="swatch swatch--off" /> {t('workcal.dayOff')}</span>
                <span><i className="swatch swatch--makeup" /> {t('workcal.makeupDays')}</span>
                <span><i className="swatch swatch--mark" /> {t('workcal.legendReminders')}</span>
                <span><i className="swatch swatch--shifted" /> {t('workcal.legendShifted')}</span>
              </div>
            </div>
          </Card>

          <Card>
            {/* The year comes from the month being viewed, so paging to
                December 2027 and pressing a preset fills in 2027 — and the
                hint says which year that will be before it is pressed. */}
            <CardHeader
              title={t('workcal.presets')}
              hint={t('workcal.presetsHint', { y: cursor.year })}
            />
            <div className="card__body">
              <div className="btn-row">
                {HOLIDAY_PRESETS.map((p) => (
                  <Button key={p.id} variant="secondary" onClick={() => usePreset(p.id)}>
                    {t(p.labelKey as TranslationKey)}
                  </Button>
                ))}
              </div>
              <div className="field__hint">{t('workcal.presetPartial')}</div>
            </div>
          </Card>

          <Card>
            <CardHeader title={t('workcal.weekend')} hint={t('workcal.weekendHint')} />
            <div className="card__body">
              <div className="daypicker">
                {WEEKDAY_ORDER.map((day) => {
                  const on = calendar.weekend.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      className="daypicker__day"
                      aria-pressed={on}
                      onClick={() =>
                        save({
                          weekend: on
                            ? calendar.weekend.filter((d) => d !== day)
                            : [...calendar.weekend, day].sort(),
                        })
                      }
                    >
                      {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(
                        new Date(2024, 0, 7 + day),
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title={t('workcal.paste')} hint={t('workcal.pasteHint')} />
            <div className="card__body form-rows">
              <Field label={t('workcal.pasteInto')}>
                <div className="btn-row">
                  <button
                    type="button"
                    className="chip chip--toggle"
                    aria-pressed={target === 'holidays'}
                    onClick={() => setTarget('holidays')}
                  >
                    {t('workcal.holidays')}
                  </button>
                  <button
                    type="button"
                    className="chip chip--toggle"
                    aria-pressed={target === 'workdays'}
                    onClick={() => setTarget('workdays')}
                  >
                    {t('workcal.makeupDays')}
                  </button>
                </div>
              </Field>
              <textarea
                className="textarea workcal__paste"
                value={paste}
                placeholder="2026-10-01 2026-10-02 2026/10/3 20261004"
                onChange={(e) => setPaste(e.target.value)}
              />
              <Button
                variant="secondary"
                icon={<IconPlus size={15} />}
                onClick={addPasted}
                disabled={paste.trim().length === 0}
              >
                {t('workcal.add')}
              </Button>
            </div>
          </Card>

          {(['holidays', 'workdays'] as const).map((list) => (
            <Card key={list}>
              <CardHeader
                title={list === 'holidays' ? t('workcal.holidays') : t('workcal.makeupDays')}
                action={
                  calendar[list].length > 0 ? (
                    <Button variant="ghost" onClick={() => save({ [list]: [] } as Partial<WorkCalendar>)}>
                      {t('workcal.clearList')}
                    </Button>
                  ) : undefined
                }
              />
              <div className="card__body">
                {calendar[list].length === 0 ? (
                  <EmptyState icon={<IconCalendar size={20} />} title={t('workcal.none')} />
                ) : (
                  <div className="workcal__dates">
                    {calendar[list].map((iso) => (
                      <span key={iso} className={`chip ${list === 'workdays' ? 'chip--warning' : ''}`}>
                        <span
                          className="chip__text"
                          title={formatDateTime(new Date(iso).getTime(), {
                            dateStyle: 'full',
                            timeStyle: undefined,
                          })}
                        >
                          {iso}
                        </span>
                        <button
                          type="button"
                          className="chip__remove"
                          aria-label={t('common.delete')}
                          onClick={() =>
                            save({
                              [list]: calendar[list].filter((d) => d !== iso),
                            } as Partial<WorkCalendar>)
                          }
                        >
                          <IconX size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
