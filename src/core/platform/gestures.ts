/**
 * Touch gestures, decided arithmetically so they can be tested.
 *
 * The hard part of a swipe is not detecting movement, it is *declining* to.
 * A list that acts on every horizontal drift fires while someone is scrolling,
 * and one that waits too long never fires at all. Three rules, all of which
 * exist because the naive version gets them wrong:
 *
 * - **Direction is decided once, early.** A scroll that wanders sideways must
 *   not turn into a swipe halfway through, so the axis is locked as soon as
 *   the movement is unambiguous and never revisited.
 * - **Distance is relative to the row, not absolute.** 96 px is a third of a
 *   narrow phone and a tenth of a tablet; the same pixel count means two
 *   different gestures on the two devices.
 * - **Speed counts.** A short, fast flick is a deliberate gesture; a long, slow
 *   drag is someone repositioning their thumb. Requiring distance alone makes
 *   the control feel heavy.
 *
 * RTL is handled by the caller passing `rtl` — "leading" and "trailing" are
 * what the actions mean, and in Arabic the leading edge is on the right.
 */

export interface Point {
  x: number
  y: number
  t: number
}

export type Axis = 'undecided' | 'horizontal' | 'vertical'

/** Below this, movement is noise from a tap. */
export const AXIS_LOCK_PX = 10
/** Fraction of the row's width a slow drag has to cover. */
export const SWIPE_FRACTION = 0.25
/** px per millisecond above which a shorter drag still counts. */
export const FLICK_SPEED = 0.5
/** Even a fast flick has to travel this far, or a tap with jitter would fire. */
export const FLICK_MIN_PX = 40

/**
 * Which axis this movement belongs to.
 *
 * `undecided` until one axis clearly leads, so the caller can hold off on both
 * scrolling and swiping rather than guessing and having to undo it.
 */
export function lockAxis(dx: number, dy: number): Axis {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < AXIS_LOCK_PX) return 'undecided'
  // A clear margin rather than a bare comparison: a 45° drag is not a swipe,
  // and treating it as one is how a list starts eating scrolls.
  if (ax > ay * 1.5) return 'horizontal'
  if (ay > ax * 1.5) return 'vertical'
  return 'undecided'
}

export type SwipeResult = 'leading' | 'trailing' | null

/**
 * Did this movement complete a swipe, and in which direction?
 *
 * `width` is the row's own width, so the threshold scales with the device.
 */
export function resolveSwipe(
  from: Point,
  to: Point,
  width: number,
  rtl = false,
): SwipeResult {
  const dx = to.x - from.x
  const dt = Math.max(1, to.t - from.t)
  const distance = Math.abs(dx)
  const speed = distance / dt

  const farEnough = distance >= width * SWIPE_FRACTION
  const fastEnough = speed >= FLICK_SPEED && distance >= FLICK_MIN_PX
  if (!farEnough && !fastEnough) return null

  // Right-to-left flips which physical direction is "leading".
  const towardsTrailing = rtl ? dx > 0 : dx < 0
  return towardsTrailing ? 'trailing' : 'leading'
}

/**
 * How far the row should be visually dragged for a given finger movement.
 *
 * Resistance past the action threshold: the row keeps moving so the gesture
 * still feels live, but slower, which is what tells a thumb it has already
 * done enough without needing to look.
 */
export function dragOffset(dx: number, width: number): number {
  const limit = width * SWIPE_FRACTION
  if (Math.abs(dx) <= limit) return dx
  const excess = Math.abs(dx) - limit
  return Math.sign(dx) * (limit + excess * 0.35)
}

export interface PullState {
  /** How far the indicator should be shown, 0..1. */
  progress: number
  /** True once releasing would trigger a refresh. */
  armed: boolean
}

/** Distance the finger must travel before a pull-to-refresh fires. */
export const PULL_THRESHOLD_PX = 72

/**
 * Pull-to-refresh, but only from a genuine top.
 *
 * `scrollTop` is passed in and checked here rather than assumed by the caller:
 * a pull that fires while the list is scrolled down is the single most
 * annoying version of this gesture, and it happens whenever the check lives
 * somewhere that can go stale.
 */
export function resolvePull(dy: number, scrollTop: number): PullState {
  if (scrollTop > 0 || dy <= 0) return { progress: 0, armed: false }
  // Damped, so the indicator does not shoot to full on a flick.
  const progress = Math.min(1, dy / PULL_THRESHOLD_PX)
  return { progress, armed: dy >= PULL_THRESHOLD_PX }
}
