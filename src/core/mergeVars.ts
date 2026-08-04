/**
 * Template variables and mail merge.
 *
 * One message written once, personalised per recipient: `{{name}}` becomes the
 * contact's name, `{{email}}` their address, and anything you put in a
 * contact's custom fields becomes a variable of that name.
 *
 * Two deliberate limits:
 *
 * - **Substitution is literal, never evaluated.** `{{name}}` is a lookup in a
 *   plain object and nothing else — no expressions, no function calls, no
 *   nested templates. A mail merge that can run code is a mail merge that can
 *   be handed a malicious contact list.
 * - **An unknown variable is left standing, not blanked.** `{{nmae}}` arriving
 *   as `{{nmae}}` in the preview is how you find the typo; arriving as an empty
 *   string is how you send forty people a letter starting "Dear ,".
 */

import type { Contact, MessageDraft } from './types'
import {
  addIsoDays,
  isWorkingDayIso,
  toIsoDate,
  type IsoDate,
  type WorkCalendar,
} from './workCalendar'

/** `{{ name }}` — braces doubled, whitespace tolerated, word characters only. */
const TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

export interface MergeVars {
  [name: string]: string
}

/** Variables every merge has, regardless of what the contact list carries. */
export function builtinVars(now = Date.now(), locale = 'en'): MergeVars {
  const d = new Date(now)
  const two = (n: number) => (n < 10 ? `0${n}` : String(n))
  return {
    date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    time: `${two(d.getHours())}:${two(d.getMinutes())}`,
    year: String(d.getFullYear()),
    month: two(d.getMonth() + 1),
    day: two(d.getDate()),
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d),
  }
}

/**
 * How far ahead the calendar variables will look before giving up.
 *
 * A year and a bit. A calendar with every day marked as a holiday would
 * otherwise send `nextWorkday` scanning forever, and the honest answer to
 * "when is the next working day" on such a calendar is "there isn't one" —
 * which is an empty string, not a hang.
 */
const CALENDAR_HORIZON_DAYS = 400

/**
 * Variables that answer "what is today, on my working calendar?".
 *
 * The point of these is a message whose text depends on the calendar that
 * already decides when it is sent. Without them the calendar can move a
 * reminder onto Monday but the reminder still says "see you tomorrow", and the
 * two halves of the same feature disagree in front of the recipient.
 *
 * Every value is a fact with an obvious rendering — a date, a name, a count.
 * There is deliberately no `{{isWorkday}}`: it would have to render as a word,
 * that word would have to be translated, and a merge variable is inserted into
 * a message whose language this module does not know. Counts and dates carry
 * across all six locales unchanged.
 *
 * An empty string is a real answer here, not a failure. `{{holiday}}` on an
 * ordinary Tuesday is empty because there is no holiday, and "祝你{{holiday}}
 * 快乐" collapsing to "祝你快乐" is better than it rendering the token. That is
 * the one place this module departs from "unknown variables are left standing"
 * — and it is not a departure, because the variable is known; its value is
 * just empty.
 *
 * @param names Holiday names by date, where they are known. The generic
 *   `WorkCalendar` stores dates without names, so `{{holiday}}` is only ever
 *   non-empty for a calendar built from a named source — the Chinese statutory
 *   tables, or an imported ICS with summaries.
 */
export function calendarVars(
  now: number,
  cal: WorkCalendar,
  names: Map<IsoDate, string> = new Map(),
): MergeVars {
  const today = toIsoDate(now)

  const scan = (from: IsoDate, step: 1 | -1, want: (iso: IsoDate) => boolean): IsoDate => {
    for (let i = 1; i <= CALENDAR_HORIZON_DAYS; i++) {
      const probe = addIsoDays(from, i * step)
      if (want(probe)) return probe
    }
    return ''
  }

  const working = (iso: IsoDate) => isWorkingDayIso(iso, cal)
  const offDay = (iso: IsoDate) => !isWorkingDayIso(iso, cal)

  const nextWorkday = scan(today, 1, working)
  const prevWorkday = scan(today, -1, working)
  const nextHolidayDate = scan(today, 1, (iso) => cal.holidays.includes(iso))
  // The next day off is not the next *holiday*: a weekend is a day off nobody
  // announces. Both are offered because "see you after the weekend" and "see
  // you after Spring Festival" are different sentences.
  const nextDayOff = scan(today, 1, offDay)

  const countUntil = (endExclusive: IsoDate): string => {
    if (!endExclusive) return ''
    let n = 0
    for (let i = 0; i < CALENDAR_HORIZON_DAYS; i++) {
      const probe = addIsoDays(today, i)
      if (probe >= endExclusive) break
      if (working(probe)) n++
    }
    return String(n)
  }

  const daysBetween = (from: IsoDate, to: IsoDate): string => {
    if (!to) return ''
    for (let i = 0; i <= CALENDAR_HORIZON_DAYS; i++) {
      if (addIsoDays(from, i) === to) return String(i)
    }
    return ''
  }

  // The end of the ISO week (Monday-based), so "workdays left this week"
  // means what a working week means rather than what a Sunday-first grid does.
  const d = new Date(now)
  const dow = (d.getDay() + 6) % 7 // 0 = Monday
  const weekEnd = addIsoDays(today, 7 - dow)
  const monthEnd = toIsoDate(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime())

  return {
    today,
    holiday: names.get(today) ?? '',
    nextWorkday,
    prevWorkday,
    nextDayOff,
    nextHoliday: nextHolidayDate ? (names.get(nextHolidayDate) ?? '') : '',
    nextHolidayDate,
    daysToNextHoliday: daysBetween(today, nextHolidayDate),
    daysToNextDayOff: daysBetween(today, nextDayOff),
    workdaysLeftThisWeek: countUntil(weekEnd),
    workdaysLeftThisMonth: countUntil(monthEnd),
  }
}

