/**
 * Which days count as working days.
 *
 * One shared calendar rather than one per reminder: a public holiday is a fact
 * about the year, not about a particular schedule, and asking someone to enter
 * the same eleven dates into six reminders is how five of them end up wrong.
 *
 * Make-up workdays get equal billing with holidays because in several
 * countries they are half the answer — a calendar that only knows "weekends
 * are off" is wrong on exactly the working Saturdays people most need warning
 * about.
 */

import { useState } from 'react'
import { Button, Card, CardHeader, Field, StatusChip, useToast } from '../components/ui'
import { IconCalendar, IconPlus, IconX } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import {
  DEFAULT_WORK_CALENDAR,
  isWorkingDay,
  parseDateList,
  toIsoDate,
  type WorkCalendar,
} from '../core/workCalendar'

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function WorkCalendarCard() {
  const { state, dispatch } = useApp()
  const { t, formatDateTime } = useI18n()
  const toast = useToast()
  const calendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR
  const [paste, setPaste] = useState('')
  const [target, setTarget] = useState<'holidays' | 'workdays'>('holidays')

  const save = (patch: Partial<WorkCalendar>) => {
    dispatch({
      type: 'patchSettings',
      patch: { workCalendar: { ...calendar, ...patch } },
    })
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
    // Rejections are reported, never swallowed — a holiday list that quietly
    // lost three dates is worse than one that refused to load.
    toast.push({
      tone: rejected.length > 0 ? 'info' : 'success',
      title: t('workcal.added', { n: merged.length - existing.length }),
      detail:
        rejected.length > 0
          ? t('workcal.rejected', { n: rejected.length, list: rejected.slice(0, 5).join(' ') })
          : undefined,
    })
  }

  const remove = (list: 'holidays' | 'workdays', iso: string) => {
    save({ [list]: calendar[list].filter((d) => d !== iso) } as Partial<WorkCalendar>)
  }

  const todayWorking = isWorkingDay(Date.now(), calendar)

  return (
    <Card>
      <CardHeader
        title={t('workcal.title')}
        hint={t('workcal.hint')}
        action={
          <StatusChip
            tone={todayWorking ? 'success' : 'neutral'}
            dot
            label={todayWorking ? t('workcal.todayWorking') : t('workcal.todayOff')}
            title={toIsoDate(Date.now())}
          />
        }
      />
      <div className="card__body form-rows">
        <Field label={t('workcal.weekend')} hint={t('workcal.weekendHint')}>
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
                    // 2024-01-07 was a Sunday, so this indexes weekdays without
                    // depending on what today happens to be.
                    new Date(2024, 0, 7 + day),
                  )}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label={t('workcal.paste')} hint={t('workcal.pasteHint')}>
          <div className="workcal__entry">
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
        </Field>

        {(['holidays', 'workdays'] as const).map((list) => (
          <Field
            key={list}
            label={list === 'holidays' ? t('workcal.holidays') : t('workcal.makeupDays')}
          >
            {calendar[list].length === 0 ? (
              <div className="field__hint">{t('workcal.none')}</div>
            ) : (
              <div className="workcal__dates">
                {calendar[list].map((iso) => (
                  <span key={iso} className={`chip ${list === 'workdays' ? 'chip--warning' : ''}`}>
                    <span className="chip__text" title={formatDateTime(new Date(iso).getTime(), { dateStyle: 'full', timeStyle: undefined })}>
                      {iso}
                    </span>
                    <button
                      type="button"
                      className="chip__remove"
                      aria-label={t('common.delete')}
                      onClick={() => remove(list, iso)}
                    >
                      <IconX size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Field>
        ))}

        <div className="field__hint">
          <IconCalendar size={12} /> {t('workcal.usage')}
        </div>
      </div>
    </Card>
  )
}
