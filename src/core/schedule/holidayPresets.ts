/**
 * Starting points for the working calendar, per country.
 *
 * **Fixed-date statutory holidays only, and that is deliberate.**
 *
 * The holidays that move — Easter and everything hanging off it, the Chinese
 * and Islamic lunar calendars, the "observed on the following Monday" rules,
 * and every make-up workday — are published year by year by each government.
 * Guessing them produces a calendar that is confidently wrong on exactly the
 * days it matters, and a reminder that silently moves to the wrong day is worse
 * than one the user entered by hand. So this ships the dates that genuinely do
 * not move, says so on screen, and leaves the paste box for the rest.
 *
 * The weekend definition is the other half and is not a detail: Friday–Saturday
 * in Saudi Arabia is not an edge case, it is most of the reason a hard-coded
 * `[0, 6]` was wrong.
 */

import type { IsoDate, WorkCalendar } from './workCalendar'

/**
 * How many years either side of the cursor a preset may be asked to fill.
 *
 * Generous, because the alternative was worse: filling three years used to mean
 * paging the grid 36 times and pressing the button three times. Not unbounded,
 * because "every year from now to 2099" is 800 date strings in a settings file
 * that is read on every launch.
 */
export const PRESET_MAX_YEARS = 10

export interface HolidayPreset {
  id: string
  /** Translation key for the country's name. */
  labelKey: string
  /** Days of the week that are not worked. 0 = Sunday … 6 = Saturday. */
  weekend: number[]
  /** `MM-DD`, expanded to the requested year. */
  fixed: Array<{ md: string; name: string }>
  /**
   * True when a meaningful part of this country's calendar moves year to year
   * and therefore is not in `fixed`. Drives the "check the official notice"
   * line, so the gap is visible rather than implied.
   */
  hasMovingDates: boolean
}

export const HOLIDAY_PRESETS: HolidayPreset[] = [
  {
    id: 'CN',
    labelKey: 'workcal.preset.CN',
    weekend: [0, 6],
    fixed: [
      { md: '01-01', name: "New Year's Day" },
      { md: '05-01', name: 'Labour Day' },
      { md: '10-01', name: 'National Day' },
      { md: '10-02', name: 'National Day' },
      { md: '10-03', name: 'National Day' },
    ],
    // Spring Festival, Qingming, Dragon Boat and Mid-Autumn are lunar, and the
    // make-up workdays are announced annually by the State Council.
    hasMovingDates: true,
  },
  {
    id: 'US',
    labelKey: 'workcal.preset.US',
    weekend: [0, 6],
    fixed: [
      { md: '01-01', name: "New Year's Day" },
      { md: '06-19', name: 'Juneteenth' },
      { md: '07-04', name: 'Independence Day' },
      { md: '11-11', name: 'Veterans Day' },
      { md: '12-25', name: 'Christmas Day' },
    ],
    // MLK Day, Presidents' Day, Memorial Day, Labor Day, Columbus Day and
    // Thanksgiving are all nth-weekday rules.
    hasMovingDates: true,
  },
  {
    id: 'FR',
    labelKey: 'workcal.preset.FR',
    weekend: [0, 6],
    fixed: [
      { md: '01-01', name: "Jour de l'An" },
      { md: '05-01', name: 'Fête du Travail' },
      { md: '05-08', name: 'Victoire 1945' },
      { md: '07-14', name: 'Fête nationale' },
      { md: '08-15', name: 'Assomption' },
      { md: '11-01', name: 'Toussaint' },
      { md: '11-11', name: 'Armistice' },
      { md: '12-25', name: 'Noël' },
    ],
    // Easter Monday, Ascension and Whit Monday move with Easter.
    hasMovingDates: true,
  },
  {
    id: 'ES',
    labelKey: 'workcal.preset.ES',
    weekend: [0, 6],
    fixed: [
      { md: '01-01', name: 'Año Nuevo' },
      { md: '01-06', name: 'Epifanía' },
      { md: '05-01', name: 'Fiesta del Trabajo' },
      { md: '08-15', name: 'Asunción' },
      { md: '10-12', name: 'Fiesta Nacional' },
      { md: '11-01', name: 'Todos los Santos' },
      { md: '12-06', name: 'Día de la Constitución' },
      { md: '12-08', name: 'Inmaculada Concepción' },
      { md: '12-25', name: 'Navidad' },
    ],
    // Good Friday moves, and every autonomous community adds its own.
    hasMovingDates: true,
  },
  {
    id: 'RU',
    labelKey: 'workcal.preset.RU',
    weekend: [0, 6],
    fixed: [
      { md: '01-01', name: 'Новый год' },
      { md: '01-02', name: 'Новогодние каникулы' },
      { md: '01-03', name: 'Новогодние каникулы' },
      { md: '01-04', name: 'Новогодние каникулы' },
      { md: '01-05', name: 'Новогодние каникулы' },
      { md: '01-06', name: 'Новогодние каникулы' },
      { md: '01-07', name: 'Рождество' },
      { md: '01-08', name: 'Новогодние каникулы' },
      { md: '02-23', name: 'День защитника Отечества' },
      { md: '03-08', name: 'Международный женский день' },
      { md: '05-01', name: 'Праздник Весны и Труда' },
      { md: '05-09', name: 'День Победы' },
      { md: '06-12', name: 'День России' },
      { md: '11-04', name: 'День народного единства' },
    ],
    // The government reshuffles working days around these every year.
    hasMovingDates: true,
  },
  {
    id: 'SA',
    labelKey: 'workcal.preset.SA',
    // Not an edge case — the whole reason the weekend is configurable.
    weekend: [5, 6],
    fixed: [{ md: '09-23', name: 'Saudi National Day' }],
    // Eid al-Fitr and Eid al-Adha follow the Hijri calendar.
    hasMovingDates: true,
  },
]

