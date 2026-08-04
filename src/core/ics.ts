/**
 * iCalendar (RFC 5545), written by hand.
 *
 * Two jobs, and they are not symmetric.
 *
 * **Writing** has to produce a file the other calendars accept, which is a
 * short list of rules that are easy to state and easy to get wrong: CRLF and
 * only CRLF; content lines folded at 75 *octets* (not characters — a folded
 * Chinese holiday name that split a UTF-8 sequence would arrive as mojibake);
 * `,` `;` `\` and newlines escaped inside TEXT; and a `DTSTART` whose kind
 * matches what the thing actually is.
 *
 * **Reading** has to survive what real calendars emit, which is a much longer
 * list: `TZID=` parameters naming zones we do not ship a database for, quoted
 * parameter values containing colons, `DURATION` instead of `DTEND`, `X-`
 * properties everywhere, lone-LF files from scripts, a BOM from Outlook, and
 * `RRULE`s using parts this application has no concept of. None of those may
 * throw, and none of them may be silently discarded — anything not understood
 * comes back in `warnings` so the import screen can say what it ignored.
 *
 * No dependency. A calendar library would bring a timezone database and a
 * parser generator for what is, on this side of the app, a few hundred lines.
 *
 * ## Which time each thing gets
 *
 * | what | how it is written | why |
 * |---|---|---|
 * | a holiday / make-up day | `DTSTART;VALUE=DATE` | it is a *date*, and has no time |
 * | a one-off reminder | UTC instant, `…Z` | it fires at one instant; UTC is unambiguous |
 * | a repeating reminder | floating local time + `RRULE` | "every day at 09:00" means 09:00 wherever you are, and that survives a DST change; a UTC instant would drift by an hour |
 *
 * The third row is the only interesting one. Emitting `DTSTART;TZID=Asia/Shanghai`
 * would be the other correct answer, but it obliges us to also emit a
 * `VTIMEZONE` block containing that zone's full transition rules — which we
 * would have to synthesise, and which shifts every event by an hour when it is
 * wrong. Floating time is spec (RFC 5545 §3.3.5) and is exactly the semantics a
 * wall-clock reminder already has in this app.
 */

import { pad2, type Recurrence, type ScheduledJob } from './types'
import { computeOccurrences } from './schedule'
import { toIsoDate, type IsoDate, type WorkCalendar } from './workCalendar'

// ---------------------------------------------------------------------------
// Line handling
// ---------------------------------------------------------------------------

/** Longest a content line may be, excluding the line break. RFC 5545 §3.1. */
const OCTET_LIMIT = 75

const encoder = new TextEncoder()

/**
 * Fold one content line to 75 octets per physical line.
 *
 * Measured in octets and split on code points, which are two separate traps:
 * `'节'.length` is 1 but it occupies 3 bytes, and a naive `slice` on a string
 * containing an emoji splits a surrogate pair into two lone halves. The
 * continuation space counts toward its own line's 75.
 */
export function foldLine(line: string): string {
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of line) {
    const n = encoder.encode(ch).length
    if (bytes + n > OCTET_LIMIT && current.length > 0) {
      out.push(current)
      current = ' '
      bytes = 1
    }
    current += ch
    bytes += n
  }
  out.push(current)
  return out.join('\r\n')
}

/**
 * Reverse the fold, and be liberal about line breaks while doing it.
 *
 * A file written by a shell script has bare LFs and is not strictly legal;
 * refusing it would be correct and useless.
 */
