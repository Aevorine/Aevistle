/**
 * Reordering a list by hand, by three different means, from one place.
 *
 * The user arranges their mail accounts, and the arrangement has to be the
 * same in Settings (a vertical list of rows) and in the inbox (a horizontal
 * strip of tabs). Those two screens look nothing alike and the gesture is
 * identical, so the gesture lives here and the screens supply only the
 * rendering. What "the same" means is enforced by both of them handing back
 * the same finished sequence of ids to the same reducer action.
 *
 * Three input methods, because one is not enough for any of them:
 *
 *   - **Mouse**: native HTML5 drag and drop, the pattern `MonthGrid` already
 *     uses in this codebase — `draggable` on the grip, a private MIME type on
 *     the `dataTransfer`, `dragover`/`drop` on the rows. It is the only way to
 *     get the operating system's own drag cursor and drag image, and it costs
 *     nothing because the browser runs the whole gesture.
 *
 *   - **Touch**: it has to be its own implementation. HTML5 drag and drop
 *     simply does not start from a finger on Android's WebView — there is no
 *     `dragstart`, ever — and the app's existing `useSwipe` deliberately
 *     ignores mice and is tuned for a two-outcome horizontal flick, which is
 *     the opposite shape of problem from "hold, then travel anywhere, then
 *     land". So: long-press to lift, pointer capture, hit-test under the
 *     finger, and auto-scroll when the finger nears an edge.
 *
 *   - **Keyboard**: Ctrl/Alt/Cmd + arrow on a focused grip, with the new
 *     position said out loud in a live region. This is not a nicety bolted on
 *     afterwards. A list that can *only* be dragged is a list a screen-reader
 *     user cannot arrange at all, and "arrange your accounts" is not an
 *     optional corner of this app — it is how you find your own mailbox.
 *
 * The hook is headless: it owns the gesture and the bookkeeping and returns
 * prop bags. It draws nothing and knows no class names, which is why one copy
 * can serve a list of `.log` rows and a strip of `.segmented__item` buttons.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'

/**
 * The drag payload's MIME type.
 *
 * Private, for the same reason `MonthGrid`'s is: `text/plain` would mean that
 * dropping an account onto the search box pastes `acct_01H8…` into it, and
 * that dragging a word of text *into* the account list would be read as a
 * reorder. A type nothing else claims makes both of those non-events.
 */
export const REORDER_DRAG_TYPE = 'application/x-aevistle-account-order'

/** Which way the list runs, and therefore which arrow keys and which edges. */
export type ReorderAxis = 'vertical' | 'horizontal'

/** How long a finger must rest on the grip before the row lifts. */
const LIFT_DELAY_MS = 320
/** Travel that cancels the pending lift — that was a scroll, not a hold. */
const LIFT_SLOP_PX = 8
/** How close to the scroll container's edge auto-scroll starts. */
const EDGE_ZONE_PX = 56
/** Pixels per frame at the very edge, tapering to zero at the zone's inner rim. */
const EDGE_SPEED_PX = 13

export interface ReorderOptions {
  /**
   * The ids in the order they are currently drawn, top to bottom (or start to
   * end). The *drawn* order, not the stored one: everything here is computed
   * against what the user can see, so a list that is grouped or filtered
   * before rendering must be grouped or filtered before it gets here too.
   */
  ids: string[]
  /** Called with the whole new sequence once a move lands. */
  onReorder: (ids: string[]) => void
  /**
   * Which reorder scope an id belongs to. Ids in different scopes cannot be
   * dropped on each other and cannot be stepped past with the keyboard.
   * Everything is one scope when this is omitted.
   */
  scopeOf?: (id: string) => string
  axis?: ReorderAxis
  /**
   * The sentence read out when a move lands. `position` and `total` are
   * one-based and counted *within the scope*, because "3 of 4" said about a
   * list the user sees as two groups of two is a lie told precisely.
   */
  announce?: (id: string, position: number, total: number) => string
  /** Switch the whole thing off — a one-item list has nothing to arrange. */
  disabled?: boolean
}

