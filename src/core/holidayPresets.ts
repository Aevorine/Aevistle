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
  const holidays = [...new Set([...calendar.holidays, ...presetDates(preset, year)])].sort()
  return { ...calendar, weekend: [...preset.weekend].sort(), holidays }
}
