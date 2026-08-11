# Aevistle 0.1.35

## Compose — the real fix for the small message box

0.1.34 fixed the wrong half of this. `MainActivity`'s inset listener was
changed to fold the keyboard's inset into the window's padding, which is
necessary but was not sufficient: the app's own root (`html`, `body`,
`#root` in `app.css`) was still sized with `height: 100%`, which resolves to
the same viewport value as `vh` — and Android's WebView does not recompute
that value when the on-screen keyboard opens. Every height in the app
cascades from that one root rule, so the message box kept the height it
computed for a keyboard-free screen no matter what the native side did; the
keyboard just covered the bottom of it. Changed the root to `height: 100dvh`
(the dynamic viewport unit, already used for exactly this reason on one
smaller popup elsewhere in the stylesheet) so the *whole* app, not just one
sheet, actually shrinks when the keyboard comes up. This is the difference
between the message box being 85%+ of the screen with the keyboard closed
and roughly a quarter of it once you tap in to start typing.

## Still worth knowing

The subject field on the compose screen is a single-line input; it cannot
wrap onto two lines by construction. The inbox reader's title-wrapping and
button-placement issue reported earlier was fixed in 0.1.34 (button row on
top, subject wraps on its own line beneath) and is unchanged here. If either
still looks wrong after installing this build, it's a new, different bug —
send a screenshot rather than a description, since two "the box is small"
reports in a row turned out to have two different causes.
