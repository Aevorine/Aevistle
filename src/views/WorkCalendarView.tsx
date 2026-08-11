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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { CalendarDayPanel, JobSheet, SeriesSheet, conflictLine, type DayEntry } from '../components/CalendarDayPanel'
import type { DaySend, SendDeliveryStatus } from '../components/MonthGrid'
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
import { computeOccurrences } from '../core/schedule/schedule'
import {
  applyPresetRange,
  clearYear,
  countInYear,
  holidayNameFor,
  HOLIDAY_PRESETS,
  yearRange,
  yearsInCalendar,
} from '../core/schedule/holidayPresets'
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
} from '../core/schedule/cnHolidays'
import { feedFetchVia } from '../core/schedule/feeds'
import { findConflicts, type Conflict } from '../core/sync/conflicts'
import { buildIcs, calendarToEvents, eventsToCalendarDates, jobsToEvents, parseIcs } from '../core/schedule/ics'
import { dayDelta, planReschedule, planRestagger, shiftInstantByDays } from '../core/schedule/reschedule'
import { isInsideWindow, resolveTimeZone, wallClockIn } from '../core/schedule/deliveryWindow'
import { seedComposeDate, seedComposeDates } from '../core/mail/composeSeed'
import { LOAD_STEPS, loadLevel } from '../core/schedule/calendarLoad'
import { activeSolarTermForMonth, type SolarTermId } from '../core/schedule/solarTerms'

/** Every 节气 name, for the runecircuit-only line under the period heading. */
const SOLAR_TERM_LABEL: Record<SolarTermId, TranslationKey> = {
  xiaohan: 'calendar.solarTerm.xiaohan',
  dahan: 'calendar.solarTerm.dahan',
  lichun: 'calendar.solarTerm.lichun',
  yushui: 'calendar.solarTerm.yushui',
  jingzhe: 'calendar.solarTerm.jingzhe',
  chunfen: 'calendar.solarTerm.chunfen',
  qingming: 'calendar.solarTerm.qingming',
  guyu: 'calendar.solarTerm.guyu',
  lixia: 'calendar.solarTerm.lixia',
  xiaoman: 'calendar.solarTerm.xiaoman',
  mangzhong: 'calendar.solarTerm.mangzhong',
  xiazhi: 'calendar.solarTerm.xiazhi',
  xiaoshu: 'calendar.solarTerm.xiaoshu',
  dashu: 'calendar.solarTerm.dashu',
  liqiu: 'calendar.solarTerm.liqiu',
  chushu: 'calendar.solarTerm.chushu',
  bailu: 'calendar.solarTerm.bailu',
  qiufen: 'calendar.solarTerm.qiufen',
  hanlu: 'calendar.solarTerm.hanlu',
  shuangjiang: 'calendar.solarTerm.shuangjiang',
  lidong: 'calendar.solarTerm.lidong',
  xiaoxue: 'calendar.solarTerm.xiaoxue',
  daxue: 'calendar.solarTerm.daxue',
  dongzhi: 'calendar.solarTerm.dongzhi',
}
import { saveGeneratedFile } from '../core/platform/download'
import { accountLabel, groupAccounts } from '../core/mail/accounts'
import { DragTimezoneTip } from '../components/DragTimezoneTip'
import type { OutboxItem } from '../core/ops/outbox'
import { pad2, type Contact, type LogEntry, type Recurrence, type ScheduledJob } from '../core/types'
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
} from '../core/schedule/workCalendar'

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

/** Lines the drag preview tooltip shows before it switches to "+N more". */
const MAX_DRAGTIP_LINES = 3

/**
 * How close a log line or an outbox item's own timestamp has to sit to an
 * occurrence's fire time to be read as *about that send*, rather than some
 * other run of the same repeating reminder.
 *
 * Wide enough to cover the offline queue's own worst case — `MAX_ATTEMPTS`
 * attempts of `backoffMs` sum to a little over two hours — with slack left for
 * a quiet-hours release or ordinary clock drift. Not unbounded: a window that
 * never closes would eventually tie a Tuesday's failure to Thursday's send.
 */
const STATUS_MATCH_WINDOW_MS = 3 * 60 * 60_000

