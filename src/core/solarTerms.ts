/**
 * The 24 solar terms (二十四节气) — computed, not looked up.
 *
 * Unlike `cnHolidays.ts`'s statutory table, a solar term is pure astronomy:
 * the instant the sun's apparent ecliptic longitude crosses a multiple of 15°.
 * That is derivable from a handful of polynomial constants, so there is no
 * government notice to transcribe and no year the coverage simply stops —
 * `cnHolidays.ts`'s reason for a bundled table does not apply here.
 *
 * The polynomial is Meeus's low-precision solar position (*Astronomical
 * Algorithms*, ch. 25): mean longitude and mean anomaly as low-order
 * polynomials in Julian centuries since J2000, the equation of centre as a
 * three-term series in the mean anomaly, and a small nutation/aberration
 * correction so the result is the sun's *apparent* longitude — the quantity a
 * solar term is actually defined against, not the geometric mean position.
 * Good to roughly 0.01°, on the order of a minute of time, for centuries
 * either side of 2000 — comfortably inside the 1900-2100 range `cnHolidays.ts`
 * and `workCalendar.ts` already treat as this app's working span; see
 * `scripts/check-solarterms.mjs` for the check against published instants.
 *
 * This is used for exactly one thing: the runecircuit style's monthly colour
 * wash (`WorkCalendarView`'s `data-solar-term`, `theme.css`'s `--solarterm-*`
 * tokens). Nothing here reaches a reminder's schedule or `workCalendar.ts`'s
 * working-day logic, so a day of drift at the far edge of the range would cost
 * a tint one term early — never a wrong send date.
 */

export type SolarTermId =
  | 'lichun'
  | 'yushui'
  | 'jingzhe'
  | 'chunfen'
  | 'qingming'
  | 'guyu'
  | 'lixia'
  | 'xiaoman'
  | 'mangzhong'
  | 'xiazhi'
  | 'xiaoshu'
  | 'dashu'
  | 'liqiu'
  | 'chushu'
  | 'bailu'
  | 'qiufen'
  | 'hanlu'
  | 'shuangjiang'
  | 'lidong'
  | 'xiaoxue'
  | 'daxue'
  | 'dongzhi'
  | 'xiaohan'
  | 'dahan'

export interface SolarTermInstant {
  id: SolarTermId
  /** Epoch ms, UTC. */
  at: number
}

interface TermDef {
  id: SolarTermId
  /** Target solar longitude, degrees, 0 = the March equinox. */
  longitudeDeg: number
  /**
   * Newton's seed — this term's UTC calendar date most years, never more than
   * ~10 days off across 1900-2100. Only has to land the iteration in the right
   * neighbourhood; `solveForLongitude` does the rest.
   */
  guessMonth: number
  guessDay: number
}

/** Chronological within the calendar year, 小寒 through 冬至. */
const TERMS: TermDef[] = [
  { id: 'xiaohan', longitudeDeg: 285, guessMonth: 1, guessDay: 5 },
  { id: 'dahan', longitudeDeg: 300, guessMonth: 1, guessDay: 20 },
  { id: 'lichun', longitudeDeg: 315, guessMonth: 2, guessDay: 4 },
  { id: 'yushui', longitudeDeg: 330, guessMonth: 2, guessDay: 19 },
  { id: 'jingzhe', longitudeDeg: 345, guessMonth: 3, guessDay: 5 },
  { id: 'chunfen', longitudeDeg: 0, guessMonth: 3, guessDay: 20 },
  { id: 'qingming', longitudeDeg: 15, guessMonth: 4, guessDay: 5 },
  { id: 'guyu', longitudeDeg: 30, guessMonth: 4, guessDay: 20 },
  { id: 'lixia', longitudeDeg: 45, guessMonth: 5, guessDay: 5 },
  { id: 'xiaoman', longitudeDeg: 60, guessMonth: 5, guessDay: 21 },
  { id: 'mangzhong', longitudeDeg: 75, guessMonth: 6, guessDay: 5 },
  { id: 'xiazhi', longitudeDeg: 90, guessMonth: 6, guessDay: 21 },
  { id: 'xiaoshu', longitudeDeg: 105, guessMonth: 7, guessDay: 7 },
  { id: 'dashu', longitudeDeg: 120, guessMonth: 7, guessDay: 22 },
  { id: 'liqiu', longitudeDeg: 135, guessMonth: 8, guessDay: 7 },
  { id: 'chushu', longitudeDeg: 150, guessMonth: 8, guessDay: 23 },
  { id: 'bailu', longitudeDeg: 165, guessMonth: 9, guessDay: 7 },
  { id: 'qiufen', longitudeDeg: 180, guessMonth: 9, guessDay: 23 },
  { id: 'hanlu', longitudeDeg: 195, guessMonth: 10, guessDay: 8 },
  { id: 'shuangjiang', longitudeDeg: 210, guessMonth: 10, guessDay: 23 },
  { id: 'lidong', longitudeDeg: 225, guessMonth: 11, guessDay: 7 },
  { id: 'xiaoxue', longitudeDeg: 240, guessMonth: 11, guessDay: 22 },
  { id: 'daxue', longitudeDeg: 255, guessMonth: 12, guessDay: 7 },
  { id: 'dongzhi', longitudeDeg: 270, guessMonth: 12, guessDay: 22 },
]