export function unfoldLines(text: string): string[] {
  const raw = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  const out: string[] = []
  for (const line of raw) {
    if (out.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out.filter((l) => l.trim().length > 0)
}

/** Escape a TEXT value. Note `:` is *not* escaped in TEXT — only in params. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n')
}

export function unescapeText(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const next = value[++i]
    if (next === undefined) {
      // A trailing backslash is malformed. Keep it rather than eat it.
      out += '\\'
      break
    }
    if (next === 'n' || next === 'N') out += '\n'
    else out += next
  }
  return out
}

/** Split on `sep`, ignoring separators inside a double-quoted section. */
function splitUnquoted(text: string, sep: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      current += ch
    } else if (ch === sep && !quoted) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

export interface IcsProperty {
  name: string
  params: Record<string, string[]>
  value: string
}

/**
 * `NAME;PARAM=x;OTHER="a:b":the value` → its three parts.
 *
 * The quoted-parameter case is the one that bites: `TZID="GMT+08:00"` and
 * `CN="Doe, John"` both contain characters that end the property if you split
 * on the first `:` or `;` you find.
 */
export function parseProperty(line: string): IcsProperty | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segments = splitUnquoted(head, ';')
  const name = segments[0].trim().toUpperCase()
  if (!name) return null
  const params: Record<string, string[]> = {}
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=')
    if (eq < 0) continue
    const key = segment.slice(0, eq).trim().toUpperCase()
    const values = splitUnquoted(segment.slice(eq + 1), ',').map((v) =>
      v.replace(/^"/, '').replace(/"$/, ''),
    )
    params[key] = (params[key] ?? []).concat(values)
  }
  return { name, params, value }
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/**
 * What a DTSTART/DTEND turned out to be.
 *
 * Three cases and not two, because "a date" and "midnight on that date" are
 * different things and collapsing them is how an all-day holiday ends up one
 * day early for half the planet — the same bug `parseIsoDate` exists to stop.
 */
export type IcsWhen =
  /** All-day. There is no time and no zone; `date` is the whole value. */
  | { kind: 'date'; date: IsoDate }
  /** A fixed point on the timeline, already resolved to epoch ms. */
  | { kind: 'instant'; at: number }
  /**
   * A wall-clock time with no zone: 09:00 wherever the reader is. `at` is that
   * wall time resolved against *this* machine, which is what every consumer
   * here wants; `wall` keeps the original so re-export is lossless.
   */
  | { kind: 'floating'; at: number; wall: string }

/**
 * The offset of `tz` at a given instant, in ms.
 *
 * `Intl` is the timezone database we do not ship: every engine this runs on
 * (Chromium in Electron, the Android WebView, Node) carries a full IANA set.
 * Throws for a zone the engine does not know, which the caller turns into a
 * warning rather than a failure.
 */
function zoneOffsetAt(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // Some engines render midnight as hour 24 under hour12:false. `% 24` is not
  // cosmetic — without it the offset comes out a full day wrong once a day.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asIfUtc - utcMs
}

/**
 * A wall-clock reading in a named zone → the instant it denotes.
 *
 * Two passes, because the offset depends on the instant we are trying to find.
 * The first guess is wrong only across a DST transition; the second correction
 * lands it. (An ambiguous hour — the one that happens twice each autumn —
 * resolves to the first of the two, which is what every implementation does.)
 */
function zonedWallToUtc(wallAsUtc: number, tz: string): number {
  const first = wallAsUtc - zoneOffsetAt(tz, wallAsUtc)
  return wallAsUtc - zoneOffsetAt(tz, first)
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/
const DATETIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/

/**
 * Read a DATE or DATE-TIME value, honouring `VALUE=` and `TZID=`.
 *
 * Returns null for anything unreadable; the caller reports it rather than
 * inventing a date, because a reminder imported onto the wrong day is worse
 * than one that was refused.
 */
export function parseIcsWhen(
  prop: IcsProperty,
  onWarn?: (message: string) => void,
): IcsWhen | null {
  const raw = prop.value.trim()
  const isDateValue = prop.params.VALUE?.[0]?.toUpperCase() === 'DATE'

  const dateOnly = DATE_RE.exec(raw)
  if (dateOnly && (isDateValue || raw.length === 8)) {
    return { kind: 'date', date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}` }
  }

  const m = DATETIME_RE.exec(raw)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const

  if (z) {
    return { kind: 'instant', at: Date.UTC(...fields) }
  }

  const tzid = prop.params.TZID?.[0]
  if (tzid) {
    try {
      return { kind: 'instant', at: zonedWallToUtc(Date.UTC(...fields), tzid) }
    } catch {
      // An unknown zone is not a reason to drop the event. Fall through to
      // floating and say so — the time of day is still right, and the reader
      // is told which assumption was made.
      onWarn?.(`Unknown time zone "${tzid}" — read as local time`)
    }
  }

  return {
    kind: 'floating',
    at: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime(),
    wall: `${y}${mo}${d}T${h}${mi}${s}`,
  }
}

/** `YYYYMMDD`, from a local date string. */
function icsDate(iso: IsoDate): string {
  return iso.replace(/-/g, '')
}

/** `YYYYMMDDTHHMMSSZ` — an instant, no zone required to read it. */
export function icsInstant(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  )
}

/** `YYYYMMDDTHHMMSS` — a wall-clock time, deliberately with no zone. */
export function icsFloating(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

/** One local day later, as a `YYYYMMDD` — an all-day DTEND is exclusive. */
function nextDay(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number)
  const next = new Date(y, m - 1, d + 1)
  return `${next.getFullYear()}${pad2(next.getMonth() + 1)}${pad2(next.getDate())}`
}

// ---------------------------------------------------------------------------
// RRULE
// ---------------------------------------------------------------------------

export interface RRuleParts {
  freq: 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval?: number
  count?: number
  /** Epoch ms, when the file gave a readable UNTIL. */
  until?: number
  byDay?: string[]
  byMonthDay?: number[]
  byMonth?: number[]
  /** Parts this app has no concept of, kept so an import can say what it lost. */
  unsupported?: string[]
}

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export function parseRRule(value: string, onWarn?: (m: string) => void): RRuleParts | null {
  const parts: Record<string, string> = {}
  for (const chunk of value.split(';')) {
    const eq = chunk.indexOf('=')
    if (eq < 0) continue
    parts[chunk.slice(0, eq).trim().toUpperCase()] = chunk.slice(eq + 1).trim()
  }
  const freq = parts.FREQ?.toUpperCase()
  if (
    freq !== 'SECONDLY' &&
    freq !== 'MINUTELY' &&
    freq !== 'HOURLY' &&
    freq !== 'DAILY' &&
    freq !== 'WEEKLY' &&
    freq !== 'MONTHLY' &&
    freq !== 'YEARLY'
  ) {
    onWarn?.(`RRULE with no usable FREQ: ${value}`)
    return null
  }

  const rule: RRuleParts = { freq }
  if (parts.INTERVAL) rule.interval = Math.max(1, Number(parts.INTERVAL) || 1)
  if (parts.COUNT) rule.count = Math.max(1, Number(parts.COUNT) || 1)
  if (parts.UNTIL) {
    const when = parseIcsWhen({ name: 'UNTIL', params: {}, value: parts.UNTIL })
    if (when) rule.until = when.kind === 'date' ? new Date(`${when.date}T23:59:59`).getTime() : when.at
  }
  if (parts.BYDAY) {
    // `2MO` (second Monday) keeps its ordinal here; the mapper below refuses it
    // rather than silently reading it as "every Monday".
    rule.byDay = parts.BYDAY.split(',').map((d) => d.trim().toUpperCase())
  }
  if (parts.BYMONTHDAY) rule.byMonthDay = parts.BYMONTHDAY.split(',').map(Number)
  if (parts.BYMONTH) rule.byMonth = parts.BYMONTH.split(',').map(Number)

  const known = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'])
  const unsupported = Object.keys(parts).filter((k) => !known.has(k))
  if (unsupported.length > 0) rule.unsupported = unsupported

  return rule
}

export function formatRRule(rule: RRuleParts): string {
  const out = [`FREQ=${rule.freq}`]
  if (rule.interval && rule.interval > 1) out.push(`INTERVAL=${rule.interval}`)
  // Widest unit first — the order every calendar in the wild writes, and the
  // one a human comparing two files by eye expects.
  if (rule.byMonth && rule.byMonth.length > 0) out.push(`BYMONTH=${rule.byMonth.join(',')}`)
  if (rule.byMonthDay && rule.byMonthDay.length > 0) {
    out.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`)
  }
  if (rule.byDay && rule.byDay.length > 0) out.push(`BYDAY=${rule.byDay.join(',')}`)
  // COUNT and UNTIL are mutually exclusive per spec; COUNT wins if both are set.
  if (rule.count !== undefined) out.push(`COUNT=${rule.count}`)
  else if (rule.until !== undefined) out.push(`UNTIL=${icsInstant(rule.until)}`)
  return out.join(';')
}

const MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }

