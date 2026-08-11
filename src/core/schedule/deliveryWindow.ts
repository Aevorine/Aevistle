/**
 * Delivery windows — landing a scheduled send inside the **recipient's**
 * working hours, in the **recipient's** time zone.
 *
 * Everything else in this codebase that moves a send around does it in the
 * sender's clock: `applyQuietHours` is the sender's night, `applyWorkCalendar`
 * is the sender's working week. That is fine while both ends of the message
 * live in the same country and wrong the moment they do not — "every Monday at
 * 09:00" written in Shanghai arrives at 03:00 in Los Angeles, which is the one
 * hour of the week nobody reads mail.
 *
 * Like the other two, this rewrites the *fire time*, not the send. The desktop
 * timer and the Android alarm both simply receive a different timestamp, and
 * neither native scheduler learns the feature exists.
 *
 * ## Where it sits in the pipeline
 *
 *   1. `computeOccurrences`          — the rule
 *   2. `applyWorkCalendarDetailed`   — the sender's working days
 *   3. `applyQuietHours`             — the sender's night
 *   4. `applyDeliveryWindows`        — **the recipient's day (this file)**
 *
 * Last, and it wins where the stages disagree. Two reasons, and the second one
 * is not optional:
 *
 * - Quiet hours are a *proxy* for "do not ping anyone in the middle of the
 *   night", expressed in the only zone the application used to know. Once a
 *   real recipient zone is on file, the window is the better-informed answer to
 *   the same question, so it supersedes the proxy.
 * - Running quiet hours *after* the window would push the send straight back
 *   out of the window it was just moved into. The two constraints would fight,
 *   quiet hours would always win because they run last, and B3 would silently
 *   do nothing. So quiet hours are **not** re-applied afterwards, and a send
 *   released into the recipient's morning may well be inside the sender's
 *   night. That is the feature working, not a bug — `check:window` asserts it
 *   explicitly so nobody "fixes" it.
 *
 * ## One message, several recipients
 *
 * A message with four addresses in `To:` is physically one send at one instant,
 * so "the first instant that satisfies everyone" has to exist as an answer —
 * and for a New Zealand / California pair inside an ordinary 09:00–12:00
 * window, it does not exist at all.
 *
 * The way out already exists in this codebase: `MessageDraft.individualDelivery`
 * and `buildMergeMessages` both already expand one draft into one message per
 * recipient. So **per-recipient is the answer**, and `DeliveryWindowResult`
 * carries `perRecipient` — one landing for every window handed in, always, even
 * when they agree. The joint instant is computed too (as `at`), because a draft
 * that is *not* being split still needs a single number, and because a caller
 * has to be able to tell the user why splitting is necessary. `splitRequired`
 * says exactly that.
 *
 * Nothing is ever dropped. A window that cannot be satisfied inside the search
 * horizon is reported as `impossible` and the send keeps its original instant —
 * mirroring `CalendarAdjustment.dropped` in `workCalendar.ts`, except that here
 * even the drop does not happen: a late message is a nuisance, a message that
 * never goes out is the failure this application exists to prevent.
 *
 * ## Time zones, without a time-zone library
 *
 * This app ships no runtime dependency beyond mail and sanitising, so the only
 * tool available is `Intl.DateTimeFormat` with a `timeZone` and
 * `formatToParts`. That direction — instant → wall clock in a zone — is exact
 * and cheap. The other direction is the hard one and is handled in
 * `instantForWallClock`; read the comment there before touching it.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface DeliveryWindow {
  /** IANA zone, e.g. `Asia/Shanghai`. Empty means "the sender's own zone". */
  timeZone: string
  /** Local wall-clock start, `HH:MM`. Inclusive. */
  from: string
  /** Local wall-clock end, `HH:MM`. Exclusive; `24:00` is accepted for midnight. */
  to: string
  /**
   * Which local weekdays count. 0 = Sunday, matching `Date#getDay`.
   *
   * For a window that spans midnight this names the day the window *opens*:
   * a 22:00→06:00 window on `days: [5]` runs from Friday evening into Saturday
   * morning, which is what "Friday night" means to everyone who is not a
   * computer.
   */
  days: number[]
}

