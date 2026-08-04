/**
 * Chinese statutory holidays and 调休 make-up workdays.
 *
 * These cannot be computed. Three of the seven holidays follow the lunar
 * calendar, and — more importantly — the *lengths* and the make-up workdays are
 * decided each year by a State Council notice, usually published in November
 * for the year after. There is no rule to implement. 2026's Spring Festival
 * runs nine days from 15 February and is paid for by working Saturday 14
 * February and Saturday 28 February; nothing about that is derivable from a
 * calendar, and an app that guessed would be confidently wrong on the exact
 * days it matters most.
 *
 * So the design here is deliberately unexciting, and every part of it exists to
 * avoid one specific way of lying to the user:
 *
 * 1. **A bundled table, transcribed from the notices.** Works with no network,
 *    forever. This is the primary source, not a fallback.
 * 2. **The table knows which years it covers.** Asking for 2027 today returns
 *    `undefined`, not an extrapolation — see `statutoryFor`. The screen says
 *    "not published yet" rather than filling in plausible dates.
 * 3. **Nothing is fetched unless the user presses the button.** No check on
 *    start-up, no background refresh. The URL that would be contacted is shown
 *    on screen before it is contacted. (The app's only other outbound
 *    connections are SMTP/IMAP and the opt-in GitHub release check.)
 * 4. **Fetched data is stamped and never mistaken for bundled data.** Every
 *    year carries where it came from and when, and the UI prints both. A cache
 *    entry that is older than the bundle for the same year loses.
 *
 * ## Why this feed
 *
 * `holiday-cn` republishes each 国务院办公厅 notice as JSON and records the
 * notice's own gov.cn URL in the file, so the provenance survives the trip.
 * gov.cn itself publishes prose in HTML — parsing a government press release
 * with a regular expression is precisely the kind of thing that works until the
 * year it does not, and it fails by producing *wrong dates* rather than none.
 */

import type { IsoDate, WorkCalendar } from './workCalendar'

export interface StatutoryDay {
  date: IsoDate
  /** As the notice names it — 春节, 国庆节… */
  name: string
  /** True for a day off; false for a 调休 make-up workday. */
  off: boolean
}

export type StatutorySource = 'bundled' | 'network'

export interface StatutoryYear {
  year: number
  days: StatutoryDay[]
  source: StatutorySource
  /** The State Council notice this was transcribed from, when known. */
  paper?: string
  /**
   * When this app obtained it. For the bundle that is the date it was
   * transcribed, so an old build cannot pass its table off as fresh.
   */
  obtainedAt: number
}

/** When the bundled tables below were transcribed and checked. */
export const BUNDLED_AT = Date.UTC(2026, 7, 4)

/**
 * 2025 and 2026, from the two notices named in `paper`.
 *
 * Kept as one flat list per year rather than as ranges: a range invites the
 * reader to assume the days between the ends are uniform, and in 2025 the
 * Spring Festival block genuinely skips 27 January.
 */