/**
 * A `Recurrence` as an RRULE, or null when it is not expressible.
 *
 * Null is a real answer and the caller must handle it: a cron rule and a
 * sub-second interval have no RRULE spelling, and writing an approximate one
 * would produce a file that quietly disagrees with the app it came from.
 */
export function recurrenceToRRule(rec: Recurrence): RRuleParts | null {
  const end: Partial<RRuleParts> =
    rec.endMode === 'afterCount' && rec.maxRuns !== undefined
      ? { count: rec.maxRuns }
      : rec.endMode === 'onDate' && rec.endDate !== undefined
        ? { until: rec.endDate }
        : {}

  switch (rec.kind) {
    case 'once':
      return null
    case 'daily':
      return { freq: 'DAILY', ...end }
    case 'weekly': {
      const days = rec.weekdays && rec.weekdays.length > 0 ? rec.weekdays : [new Date(rec.startAt).getDay()]
      return { freq: 'WEEKLY', byDay: days.map((d) => RRULE_DAYS[d]), ...end }
    }
    case 'monthly':
      return {
        freq: 'MONTHLY',
        byMonthDay: [rec.dayOfMonth ?? new Date(rec.startAt).getDate()],
        ...end,
      }
    case 'yearly':
      return {
        freq: 'YEARLY',
        byMonth: [(rec.month ?? new Date(rec.startAt).getMonth()) + 1],
        byMonthDay: [rec.dayOfMonth ?? new Date(rec.startAt).getDate()],
        ...end,
      }
    case 'interval': {
      const ms = rec.intervalMs ?? (rec.intervalMinutes ?? 0) * 60_000
      if (ms <= 0) return null
      if (ms % MS.day === 0) return { freq: 'DAILY', interval: ms / MS.day, ...end }
      if (ms % MS.hour === 0) return { freq: 'HOURLY', interval: ms / MS.hour, ...end }
      if (ms % MS.minute === 0) return { freq: 'MINUTELY', interval: ms / MS.minute, ...end }
      if (ms % MS.second === 0) return { freq: 'SECONDLY', interval: ms / MS.second, ...end }
      // Sub-second. RRULE's smallest unit is the second.
      return null
    }
    case 'cron':
      // Deliberate. A five-field cron expresses sets RRULE cannot ("the 1st and
      // the 15th at 9 and 17"), and half-translating it is worse than not.
      return null
  }
}