/** Business hours, Monday to Friday, in whatever zone the sender is in. */
export const DEFAULT_DELIVERY_WINDOW: DeliveryWindow = {
  timeZone: '',
  from: '09:00',
  to: '18:00',
  days: [1, 2, 3, 4, 5],
}

/**
 * The field this feature needs on a contact.
 *
 * `core/types.ts` is owned elsewhere, so the shape is declared here and the
 * one-line addition to `Contact` is listed in the task report rather than made
 * here. `undefined` means "no window", which is what every existing contact
 * means and must keep meaning.
 */
export interface HasDeliveryWindow {
  deliveryWindow?: DeliveryWindow
}

/**
 * How far ahead a window is searched before the answer becomes "there isn't
 * one".
 *
 * Two weeks. An ordinary Mon–Fri window always opens within three days, so the
 * only things this bound ever catches are genuine impossibilities: a window
 * whose zones cannot overlap, or a `days` list that has been whittled down to
 * nothing useful. Long enough that a public holiday is not mistaken for one;
 * short enough that "impossible" arrives while the user is still looking at the
 * screen that caused it.
 */
export const DELIVERY_HORIZON_DAYS = 14

/**
 * Why a send is where it is. Structured, never prose: the words are i18n keys
 * chosen by the view layer, which is the only layer that knows the language.
 */
export type DeliveryWindowReason =
  /** No windows were supplied at all — nothing to honour, nothing was done. */
  | 'noWindows'
  /** The instant was already inside every window. */
  | 'inside'
  /** Moved forward to an opening later on the same local day. */
  | 'opensLater'
  /** Moved forward to the next local day the window opens on. */
  | 'nextOpenDay'
  /** No single instant inside the horizon satisfies every window at once. */
  | 'noCommonInstant'
  /** This window can never open: no valid weekday, or `from` equals `to`. */
  | 'neverOpens'
  /** The stored zone id is not a zone this device knows. */
  | 'unknownZone'
  /** `from` or `to` is not a readable `HH:MM`. */
  | 'malformed'
  /** The window is well-formed but does not open inside the horizon. */
  | 'outOfHorizon'

/** What a window is wrong about, or `null` when it is usable. */
export type DeliveryWindowFault = 'unknownZone' | 'malformed' | 'neverOpens'

export interface DeliveryWindowLanding {
  /** Position in the `windows` array handed in, so the caller can match it up. */
  index: number
  outcome: 'unchanged' | 'moved' | 'impossible' | 'ignored'
  reason: DeliveryWindowReason
  /** When this recipient's own copy should go out. Always finite, never null. */
  at: number
  /** What it would have been. */
  from: number
  /** The zone actually used — the resolved sender zone when `timeZone` was empty. */
  timeZone: string
}

/**
 * What a send time becomes once every recipient's window is honoured, and why.
 *
 * `at` is always a real instant. `outcome: 'impossible'` means the windows
 * could not be honoured, *not* that the message was cancelled — `at` is then
 * the original instant and the send still happens.
 */
