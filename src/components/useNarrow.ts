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

/**
 * The root attribute `app.css`'s "dialogs are screens here" block selects on.
 *
 * Exported so `main.tsx` can set it before the first paint and this module can
 * keep it in step afterwards, without either of them spelling the string twice.
 */
export const MOBILE_SHELL_ATTR = 'data-shell'
export const MOBILE_SHELL_VALUE = 'mobile'

/**
 * "Is this a touch shell?" — a wider question than `useNarrow`, and the one
 * most of this app's structural decisions actually want.
 *
 * `useNarrow` asks about *width*, which is the right question for the tab bar: a
 * 1280px tablet has room for nine tabs and taking four of them away to match a
 * phone would cost taps and buy nothing. It is the wrong question for a dialog.
 * An 800px portrait tablet running the Android app was outside the 760px query,
 * so it got the desktop treatment — Settings as a two-column grid of cards
 * rather than rows that open, and dialogs as floating cards with scrim down each
 * side — on a device held in two hands with no pointer anywhere near it.
 *
 * So: narrow *or* a native mobile platform. The caller passes the platform half
 * because this module deliberately knows nothing about the bridge; every call
 * site already has it.
 *
 * The effect is what `app.css` reads. Two components calling this hook write the
 * same value to the same attribute, which is idempotent and cheaper than
 * threading the answer through a context to guarantee a single writer.
 */
export function useMobileShell(nativeMobile: boolean): boolean {
  const narrow = useNarrow()
  const mobile = narrow || nativeMobile

  useEffect(() => {
    const root = document.documentElement
    if (mobile) root.setAttribute(MOBILE_SHELL_ATTR, MOBILE_SHELL_VALUE)
    // Removed rather than set to something else: a desktop window dragged back
    // out past 760px has to lose the sheet styling, and an attribute with a
    // value nobody selects on would look like an intentional third state.
    else root.removeAttribute(MOBILE_SHELL_ATTR)
  }, [mobile])

  return mobile
}

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
