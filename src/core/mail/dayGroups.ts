/**
 * Where the day changes in a message list.
 *
 * A mailbox scrolled far enough stops being a list and becomes a wall: forty
 * rows of "09:42, 09:31, 09:07" with nothing saying which of them are from
 * this morning and which are from a Tuesday three weeks ago. Every mail client
 * solves this the same way and this one is not going to be clever about it —
 * a sticky separator carrying "Today", "Yesterday", the weekday inside the
 * current week, and the date past that.
 *
 * The whole of the logic is here, away from the view, because the boundary
 * cases are all about calendars rather than about rendering: local midnight,
 * not a 24-hour subtraction; a week that starts where the user's locale says
 * it does; and a list that is already sorted newest-first, which every
 * consumer of this file relies on and none of them should have to re-establish.
 */

/** What a separator says, in a form the view can translate. */
export type DayLabel =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  /** Inside the last seven days: the weekday alone reads better than a date. */
  | { kind: 'weekday'; at: number }
  /** Anything older: the date itself, formatted by the caller's locale. */
  | { kind: 'date'; at: number }

/**
 * Local midnight at the start of the day containing `at`.
 *
 * Built from the date parts rather than by rounding the epoch, because the two
 * disagree exactly where it matters. `Math.floor(at / 86400000) * 86400000` is
 * midnight *UTC*, which is 08:00 in Beijing and 19:00 the previous day in Los
 * Angeles — so a message sent at 22:00 local lands in tomorrow's group for half
 * the world. Daylight-saving transitions break the arithmetic version a second
 * way: two days a year are not 24 hours long.
 */
export function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Whole local days between the two instants — negative when `at` is later. */
export function daysBetween(now: number, at: number): number {
  return Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
}

/**
 * What to call the day `at` falls in.
 *
 * `now` is passed rather than read from the clock so this is testable and so
 * a list rendered once does not disagree with itself halfway down when
 * midnight passes mid-render.
 */
export function dayLabel(at: number, now: number): DayLabel {
  const delta = daysBetween(now, at)
  if (delta <= 0) return { kind: 'today' }
  if (delta === 1) return { kind: 'yesterday' }
  if (delta < 7) return { kind: 'weekday', at }
  return { kind: 'date', at }
}

/** A run of items that share a day, with the separator that heads it. */
export interface DayGroup<T> {
  /** Local midnight of the day — a stable React key, unlike the label. */
  key: number
  label: DayLabel
  items: T[]
}

/**
 * Split an already-sorted list into day runs.
 *
 * Deliberately *not* a sort. The caller's order is the order the user chose
 * (newest first, oldest first, by sender), and re-sorting here would silently
 * override it; grouping a list that is not ordered by date simply produces
 * more groups, which is the honest outcome rather than a wrong one.
 *
 * Returns an empty array for an empty list, so the view's guard is a single
 * `.length` test.
 */
export function groupByDay<T>(items: readonly T[], at: (item: T) => number, now: number): DayGroup<T>[] {
  const out: DayGroup<T>[] = []
  let current: DayGroup<T> | null = null
  for (const item of items) {
    const key = startOfDay(at(item))
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(at(item), now), items: [] }
      out.push(current)
    }
    current.items.push(item)
  }
  return out
}

/**
 * A flat sequence of separators and items, for a list that renders one row at
 * a time.
 *
 * The virtualised list measures and renders rows, not groups — handing it
 * nested arrays would mean it could no longer count its own children, and
 * windowing a nested structure is how a "simple" grouping feature turns into a
 * rewrite of the scroller. Flattening keeps the row count exact and the
 * separator is just another row.
 */
export type DayRow<T> =
  | { type: 'separator'; key: number; label: DayLabel; count: number }
  | { type: 'item'; key: number; item: T }

export function flattenByDay<T>(
  items: readonly T[],
  at: (item: T) => number,
  now: number,
): DayRow<T>[] {
  const rows: DayRow<T>[] = []
  for (const group of groupByDay(items, at, now)) {
    rows.push({ type: 'separator', key: group.key, label: group.label, count: group.items.length })
    for (const item of group.items) rows.push({ type: 'item', key: group.key, item })
  }
  return rows
}