export interface DeliveryWindowResult {
  outcome: 'unchanged' | 'moved' | 'impossible'
  reason: DeliveryWindowReason
  /** The instant to send at if the draft goes out as one message. */
  at: number
  /** The instant it was before this ran. */
  from: number
  /** One landing per input window, same order, always the same length. */
  perRecipient: DeliveryWindowLanding[]
  /**
   * True when a single send cannot serve everyone as well as separate sends
   * would — either because no joint instant exists, or because holding
   * everyone to the joint instant makes at least one recipient wait longer
   * than their own window requires.
   *
   * The cure is `MessageDraft.individualDelivery`, which this codebase already
   * implements; see the header.
   */
  splitRequired: boolean
  /**
   * Index of the window that decided the joint instant — the recipient the
   * send is waiting on. `undefined` when nothing moved.
   */
  boundBy?: number
  /** How far ahead this looked, so an `impossible` can be read as bounded. */
  horizonDays: number
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * Formatters are expensive to construct and this module builds a wall clock
 * several times per candidate instant, so they are cached per zone. `null` is
 * cached too: a garbage zone id out of an import would otherwise pay for a
 * thrown `RangeError` on every single occurrence.
 */
const formatters = new Map<string, Intl.DateTimeFormat | null>()

/**
 * `en-US` is passed explicitly rather than left to the default locale.
 *
 * On a machine whose locale carries a non-Gregorian calendar — `th-TH` defaults
 * to the Buddhist era — the default formatter reports year 2569 for 2026, and
 * every date computed from it is 543 years out. The zone is the variable here;
 * the calendar must not be.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, which in some engines renders
 * midnight as hour 24.
 */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone)
  if (cached !== undefined) return cached
  let made: Intl.DateTimeFormat | null = null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    made = null
  }
  formatters.set(zone, made)
  return made
}

/**
 * Is this a zone identifier this device can actually use?
 *
 * **Constructing a formatter is the test, not `Intl.supportedValuesOf`.** That
 * list contains only *canonical* zone ids, so `Asia/Calcutta`, `US/Pacific` and
 * `Europe/Kiev` — all perfectly valid, all still emitted by real systems and
 * still sitting in real address books — are absent from it. Validating against
 * the list would reject working zones and hold their owners' mail. The list is
 * for building a picker; this function is for deciding.
 */
export function isValidTimeZone(zone: string): boolean {
  const id = String(zone ?? '').trim()
  if (!id) return false
  return formatterFor(id) !== null
}

/** The zone list for a picker, or `[]` where the runtime predates it. */
export function knownTimeZones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  if (typeof supported !== 'function') return []
  try {
    return supported('timeZone')
  } catch {
    return []
  }
}

/** The zone the sender's device is in. */
export function senderTimeZone(): string {
  try {
    const id = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (id && formatterFor(id) !== null) return id
  } catch {
    /* fall through */
  }
  return 'UTC'
}

/**
 * The zone a window actually uses: its own, the sender's when it is empty, or
 * `null` when the stored string is not a zone at all.
 */
export function resolveTimeZone(zone: string): string | null {
  const id = String(zone ?? '').trim()
  if (!id) return senderTimeZone()
  return formatterFor(id) === null ? null : id
}

// ---------------------------------------------------------------------------
// Instant → wall clock
// ---------------------------------------------------------------------------

export interface WallClock {
  year: number
  /** 1–12. */
  month: number
  /** 1–31. */
  day: number
  /** 0 = Sunday, matching `Date#getDay`. */
  weekday: number
  /** Minutes since local midnight, 0–1439. */
  minutes: number
  second: number
}

/**
 * `Date.UTC` maps years 0–99 onto 1900–1999. Nothing here schedules mail in the
 * first century, but the two-digit trap is exactly the kind of thing that turns
 * up years later in an imported file, and `setUTCFullYear` costs nothing.
 * `minutes` may exceed 1439 on purpose — that is how `to: '24:00'` becomes the
 * following midnight.
 */
function utcFromCivil(year: number, month: number, day: number, minutes = 0, second = 0): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(0, minutes, second, 0)
  return d.getTime()
}

/** Weekday of a civil date. Pure calendar arithmetic — no zone is involved. */
function civilWeekday(year: number, month: number, day: number): number {
  return new Date(utcFromCivil(year, month, day)).getUTCDay()
}

