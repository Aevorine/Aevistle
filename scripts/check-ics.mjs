/**
 * Does the calendar file we write actually come back as the calendar we wrote —
 * and does the one we read survive what real calendars emit?
 *
 * Every assertion here corresponds to a way an iCalendar implementation is
 * wrong in the field, and all of them fail by producing a *plausible* file or a
 * *plausible* date rather than by throwing:
 *
 *   - **Line endings.** A single `\n` where a `\r\n` belongs makes the file
 *     unreadable to a strict parser and readable to a lenient one, so it works
 *     until it reaches Exchange.
 *   - **Folding by octets, not characters.** 75 *characters* of Chinese is 225
 *     bytes; folding on the character count leaves the line too long, and
 *     folding on a byte index splits a UTF-8 sequence and turns 春节 into two
 *     replacement characters.
 *   - **Escaping.** An unescaped comma inside SUMMARY turns one event's title
 *     into a two-element list.
 *   - **DATE vs DATE-TIME.** An all-day holiday written as midnight is one day
 *     early for every reader west of the writer — the same class of bug as
 *     `new Date('2026-10-01')`, which is why this whole file runs in
 *     America/Los_Angeles.
 *   - **Exclusive DTEND.** An all-day event ending on the day it covers is a
 *     zero-length event; ending the day after is correct and reads as two days
 *     to anyone who gets it backwards.
 *   - **TZID.** A file from Outlook names a zone and expects the reader to have
 *     a database. Ignoring the parameter shifts the event by the offset.
 *   - **RRULE.** A rule this app cannot run must be refused, not approximated:
 *     translating a cron expression into `FREQ=DAILY` produces a file that
 *     silently disagrees with the app that wrote it.
 *
 * Exit code 1 if anything needs attention.
 */

process.env.TZ = 'America/Los_Angeles'

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let dir
try {
  dir = await mkdtemp(path.join(process.cwd(), 'node_modules', '.aevistle-ics-'))
} catch {
  dir = await mkdtemp(path.join(tmpdir(), 'aevistle-ics-'))
}

async function load(entry, name) {
  const outfile = path.join(dir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    external: ['react', 'react-dom'],
    define: { __APP_VERSION__: '"0.0.0-check"' },
    logLevel: 'error',
  })
  return import(pathToFileURL(outfile).href)
}

const ics = await load('src/core/schedule/ics.ts', 'ics')

