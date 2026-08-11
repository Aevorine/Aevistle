# Aevistle 0.1.33

## Compose

The message box on a landscape phone or a wide tablet was falling to 52–66%
of the compose screen — the fold-on-first-paint fix in an earlier release only
triggered under 900px, so a rotated phone or a large tablet still got the full
desktop form with everything expanded. The Android app now always gets the
narrow, message-first layout regardless of its current width or orientation;
a desktop window dragged narrow still behaves exactly as before. Measured:
85.5% at 360×800, 92.3% at a tablet width.

A one-line title band for "new mail" vs. "editing an existing one" was tried
on the narrow layout and pulled back out the same day it went in — its own
smallest measurement only left 82.4% of the screen for the message box, and
lowering the 85% floor to fit it would have traded the requirement away
instead of meeting it. The existing "编辑中" badge on the folded summary
answers the same question without the cost.

## Inbox

Received HTML mail on Android was losing every inline style — color, bold,
size, alignment — because the Android sanitizer rejected the `style`
attribute outright, while the desktop build kept a seven-property allowlist. Most
real-world mail formatting lives in `style=""`, so this made ordinary
messages render as an unstyled wall of text on phone and tablet only, while
looking correct on desktop. Android now applies the same seven-property
allowlist (color, background-color, font-weight, font-style, font-size,
text-align, text-decoration) as desktop — same fidelity, no new properties
allowed, so no new risk beyond what desktop has already carried.

Both platforms now also strip a same-element `color`/`background-color`
match — the classic "hide this paragraph" trick (white text on a white
background) used for keyword-stuffing past spam filters or hiding fake
disclaimers.

The reader's dark-mode filter was inverting a plain white-background message
to pure black-on-#eee, ~18:1 contrast — well past the ~12–13:1 this app's own
dark theme was deliberately tuned to, to avoid the glare of a flat black/white
extreme over a long read. Softened to land in the same range. Opening a
message that is still loading now shows the shape of a paragraph rather than
a bare spinner, matching the shape-not-motion skeleton already used
elsewhere in the app.

## Fonts

Chinese UI text was set in "SimSun" and English text in "Times New Roman" via
CSS `local()` references only — fonts that exist on Windows but not on
Android, where SimSun in particular cannot legally be bundled (Microsoft-
proprietary). Every such lookup was silently failing on every Android device.
Now ships two free, OFL-licensed substitutes embedded directly in the app —
Noto Serif SC for the CJK serif look, Tinos as a metric-compatible Times New
Roman substitute — so the intended typography actually renders identically on
every platform instead of falling back to whatever a given device happens to
have.

## Reader header (from the in-flight mobile UI work, finished this release)

A stale nine-tab-era CSS rule was hiding the active bottom-nav tab's own
label, fighting the five-tab fix that shipped earlier. Fixed. The reader's
flag/delete controls now fold behind a "more" menu on phones so the header
stays one line instead of wrapping. A one-off scheduled send's summary now
shows the actual send time instead of a static "Once".

## Visual polish

Seven smaller items, audited against the existing design system before
touching anything (design tokens, dark-mode contrast, and the empty-inbox
state were already solid — not reworked):

- Inbox rows carried a box-shadow that directly contradicted this app's own
  documented "cards get no shadow, a border and surface step is enough"
  rule — the longest, most-scrolled list in the app was the one exception.
  Dropped; hover now shifts background instead.
- Five interactive element classes (icon buttons, nav tabs, inbox rows, the
  segmented control, toggle chips) had hover feedback but nothing on
  `:active` — the state that matters on a touchscreen, not a mouse. Extended
  the same press-feedback idiom already used elsewhere in the app.
- Ten icon-only buttons in the image viewer had a `title` tooltip but no
  `aria-label`, so a screen reader had nothing to announce for them.
- "New mail" now carries a permanent accent-colored icon in the nav, rather
  than looking identical to the other eight tabs until it happens to be the
  open screen — text stays neutral, since accent-colored 16px text was
  already measured below the accessibility contrast minimum.
- Tap targets under the 44px accessibility floor (an icon button here, a
  formatting toolbar button there) were deliberately left small on desktop —
  sized for a mouse, on purpose. Any device that reports a coarse (touch)
  pointer — including a touchscreen Windows window — now gets the same 44px
  floor the Android app already had; a plain mouse-driven desktop window is
  untouched.

## Internal

`AppState.tsx`'s reducer — 15 responsibility domains in one ~3700-line switch
— had four of its cleanest-boundary domains (code history, outbox, jobs,
sync) split into their own modules under `src/state/services/`, with the same
exported `reducer` signature and every case's observable behavior unchanged.

Crash recovery for a send in flight used to lean on a single boolean claim:
"did we start sending this?" A per-occurrence dispatch ledger now tracks
*where* a send actually got to (claimed / sending / accepted) on both the
desktop and Android builds, and restart recovery resolves anything short of
positive proof of acceptance toward resending rather than dropping it.