/** Read a UTC instant as wall-clock time in `zone`. `null` for an unknown zone. */
export function wallClockIn(at: number, timeZone: string): WallClock | null {
  if (!Number.isFinite(at)) return null
  const zone = resolveTimeZone(timeZone)
  if (zone === null) return null
  const fmt = formatterFor(zone)
  if (fmt === null) return null

  let year = NaN
  let month = NaN
  let day = NaN
  let hour = NaN
  let minute = NaN
  let second = 0
  for (const part of fmt.formatToParts(new Date(at))) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      case 'hour':
        hour = Number(part.value)
        break
      case 'minute':
        minute = Number(part.value)
        break
      case 'second':
        second = Number(part.value)
        break
      default:
        break
    }
  }
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null
  // Belt and braces: `hourCycle: 'h23'` should never produce 24, but an engine
  // that does would otherwise shift midnight a whole day.
  if (hour === 24) hour = 0

  return {
    year,
    month,
    day,
    weekday: civilWeekday(year, month, day),
    minutes: hour * 60 + minute,
    second,
  }
}

/** The zone's UTC offset, in ms, at a given instant. `null` for an unknown zone. */
export function zoneOffsetAt(at: number, timeZone: string): number | null {
  const wall = wallClockIn(at, timeZone)
  if (wall === null) return null
  const asUtc = utcFromCivil(wall.year, wall.month, wall.day, wall.minutes, wall.second)
  return asUtc - Math.floor(at / 1000) * 1000
}

function offsetOf(at: number, zone: string): number {
  return zoneOffsetAt(at, zone) ?? 0
}

/**
 * The first instant in `(lo, hi]` at which the zone's offset differs from the
 * one in force at `lo`, or `null` when it never does.
 *
 * Bisection, on whole seconds throughout. `Intl` reports wall clocks to the
 * second, so a sub-second bisection cannot distinguish anything and would
 * return whichever *probe* happened to straddle the change rather than the
 * change itself — a transition landing on `16:30:00.218Z`, which is not a time
 * any zone has ever changed at. Keeping both bounds second-aligned makes the
 * final `after` the transition exactly.
 */
function findTransition(lo: number, hi: number, zone: string): number | null {
  let before = Math.floor(lo / 1000) * 1000
  let after = Math.ceil(hi / 1000) * 1000
  const base = offsetOf(before, zone)
  if (offsetOf(after, zone) === base) return null
  while (after - before > 1000) {
    const mid = before + Math.floor((after - before) / 2000) * 1000
    if (offsetOf(mid, zone) === base) before = mid
    else after = mid
  }
  return after
}

/** Which of the three things a requested wall clock turned out to be. */
export type WallClockKind =
  /** It exists exactly once. The ordinary case. */
  | 'exact'
  /** It happens twice — the hour an autumn clock change repeats. */
  | 'ambiguous'
  /** It never happens — the hour a spring clock change skips. */
  | 'gap'

export interface ResolvedWallClock {
  at: number
  kind: WallClockKind
}

/**
 * Wall clock in a zone → UTC instant. The hard direction.
 *
 * There is no `Intl` API for this, so it is done by *guessing and checking*: an
 * offset turns the wall clock into a candidate instant, and the candidate is
 * only accepted if reading it back in the zone reproduces the wall clock we
 * asked for. Two guesses are needed, using the offsets a day either side,
 * because on a transition day the offset before and the offset after are both
 * plausible and only one of them can be right.
 *
 * The check is not decoration. It is what distinguishes the three answers:
 *
 * - **Both candidates verify** → the wall clock happens twice. This is the hour
 *   an autumn clock change repeats: 01:30 on 2026-11-01 exists in New York at
 *   05:30 UTC as EDT and again at 06:30 UTC as EST. **The earlier one is
 *   chosen** — "the window opens at 01:30" means the first 01:30, the same
 *   choice `Temporal`'s `compatible` disambiguation makes. Choosing the later
 *   one would hold an hour of mail for no reason anybody could see.
 * - **One candidate verifies** → the ordinary case.
 * - **Neither verifies** → the wall clock does not exist. This is the hour a
 *   spring clock change skips: 02:30 on 2026-03-08 in New York is not a time.
 *   The answer is the transition instant itself — 03:00 EDT, the first moment
 *   at which the local clock has reached or passed the time asked for. A window
 *   that opens at 02:30 therefore opens at 03:00 on that one day, which is what
 *   "from 02:30" has to mean on a day with no 02:30. Naive arithmetic instead
 *   returns 03:30 and quietly loses the first half-hour of the window.
 *
 * Returns `null` only for an unknown zone.
 */