/** Expand a preset's fixed dates into `YYYY-MM-DD` for one year. */
export function presetDates(preset: HolidayPreset, year: number): IsoDate[] {
  return preset.fixed.map((h) => `${year}-${h.md}`)
}

/** The same, with the names the tables have carried all along. */
export function presetEntries(
  preset: HolidayPreset,
  year: number,
): Array<{ date: IsoDate; name: string }> {
  return preset.fixed.map((h) => ({ date: `${year}-${h.md}`, name: h.name }))
}

/**
 * Every year from `from` to `to` inclusive, clamped to `PRESET_MAX_YEARS`.
 *
 * Reversed inputs are accepted and sorted rather than returning nothing: a
 * range control where dragging the wrong end silently produces an empty result
 * is a control people press twice and then stop trusting.
 */
export function yearRange(from: number, to: number): number[] {
  const lo = Math.min(from, to)
  const hi = Math.min(Math.max(from, to), lo + PRESET_MAX_YEARS - 1)
  const out: number[] = []
  for (let y = lo; y <= hi; y++) out.push(y)
  return out
}

export function presetDatesRange(preset: HolidayPreset, from: number, to: number): IsoDate[] {
  return yearRange(from, to)
    .flatMap((y) => presetDates(preset, y))
    .sort()
}

/**
 * Merge a preset into an existing calendar.
 *
 * Additive for holidays — someone who has already pasted their own list should
 * not lose it — but the weekend is *replaced*, because it is a single fact
 * about where you work and unioning `[0,6]` with `[5,6]` would produce a
 * three-day weekend nobody has.
 *
 * Make-up workdays are left alone: no preset can supply them, and clearing the
 * ones the user entered by hand would be the worst possible response to
 * pressing "apply".
 */
export function applyPreset(
  calendar: WorkCalendar,
  preset: HolidayPreset,
  year: number,
): WorkCalendar {
  return applyPresetRange(calendar, preset, year, year)
}

/** `applyPreset` across a span of years — see `yearRange` for the clamp. */
export function applyPresetRange(
  calendar: WorkCalendar,
  preset: HolidayPreset,
  from: number,
  to: number,
): WorkCalendar {
  const holidays = [
    ...new Set([...calendar.holidays, ...presetDatesRange(preset, from, to)]),
  ].sort()
  return { ...calendar, weekend: [...preset.weekend].sort(), holidays }
}

/**
 * Take one year back out again.
 *
 * The gap this fills: applying CN in 2026 and again in 2027 left both years in
 * the list with no way to remove either — the only control was "Clear", which
 * wiped dates the user had typed by hand along with the generated ones. A year
 * is the unit people actually think in ("last year's holidays are clutter"),
 * and it is the unit the presets generate in.
 */
export function clearYear(
  calendar: WorkCalendar,
  year: number,
  lists: Array<'holidays' | 'workdays'> = ['holidays', 'workdays'],
): WorkCalendar {
  const prefix = `${year}-`
  const next = { ...calendar }
  for (const list of lists) next[list] = calendar[list].filter((d) => !d.startsWith(prefix))
  return next
}

/** Which years the calendar currently has any dates in, ascending. */
export function yearsInCalendar(calendar: WorkCalendar): number[] {
  const years = new Set<number>()
  for (const date of [...calendar.holidays, ...calendar.workdays]) {
    const year = Number(date.slice(0, 4))
    if (Number.isFinite(year) && year > 0) years.add(year)
  }
  return [...years].sort((a, b) => a - b)
}

/** How many dates of each list fall in a given year. */
export function countInYear(
  calendar: WorkCalendar,
  year: number,
): { holidays: number; workdays: number } {
  const prefix = `${year}-`
  return {
    holidays: calendar.holidays.filter((d) => d.startsWith(prefix)).length,
    workdays: calendar.workdays.filter((d) => d.startsWith(prefix)).length,
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * What to consult when naming a date, most specific first.
 *
 * `statutory` is an exact date → name map (the Chinese tables, which are per
 * date and unambiguous). `presetId` narrows the fixed-date lookup to one
 * country, which matters because 1 January and 1 May are named by five of the
 * six presets and blending them produces a chip nobody can read.
 */
export interface HolidayNameContext {
  presetId?: string
  statutory?: Map<IsoDate, string>
}

/**
 * The name of a holiday, or `undefined` when nothing knows one.
 *
 * `undefined` and not the date string: the caller already has the date, and a
 * function that returns its own input dressed up as an answer makes "we know
 * what this day is called" indistinguishable from "we do not".
 *
 * Without a `presetId` the lookup spans every preset and joins the distinct
 * names it finds, capped at two. That is deliberately a little untidy — it is
 * the honest rendering of "several countries call this date something, and
 * nothing here records which one you meant".
 */
export function holidayNameFor(iso: IsoDate, ctx: HolidayNameContext = {}): string | undefined {
  const exact = ctx.statutory?.get(iso)
  if (exact) return exact

  const md = iso.slice(5)
  if (md.length !== 5) return undefined

  if (ctx.presetId) {
    const preset = HOLIDAY_PRESETS.find((p) => p.id === ctx.presetId)
    return preset?.fixed.find((h) => h.md === md)?.name
  }

  const names: string[] = []
  for (const preset of HOLIDAY_PRESETS) {
    for (const holiday of preset.fixed) {
      if (holiday.md === md && !names.includes(holiday.name)) names.push(holiday.name)
    }
  }
  if (names.length === 0) return undefined
  return names.length > 2 ? `${names.slice(0, 2).join(' / ')}…` : names.join(' / ')
}