export interface ReorderApi {
  /** The id being dragged or lifted right now, for a `data-` attribute. */
  activeId: string | null
  /** The row the indicator is drawn against, and which side of it. */
  dropId: string | null
  dropAfter: boolean
  /** True while a finger is holding a lifted row, as opposed to a mouse drag. */
  lifted: boolean
  /** The live-region text. Render it into an `aria-live="polite"` element. */
  announcement: string
  /** Spread onto each row/tab. Makes it a drop target and a hit-test target. */
  itemProps: (id: string) => Record<string, unknown>
  /** Spread onto the grab handle inside that row/tab. */
  handleProps: (id: string) => Record<string, unknown>
}

/** The sequence with `movedId` pulled out and reinserted next to `targetId`. */
function withMoved(ids: string[], movedId: string, targetId: string, after: boolean): string[] {
  const rest = ids.filter((id) => id !== movedId)
  const at = rest.indexOf(targetId)
  if (at < 0) return ids
  rest.splice(after ? at + 1 : at, 0, movedId)
  return rest
}

/**
 * The nearest ancestor that actually scrolls along `axis`.
 *
 * Both conditions are needed. `overflow: auto` on an element whose content
 * fits does not scroll, so auto-scrolling it would silently do nothing and
 * look like the feature is broken near the edge; and an element that scrolls
 * because the *page* does has no `overflow` of its own to find. Falling back
 * to the scrolling element covers the second case — in this app the inbox
 * strip is its own `overflow-x: auto` box while the Settings list rides the
 * page, so both paths are live at once on the same build.
 */
function scrollParent(node: Element | null, axis: ReorderAxis): Element | null {
  let el: Element | null = node?.parentElement ?? null
  while (el) {
    const style = getComputedStyle(el)
    const overflow = axis === 'vertical' ? style.overflowY : style.overflowX
    const scrolls = overflow === 'auto' || overflow === 'scroll'
    const overflows =
      axis === 'vertical' ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth
    if (scrolls && overflows) return el
    el = el.parentElement
  }
  return document.scrollingElement
}