/**
 * Everything a single recipient's message can refer to.
 *
 * `address` is always defined — it is the one thing a recipient is guaranteed
 * to have. `name` falls back to the local part of the address rather than to
 * an empty string, so "Hi {{name}}" degrades to "Hi lena" instead of "Hi".
 */
export function varsForRecipient(
  address: string,
  contact: Contact | undefined,
  extra: MergeVars = {},
): MergeVars {
  const local = address.split('@')[0] ?? address
  return {
    ...extra,
    ...(contact?.fields ?? {}),
    email: address,
    address,
    name: contact?.name?.trim() || local,
    firstName: (contact?.name?.trim() || local).split(/\s+/)[0],
    note: contact?.note ?? '',
  }
}

/** Substitute `{{tokens}}`. Unknown names are left exactly as written. */
export function render(text: string, vars: MergeVars): string {
  return text.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  )
}

/** Every distinct variable name used in a piece of text, in first-seen order. */
export function usedVars(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(TOKEN)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** Variables the text asks for that this recipient cannot supply. */
export function missingVars(text: string, vars: MergeVars): string[] {
  return usedVars(text).filter((n) => !Object.prototype.hasOwnProperty.call(vars, n))
}

export interface MergeMessage {
  address: string
  draft: MessageDraft
  /** Names this message could not fill in — surfaced before sending, not after. */
  missing: string[]
}

/**
 * Expand one draft into one message per recipient.
 *
 * Cc and Bcc are dropped from the expanded copies on purpose. A merge sends
 * each person their own letter; carrying the whole Cc list into all forty of
 * them would send the carbon-copied reader forty near-identical messages and
 * leak the recipient list the merge existed to keep private.
 *
 * Returns a single unmodified message when merging is off, so callers have one
 * code path either way.
 */
export function buildMergeMessages(
  draft: MessageDraft,
  contacts: Contact[],
  opts: {
    enabled: boolean
    now?: number
    locale?: string
    /** Supplies the `{{nextWorkday}}` family. Omitted, those variables simply do not exist. */
    calendar?: WorkCalendar
    /** Holiday names by date, for `{{holiday}}` / `{{nextHoliday}}`. */
    holidayNames?: Map<IsoDate, string>
  } = { enabled: true },
): MergeMessage[] {
  const at = opts.now ?? Date.now()
  const base = {
    ...builtinVars(at, opts.locale ?? 'en'),
    // Only when a calendar was supplied. Registering these names with empty
    // values on a caller that has no calendar would turn `{{nextWorkday}}`
    // from a visible typo into a silent blank — the exact failure the
    // leave-unknown-tokens-standing rule exists to prevent.
    ...(opts.calendar ? calendarVars(at, opts.calendar, opts.holidayNames) : {}),
  }

  if (!opts.enabled) {
    const vars = { ...base }
    return [
      {
        address: draft.to.join(', '),
        draft: {
          ...draft,
          subject: render(draft.subject, vars),
          body: render(draft.body, vars),
        },
        missing: [
          ...new Set([
            ...missingVars(draft.subject, vars),
            ...missingVars(draft.body, vars),
          ]),
        ],
      },
    ]
  }

  const byAddress = new Map<string, Contact>()
  for (const c of contacts) byAddress.set(c.address.trim().toLowerCase(), c)

  return draft.to.map((address) => {
    const contact = byAddress.get(address.trim().toLowerCase())
    const vars = varsForRecipient(address, contact, base)
    return {
      address,
      draft: {
        ...draft,
        to: [address],
        cc: [],
        bcc: [],
        subject: render(draft.subject, vars),
        body: render(draft.body, vars),
        individualDelivery: false,
      },
      missing: [
        ...new Set([...missingVars(draft.subject, vars), ...missingVars(draft.body, vars)]),
      ],
    }
  })
}

/** True when the draft contains at least one `{{token}}`. */
export function hasVars(draft: MessageDraft): boolean {
  return usedVars(draft.subject).length > 0 || usedVars(draft.body).length > 0
}