/**
 * An RRULE as the fields of a `Recurrence`, or null when this app cannot run it.
 *
 * Returns a *partial*: the caller merges it into a full recurrence so that
 * fields the file said nothing about keep the values the caller chose.
 */
export function rruleToRecurrence(
  rule: RRuleParts,
  startAt: number,
): Partial<Recurrence> | null {
  const end: Partial<Recurrence> =
    rule.count !== undefined
      ? { endMode: 'afterCount', maxRuns: rule.count }
      : rule.until !== undefined
        ? { endMode: 'onDate', endDate: rule.until }
        : { endMode: 'never' }

  const interval = rule.interval ?? 1
  const start = new Date(startAt)

  // An ordinal BYDAY ("the second Tuesday") is a rule this app has no way to
  // run. Refusing is the honest answer.
  const plainDays = (rule.byDay ?? []).every((d) => RRULE_DAYS.includes(d))
  if (rule.byDay && !plainDays) return null

  switch (rule.freq) {
    case 'DAILY':
      if (interval === 1) return { kind: 'daily', ...end }
      return { kind: 'interval', intervalMs: interval * MS.day, ...end }
    case 'WEEKLY': {
      if (interval !== 1) return { kind: 'interval', intervalMs: interval * 7 * MS.day, ...end }
      const weekdays = (rule.byDay ?? [RRULE_DAYS[start.getDay()]]).map((d) => RRULE_DAYS.indexOf(d))
      return { kind: 'weekly', weekdays: weekdays.sort(), ...end }
    }
    case 'MONTHLY':
      if (interval !== 1) return null
      return { kind: 'monthly', dayOfMonth: rule.byMonthDay?.[0] ?? start.getDate(), ...end }
    case 'YEARLY':
      if (interval !== 1) return null
      return {
        kind: 'yearly',
        month: (rule.byMonth?.[0] ?? start.getMonth() + 1) - 1,
        dayOfMonth: rule.byMonthDay?.[0] ?? start.getDate(),
        ...end,
      }
    case 'HOURLY':
      return { kind: 'interval', intervalMs: interval * MS.hour, ...end }
    case 'MINUTELY':
      return { kind: 'interval', intervalMs: interval * MS.minute, ...end }
    case 'SECONDLY':
      return { kind: 'interval', intervalMs: interval * MS.second, ...end }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** What this app means by an event, which is less than VEVENT can carry. */
export interface IcsEvent {
  uid: string
  summary: string
  description?: string
  start: IcsWhen
  end?: IcsWhen
  rrule?: RRuleParts
  categories: string[]
  /** `TRANSP:TRANSPARENT` — a day off does not make you busy. */
  transparent: boolean
  /**
   * Set by our own exporter so a re-import knows which list a date belongs in.
   * Absent on a file from anywhere else, where the heuristics take over.
   */
  kind?: 'holiday' | 'workday' | 'reminder'
}

export const AEVISTLE_PRODID = '-//Aevistle//Working calendar//EN'
/** The `X-` property that tells our own files apart from everyone else's. */
export const KIND_PROP = 'X-AEVISTLE-KIND'

function line(name: string, value: string, params?: string): string {
  return foldLine(`${name}${params ? `;${params}` : ''}:${value}`)
}

/**
 * Build a whole calendar.
 *
 * `now` is a parameter rather than a call to the clock so the output is
 * reproducible — a serialiser you cannot compare two runs of is a serialiser
 * you cannot test.
 */
export function buildIcs(
  events: IcsEvent[],
  opts: { prodId?: string; name?: string; now?: number } = {},
): string {
  const now = opts.now ?? Date.now()
  const stamp = icsInstant(now)
  const out: string[] = [
    'BEGIN:VCALENDAR',
    line('VERSION', '2.0'),
    line('PRODID', opts.prodId ?? AEVISTLE_PRODID),
    line('CALSCALE', 'GREGORIAN'),
    line('METHOD', 'PUBLISH'),
  ]
  if (opts.name) {
    out.push(line('X-WR-CALNAME', escapeText(opts.name)))
    out.push(line('NAME', escapeText(opts.name)))
  }

  for (const event of events) {
    out.push('BEGIN:VEVENT')
    out.push(line('UID', escapeText(event.uid)))
    out.push(line('DTSTAMP', stamp))

    if (event.start.kind === 'date') {
      out.push(line('DTSTART', icsDate(event.start.date), 'VALUE=DATE'))
      const endDate =
        event.end && event.end.kind === 'date' ? icsDate(event.end.date) : nextDay(event.start.date)
      out.push(line('DTEND', endDate, 'VALUE=DATE'))
    } else if (event.start.kind === 'instant') {
      out.push(line('DTSTART', icsInstant(event.start.at)))
      if (event.end && event.end.kind === 'instant') out.push(line('DTEND', icsInstant(event.end.at)))
    } else {
      out.push(line('DTSTART', icsFloating(event.start.at)))
      if (event.end && event.end.kind === 'floating') {
        out.push(line('DTEND', icsFloating(event.end.at)))
      }
    }

    out.push(line('SUMMARY', escapeText(event.summary)))
    if (event.description) out.push(line('DESCRIPTION', escapeText(event.description)))
    if (event.rrule) out.push(line('RRULE', formatRRule(event.rrule)))
    if (event.categories.length > 0) {
      out.push(line('CATEGORIES', event.categories.map(escapeText).join(',')))
    }
    if (event.transparent) out.push(line('TRANSP', 'TRANSPARENT'))
    if (event.kind) out.push(line(KIND_PROP, event.kind.toUpperCase()))
    out.push('END:VEVENT')
  }

  out.push('END:VCALENDAR')
  // The trailing CRLF is not decoration: a file whose last line has no break
  // is rejected by several readers.
  return `${out.join('\r\n')}\r\n`
}

export interface IcsParseResult {
  events: IcsEvent[]
  /** Everything understood-but-ignored or not understood at all. Never empty silently. */
  warnings: string[]
  calendarName?: string
  prodId?: string
}

/**
 * Read a calendar.
 *
 * Never throws. A file that is not a calendar at all comes back with no events
 * and a warning saying so, because the alternative — an exception crossing an
 * import button — is a blank screen.
 */
export function parseIcs(text: string): IcsParseResult {
  const warnings: string[] = []
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m)
  }
  const events: IcsEvent[] = []
  let calendarName: string | undefined
  let prodId: string | undefined

  const lines = unfoldLines(text)
  if (!lines.some((l) => /^BEGIN:VCALENDAR/i.test(l))) {
    return { events: [], warnings: ['Not an iCalendar file (no BEGIN:VCALENDAR)'] }
  }

  let current: Partial<IcsEvent> & { durationMs?: number } | null = null
  /** Depth of components we are skipping wholesale — VTIMEZONE, VALARM, VTODO. */
  let skipping: string | null = null
  let unknownIdx = 0

  for (const raw of lines) {
    const prop = parseProperty(raw)
    if (!prop) continue

    if (prop.name === 'BEGIN') {
      const component = prop.value.trim().toUpperCase()
      if (skipping) continue
      if (component === 'VEVENT') {
        current = { categories: [], transparent: false }
      } else if (component !== 'VCALENDAR') {
        // VTIMEZONE is skipped by design: the TZID lookups go through Intl, so
        // a file's own transition rules are information we already have and
        // would only disagree with. VALARM is a display concern of the sending
        // calendar. Both are noted, not silently dropped.
        skipping = component
        if (component === 'VTODO' || component === 'VJOURNAL' || component === 'VFREEBUSY') {
          warn(`Ignored a ${component} component — only events are imported`)
        }
      }
      continue
    }

    if (prop.name === 'END') {
      const component = prop.value.trim().toUpperCase()
      if (skipping) {
        if (skipping === component) skipping = null
        continue
      }
      if (component === 'VEVENT' && current) {
        if (!current.start) {
          warn(`Skipped an event with no readable DTSTART${current.summary ? `: ${current.summary}` : ''}`)
        } else {
          if (!current.end && current.durationMs !== undefined && current.start.kind !== 'date') {
            const endAt = current.start.at + current.durationMs
            current.end =
              current.start.kind === 'instant'
                ? { kind: 'instant', at: endAt }
                : { kind: 'floating', at: endAt, wall: icsFloating(endAt) }
          }
          events.push({
            uid: current.uid ?? `imported-${++unknownIdx}@aevistle`,
            summary: current.summary ?? '',
            description: current.description,
            start: current.start,
            end: current.end,
            rrule: current.rrule,
            categories: current.categories ?? [],
            transparent: current.transparent ?? false,
            kind: current.kind,
          })
        }
        current = null
      }
      continue
    }

    if (skipping) continue

    if (!current) {
      if (prop.name === 'X-WR-CALNAME' || prop.name === 'NAME') calendarName = unescapeText(prop.value)
      if (prop.name === 'PRODID') prodId = unescapeText(prop.value)
      continue
    }

    switch (prop.name) {
      case 'UID':
        current.uid = unescapeText(prop.value)
        break
      case 'SUMMARY':
        current.summary = unescapeText(prop.value)
        break
      case 'DESCRIPTION':
        current.description = unescapeText(prop.value)
        break
      case 'DTSTART': {
        const when = parseIcsWhen(prop, warn)
        if (when) current.start = when
        else warn(`Unreadable DTSTART: ${prop.value}`)
        break
      }
      case 'DTEND': {
        const when = parseIcsWhen(prop, warn)
        if (when) current.end = when
        break
      }
      case 'DURATION': {
        const ms = parseDuration(prop.value)
        if (ms !== null) current.durationMs = ms
        break
      }
      case 'RRULE': {
        const rule = parseRRule(prop.value, warn)
        if (rule) {
          current.rrule = rule
          if (rule.unsupported && rule.unsupported.length > 0) {
            warn(`RRULE parts not supported and ignored: ${rule.unsupported.join(', ')}`)
          }
        }
        break
      }
      case 'RDATE':
      case 'EXDATE':
        warn(`${prop.name} is not supported and was ignored`)
        break
      case 'CATEGORIES':
        current.categories = splitUnquoted(prop.value, ',').map(unescapeText)
        break
      case 'TRANSP':
        current.transparent = prop.value.trim().toUpperCase() === 'TRANSPARENT'
        break
      case KIND_PROP: {
        const kind = prop.value.trim().toLowerCase()
        if (kind === 'holiday' || kind === 'workday' || kind === 'reminder') current.kind = kind
        break
      }
      default:
        break
    }
  }

  if (current) warn('The file ended inside an event; it was ignored')
  return { events, warnings, calendarName, prodId }
}

