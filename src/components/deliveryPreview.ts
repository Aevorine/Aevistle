/**
 * The part of B3 (送达窗口 / delivery window) that both screens need, kept out
 * of both of them.
 *
 * `core/deliveryWindow.ts` answers "when does this land"; this file answers the
 * two questions a *screen* has on top of that:
 *
 *   1. **Whose windows apply to this draft?** The scheduler already decides
 *      that inside `AppState.shapeOccurrences` via its own `windowsForDraft`,
 *      and the compose screen has to give the same answer or it would report a
 *      send time the scheduler does not use. So the rule is written once, here,
 *      and matched to that helper deliberately: `To:` only — never Cc, never
 *      Bcc — keyed on a trimmed, lower-cased address, in `To:` order so a
 *      landing can be zipped back onto the recipient it belongs to.
 *
 *   2. **What is the consequence?** `applyDeliveryWindows` returns a result
 *      the UI would otherwise have to re-derive twice, differently. `previewFor`
 *      does it once and hands back the two facts a sentence needs: did this
 *      move, and who is it waiting on.
 *
 * Deliberately free of React and of every core module except
 * `core/deliveryWindow` (which itself imports nothing). That is not tidiness:
 * `check:delivery-ui` mirrors these two files into a temp directory and bundles
 * them so the boundary between the UI's shape and the engine can be tested for
 * real, and a third import would drag half the app into that mirror.
 */

import {
  applyDeliveryWindows,
  resolveTimeZone,
  senderTimeZone,
  wallClockIn,
  windowFault,
  type DeliveryWindow,
  type DeliveryWindowFault,
  type DeliveryWindowResult,
} from '../core/schedule/deliveryWindow'
import type { Contact } from '../core/types'

/** A `To:` recipient who has a window, and what to call them on screen. */
export interface WindowedRecipient {
  /** The address exactly as it sits in `To:`. */
  address: string
  /** Display name, falling back to the address — never blank. */
  name: string
  window: DeliveryWindow
}

/**
 * The windows belonging to a draft's `To:` list, in `To:` order.
 *
 * The twin of `windowsForDraft` in `AppState.tsx`. Cc and Bcc are not
 * consulted there and must not be consulted here: a window says when someone
 * should be *reached*, and letting a carbon copy hold up the real recipient's
 * mail would be the tail wagging the dog. If these two ever disagree, the
 * compose screen starts promising a send time the scheduler will not honour.
 */
export function windowsForRecipients(to: string[], contacts: Contact[]): WindowedRecipient[] {
  if (contacts.length === 0 || to.length === 0) return []
  const byAddress = new Map<string, Contact>()
  for (const c of contacts) byAddress.set(c.address.trim().toLowerCase(), c)
  const out: WindowedRecipient[] = []
  for (const address of to) {
    const contact = byAddress.get(address.trim().toLowerCase())
    const window = contact?.deliveryWindow
    if (contact && window) {
      out.push({ address, name: contact.name || contact.address, window })
    }
  }
  return out
}

/** Just the windows, in the order `applyDeliveryWindows` wants them. */
export function windowsOf(entries: WindowedRecipient[]): DeliveryWindow[] {
  return entries.map((e) => e.window)
}

export interface DeliveryPreview {
  /** The engine's own answer, untouched. */
  result: DeliveryWindowResult
  /** The recipients that produced it, index-aligned with `result.perRecipient`. */
  entries: WindowedRecipient[]
  /** The instant the caller asked for. */
  from: number
  /** The instant it becomes. Always finite — a window never cancels a send. */
  at: number
  /** True only when the send time the user chose is not the one that happens. */
  moved: boolean
  /** Who the send is waiting on, when it is waiting on anyone. */
  boundTo?: WindowedRecipient
  /** No single instant serves everyone inside the horizon. Mail still goes out. */
  impossible: boolean
  /** One send cannot serve everyone as well as separate sends would. */
  splitRequired: boolean
  /** True when at least one window is broken, and therefore being ignored. */
  hasFault: boolean
}

/**
 * What honouring these windows does to this instant.
 *
 * Note what `moved` is *not*: it is not `outcome === 'moved'` alone. An
 * `impossible` result also carries the original instant, and a screen that
 * treated the two the same would announce a change that is not happening.
 */
export function previewFor(at: number, entries: WindowedRecipient[]): DeliveryPreview {
  const result = applyDeliveryWindows(at, windowsOf(entries))
  return {
    result,
    entries,
    from: at,
    at: result.at,
    moved: result.outcome === 'moved' && result.at !== at,
    boundTo: result.boundBy === undefined ? undefined : entries[result.boundBy],
    impossible: result.outcome === 'impossible',
    splitRequired: result.splitRequired,
    hasFault: result.perRecipient.some((l) => l.outcome === 'ignored'),
  }
}

