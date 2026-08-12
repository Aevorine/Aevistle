/**
 * The CSS this app's oldest supported engine cannot parse, in one place.
 *
 * `minSdkVersion` is 24 (Android 7.0). A System WebView that has never been
 * updated on such a device is Chromium 51-ish, and the device the last several
 * layout reports came from has been shown not to have `:has()` — Chromium 105 —
 * so anything newer than that is not available there either.
 *
 * Two checks need this list and they must agree, which is why it is a module
 * rather than a constant in each of them:
 *
 *   - `check-css-fallbacks.mjs` fails a **custom property** whose value uses one
 *     of these without an `@supports` fallback, because that case destroys
 *     whichever property reads it (invalid at computed-value time -> `unset`)
 *     rather than degrading.
 *   - `check-css-tokens.mjs` uses it the other way round, to *permit* a pair of
 *     competing declarations when the second one is a progressive enhancement
 *     of the first — the standard fallback idiom, which would otherwise read
 *     exactly like the duplicate-rule bug that check exists to catch.
 *
 * `lib/stylesheets.mjs` records what happens when two scripts each carry their
 * own copy of a fact: both keep passing while they drift, and the drift is
 * invisible because neither fails.
 */

/**
 * Each entry names the function and the Chromium version it arrived in. The
 * version is quoted in failure messages so a reader can weigh it against
 * `minSdkVersion` themselves rather than taking a script's word for it.
 *
 * `fn` is matched as a plain substring against a declaration's value, so it
 * includes the opening parenthesis — otherwise `lab(` would also match
 * `oklab(`, and `from var(` is deliberately not a function name at all but the
 * keyword that distinguishes relative colour syntax from the `rgb()` that has
 * existed since CSS 1.
 */
export const MODERN_CSS = [
  { fn: 'color-mix(', since: 'Chromium 111' },
  { fn: 'oklch(', since: 'Chromium 111' },
  { fn: 'oklab(', since: 'Chromium 111' },
  { fn: 'lch(', since: 'Chromium 111' },
  { fn: 'lab(', since: 'Chromium 111' },
  { fn: 'light-dark(', since: 'Chromium 123' },
  { fn: 'from var(', since: 'Chromium 119 (relative colour syntax)' },
]

/** The entry a value depends on, or `undefined` if it is understood everywhere. */
export function modernFeatureIn(value) {
  if (!value) return undefined
  return MODERN_CSS.find((m) => value.includes(m.fn))
}