export function useReorder({
  ids,
  onReorder,
  scopeOf,
  axis = 'vertical',
  announce,
  disabled,
}: ReorderOptions): ReorderApi {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const [lifted, setLifted] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  /*
   * The live values, readable from inside a gesture.
   *
   * A pointer gesture spans many events over several hundred milliseconds and
   * the component re-renders throughout — the parent list re-sorts the instant
   * a move commits. Closing over `ids` in a handler that was created three
   * renders ago is how a drag ends up reordering a snapshot of the list rather
   * than the list, so every handler reads through a ref that an effect keeps
   * current. `activeId` is duplicated the same way: it is state because the
   * rendering depends on it, and a ref because `pointermove` needs it without
   * waiting for a render.
   */
  const idsRef = useRef(ids)
  const scopeRef = useRef(scopeOf)
  const announceRef = useRef(announce)
  const onReorderRef = useRef(onReorder)
  useEffect(() => {
    idsRef.current = ids
    scopeRef.current = scopeOf
    announceRef.current = announce
    onReorderRef.current = onReorder
  })

  const activeRef = useRef<string | null>(null)
  const dropRef = useRef<{ id: string; after: boolean } | null>(null)

  const sameScope = useCallback((a: string, b: string) => {
    const of = scopeRef.current
    return of ? of(a) === of(b) : true
  }, [])

  /**
   * Say where it ended up.
   *
   * The zero-width space is not decoration. Screen readers compare a live
   * region's new text with its old text and stay silent when they match, so
   * moving an account down and straight back up again — the most ordinary
   * thing anybody does while arranging a list — would announce the first move
   * and then nothing at all, leaving the user with no way to tell whether the
   * second keypress registered. Alternating an invisible character makes every
   * announcement textually new while reading identically.
   */
  const say = useCallback((text: string) => {
    setAnnouncement((prev) => (prev.endsWith('​') ? text : `${text}​`))
  }, [])

  const commit = useCallback(
    (next: string[], movedId: string) => {
      const current = idsRef.current
      if (next.length === current.length && next.every((id, i) => id === current[i])) return
      onReorderRef.current(next)
      const sentence = announceRef.current
      if (sentence) {
        const siblings = next.filter((id) => sameScope(id, movedId))
        say(sentence(movedId, siblings.indexOf(movedId) + 1, siblings.length))
      }
    },
    [sameScope, say],
  )

  // --- shared drop bookkeeping ----------------------------------------------

  const setDropTarget = useCallback((next: { id: string; after: boolean } | null) => {
    const prev = dropRef.current
    if (prev?.id === next?.id && prev?.after === next?.after) return
    dropRef.current = next
    setDrop(next)
  }, [])

  const clearGesture = useCallback(() => {
    activeRef.current = null
    dropRef.current = null
    setActiveId(null)
    setDrop(null)
    setLifted(false)
  }, [])

  /**
   * Which half of a row a point falls in, in *logical* terms.
   *
   * `getBoundingClientRect` is physical and the app ships Arabic, so on the
   * horizontal inbox strip under `dir="rtl"` the row that is further right is
   * the row that comes *earlier*. Without the flip, dragging a tab towards the
   * end of the strip in Arabic would move it towards the beginning — and the
   * indicator would appear on the wrong side of the row the whole way, so it
   * would look deliberate rather than broken.
   */
  const dropSideAt = useCallback(
    (row: HTMLElement, x: number, y: number) => {
      const rect = row.getBoundingClientRect()
      if (axis === 'vertical') return y > rect.top + rect.height / 2
      const rtl = getComputedStyle(row).direction === 'rtl'
      const past = x > rect.left + rect.width / 2
      return rtl ? !past : past
    },
    [axis],
  )

  /** The reorderable row under a point, if it is one we may drop on. */
  const rowAt = useCallback(
    (x: number, y: number, movedId: string) => {
      const hit = document.elementFromPoint(x, y)
      const row = hit?.closest<HTMLElement>('[data-reorder-id]') ?? null
      const id = row?.dataset.reorderId
      if (!row || !id || id === movedId || !sameScope(id, movedId)) return null
      return { row, id }
    },
    [sameScope],
  )

  // --- mouse: native HTML5 drag and drop ------------------------------------

  const onDragStart = useCallback(
    (event: ReactDragEvent<HTMLElement>, id: string) => {
      event.dataTransfer.setData(REORDER_DRAG_TYPE, id)
      event.dataTransfer.effectAllowed = 'move'
      /*
       * Drag the row, not the grip. Left alone the browser snapshots the
       * element that carries `draggable`, which here is a 26px handle — so the
       * thing following the cursor would be a pair of dots with no indication
       * of which account is in flight, in a list where every row differs only
       * by the text the snapshot left behind.
       */
      const row = event.currentTarget.closest<HTMLElement>('[data-reorder-id]')
      if (row) {
        const rect = row.getBoundingClientRect()
        event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top)
      }
      activeRef.current = id
      setActiveId(id)
    },
    [],
  )

  const onDragOverItem = useCallback(
    (event: ReactDragEvent<HTMLElement>, id: string) => {
      const moved = activeRef.current
      if (!moved || moved === id || !sameScope(id, moved)) return
      if (!event.dataTransfer.types.includes(REORDER_DRAG_TYPE)) return
      // Without both of these the browser refuses the drop and plays the
      // "snap back" animation, which reads as the app rejecting the move.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget({ id, after: dropSideAt(event.currentTarget, event.clientX, event.clientY) })
    },
    [dropSideAt, sameScope, setDropTarget],
  )

  const onDropItem = useCallback(
    (event: ReactDragEvent<HTMLElement>, id: string) => {
      const moved = event.dataTransfer.getData(REORDER_DRAG_TYPE)
      const target = dropRef.current
      clearGesture()
      if (!moved || moved === id || !sameScope(id, moved)) return
      event.preventDefault()
      // A tab is a button and a row holds buttons; letting the drop bubble on
      // would also fire whatever is underneath, so the account you just moved
      // would become the filter, or worse, open its editor.
      event.stopPropagation()
      commit(withMoved(idsRef.current, moved, id, target?.id === id ? target.after : false), moved)
    },
    [clearGesture, commit, sameScope],
  )

  // --- touch: long-press to lift --------------------------------------------

  /** The finger that might become a drag, before the hold has been earned. */
  const pressRef = useRef<{ id: string; pointerId: number; x: number; y: number; timer: number } | null>(
    null,
  )
  /**
   * The finger that *is* the drag, once the hold has been earned.
   *
   * Its whole reason for existing is that the two gesture systems overlap on
   * the same element. Starting an HTML5 drag makes the browser fire
   * `pointercancel` at whatever had the pointer — which is this grip, because
   * that is where the mouse button went down. An unguarded `pointercancel`
   * handler therefore tore down the drag it had just started: `activeId` went
   * back to null, so every `dragover` after it declined to `preventDefault`,
   * so Chromium refused the drop and played the snap-back. It was worse than a
   * dead feature because it was an *intermittent* one — whether the cancel
   * arrived before or after the first `dragover` decided whether that
   * particular drag worked, which is how it survived the first round of
   * testing on the same code path it later failed on.
   *
   * So the pointer handlers now answer only for a pointer they are actually
   * holding, by id. A mouse never gets one, and the two systems stop being
   * able to see each other at all.
   */
  const liftRef = useRef<{ id: string; pointerId: number } | null>(null)
  /** Where the finger is now, read by the auto-scroll frame. */
  const pointRef = useRef<{ x: number; y: number } | null>(null)
  const scrollerRef = useRef<Element | null>(null)
  const rafRef = useRef(0)

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    scrollerRef.current = null
    pointRef.current = null
  }, [])

  /**
   * Creep the list along while the finger sits near an edge.
   *
   * A phone shows four or five account rows. Without this, reordering is
   * limited to the rows that happen to be on screen when you pick one up —
   * moving your default account from the bottom of eight to the top would be
   * impossible, and impossible in the silent way where the finger reaches the
   * edge of the glass and simply stops.
   *
   * The hover target is recomputed on every frame rather than only on
   * `pointermove`, because during auto-scroll the finger is deliberately
   * still: the rows slide underneath it, so the row beneath the finger changes
   * with no pointer event to notice it by.
   */
  const autoScrollFrame = useCallback(() => {
    const point = pointRef.current
    const scroller = scrollerRef.current
    const moved = activeRef.current
    if (!point || !scroller || !moved) {
      rafRef.current = 0
      return
    }

    const root = scroller === document.scrollingElement
    const rect = root
      ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      : scroller.getBoundingClientRect()

    const near = (from: number, to: number) => (from - to) / EDGE_ZONE_PX
    let delta = 0
    if (axis === 'vertical') {
      if (point.y < rect.top + EDGE_ZONE_PX) delta = -EDGE_SPEED_PX * near(rect.top + EDGE_ZONE_PX, point.y)
      else if (point.y > rect.bottom - EDGE_ZONE_PX)
        delta = EDGE_SPEED_PX * near(point.y, rect.bottom - EDGE_ZONE_PX)
      if (delta) scroller.scrollTop += delta
    } else {
      if (point.x < rect.left + EDGE_ZONE_PX) delta = -EDGE_SPEED_PX * near(rect.left + EDGE_ZONE_PX, point.x)
      else if (point.x > rect.right - EDGE_ZONE_PX)
        delta = EDGE_SPEED_PX * near(point.x, rect.right - EDGE_ZONE_PX)
      if (delta) scroller.scrollLeft += delta
    }

    const hit = rowAt(point.x, point.y, moved)
    // Only a *new* answer replaces the indicator. Leaving it where it was when
    // the finger is over the lifted row itself, or off the list entirely, is
    // what stops the line flickering out every time the finger crosses its own
    // row on the way past.
    if (hit) setDropTarget({ id: hit.id, after: dropSideAt(hit.row, point.x, point.y) })

    rafRef.current = requestAnimationFrame(autoScrollFrame)
  }, [axis, dropSideAt, rowAt, setDropTarget])

  const cancelPendingLift = useCallback(() => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string) => {
      // The mouse already has a drag implementation, and it is the browser's.
      // Running both would start an HTML5 drag and a long-press lift from the
      // same button press and leave two indicators fighting over one list.
      if (event.pointerType === 'mouse') return
      const handle = event.currentTarget
      const pointerId = event.pointerId
      cancelPendingLift()
      const timer = window.setTimeout(() => {
        pressRef.current = null
        /*
         * Capture *after* the hold, not before. Taking the pointer at
         * `pointerdown` would mean every touch that lands on the grip is the
         * gesture's, including the ones that turn out to be a tap or a scroll
         * attempt, and a released capture does not hand the gesture back to
         * the page.
         */
        try {
          handle.setPointerCapture(pointerId)
        } catch {
          // Safari throws if the pointer is already gone. Nothing to capture,
          // nothing to clean up — the lift below simply ends at the first
          // `pointerup` that never comes, which `pointercancel` handles.
        }
        liftRef.current = { id, pointerId }
        activeRef.current = id
        setActiveId(id)
        setLifted(true)
        scrollerRef.current = scrollParent(handle, axis)
        pointRef.current = { x: event.clientX, y: event.clientY }
        if (!rafRef.current) rafRef.current = requestAnimationFrame(autoScrollFrame)
      }, LIFT_DELAY_MS)
      pressRef.current = { id, pointerId, x: event.clientX, y: event.clientY, timer }
    },
    [autoScrollFrame, axis, cancelPendingLift],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pending = pressRef.current
      if (pending && pending.pointerId === event.pointerId) {
        // Travelled before the hold was earned. That is somebody trying to
        // scroll the page with their thumb on the grip, and turning it into a
        // reorder would rearrange their accounts by accident.
        const far =
          Math.abs(event.clientX - pending.x) > LIFT_SLOP_PX ||
          Math.abs(event.clientY - pending.y) > LIFT_SLOP_PX
        if (far) cancelPendingLift()
        return
      }
      const lift = liftRef.current
      if (!lift || lift.pointerId !== event.pointerId) return
      const moved = lift.id
      pointRef.current = { x: event.clientX, y: event.clientY }
      const hit = rowAt(event.clientX, event.clientY, moved)
      if (hit) setDropTarget({ id: hit.id, after: dropSideAt(hit.row, event.clientX, event.clientY) })
    },
    [cancelPendingLift, dropSideAt, rowAt, setDropTarget],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pending = pressRef.current
      if (pending && pending.pointerId === event.pointerId) cancelPendingLift()
      const lift = liftRef.current
      // Not our pointer — most often the mouse button that just started an
      // HTML5 drag, whose teardown belongs to `dragend` and not to us.
      if (!lift || lift.pointerId !== event.pointerId) return
      const moved = lift.id
      const target = dropRef.current
      liftRef.current = null
      stopAutoScroll()
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Already released, or never taken. Either way there is nothing left
        // to hold, and throwing here would skip the state cleanup below.
      }
      clearGesture()
      if (!target || target.id === moved) return
      commit(withMoved(idsRef.current, moved, target.id, target.after), moved)
    },
    [cancelPendingLift, clearGesture, commit, stopAutoScroll],
  )

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const pending = pressRef.current
      if (pending && pending.pointerId === event.pointerId) cancelPendingLift()
      const lift = liftRef.current
      if (!lift || lift.pointerId !== event.pointerId) return
      liftRef.current = null
      stopAutoScroll()
      clearGesture()
    },
    [cancelPendingLift, clearGesture, stopAutoScroll],
  )

  // A gesture that outlives its component would leave a `requestAnimationFrame`
  // loop reading a ref nobody updates any more — one frame callback per second
  // for as long as the tab is open, forever.
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (pressRef.current) window.clearTimeout(pressRef.current.timer)
  }, [])

  // --- keyboard --------------------------------------------------------------

  /**
   * One step along the list, staying inside the scope.
   *
   * Stepping is defined over the *siblings* — the ids that share a scope —
   * rather than over the whole sequence, so pressing down on the last account
   * of a group does nothing instead of quietly attempting a move into the next
   * group that the drop rules would have refused from a pointer.
   */
  const step = useCallback(
    (id: string, delta: number) => {
      const list = idsRef.current
      const siblings = list.filter((other) => sameScope(other, id))
      const at = siblings.indexOf(id)
      const to = at + delta
      if (at < 0 || to < 0 || to >= siblings.length) return false
      commit(withMoved(list, id, siblings[to], delta > 0), id)
      return true
    },
    [commit, sameScope],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, id: string) => {
      // Any of the three, because there is no one modifier that is free and
      // familiar on Windows, macOS and a Chromebook at the same time — and a
      // bare arrow key belongs to whatever is moving focus around the list.
      if (!event.ctrlKey && !event.altKey && !event.metaKey) return
      const forwardKey = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight'
      const backKey = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
      let delta = 0
      if (event.key === forwardKey) delta = 1
      else if (event.key === backKey) delta = -1
      else return
      // Right means backwards when the page is laid out right to left, exactly
      // as it does for the pointer a few functions up.
      if (axis === 'horizontal' && getComputedStyle(event.currentTarget).direction === 'rtl') {
        delta = -delta
      }
      // Claimed unconditionally, whether or not the move was possible: an
      // Alt+Arrow that falls through scrolls the page out from under the row
      // the user is holding onto, which is worse than a keypress that does
      // nothing at the end of a list.
      event.preventDefault()
      event.stopPropagation()
      step(id, delta)
    },
    [axis, step],
  )

  // --- prop bags -------------------------------------------------------------

  const itemProps = useCallback(
    (id: string) => {
      if (disabled) return {}
      return {
        'data-reorder-id': id,
        'data-reorder-active': activeId === id || undefined,
        'data-reorder-drop': drop?.id === id ? (drop.after ? 'after' : 'before') : undefined,
        onDragOver: (event: ReactDragEvent<HTMLElement>) => onDragOverItem(event, id),
        onDrop: (event: ReactDragEvent<HTMLElement>) => onDropItem(event, id),
      }
    },
    [activeId, disabled, drop, onDragOverItem, onDropItem],
  )

  const handleProps = useCallback(
    (id: string) => {
      if (disabled) return { hidden: true, disabled: true }
      return {
        draggable: true,
        onDragStart: (event: ReactDragEvent<HTMLElement>) => onDragStart(event, id),
        onDragEnd: clearGesture,
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onPointerDown(event, id),
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        // Android pops a text-selection menu on a long press over anything it
        // considers content, which lands on top of the row being lifted. The
        // CSS half of the fix (`user-select`, `touch-action`) is on
        // `.reorder-handle`; this is the half the stylesheet cannot do.
        onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
        onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => onKeyDown(event, id),
      }
    },
    [clearGesture, disabled, onDragStart, onKeyDown, onPointerCancel, onPointerDown, onPointerMove, onPointerUp],
  )

  return {
    activeId,
    dropId: drop?.id ?? null,
    dropAfter: drop?.after ?? false,
    lifted,
    announcement,
    itemProps,
    handleProps,
  }
}