/** `PT1H30M`, `P1D`, `-PT15M` → ms. Null when it is not a duration. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase(),
  )
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  if (!w && !d && !h && !mi && !s) return null
  const total =
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(mi ?? 0) * 60_000 +
    Number(s ?? 0) * 1000
  return sign === '-' ? -total : total
}

// ---------------------------------------------------------------------------
// This app's two shapes ↔ events
// ---------------------------------------------------------------------------

/**
 * The working calendar as all-day events.
 *
 * `nameFor` is injected rather than imported so this module stays free of the
 * holiday tables — the ICS layer should not have an opinion about which
 * country's dates exist.
 */
export function calendarToEvents(
  calendar: WorkCalendar,
  opts: { nameFor?: (iso: IsoDate) => string | undefined; holidayLabel: string; workdayLabel: string },
): IcsEvent[] {
  const out: IcsEvent[] = []
  for (const iso of [...calendar.holidays].sort()) {
    out.push({
      uid: `holiday-${iso}@aevistle`,
      summary: opts.nameFor?.(iso) ?? opts.holidayLabel,
      start: { kind: 'date', date: iso },
      categories: ['HOLIDAY'],
      transparent: true,
      kind: 'holiday',
    })
  }
  for (const iso of [...calendar.workdays].sort()) {
    out.push({
      uid: `workday-${iso}@aevistle`,
      summary: opts.workdayLabel,
      start: { kind: 'date', date: iso },
      categories: ['WORKDAY'],
      transparent: false,
      kind: 'workday',
    })
  }
  return out
}

