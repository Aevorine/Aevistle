/**
 * The widths this app changes shape at, and the hooks that read them.
 *
 * ## Why this file is the only place the numbers appear
 *
 * Before this round there were three, in three files, none of them agreeing:
 * `NARROW_QUERY` here at 760px decided the tab bar and the dialog treatment,
 * `SHEET_BREAKPOINT` in `RecipientPicker` at 760 decided dropdown-vs-sheet, and
 * `BODY_FIRST_QUERY` in `ComposeView` at 900 decided whether the message box
 * got the screen — and `app.css` had ten more of its own (560 620 700 720 760
 * 900 1000 1100 1500 1600). So a window dragged from 1600px to 320px did not
 * cross a layout boundary, it crossed eleven of them, and between any two the
 * screen was a mix of both arrangements. That is what 布局不统一 looks like from
 * the inside, and no amount of restyling any single screen could have fixed it.
 *
 * Now there are three boundaries and they are here. `app.css` spells them as
 * literals because a media query cannot read a variable, and
 * `scripts/check-breakpoints.mjs` fails the build if the two sides ever drift
 * apart — which is the guarantee that replaces "remember to update both".
 *
 * ## Which three
 *
 * Android's own window size classes, unchanged. This ships as an Android app;
 * borrowing the platform's boundaries means the layout changes where the
 * platform's own apps change, and it means the numbers are defensible without
 * this file having to argue for them.
 *
 *   compact    < 600px     phone portrait                one column, bottom tabs
 *   medium     600-839     phone landscape, small tablet  one column, bottom tabs
 *   expanded   840-1199    tablet landscape, laptop       side rail, two panes
 *   large      >= 1200     desktop                        side rail, two panes
 *
 * The shell splits at 840: below it the app is a stack with a tab bar, above it
 * a rail with two panes. compact-vs-medium and expanded-vs-large are density
 * steps within those two shapes, not different shapes.
 *
 * ## Why `matchMedia` and not a resize listener
 *
 * The browser already knows the answer and fires only when it *changes*, where
 * a resize handler fires continuously through a window drag and would re-render
 * every card in Settings on each frame of it.
 */

import { useEffect, useState } from 'react'

/* -------------------------------------------------------------------------- */
/*  The boundaries                                                            */
/* -------------------------------------------------------------------------- */

/** Phone portrait ends here. */
export const BP_MEDIUM = 600
/** The shell changes shape here: stack + tab bar below, rail + two panes above. */
export const BP_EXPANDED = 840
/** Desktop density begins here. */
export const BP_LARGE = 1200

/**
 * `max-width` is inclusive, so a bare `max-width: 840px` and a
 * `min-width: 840px` both match a viewport of exactly 840px, and at that one
 * width the page gets both arrangements at once. Subtracting a hundredth is the
 * standard way out, and is what `app.css` writes too.
 */
const below = (px: number) => `(max-width: ${px - 0.02}px)`

/** Phone portrait only. */
export const COMPACT_QUERY = below(BP_MEDIUM)
/**
 * The shell query: everything below the two-pane layout.
 *
 * Named `NARROW_QUERY` still, because `main.tsx` sets the shell attribute from
 * it before the first paint and the name says what it is used for.
 */
export const NARROW_QUERY = below(BP_EXPANDED)
/** Two panes and a side rail. */
export const EXPANDED_QUERY = `(min-width: ${BP_EXPANDED}px)`
/** Desktop. */
export const LARGE_QUERY = `(min-width: ${BP_LARGE}px)`

/**
 * "Is this window too short for a form and a message box?"
 *
 * The app had 32 media queries before this round and every one of them asked
 * about width. Nothing anywhere asked about height, which is why a 1024x768
 * window — a tablet in landscape, and the most common laptop screen there has
 * ever been — put the compose message box at 240px, or 31% of the screen,
 * while the same app on a 360x800 phone gave it 72%.
 *
 * Measured at 1024x768 with an account warning showing: page head 113px,
 * addressing row 82px, footer 164px. 359px of chrome, 47% of the window, none
 * of it the thing the screen is for. Width was never the problem — at 1024
 * there is width to spare — and no width query can see a problem that is
 * entirely vertical.
 *
 * 880px is where the arithmetic turns: below it, chrome plus a message box
 * worth writing in no longer both fit, so the attachments and the send time go
 * behind the two buttons that open them and the message takes the space back.
 * That is the same trade a phone already makes, applied on the axis that
 * actually decides it.
 *
 * Android is unaffected either way — `useBodyFirst` ORs in the native platform,
 * so the app has always taken this path on a phone or tablet regardless of its
 * dimensions. This is the desktop and Electron window catching up.
 */