/** Remembers which country's names to use for the chips. See `holidayNameFor`. */
const PRESET_MEMORY_KEY = 'aevistle.workcal.preset'

export function WorkCalendarView({ onCompose }: { onCompose?: () => void } = {}) {
  const { state, dispatch, pushUndo, undo, toggleJob, scheduleDraft, bridge } = useApp()
  const { t, dir, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()
  const calendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR
  const heatmapOn = state.settings.calendarHeatmapEnabled ?? true
  const setHeatmapOn = (v: boolean) => dispatch({ type: 'patchSettings', patch: { calendarHeatmapEnabled: v } })

  const now = new Date()
  const todayIso = toIsoDate(now.getTime())
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  /** The runecircuit style's monthly wash — ignored entirely by every other style. */
  const solarTerm = useMemo(() => activeSolarTermForMonth(cursor.year, cursor.month), [cursor.year, cursor.month])
  const [scope, setScope] = useState<GridScope | 'day'>('month')
  const [focusedDate, setFocusedDate] = useState<IsoDate>(todayIso)
  const [selection, setSelection] = useState<DateRange | null>(null)
  /**
   * Days queued for the gap-compose batch. `IsoDate`s rather than a range: a
   * shutdown is contiguous and already has `selection` for that; a batch of
   * reminders for a handful of scattered dates is a different shape of
   * gesture and gets its own set. Cleared on every compose and on request.
   */
  const [gapDates, setGapDates] = useState<Set<IsoDate>>(new Set())
  /**
   * The drag-time recipient timezone preview — recomputed on every cell the
   * pointer crosses (see `onDragHover` below) and cleared on drop or cancel.
   * `null` means nothing is being dragged, or nothing about the drag is worth
   * saying.
   */
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const [paste, setPaste] = useState('')
  const [target, setTarget] = useState<'holidays' | 'workdays'>('holidays')
  const [sheetJobId, setSheetJobId] = useState<string | null>(null)
  /** The series sheet, opened from `JobSheet` for a job a single drag cannot act on alone. */
  const [seriesJobId, setSeriesJobId] = useState<string | null>(null)
  /**
   * A day opened from the badge, shown as a panel under the grid rather than
   * by switching `scope` to `'day'` — the point of the quick view is staying
   * on the month you were looking at. Distinct from `focusedDate`, which keeps
   * moving with the keyboard and the drag-and-drop regardless of whether this
   * panel is open.
   */
  const [quickPanelIso, setQuickPanelIso] = useState<IsoDate | null>(null)
  const [filterAccountId, setFilterAccountId] = useState('all')
  const [filterTag, setFilterTag] = useState('all')
  const [filterRecipient, setFilterRecipient] = useState('')
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

  // --- filtering, initials, and delivery status ------------------------------
  //
  // Every index below is built once per render of its own inputs, the same
  // discipline `collidingMinutes` and `movedTo` already keep inside the marks
  // memo further down — a lookup per occurrence instead of a scan per
  // occurrence. `conflictScan` above and `users` above it both stay over
  // `state.jobs`, unfiltered: a filter that could hide a real conflict would
  // be worse than no filter at all.

  /** Normalised address → contact, for the initials chips and the tag filter. */
  const contactsByAddress = useMemo(() => {
    const map = new Map<string, Contact>()
    for (const contact of state.contacts) {
      const address = contact.address.trim().toLowerCase()
      if (address) map.set(address, contact)
    }
    return map
  }, [state.contacts])

  const accountGroups = useMemo(() => groupAccounts(state.accounts), [state.accounts])
  const allTags = useMemo(
    () => [...new Set(state.contacts.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b)),
    [state.contacts],
  )

  const filterActive =
    filterAccountId !== 'all' || filterTag !== 'all' || filterRecipient.trim().length > 0

  const filteredJobs = useMemo(() => {
    if (!filterActive) return state.jobs
    const needle = filterRecipient.trim().toLowerCase()
    return state.jobs.filter((job) => {
      if (filterAccountId !== 'all' && job.draft.accountId !== filterAccountId) return false
      const addresses = [...job.draft.to, ...job.draft.cc, ...job.draft.bcc]
      if (filterTag !== 'all') {
        const tagged = addresses.some((a) =>
          (contactsByAddress.get(a.trim().toLowerCase())?.tags ?? []).includes(filterTag),
        )
        if (!tagged) return false
      }
      if (needle && !addresses.some((a) => a.toLowerCase().includes(needle))) return false
      return true
    })
  }, [state.jobs, filterActive, filterAccountId, filterTag, filterRecipient, contactsByAddress])

  const clearFilters = () => {
    setFilterAccountId('all')
    setFilterTag('all')
    setFilterRecipient('')
  }

  /** `LogEntry`s that name a job, grouped — the past half of a delivery status. */
  const logsByJob = useMemo(() => {
    const map = new Map<string, LogEntry[]>()
    for (const log of state.logs) {
      if (log.kind !== 'send' || !log.jobId) continue
      const list = map.get(log.jobId)
      if (list) list.push(log)
      else map.set(log.jobId, [log])
    }
    return map
  }, [state.logs])

  /** Outbox items that name a job, grouped — the "still trying" half. */
  const outboxByJob = useMemo(() => {
    const map = new Map<string, OutboxItem[]>()
    for (const item of state.outbox) {
      if (!item.jobId) continue
      const list = map.get(item.jobId)
      if (list) list.push(item)
      else map.set(item.jobId, [item])
    }
    return map
  }, [state.outbox])

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

    const nowMs = Date.now()

    for (const job of filteredJobs) {
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

      // One lookup per job, not per occurrence: the first recipient and its
      // contact never change across a job's own sends.
      const firstTo = job.draft.to[0]
      const contactName = firstTo ? contactsByAddress.get(firstTo.trim().toLowerCase())?.name?.trim() : undefined
      const initialsSource = contactName || firstTo?.split('@')[0]
      const initials = initialsSource ? initialsSource.charAt(0).toUpperCase() : undefined

      for (const at of occurrences) {
        const iso = toIsoDate(at)
        const shifted = !rawDates.has(iso)
        const from = shifted ? movedTo.get(iso) : undefined
        // Only a send that has already fired can have a delivery status — a
        // future occurrence has nothing yet to correlate against.
        const status =
          at <= nowMs ? sendStatusFor(job.id, at, outboxByJob, logsByJob, job) : undefined

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
          initials,
          status,
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
          status,
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
  }, [filteredJobs, calendar, conflictScan, previewUntil, contactsByAddress, outboxByJob, logsByJob])

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

    // The same sentences the hover tooltip was showing, recomputed rather than
    // carried over from `dragPreview` state — the pointer may have kept moving
    // between the last `dragover` and this drop's `onMoveJob`, and this is the
    // instant the decision actually gets made on. See `dragWarningLines`.
    const warnings = dragWarningLines(job, fromIso, toIso, calendar, contactsByAddress, t)

    const ok = await confirm({
      title: t('cal.move.title'),
      body: [
        [
          t(plan.reasonKey as TranslationKey, translateValues(plan.reasonValues, t)),
          plan.outcome === 'series' ? t('cal.move.seriesNote') : '',
        ]
          .filter(Boolean)
          .join(' '),
        ...warnings,
      ]
        .filter(Boolean)
        .join(' · '),
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

  /**
   * The drag preview, updated as the pointer crosses cells.
   *
   * `MonthGrid` throttles this to once per cell entered; the lookup and the
   * sentence-building happen here rather than there because `dragWarningLines`
   * needs `state.jobs`, `contactsByAddress` and `t`, none of which the grid
   * component knows about — it only ever handles ids and dates.
   */
  const onDragHover = useCallback(
    (info: { jobId: string; fromIso: IsoDate; toIso: IsoDate; fromAt: number; x: number; y: number }) => {
      const job = state.jobs.find((j) => j.id === info.jobId)
      if (!job) {
        setDragPreview(null)
        return
      }
      const full = dragWarningLines(job, info.fromIso, info.toIso, calendar, contactsByAddress, t)
      if (full.length === 0) {
        setDragPreview(null)
        return
      }
      const shown = full.length > MAX_DRAGTIP_LINES ? full.slice(0, MAX_DRAGTIP_LINES) : full
      const hidden = full.length - shown.length
      setDragPreview({
        x: info.x,
        y: info.y,
        lines: hidden > 0 ? [...shown, t('cal.dragpreview.multiple', { n: hidden })] : shown,
      })
    },
    [state.jobs, calendar, contactsByAddress, t],
  )

  /** Ctrl/Cmd-click on an empty square: add or drop it from the gap-compose batch. */
  const onGapToggle = useCallback((iso: IsoDate) => {
    setGapDates((prev) => {
      const next = new Set(prev)
      if (next.has(iso)) next.delete(iso)
      else next.add(iso)
      return next
    })
  }, [])

  const composeForGaps = () => {
    if (gapDates.size === 0 || !onCompose) return
    if (!seedComposeDates([...gapDates].sort())) return
    setGapDates(new Set())
    onCompose()
  }

  /**
   * `SeriesSheet`'s bulk reschedule — a UI front door onto the exact same
   * `planReschedule` shift a drag on the grid performs, not a second way to
   * move a job. The anchor (rather than, say, today) is a date
   * `planReschedule`'s weekly branch can trust: it is an actual fire time the
   * current rule produced, so its weekday is guaranteed to be one the rule
   * names, the same guarantee a real drag has.
   *
   * The first *future* occurrence, not `occurrences[0]`.
   *
   * Since catch-up landed, `occurrences[0]` can be a missed instant waiting to
   * be paid — prepended unshaped, so unlike every other entry it carries no
   * promise about its weekday. Anchoring on it computed the day delta from
   * yesterday, which moved the series one day further than the user asked, in
   * silence, and only for jobs that had missed a run. Falling back to the last
   * entry keeps a job whose whole list is overdue draggable rather than inert.
   */
  const shiftSeries = (job: ScheduledJob, days: number) => {
    if (job.occurrences.length === 0 || days === 0) return
    const now = Date.now()
    const anchor =
      job.occurrences.find((at) => at > now) ?? job.occurrences[job.occurrences.length - 1]
    const fromIso = toIsoDate(anchor)
    void moveJob(job.id, fromIso, addIsoDays(fromIso, days))
  }

  /**
   * `SeriesSheet`'s template swap. Only the message changes — `recurrence` is
   * untouched, so every occurrence keeps the time it already had.
   */
  const swapSeriesTemplate = async (job: ScheduledJob, templateId: string) => {
    const tmpl = state.templates.find((tp) => tp.id === templateId)
    if (!tmpl) return
    pushUndo(job.name, [{ type: 'upsertJob', job }])
    await scheduleDraft({
      ...job,
      draft: { ...job.draft, subject: tmpl.subject, body: tmpl.body, bodyFormat: tmpl.bodyFormat },
    })
    toast.push({ tone: 'success', title: t('cal.series.swapped', { name: tmpl.name }) })
  }

  /**
   * A link inside an expanded HTML body preview was clicked — the same
   * confirm-then-open the inbox reader uses for exactly the same reason: the
   * click came from inside a sanitized-but-still-sender-authored document.
   */
  const openLinkSafely = useCallback(
    async (url: string) => {
      let host = url
      try {
        host = new URL(url).host
      } catch {
        /* keep the raw string if it does not parse */
      }
      const ok = await confirm({
        title: t('confirm.openLinkTitle'),
        body: t('confirm.openLinkBody', { host }),
        confirmLabel: t('confirm.openLinkConfirm'),
        cancelLabel: t('common.cancel'),
      })
      if (ok) void bridge?.openExternal(url)
    },
    [confirm, bridge, t],
  )

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
  const seriesJob = seriesJobId ? state.jobs.find((j) => j.id === seriesJobId) : undefined

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
    if (outcome.unpublished) {
      // Answered, and the answer is "not yet". Not an error, and it gets the
      // sentence this screen already uses for that — the same one the row
      // shows before the button is pressed, so pressing it cannot contradict
      // what the row said.
      toast.push({ tone: 'info', title: t('cal.cn.missing', { year }) })
      return
    }
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
    // The quick view names a day; a day that has scrolled off screen is not
    // worth still showing a panel for.
    setQuickPanelIso(null)
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
          Only the positive case is announced now.

          There used to be a companion banner for `users.length === 0`
          explaining that no reminder uses this calendar yet and which switch
          turns it on. It was accurate and it was in the way: zero is where
          every install starts, so the first thing anyone ever saw on this
          screen was two lines telling them the screen they had just opened
          was not doing anything — above the calendar, on every visit, until
          they happened to satisfy it. On a phone it pushed the month grid
          itself below the fold.

          The same instruction lives where it can be acted on, in the
          recurrence editor's own switch, which is the thing the removed text
          was directing people to anyway.
        */}
        {users.length > 0 ? (
          <div className="banner banner--success">
            <IconCalendar size={16} />
            <div>{t('workcal.usedBy', { n: users.length })}</div>
          </div>
        ) : null}

        <div className="list-pane workcal__panes">
          <Card>
            <CardHeader
              title={periodLabel}
              /* The instruction that used to sit here ("tap a day to flip it")
                 is gone with the rest of the explanatory prose; the solar term
                 stays because it is the month's data, not a description of the
                 control below it. */
              hint={
                state.settings.visualStyle === 'runecircuit'
                  ? t(SOLAR_TERM_LABEL[solarTerm])
                  : undefined
              }
              action={
                <div className="btn-row">
                  <Segmented
                    value={scope}
                    onChange={(v) => {
                      setScope(v)
                      setQuickPanelIso(null)
                    }}
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
                      setQuickPanelIso(null)
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
                <div className="field__row workcal__filters">
                  <Field label={t('cal.filter.account')}>
                    <select
                      className="input"
                      value={filterAccountId}
                      onChange={(e) => setFilterAccountId(e.target.value)}
                    >
                      <option value="all">{t('cal.filter.allAccounts')}</option>
                      {accountGroups.map((group) =>
                        group.name ? (
                          <optgroup key={group.name} label={group.name}>
                            {group.accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {accountLabel(a)}
                              </option>
                            ))}
                          </optgroup>
                        ) : (
                          group.accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {accountLabel(a)}
                            </option>
                          ))
                        ),
                      )}
                    </select>
                  </Field>
                  <Field label={t('cal.filter.tag')}>
                    <select className="input" value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
                      <option value="all">{t('cal.filter.allTags')}</option>
                      {allTags.map((tag) => (
                        <option key={tag} value={tag}>
                          {tag}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('cal.filter.recipient')}>
                    <input
                      className="input"
                      type="text"
                      value={filterRecipient}
                      onChange={(e) => setFilterRecipient(e.target.value)}
                    />
                  </Field>
                  {filterActive ? (
                    <>
                      <span className="workcal__filterhint">
                        {t('cal.filter.activeHint', { n: filteredJobs.length, total: state.jobs.length })}
                      </span>
                      <Button variant="ghost" icon={<IconX size={14} />} onClick={clearFilters}>
                        {t('cal.filter.clear')}
                      </Button>
                    </>
                  ) : null}
                </div>
              )}

              {scope === 'day' ? null : (
                <MonthGrid
                  year={cursor.year}
                  month={cursor.month}
                  solarTerm={solarTerm}
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
                    setQuickPanelIso(iso)
                  }}
                  onMoveJob={(jobId, from, to) => void moveJob(jobId, from, to)}
                  onDragHover={onDragHover}
                  onDragHoverEnd={() => setDragPreview(null)}
                  gapDates={gapDates}
                  onGapToggle={onGapToggle}
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
                  label={
                    filterActive
                      ? `${t('cal.gridLabel')} — ${t('cal.filter.activeHint', {
                          n: filteredJobs.length,
                          total: state.jobs.length,
                        })}`
                      : t('cal.gridLabel')
                  }
                  badgeLabel={(iso, mark) => t('cal.badge', { n: mark.count, date: iso })}
                  heatmapOn={heatmapOn}
                  initialsAriaLabel={(name) => t('cal.badge.initialsAria', { name })}
                  sendStatusLabel={(status) =>
                    t('cal.status.badgeAria', { status: t(`cal.status.${status}` as TranslationKey) })
                  }
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

              {scope !== 'day' && quickPanelIso ? (
                <div className="workcal__quickpanel">
                  <div className="workcal__quickpanelhead">
                    <span className="section-label">{t('cal.quick.title')}</span>
                    <IconButton label={t('cal.quick.close')} onClick={() => setQuickPanelIso(null)}>
                      <IconX size={14} />
                    </IconButton>
                  </div>
                  <CalendarDayPanel
                    iso={quickPanelIso}
                    entries={entriesByDate.get(quickPanelIso) ?? []}
                    working={isWorkingDayIso(quickPanelIso, calendar)}
                    holidayName={calendar.holidays.includes(quickPanelIso) ? nameFor(quickPanelIso) : undefined}
                    calendar={calendar}
                    conflicts={conflictScan.byDate.get(quickPanelIso) ?? []}
                    onToggleDay={toggleDay}
                    onMove={(jobId, from, to) => void moveJob(jobId, from, to)}
                    onOpenJob={setSheetJobId}
                    onCreate={onCompose ? createOnDay : undefined}
                    onDeStagger={(conflict) => void deStagger(conflict)}
                    staggerWindowMinutes={STAGGER_WINDOW_MIN}
                    sanitizeHtml={bridge?.sanitizeHtml}
                    onOpenLink={openLinkSafely}
                    compact
                  />
                </div>
              ) : null}

              {scope === 'day' ? (
                <CalendarDayPanel
                  iso={focusedDate}
                  entries={entriesByDate.get(focusedDate) ?? []}
                  working={isWorkingDayIso(focusedDate, calendar)}
                  holidayName={calendar.holidays.includes(focusedDate) ? nameFor(focusedDate) : undefined}
                  calendar={calendar}
                  conflicts={dayConflicts}
                  onToggleDay={toggleDay}
                  onMove={(jobId, from, to) => void moveJob(jobId, from, to)}
                  onOpenJob={setSheetJobId}
                  onCreate={onCompose ? createOnDay : undefined}
                  onDeStagger={(conflict) => void deStagger(conflict)}
                  staggerWindowMinutes={STAGGER_WINDOW_MIN}
                  sanitizeHtml={bridge?.sanitizeHtml}
                  onOpenLink={openLinkSafely}
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

              {scope !== 'day' && onCompose ? (
                gapDates.size > 0 ? (
                  <div className="rangebar" role="group" aria-label={t('cal.gap.composeFor', { n: gapDates.size })}>
                    <Button variant="secondary" icon={<IconPlus size={15} />} onClick={composeForGaps}>
                      {t('cal.gap.composeFor', { n: gapDates.size })}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setGapDates(new Set())
                        toast.push({ tone: 'info', title: t('cal.gap.cleared') })
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : null
              ) : null}

              {scope !== 'day' ? (
                <div className="workcal__heatmaptoggle">
                  <Switch
                    checked={heatmapOn}
                    onChange={setHeatmapOn}
                    title={t('cal.heatmap.toggle')}
                    description={t('cal.heatmap.hint')}
                  />
                </div>
              ) : null}

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
                    the darkest one means eight sends or more. Gated by the same
                    switch that gates the tint itself — a key for a scale that
                    is not being painted would be the decoration.
                  */}
                  {heatmapOn ? (
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
                  ) : null}
                </div>
              ) : null}
            </div>
          </Card>

          {/* --- conflicts --------------------------------------------------- */}

          <Card>
            <CardHeader
              title={t('cal.conflict.title')}
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
            <CardHeader title={t('workcal.presets')} />
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
            <CardHeader title={t('cal.cn.title')} />
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
            <CardHeader title={t('cal.ics.title')} />
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
              />
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
            <CardHeader title={t('workcal.weekend')} />
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
            <CardHeader title={t('workcal.paste')} />
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
              <CardHeader title={t('cal.year.title')} />
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
          onViewSeries={() => {
            setSeriesJobId(sheetJob.id)
            setSheetJobId(null)
          }}
        />
      ) : null}

      {seriesJob ? (
        <SeriesSheet
          job={seriesJob}
          calendar={calendar}
          templates={state.templates}
          onClose={() => setSeriesJobId(null)}
          onPause={() => void toggleJob(seriesJob.id, false)}
          onShift={(days) => shiftSeries(seriesJob, days)}
          onSwapTemplate={(templateId) => void swapSeriesTemplate(seriesJob, templateId)}
        />
      ) : null}

      {dragPreview ? <DragTimezoneTip x={dragPreview.x} y={dragPreview.y} lines={dragPreview.lines} /> : null}

      {confirmElement}
    </div>
  )
}

