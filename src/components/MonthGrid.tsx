/**
 * A month at a time, with each day's working status editable in place.
 *
 * The calendar used to be two textareas you pasted dates into. It was correct
 * and it was impossible to check: nothing on screen answered "so is the 2nd a
 * working day or not", which is the only question anyone actually has. Making
 * the answer visible is most of what turns this screen from a settings form
 * into something worth opening.
 *
 * Clicking a day cycles it: working → off → working. Which list the change
 * lands in depends on what the day would be by default — marking a Saturday as
 * worked is a make-up day, marking a Tuesday as off is a holiday — so the user
 * never has to know those are two separate lists.
 */

import { useMemo } from 'react'
import { isWorkingDay, toIsoDate, type WorkCalendar } from '../core/workCalendar'

export interface DayMark {
  /** Reminders landing on this day, for the impact preview. */
  count: number
  /** True when at least one of them was moved here by the calendar. */
  shifted: boolean
}

export function MonthGrid({
  year,
  month,
  calendar,
  marks,
  onToggle,
  weekdayLabel,
  dayTitle,
}: {
  year: number
  month: number
  calendar: WorkCalendar
  marks?: Map<string, DayMark>
  onToggle: (iso: string) => void
  weekdayLabel: (day: number) => string
  dayTitle: (iso: string, working: boolean, mark?: DayMark) => string
}) {
  /**
   * Weeks start on the first day that is *not* a weekend, so a Friday–Saturday
   * weekend puts Sunday first and a Saturday–Sunday weekend puts Monday first.
   * Hard-coding Monday would push the Saudi weekend into the middle of the row
   * and make it read as two ordinary midweek days.
   */
  const firstDay = useMemo(() => {
    for (let d = 0; d < 7; d++) {
      if (!calendar.weekend.includes(d)) return d
    }
    return 1
  }, [calendar.weekend])

  const cells = useMemo(() => {
    const first = new Date(year, month, 1)
    const lead = (first.getDay() - firstDay + 7) % 7
    const days = new Date(year, month + 1, 0).getDate()
    const out: Array<{ iso: string; day: number } | null> = []
    for (let i = 0; i < lead; i++) out.push(null)
    for (let d = 1; d <= days; d++) {
      out.push({ iso: toIsoDate(new Date(year, month, d).getTime()), day: d })
    }
    // Pad to whole weeks so the grid does not reflow as months change length.
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [year, month, firstDay])

  const todayIso = toIsoDate(Date.now())

  return (
    <div className="monthgrid">
      <div className="monthgrid__head">
        {Array.from({ length: 7 }, (_, i) => {
          const day = (firstDay + i) % 7
          return (
            <span key={day} className="monthgrid__weekday" data-weekend={calendar.weekend.includes(day)}>
              {weekdayLabel(day)}
            </span>
          )
        })}
      </div>
      <div className="monthgrid__body">
        {cells.map((cell, i) => {
          if (!cell) return <span key={`pad-${i}`} className="monthgrid__pad" />
          const ms = new Date(cell.iso).getTime()
          const working = isWorkingDay(ms, calendar)
          const holiday = calendar.holidays.includes(cell.iso)
          const makeup = calendar.workdays.includes(cell.iso)
          const mark = marks?.get(cell.iso)
          return (
            <button
              key={cell.iso}
              type="button"
              className="monthgrid__day"
              data-working={working}
              data-holiday={holiday}
              data-makeup={makeup}
              data-today={cell.iso === todayIso}
              title={dayTitle(cell.iso, working, mark)}
              onClick={() => onToggle(cell.iso)}
            >
              <span className="monthgrid__num">{cell.day}</span>
              {mark && mark.count > 0 ? (
                <span className="monthgrid__marks" data-shifted={mark.shifted}>
                  {/* A count rather than one dot per reminder: three dots and
                      seven dots are indistinguishable at this size. */}
                  {mark.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
