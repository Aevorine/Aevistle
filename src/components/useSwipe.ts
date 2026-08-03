/**
 * Binding the gesture arithmetic in `core/gestures.ts` to real touch events.
 *
 * Everything that decides *whether* a gesture happened lives in that module and
 * is tested without a DOM. This only tracks pointers and moves an element.
 *
 * Pointer events rather than touch events: the same code then works for a
 * stylus and for a mouse drag on a touchscreen laptop, and `setPointerCapture`
 * means a finger that slides off the row still completes the gesture instead of
 * leaving it half-swiped.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { dragOffset, lockAxis, resolveSwipe, type Axis, type SwipeResult } from '../core/gestures'

export interface SwipeHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

export function useSwipe({
  onSwipe,
  rtl = false,
  enabled = true,
}: {
  onSwipe: (direction: NonNullable<SwipeResult>) => void
  rtl?: boolean
  enabled?: boolean
}): { offset: number; handlers: SwipeHandlers } {
  const start = useRef<{ x: number; y: number; t: number; width: number } | null>(null)
  const axis = useRef<Axis>('undecided')
  const [offset, setOffset] = useState(0)

  const reset = () => {
    start.current = null
    axis.current = 'undecided'
    setOffset(0)
  }

  const handlers: SwipeHandlers = {
    onPointerDown: (e) => {
      // Mouse drags are excluded: on the desktop the row already has a
      // right-click menu and buttons, and a click that drifts two pixels
      // becoming a swipe would be a surprise, not a feature.
      if (!enabled || e.pointerType === 'mouse') return
      const rect = e.currentTarget.getBoundingClientRect()
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
        // Locked to vertical: this is a scroll. Let go of it completely rather
        // than continuing to watch, or a long scroll that happens to end
        // sideways would fire an action at the end of it.
        if (axis.current === 'vertical') {
          start.current = null
          return
        }
      }
      if (axis.current !== 'horizontal') return

      // Only now, once the gesture is definitely horizontal, is it ours to
      // capture. Capturing earlier would steal scrolls.
      if (e.currentTarget.hasPointerCapture?.(e.pointerId) !== true) {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
      setOffset(dragOffset(dx, from.width))
    },
    onPointerUp: (e) => {
      const from = start.current
      if (!from) {
        reset()
        return
      }
      const result =
        axis.current === 'horizontal'
          ? resolveSwipe(from, { x: e.clientX, y: e.clientY, t: e.timeStamp }, from.width, rtl)
          : null
      reset()
      if (result) onSwipe(result)
    },
    // A cancelled pointer (a call arriving, the system taking over) must leave
    // the row where it started rather than half-open.
    onPointerCancel: reset,
  }

  return { offset, handlers }
}
