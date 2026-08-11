# Aevistle 0.1.37

## Phone — the bottom tab bar could sit in the middle of the screen

Reported four times, fixed three times, and the three fixes were all aimed at
the wrong thing.

`MainActivity` pads the Android content view down by the window insets, and
0.1.34 folded the keyboard's inset into that padding so the window would shrink
for the keyboard. Padding the content view shrinks the WebView; the WebView is
what `100dvh` measures; `.shell` is `100%` of that; and the five-tab bar is the
bottom row of `.shell`. So a keyboard-sized bottom padding lifts the tab bar a
keyboard's height off the bottom of the screen — with a band of blank,
app-coloured background beneath it, which is why it read as a design rather than
as a fault.

That would have been survivable if the padding always came back down. It does
not: `setPadding` was only ever reached from inside the insets listener, and
`requestApplyInsets` was called exactly once, in `onCreate`. Some OEM keyboards
skip the final "keyboard closed" insets pass, and when that happens nothing
lowers the padding again for the rest of the session — on every screen, until
the app is force-stopped. 0.1.34 clamped the value; 0.1.35 guarded it behind
`isVisible(ime())`. Both still needed a pass to *arrive* in order to lower
anything, which is precisely what does not happen.

Four changes, so that no single one of them has to be right:

- **The keyboard no longer pads the window at all.** `applyInsets` pads only for
  system bars and the display cutout. The window stays the full height of the
  screen, so nothing can lift the tab bar off the bottom of it.
- **The padding has a way back down that does not need the system's
  cooperation.** `refreshWindowInsets` reads `ViewCompat.getRootWindowInsets`
  directly — which reports what the window currently holds, independently of the
  dispatch chain this activity consumes — and runs on every `onResume` and every
  focus gain.
- **The bottom padding is capped at a quarter of the window.** Nothing
  legitimate comes near that. A bug of this class can now cost a strip at worst,
  never 43% of the screen.
- **`.shell` is `position: fixed; inset: 0` on a phone.** It is glued to the
  viewport rather than to the box the app was handed, so the bar is at the
  bottom of the visible area even if everything above goes wrong. Verified by
  forcing `#root` to 440px in an 800px viewport: the bar stayed at 780–800px.

The tab bar is taken out of the grid by none of this — it is still the `auto`
row — so no height measured inside `.main` moved, and the compose screen's 85%
floor is untouched by the change.

## Compose — the keyboard, and a bigger message box

The keyboard is now a number the page reasons about rather than a fact the
layout is helpless against. `MainActivity.publishKeyboardInset` hands the height
to the page in CSS pixels; `core/keyboardInset.ts` cross-checks it against
`visualViewport` and, crucially, against whether a text field is actually
focused — a soft keyboard cannot be up while nothing accepting text has focus,
which is the one signal in this whole story that cannot go stale. The result is
`--kb`, and `.shell` ends where the keyboard begins. The tab bar stands down
while typing and returns the moment the field is left.

Separately, the seven formatting buttons now fold behind a "Formatting"
disclosure on a phone. Seven 44px targets never fit a 360px row and had been
living in a hidden horizontal scroller with the last button off the end. Closed
— which is how every visit starts — they are out of the layout entirely, and the
disclosure is a 23px text control with a 44px hit area, so the row it shares with
the byte count is 23.8px instead of 44px. Open, the strip is a full-width row of
its own with all seven reachable without scrolling.

Measured by `scripts/layout-probe.mjs`, message box as a share of the compose
view on first paint:

| window | before | after |
| --- | --- | --- |
| 360x800 phone | 85.5% | **88.7%** |
| 820x1180 tablet | 90.5% | **92.6%** |

## Typography — the real Times New Roman and the real SimSun

Both `@font-face` blocks listed the bundled `url()` **first**, and a
successfully-loaded `url()` font wins its entire declared unicode-range. So the
bundled Tinos and Noto Serif SC were what rendered on every platform, Windows
included — the `local("Times New Roman")` and `local("SimSun")` entries below
them had never once been reached. The order is now system-first: Windows and
macOS draw the literal faces the app was designed around, Android has neither
and falls through to the bundled files exactly as before. Desktop also stops
downloading a 4.05 MB CJK subset it does not need, and `font-display: swap` on
both blocks ends the up-to-three-second blocking period Android had.

Three more places escaped the app's typography entirely and now do not:

- **The inbox reader.** Received mail renders in a sandboxed iframe, whose
  injected stylesheet said `font-family: inherit`. Across a document boundary
  that resolves against *that* document's root, which has no font — so the
  screen where the most text is read fell back to the WebView default
  (sans-serif on Android). It now names the stack literally, at 16px/1.65.
  Mail that sets its own `<font face>` still keeps it; the app's font is the
  default now rather than something mail merely happened to inherit.
- **`--font-mono`.** Sixteen rules — verification codes, file paths, host:port
  readouts, SSL errors, recovery keys — drew from a coding sans. They are Latin
  text, so they are Times New Roman now. Digit alignment survives on
  `tabular-nums`; glyph disambiguation (0/O, 1/l/I) does not, which is a real
  cost of the change and a one-declaration revert.
- **The OAuth result page**, served on localhost after a Google or Microsoft
  sign-in, was `system-ui, sans-serif`.

The `runecircuit` style's heading pairing (KaiTi headings against Songti body)
is withdrawn. It was the only place in the app where the typeface depended on
which visual style was selected. Its palette, circuit traces and solar-term
washes are unchanged.

## Type scale — nothing below 14px, and prose is 16px

`--text-xs` was 12.5px across 50 rules. The scale is now two ranks with one
rule between them: **prose is 16px or 18.67px, data labels are 14px, and
nothing is smaller than 14px.**

Every `var(--text-sm)` and `var(--text-xs)` rule in the stylesheet was
classified as prose or as a data label, and 46 rules moved up to the body rank —
field hints, switch descriptions, banner and toast copy, empty states, release
notes, conflict text, message subjects and previews, the send-time sentence, the
delivery-window sentence, the "why this code" explanations, both failure-screen
hints. Timestamps, byte counts, addresses, chips, badges and calendar numerals
stayed at 14px. `.select--compact` and the work-calendar paste box moved to 16px
for a different reason: iOS and Android zoom the page when a focused field is
under 16px.

Four comments in `app.css` had been claiming 16px while rendering 14px, because
`--text-sm` was `1rem` when they were written and a later pass dropped the token
without updating them. Two of those rules are now the size their comment always
argued for; the other two say what they actually do.

The one literal font size left in the stylesheet — `10px` on the phone tab
bar's unread badge — is on the scale, and the badge grew from 16px to 20px to
hold it.

## App icon

Regenerated from new artwork through the existing pipeline: five Android
launcher densities plus round and adaptive layers, the Windows `.ico` (seven
frames), tray icons, installer bitmaps, the favicon, the in-app brand mark and
the documentation logo. The adaptive icon's background colour resource follows
the artwork and is now `#56BFFD`, which also lightens the Android splash.

Round launcher masks shave the outer edge of the clock ring; the envelope and
paperclip are inside the guaranteed safe zone. The Android launcher PNGs grew
from 90 KB to 729 KB, so the APK is roughly 640 KB larger.