const MS_PER_DAY = 86400000
const UNIX_EPOCH_JD = 2440587.5
// The tropical year expressed the other way round — degrees of solar motion
// per day — which is all Newton's method below needs as a slope.
const MEAN_RATE_DEG_PER_DAY = 360 / 365.2422

function toJulianDay(date: Date): number {
  return date.getTime() / MS_PER_DAY + UNIX_EPOCH_JD
}

function fromJulianDay(jd: number): Date {
  return new Date((jd - UNIX_EPOCH_JD) * MS_PER_DAY)
}

function normalizeDeg(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

/** Sun's apparent geocentric ecliptic longitude at Julian Day `jd`, in degrees. */
function sunApparentLongitudeDeg(jd: number): number {
  const T = (jd - 2451545.0) / 36525
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T
  const Mr = (M * Math.PI) / 180
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr)
  const trueLongitude = L0 + C
  // Nutation + aberration, folded into one small correction (Meeus §25) —
  // the difference between the sun's *true* and *apparent* longitude, which
  // is the one a solar term boundary is actually defined against.
  const omega = 125.04 - 1934.136 * T
  const apparent = trueLongitude - 0.00569 - 0.00478 * Math.sin((omega * Math.PI) / 180)
  return normalizeDeg(apparent)
}

/**
 * Newton's method on a slope that is nearly constant across the whole search
 * window (~0.9856°/day, varying by under 2% over a year) — eight steps
 * converge to well under a second, using the same closed-form longitude
 * function as the fixed point.
 */
function solveForLongitude(targetDeg: number, guessJd: number): number {
  let jd = guessJd
  for (let i = 0; i < 8; i++) {
    const longitude = sunApparentLongitudeDeg(jd)
    let diff = targetDeg - longitude
    // Shortest signed distance around the circle, so a guess just past 0°
    // chasing a target just before it moves backward by degrees, not forward
    // by 359.
    diff = ((((diff + 180) % 360) + 360) % 360) - 180
    jd += diff / MEAN_RATE_DEG_PER_DAY
  }
  return jd
}

/** The 24 instants for one calendar year, chronological (小寒 first, 冬至 last). */
export function termsForYear(year: number): SolarTermInstant[] {
  return TERMS.map((term) => {
    const guessJd = toJulianDay(new Date(Date.UTC(year, term.guessMonth - 1, term.guessDay)))
    const jd = solveForLongitude(term.longitudeDeg, guessJd)
    return { id: term.id, at: fromJulianDay(jd).getTime() }
  }).sort((a, b) => a.at - b.at)
}

/**
 * Which of the 24 terms is in effect at `date` — the latest instant that has
 * already passed. Pulls in the neighbouring years' tables too, not just
 * `date`'s own: a date in the first days of January is still under the
 * *previous* year's 冬至 until that year's own 小寒 arrives, and a table built
 * from `date.getFullYear()` alone would have nothing earlier to compare it to.
 */
export function activeSolarTerm(date: Date): SolarTermId {
  const year = date.getFullYear()
  const candidates = [...termsForYear(year - 1), ...termsForYear(year), ...termsForYear(year + 1)].sort(
    (a, b) => a.at - b.at,
  )

  const at = date.getTime()
  let active = candidates[0]
  for (const c of candidates) {
    if (c.at > at) break
    active = c
  }
  return active.id
}

/**
 * The term governing a displayed month, for the calendar screen's wash.
 * Anchored on the 15th at local noon — comfortably clear of a term boundary
 * landing on the 1st or the last day, which is the only way a single month
 * could plausibly disagree with "the term most of it sits in".
 */
export function activeSolarTermForMonth(year: number, month0: number): SolarTermId {
  return activeSolarTerm(new Date(year, month0, 15, 12))
}
