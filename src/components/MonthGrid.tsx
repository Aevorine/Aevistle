/**
 * A month — or a single week — at a time, with each day's working status
 * editable in place.
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
 *
 * ## Three things this grid has to do at once
 *
 * A day cell carries three separate gestures, and the reason the markup looks
 * the way it does is that they must not fight:
 *
 *   - **Toggle** — the click. It owns the cell's own button.
 *   - **Open** — the reminder badge. It is a *sibling* button positioned over
 *     the cell, not a child of it: a `<button>` inside a `<button>` is invalid
 *     HTML and browsers resolve it by ignoring the inner one, so the badge
 *     would have silently toggled the holiday instead of opening the reminder.
 *   - **Move** — dragging that badge onto another day. The drop target is the
 *     wrapper, which is not itself a button, so a drop never lands as a click.
 *
 * ## And it has to be usable without a mouse
 *
 * There used to be 42 tab stops in a month and no way to move between days
 * except pressing Tab 42 times. It is now one tab stop with arrow keys inside
 * (a roving tabindex), which is what every date picker and spreadsheet does.
 * Horizontal arrows follow the *reading* direction, so they still mean
 * "tomorrow is that way" in Arabic.
 */

import { useEffect, useMemo, useRef } from 'react'
import { addIsoDays, isWorkingDayIso, parseIsoDate, toIsoDate, type WorkCalendar } from '../core/workCalendar'

export interface DayMark {
  /** Reminders landing on this day, for the impact preview. */
  count: number
  /** True when at least one of them was moved here by the calendar. */
  shifted: boolean
  /** Which reminders, so a click can open one and a drag can move one. */
  jobIds?: string[]
  /** Worst conflict on this day, if any — see `core/conflicts.ts`. */
  conflict?: 'error' | 'warning'
}

export type GridScope = 'month' | 'week'

/** An inclusive span of dates, as the user is dragging or shift-clicking it out. */
export interface DateRange {
  anchor: string
  focus: string
}

/** The two ends of a range, ordered. ISO dates sort chronologically as strings. */
export function orderedRange(range: DateRange): { from: string; to: string } {
  return range.anchor <= range.focus
    ? { from: range.anchor, to: range.focus }
    : { from: range.focus, to: range.anchor }
}

/** Every date in a range, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  // Bounded: a range this long is a mis-drag, and an unbounded loop here would
  // hang the renderer rather than produce a wrong answer.
  for (let cursor = from, i = 0; cursor <= to && i < 800; cursor = addIsoDays(cursor, 1), i++) {
    out.push(cursor)
  }
  return out
}

/** The first weekday of the week, given which days are the weekend. */
export function weekStartDay(weekend: number[]): number {
  for (let d = 0; d < 7; d++) {
    if (!weekend.includes(d)) return d
  }
  return 1
}

/** The seven dates of the week containing `iso`. */
export function weekOf(iso: string, firstDay: number): string[] {
  const date = parseIsoDate(iso)
  if (Number.isNaN(date.getTime())) return []
  const lead = (date.getDay() - firstDay + 7) % 7
  const start = addIsoDays(iso, -lead)
  return Array.from({ length: 7 }, (_, i) => addIsoDays(start, i))
}

export interface MonthGridProps {
  year: number
  month: number
  scope?: GridScope
  /** Which week to show when `scope` is `'week'`; any date inside it. */
  anchorDate?: string
  calendar: WorkCalendar
  marks?: Map<string, DayMark>
  onToggle: (iso: string) => void
  weekdayLabel: (day: number) => string
  dayTitle: (iso: string, working: boolean, mark?: DayMark) => string

  /** The cell that owns the single tab stop. Controlled by the parent so the
   *  day panel and the grid always agree about which day is being looked at. */
  focusedDate?: string
  onFocusDate?: (iso: string) => void
  /** Selected span, for the range actions. */
  selection?: DateRange | null
  onSelect?: (range: DateRange | null) => void
  /** The reminder badge was activated. */
  onOpenDay?: (iso: string) => void
  /** A reminder badge was dragged from `fromIso` and dropped on `toIso`. */
  onMoveJob?: (jobId: string, fromIso: string, toIso: string) => void
  /** Reading direction, so the horizontal arrows mean what they look like. */
  rtl?: boolean
  /** Accessible name for the grid. */
  label: string
  /** Announced on the badge, e.g. "3 reminders — open". */
  badgeLabel: (iso: string, mark: DayMark) => string
}

