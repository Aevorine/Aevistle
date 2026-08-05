/**
 * "Is this a phone-shaped window?", answered once and shared.
 *
 * Nearly all of this app's responsive behaviour is CSS, which is where it
 * belongs: a media query needs no JavaScript, no re-render and no state, and it
 * is correct during the very first paint. This hook exists for the cases CSS
 * genuinely cannot express — where the narrow layout is not the wide one
 * restyled, but a different *structure*: on a phone, Settings renders a list of
 * rows that open dialogs, and the Home screen renders tiles that open dialogs.
 * There is no stylesheet that turns a stack of sixteen cards into sixteen
 * buttons plus one modal.
 *
 * Deliberately reading the same 760px as `app.css`.
 *
 * The constant is exported and `scripts/check-css-tokens.mjs` is not what
 * guards it — the two are kept in step by `NARROW_QUERY` being the only
 * spelling of the number on this side. A layout that switched structure at one
 * width and styling at another would be broken in a band a few pixels wide,
 * which is the kind of bug that only ever reproduces on someone else's screen.
 *
 * `matchMedia` and not a resize listener: the browser already knows the answer
 * and fires only when it *changes*, where a resize handler fires continuously
 * through a window drag and would re-render every card in Settings on each
 * frame of it.
 */

import { useEffect, useState } from 'react'

/** Must stay identical to the `max-width` in `app.css`'s phone-layout block. */
export const NARROW_QUERY = '(max-width: 760px)'

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    // Guarded because this module is imported by screens that are also rendered
    // during the build's static pass, where `window` does not exist. Wide is
    // the safer default of the two: it renders every section rather than a
    // list of buttons that need JavaScript to open anything.
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(NARROW_QUERY)
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    // Re-read on mount as well as on change: between the `useState` initialiser
    // and this effect the window can have been resized, and a rotated phone
    // that landed on the wrong branch would stay there until the *next* change.
    setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return narrow
}