/**
 * What dragging `job` from `fromIso` to `toIso` would mean for the people
 * receiving it, in their own zone — the drag-time preview, and the same
 * sentences `moveJob`'s confirm dialog appends so the decision survives from
 * hover to drop. Computed fresh each time rather than cached: it is cheap
 * (`job.draft.to/cc/bcc` is never more than a handful of addresses), and a
 * cached answer would be one more thing that could disagree with where the
 * pointer actually is.
 *
 * Only a recipient matched by address in the contact book *and* carrying a
 * stored `deliveryWindow` gets a line. Everyone else is silently absent —
 * never a guess dressed up as a reading. See `core/deliveryWindow.ts`.
 */
function dragWarningLines(
  job: ScheduledJob,
  fromIso: IsoDate,
  toIso: IsoDate,
  calendar: WorkCalendar,
  contactsByAddress: Map<string, Contact>,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string[] {
  const lines: string[] = []
  const delta = dayDelta(fromIso, toIso)
  // `job.recurrence.startAt`, not a specific occurrence's own instant: the
  // caller only ever has one to hand (the badge falls back to the day's
  // earliest send), and shifting the rule's own anchor keeps the same
  // wall-clock time of day a real move would produce. See `planReschedule`.
  const candidateAt = shiftInstantByDays(job.recurrence.startAt, delta)

  const seen = new Set<string>()
  for (const raw of [...job.draft.to, ...job.draft.cc, ...job.draft.bcc]) {
    const address = raw.trim().toLowerCase()
    if (!address || seen.has(address)) continue
    seen.add(address)
    const contact = contactsByAddress.get(address)
    const window = contact?.deliveryWindow
    if (!contact || !window) continue
    const zone = resolveTimeZone(window.timeZone)
    if (zone === null) continue
    const wall = wallClockIn(candidateAt, zone)
    if (wall === null) continue

    const time = `${pad2(Math.floor(wall.minutes / 60))}:${pad2(wall.minutes % 60)}`
    const name = contact.name.trim() || address
    lines.push(
      isInsideWindow(candidateAt, window)
        ? t('cal.dragpreview.recipientTime', { time, name })
        : t('cal.dragpreview.outsideWindow', { time, name, from: window.from, to: window.to }),
    )
  }

  if (calendar.holidays.includes(toIso)) lines.push(t('cal.dragpreview.holiday'))

  return lines
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

/**
 * What became of one past occurrence — delivered, failed, still retrying, or
 * unknown — read off whatever the app actually recorded about it.
 *
 * In order: the offline queue first, because it names the *current* state of
 * a send that has not finished yet; then the logs, taking the most recent
 * entry inside the window as the authoritative one, since a queued send
 * writes a fresh log line on every attempt and the last one is what actually
 * happened; then the job's own `lastResult`, but only when its `lastRunAt` is
 * plausibly *this* occurrence and not some later one. No match anywhere
 * returns `undefined` — never a guess. See `core/receipts.ts` for the same
 * stance applied to bounces.
 */
function sendStatusFor(
  jobId: string,
  at: number,
  outboxByJob: Map<string, OutboxItem[]>,
  logsByJob: Map<string, LogEntry[]>,
  job: ScheduledJob,
): SendDeliveryStatus | undefined {
  for (const item of outboxByJob.get(jobId) ?? []) {
    if (Math.abs(item.queuedAt - at) > STATUS_MATCH_WINDOW_MS) continue
    if (item.status === 'failed') return 'failed'
    if (item.status === 'waiting' || item.status === 'sending') return 'retrying'
  }

  const nearby = (logsByJob.get(jobId) ?? [])
    .filter((l) => Math.abs(l.at - at) <= STATUS_MATCH_WINDOW_MS)
    .sort((a, b) => a.at - b.at)
  const last = nearby[nearby.length - 1]
  if (last) {
    if (last.level === 'info') return 'delivered'
    if (last.level === 'error') return 'failed'
    return 'retrying'
  }

  if (job.lastRunAt !== undefined && Math.abs(job.lastRunAt - at) <= STATUS_MATCH_WINDOW_MS) {
    if (job.lastResult === 'ok') return 'delivered'
    if (job.lastResult === 'failed') return 'failed'
  }

  return undefined
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