export const CN_BUNDLED: StatutoryYear[] = [
  {
    year: 2025,
    source: 'bundled',
    obtainedAt: BUNDLED_AT,
    paper: 'https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm',
    days: [
      { date: '2025-01-01', name: '元旦', off: true },
      { date: '2025-01-26', name: '春节', off: false },
      { date: '2025-01-28', name: '春节', off: true },
      { date: '2025-01-29', name: '春节', off: true },
      { date: '2025-01-30', name: '春节', off: true },
      { date: '2025-01-31', name: '春节', off: true },
      { date: '2025-02-01', name: '春节', off: true },
      { date: '2025-02-02', name: '春节', off: true },
      { date: '2025-02-03', name: '春节', off: true },
      { date: '2025-02-04', name: '春节', off: true },
      { date: '2025-02-08', name: '春节', off: false },
      { date: '2025-04-04', name: '清明节', off: true },
      { date: '2025-04-05', name: '清明节', off: true },
      { date: '2025-04-06', name: '清明节', off: true },
      { date: '2025-04-27', name: '劳动节', off: false },
      { date: '2025-05-01', name: '劳动节', off: true },
      { date: '2025-05-02', name: '劳动节', off: true },
      { date: '2025-05-03', name: '劳动节', off: true },
      { date: '2025-05-04', name: '劳动节', off: true },
      { date: '2025-05-05', name: '劳动节', off: true },
      { date: '2025-05-31', name: '端午节', off: true },
      { date: '2025-06-01', name: '端午节', off: true },
      { date: '2025-06-02', name: '端午节', off: true },
      { date: '2025-09-28', name: '国庆节、中秋节', off: false },
      { date: '2025-10-01', name: '国庆节、中秋节', off: true },
      { date: '2025-10-02', name: '国庆节、中秋节', off: true },
      { date: '2025-10-03', name: '国庆节、中秋节', off: true },
      { date: '2025-10-04', name: '国庆节、中秋节', off: true },
      { date: '2025-10-05', name: '国庆节、中秋节', off: true },
      { date: '2025-10-06', name: '国庆节、中秋节', off: true },
      { date: '2025-10-07', name: '国庆节、中秋节', off: true },
      { date: '2025-10-08', name: '国庆节、中秋节', off: true },
      { date: '2025-10-11', name: '国庆节、中秋节', off: false },
    ],
  },
  {
    year: 2026,
    source: 'bundled',
    obtainedAt: BUNDLED_AT,
    paper: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
    days: [
      { date: '2026-01-01', name: '元旦', off: true },
      { date: '2026-01-02', name: '元旦', off: true },
      { date: '2026-01-03', name: '元旦', off: true },
      { date: '2026-01-04', name: '元旦', off: false },
      { date: '2026-02-14', name: '春节', off: false },
      { date: '2026-02-15', name: '春节', off: true },
      { date: '2026-02-16', name: '春节', off: true },
      { date: '2026-02-17', name: '春节', off: true },
      { date: '2026-02-18', name: '春节', off: true },
      { date: '2026-02-19', name: '春节', off: true },
      { date: '2026-02-20', name: '春节', off: true },
      { date: '2026-02-21', name: '春节', off: true },
      { date: '2026-02-22', name: '春节', off: true },
      { date: '2026-02-23', name: '春节', off: true },
      { date: '2026-02-28', name: '春节', off: false },
      { date: '2026-04-04', name: '清明节', off: true },
      { date: '2026-04-05', name: '清明节', off: true },
      { date: '2026-04-06', name: '清明节', off: true },
      { date: '2026-05-01', name: '劳动节', off: true },
      { date: '2026-05-02', name: '劳动节', off: true },
      { date: '2026-05-03', name: '劳动节', off: true },
      { date: '2026-05-04', name: '劳动节', off: true },
      { date: '2026-05-05', name: '劳动节', off: true },
      { date: '2026-05-09', name: '劳动节', off: false },
      { date: '2026-06-19', name: '端午节', off: true },
      { date: '2026-06-20', name: '端午节', off: true },
      { date: '2026-06-21', name: '端午节', off: true },
      { date: '2026-09-20', name: '国庆节', off: false },
      { date: '2026-09-25', name: '中秋节', off: true },
      { date: '2026-09-26', name: '中秋节', off: true },
      { date: '2026-09-27', name: '中秋节', off: true },
      { date: '2026-10-01', name: '国庆节', off: true },
      { date: '2026-10-02', name: '国庆节', off: true },
      { date: '2026-10-03', name: '国庆节', off: true },
      { date: '2026-10-04', name: '国庆节', off: true },
      { date: '2026-10-05', name: '国庆节', off: true },
      { date: '2026-10-06', name: '国庆节', off: true },
      { date: '2026-10-07', name: '国庆节', off: true },
      { date: '2026-10-10', name: '国庆节', off: false },
    ],
  },
]

export const CN_BUNDLED_YEARS = CN_BUNDLED.map((y) => y.year)

/** The host the refresh button contacts. Shown on screen before it is used. */
export const CN_FEED_HOST = 'raw.githubusercontent.com'