/**
 * Events → the two date lists.
 *
 * Our own files say which list each date belongs to. Everyone else's do not,
 * so the fallback is: an all-day event is a holiday unless its categories or
 * summary mark it as a working day. A multi-day event contributes every date
 * it spans, which is what a "Christmas break" entry from a real calendar is.
 *
 * Timed events are *not* holidays. A meeting at 14:00 is not a day off, and
 * importing a normal calendar would otherwise mark the entire year off.
 */
export function eventsToCalendarDates(events: IcsEvent[]): {
  holidays: IsoDate[]
  workdays: IsoDate[]
  named: Record<IsoDate, string>
  skippedTimed: number
} {
  const holidays = new Set<IsoDate>()
  const workdays = new Set<IsoDate>()
  const named: Record<IsoDate, string> = {}
  let skippedTimed = 0

  for (const event of events) {
    if (event.start.kind !== 'date') {
      skippedTimed++
      continue
    }
    const isWorkday =
      event.kind === 'workday' ||
      event.categories.some((c) => /^work ?day$/i.test(c.trim())) ||
      /make-?up|调休|补班/i.test(event.summary)

    // An all-day DTEND is exclusive, so a one-day event ends on the next day.
    const last =
      event.end && event.end.kind === 'date'
        ? addDate(event.end.date, -1)
        : event.start.date
    for (let cursor = event.start.date; cursor <= last; cursor = addDate(cursor, 1)) {
      if (isWorkday) workdays.add(cursor)
      else {
        holidays.add(cursor)
        if (event.summary) named[cursor] = event.summary
      }
      // A malformed DTEND far in the future would otherwise spin; 400 days is
      // longer than any real all-day event and shorter than a hang.
      if (Object.keys(named).length + holidays.size + workdays.size > 4000) break
    }
  }

  return {
    holidays: [...holidays].sort(),
    workdays: [...workdays].filter((d) => !holidays.has(d)).sort(),
    named,
    skippedTimed,
  }
}

