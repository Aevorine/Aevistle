/**
 * Row windowing for the screens that grow without a ceiling — the inbox, the
 * activity log, the schedule, contacts and templates.
 *
 * Measured first, on two thousand activity entries: the screen took 2.0s to
 * appear and dropped every frame while scrolling, because the browser was
 * laying out two thousand rows to show twelve of them.
 *
 * `content-visibility: auto` was tried before this and made it dramatically
 * worse — mounting the same list went from two seconds to over thirty. The
 * cheap trick is not always the cheap trick, which is why the numbers came
 * first. Windowing the rows in JavaScript is what actually works here.
 *
 * Row heights are not uniform: a job carrying a failure message is twice the
 * height of one without, and a log entry with a detail line is taller than one
 * without. So heights start as an estimate and are corrected from the DOM as
 * rows come into view; the scroll offset is a prefix sum over that mixture,
 * which means the scrollbar tightens as you scroll rather than staying wrong.
 *
 * Rows are deliberately *not* wrapped in a measuring div. These lists are flex
 * children of a gapped column, and interposing an element per row would break
 * that layout and every `>` selector aimed at it. Instead the row container's
 * own element children are measured after each render, which needs no wrapper
 * and no change to the markup a caller writes.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export interface VirtualListProps<T> {
  items: T[]
  /** Stable identity per row — the React key, and the key heights cache under. */
  keyOf: (item: T) => string
  /**
   * Height to assume for a row nobody has measured yet. Getting it wrong only
   * costs a scrollbar that resizes as you scroll, but getting it wrong on the
   * first screenful is visible, so pass a typical row rather than the shortest.
   */
  estimate: number
  children: (item: T, index: number) => ReactNode
  /** The scrolling element. In this app that is always `list-pane`. */
  scrollerClassName?: string
  /**
   * Optional chrome that must surround the *whole* list rather than the part
   * of it currently on screen — the card border around the activity log, for
   * instance. It takes the full scroll height, so its border does not collapse
   * around the dozen rows that happen to be rendered.
   */
  surfaceClassName?: string
  /** The element that directly parents the rows: `joblist` and friends. */
  rowsClassName?: string
  /**
   * Rows kept mounted past each edge. Enough that a fast flick does not outrun
   * the scroll handler, few enough that it is still a saving.
   */
  overscan?: number
  /**
   * Under this many rows the list renders whole and none of this runs.
   * Windowing forty rows costs more than it saves, and it would otherwise put
   * a scroll listener and a ResizeObserver behind every short list in the app.
   */
  threshold?: number
}