export function instantForWallClock(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): ResolvedWallClock | null {
  const zone = resolveTimeZone(timeZone)
  if (zone === null) return null

  const naive = utcFromCivil(year, month, day, minutes)
  const o1 = offsetOf(naive - DAY_MS, zone)
  const o2 = offsetOf(naive + DAY_MS, zone)
  const c1 = naive - o1
  const c2 = naive - o2
  const earlier = Math.min(c1, c2)
  const later = Math.max(c1, c2)

  // Normalised, because `minutes` may be 1440 (`to: '24:00'`) and the caller
  // then means midnight the following day.
  const target = new Date(naive)
  const wantYear = target.getUTCFullYear()
  const wantMonth = target.getUTCMonth() + 1
  const wantDay = target.getUTCDate()
  const wantMinutes = target.getUTCHours() * 60 + target.getUTCMinutes()

  const verifies = (candidate: number): boolean => {
    const wall = wallClockIn(candidate, zone)
    return (
      wall !== null &&
      wall.year === wantYear &&
      wall.month === wantMonth &&
      wall.day === wantDay &&
      wall.minutes === wantMinutes
    )
  }

  const hits = (earlier === later ? [earlier] : [earlier, later]).filter(verifies)
  if (hits.length > 1) return { at: hits[0], kind: 'ambiguous' }
  if (hits.length === 1) return { at: hits[0], kind: 'exact' }

  const gap = findTransition(naive - DAY_MS, naive + DAY_MS, zone)
  return { at: gap ?? later, kind: 'gap' }
}

// ---------------------------------------------------------------------------
// The window itself
// ---------------------------------------------------------------------------

const HHMM = /^(\d{1,2}):(\d{2})$/

function parseHhMm(text: string, allowEndOfDay: boolean): number | null {
  const m = HHMM.exec(String(text ?? '').trim())
  if (m === null) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (mi > 59) return null
  if (h === 24) return allowEndOfDay && mi === 0 ? 1440 : null
  if (h > 23) return null
  return h * 60 + mi
}

/**
 * `days` cleaned up: integers only, de-duplicated, and 7 folded onto 0 the way
 * `parseCron` already folds it, so a list that came out of a cron-shaped editor
 * does not silently lose its Sundays.
 */
function normalizedDays(days: number[]): number[] {
  const out: number[] = []
  for (const raw of Array.isArray(days) ? days : []) {
    if (!Number.isInteger(raw)) continue
    const day = raw === 7 ? 0 : raw
    if (day < 0 || day > 6) continue
    if (!out.includes(day)) out.push(day)
  }
  return out
}

/**
 * What is wrong with this window, or `null` when it is usable.
 *
 * An empty `days` list is `neverOpens` rather than "every day". Both readings
 * are defensible and the difference matters, so it is decided here once: a
 * window that names no weekday is a window somebody half-configured, and the
 * treatment for every fault in this file is the same — **the window is ignored
 * and the send goes out on time**, with the fault reported so the UI can say
 * so. Holding a message forever because a list is empty is precisely the silent
 * failure this application refuses to have.
 */
export function windowFault(w: DeliveryWindow): DeliveryWindowFault | null {
  if (!w || typeof w !== 'object') return 'malformed'
  if (resolveTimeZone(w.timeZone) === null) return 'unknownZone'
  const from = parseHhMm(w.from, false)
  const to = parseHhMm(w.to, true)
  if (from === null || to === null) return 'malformed'
  if (from === to) return 'neverOpens'
  if (normalizedDays(w.days).length === 0) return 'neverOpens'
  return null
}