/**
 * Is this preview worth interrupting the compose screen for?
 *
 * A window that changes nothing is not news, and a *faulty* window is not news
 * either — the mail goes out at the time on screen, which is exactly what the
 * screen already says. Only a moved send, an unmeetable set of windows, or a
 * split that a single send cannot serve is worth a marker.
 */
export function worthShowing(preview: DeliveryPreview | null): boolean {
  if (preview === null) return false
  return preview.moved || preview.impossible || preview.splitRequired
}

/** What is wrong with this window, or `null`. Re-exported so views import once. */
export function faultOf(window: DeliveryWindow): DeliveryWindowFault | null {
  return windowFault(window)
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * `HH:MM` on the wall clock in `timeZone`, or `null` for a zone this device
 * cannot read.
 *
 * `minutes` can exceed 1439 in this module's own vocabulary (that is how
 * `24:00` is expressed), so the hour is taken modulo 24 rather than trusted.
 */
export function wallTimeIn(at: number, timeZone: string): string | null {
  const wall = wallClockIn(at, timeZone)
  if (wall === null) return null
  return `${pad(Math.floor(wall.minutes / 60) % 24)}:${pad(wall.minutes % 60)}`
}

/** The local weekday there, `0 = Sunday`, matching `DeliveryWindow.days`. */
export function wallWeekdayIn(at: number, timeZone: string): number | null {
  const wall = wallClockIn(at, timeZone)
  return wall === null ? null : wall.weekday
}

/** The zone a window really uses — its own, or the sender's when it is blank. */
export function effectiveZone(window: DeliveryWindow): string {
  return resolveTimeZone(window.timeZone) ?? window.timeZone
}

/** This device's own zone, for labelling the "same as this device" choice. */
export function deviceZone(): string {
  return senderTimeZone()
}

/**
 * The order the seven day buttons are drawn in.
 *
 * Monday first, because the month grid elsewhere in this application is
 * Monday-first and two weekday pickers that disagree about which column is
 * Monday is precisely how somebody ticks the wrong day and finds out a month
 * later. The *values* are `Date#getDay` numbers — `0` is Sunday — which is what
 * `DeliveryWindow.days` stores and what `isInsideWindow` compares against.
 * Drawing order and stored value are two different things and are kept two
 * different things on purpose.
 */
export const DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

/** Tick or untick one weekday, keeping the list sorted and duplicate-free. */
export function toggleDay(days: number[], day: number): number[] {
  const current = Array.isArray(days) ? days : []
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : [...current, day]
  return [...new Set(next)].sort((a, b) => a - b)
}

/** Does this window run past local midnight? Then the ticked day is the evening. */
export function wrapsMidnight(window: DeliveryWindow): boolean {
  const from = String(window.from ?? '')
  const to = String(window.to ?? '')
  if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) return false
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
  }
  return minutes(from) > minutes(to)
}

const MAX_ZONE_ROWS = 120

export interface ZoneMatches {
  /** The rows to draw, already capped. */
  shown: string[]
  /** How many more matched than fit. `0` when everything is on screen. */
  hidden: number
}

/**
 * The zone list, filtered for an in-page picker.
 *
 * Drawn in the page rather than by a `<datalist>` on purpose: Chromium paints a
 * datalist popup as browser chrome *outside the document*, where the page's own
 * CSS cannot reach it and a DOM probe cannot see it — recorded in
 * PROJECT-BRIEF §4 after "every control is at least 16px" and "that list is
 * tiny" were both true at the same time.
 *
 * `_` and `/` are treated as spaces so `new york` finds `America/New_York`, and
 * the result is capped: 430-odd rows is not a list anyone reads, and rendering
 * them all is 430 buttons of layout on every keystroke.
 */
export function filterZones(zones: string[], query: string): ZoneMatches {
  const q = query.trim().toLowerCase().replace(/[_/]+/g, ' ')
  const readable = (zone: string) => zone.toLowerCase().replace(/[_/]+/g, ' ')
  const matched =
    q.length === 0
      ? zones
      : zones.filter((z) => readable(z).includes(q))

  if (q.length === 0) {
    return { shown: matched.slice(0, MAX_ZONE_ROWS), hidden: Math.max(0, matched.length - MAX_ZONE_ROWS) }
  }

  // A city that *starts* with what was typed is almost always the one meant —
  // "sao" should not have to scroll past "America/Sao_Paulo" being ranked with
  // everything that merely contains the letters.
  const ranked = [...matched].sort((a, b) => {
    const cityA = readable(a.slice(a.lastIndexOf('/') + 1))
    const cityB = readable(b.slice(b.lastIndexOf('/') + 1))
    const startsA = cityA.startsWith(q) ? 0 : 1
    const startsB = cityB.startsWith(q) ? 0 : 1
    if (startsA !== startsB) return startsA - startsB
    return a.localeCompare(b)
  })
  return {
    shown: ranked.slice(0, MAX_ZONE_ROWS),
    hidden: Math.max(0, ranked.length - MAX_ZONE_ROWS),
  }
}
