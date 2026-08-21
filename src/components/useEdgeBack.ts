/**
 * The back gesture: drag in from the leading edge of a full-screen sheet to
 * dismiss it.
 *
 * On a phone the eleven screens that are not bottom-bar tabs open as
 * full-screen sheets from the Home grid, and the only way out was the ✕ in the
 * far corner — the one place on a 390px screen a thumb cannot reach without
 * regripping. The system back button worked (`pushBackHandler`), but a
 * three-button navigation bar is not a given any more: a phone in gesture
 * navigation *is* an edge swipe, and this app was the one surface where that
 * did nothing.
 *
 * ## Why this is separate from `useSwipe`
 *
 * `useSwipe` answers "did this row get swiped", and it is right for a row: the
 * gesture may start anywhere on it, because the whole row is the target. A
 * back gesture is the opposite — it is defined by *where it starts*, and it has
 * to be, or every horizontal drag inside the sheet (a calendar strip, a
 * swipeable message row, a range slider) would fight it. The two share the
 * arithmetic in `core/platform/gestures.ts` and nothing else.
 *
 * ## What it does not do
 *
 * It does not touch vertical scrolling. The axis is locked by `lockAxis`
 * before anything is captured, and a drag that turns out to be vertical is
 * dropped outright rather than watched — the same discipline `useSwipe`
 * records, learned from a long scroll that ended sideways firing an action.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  dragOffset,
  lockAxis,
  resolveSwipe,
  startedAtLeadingEdge,
  type Axis,
} from '../core/platform/gestures'

export interface EdgeBackHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

export function useEdgeBack({
  onBack,
  rtl = false,
  enabled = true,
}: {
  onBack: () => void
  rtl?: boolean
  enabled?: boolean
}): { offset: number; dragging: boolean; handlers: EdgeBackHandlers } {
  const start = useRef<{ x: number; y: number; t: number; width: number } | null>(null)
  const axis = useRef<Axis>('undecided')
  const [offset, setOffset] = useState(0)

  const reset = () => {
    start.current = null
    axis.current = 'undecided'
    setOffset(0)
  }

  const handlers: EdgeBackHandlers = {
    onPointerDown: (e) => {
      /* Mouse excluded for the reason `useSwipe` gives: a pointer has the ✕,
         the Escape key and the palette, and a click that drifts two pixels
         becoming a dismissal would be a surprise rather than a feature. */
      if (!enabled || e.pointerType === 'mouse') return
      const rect = e.currentTarget.getBoundingClientRect()
      if (!startedAtLeadingEdge(e.clientX - rect.left, rect.width, rtl)) return
      start.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, width: rect.width }
      axis.current = 'undecided'
    },
    onPointerMove: (e) => {
      const from = start.current
      if (!from) return
      const dx = e.clientX - from.x
      const dy = e.clientY - from.y

      if (axis.current === 'undecided') {
        axis.current = lockAxis(dx, dy)
        if (axis.current === 'vertical') {
          start.current = null
          return
        }
      }
      if (axis.current !== 'horizontal') return

      /* Only inward counts. A drag that starts at the edge and goes *away*
         from the content is not a back gesture, and letting it move the panel
         the wrong way would pull the sheet off its own leading edge. */
      const inward = rtl ? Math.min(0, dx) : Math.max(0, dx)
      if (inward === 0) return

      if (e.currentTarget.hasPointerCapture?.(e.pointerId) !== true) {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
      setOffset(dragOffset(inward, from.width))
    },
    onPointerUp: (e) => {
      const from = start.current
      if (!from) {
        reset()
        return
      }
      /* `resolveSwipe` calls the inward direction `leading` in both scripts —
         rightward in English, leftward in Arabic — which is exactly the
         direction an edge-back travels. One name, no per-locale branch. */
      const result =
        axis.current === 'horizontal'
          ? resolveSwipe(from, { x: e.clientX, y: e.clientY, t: e.timeStamp }, from.width, rtl)
          : null
      reset()
      if (result === 'leading') onBack()
    },
    onPointerCancel: reset,
  }

  return { offset, dragging: offset !== 0, handlers }
}
