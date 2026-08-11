/**
 * How busy a day is, as a step on a scale.
 *
 * The month grid tints each square by how many sends land on it. That tint is
 * only information if the mapping from "sends" to "shade" is fixed and
 * knowable, which rules out the obvious implementation:
 *
 *   - **Not relative to the busiest day on screen.** A scale normalised to the
 *     current month re-colours every square whenever one reminder is added,
 *     paused or deleted. The same Tuesday would be "hot" in one month's view
 *     and "cool" in the next with nothing about that Tuesday having changed,
 *     and a colour that means something different every time you look at it is
 *     decoration.
 *   - **Not the raw count.** There is no meaningful difference between eleven
 *     sends and fourteen, and there is no shade that reads as "fourteen". The
 *     badge on the square says the exact number; the tint answers "is this day
 *     a problem", which has about five useful answers.
 *
 * Five steps, because five shades of one accent are as many as stay apart from
 * each other in all six of the app's visual styles, and the top one is
 * open-ended on purpose.
 *
 * `scripts/check-calendar-console.mjs` asserts that the stylesheet defines a
 * tint for every step this can return, and that the tints get monotonically
 * stronger — a sixth step added here with no shade to go with it would be a
 * square that is busier than the darkest one and painted lighter than it.
 */

/** A day with this many sends on it is at least this busy. Ascending. */
export const LOAD_STEPS = [1, 2, 3, 5, 8] as const

/** The highest step. Everything from here up is the same shade. */
export const MAX_LOAD_LEVEL = LOAD_STEPS.length

/**
 * Which step a day's send count falls on — 1…5 — or `undefined` for a day with
 * nothing on it.
 *
 * `undefined` rather than 0 so the grid can leave the attribute off entirely,
 * and the stylesheet never has to paint "no load" as a colour.
 */
export function loadLevel(count: number): number | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined
  let level = 0
  // Five comparisons. Runs once per date that has sends on it, inside the
  // marks memo — never per cell, and never per occurrence.
  for (const step of LOAD_STEPS) {
    if (count >= step) level += 1
  }
  return level
}