const failures = []
let checked = 0
const ok = (what, pass) => {
  checked++
  if (!pass) failures.push(what)
}
const eq = (what, actual, expected) =>
  ok(
    `${what} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    JSON.stringify(actual) === JSON.stringify(expected),
  )
const present = (what, value) => {
  checked++
  if (typeof value !== 'function') failures.push(`${what} — the export does not exist`)
  return typeof value === 'function'
}
/**
 * The nth event, or a named failure and an inert stand-in.
 *
 * Breaking the parser must produce the whole list of consequences, not a
 * `Cannot read properties of undefined` on the first one — the second and third
 * failures are usually the ones that say *what* broke.
 */
const ev = (what, result, index = 0) => {
  checked++
  const event = result?.events?.[index]
  if (!event) {
    failures.push(`${what} — there is no event at index ${index}`)
    return { start: {}, end: undefined, categories: [] }
  }
  return event
}
/** `formatRRule` of a rule that may legitimately be null. */
const fmt = (rule) => (rule ? ics.formatRRule(rule) : null)
/** An instant as an ISO string, or null — so a missing one reads as a value, not a throw. */
const isoOrNull = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)

const at = (y, m, d, hh = 9, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss, 0).getTime()
const bytes = (s) => Buffer.byteLength(s, 'utf8')
const NOW = at(2026, 6, 1, 12)

// ===========================================================================
// Line discipline
// ===========================================================================

if (present('folding: foldLine is exported', ics.foldLine)) {
  const short = ics.foldLine('SUMMARY:hello')
  eq('folding: a short line is left alone', short, 'SUMMARY:hello')

  const long = `SUMMARY:${'a'.repeat(300)}`
  const folded = ics.foldLine(long)
  const physical = folded.split('\r\n')
  ok('folding: a long line is split', physical.length > 1)
  ok(
    'folding: every physical line is 75 octets or fewer',
    physical.every((l) => bytes(l) <= 75),
  )
  ok(
    'folding: every continuation begins with one space',
    physical.slice(1).every((l) => l.startsWith(' ')),
  )
  eq(
    'folding: unfolding restores the original exactly',
    ics.unfoldLines(folded)[0],
    long,
  )

  // The one that a byte-index slice gets wrong.
  const chinese = `SUMMARY:${'春节调休'.repeat(20)}`
  const cnFolded = ics.foldLine(chinese)
  ok(
    'folding: multibyte lines still respect the octet limit',
    cnFolded.split('\r\n').every((l) => bytes(l) <= 75),
  )
  eq(
    'folding: no UTF-8 sequence is split (round trip is byte-identical)',
    ics.unfoldLines(cnFolded)[0],
    chinese,
  )
  ok(
    'folding: and no replacement characters appeared',
    !cnFolded.includes('�'),
  )

  // An emoji is a surrogate pair in JS; splitting on `.length` breaks it.
  const emoji = `SUMMARY:${'🎆'.repeat(40)}`
  eq('folding: a surrogate pair survives folding', ics.unfoldLines(ics.foldLine(emoji))[0], emoji)
}

if (present('escaping: escapeText is exported', ics.escapeText)) {
  eq('escaping: a comma is escaped', ics.escapeText('a,b'), 'a\\,b')
  eq('escaping: a semicolon is escaped', ics.escapeText('a;b'), 'a\\;b')
  eq('escaping: a backslash is escaped first', ics.escapeText('a\\b'), 'a\\\\b')
  eq('escaping: a newline becomes \\n', ics.escapeText('a\nb'), 'a\\nb')
  eq('escaping: CRLF becomes one \\n', ics.escapeText('a\r\nb'), 'a\\nb')
  eq('escaping: a colon is NOT escaped in TEXT', ics.escapeText('a:b'), 'a:b')

  for (const value of ['a,b', 'a;b', 'a\\b', 'a\nb', 'plain', 'a\\,b;c', '春节, 调休']) {
    eq(`escaping: round trip of ${JSON.stringify(value)}`,
       ics.unescapeText(ics.escapeText(value)),
       value.replace(/\r\n/g, '\n'))
  }
}

// ===========================================================================
// Writing
// ===========================================================================

const holidayCal = {
  weekend: [0, 6],
  holidays: ['2026-10-01', '2026-10-02', '2026-10-03'],
  workdays: ['2026-10-10'],
}

let file = ''
if (present('writing: buildIcs is exported', ics.buildIcs) &&
    present('writing: calendarToEvents is exported', ics.calendarToEvents)) {
  const events = ics.calendarToEvents(holidayCal, {
    nameFor: (iso) => (iso === '2026-10-01' ? '国庆节, 第一天' : undefined),
    holidayLabel: 'Day off',
    workdayLabel: 'Make-up workday',
  })
  file = ics.buildIcs(events, { name: 'Working calendar', now: NOW })

  ok('writing: every line break is CRLF', !/(^|[^\r])\n/.test(file))
  ok('writing: the file ends with CRLF', file.endsWith('\r\n'))
  ok('writing: it opens with BEGIN:VCALENDAR', file.startsWith('BEGIN:VCALENDAR\r\n'))
  ok('writing: it closes with END:VCALENDAR', file.trimEnd().endsWith('END:VCALENDAR'))
  ok('writing: VERSION:2.0 is present', file.includes('VERSION:2.0\r\n'))
  ok('writing: a PRODID is present', /PRODID:[^\r\n]+/.test(file))
  ok('writing: every VEVENT has a UID', (file.match(/BEGIN:VEVENT/g) ?? []).length === (file.match(/\r\nUID:/g) ?? []).length)
  ok('writing: every VEVENT has a DTSTAMP', (file.match(/BEGIN:VEVENT/g) ?? []).length === (file.match(/\r\nDTSTAMP:/g) ?? []).length)

  ok('writing: a holiday is an all-day DATE value', file.includes('DTSTART;VALUE=DATE:20261001'))
  ok('writing: and it is NOT written as midnight', !file.includes('DTSTART:20261001T000000'))
  ok('writing: the all-day DTEND is the following day (exclusive)', file.includes('DTEND;VALUE=DATE:20261002'))
  ok('writing: a name containing a comma is escaped', file.includes('SUMMARY:国庆节\\, 第一天'))
  ok('writing: a day off is TRANSPARENT', file.includes('TRANSP:TRANSPARENT'))
  ok('writing: our own files mark which list a date came from', file.includes('X-AEVISTLE-KIND:HOLIDAY'))
  ok('writing: and mark make-up days differently', file.includes('X-AEVISTLE-KIND:WORKDAY'))

  ok(
    'writing: no physical line exceeds 75 octets',
    file.split('\r\n').every((l) => bytes(l) <= 75),
  )
}

// ===========================================================================
// Reading our own file back — the round trip
// ===========================================================================

if (present('reading: parseIcs is exported', ics.parseIcs)) {
  const back = ics.parseIcs(file)
  eq('round trip: every event survives', back.events.length, 4)
  eq('round trip: the calendar name survives', back.calendarName, 'Working calendar')
  const first = ev('round trip: the first event exists', back)
  eq('round trip: the escaped comma is restored', first.summary, '国庆节, 第一天')

  const dates = ics.eventsToCalendarDates(back.events)
  eq('round trip: the holidays come back identical', dates.holidays, holidayCal.holidays)
  eq('round trip: the make-up workdays come back identical', dates.workdays, holidayCal.workdays)
  eq('round trip: nothing was misfiled between the two lists', dates.holidays.includes('2026-10-10'), false)
  eq('round trip: no warnings on our own file', back.warnings, [])

  // The B4 bug, in this module: an all-day date read as an instant.
  eq('round trip: an all-day value stays a date, not an instant', first.start.kind, 'date')
  eq('round trip: and it is the date that was written', first.start.date, '2026-10-01')
}

// ===========================================================================
// Reading what other calendars emit
// ===========================================================================

const CRLF = '\r\n'
const wrap = (body) => `BEGIN:VCALENDAR${CRLF}VERSION:2.0${CRLF}PRODID:-//Test//EN${CRLF}${body}${CRLF}END:VCALENDAR${CRLF}`

{
  // Lone LF, a BOM, and a lowercase property name — all three appear in the wild.
  const loose = '﻿' + wrap(
    ['BEGIN:VEVENT', 'UID:a@x', 'DTSTART;VALUE=DATE:20261225', 'SUMMARY:Christmas', 'END:VEVENT'].join(CRLF),
  ).replace(/\r\n/g, '\n')
  const parsed = ics.parseIcs(loose)
  eq('wild: a lone-LF file with a BOM still parses', parsed.events.length, 1)
  eq('wild: and the date is right', ev('wild: the lone-LF event exists', parsed).start.date, '2026-12-25')
}

{
  // A quoted parameter containing a colon — the character the property split
  // looks for.
  const quoted = wrap(
    [
      'BEGIN:VEVENT',
      'UID:b@x',
      'DTSTART;TZID="GMT+08:00";VALUE=DATE:20261001',
      'ATTENDEE;CN="Doe, John":mailto:j@example.com',
      'SUMMARY:Quoted',
      'END:VEVENT',
    ].join(CRLF),
  )
  const parsed = ics.parseIcs(quoted)
  eq('wild: a quoted param containing a colon does not truncate the value', parsed.events.length, 1)
  eq('wild: and the date is still read', ev('wild: the quoted-param event exists', parsed).start.date, '2026-10-01')
}

{
  // TZID against a real zone. 2026-07-01T09:00 in Asia/Shanghai is 01:00 UTC.
  const tz = wrap(
    ['BEGIN:VEVENT', 'UID:c@x', 'DTSTART;TZID=Asia/Shanghai:20260701T090000', 'SUMMARY:Zoned', 'END:VEVENT'].join(CRLF),
  )
  const parsed = ics.parseIcs(tz)
  const zoned = ev('wild: the TZID event exists', parsed)
  eq('wild: a TZID event resolves to an instant', zoned.start.kind, 'instant')
  eq('wild: Asia/Shanghai 09:00 is 01:00 UTC', isoOrNull(zoned.start.at), '2026-07-01T01:00:00.000Z')

  // And across a DST boundary in a zone that has one: 2026-07-01T09:00 in
  // New York is 13:00 UTC (EDT), while 2026-01-01T09:00 is 14:00 UTC (EST).
  const dst = wrap(
    [
      'BEGIN:VEVENT', 'UID:d1@x', 'DTSTART;TZID=America/New_York:20260701T090000', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d2@x', 'DTSTART;TZID=America/New_York:20260101T090000', 'END:VEVENT',
    ].join(CRLF),
  )
  const both = ics.parseIcs(dst)
  eq('wild: summer time is honoured', isoOrNull(ev('wild: the summer event exists', both, 0).start.at), '2026-07-01T13:00:00.000Z')
  eq('wild: and winter time is a different offset', isoOrNull(ev('wild: the winter event exists', both, 1).start.at), '2026-01-01T14:00:00.000Z')
}

{
  // A zone the engine has never heard of must not lose the event.
  const bogus = wrap(
    ['BEGIN:VEVENT', 'UID:e@x', 'DTSTART;TZID=Middle/Earth:20260701T090000', 'END:VEVENT'].join(CRLF),
  )
  const parsed = ics.parseIcs(bogus)
  eq('wild: an unknown zone still yields an event', parsed.events.length, 1)
  eq('wild: read as floating local time', ev('wild: the unknown-zone event exists', parsed).start.kind, 'floating')
  ok('wild: and the reader is told', parsed.warnings.some((w) => /Middle\/Earth/.test(w)))
}

{
  // VTIMEZONE and VALARM must be stepped over, not read as events.
  const noisy = wrap(
    [
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Paris',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700329T020000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:f@x',
      'DTSTART:20260701T090000Z',
      'SUMMARY:Real',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'END:VALARM',
      'END:VEVENT',
    ].join(CRLF),
  )
  const parsed = ics.parseIcs(noisy)
  eq('wild: VTIMEZONE and VALARM do not become events', parsed.events.length, 1)
  const real = ev('wild: the event beside VTIMEZONE exists', parsed)
  eq('wild: the real event survives them', real.summary, 'Real')
  eq('wild: a UTC instant round-trips', isoOrNull(real.start.at), '2026-07-01T09:00:00.000Z')
}

{
  // DURATION instead of DTEND.
  const dur = wrap(
    ['BEGIN:VEVENT', 'UID:g@x', 'DTSTART:20260701T090000Z', 'DURATION:PT1H30M', 'END:VEVENT'].join(CRLF),
  )
  const parsed = ics.parseIcs(dur)
  const durEvent = ev('wild: the DURATION event exists', parsed)
  eq('wild: DURATION is honoured when DTEND is absent',
     (durEvent.end?.at ?? 0) - (durEvent.start?.at ?? 0), 90 * 60_000)
  eq('wild: parseDuration reads weeks and days', ics.parseDuration('P1W2D'), 9 * 86_400_000)
  eq('wild: and refuses a non-duration', ics.parseDuration('tomorrow'), null)
}

{
  // A multi-day all-day event covers every day it spans, DTEND exclusive.
  const span = wrap(
    [
      'BEGIN:VEVENT',
      'UID:h@x',
      'DTSTART;VALUE=DATE:20261224',
      'DTEND;VALUE=DATE:20261227',
      'SUMMARY:Christmas break',
      'END:VEVENT',
    ].join(CRLF),
  )
  const dates = ics.eventsToCalendarDates(ics.parseIcs(span).events)
  eq('wild: a multi-day all-day event expands, DTEND exclusive',
     dates.holidays, ['2026-12-24', '2026-12-25', '2026-12-26'])
  eq('wild: and each day carries the event name', dates.named['2026-12-25'], 'Christmas break')
}

{
  // The one that would ruin a calendar: importing an ordinary work diary.
  const meetings = wrap(
    [
      'BEGIN:VEVENT', 'UID:i1@x', 'DTSTART:20260701T140000Z', 'SUMMARY:Standup', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:i2@x', 'DTSTART:20260702T140000Z', 'SUMMARY:Review', 'END:VEVENT',
    ].join(CRLF),
  )
  const dates = ics.eventsToCalendarDates(ics.parseIcs(meetings).events)
  eq('wild: a timed meeting is NOT a day off', dates.holidays, [])
  eq('wild: and the reader is told how many were skipped', dates.skippedTimed, 2)
}

{
  const broken = wrap(['BEGIN:VEVENT', 'UID:j@x', 'SUMMARY:No start', 'END:VEVENT'].join(CRLF))
  const parsed = ics.parseIcs(broken)
  eq('wild: an event with no DTSTART is dropped', parsed.events.length, 0)
  ok('wild: and reported rather than silently lost', parsed.warnings.length > 0)

  const garbage = ics.parseIcs('this is not a calendar at all')
  eq('wild: garbage produces no events', garbage.events.length, 0)
  ok('wild: and says why', garbage.warnings.length > 0)
  eq('wild: an empty string does not throw', ics.parseIcs('').events.length, 0)
}

// ===========================================================================
// RRULE
// ===========================================================================

const baseRec = {
  kind: 'daily',
  startAt: at(2026, 7, 1, 9),
  timeOfDay: '09:00',
  monthDayFallback: 'last',
  endMode: 'never',
  jitterSeconds: 0,
  skipWeekends: false,
  catchUp: 'fireOnce',
}

if (present('rrule: recurrenceToRRule is exported', ics.recurrenceToRRule)) {
  eq('rrule: a one-off has no rule', ics.recurrenceToRRule({ ...baseRec, kind: 'once' }), null)
  eq('rrule: daily', fmt(ics.recurrenceToRRule(baseRec)), 'FREQ=DAILY')
  eq(
    'rrule: weekly names its days',
    fmt(ics.recurrenceToRRule({ ...baseRec, kind: 'weekly', weekdays: [1, 3, 5] })),
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  )
  eq(
    'rrule: monthly names its day of month',
    fmt(ics.recurrenceToRRule({ ...baseRec, kind: 'monthly', dayOfMonth: 15 })),
    'FREQ=MONTHLY;BYMONTHDAY=15',
  )
  eq(
    'rrule: yearly names month and day',
    fmt(ics.recurrenceToRRule({ ...baseRec, kind: 'yearly', month: 9, dayOfMonth: 1 })),
    'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=1',
  )
  eq(
    'rrule: an interval in whole days becomes DAILY;INTERVAL',
    fmt(ics.recurrenceToRRule({ ...baseRec, kind: 'interval', intervalMs: 3 * 86_400_000 })),
    'FREQ=DAILY;INTERVAL=3',
  )
  eq(
    'rrule: a 90-minute interval becomes MINUTELY;INTERVAL',
    fmt(ics.recurrenceToRRule({ ...baseRec, kind: 'interval', intervalMs: 90 * 60_000 })),
    'FREQ=MINUTELY;INTERVAL=90',
  )
  eq(
    'rrule: an end-after-N becomes COUNT',
    fmt(ics.recurrenceToRRule({ ...baseRec, endMode: 'afterCount', maxRuns: 12 })),
    'FREQ=DAILY;COUNT=12',
  )
  ok(
    'rrule: an end-on-date becomes a UTC UNTIL',
    (fmt(ics.recurrenceToRRule({ ...baseRec, endMode: 'onDate', endDate: at(2026, 12, 31, 9) })) ?? '')
      .includes('UNTIL=20261231T170000Z'),
  )

  // The refusals. These are the point.
  eq('rrule: a cron rule is refused, not approximated',
     ics.recurrenceToRRule({ ...baseRec, kind: 'cron', cron: '0 9 1,15 * *' }), null)
  eq('rrule: a sub-second interval is refused',
     ics.recurrenceToRRule({ ...baseRec, kind: 'interval', intervalMs: 250 }), null)
}

if (present('rrule: rruleToRecurrence is exported', ics.rruleToRecurrence)) {
  const trip = (rec) => {
    const rule = ics.recurrenceToRRule(rec)
    if (!rule) return null
    const text = ics.formatRRule(rule)
    const reparsed = ics.parseRRule(text)
    return ics.rruleToRecurrence(reparsed, rec.startAt)
  }

  eq('rrule round trip: daily', trip(baseRec)?.kind, 'daily')
  const weekly = trip({ ...baseRec, kind: 'weekly', weekdays: [1, 3, 5] })
  eq('rrule round trip: weekly keeps its kind', weekly?.kind, 'weekly')
  eq('rrule round trip: weekly keeps its days', weekly?.weekdays, [1, 3, 5])
  eq('rrule round trip: monthly keeps its day', trip({ ...baseRec, kind: 'monthly', dayOfMonth: 15 })?.dayOfMonth, 15)
  const yearly = trip({ ...baseRec, kind: 'yearly', month: 9, dayOfMonth: 1 })
  eq('rrule round trip: yearly keeps its month (0-based in, 0-based out)', yearly?.month, 9)
  eq('rrule round trip: yearly keeps its day', yearly?.dayOfMonth, 1)
  eq('rrule round trip: an interval keeps its length',
     trip({ ...baseRec, kind: 'interval', intervalMs: 3 * 86_400_000 })?.intervalMs, 3 * 86_400_000)
  eq('rrule round trip: COUNT survives',
     trip({ ...baseRec, endMode: 'afterCount', maxRuns: 12 })?.maxRuns, 12)

  // An ordinal BYDAY is a rule this app cannot run; reading it as "every
  // Monday" would send four times a month instead of once.
  eq(
    'rrule: "the second Monday" is refused rather than flattened',
    ics.rruleToRecurrence(ics.parseRRule('FREQ=MONTHLY;BYDAY=2MO'), NOW),
    null,
  )
  const warned = []
  eq('rrule: a rule with no FREQ is refused', ics.parseRRule('INTERVAL=2', (m) => warned.push(m)), null)
  ok('rrule: and says so', warned.length > 0)

  const exotic = ics.parseRRule('FREQ=DAILY;BYSETPOS=1;BYHOUR=9')
  ok('rrule: unsupported parts are listed rather than ignored', (exotic?.unsupported ?? []).length === 2)
}

// ===========================================================================
// Reminders → events
// ===========================================================================

function job(id, recurrence, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    draft: { accountId: 'a', to: ['x@example.com'], cc: [], bcc: [], subject: 'S', body: '', attachments: [] },
    recurrence,
    occurrences: [],
    runCount: 0,
    retry: { maxAttempts: 3, backoffSeconds: 60, backoffFactor: 3 },
    status: 'armed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

if (present('jobs: jobsToEvents is exported', ics.jobsToEvents)) {
  const { events } = ics.jobsToEvents([job('weekly', { ...baseRec, kind: 'weekly', weekdays: [2] })], { now: NOW })
  eq('jobs: a repeating reminder is one recurring event', events.length, 1)
  const recurring = ev('jobs: the recurring event exists', { events })
  eq('jobs: written as floating local time, not a UTC instant', recurring.start.kind, 'floating')
  ok('jobs: and carries its rule', recurring.rrule !== undefined)

  const text = ics.buildIcs(events, { now: NOW })
  ok('jobs: the floating DTSTART has no Z', /DTSTART:20260701T090000\r\n/.test(text))
  ok('jobs: the RRULE is written out', text.includes('RRULE:FREQ=WEEKLY;BYDAY=TU'))

  const once = ics.jobsToEvents([job('once', { ...baseRec, kind: 'once' }, { occurrences: [at(2026, 7, 1, 9)] })], { now: NOW })
  eq('jobs: a one-off is a single instant', ev('jobs: the one-off event exists', once).start.kind, 'instant')
  ok('jobs: written in UTC', ics.buildIcs(once.events, { now: NOW }).includes('DTSTART:20260701T160000Z'))

  const cron = ics.jobsToEvents(
    [job('cron', { ...baseRec, kind: 'cron', cron: '0 9 1,15 * *' }, { occurrences: [at(2026, 7, 1, 9), at(2026, 7, 15, 9)] })],
    { now: NOW },
  )
  eq('jobs: a cron rule is expanded into dated events rather than faked', cron.events.length, 2)
  ok('jobs: and none of them carries an invented RRULE', cron.events.every((e) => e.rrule === undefined))
}

// ===========================================================================

await rm(dir, { recursive: true, force: true })

const label = 'the calendar we write is the calendar that comes back'
if (failures.length === 0) {
  console.log(`\n  ${label}\n  ${checked} checks\n\n  All clear.\n`)
  process.exit(0)
}
console.log(`\n  ${label}\n  ${checked} checks, ${failures.length} failed\n`)
for (const f of failures) console.log(`  FAIL  ${f}`)
console.log('')
process.exit(1)