export function MonthGrid({
  year,
  month,
  scope = 'month',
  anchorDate,
  calendar,
  marks,
  onToggle,
  weekdayLabel,
  dayTitle,
  focusedDate,
  onFocusDate,
  selection,
  onSelect,
  onOpenDay,
  onMoveJob,
  rtl = false,
  label,
  badgeLabel,
}: MonthGridProps) {
  /**
   * Weeks start on the first day that is *not* a weekend, so a Friday–Saturday
   * weekend puts Sunday first and a Saturday–Sunday weekend puts Monday first.
   * Hard-coding Monday would push the Saudi weekend into the middle of the row
   * and make it read as two ordinary midweek days.
   */
  const firstDay = useMemo(() => weekStartDay(calendar.weekend), [calendar.weekend])

  const cells = useMemo(() => {
    if (scope === 'week') {
      const anchor = anchorDate ?? toIsoDate(new Date(year, month, 1).getTime())
      return weekOf(anchor, firstDay).map((iso) => ({ iso, day: parseIsoDate(iso).getDate() }))
    }
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
  }, [year, month, firstDay, scope, anchorDate])

  const todayIso = toIsoDate(Date.now())
  const dayCells = cells.filter((c): c is { iso: string; day: number } => c !== null)

  /**
   * The one cell in the tab order.
   *
   * Falls back to today, then to the first day shown — never to "none", which
   * would make the whole grid unreachable by keyboard, and never to "all of
   * them", which is the 42-tab-stops problem this replaced.
   */
  const rovingDate =
    (focusedDate && dayCells.some((c) => c.iso === focusedDate) ? focusedDate : undefined) ??
    (dayCells.some((c) => c.iso === todayIso) ? todayIso : undefined) ??
    dayCells[0]?.iso

  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  /** Set only by the key handler: moving focus by arrow should move the caret,
   *  but a parent re-render for an unrelated reason must not steal it. */
  const wantsFocus = useRef(false)

  useEffect(() => {
    if (!wantsFocus.current || !focusedDate) return
    wantsFocus.current = false
    cellRefs.current.get(focusedDate)?.focus()
  }, [focusedDate, year, month, scope])

  const range = selection ? orderedRange(selection) : null

  const move = (from: string, days: number, extend: boolean) => {
    const to = addIsoDays(from, days)
    wantsFocus.current = true
    onFocusDate?.(to)
    if (extend && onSelect) onSelect({ anchor: selection?.anchor ?? from, focus: to })
    else if (!extend && onSelect && selection) onSelect(null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, iso: string) => {
    // 1 in the reading direction: in Arabic the grid is mirrored, so the key
    // that points at the next column is the left one.
    const forward = rtl ? -1 : 1
    const step = (days: number) => {
      event.preventDefault()
      move(iso, days, event.shiftKey)
    }
    switch (event.key) {
      case 'ArrowRight':
        return step(forward)
      case 'ArrowLeft':
        return step(-forward)
      case 'ArrowDown':
        return step(7)
      case 'ArrowUp':
        return step(-7)
      case 'Home': {
        const lead = (parseIsoDate(iso).getDay() - firstDay + 7) % 7
        return step(-lead)
      }
      case 'End': {
        const lead = (parseIsoDate(iso).getDay() - firstDay + 7) % 7
        return step(6 - lead)
      }
      case 'PageUp':
        return step(event.shiftKey ? -365 : -28)
      case 'PageDown':
        return step(event.shiftKey ? 365 : 28)
      default:
        break
    }
  }

  const onCellClick = (event: React.MouseEvent, iso: string) => {
    onFocusDate?.(iso)
    // Shift-click extends from wherever the selection was anchored — the
    // gesture every file list and spreadsheet already trained. Without it a
    // two-week shutdown is fourteen clicks.
    if (event.shiftKey && onSelect) {
      onSelect({ anchor: selection?.anchor ?? iso, focus: iso })
      return
    }
    if (selection && onSelect) onSelect(null)
    onToggle(iso)
  }

  return (
    <div className="monthgrid" data-scope={scope}>
      <div className="monthgrid__head" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => {
          const day = (firstDay + i) % 7
          return (
            <span key={day} className="monthgrid__weekday" data-weekend={calendar.weekend.includes(day)}>
              {weekdayLabel(day)}
            </span>
          )
        })}
      </div>
      <div className="monthgrid__body" role="grid" aria-label={label}>
        {/*
          Weeks are real elements, not just a visual seven-column wrap.

          ARIA requires `grid > row > gridcell`; a grid whose cells are direct
          children is an invalid tree, and a screen reader given one announces
          the position wrongly or not at all — which on the one screen that has
          just grown arrow-key navigation would be worse than shipping no roles.
          The rows carry `display: contents` so the CSS grid still lays the
          cells out itself.
        */}
        {chunk(cells, 7).map((week, w) => (
        <div key={`w-${w}`} className="monthgrid__row" role="row">
        {week.map((cell, i) => {
          if (!cell) return <span key={`pad-${w}-${i}`} className="monthgrid__pad" role="presentation" />
          const working = isWorkingDayIso(cell.iso, calendar)
          const holiday = calendar.holidays.includes(cell.iso)
          const makeup = calendar.workdays.includes(cell.iso)
          const mark = marks?.get(cell.iso)
          const selected = range !== null && cell.iso >= range.from && cell.iso <= range.to
          const draggableJob = mark?.jobIds?.length === 1 ? mark.jobIds[0] : undefined

          return (
            <div
              key={cell.iso}
              className="monthgrid__cell"
              role="gridcell"
              aria-selected={selected || undefined}
              onDragOver={(event) => {
                if (!onMoveJob) return
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                if (!onMoveJob) return
                const payload = readDragPayload(event.dataTransfer.getData(DRAG_TYPE))
                if (!payload) return
                const { jobId, fromIso } = payload
                event.preventDefault()
                // Stops the drop from also arriving as a click on the cell
                // button underneath, which would toggle the holiday the user
                // was only trying to drop a reminder onto.
                event.stopPropagation()
                onMoveJob(jobId, fromIso, cell.iso)
              }}
            >
              <button
                type="button"
                ref={(node) => {
                  if (node) cellRefs.current.set(cell.iso, node)
                  else cellRefs.current.delete(cell.iso)
                }}
                className="monthgrid__day"
                data-working={working}
                data-holiday={holiday}
                data-makeup={makeup}
                data-today={cell.iso === todayIso}
                data-selected={selected}
                data-conflict={mark?.conflict ?? undefined}
                tabIndex={cell.iso === rovingDate ? 0 : -1}
                aria-pressed={holiday || makeup}
                title={dayTitle(cell.iso, working, mark)}
                onKeyDown={(event) => onKeyDown(event, cell.iso)}
                onClick={(event) => onCellClick(event, cell.iso)}
              >
                <span className="monthgrid__num">{cell.day}</span>
              </button>

              {mark && mark.count > 0 ? (
                <button
                  type="button"
                  className="monthgrid__marks"
                  data-shifted={mark.shifted}
                  data-conflict={mark.conflict ?? undefined}
                  /*
                    Part of the same roving tab stop as the day it sits on, so
                    arrowing to a day with reminders and pressing Tab reaches
                    "open this day" — and no other day's badge is in the tab
                    order. A permanent `tabIndex={-1}` here would have made the
                    only route to a reminder a mouse click on an 18px circle.
                  */
                  tabIndex={cell.iso === rovingDate ? 0 : -1}
                  aria-label={badgeLabel(cell.iso, mark)}
                  title={badgeLabel(cell.iso, mark)}
                  draggable={Boolean(draggableJob && onMoveJob)}
                  onDragStart={(event) => {
                    if (!draggableJob) return
                    event.dataTransfer.setData(DRAG_TYPE, dragPayload(draggableJob, cell.iso))
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onFocusDate?.(cell.iso)
                    onOpenDay?.(cell.iso)
                  }}
                >
                  {/* A count rather than one dot per reminder: three dots and
                      seven dots are indistinguishable at this size. */}
                  {mark.count}
                </button>
              ) : null}
            </div>
          )
        })}
        </div>
        ))}
      </div>
    </div>
  )
}