/**
 * Is this instant inside the window?
 *
 * A window whose `from` is later than its `to` wraps midnight — 22:00→06:00 is
 * one window, not "the sixteen hours in between" — the same reading
 * `isQuiet` gives a nightly window. For the part after midnight the weekday
 * tested is the day the window *opened*, so `days: [5]` covers Friday 22:00
 * through Saturday 06:00 and stops there.
 *
 * Returns `true` for any window with a fault, and for an unreadable instant.
 * "Inside" here means "nothing is holding this back", and failing open is the
 * only safe direction for a tool whose job is delivering on time.
 */
export function isInsideWindow(at: number, w: DeliveryWindow): boolean {
  if (!Number.isFinite(at)) return true
  if (windowFault(w) !== null) return true

  const zone = resolveTimeZone(w.timeZone)
  if (zone === null) return true
  const wall = wallClockIn(at, zone)
  if (wall === null) return true

  const from = parseHhMm(w.from, false) as number
  const to = parseHhMm(w.to, true) as number
  const days = normalizedDays(w.days)

  if (from < to) {
    return days.includes(wall.weekday) && wall.minutes >= from && wall.minutes < to
  }
  if (wall.minutes >= from) return days.includes(wall.weekday)
  if (wall.minutes < to) return days.includes((wall.weekday + 6) % 7)
  return false
}

function addCivilDays(
  wall: Pick<WallClock, 'year' | 'month' | 'day'>,
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(utcFromCivil(wall.year, wall.month, wall.day))
  d.setUTCDate(d.getUTCDate() + days)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  }
}

/**
 * The first instant at or after `at` that is inside the window, or `null` when
 * the window does not open inside `DELIVERY_HORIZON_DAYS`.
 *
 * The search walks *local calendar days* rather than adding 86 400 000 ms,
 * because a day is not always that many milliseconds and a clock change in
 * between would otherwise walk the search off the day it was aiming at.
 *
 * Each candidate opening is checked with `isInsideWindow` before it is
 * returned. That second look is what handles a window that a spring clock
 * change swallows whole — 02:00→02:30 on the day the local clock jumps from
 * 02:00 to 03:00 resolves to an opening of 03:00, which is already past its own
 * closing time, so that day is skipped and the next one is tried.
 *
 * Returns `at` unchanged for a faulty window; see `windowFault`.
 */
export function nextInsideWindow(at: number, w: DeliveryWindow): number | null {
  if (!Number.isFinite(at)) return null
  if (windowFault(w) !== null) return at
  if (isInsideWindow(at, w)) return at

  const zone = resolveTimeZone(w.timeZone) as string
  const start = wallClockIn(at, zone)
  if (start === null) return at

  const from = parseHhMm(w.from, false) as number
  const days = normalizedDays(w.days)

  for (let i = 0; i <= DELIVERY_HORIZON_DAYS; i++) {
    const date = addCivilDays(start, i)
    if (!days.includes(date.weekday)) continue
    const open = instantForWallClock(date.year, date.month, date.day, from, zone)
    if (open === null) continue
    if (open.at >= at && isInsideWindow(open.at, w)) return open.at
  }
  return null
}

// ---------------------------------------------------------------------------
// Several recipients
// ---------------------------------------------------------------------------

function reasonForMove(w: DeliveryWindow, from: number, to: number): DeliveryWindowReason {
  if (to === from) return 'inside'
  const zone = resolveTimeZone(w.timeZone)
  if (zone === null) return 'nextOpenDay'
  const a = wallClockIn(from, zone)
  const b = wallClockIn(to, zone)
  if (a === null || b === null) return 'nextOpenDay'
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day
  return sameDay ? 'opensLater' : 'nextOpenDay'
}

/**
 * The earliest instant that satisfies every window at once.
 *
 * A fixed point, not an intersection: each window pushes the cursor to its own
 * next opening, and pushing it for one recipient can take it back outside
 * another's window, so the sweep repeats until nobody moves it. Bounded twice
 * over — by the horizon and by a pass count — because the loop's natural
 * behaviour on an unsatisfiable pair is to advance forever.
 *
 * `boundBy` is whichever window last moved the cursor: the recipient the send
 * is actually waiting on, which is the only useful thing to put on screen.
 */
