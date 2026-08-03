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

  const windowed = items.length >= threshold

  const keys = useMemo(() => items.map(keyOf), [items, keyOf])

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
    setRange((prev) => (prev.start === start && prev.end === stop ? prev : { start, end: stop }))
  }, [keys.length, offsets, overscan, windowed])

  useEffect(() => {
    if (!windowed) return
    const scroller = scrollerRef.current
    if (!scroller) return
    recompute()
    scroller.addEventListener('scroll', recompute, { passive: true })
    const observer = new ResizeObserver(recompute)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', recompute)
      observer.disconnect()
    }
  }, [recompute, windowed])

  // After layout, before paint: a row never shows at the estimated height and
  // then snaps to its real one.
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
      if (known === undefined || Math.abs(known - height) > 0.5) {
        heights.current.set(key, height)
        changed = true
      }
    }
    // One re-render per screenful of corrections, not one per row.
    if (changed) setVersion((n) => n + 1)
  })

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
