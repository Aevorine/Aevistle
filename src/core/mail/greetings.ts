/**
 * Which holidays a greeting would be written for, and to whom.
 *
 * **This module plans. It never creates anything, and it certainly never
 * sends.** That separation is the whole feature. A tool that quietly produced
 * outgoing mail on a date it worked out for itself would be the mirror image of
 * the failure this application exists to avoid: the daily send cap was left
 * unimplemented because "悄悄不发" — silently not sending — is the worst thing a
 * reminder app can do, and silently *sending* is the same sin with the sign
 * flipped. So the flow is: plan here, show the plan, let the user press the
 * button, and put ordinary visible scheduled jobs in the schedule where they
 * can be read, edited and cancelled like anything else.
 *
 * Names matter here in a way they do not elsewhere. A greeting has to say what
 * it is greeting, so a date alone is useless and this module refuses to invent
 * one:
 *
 *   - **China** comes from `cnHolidays.ts` — the transcribed State Council
 *     tables, which carry 春节 / 国庆节 and the 调休 make-up days, and which
 *     return *nothing* for a year nobody has announced yet. When the year is
 *     unannounced this falls back to the fixed-date preset and says so in
 *     `source`, rather than extrapolating last year's lunar dates.
 *   - **Everywhere else** comes from `holidayPresets.ts`, which is fixed-date
 *     only by design. Easter, the Hijri calendar and the nth-Monday rules are
 *     not in there and are not guessed; `HolidayPreset.hasMovingDates` is
 *     carried through so the screen can say what is missing.
 *
 * Consecutive days that share a name are one occasion, not seven. National Day
 * running 1–7 October is one greeting on the 1st; a recipient who gets seven
 * identical messages in a week has been spammed by a feature meant to be kind.
 */

import { loadCachedYears, statutoryFor, type StatutoryYear } from '../schedule/cnHolidays'
import {
  HOLIDAY_PRESETS,
  presetEntries,
  type HolidayPreset,
} from '../schedule/holidayPresets'
import {
  addIsoDays,
  isWorkingDayIso,
  parseIsoDate,
  DEFAULT_WORK_CALENDAR,
  type IsoDate,
  type WorkCalendar,
} from '../schedule/workCalendar'

/** The countries a greeting can be planned for — the preset ids, nothing invented. */
export const GREETING_COUNTRIES: string[] = HOLIDAY_PRESETS.map((p) => p.id)

/** When a greeting goes out, unless the caller says otherwise. */
export const DEFAULT_GREETING_TIME = '09:00'

export interface GreetingRecipient {
  address: string
  /** For `{{name}}`; not required, and never fabricated from the address here. */
  name?: string
  /** A `HOLIDAY_PRESETS` id. Blank or unknown falls back to `defaultCountry`. */
  country?: string
}

/**
 * `statutory` — a named government table for that exact date.
 * `preset` — the country's fixed-date list, which is all this app can promise
 * for a year (or a country) with no published table.
 */
export type GreetingSource = 'statutory' | 'preset'

export interface GreetingOccasion {
  /** Stable across runs, so a plan shown twice is the same plan. */
  key: string
  date: IsoDate
  /** As the source names it. Never derived, never translated. */
  name: string
  country: string
  source: GreetingSource
  /** True when this country's calendar has parts that move and are not here. */
  hasMovingDates: boolean
  /** The instant a greeting would leave, from the requested time of day. */
  at: number
  /** Whether that date is a working day on *your* calendar. Information, not a filter. */
  yourWorkingDay: boolean
  recipients: GreetingRecipient[]
}

export interface GreetingOptions {
  now?: number
  /** For `yourWorkingDay`. Defaults to the plain Saturday/Sunday calendar. */
  calendar?: WorkCalendar
  /** 'HH:mm', local. */
  timeOfDay?: string
  /** Used for a recipient whose own country is missing or unrecognised. */
  defaultCountry?: string
  /** Injected by the guard; production reads the localStorage cache. */
  statutoryCache?: StatutoryYear[]
}

function presetFor(country: string): HolidayPreset | undefined {
  return HOLIDAY_PRESETS.find((p) => p.id === country)
}

function timeAt(date: IsoDate, timeOfDay: string): number {
  const day = parseIsoDate(date)
  if (Number.isNaN(day.getTime())) return NaN
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay.trim())
  const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 9
  const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0
  day.setHours(hh, mm, 0, 0)
  return day.getTime()
}

/**
 * Collapse a date-sorted list into one entry per run of consecutive same-named
 * days, keeping the first date of each run.
 *
 * Runs, not "first occurrence of each name": Russia's New Year block is
 * 2–6 January, then Christmas on the 7th, then the block again on the 8th, and
 * those really are two separate stretches of the same holiday.
 */
function collapseRuns(
  days: Array<{ date: IsoDate; name: string }>,
): Array<{ date: IsoDate; name: string }> {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date))
  const out: Array<{ date: IsoDate; name: string }> = []
  // The day *seen last*, not the run's first day — a run is contiguous with its
  // own previous member, and comparing against the start would break every run
  // longer than two days.
  let previous: { date: IsoDate; name: string } | null = null
  for (const day of sorted) {
    const sameRun =
      previous !== null &&
      previous.name === day.name &&
      (previous.date === day.date || addIsoDays(previous.date, 1) === day.date)
    if (!sameRun) out.push(day)
    previous = day
  }
  return out
}