export const SHORT_QUERY = `(max-height: 880px)`

/** True when the window is too short to hold the chrome and a usable message box. */
export function useShort(): boolean {
  return useMedia(SHORT_QUERY)
}

export type SizeClass = 'compact' | 'medium' | 'expanded' | 'large'

/**
 * Written to the root element so a stylesheet can branch on the tier by name
 * instead of restating the numbers.
 *
 * `[data-size-class="expanded"]` reads as what it is at the point of use, where
 * `@media (min-width: 840px) and (max-width: 1199.98px)` has to be decoded
 * every time — and decoded identically in each of the places that need it,
 * which is precisely the discipline that failed here before.
 */
export const SIZE_CLASS_ATTR = 'data-size-class'

/**
 * The root attribute `app.css`'s "dialogs are screens here" block selects on.
 *
 * Exported so `main.tsx` can set it before the first paint and this module can
 * keep it in step afterwards, without either of them spelling the string twice.
 */
export const MOBILE_SHELL_ATTR = 'data-shell'
export const MOBILE_SHELL_VALUE = 'mobile'

/** Pure, so `main.tsx` can call it pre-paint and the check script can test it. */
export function sizeClassFor(width: number): SizeClass {
  if (width < BP_MEDIUM) return 'compact'
  if (width < BP_EXPANDED) return 'medium'
  if (width < BP_LARGE) return 'expanded'
  return 'large'
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One media query, subscribed once.
 *
 * Guarded because this module is imported by screens that are also rendered
 * during the build's static pass, where `window` does not exist. `false` is the
 * safer default for every caller here: it renders the full layout rather than a
 * list of buttons that need JavaScript to open anything.
 */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    // Re-read on mount as well as on change: between the `useState` initialiser
    // and this effect the window can have been resized, and a rotated phone that
    // landed on the wrong branch would stay there until the *next* change.
    setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/**
 * "Is this window below the two-pane layout?"
 *
 * Nearly all of this app's responsive behaviour is CSS, which is where it
 * belongs: a media query needs no JavaScript, no re-render and no state, and it
 * is correct during the very first paint. This hook exists for the cases CSS
 * genuinely cannot express — where the narrow layout is not the wide one
 * restyled, but a different *structure*: on a phone, Settings renders a list of
 * rows that open dialogs, and Home renders tiles that open dialogs. There is no
 * stylesheet that turns a stack of sixteen cards into sixteen buttons plus one
 * modal.
 */
export function useNarrow(): boolean {
  return useMedia(NARROW_QUERY)
}

/** True from 840px up — the width at which a second pane fits. */
export function useExpanded(): boolean {
  return useMedia(EXPANDED_QUERY)
}

/**
 * The current tier, also published to the root element as `data-size-class`.
 *
 * Mounted once, at the shell. Two callers would write the same value to the
 * same attribute, which is idempotent, but the subscription is not free and
 * there is no second caller that needs it.
 */
export function useSizeClass(): SizeClass {
  const compact = useMedia(COMPACT_QUERY)
  const expanded = useMedia(EXPANDED_QUERY)
  const large = useMedia(LARGE_QUERY)
  const value: SizeClass = large ? 'large' : expanded ? 'expanded' : compact ? 'compact' : 'medium'

  useEffect(() => {
    document.documentElement.setAttribute(SIZE_CLASS_ATTR, value)
  }, [value])

  return value
}

/**
 * "Is this a touch shell?" — a wider question than `useNarrow`, and the one most
 * of this app's structural decisions actually want.
 *
 * `useNarrow` asks about *width*, which is the right question for the tab bar: a
 * 1280px tablet has room for nine tabs and taking four of them away to match a
 * phone would cost taps and buy nothing. It is the wrong question for a dialog.
 * A portrait tablet running the Android app used to fall outside the old 760px
 * query, so it got the desktop treatment — Settings as a two-column grid of
 * cards rather than rows that open, and dialogs as floating cards with scrim
 * down each side — on a device held in two hands with no pointer anywhere near
 * it. Widening the boundary to 840 covers the common 768px portrait tablet, but
 * not a 1024px one, so the platform half of the OR still earns its keep.
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
    // out past the boundary has to lose the sheet styling, and an attribute with
    // a value nobody selects on would look like an intentional third state.
    else root.removeAttribute(MOBILE_SHELL_ATTR)
  }, [mobile])

  return mobile
}