/** Split a flat list into fixed-size groups — one per week. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The drag payload's MIME type.
 *
 * A private type rather than `text/plain`, so dropping a reminder onto a text
 * field somewhere else does not paste a job id, and dragging text *into* the
 * calendar is ignored rather than read as a reschedule.
 */
export const DRAG_TYPE = 'application/x-aevistle-job'

/**
 * The payload carries the day it was dragged *from*, not only which reminder.
 *
 * That looked redundant and is not: a weekly rule appears on many squares, and
 * the plan for "move this to Thursday" is computed from the source weekday. A
 * drop handler that only knew the job id would have to guess which of its
 * occurrences was picked up — and guessing wrong rewrites the rule to the
 * wrong day of the week, silently.
 */
export const DRAG_SEPARATOR = '|'

export function dragPayload(jobId: string, fromIso: string): string {
  return `${jobId}${DRAG_SEPARATOR}${fromIso}`
}

export function readDragPayload(raw: string): { jobId: string; fromIso: string } | null {
  // `lastIndexOf`: the date is the tail and can never contain the separator,
  // whereas an id from some future source might.
  const cut = raw.lastIndexOf(DRAG_SEPARATOR)
  if (cut <= 0) return null
  const fromIso = raw.slice(cut + DRAG_SEPARATOR.length)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) return null
  return { jobId: raw.slice(0, cut), fromIso }
}
