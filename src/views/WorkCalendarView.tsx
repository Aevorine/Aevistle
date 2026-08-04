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
 *   - a grid at three zooms — month, week, day — so "is the 2nd a working day"
 *     has a visible answer and "what exactly happens on the 2nd" has one too;
 *   - country presets that fill in *years*, not one year at a time, and a way
 *     to take a year back out;
 *   - the Chinese statutory tables, which are the case no rule can compute;
 *   - an impact preview that marks which reminders land on which days and
 *     which ones the calendar *moved* — the only thing that actually answers
 *     "did configuring this do anything";
 *   - the conflicts that preview implies: sends stacked on one minute, a
 *     reminder every one of whose sends is skipped, a calendar so full there is
 *     nowhere left to move to;
 *   - `.ics` in and out, because a working calendar nobody else can read is a
 *     working calendar you maintain twice.
 *
 * Every edit here is undoable with the app's own Ctrl+Z, and "Clear" asks
 * first. Both were missing, and this is the one screen where a stray click
 * used to destroy a list somebody had typed out of a government notice.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MonthGrid,
  datesBetween,
  orderedRange,
  weekOf,
  weekStartDay,
  type DateRange,
  type DayMark,
  type GridScope,
} from '../components/MonthGrid'
import { CalendarDayPanel, JobSheet, conflictLine, type DayEntry } from '../components/CalendarDayPanel'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  PageHead,
  Segmented,
  StatusChip,
  useConfirm,
  useToast,
} from '../components/ui'
import {
  IconAlert,
  IconCalendar,
  IconCheckCircle,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconX,
} from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import { computeOccurrences } from '../core/schedule'
import {
  applyPresetRange,
  clearYear,
  countInYear,
  holidayNameFor,
  HOLIDAY_PRESETS,
  PRESET_MAX_YEARS,
  yearRange,
  yearsInCalendar,
} from '../core/holidayPresets'
import {
  applyStatutoryYear,
  CN_FEED_HOST,
  cnFeedUrl,
  fetchStatutoryYear,
  knownYears,
  loadCachedYears,
  saveCachedYear,
  statutoryFor,
  statutoryNames,
  statutoryToCalendarDates,
  type StatutoryYear,
} from '../core/cnHolidays'
import { findConflicts, type Conflict } from '../core/conflicts'
import { buildIcs, calendarToEvents, eventsToCalendarDates, jobsToEvents, parseIcs } from '../core/ics'
import { planReschedule } from '../core/reschedule'
import {
  applyWorkCalendarDetailed,
  DEFAULT_WORK_CALENDAR,
  isWorkingDay,
  isWorkingDayIso,
  parseDateList,
  parseIsoDate,
  toIsoDate,
  type IsoDate,
  type WorkCalendar,
  type WorkdayPolicy,
} from '../core/workCalendar'

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
/** How far ahead the impact preview looks, per reminder. */
const PREVIEW_OCCURRENCES = 60

/** Remembers which country's names to use for the chips. See `holidayNameFor`. */
const PRESET_MEMORY_KEY = 'aevistle.workcal.preset'