function jointInstant(
  at: number,
  usable: Array<{ index: number; window: DeliveryWindow }>,
): { at: number; boundBy?: number } | null {
  const limit = at + DELIVERY_HORIZON_DAYS * DAY_MS
  let cursor = at
  let boundBy: number | undefined

  for (let pass = 0; pass <= DELIVERY_HORIZON_DAYS * 4 + 8; pass++) {
    let moved = false
    for (const entry of usable) {
      const next = nextInsideWindow(cursor, entry.window)
      if (next === null) return null
      if (next > cursor) {
        cursor = next
        boundBy = entry.index
        moved = true
        if (cursor > limit) return null
      }
    }
    if (!moved) return cursor > limit ? null : { at: cursor, boundBy }
  }
  return null
}

/**
 * What a send time becomes once every recipient's window is honoured, and why.
 *
 * `windows` is one entry per recipient, in whatever order the caller holds
 * them; `perRecipient` comes back the same length and in the same order, so an
 * address list and a landing list can be zipped without bookkeeping. A window
 * with a fault contributes an `ignored` landing and constrains nothing.
 */
export function applyDeliveryWindows(
  at: number,
  windows: DeliveryWindow[],
): DeliveryWindowResult {
  const list = Array.isArray(windows) ? windows : []
  const perRecipient: DeliveryWindowLanding[] = []
  const usable: Array<{ index: number; window: DeliveryWindow }> = []

  list.forEach((w, index) => {
    const fault = windowFault(w)
    const zone = (w && resolveTimeZone(w.timeZone)) || ''
    if (fault !== null) {
      perRecipient.push({
        index,
        outcome: 'ignored',
        reason: fault,
        at,
        from: at,
        timeZone: zone,
      })
      return
    }
    usable.push({ index, window: w })
    const landed = nextInsideWindow(at, w)
    if (landed === null) {
      // Well-formed but does not open inside the horizon. The send is not
      // cancelled — it keeps its instant and this is reported.
      perRecipient.push({
        index,
        outcome: 'impossible',
        reason: 'outOfHorizon',
        at,
        from: at,
        timeZone: zone,
      })
      return
    }
    perRecipient.push({
      index,
      outcome: landed === at ? 'unchanged' : 'moved',
      reason: landed === at ? 'inside' : reasonForMove(w, at, landed),
      at: landed,
      from: at,
      timeZone: zone,
    })
  })

  const base = {
    from: at,
    perRecipient,
    horizonDays: DELIVERY_HORIZON_DAYS,
  }

  if (list.length === 0) {
    return { ...base, outcome: 'unchanged', reason: 'noWindows', at, splitRequired: false }
  }
  if (usable.length === 0) {
    // Every window had a fault. Say which one rather than pretending none were
    // supplied — the first fault is the one the UI should point at.
    return {
      ...base,
      outcome: 'unchanged',
      reason: perRecipient[0]?.reason ?? 'noWindows',
      at,
      splitRequired: false,
    }
  }

  const joint = jointInstant(at, usable)
  if (joint === null) {
    // Every recipient may still be reachable on their own — that is exactly the
    // New Zealand / California case, and exactly when splitting the send is the
    // right answer rather than a workaround.
    const eachReachable = perRecipient.every((l) => l.outcome !== 'impossible')
    return {
      ...base,
      outcome: 'impossible',
      reason: 'noCommonInstant',
      at,
      splitRequired: eachReachable,
    }
  }

  const splitRequired = perRecipient.some((l) => l.outcome !== 'ignored' && l.at !== joint.at)

  if (joint.at === at) {
    return { ...base, outcome: 'unchanged', reason: 'inside', at, splitRequired }
  }

  const binding = joint.boundBy !== undefined ? list[joint.boundBy] : undefined
  return {
    ...base,
    outcome: 'moved',
    reason: binding ? reasonForMove(binding, at, joint.at) : 'nextOpenDay',
    at: joint.at,
    splitRequired,
    boundBy: joint.boundBy,
  }
}