export function VirtualList<T>({
  items,
  keyOf,
  estimate,
  children,
  scrollerClassName,
  surfaceClassName,
  rowsClassName,
  overscan = 8,
  threshold = 60,
}: VirtualListProps<T>) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string, number>())
  const [version, setVersion] = useState(0)
  const [range, setRange] = useState({ start: 0, end: 0 })

  /**
   * How many measure→re-render passes the current range has spent without
   * settling. See the layout effect for why this exists.
   */
  const settling = useRef(0)

  const windowed = items.length >= threshold

  /**
   * `keyOf` is an inline arrow at all six call sites, so it is a new function
   * on every render of every list screen. Depending on it directly meant
   * `keys`, `offsets` and `recompute` were all rebuilt every render — every
   * `useMemo` below bought exactly nothing, and the effect that subscribes to
   * scrolling tore itself down and built a fresh `ResizeObserver` each time.
   * Holding it in a ref is what makes the memoisation real. It is safe to read
   * during render because it is a pure function of the item.
   */
  const keyOfRef = useRef(keyOf)
  keyOfRef.current = keyOf

  const keys = useMemo(() => items.map((item) => keyOfRef.current(item)), [items])

  /** Running offsets, using measured heights where they exist. */
  const offsets = useMemo(() => {
    const out = new Float64Array(keys.length + 1)
    for (let i = 0; i < keys.length; i++) {
      out[i + 1] = out[i] + (heights.current.get(keys[i]) ?? estimate)
    }
    return out
    // `heights` is a ref and cannot be a dependency; `version` is bumped after
    // a batch of rows reports in and is what re-runs this.
  }, [keys, estimate, version])

  const total = offsets[keys.length]

  const recompute = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !windowed) return
    const top = scroller.scrollTop
    const bottom = top + scroller.clientHeight

    // Binary search, not a scan: at ten thousand rows a linear walk on every
    // scroll event becomes the jank it was meant to remove.
    let lo = 0
    let hi = keys.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= top) lo = mid + 1
      else hi = mid
    }
    let end = lo
    while (end < keys.length && offsets[end] < bottom) end++

    const start = Math.max(0, lo - overscan)
    const stop = Math.min(keys.length, end + overscan)
    setRange((prev) => {
      if (prev.start === start && prev.end === stop) return prev
      // A genuine scroll deserves a fresh measuring budget; the cap below is
      // only meant to catch a range that cannot settle where it is.
      settling.current = 0
      return { start, end: stop }
    })
  }, [keys.length, offsets, overscan, windowed])

  /**
   * Subscribe once per list, not once per render.
   *
   * `ResizeObserver.observe` is specified to deliver a callback immediately,
   * even with nothing resized. Rebuilding the observer on every render
   * therefore scheduled another `recompute` on every render, which could set
   * state, which rendered again — a pump that only stopped when everything
   * else happened to be still. Reading the callback through a ref keeps the
   * subscription alive across renders while still running the current logic.
   */
  const recomputeRef = useRef(recompute)
  recomputeRef.current = recompute

  useEffect(() => {
    if (!windowed) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const run = () => recomputeRef.current()

    /*
     * Scrolling is coalesced to one recompute per frame.
     *
     * A trackpad or a smooth-scrolling wheel delivers scroll events faster than
     * the compositor paints, and each one used to run the binary search and
     * possibly `setRange` synchronously. The search itself is cheap; what is
     * not cheap is the render and the measuring layout effect a range change
     * pulls behind it, and doing that twice inside one frame is work nobody can
     * see. `requestAnimationFrame` also lands the recompute at the moment the
     * new range is about to be painted rather than partway through the frame.
     */
    let frame = 0
    const onScroll = () => {
      // Already scheduled: the later event would compute the same range from
      // the same `scrollTop` read at the same moment.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        recomputeRef.current()
      })
    }

    run()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(run)
    observer.observe(scroller)
    return () => {
      // Unmounting with a frame in flight would run `recompute` against a
      // detached scroller — harmless today, but only by accident.
      if (frame) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [windowed])

  /**
   * Correct the estimated heights from the DOM, after layout and before paint,
   * so a row never shows at its estimate and then snaps to its real height.
   *
   * This used to run with no dependency array at all — after *every* render,
   * including ones caused by something else entirely — and its `setVersion`
   * re-ran it synchronously. That is one half of React's "Maximum update depth
   * exceeded"; the other half was the scroll window sliding out from under a
   * fixed `scrollTop` as the rows above it were corrected, so a new set of
   * unmeasured rows entered on every pass and there was always something left
   * to change. Two things stop it now: the offsets above the window are
   * compensated for in `scrollTop`, so the content stays put and the range
   * stops moving; and if a range somehow still has not settled after a handful
   * of passes, measuring stops rather than taking the whole app down.
   */
  useLayoutEffect(() => {
    if (!windowed) return
    const container = rowsRef.current
    if (!container) return

    const gap = parseFloat(getComputedStyle(container).rowGap) || 0
    let changed = false
    const kids = container.children
    for (let i = 0; i < kids.length; i++) {
      const key = keys[range.start + i]
      if (key === undefined) break
      const height = (kids[i] as HTMLElement).getBoundingClientRect().height + gap
      if (!height) continue
      const known = heights.current.get(key)
      // 1.5px rather than 0.5: a scrollbar appearing, or text rewrapping by a
      // fraction, is not a row that changed height, and treating it as one is
      // what kept the loop fed.
      if (known === undefined || Math.abs(known - height) > 1.5) {
        heights.current.set(key, height)
        changed = true
      }
    }

    if (!changed) {
      settling.current = 0
      return
    }

    // Hold the content still. Correcting the heights of rows *above* the
    // window moves everything below them, and without this the same pixels
    // would show a different row after every correction.
    const scroller = scrollerRef.current
    if (scroller) {
      let corrected = 0
      for (let i = 0; i < range.start; i++) {
        corrected += heights.current.get(keys[i]) ?? estimate
      }
      const drift = corrected - offsets[range.start]
      if (Math.abs(drift) > 0.5) scroller.scrollTop += drift
    }

    // Measurement settles in two or three passes. If it has not after eight,
    // the layout is fighting itself and a ninth will not help.
    if (settling.current++ > 8) return
    // One re-render per screenful of corrections, not one per row.
    setVersion((n) => n + 1)
  }, [windowed, keys, range.start, range.end, version, estimate, offsets])

  if (!windowed) {
    return (
      <div className={scrollerClassName} ref={scrollerRef}>
        <div className={surfaceClassName}>
          <div className={rowsClassName}>
            {items.map((item, i) => (
              <Fragmentish key={keys[i]}>{children(item, i)}</Fragmentish>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={scrollerClassName} ref={scrollerRef}>
      <div className={surfaceClassName} style={{ height: total, position: 'relative' }}>
        {/* The live rows are translated into place rather than pushed by a
            padded spacer: padding makes the browser reflow on every scroll
            tick, a transform does not. */}
        <div
          ref={rowsRef}
          className={rowsClassName}
          style={{
            position: 'absolute',
            insetInline: 0,
            top: 0,
            transform: `translateY(${offsets[range.start]}px)`,
          }}
        >
          {items.slice(range.start, range.end).map((item, i) => (
            <Fragmentish key={keys[range.start + i]}>{children(item, range.start + i)}</Fragmentish>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Applies a key to a caller's element without adding one of our own to the
 * DOM. `<>{child}</>` with a key would do the same thing; this is the same
 * idea written where it can carry the explanation.
 */
function Fragmentish({ children }: { children: ReactNode }) {
  return <>{children}</>
}
