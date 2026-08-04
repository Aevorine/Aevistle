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
import type { DaySend } from '../components/MonthGrid'
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
  Switch,
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
import { feedFetchVia } from '../core/feeds'
import { findConflicts, type Conflict } from '../core/conflicts'
import { buildIcs, calendarToEvents, eventsToCalendarDates, jobsToEvents, parseIcs } from '../core/ics'
import { planReschedule, planRestagger } from '../core/reschedule'
import { seedComposeDate } from '../core/composeSeed'
import { LOAD_STEPS, loadLevel } from '../core/calendarLoad'
import { saveGeneratedFile } from '../core/download'
import type { Recurrence, ScheduledJob } from '../core/types'
import {
  addIsoDays,
  applyWorkCalendarDetailed,
  DEFAULT_WORK_CALENDAR,
  isWorkingDay,
  isWorkingDayIso,
  parseDateList,
  parseIsoDate,
  spreadSameMinute,
  STAGGER_WINDOW_MS,
  toIsoDate,
  type IsoDate,
  type WorkCalendar,
  type WorkdayPolicy,
} from '../core/workCalendar'

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
/** How far ahead the impact preview looks, per reminder. */
const PREVIEW_OCCURRENCES = 60
/**
 * Slack past the end of the visible range, in days.
 *
 * `MAX_SHIFT_DAYS` in `core/workCalendar.ts` is 31, so a `'before'` policy can
 * pull an occurrence back by at most a month. Anything further out than that
 * cannot land on a square the grid is drawing, which makes 31 the exact bound
 * rather than a guess — the preview is unchanged, only the work is smaller.
 */
const PREVIEW_PAD_DAYS = 31
const DAY_MS = 86_400_000

/** How wide a de-stagger may spread a pile-up, as the sentences say it. */
const STAGGER_WINDOW_MIN = Math.round(STAGGER_WINDOW_MS / 60_000)

/** Remembers which country's names to use for the chips. See `holidayNameFor`. */
const PRESET_MEMORY_KEY = 'aevistle.workcal.preset'