export function cnFeedUrl(year: number): string {
  return `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`
}

// ---------------------------------------------------------------------------
// Parsing a fetched year
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Read the feed's JSON into a `StatutoryYear`, or say why not.
 *
 * Treated as hostile input, because it is: it arrives over the network from a
 * repository this project does not control. A payload that is the wrong year,
 * or that contains one bad date, must not become a calendar entry — every date
 * that survives is a day some reminder will or will not be sent on.
 */
export function parseStatutoryPayload(
  payload: unknown,
  expectedYear: number,
  at: number,
): { year: StatutoryYear } | { error: string; unpublished?: boolean } {
  if (typeof payload !== 'object' || payload === null) return { error: 'not an object' }
  const record = payload as Record<string, unknown>

  if (typeof record.year === 'number' && record.year !== expectedYear) {
    return { error: `the file is for ${record.year}, not ${expectedYear}` }
  }
  if (!Array.isArray(record.days)) return { error: 'no days array' }

  const days: StatutoryDay[] = []
  let rejected = 0
  for (const entry of record.days) {
    if (typeof entry !== 'object' || entry === null) {
      rejected++
      continue
    }
    const day = entry as Record<string, unknown>
    const date = typeof day.date === 'string' ? day.date.trim() : ''
    if (!ISO_RE.test(date) || !date.startsWith(`${expectedYear}-`)) {
      rejected++
      continue
    }
    if (typeof day.isOffDay !== 'boolean') {
      rejected++
      continue
    }
    days.push({
      date,
      name: typeof day.name === 'string' && day.name.trim() ? day.name.trim() : String(expectedYear),
      off: day.isOffDay,
    })
  }

  if (days.length === 0) {
    // Not a parse failure, and it must not read like one. `holiday-cn` commits
    // a placeholder for the coming year — `{"year": 2027, "days": []}`, served
    // as a perfectly good 200 — as soon as the file exists, months before the
    // State Council publishes the notice that fills it. Reporting that as
    // "no usable dates in the file" is technically true and tells the reader
    // their app is broken, when the honest answer is that nobody has decided
    // 2027's holidays yet.
    if (rejected === 0) return { error: 'not published yet', unpublished: true }
    return { error: 'no usable dates in the file' }
  }
  // A year with no make-up workdays at all has never happened, and it is the
  // shape a half-parsed file takes. Better to refuse than to install a calendar
  // that is missing every 调休 day.
  if (!days.some((d) => !d.off)) return { error: 'no make-up workdays — the file looks incomplete' }
  if (rejected > days.length) return { error: `${rejected} unreadable entries` }

  days.sort((a, b) => a.date.localeCompare(b.date))
  const papers = Array.isArray(record.papers) ? record.papers.filter((p) => typeof p === 'string') : []

  return {
    year: {
      year: expectedYear,
      days,
      source: 'network',
      paper: papers[0] as string | undefined,
      obtainedAt: at,
    },
  }
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

const CACHE_KEY = 'aevistle.cn-holidays.v1'

/**
 * Where a fetched year is kept.
 *
 * `localStorage`, not `Settings`, and that is a compromise rather than a
 * preference: `Settings` lives in `core/types.ts`, which this change was not
 * allowed to touch. The consequence is real and worth knowing — a fetched table
 * does not travel in a backup or to another device, so the app falls back to
 * the bundle there. See the report accompanying this change.
 */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Blocked by a privacy setting. Not fatal; the bundle still works.
    return null
  }
}

export function loadCachedYears(): StatutoryYear[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(CACHE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (y): y is StatutoryYear =>
        typeof y === 'object' &&
        y !== null &&
        typeof (y as StatutoryYear).year === 'number' &&
        Array.isArray((y as StatutoryYear).days),
    )
  } catch {
    return []
  }
}

export function saveCachedYear(year: StatutoryYear): void {
  const store = storage()
  if (!store) return
  const kept = loadCachedYears().filter((y) => y.year !== year.year)
  try {
    store.setItem(CACHE_KEY, JSON.stringify([...kept, year].sort((a, b) => a.year - b.year)))
  } catch {
    // Quota, or a private window. The year still applies for this session.
  }
}