function addDate(iso: IsoDate, days: number): IsoDate {
  const [y, m, d] = iso.split('-').map(Number)
  return toIsoDate(new Date(y, m - 1, d + days).getTime())
}

/**
 * Reminders as events.
 *
 * A rule that maps to an RRULE becomes one recurring event. A rule that does
 * not — cron, a sub-second interval — becomes one event per occurrence, capped,
 * with the cap reported. Writing a wrong RRULE for a cron expression would
 * produce a file that disagrees with the app that wrote it.
 */
export function jobsToEvents(
  jobs: ScheduledJob[],
  opts: {
    expandLimit?: number
    now?: number
    /**
     * Export the times this app will *actually send at*, not the rule.
     *
     * An `RRULE` is the honest export of a rule and a dishonest export of a
     * schedule, and this application is one where those differ on purpose.
     * "Every weekday at 09:00" becomes `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`
     * — and then the working calendar moves the 1 October send to the 8th,
     * quiet hours hold the 02:00 one until morning, and the subscriber's
     * calendar still shows the original. They would be looking at a schedule
     * this app has already decided not to follow.
     *
     * `job.occurrences` is the list *after* `applyWorkCalendarDetailed` and
     * quiet hours have had it (see `rebuildJob` in `state/AppState.tsx`), so
     * resolving means expanding that list instead of describing the rule. The
     * cost is a file that goes stale — a concrete list only reaches as far as
     * the occurrences do — which is why this is a mode and not the default.
     *
     * `calendar` is only reached for a job whose stored occurrence list is
     * empty (a paused reminder, or one restored from an export). Without it
     * that fallback would recompute from the bare rule and quietly put the
     * unadjusted times back into a file whose whole purpose is that they are
     * adjusted.
     */
    resolved?: { calendar?: WorkCalendar }
  } = {},
): { events: IcsEvent[]; expanded: string[] } {
  const limit = opts.expandLimit ?? 100
  const now = opts.now ?? Date.now()
  const events: IcsEvent[] = []
  const expanded: string[] = []

  for (const job of jobs) {
    const rule = opts.resolved ? null : recurrenceToRRule(job.recurrence)
    const description = [
      job.draft.subject,
      job.draft.to.length > 0 ? `To: ${job.draft.to.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    if (rule) {
      events.push({
        uid: `job-${job.id}@aevistle`,
        summary: job.name,
        description: description || undefined,
        // Floating: a repeating reminder is a wall-clock rule. See the header.
        start: { kind: 'floating', at: job.recurrence.startAt, wall: icsFloating(job.recurrence.startAt) },
        rrule: rule,
        categories: ['REMINDER'],
        transparent: true,
        kind: 'reminder',
      })
      continue
    }

    const times =
      job.occurrences.length > 0
        ? job.occurrences.slice(0, limit)
        : computeOccurrences(job.recurrence, {
            after: now,
            count: limit,
            runsSoFar: job.runCount,
            calendar: opts.resolved?.calendar,
          })
    if (job.recurrence.kind !== 'once' && times.length >= limit) expanded.push(job.name)
    for (const [i, at] of times.entries()) {
      events.push({
        uid: `job-${job.id}-${i}@aevistle`,
        summary: job.name,
        description: description || undefined,
        start: { kind: 'instant', at },
        categories: ['REMINDER'],
        transparent: true,
        kind: 'reminder',
      })
    }
  }

  return { events, expanded }
}
