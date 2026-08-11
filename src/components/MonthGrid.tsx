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
import { addIsoDays, parseIsoDate, toIsoDate, type WorkCalendar } from '../core/schedule/workCalendar'
import type { SolarTermId } from '../core/schedule/solarTerms'

/**
 * One send, as a day square shows it: time · recipient · subject.
 *
 * Deliberately raw strings rather than a finished sentence. Building the label
 * needs the locale's time format and two fallback words, and doing that where
 * the marks are computed would put `t` and `formatDateTime` — both rebuilt on
 * every render — into the dependency list of the memo that this whole screen's
 * performance rests on. See `WorkCalendarView`.
 */
/** What happened to a past send, as far as the app can honestly tell. See `WorkCalendarView`. */
export type SendDeliveryStatus = 'delivered' | 'failed' | 'retrying'

export interface DaySend {
  jobId: string
  /** When it fires, after the calendar and quiet hours have had their say. */
  at: number
  /** First recipient. Empty when the reminder has none yet. */
  to: string
  /** Empty when it has no subject yet. */
  subject: string
  /** True when the calendar moved this send onto this day. */
  shifted: boolean
  /**
   * True when this send is one of a pile-up on a single minute.
   *
   * Per-send, not per-day. The square already got a border when *something* on
   * it was in conflict, which on a day holding three sends says a problem is
   * here and leaves the reader to work out which of the three it is about.
   */
  conflict?: boolean
  /**
   * A single glyph for the avatar chip — a contact's initial, or the first
   * letter of the recipient's local part. `undefined` when there is no
   * recipient to draw one from.
   */
  initials?: string
  /**
   * What became of this send, correlated against the logs and the offline
   * queue. `undefined` for a send in the future, and for one in the past that
   * left no trace to correlate against — never guessed. See `WorkCalendarView`.
   */
  status?: SendDeliveryStatus
}

export interface DayMark {
  /** Reminders landing on this day, for the impact preview. */
  count: number
  /** True when at least one of them was moved here by the calendar. */
  shifted: boolean
  /** Which reminders, so a click can open one and a drag can move one. */
  jobIds?: string[]
  /** Worst conflict on this day, if any — see `core/conflicts.ts`. */
  conflict?: 'error' | 'warning'
  /**
   * The sends themselves, earliest first — what the square lists.
   *
   * Prebuilt by the caller, so a cell reads one already-sorted array rather
   * than filtering a flat list of every send in the month. Sorting 42 short
   * arrays once beats sorting inside 42 renders.
   */
  lines?: DaySend[]
  /**
   * How busy this day is, 1–5, or absent for a day with nothing on it. The
   * heatmap step — see `LOAD_STEPS` in `WorkCalendarView`.
   */
  level?: number
}

/**
 * How many rows a square spends on sends before it stops and says "+N more".
 *
 * Three, because that is what fits above the fold of a cell at every width the
 * grid is drawn at without the month growing taller than the window. The rest
 * are not hidden — the badge still counts all of them, "+N more" opens the day,
 * and the day panel lists every one.
 *
 * "+N more" costs one of the three. It is a row like any other and the cell
 * cannot shrink to fit a fourth — flex items in a column have `min-height:
 * auto` — so a day that overflows lists two sends and the button rather than
 * three sends and a button clipped out of sight. It was clipped out of sight,
 * and `hidden > 0` is the only state it is ever drawn in, so the affordance
 * had never once been visible while still holding a tab stop.
 */