export function clearCachedYears(): void {
  storage()?.removeItem(CACHE_KEY)
}

/**
 * The table for one year, or `undefined` when there genuinely is not one.
 *
 * `undefined` is the whole point. Asking for a year the State Council has not
 * announced returns nothing, and the caller has to say so — the alternative
 * (repeating last year's dates, or synthesising from the lunar calendar) is a
 * calendar that looks authoritative and is wrong.
 */
export function statutoryFor(year: number, cached = loadCachedYears()): StatutoryYear | undefined {
  const fromCache = cached.find((y) => y.year === year)
  const fromBundle = CN_BUNDLED.find((y) => y.year === year)
  if (fromCache && fromBundle) {
    // A cache entry only wins if it is actually newer than the transcription.
    return fromCache.obtainedAt >= fromBundle.obtainedAt ? fromCache : fromBundle
  }
  return fromCache ?? fromBundle
}

/** Every year anything is known about, ascending. */
export function knownYears(cached = loadCachedYears()): number[] {
  return [...new Set([...CN_BUNDLED_YEARS, ...cached.map((y) => y.year)])].sort((a, b) => a - b)
}

/** Split a year's table into the two lists a `WorkCalendar` holds. */
export function statutoryToCalendarDates(year: StatutoryYear): {
  holidays: IsoDate[]
  workdays: IsoDate[]
} {
  return {
    holidays: year.days.filter((d) => d.off).map((d) => d.date).sort(),
    workdays: year.days.filter((d) => !d.off).map((d) => d.date).sort(),
  }
}

/** Merge one year's statutory table into a calendar. Additive, never destructive. */
export function applyStatutoryYear(calendar: WorkCalendar, year: StatutoryYear): WorkCalendar {
  const { holidays, workdays } = statutoryToCalendarDates(year)
  return {
    ...calendar,
    holidays: [...new Set([...calendar.holidays, ...holidays])].sort(),
    workdays: [...new Set([...calendar.workdays, ...workdays])].sort(),
  }
}

/** Name lookup across every year known, for the chips and the grid tooltips. */
export function statutoryNames(cached = loadCachedYears()): Map<IsoDate, string> {
  const out = new Map<IsoDate, string>()
  for (const year of knownYears(cached)) {
    const table = statutoryFor(year, cached)
    if (!table) continue
    for (const day of table.days) out.set(day.date, day.name)
  }
  return out
}

// ---------------------------------------------------------------------------
// The network call — only ever from an explicit press
// ---------------------------------------------------------------------------

export interface FetchOutcome {
  year?: StatutoryYear
  error?: string
  /**
   * The feed answered, and the answer is "this year does not exist yet".
   *
   * Kept apart from `error` because the screen has a sentence for this already
   * — the same one the row shows before the button is pressed — and because it
   * is not a failure of anything. A 404 and a published-but-empty file are the
   * same fact wearing two shapes.
   */
  unpublished?: boolean
}

/**
 * Ask the feed for one year.
 *
 * Never called on a timer, on start-up, or as a side effect of anything else.
 * The caller is a button, and the screen next to that button names the host it
 * contacts before it is pressed.
 */
export async function fetchStatutoryYear(
  year: number,
  opts: { now?: number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchOutcome> {
  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  if (!doFetch) return { error: 'no network stack available' }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
    : undefined

  try {
    const response = await doFetch(cnFeedUrl(year), {
      signal: controller?.signal,
      // No credentials, no cookies, no referrer. This is a public JSON file and
      // the request should carry nothing that identifies the reader.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      if (response.status === 404) return { error: 'not published yet', unpublished: true }
      return { error: `the server answered ${response.status}` }
    }
    const payload: unknown = await response.json()
    const parsed = parseStatutoryPayload(payload, year, opts.now ?? Date.now())
    return 'error' in parsed
      ? { error: parsed.error, unpublished: parsed.unpublished }
      : { year: parsed.year }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'the request failed' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