export function WorkCalendarView() {
  const { state, dispatch, pushUndo, toggleJob, scheduleDraft } = useApp()
  const { t, dir, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()
  const calendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR

  const now = new Date()
  const todayIso = toIsoDate(now.getTime())
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [scope, setScope] = useState<GridScope | 'day'>('month')
  const [focusedDate, setFocusedDate] = useState<IsoDate>(todayIso)
  const [selection, setSelection] = useState<DateRange | null>(null)
  const [paste, setPaste] = useState('')
  const [target, setTarget] = useState<'holidays' | 'workdays'>('holidays')
  const [sheetJobId, setSheetJobId] = useState<string | null>(null)
  const [presetId, setPresetId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(PRESET_MEMORY_KEY) ?? undefined
    } catch {
      return undefined
    }
  })
  const [fromYear, setFromYear] = useState(now.getFullYear())
  const [toYear, setToYear] = useState(now.getFullYear() + 2)
  const [cached, setCached] = useState<StatutoryYear[]>(() => loadCachedYears())
  const [fetching, setFetching] = useState<number | null>(null)
  const icsInput = useRef<HTMLInputElement>(null)

  /**
   * Every write to the calendar goes through here, and every one of them is
   * undoable.
   *
   * The inverse is the *whole previous calendar* rather than a targeted removal
   * because these edits are not all removals: "apply CN 2026–2028" adds 15
   * dates and replaces the weekend, and reconstructing the inverse of that from
   * the patch is how an undo ends up half-undoing. Whole-object inverses are
   * cheap here — the object is three arrays of short strings.
   */
  const save = (patch: Partial<WorkCalendar>, label: string) => {
    pushUndo(label, [{ type: 'patchSettings', patch: { workCalendar: calendar } }])
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
  const toggleDay = (iso: IsoDate) => {
    // `parseIsoDate`, never `new Date(iso)`: a bare date is UTC midnight per
    // spec, so west of UTC the weekend test below would read the previous day.
    const weekday = parseIsoDate(iso).getDay()
    const isWeekendDay = calendar.weekend.includes(weekday)
    const label = t('cal.undo.calendar')
    if (calendar.holidays.includes(iso)) {
      save({ holidays: calendar.holidays.filter((d) => d !== iso) }, label)
    } else if (calendar.workdays.includes(iso)) {
      save({ workdays: calendar.workdays.filter((d) => d !== iso) }, label)
    } else if (isWeekendDay) {
      save({ workdays: [...calendar.workdays, iso].sort() }, label)
    } else {
      save({ holidays: [...calendar.holidays, iso].sort() }, label)
    }
  }

  /** Mark a whole span at once — a shutdown is one gesture, not fourteen. */
  const applyRange = (mode: 'off' | 'working' | 'clear') => {
    if (!selection) return
    const { from, to } = orderedRange(selection)
    const dates = datesBetween(from, to)
    const label = t('cal.undo.calendar')
    if (mode === 'clear') {
      save(
        {
          holidays: calendar.holidays.filter((d) => !dates.includes(d)),
          workdays: calendar.workdays.filter((d) => !dates.includes(d)),
        },
        label,
      )
    } else if (mode === 'off') {
      save(
        {
          holidays: [...new Set([...calendar.holidays, ...dates])].sort(),
          workdays: calendar.workdays.filter((d) => !dates.includes(d)),
        },
        label,
      )
    } else {
      save(
        {
          workdays: [...new Set([...calendar.workdays, ...dates])].sort(),
          holidays: calendar.holidays.filter((d) => !dates.includes(d)),
        },
        label,
      )
    }
    setSelection(null)
    toast.push({ tone: 'success', title: t('cal.range.applied', { n: dates.length }) })
  }

  const addPasted = () => {
    const { dates, rejected } = parseDateList(paste)
    if (dates.length === 0) {
      toast.push({ tone: 'error', title: t('workcal.noneParsed') })
      return
    }
    const existing = calendar[target]
    const merged = [...new Set([...existing, ...dates])].sort()
    save({ [target]: merged } as Partial<WorkCalendar>, t('cal.undo.calendar'))
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
    const years = yearRange(fromYear, toYear)
    const before = calendar.holidays.length
    const next = applyPresetRange(calendar, preset, fromYear, toYear)
    save(next, t('cal.undo.calendar'))
    setPresetId(id)
    try {
      localStorage.setItem(PRESET_MEMORY_KEY, id)
    } catch {
      // A blocked localStorage costs the chip names, nothing else.
    }
    toast.push({
      tone: 'success',
      title: t('cal.preset.appliedRange', {
        n: next.holidays.length - before,
        years: years.length,
      }),
      // Never presented as a complete calendar. Every one of these countries
      // has dates that move, and letting the user believe otherwise is how a
      // reminder ends up going out on a public holiday.
      detail: preset.hasMovingDates ? t('workcal.presetPartial') : undefined,
    })
  }

  // --- who actually uses this calendar --------------------------------------

  const users = state.jobs.filter((j) => (j.recurrence.workdayPolicy ?? 'off') !== 'off')

  /** Exact date → name, from the Chinese tables. Rebuilt when a year is fetched. */
  const statutory = useMemo(() => statutoryNames(cached), [cached])
  const nameFor = (iso: IsoDate) => holidayNameFor(iso, { presetId, statutory })

  const conflictScan = useMemo(
    () => findConflicts(state.jobs, calendar, { now: Date.now() }),
    [state.jobs, calendar],
  )

  /**
   * Where the next couple of months of reminders land, and which of them the
   * calendar moved.
   *
   * Every *enabled* reminder is drawn, not only the ones that opted into the
   * calendar: a calendar that hides two thirds of what is scheduled is not a
   * calendar. What the policy changes is the `shifted` flag — computed by
   * comparing the shaped list against the raw one, which is the only way to
   * know a day was arrived at rather than asked for.
   */
  const { marks, entriesByDate } = useMemo(() => {
    const marks = new Map<IsoDate, DayMark>()
    const entriesByDate = new Map<IsoDate, DayEntry[]>()

    for (const job of state.jobs) {
      if (!job.enabled) continue
      const policy = job.recurrence.workdayPolicy ?? 'off'
      const raw = computeOccurrences(job.recurrence, {
        count: PREVIEW_OCCURRENCES,
        runsSoFar: job.runCount,
        calendar,
      })
      const { occurrences, adjustment } = applyWorkCalendarDetailed(raw, policy, calendar)
      const rawDates = new Set(raw.map(toIsoDate))

      for (const at of occurrences) {
        const iso = toIsoDate(at)
        const shifted = !rawDates.has(iso)
        const move = shifted ? adjustment.moved.find((m) => toIsoDate(m.to) === iso) : undefined

        const mark = marks.get(iso)
        if (mark) {
          mark.count += 1
          mark.shifted = mark.shifted || shifted
          if (!mark.jobIds!.includes(job.id)) mark.jobIds!.push(job.id)
        } else {
          marks.set(iso, { count: 1, shifted, jobIds: [job.id] })
        }

        const entry: DayEntry = {
          job,
          at,
          shifted,
          originalIso: move ? toIsoDate(move.from) : undefined,
        }
        const list = entriesByDate.get(iso)
        if (list) list.push(entry)
        else entriesByDate.set(iso, [entry])
      }
    }

    // Conflicts colour the square they happen on, so the grid answers "where is
    // the problem" without reading the list below it.
    for (const [iso, list] of conflictScan.byDate) {
      const severity = list.some((c) => c.severity === 'error') ? 'error' : 'warning'
      const mark = marks.get(iso)
      if (mark) mark.conflict = severity
      else marks.set(iso, { count: 0, shifted: false, jobIds: [], conflict: severity })
    }

    return { marks, entriesByDate }
  }, [state.jobs, calendar, conflictScan])

  // --- moving a reminder ----------------------------------------------------

  /**
   * Drag, or the keyboard equivalent in the day panel.
   *
   * Always confirmed, and the confirmation says *which of the two things* it is
   * about to do — move one send, or rewrite the rule. Those are different
   * enough that guessing on the user's behalf is not acceptable, and only one
   * of them is even possible for a repeating reminder. See `core/reschedule.ts`.
   */
  const moveJob = async (jobId: string, fromIso: IsoDate, toIso: IsoDate) => {
    const job = state.jobs.find((j) => j.id === jobId)
    if (!job) return
    const plan = planReschedule(job, fromIso, toIso)

    if (plan.outcome === 'refused' || !plan.recurrence) {
      toast.push({
        tone: 'error',
        title: t('cal.move.cannot'),
        detail: t(plan.reasonKey as TranslationKey, translateValues(plan.reasonValues, t)),
      })
      return
    }

    const ok = await confirm({
      title: t('cal.move.title'),
      body: [
        t(plan.reasonKey as TranslationKey, translateValues(plan.reasonValues, t)),
        plan.outcome === 'series' ? t('cal.move.seriesNote') : '',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: t('cal.move.confirm'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    pushUndo(job.name, [{ type: 'upsertJob', job }])
    await scheduleDraft({ ...job, recurrence: plan.recurrence })
    toast.push({
      tone: 'success',
      title: t('cal.move.done', { name: job.name }),
      detail: t(plan.outcome === 'series' ? 'cal.move.doneSeries' : 'cal.move.doneOne', {
        to: toIso,
      }),
    })
  }

  const sheetJob = sheetJobId ? state.jobs.find((j) => j.id === sheetJobId) : undefined

  // --- .ics -----------------------------------------------------------------

  const downloadIcs = (text: string, name: string) => {
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    // Revoking immediately can cancel the download in some builds.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.push({ tone: 'success', title: t('cal.ics.exported', { name }) })
  }

  const exportCalendarIcs = () => {
    const events = calendarToEvents(calendar, {
      nameFor,
      holidayLabel: t('workcal.dayOff'),
      workdayLabel: t('workcal.makeupDays'),
    })
    if (events.length === 0) {
      toast.push({ tone: 'info', title: t('workcal.none') })
      return
    }
    downloadIcs(
      buildIcs(events, { name: t('workcal.title') }),
      `aevistle-working-calendar-${todayIso}.ics`,
    )
  }

  const exportScheduleIcs = () => {
    if (state.jobs.length === 0) {
      toast.push({ tone: 'info', title: t('schedule.empty') })
      return
    }
    const { events, expanded } = jobsToEvents(state.jobs)
    downloadIcs(buildIcs(events, { name: t('schedule.title') }), `aevistle-reminders-${todayIso}.ics`)
    if (expanded.length > 0) {
      toast.push({
        tone: 'info',
        title: t('cal.ics.expanded', { list: expanded.slice(0, 3).join(', ') }),
      })
    }
  }

  const importIcs = async (file: File) => {
    const result = parseIcs(await file.text())
    const { holidays, workdays, skippedTimed } = eventsToCalendarDates(result.events)
    const newHolidays = holidays.filter((d) => !calendar.holidays.includes(d))
    const newWorkdays = workdays.filter((d) => !calendar.workdays.includes(d))

    if (newHolidays.length === 0 && newWorkdays.length === 0) {
      toast.push({
        tone: 'info',
        title: t('cal.ics.importedNone'),
        detail:
          skippedTimed > 0
            ? t('cal.ics.timedSkipped', { n: skippedTimed })
            : result.warnings[0],
      })
      return
    }

    const ok = await confirm({
      title: t('cal.ics.import'),
      body: t('cal.ics.confirm', { h: newHolidays.length, w: newWorkdays.length }),
      confirmLabel: t('common.add'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    save(
      {
        holidays: [...new Set([...calendar.holidays, ...newHolidays])].sort(),
        workdays: [...new Set([...calendar.workdays, ...newWorkdays])].sort(),
      },
      t('cal.undo.calendar'),
    )
    toast.push({
      tone: 'success',
      title: t('cal.ics.imported', { h: newHolidays.length, w: newWorkdays.length }),
      detail: [
        skippedTimed > 0 ? t('cal.ics.timedSkipped', { n: skippedTimed }) : '',
        result.warnings.length > 0 ? t('cal.ics.importWarnings', { n: result.warnings.length }) : '',
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    })
  }

  // --- China -----------------------------------------------------------------

  const applyStatutory = (year: number) => {
    const table = statutoryFor(year, cached)
    if (!table) return
    const { holidays, workdays } = statutoryToCalendarDates(table)
    save(applyStatutoryYear(calendar, table), t('cal.undo.calendar'))
    setPresetId('CN')
    toast.push({
      tone: 'success',
      title: t('cal.cn.applied', { h: holidays.length, w: workdays.length, year }),
      detail: table.paper,
    })
  }

  const refreshStatutory = async (year: number) => {
    setFetching(year)
    const outcome = await fetchStatutoryYear(year)
    setFetching(null)
    if (outcome.error || !outcome.year) {
      toast.push({
        tone: 'error',
        title: t('cal.cn.fetchFailed', { year, error: outcome.error ?? '' }),
        detail: t('cal.cn.offline'),
      })
      return
    }
    saveCachedYear(outcome.year)
    setCached(loadCachedYears())
    toast.push({
      tone: 'success',
      title: t('cal.cn.fetched', { n: outcome.year.days.length, year }),
    })
  }

  // --- navigation ------------------------------------------------------------

  /**
   * Arrow keys walk off the edge of the month, so the cursor follows the focus
   * rather than trapping it. Without this, ArrowDown on the 28th does nothing
   * and the grid reads as broken.
   */
  useEffect(() => {
    const focus = parseIsoDate(focusedDate)
    if (Number.isNaN(focus.getTime())) return
    if (focus.getFullYear() !== cursor.year || focus.getMonth() !== cursor.month) {
      setCursor({ year: focus.getFullYear(), month: focus.getMonth() })
    }
  }, [focusedDate, cursor.year, cursor.month])

  const periodLabel =
    scope === 'month'
      ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(
          new Date(cursor.year, cursor.month, 1),
        )
      : scope === 'week'
        ? weekLabel(focusedDate, weekStartDay(calendar.weekend), formatDateTime)
        : formatDateTime(parseIsoDate(focusedDate).getTime(), {
            dateStyle: 'full',
            timeStyle: undefined,
          })

  const shiftPeriod = (by: number) => {
    if (scope === 'month') {
      const d = new Date(cursor.year, cursor.month + by, 1)
      setCursor({ year: d.getFullYear(), month: d.getMonth() })
      setFocusedDate(toIsoDate(d.getTime()))
      return
    }
    const step = scope === 'week' ? 7 : 1
    const d = parseIsoDate(focusedDate)
    d.setDate(d.getDate() + by * step)
    setFocusedDate(toIsoDate(d.getTime()))
  }

  const todayWorking = isWorkingDay(Date.now(), calendar)
  const selectedDates = selection
    ? datesBetween(orderedRange(selection).from, orderedRange(selection).to)
    : []
  const years = yearsInCalendar(calendar)
  const dayConflicts = conflictScan.byDate.get(focusedDate) ?? []

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
              title={todayIso}
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
              title={periodLabel}
              hint={t('workcal.gridHint')}
              action={
                <div className="btn-row">
                  <Segmented
                    value={scope}
                    onChange={(v) => setScope(v)}
                    ariaLabel={t('cal.scope.label')}
                    options={[
                      { value: 'month', label: t('cal.scope.month') },
                      { value: 'week', label: t('cal.scope.week') },
                      { value: 'day', label: t('cal.scope.day') },
                    ]}
                  />
                  <IconButton label={t('cal.prevPeriod')} onClick={() => shiftPeriod(-1)}>
                    <IconChevronLeft size={16} />
                  </IconButton>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setCursor({ year: now.getFullYear(), month: now.getMonth() })
                      setFocusedDate(todayIso)
                    }}
                  >
                    {t('workcal.today')}
                  </Button>
                  <IconButton label={t('cal.nextPeriod')} onClick={() => shiftPeriod(1)}>
                    <IconChevronRight size={16} />
                  </IconButton>
                </div>
              }
            />
            <div className="card__body">
              {scope === 'day' ? null : (
                <MonthGrid
                  year={cursor.year}
                  month={cursor.month}
                  scope={scope}
                  anchorDate={focusedDate}
                  calendar={calendar}
                  marks={marks}
                  onToggle={toggleDay}
                  focusedDate={focusedDate}
                  onFocusDate={setFocusedDate}
                  selection={selection}
                  onSelect={setSelection}
                  onOpenDay={(iso) => {
                    setFocusedDate(iso)
                    setScope('day')
                  }}
                  onMoveJob={(jobId, from, to) => void moveJob(jobId, from, to)}
                  rtl={dir === 'rtl'}
                  label={t('cal.gridLabel')}
                  badgeLabel={(iso, mark) => t('cal.badge', { n: mark.count, date: iso })}
                  weekdayLabel={(day) =>
                    new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(
                      // 2024-01-07 was a Sunday, so this indexes weekdays without
                      // depending on what today happens to be.
                      new Date(2024, 0, 7 + day),
                    )
                  }
                  dayTitle={(iso, working, mark) => {
                    const parts = [
                      formatDateTime(parseIsoDate(iso).getTime(), {
                        dateStyle: 'full',
                        timeStyle: undefined,
                      }),
                      working ? t('workcal.dayWorking') : t('workcal.dayOff'),
                    ]
                    const name = nameFor(iso)
                    if (name && calendar.holidays.includes(iso)) parts.push(name)
                    if (mark?.count) {
                      parts.push(t('workcal.dayReminders', { n: mark.count }))
                      if (mark.shifted) parts.push(t('workcal.dayShifted'))
                    }
                    return parts.join(' · ')
                  }}
                />
              )}

              {scope === 'day' ? (
                <CalendarDayPanel
                  iso={focusedDate}
                  entries={entriesByDate.get(focusedDate) ?? []}
                  working={isWorkingDayIso(focusedDate, calendar)}
                  holidayName={calendar.holidays.includes(focusedDate) ? nameFor(focusedDate) : undefined}
                  conflicts={dayConflicts}
                  onToggleDay={toggleDay}
                  onMove={(jobId, from, to) => void moveJob(jobId, from, to)}
                  onOpenJob={setSheetJobId}
                />
              ) : null}

              {selection && selectedDates.length > 0 ? (
                <div className="rangebar" role="group" aria-label={t('cal.range.label')}>
                  <span className="rangebar__count">
                    {t('cal.range.selected', { n: selectedDates.length })}
                  </span>
                  <Button variant="secondary" onClick={() => applyRange('off')}>
                    {t('cal.range.markOff')}
                  </Button>
                  <Button variant="secondary" onClick={() => applyRange('working')}>
                    {t('cal.range.markWorking')}
                  </Button>
                  <Button variant="ghost" onClick={() => applyRange('clear')}>
                    {t('cal.range.reset')}
                  </Button>
                  <Button variant="ghost" onClick={() => setSelection(null)}>
                    {t('cal.range.cancel')}
                  </Button>
                </div>
              ) : (
                <div className="field__hint">{t('cal.range.hint')}</div>
              )}

              {scope !== 'day' ? (
                <div className="monthgrid__legend">
                  <span><i className="swatch swatch--off" /> {t('workcal.dayOff')}</span>
                  <span><i className="swatch swatch--makeup" /> {t('workcal.makeupDays')}</span>
                  <span><i className="swatch swatch--mark" /> {t('workcal.legendReminders')}</span>
                  <span><i className="swatch swatch--shifted" /> {t('workcal.legendShifted')}</span>
                  <span><i className="swatch swatch--conflict" /> {t('cal.legendConflict')}</span>
                </div>
              ) : null}
            </div>
          </Card>

          {/* --- conflicts --------------------------------------------------- */}

          <Card>
            <CardHeader
              title={t('cal.conflict.title')}
              hint={t('cal.conflict.hint', { days: conflictScan.days })}
              action={
                conflictScan.conflicts.length > 0 ? (
                  <StatusChip
                    tone={conflictScan.conflicts.some((c) => c.severity === 'error') ? 'danger' : 'warning'}
                    label={t('cal.conflict.count', { n: conflictScan.conflicts.length })}
                  />
                ) : undefined
              }
            />
            <div className="card__body">
              {conflictScan.conflicts.length === 0 ? (
                <div className="conflict conflict--clear">
                  <IconCheckCircle size={16} />
                  <span>{t('cal.conflict.none', { days: conflictScan.days })}</span>
                </div>
              ) : (
                <ul className="conflictlist">
                  {conflictScan.conflicts.slice(0, 12).map((conflict, i) => (
                    <li key={i} className="conflict" data-severity={conflict.severity}>
                      <IconAlert size={15} />
                      <button
                        type="button"
                        className="link conflict__text"
                        onClick={() => {
                          if (conflict.date) {
                            setFocusedDate(conflict.date)
                            setScope('day')
                          }
                        }}
                      >
                        {conflictLine(conflict, t, formatDateTime, namesOf(conflict, state.jobs))}
                      </button>
                      <span className="conflict__when">
                        {conflict.at !== undefined ? formatDateTime(conflict.at) : conflict.date}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {/* --- presets ----------------------------------------------------- */}

          <Card>
            <CardHeader title={t('workcal.presets')} hint={t('cal.preset.rangeHint', { max: PRESET_MAX_YEARS })} />
            <div className="card__body form-rows">
              <div className="field__row">
                <Field label={t('cal.preset.from')}>
                  <input
                    className="input"
                    type="number"
                    min={1970}
                    max={2100}
                    value={fromYear}
                    onChange={(e) => setFromYear(Number(e.target.value) || now.getFullYear())}
                  />
                </Field>
                <Field label={t('cal.preset.to')}>
                  <input
                    className="input"
                    type="number"
                    min={1970}
                    max={2100}
                    value={toYear}
                    onChange={(e) => setToYear(Number(e.target.value) || now.getFullYear())}
                  />
                </Field>
              </div>
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

          {/* --- China's statutory tables ------------------------------------ */}

          <Card>
            <CardHeader title={t('cal.cn.title')} hint={t('cal.cn.hint')} />
            <div className="card__body form-rows">
              <ul className="yearlist">
                {[...new Set([...knownYears(cached), now.getFullYear(), now.getFullYear() + 1])]
                  .sort((a, b) => a - b)
                  .filter((y) => y >= now.getFullYear() - 1)
                  .map((year) => {
                    const table = statutoryFor(year, cached)
                    return (
                      <li key={year} className="yearlist__row">
                        <span className="yearlist__year">{year}</span>
                        {table ? (
                          <>
                            <StatusChip
                              tone={table.source === 'network' ? 'info' : 'neutral'}
                              label={t(
                                table.source === 'network' ? 'cal.cn.network' : 'cal.cn.bundled',
                                { when: formatDateTime(table.obtainedAt, { dateStyle: 'medium', timeStyle: undefined }) },
                              )}
                            />
                            <span className="yearlist__meta">
                              {t('cal.cn.counts', {
                                h: table.days.filter((d) => d.off).length,
                                w: table.days.filter((d) => !d.off).length,
                              })}
                            </span>
                            <Button variant="secondary" onClick={() => applyStatutory(year)}>
                              {t('cal.cn.apply', { year })}
                            </Button>
                          </>
                        ) : (
                          <span className="yearlist__missing">{t('cal.cn.missing', { year })}</span>
                        )}
                        <Button
                          variant="ghost"
                          icon={<IconRefresh size={15} />}
                          loading={fetching === year}
                          onClick={() => void refreshStatutory(year)}
                        >
                          {t('cal.cn.refresh')}
                        </Button>
                      </li>
                    )
                  })}
              </ul>
              {/*
                Said before the button is pressed, not after. This is the only
                outbound request this screen can make, it happens exactly when
                somebody asks for it, and the host it contacts is named here.
              */}
              <div className="field__hint">
                {t('cal.cn.willContact', { host: CN_FEED_HOST })}
                <br />
                <code className="yearlist__url">{cnFeedUrl(now.getFullYear() + 1)}</code>
              </div>
            </div>
          </Card>

          {/* --- .ics -------------------------------------------------------- */}

          <Card>
            <CardHeader title={t('cal.ics.title')} hint={t('cal.ics.hint')} />
            <div className="card__body">
              <div className="btn-row">
                <Button variant="secondary" icon={<IconDownload size={15} />} onClick={exportCalendarIcs}>
                  {t('cal.ics.exportCalendar')}
                </Button>
                <Button variant="secondary" icon={<IconDownload size={15} />} onClick={exportScheduleIcs}>
                  {t('cal.ics.exportSchedule')}
                </Button>
                <Button variant="secondary" onClick={() => icsInput.current?.click()}>
                  {t('cal.ics.import')}
                </Button>
                <input
                  ref={icsInput}
                  type="file"
                  accept=".ics,text/calendar"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void importIcs(file)
                    event.target.value = ''
                  }}
                />
              </div>
              <div className="field__hint">{t('cal.ics.importHint')}</div>
            </div>
          </Card>

          {/* --- weekend ----------------------------------------------------- */}

          <Card>
            <CardHeader title={t('workcal.weekend')} hint={t('workcal.weekendHint')} />
            <div className="card__body">
              <div className="daypicker daypicker--wide">
                {WEEKDAY_ORDER.map((day) => {
                  const on = calendar.weekend.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      className="daypicker__day"
                      aria-pressed={on}
                      onClick={() =>
                        save(
                          {
                            weekend: on
                              ? calendar.weekend.filter((d) => d !== day)
                              : [...calendar.weekend, day].sort(),
                          },
                          t('cal.undo.calendar'),
                        )
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

          {/* --- paste ------------------------------------------------------- */}

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

          {/* --- what is in there, by year ------------------------------------ */}

          {years.length > 0 ? (
            <Card>
              <CardHeader title={t('cal.year.title')} hint={t('cal.year.hint')} />
              <div className="card__body">
                <ul className="yearlist">
                  {years.map((year) => {
                    const counts = countInYear(calendar, year)
                    return (
                      <li key={year} className="yearlist__row">
                        <span className="yearlist__year">{year}</span>
                        <span className="yearlist__meta">
                          {t('cal.year.counts', { h: counts.holidays, w: counts.workdays })}
                        </span>
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            const ok = await confirm({
                              title: t('cal.year.clear', { year }),
                              body: t('cal.year.clearBody', {
                                n: counts.holidays + counts.workdays,
                                year,
                              }),
                              confirmLabel: t('common.delete'),
                              cancelLabel: t('common.cancel'),
                              danger: true,
                            })
                            if (!ok) return
                            save(clearYear(calendar, year), t('cal.undo.calendar'))
                            toast.push({
                              tone: 'info',
                              title: t('cal.year.cleared', {
                                n: counts.holidays + counts.workdays,
                                year,
                              }),
                            })
                          }}
                        >
                          {t('cal.year.clear', { year })}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </Card>
          ) : null}

          {/* --- the two lists ------------------------------------------------ */}

          {(['holidays', 'workdays'] as const).map((list) => (
            <Card key={list}>
              <CardHeader
                title={list === 'holidays' ? t('workcal.holidays') : t('workcal.makeupDays')}
                action={
                  calendar[list].length > 0 ? (
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        const ok = await confirm({
                          title: t('cal.confirm.clearTitle', {
                            list: list === 'holidays' ? t('workcal.holidays') : t('workcal.makeupDays'),
                          }),
                          body: t('cal.confirm.clearBody', { n: calendar[list].length }),
                          confirmLabel: t('workcal.clearList'),
                          cancelLabel: t('common.cancel'),
                          danger: true,
                        })
                        if (!ok) return
                        save({ [list]: [] } as Partial<WorkCalendar>, t('cal.undo.calendar'))
                        toast.push({ tone: 'info', title: t('cal.undo.hint') })
                      }}
                    >
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
                    {calendar[list].map((iso) => {
                      const name = list === 'holidays' ? nameFor(iso) : undefined
                      return (
                        <span key={iso} className={`chip ${list === 'workdays' ? 'chip--warning' : ''}`}>
                          <span
                            className="chip__text"
                            title={formatDateTime(parseIsoDate(iso).getTime(), {
                              dateStyle: 'full',
                              timeStyle: undefined,
                            })}
                          >
                            {iso}
                            {name ? <span className="chip__note">{name}</span> : null}
                          </span>
                          <button
                            type="button"
                            className="chip__remove"
                            aria-label={t('common.delete')}
                            onClick={() =>
                              save(
                                { [list]: calendar[list].filter((d) => d !== iso) } as Partial<WorkCalendar>,
                                t('cal.undo.calendar'),
                              )
                            }
                          >
                            <IconX size={12} />
                          </button>
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {sheetJob ? (
        <JobSheet
          job={sheetJob}
          warning={sheetJob.calendarWarning}
          conflicts={conflictScan.conflicts.filter((c) => c.jobIds.includes(sheetJob.id))}
          onClose={() => setSheetJobId(null)}
          onTogglePaused={() => void toggleJob(sheetJob.id, !sheetJob.enabled)}
          onPolicyChange={(policy: WorkdayPolicy) => {
            pushUndo(sheetJob.name, [{ type: 'upsertJob', job: sheetJob }])
            void scheduleDraft({
              ...sheetJob,
              recurrence: { ...sheetJob.recurrence, workdayPolicy: policy },
            })
          }}
        />
      ) : null}

      {confirmElement}
    </div>
  )
}

/** Reason values that are themselves translation keys, resolved. */
function translateValues(
  values: Record<string, string | number> | undefined,
  t: (key: TranslationKey) => string,
): Record<string, string | number> | undefined {
  if (!values) return undefined
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(values)) {
    out[key] = typeof value === 'string' && value.startsWith('weekday.') ? t(value as TranslationKey) : value
  }
  return out
}

/** The job names a conflict is about, for the sentence. */
function namesOf(conflict: Conflict, jobs: Array<{ id: string; name: string }>): string {
  const names = conflict.jobIds
    .map((id) => jobs.find((j) => j.id === id)?.name)
    .filter((n): n is string => Boolean(n))
  return names.length > 2 ? `${names.slice(0, 2).join(', ')}…` : names.join(', ')
}

/** "6–12 Oct" for the week header. */
function weekLabel(
  iso: IsoDate,
  firstDay: number,
  formatDateTime: (ms: number, opts?: Intl.DateTimeFormatOptions) => string,
): string {
  const week = weekOf(iso, firstDay)
  if (week.length === 0) return iso
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: undefined }
  return `${formatDateTime(parseIsoDate(week[0]).getTime(), opts)} – ${formatDateTime(
    parseIsoDate(week[6]).getTime(),
    opts,
  )}`
}
