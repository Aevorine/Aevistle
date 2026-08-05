/**
 * "If you drop it here, it lands outside her hours."
 *
 * A reminder dragged across the working calendar moves in the *sender's*
 * days — the grid has no other axis to drop it onto — but a recipient with a
 * stored `deliveryWindow` reads it in their own zone, on their own clock, and
 * dragging Tuesday's 09:00 onto Thursday can just as easily turn "morning for
 * me" into "half past ten at night for them". Nothing about the drop enforces
 * that; `core/deliveryWindow.ts` only ever *reads* windows to reshape a send
 * that has already been scheduled. So the honest thing to do while the
 * pointer is still moving is say so, next to the pointer, and let the person
 * holding the badge decide — never block the drop over it.
 *
 * Positioned from the native `dragover` event's own `clientX`/`clientY`
 * rather than tracked with `pointermove`: the browser stops delivering
 * pointer events for the duration of an HTML5 drag, and `dragover` is the one
 * event that keeps firing with a live cursor position.
 */

import { useLayoutEffect, useRef, useState } from 'react'

export interface DragTimezoneTipProps {
  x: number
  y: number
  /** Already-composed sentences — see `dragWarningLines` in `WorkCalendarView`. */
  lines: string[]
}

/** Kept clear of the cursor so the tip never sits under the hand holding it. */
const OFFSET_X = 16
const OFFSET_Y = 20
/** How close to an edge the box is allowed to land. */
const EDGE = 8

export function DragTimezoneTip({ x, y, lines }: DragTimezoneTipProps) {
  const ref = useRef<HTMLDivElement>(null)
  /**
   * Measured rather than assumed. `position: fixed` contributes no scrollable
   * overflow, so a tip that runs past the right edge or the bottom of the
   * window is not merely awkward — it is unreachable, and the last grid row is
   * the most common drop target there is ("push this to next week"). The
   * sentences wrap to four lines inside 280px, so the height is not knowable
   * without asking.
   */
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
  })

  if (lines.length === 0) return null

  const below = y + OFFSET_Y
  // Flipped above the cursor rather than clamped against the bottom: a tip
  // pinned to the last few pixels of the window would sit under the pointer,
  // which is the one place this may never be.
  const top =
    size.h > 0 && below + size.h > window.innerHeight - EDGE
      ? Math.max(EDGE, y - OFFSET_Y - size.h)
      : below
  const left =
    size.w > 0
      ? Math.max(EDGE, Math.min(x + OFFSET_X, window.innerWidth - size.w - EDGE))
      : x + OFFSET_X

  return (
    <div
      ref={ref}
      className="dragtip"
      role="presentation"
      aria-hidden="true"
      style={{ left, top }}
    >
      {lines.map((line, i) => (
        <div key={i} className="dragtip__line">
          {line}
        </div>
      ))}
    </div>
  )
}
