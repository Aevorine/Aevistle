/**
 * In-app replacements for `<input type="time">`, `type="date"` and
 * `type="datetime-local"`.
 *
 * The closed state of a native date/time input already goes through `.input`
 * and looks like every other field on the screen. Opening one does not: on
 * Android it hands off to the OS picker — a full-screen Material-You wheel on
 * 12+ — which is a different app's chrome appearing inside this one for the
 * three seconds it takes to pick a time. These three components render their
 * own popup instead, styled off the same `.select` trigger and the same
 * anchored-popover pattern the compose screen's quick-times chip row already
 * uses (`.whenbar__picks`), so opening one is not a context switch.
 *
 * All three keep the value shape their native predecessor had — `TimeField`
 * a `HH:mm` string, `DateField` a `YYYY-MM-DD` string, `DateTimeField` an
 * epoch-ms number — so a call site swaps the element without touching the
 * state that feeds it.
 */

import { useEffect, useRef, useState } from 'react'
import { IconChevronLeft, IconChevronRight } from './icons'
import { useI18n, type TranslationKey } from '../i18n'
import { pad2 } from '../core/types'

/** Monday-first, matching `RecurrenceEditor`'s weekday picker and the
 *  delivery-window day picker — one order for "which day" everywhere. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** Escape and an outside pointerdown close the panel — the same rule
 *  `ComposeView`'s quick-times popover uses, applied once here instead of
 *  three times. */
function useClosePopover(open: boolean, containerRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown') {
        const target = e.target as HTMLElement | null
        if (target && containerRef.current?.contains(target)) return
      }
      onClose()
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 42 cells (6 weeks × 7 days), Monday-first, spilling into the neighbouring
 *  months so the grid never has a ragged first or last row. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const firstWeekdayMon0 = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - firstWeekdayMon0)
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