export const MAX_CELL_SENDS = 3

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
  /**
   * The dragged reminder's pointer has crossed onto a new cell — preview only,
   * fired at most once per cell entered rather than on every native `dragover`
   * tick. `fromAt` is the instant of the specific occurrence being dragged (the
   * badge falls back to the day's earliest one), and `x`/`y` are the pointer's
   * `clientX`/`clientY` at that moment, for a tooltip to anchor itself to.
   */
  onDragHover?: (info: { jobId: string; fromIso: string; toIso: string; fromAt: number; x: number; y: number }) => void
  /** The drag that `onDragHover` was reporting on has ended (drop or cancel). */
  onDragHoverEnd?: () => void
  /**
   * Days queued for the calendar's gap-compose, so their square can say so.
   * Populated by ctrl/cmd-click on an empty square — see `onGapToggle`.
   */
  gapDates?: Set<string>
  /**
   * An empty square was ctrl/cmd-clicked: add or remove it from the gap-compose
   * batch. Never fires on a square that already has sends — `onCreateDay`'s own
   * `canCreate` rule decides that, the same rule the double-click uses, so a
   * square you cannot start a *single* reminder from cannot join a batch of
   * them either.
   */
  onGapToggle?: (iso: string) => void
  /** Reading direction, so the horizontal arrows mean what they look like. */
  rtl?: boolean
  /** Accessible name for the grid. */
  label: string
  /** Announced on the badge, e.g. "3 reminders — open". */
  badgeLabel: (iso: string, mark: DayMark) => string

  // --- the scheduling console ------------------------------------------------

  /**
   * List each day's sends inside its square, rather than only counting them.
   *
   * Off at 560px and below by stylesheet, not by this flag: see the note on
   * `.monthgrid__sends` in `app.css`. Seven columns of a 360px phone is a 38px
   * cell, and 38px holds a date or a line of text, not both.
   */
  showSends?: boolean
  /** The locale's short time, memoised by the caller. Called at most 3× per cell. */
  formatTime?: (at: number) => string
  /** Stands in for a reminder with no recipients yet. */
  noRecipientLabel?: string
  /** Stands in for a reminder with no subject yet. */
  noSubjectLabel?: string
  /** "+2 more" — the affordance that opens the day panel. */
  moreLabel?: (n: number) => string
  /** A listed send was clicked: open that reminder for editing. */
  onOpenSend?: (jobId: string, iso: string) => void
  /** An empty square was double-clicked: start a reminder for that day. */
  onCreateDay?: (iso: string) => void
  /** Announced on an empty square that can be double-clicked. */
  createHint?: string
  /**
   * Paint the busyness tint (`data-load`). On by default; off leaves every
   * square its ordinary colour while the badge keeps counting. See the switch
   * in `WorkCalendarView`.
   */
  heatmapOn?: boolean
  /** Hover text for one avatar chip, e.g. "Recipient: Alex". */
  initialsAriaLabel?: (recipient: string) => string
  /** The word for a send's delivery status, folded into its row's own label. */
  sendStatusLabel?: (status: SendDeliveryStatus) => string
  /**
   * The 节气 governing the displayed month, computed by the caller
   * (`core/solarTerms.ts`) — this component only carries it onto the grid's
   * own element as `data-solar-term`. Consumed purely in CSS, and only under
   * the runecircuit style; every other style ignores the attribute entirely.
   */
  solarTerm?: SolarTermId
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
  onDragHover,
  onDragHoverEnd,
  gapDates,
  onGapToggle,
  rtl = false,
  label,
  badgeLabel,
  showSends = false,
  formatTime,
  noRecipientLabel = '',
  noSubjectLabel = '',
  moreLabel,
  onOpenSend,
  onCreateDay,
  createHint,
  heatmapOn = true,
  initialsAriaLabel,
  sendStatusLabel,
  solarTerm,
}: MonthGridProps) {
  /**
   * Weeks start on the first day that is *not* a weekend, so a Friday–Saturday
   * weekend puts Sunday first and a Saturday–Sunday weekend puts Monday first.
   * Hard-coding Monday would push the Saudi weekend into the middle of the row
   * and make it read as two ordinary midweek days.
   */
  const firstDay = useMemo(() => weekStartDay(calendar.weekend), [calendar.weekend])

  // The weekday travels with the cell so the render below never has to parse
  // the date again to ask whether it is a weekend.
  const cells = useMemo(() => {
    if (scope === 'week') {
      const anchor = anchorDate ?? toIsoDate(new Date(year, month, 1).getTime())
      return weekOf(anchor, firstDay).map((iso) => {
        const date = parseIsoDate(iso)
        return { iso, day: date.getDate(), weekday: date.getDay() }
      })
    }
    const first = new Date(year, month, 1)
    const lead = (first.getDay() - firstDay + 7) % 7
    const days = new Date(year, month + 1, 0).getDate()
    const out: Array<{ iso: string; day: number; weekday: number } | null> = []
    for (let i = 0; i < lead; i++) out.push(null)
    for (let d = 1; d <= days; d++) {
      const date = new Date(year, month, d)
      out.push({ iso: toIsoDate(date.getTime()), day: d, weekday: date.getDay() })
    }
    // Pad to whole weeks so the grid does not reflow as months change length.
    while (out.length % 7 !== 0) out.push(null)
    return out
  }, [year, month, firstDay, scope, anchorDate])

  /*
   * Membership as a set, once, rather than three linear scans per cell.
   *
   * A holiday preset fills these arrays over a three-year range by default —
   * `WorkCalendarView` offers "from 2026 to 2028" out of the box — so
   * `holidays` can hold tens of entries and `workdays` a similar number. Each
   * of the 42 cells below asked `includes` of both, and `isWorkingDayIso`
   * asked a third time on top of parsing the date. Set lookups make that
   * constant, and the `weekend` set removes the last `includes` from the loop.
   */
  const holidaySet = useMemo(() => new Set(calendar.holidays), [calendar.holidays])
  const workdaySet = useMemo(() => new Set(calendar.workdays), [calendar.workdays])
  const weekendSet = useMemo(() => new Set(calendar.weekend), [calendar.weekend])

  /**
   * `isWorkingDayIso` without re-scanning the arrays. Same precedence, and the
   * same answer: `holidays` beats `workdays` beats the weekend.
   */
  const workingOn = (iso: string, weekday: number): boolean => {
    if (holidaySet.has(iso)) return false
    if (workdaySet.has(iso)) return true
    return !weekendSet.has(weekday)
  }

  const todayIso = toIsoDate(Date.now())
  const dayCells = cells.filter((c): c is { iso: string; day: number; weekday: number } => c !== null)

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

  /**
   * What is being dragged, remembered outside React state.
   *
   * `dataTransfer.getData` is unreadable during `dragover` in every standards-
   * compliant browser (Chromium included) — only `dragstart` and `drop` may
   * read it, for the same reason a web page cannot read what you drag in from
   * your file manager before you drop it. So the payload is captured once, at
   * `dragstart`, into a plain ref: one HTML5 drag gesture runs synchronously
   * and never overlaps another, so there is nothing here for two drags to race
   * over. `lastHoverIso` is the throttle — `dragover` fires on every pixel of
   * pointer movement, and `onDragHover` only needs to know when a *new* cell
   * was entered.
   */
  const draggingRef = useRef<{ jobId: string; fromIso: string; fromAt: number } | null>(null)
  const lastHoverIso = useRef<string | null>(null)

  const beginDrag = (jobId: string, fromIso: string, fromAt: number) => {
    draggingRef.current = { jobId, fromIso, fromAt }
    lastHoverIso.current = null
  }
  const endDrag = () => {
    draggingRef.current = null
    lastHoverIso.current = null
    onDragHoverEnd?.()
  }

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
    /*
     * The second click of a double-click never toggles.
     *
     * Double-clicking an empty square starts a new reminder for that day, and
     * the browser delivers that as click → click → dblclick. Left alone, the
     * gesture would have marked the day as a holiday and then unmarked it — the
     * square flashing red, and *two* entries on the undo stack for something
     * the user never asked for. `detail` is the click count, so this drops the
     * second one; `WorkCalendarView` undoes the first when the double-click
     * turns out to be a create. Both halves are needed: this one alone still
     * leaves one stray toggle behind.
     */
    if (event.detail > 1) return
    // Ctrl/Cmd-click on an *empty* square adds it to the gap-compose batch
    // instead of toggling it. Same `canCreate` rule the double-click already
    // enforces, recomputed here rather than threaded through as a second prop:
    // a square with sends on it is somebody reaching for one of them with a
    // held-down modifier key, not a request to queue the day.
    if ((event.ctrlKey || event.metaKey) && onGapToggle) {
      const canCreate = Boolean(onCreateDay) && !marks?.get(iso)?.count
      if (canCreate) {
        onGapToggle(iso)
        return
      }
    }
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
    <div
      className="monthgrid"
      data-scope={scope}
      data-lines={showSends || undefined}
      data-solar-term={solarTerm}
    >
      <div className="monthgrid__head" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => {
          const day = (firstDay + i) % 7
          return (
            <span key={day} className="monthgrid__weekday" data-weekend={weekendSet.has(day)}>
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
          const holiday = holidaySet.has(cell.iso)
          const makeup = workdaySet.has(cell.iso)
          const working = workingOn(cell.iso, cell.weekday)
          const mark = marks?.get(cell.iso)
          const selected = range !== null && cell.iso >= range.from && cell.iso <= range.to
          const draggableJob = mark?.jobIds?.length === 1 ? mark.jobIds[0] : undefined
          // O(1) per cell: an already-sorted array is read, sliced to at most
          // three, and never scanned. The whole point of `lines` being prebuilt.
          const lines = showSends ? (mark?.lines ?? EMPTY_SENDS) : EMPTY_SENDS
          const listed =
            lines.length > MAX_CELL_SENDS ? lines.slice(0, MAX_CELL_SENDS - 1) : lines
          const hidden = lines.length - listed.length
          const canCreate = Boolean(onCreateDay) && !mark?.count

          return (
            <div
              key={cell.iso}
              className="monthgrid__cell"
              role="gridcell"
              aria-selected={selected || undefined}
              onDoubleClick={() => {
                // Only an *empty* square. A double-click on a square that has
                // sends on it is somebody aiming at one of them and missing,
                // and answering that with a brand-new reminder for a day that
                // already has three is not a guess worth making.
                if (canCreate) onCreateDay?.(cell.iso)
              }}
              onDragOver={(event) => {
                if (!onMoveJob) return
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                // Once per cell entered, not once per pixel of pointer motion —
                // see the comment on `draggingRef` above.
                if (draggingRef.current && lastHoverIso.current !== cell.iso) {
                  lastHoverIso.current = cell.iso
                  onDragHover?.({
                    jobId: draggingRef.current.jobId,
                    fromIso: draggingRef.current.fromIso,
                    toIso: cell.iso,
                    fromAt: draggingRef.current.fromAt,
                    x: event.clientX,
                    y: event.clientY,
                  })
                }
              }}
              onDrop={(event) => {
                if (!onMoveJob) return
                const payload = readDragPayload(event.dataTransfer.getData(DRAG_TYPE))
                endDrag()
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
                data-gap={gapDates?.has(cell.iso) || undefined}
                data-conflict={mark?.conflict ?? undefined}
                /* The heatmap. A step, not a count: the square is tinted by how
                   busy the day is, and the badge on top still says exactly how
                   many. Absent — not zero — on a day with nothing on it, so the
                   stylesheet never has to paint "no load" as a colour. */
                data-load={heatmapOn ? (mark?.level ?? undefined) : undefined}
                tabIndex={cell.iso === rovingDate ? 0 : -1}
                aria-pressed={holiday || makeup}
                title={
                  canCreate && createHint
                    ? `${dayTitle(cell.iso, working, mark)} · ${createHint}`
                    : dayTitle(cell.iso, working, mark)
                }
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
                  data-chips={mark.count <= MAX_CELL_SENDS ? true : undefined}
                  /*
                    Part of the same roving tab stop as the day it sits on, so
                    arrowing to a day with reminders and pressing Tab reaches
                    "open this day" — and no other day's badge is in the tab
                    order. A permanent `tabIndex={-1}` here would have made the
                    only route to a reminder a mouse click on an 18px circle.
                  */
                  tabIndex={cell.iso === rovingDate ? 0 : -1}
                  /*
                    The chips below are decoration only — this label is still
                    the single sentence a screen reader hears, exactly as it was
                    before the chips existed. A per-chip `aria-label` would have
                    read three fragments in place of the one sentence that
                    actually says how many and which day.
                  */
                  aria-label={badgeLabel(cell.iso, mark)}
                  title={badgeLabel(cell.iso, mark)}
                  draggable={Boolean(draggableJob && onMoveJob)}
                  onDragStart={(event) => {
                    if (!draggableJob) return
                    event.dataTransfer.setData(DRAG_TYPE, dragPayload(draggableJob, cell.iso))
                    event.dataTransfer.effectAllowed = 'move'
                    // No single occurrence to point at from a badge — it stands
                    // for every send this day, not one row of `lines`. The
                    // earliest is close enough for a preview that never blocks.
                    beginDrag(draggableJob, cell.iso, mark.lines?.[0]?.at ?? Date.now())
                  }}
                  onDragEnd={endDrag}
                  onClick={(event) => {
                    event.stopPropagation()
                    onFocusDate?.(cell.iso)
                    onOpenDay?.(cell.iso)
                  }}
                >
                  {/* Up to three overlapping initials read faster than a
                      number — "who is this about" instead of "how many". Past
                      three the chips would overlap into an unreadable stack,
                      so the count comes back, exactly as it always has.
                      `.monthgrid__markscount` rides along, hidden, as the
                      narrow-width fallback: three 14px chips do not fit
                      inside the 38px cell this app is built down to (see the
                      "38px holds a date or a line of text" note below), so
                      the ≤560px media query swaps which of the two is
                      display:none rather than trying to shrink chips that
                      have nowhere left to shrink to. */}
                  {mark.count <= MAX_CELL_SENDS && mark.lines && mark.lines.length > 0 ? (
                    <>
                      <span className="monthgrid__marksavatars" aria-hidden="true">
                        {mark.lines.map((send) => (
                          <span
                            key={`${send.jobId}-${send.at}`}
                            className="monthgrid__markschip"
                            title={initialsAriaLabel ? initialsAriaLabel(send.to || noRecipientLabel) : undefined}
                          >
                            {send.initials ?? '–'}
                          </span>
                        ))}
                      </span>
                      <span className="monthgrid__markscount" aria-hidden="true">
                        {mark.count}
                      </span>
                    </>
                  ) : (
                    mark.count
                  )}
                </button>
              ) : null}

              {/*
                What actually happens on this day, in the square.

                A number told you something was scheduled and nothing else — you
                could see that the 2nd was busy and had no way to find out what
                with, which made the calendar a picture of the schedule rather
                than a way to work on it.

                Buttons, and siblings of the day button rather than children of
                it, for the reason the badge above is: a `<button>` inside a
                `<button>` is invalid HTML and browsers resolve it by ignoring
                the inner one, so every one of these would silently have toggled
                the holiday instead of opening the reminder.

                The container does not take pointer events; only the rows do. A
                click on the gap between two rows still reaches the day button
                underneath, so "click the square to mark it a holiday" keeps
                working on a square that has sends on it.
              */}
              {listed.length > 0 ? (
                <div className="monthgrid__sends">
                  {listed.map((send) => {
                    const who = send.to || noRecipientLabel
                    const subject = send.subject || noSubjectLabel
                    const time = formatTime ? formatTime(send.at) : ''
                    const statusWord = send.status && sendStatusLabel ? sendStatusLabel(send.status) : ''
                    const full = [time, who, subject, statusWord].filter(Boolean).join(' · ')
                    return (
                      <button
                        key={`${send.jobId}-${send.at}`}
                        type="button"
                        className="monthgrid__send"
                        data-shifted={send.shifted || undefined}
                        data-conflict={send.conflict ? 'true' : undefined}
                        /* Part of the same single tab stop as the day it sits
                           on. 42 squares × 3 sends is 126 new tab stops, which
                           is the problem the roving tabindex was introduced to
                           remove — reintroducing it here would have undone that
                           on the one screen it was written for. */
                        tabIndex={cell.iso === rovingDate ? 0 : -1}
                        title={full}
                        aria-label={full}
                        draggable={Boolean(onMoveJob)}
                        onDragStart={(event) => {
                          // The specific send, not "the one reminder this
                          // square happens to have". The badge can only be
                          // dragged when a day holds exactly one reminder;
                          // a row always knows which one it is.
                          event.dataTransfer.setData(DRAG_TYPE, dragPayload(send.jobId, cell.iso))
                          event.dataTransfer.effectAllowed = 'move'
                          beginDrag(send.jobId, cell.iso, send.at)
                        }}
                        onDragEnd={endDrag}
                        onClick={(event) => {
                          event.stopPropagation()
                          onFocusDate?.(cell.iso)
                          onOpenSend?.(send.jobId, cell.iso)
                        }}
                      >
                        <span className="monthgrid__sendtime">
                          {/* Decorative — the status word is already folded
                              into this row's own `full` label above. */}
                          {send.status ? (
                            <span className="sendstatus" data-status={send.status} aria-hidden="true" />
                          ) : null}
                          {time}
                        </span>
                        <span className="monthgrid__sendtext">
                          {who}
                          <span className="monthgrid__sendsubject"> · {subject}</span>
                        </span>
                      </button>
                    )
                  })}
                  {hidden > 0 && moreLabel ? (
                    <button
                      type="button"
                      className="monthgrid__more"
                      tabIndex={cell.iso === rovingDate ? 0 : -1}
                      onClick={(event) => {
                        event.stopPropagation()
                        onFocusDate?.(cell.iso)
                        onOpenDay?.(cell.iso)
                      }}
                    >
                      {moreLabel(hidden)}
                    </button>
                  ) : null}
                </div>
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

/** One shared empty array, so a day with nothing on it allocates nothing. */
const EMPTY_SENDS: DaySend[] = []

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