/**
 * One country's holidays for one year, named.
 *
 * Returns an empty list rather than a guess when nothing knows: a greeting the
 * app cannot name is a greeting it should not offer to write.
 */
export function holidaysForCountry(
  country: string,
  year: number,
  opts: { statutoryCache?: StatutoryYear[] } = {},
): Array<{ date: IsoDate; name: string; source: GreetingSource }> {
  const preset = presetFor(country)
  if (!preset) return []

  if (country === 'CN') {
    const table = statutoryFor(year, opts.statutoryCache ?? loadCachedYears())
    if (table) {
      // Days off only. A 调休 make-up workday is a *working* Saturday, and
      // wishing somebody a happy make-up workday is not a feature.
      const off = table.days.filter((d) => d.off).map((d) => ({ date: d.date, name: d.name }))
      return collapseRuns(off).map((d) => ({ ...d, source: 'statutory' as const }))
    }
    // No published table for this year. Fall through to the fixed dates, which
    // is strictly less than the truth and is labelled as such.
  }

  return collapseRuns(presetEntries(preset, year)).map((d) => ({
    ...d,
    source: 'preset' as const,
  }))
}

/**
 * What a greeting run would produce, for review.
 *
 * Only future instants: a plan that offers to schedule last February is a plan
 * whose first row is wrong, and the user stops reading the rest.
 */
export function planGreetings(
  recipients: GreetingRecipient[],
  year: number,
  opts: GreetingOptions = {},
): GreetingOccasion[] {
  const now = opts.now ?? Date.now()
  const calendar = opts.calendar ?? DEFAULT_WORK_CALENDAR
  const timeOfDay = opts.timeOfDay ?? DEFAULT_GREETING_TIME
  const fallback = opts.defaultCountry ?? ''

  /** country → the people in it. Blank/unknown countries fold into the default. */
  const byCountry = new Map<string, GreetingRecipient[]>()
  for (const person of recipients) {
    if (!person.address.trim()) continue
    const asked = (person.country ?? '').trim().toUpperCase()
    const country = presetFor(asked) ? asked : fallback.trim().toUpperCase()
    if (!presetFor(country)) continue
    const list = byCountry.get(country)
    if (list) list.push(person)
    else byCountry.set(country, [person])
  }

  const out: GreetingOccasion[] = []
  for (const [country, people] of byCountry) {
    const preset = presetFor(country)
    for (const holiday of holidaysForCountry(country, year, {
      statutoryCache: opts.statutoryCache,
    })) {
      const at = timeAt(holiday.date, timeOfDay)
      if (!Number.isFinite(at) || at <= now) continue
      out.push({
        key: `${country}:${holiday.date}`,
        date: holiday.date,
        name: holiday.name,
        country,
        source: holiday.source,
        hasMovingDates: preset?.hasMovingDates ?? false,
        at,
        yourWorkingDay: isWorkingDayIso(holiday.date, calendar),
        recipients: people,
      })
    }
  }

  return out.sort((a, b) => a.at - b.at || a.country.localeCompare(b.country))
}

/**
 * The id a greeting job gets.
 *
 * Deterministic, and that is the point: pressing "create" twice must overwrite
 * the same reminder rather than schedule the holiday again. A duplicate here is
 * two identical mails to the same person on the same morning, which the
 * recipient reads as a broken sender.
 */
export function greetingJobId(occasion: Pick<GreetingOccasion, 'country' | 'date'>): string {
  return `job_greet_${occasion.country}_${occasion.date}`
}

/**
 * Holiday names by date, for `{{holiday}}` at send time.
 *
 * `mergeVars.calendarVars` looks a date up in a map and renders an empty string
 * when it misses — which is right for an ordinary Tuesday and wrong for a
 * greeting whose entire subject line is the holiday's name. Before this the map
 * held the Chinese tables and nothing else, so `{{holiday}}` was empty for
 * every non-Chinese recipient the moment the feature was used.
 *
 * `prefer` decides the shared dates. 1 January and 1 May are named by five of
 * the six presets and only one name can win; the country the user configured is
 * the least surprising answer, and a date unique to one country (14 July,
 * 23 September) resolves to that country regardless.
 */
export function holidayNameMap(opts: {
  years: number[]
  prefer?: string
  statutoryCache?: StatutoryYear[]
}): Map<IsoDate, string> {
  const names = new Map<IsoDate, string>()

  // The named government tables first — they are per date and unambiguous, and
  // nothing below is allowed to overwrite them.
  for (const year of opts.years) {
    const table = statutoryFor(year, opts.statutoryCache ?? loadCachedYears())
    if (!table) continue
    for (const day of table.days) if (day.off) names.set(day.date, day.name)
  }

  const preferred = (opts.prefer ?? '').trim().toUpperCase()
  const ordered = [
    ...HOLIDAY_PRESETS.filter((p) => p.id === preferred),
    ...HOLIDAY_PRESETS.filter((p) => p.id !== preferred),
  ]
  for (const preset of ordered) {
    for (const year of opts.years) {
      for (const entry of presetEntries(preset, year)) {
        if (!names.has(entry.date)) names.set(entry.date, entry.name)
      }
    }
  }

  return names
}

/** The years a name map should cover around an instant: last, this, next. */
export function greetingYears(now = Date.now()): number[] {
  const year = new Date(now).getFullYear()
  return [year - 1, year, year + 1]
}