function CalendarGrid({
  year,
  month,
  selected,
  onPick,
  onNavigate,
}: {
  year: number
  month: number
  selected: Date | null
  onPick: (d: Date) => void
  onNavigate: (year: number, month: number) => void
}) {
  const { t, locale } = useI18n()
  const cells = monthGrid(year, month)
  const today = new Date()
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1),
  )

  return (
    <div className="dtfield__cal">
      <div className="dtfield__calhead">
        <button
          type="button"
          className="icon-btn"
          aria-label={t('dtfield.prevMonth')}
          title={t('dtfield.prevMonth')}
          onClick={() => onNavigate(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1)}
        >
          <IconChevronLeft size={16} />
        </button>
        <span className="dtfield__calmonth">{monthLabel}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('dtfield.nextMonth')}
          title={t('dtfield.nextMonth')}
          onClick={() => onNavigate(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1)}
        >
          <IconChevronRight size={16} />
        </button>
      </div>
      <div className="dtfield__calgrid" role="grid" aria-label={monthLabel}>
        {WEEKDAY_ORDER.map((d) => (
          <span key={d} className="dtfield__calweekday" aria-hidden="true">
            {t(`weekday.${d}` as TranslationKey)}
          </span>
        ))}
        {cells.map((d) => {
          const inMonth = d.getMonth() === month
          const isToday = sameDay(d, today)
          const isSelected = selected ? sameDay(d, selected) : false
          return (
            <button
              key={d.toISOString()}
              type="button"
              className="dtfield__calday"
              data-dim={inMonth ? undefined : 'true'}
              data-today={isToday ? 'true' : undefined}
              aria-pressed={isSelected}
              onClick={() => onPick(d)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Two independent columns, each reporting only the one value it owns.
 *
 * An earlier version took a single `onPick(hour, minute)` and had each column
 * fill in the other half from its own `hour`/`minute` prop — which is exactly
 * the value most likely to be stale the moment a second tap (day, then hour,
 * then minute) lands before the parent has re-rendered with the first tap's
 * result. Reporting only the changed field pushes the "combine with whatever
 * is actually current" logic to the one place — the caller's `latest` ref —
 * that can answer it correctly no matter how the taps are timed.
 */
function TimeColumns({
  hour,
  minute,
  onHourChange,
  onMinuteChange,
}: {
  hour: number
  minute: number
  onHourChange: (hour: number) => void
  onMinuteChange: (minute: number) => void
}) {
  const { t } = useI18n()
  const hourRef = useRef<HTMLButtonElement>(null)
  const minuteRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    hourRef.current?.scrollIntoView({ block: 'center' })
    minuteRef.current?.scrollIntoView({ block: 'center' })
    // Only on mount — re-centering on every tap would fight the user's own
    // scroll position while they browse the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="dtfield__time">
      <div className="dtfield__col" role="listbox" aria-label={t('dtfield.hour')}>
        {Array.from({ length: 24 }, (_, h) => (
          <button
            key={h}
            ref={h === hour ? hourRef : undefined}
            type="button"
            className="dtfield__opt"
            aria-selected={h === hour}
            onClick={() => onHourChange(h)}
          >
            {pad2(h)}
          </button>
        ))}
      </div>
      <div className="dtfield__col" role="listbox" aria-label={t('dtfield.minute')}>
        {Array.from({ length: 60 }, (_, m) => (
          <button
            key={m}
            ref={m === minute ? minuteRef : undefined}
            type="button"
            className="dtfield__opt"
            aria-selected={m === minute}
            onClick={() => onMinuteChange(m)}
          >
            {pad2(m)}
          </button>
        ))}
      </div>
    </div>
  )
}

export interface FieldTriggerProps {
  id?: string
  className?: string
  ariaLabel?: string
  disabled?: boolean
}

/** `HH:mm`, replacing `<input type="time">`. */
export function TimeField({
  id,
  className = '',
  value,
  onChange,
  ariaLabel,
  disabled,
}: FieldTriggerProps & { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClosePopover(open, ref, () => setOpen(false))

  const [hh, mm] = /^(\d{1,2}):(\d{1,2})$/.test(value) ? value.split(':').map(Number) : [0, 0]

  /** See the comment on `DateTimeField`'s `latest` — same reason, so the hour
   *  and minute columns compose instead of racing when tapped back to back. */
  const latest = useRef({ h: hh, m: mm })
  latest.current = { h: hh, m: mm }

  return (
    <div className="dtfield" ref={ref}>
      <button
        type="button"
        id={id}
        className={`select dtfield__trigger ${className}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {value || '--:--'}
      </button>
      {open ? (
        <div className="dtfield__panel dtfield__panel--time" role="dialog" aria-label={ariaLabel ?? t('dtfield.pickTime')}>
          <TimeColumns
            hour={hh}
            minute={mm}
            onHourChange={(h) => {
              latest.current = { ...latest.current, h }
              onChange(`${pad2(latest.current.h)}:${pad2(latest.current.m)}`)
            }}
            onMinuteChange={(m) => {
              latest.current = { ...latest.current, m }
              onChange(`${pad2(latest.current.h)}:${pad2(latest.current.m)}`)
            }}
          />
          <div className="dtfield__footer">
            <button type="button" className="btn btn--ghost dtfield__done" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** `YYYY-MM-DD`, replacing `<input type="date">`. */
export function DateField({
  id,
  className = '',
  value,
  onChange,
  ariaLabel,
  disabled,
}: FieldTriggerProps & { value: string; onChange: (v: string) => void }) {
  const { t, formatDateTime } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClosePopover(open, ref, () => setOpen(false))

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : null
  const view = parsed ?? new Date()
  const [cursor, setCursor] = useState({ year: view.getFullYear(), month: view.getMonth() })

  return (
    <div className="dtfield" ref={ref}>
      <button
        type="button"
        id={id}
        className={`select dtfield__trigger ${className}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open && parsed) setCursor({ year: parsed.getFullYear(), month: parsed.getMonth() })
          setOpen((v) => !v)
        }}
      >
        {parsed ? formatDateTime(parsed.getTime(), { dateStyle: 'medium', timeStyle: undefined }) : t('dtfield.pickDate')}
      </button>
      {open ? (
        <div className="dtfield__panel dtfield__panel--date" role="dialog" aria-label={ariaLabel ?? t('dtfield.pickDate')}>
          <CalendarGrid
            year={cursor.year}
            month={cursor.month}
            selected={parsed}
            onNavigate={(year, month) => setCursor({ year, month })}
            onPick={(d) => {
              onChange(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
              setOpen(false)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Epoch ms, replacing `<input type="datetime-local">`. */
export function DateTimeField({
  id,
  className = '',
  value,
  onChange,
  ariaLabel,
  disabled,
}: FieldTriggerProps & { value: number; onChange: (ms: number) => void }) {
  const { t, formatDateTime } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClosePopover(open, ref, () => setOpen(false))

  const current = new Date(value)
  const [cursor, setCursor] = useState({ year: current.getFullYear(), month: current.getMonth() })

  /*
   * `value` is a prop, current only as of the render that closed over it. The
   * calendar and time columns below both call back into this component on
   * plain, separate click events (pick a day, then pick an hour), and if the
   * second click lands before the parent has re-rendered with the first
   * click's result — a live risk on a touch screen, where two taps can land
   * closer together than a render cycle — reading `value` again would build
   * the second edit on the pre-first-click timestamp and silently discard it.
   * The ref is updated the instant a change goes out, not just on render, so
   * back-to-back picks compose instead of racing.
   */
  const latest = useRef(value)
  latest.current = value

  const setDatePart = (d: Date) => {
    const next = new Date(latest.current)
    next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate())
    latest.current = next.getTime()
    onChange(next.getTime())
  }
  const setHourPart = (h: number) => {
    const next = new Date(latest.current)
    next.setHours(h)
    latest.current = next.getTime()
    onChange(next.getTime())
  }
  const setMinutePart = (m: number) => {
    const next = new Date(latest.current)
    next.setMinutes(m)
    latest.current = next.getTime()
    onChange(next.getTime())
  }

  return (
    <div className="dtfield" ref={ref}>
      <button
        type="button"
        id={id}
        className={`select dtfield__trigger ${className}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open) setCursor({ year: current.getFullYear(), month: current.getMonth() })
          setOpen((v) => !v)
        }}
      >
        {formatDateTime(value)}
      </button>
      {open ? (
        <div
          className="dtfield__panel dtfield__panel--datetime"
          role="dialog"
          aria-label={ariaLabel ?? t('dtfield.pickDateTime')}
        >
          <CalendarGrid
            year={cursor.year}
            month={cursor.month}
            selected={current}
            onNavigate={(year, month) => setCursor({ year, month })}
            onPick={setDatePart}
          />
          <div className="dtfield__divider" aria-hidden="true" />
          <TimeColumns
            hour={current.getHours()}
            minute={current.getMinutes()}
            onHourChange={setHourPart}
            onMinuteChange={setMinutePart}
          />
          <div className="dtfield__footer">
            <button type="button" className="btn btn--ghost dtfield__done" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