export function WorkCalendarView({ onCompose }: { onCompose?: () => void } = {}) {
  const { state, dispatch, pushUndo, undo, toggleJob, scheduleDraft, bridge } = useApp()
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
   * The last day toggled, and when.
   *
   * A double-click arrives as click → click → dblclick. `MonthGrid` drops the
   * second click, so exactly one toggle is committed before the create fires,
   * and this is how the create knows there is one to take back. Matched on the
   * date *and* on recency, so an unrelated toggle from a minute ago is never
   * mistaken for the one this gesture caused.
   */
  const lastToggle = useRef<{ iso: IsoDate; at: number } | null>(null)

  /**
   * The locale's short time, built once.
   *
   * `formatDateTime` from `useI18n` constructs a fresh `Intl.DateTimeFormat` on
   * every call, and this one is called up to three times per day square — 126
   * constructions per render of a month, for a string that only needs one
   * formatter. Same locale resolution as the weekday and month labels above.
   */
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' } as Intl.DateTimeFormatOptions),
    [],
  )
  const formatTime = useMemo(() => (at: number) => timeFormat.format(new Date(at)), [timeFormat])

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
    // Remembered so a double-click can take it back. See `createOnDay`.
    lastToggle.current = { iso, at: Date.now() }
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
   * The last instant the grid can possibly draw — twice, because one policy
   * needs slack and three do not.
   *
   * This exists because the preview below used to ask for
   * `PREVIEW_OCCURRENCES` occurrences with **no upper bound on time** — the
   * same mistake `core/conflicts.ts` documents and fixed for the conflict scan,
   * left in place here. `nextFireAfter` walks forward a day at a time up to
   * `MAX_SEARCH_DAYS` (five years), allocating a `Date` per probe, so sixty
   * occurrences of a *yearly* rule meant sixty years of day-by-day scanning —
   * about 22 000 probes and 65 000 `Date` allocations, for one reminder, to
   * draw a grid that shows six weeks.
   *
   * `grid` is where the drawn squares stop. `withSlack` adds `MAX_SHIFT_DAYS`,
   * and is used only by `workdayPolicy: 'before'`, the one policy that moves a
   * send *backwards* and can therefore pull an occurrence from beyond the grid
   * onto a square inside it. `'after'`, `'skip'` and `'off'` never do, so
   * asking them for another month of occurrences is pure waste.
   *
   * `count` stays as the second bound: a one-minute `interval` rule would
   * otherwise produce a hundred thousand occurrences inside one month, and
   * sixty of them is what the grid drew before and after this change.
   */
  const previewUntil = useMemo(() => {
    const firstDay = weekStartDay(calendar.weekend)
    let endExclusive: Date
    if (scope === 'month') {
      // The same arithmetic `MonthGrid` uses to build its cells: a leading pad
      // to the week start, then whole weeks. The grid never draws past this.
      const lead = (new Date(cursor.year, cursor.month, 1).getDay() - firstDay + 7) % 7
      const days = new Date(cursor.year, cursor.month + 1, 0).getDate()
      const cells = Math.ceil((lead + days) / 7) * 7
      endExclusive = new Date(cursor.year, cursor.month, 1 - lead + cells)
    } else if (scope === 'week') {
      const week = weekOf(focusedDate, firstDay)
      endExclusive = parseIsoDate(addIsoDays(week[6] ?? focusedDate, 1))
    } else {
      endExclusive = parseIsoDate(addIsoDays(focusedDate, 1))
    }
    const grid = endExclusive.getTime() - 1
    return { grid, withSlack: grid + PREVIEW_PAD_DAYS * DAY_MS }
  }, [calendar.weekend, scope, cursor.year, cursor.month, focusedDate])

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

    /*
     * The minutes a pile-up happens on, as a set.
     *
     * Built once from the scan — one pass over a list that is at most a dozen
     * long — so asking "is *this* send one of the colliding ones" below is a
     * single hash lookup rather than a scan of the conflict list per
     * occurrence. Same reason the `movedTo` map exists further down.
     */
    const collidingMinutes = new Set<number>()
    for (const conflict of conflictScan.conflicts) {
      if (conflict.kind === 'sameMinute' && conflict.at !== undefined) {
        collidingMinutes.add(Math.floor(conflict.at / 60_000))
      }
    }

    for (const job of state.jobs) {
      if (!job.enabled) continue
      const policy = job.recurrence.workdayPolicy ?? 'off'
      const raw = computeOccurrences(job.recurrence, {
        count: PREVIEW_OCCURRENCES,
        until: policy === 'before' ? previewUntil.withSlack : previewUntil.grid,
        runsSoFar: job.runCount,
        calendar,
      })
      const { occurrences, adjustment } = applyWorkCalendarDetailed(raw, policy, calendar)
      const rawDates = new Set(raw.map(toIsoDate))
      // Destination date → where it came from, built once. The lookup used to
      // be a `find` over `adjustment.moved` *per occurrence*, each step of
      // which allocated a `Date` inside `toIsoDate` — quadratic in the number
      // of shifted sends, for a job whose whole occurrence list is 60 long.
      const movedTo = new Map<IsoDate, number>()
      for (const move of adjustment.moved) {
        // First writer wins, so this answers exactly what `find` answered when
        // two sends were moved onto the same day.
        const to = toIsoDate(move.to)
        if (!movedTo.has(to)) movedTo.set(to, move.from)
      }

      for (const at of occurrences) {
        const iso = toIsoDate(at)
        const shifted = !rawDates.has(iso)
        const from = shifted ? movedTo.get(iso) : undefined

        /*
         * The line the square will print. Built here, where the occurrence
         * already is, rather than looked up per cell at render time — the
         * whole reason `DaySend` carries raw strings instead of a finished
         * sentence is so that this stays out of the render path and out of
         * this memo's dependency list. Cost: one object per occurrence, on a
         * loop that was already allocating one.
         */
        const line: DaySend = {
          jobId: job.id,
          at,
          to: job.draft.to[0] ?? '',
          subject: job.draft.subject,
          shifted,
          conflict: collidingMinutes.has(Math.floor(at / 60_000)),
        }

        const mark = marks.get(iso)
        if (mark) {
          mark.count += 1
          mark.shifted = mark.shifted || shifted
          if (!mark.jobIds!.includes(job.id)) mark.jobIds!.push(job.id)
          mark.lines!.push(line)
        } else {
          marks.set(iso, { count: 1, shifted, jobIds: [job.id], lines: [line] })
        }

        const entry: DayEntry = {
          job,
          at,
          shifted,
          originalIso: from !== undefined ? toIsoDate(from) : undefined,
        }
        const list = entriesByDate.get(iso)
        if (list) list.push(entry)
        else entriesByDate.set(iso, [entry])
      }
    }

    /*
     * Order and colour, once per day rather than once per cell.
     *
     * The sort is over one day's sends — typically one or two, and the square
     * only ever prints three — so this is linear in the number of sends drawn,
     * with a log factor inside each day. Doing it in the render would mean
     * re-sorting 42 arrays on every keystroke that reaches this screen.
     */
    for (const mark of marks.values()) {
      mark.lines?.sort((a, b) => a.at - b.at)
      mark.level = loadLevel(mark.count)
    }

    // Conflicts colour the square they happen on, so the grid answers "where is
    // the problem" without reading the list below it.
    for (const [iso, list] of conflictScan.byDate) {
      const severity = list.some((c) => c.severity === 'error') ? 'error' : 'warning'
      const mark = marks.get(iso)
      if (mark) mark.conflict = severity
      else marks.set(iso, { count: 0, shifted: false, jobIds: [], lines: [], conflict: severity })
    }

    return { marks, entriesByDate }
  }, [state.jobs, calendar, conflictScan, previewUntil])

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

  // --- starting one from the calendar ---------------------------------------

  /**
   * Double-click an empty square: a new reminder, for that day.
   *
   * Two things have to happen before the navigation, and both of them are
   * corrections rather than features:
   *
   *   - **Take back the stray toggle.** The first click of the double-click
   *     already marked the day as a holiday, because a browser has no way to
   *     tell a first click from the first half of a double-click. `MonthGrid`
   *     drops the *second* click, so there is exactly one edit to reverse, and
   *     the app's own undo reverses it exactly. Leaving it would mean every
   *     "new reminder here" also declared the day a public holiday.
   *   - **Refuse a day that has gone.** Mail cannot be scheduled into last
   *     Tuesday. Silently moving the date forward to something valid is the
   *     kind of quiet correction that gets discovered a month later.
   */
  const createOnDay = (iso: IsoDate) => {
    const stray = lastToggle.current
    if (stray && stray.iso === iso && Date.now() - stray.at < 1500) {
      undo()
      lastToggle.current = null
    }

    if (iso < todayIso) {
      toast.push({ tone: 'info', title: t('cal.create.past', { date: iso }) })
      return
    }
    if (!onCompose) return
    if (!seedComposeDate(iso)) return
    onCompose()
    toast.push({ tone: 'info', title: t('cal.create.seeded', { date: iso }) })
  }

  // --- de-staggering a pile-up ----------------------------------------------

  /**
   * Several reminders on one minute, spread across a window — and written back.
   *
   * This is the only conflict on this screen with a fix, and it is the one the
   * app could already *see* and never act on: `applyWorkCalendarDetailed`
   * de-duplicates within one reminder and is called once per job, so four rules
   * that each independently say 09:00 have never had anything spreading them.
   * `spreadSameMinute` is that same nudge with a `seen` set that spans jobs.
   *
   * What is written back is each rule's time of day, because that is all there
   * is to write: `Recurrence` has no per-occurrence exceptions, so moving one
   * send off 09:00 is moving every future send of that reminder off 09:00. The
   * confirmation says so in those words before anything is saved — the same
   * reason `planReschedule` is a plan rather than a mutation — and the whole
   * batch is one undo entry, so Ctrl+Z puts every one of them back together.
   */
  const deStagger = async (conflict: Conflict) => {
    const at = conflict.at
    if (conflict.kind !== 'sameMinute' || at === undefined) return

    const byId = new Map(state.jobs.map((j) => [j.id, j]))
    const involved = conflict.jobIds
      .map((id) => byId.get(id))
      .filter((j): j is ScheduledJob => Boolean(j))
    if (involved.length < 2) return

    const plan = spreadSameMinute(involved.map((job) => ({ jobId: job.id, at })))

    const writes: Array<{ job: ScheduledJob; recurrence: Recurrence; line: string }> = []
    const refused: string[] = []
    for (const move of plan.moves) {
      const job = byId.get(move.jobId)
      if (!job) continue
      const restagger = planRestagger(job, move.to - move.from)
      const sentence = `${job.name} — ${t(restagger.reasonKey as TranslationKey, restagger.reasonValues)}`
      // A cron rule keeps its minute inside an expression somebody wrote by
      // hand; rewriting it is not this button's business. Named in the result
      // rather than skipped quietly, so "why is that one still at 09:00" has
      // an answer on screen.
      if (!restagger.recurrence) refused.push(sentence)
      else writes.push({ job, recurrence: restagger.recurrence, line: sentence })
    }

    if (writes.length === 0) {
      toast.push({
        tone: 'error',
        title: t('cal.stagger.nothing'),
        detail: refused.length > 0 ? t('cal.stagger.refused', { list: refused.join(', ') }) : undefined,
      })
      return
    }

    // Every reminder, and exactly how far each one moves — not "3 reminders
    // will be adjusted". The whole reason this is a confirmation rather than a
    // button that just does it is that it rewrites *rules*, and a sentence
    // that hides which rules is not a confirmation.
    const ok = await confirm({
      title: t('cal.stagger.title'),
      body: [
        t('cal.stagger.body', {
          n: writes.length,
          min: STAGGER_WINDOW_MIN,
          when: formatDateTime(at),
        }),
        ...writes.map((w) => w.line),
      ].join(' · '),
      confirmLabel: t('cal.stagger.confirm'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    // One entry for the whole batch: undoing half a de-stagger would leave the
    // pile-up half-solved and the reminders in a state nobody chose.
    pushUndo(
      t('cal.stagger.undo'),
      writes.map((w) => ({ type: 'upsertJob', job: w.job }) as const),
    )
    for (const w of writes) {
      await scheduleDraft({ ...w.job, recurrence: w.recurrence })
    }

    toast.push({
      tone: 'success',
      title: t('cal.stagger.done', { n: writes.length, min: STAGGER_WINDOW_MIN }),
      detail:
        refused.length > 0
          ? t('cal.stagger.refused', { list: refused.join(', ') })
          : t('cal.undo.hint'),
    })
  }

  const sheetJob = sheetJobId ? state.jobs.find((j) => j.id === sheetJobId) : undefined

  // --- .ics -----------------------------------------------------------------

  /*
   * The third export in the app, and the one that was left behind when the
   * other two learned to wait for an answer. It fired "exported" on the click:
   * on the desktop the save dialog was still open, so cancelling it still
   * produced a success toast, and on Android the WebView does nothing at all
   * with a `blob:` URL, so the message was pure fiction.
   */
  const downloadIcs = async (text: string, name: string) => {
    const { outcome, unsupported } = await saveGeneratedFile(text, name, 'text/calendar')
    if (unsupported) {
      toast.push({ tone: 'error', title: t('download.androidUnsupported') })
      return
    }
    if (!outcome) {
      toast.push({ tone: 'success', title: t('cal.ics.exported', { name }) })
      return
    }
    if (outcome.cancelled) {
      toast.push({ tone: 'info', title: t('download.cancelled') })
      return
    }
    toast.push(
      outcome.ok
        ? { tone: 'success', title: t('cal.ics.exported', { name: outcome.name }) }
        : { tone: 'error', title: t('download.failed'), detail: outcome.name },
    )
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
    void downloadIcs(
      buildIcs(events, { name: t('workcal.title') }),
      `aevistle-working-calendar-${todayIso}.ics`,
    )
  }

  /**
   * Export the times this app will actually send at, rather than the rules.
   *
   * Default on, and on *this* screen that is the only defensible default. An
   * `RRULE` is the honest export of a rule and a dishonest export of a
   * schedule, and this whole screen exists because the two differ: it moves the
   * 1 October send to the 8th, and a subscriber reading the rule would be
   * looking at a date this app has already decided not to use.
   *
   * The trade-off, stated in the hint rather than hidden: a rule stays correct
   * forever, a resolved list only reaches as far as the occurrences do.
   */
  const [resolvedIcs, setResolvedIcs] = useState(true)

  const exportScheduleIcs = () => {
    if (state.jobs.length === 0) {
      toast.push({ tone: 'info', title: t('schedule.empty') })
      return
    }
    const { events, expanded } = jobsToEvents(state.jobs, {
      resolved: resolvedIcs ? { calendar } : undefined,
    })
    void downloadIcs(buildIcs(events, { name: t('schedule.title') }), `aevistle-reminders-${todayIso}.ics`)
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
    /**
     * Through the bridge, because this document is not allowed to open a
     * socket. `index.html` ships `connect-src 'self'`; the direct `fetch` that
     * used to be here was refused by the page's own policy long before it
     * reached the network, and every year — 2025, 2026, 2027 alike — came back
     * as `Failed to fetch`, which reads exactly like a network fault and is
     * not one. See `core/feeds.ts`.
     *
     * The browser preview has no trusted side to route through, so there it
     * still calls the global and still fails. That is honest: it is the one
     * build where the feature genuinely cannot work.
     */
    const outcome = await fetchStatutoryYear(year, {
      fetchImpl: bridge?.fetchFeed ? feedFetchVia(bridge.fetchFeed) : undefined,
    })
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
                  /* The square lists what it holds; the drag that was already
                     here still moves it, and a click now opens it. */
                  showSends
                  formatTime={formatTime}
                  noRecipientLabel={t('cal.day.noRecipient')}
                  noSubjectLabel={t('cal.day.noSubject')}
                  moreLabel={(n) => t('cal.more', { n })}
                  onOpenSend={(jobId, iso) => {
                    setFocusedDate(iso)
                    setSheetJobId(jobId)
                  }}
                  onCreateDay={onCompose ? createOnDay : undefined}
                  createHint={onCompose ? t('cal.create.hint') : undefined}
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
                  onCreate={onCompose ? createOnDay : undefined}
                  onDeStagger={(conflict) => void deStagger(conflict)}
                  staggerWindowMinutes={STAGGER_WINDOW_MIN}
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
                  {/*
                    The heatmap's own key. A scale nobody can read is decoration:
                    without this, five shades of the accent say only "some of
                    these are darker", and the reader has no way to learn that
                    the darkest one means eight sends or more.
                  */}
                  <span className="monthgrid__legendscale">
                    {t('cal.legendLoad')}
                    <i className="swatch swatch--load" data-load="1" />
                    <i className="swatch swatch--load" data-load="2" />
                    <i className="swatch swatch--load" data-load="3" />
                    <i className="swatch swatch--load" data-load="4" />
                    <i className="swatch swatch--load" data-load="5" />
                    <span className="monthgrid__legendmax">
                      {t('cal.legendLoadMax', { n: LOAD_STEPS[LOAD_STEPS.length - 1] })}
                    </span>
                  </span>
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
                      {/* The one kind with a fix, offered where the problem is
                          named. The other four end in "this will not send" and
                          "there is nowhere to move it to", which no button can
                          answer — a disabled control beside each of them would
                          only look like the app was withholding something. */}
                      {conflict.kind === 'sameMinute' ? (
                        <Button variant="secondary" onClick={() => void deStagger(conflict)}>
                          {t('cal.stagger.action', { min: STAGGER_WINDOW_MIN })}
                        </Button>
                      ) : null}
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
              <Switch
                checked={resolvedIcs}
                onChange={setResolvedIcs}
                title={t('cal.ics.resolved')}
                description={t('cal.ics.resolvedHint')}
              />
              <div className="field__hint">{t('cal.ics.importHint')}</div>
              {/*
                Said here rather than discovered later. "Subscribe" in the sense
                Google Calendar means it needs a public URL to poll, and this
                application deliberately has no server and no address to give
                one. A file that Outlook, Thunderbird and Apple Calendar can
                subscribe to is the honest maximum, and claiming more would be
                the kind of quiet half-truth this app is built to avoid.
              */}
              <div className="field__hint">{t('cal.ics.subscribeLimit')}</div>
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
