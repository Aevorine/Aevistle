# Aevistle 0.1.16

Repairs to the phone layout 0.1.15 introduced. Everything here is a fix; no
feature changed, and nothing about how mail is scheduled, sent, stored or
encrypted was touched.

If you are on 0.1.15, this is the build you want — two of these are things you
would have hit within a minute of opening the app on a phone.

---

## Dialogs are the screen now, not a card floating on it

Opening a settings section or a screen from Home produced a panel with a ~20px
gutter all round, corners curving away from edges it was almost touching, and
the tab bar showing underneath through the blur. It read as a card that had
failed to position itself, because that is essentially what it was.

The card vocabulary — scrim down each side, rounded corners, a shadow lifting
it off the page — needs room either side to mean anything, and a 390px screen
has none. Content dialogs now go edge to edge: square corners, no border, no
shadow, covering the tab bar, closed with the button in the header. The status
bar and the gesture bar are accounted for, so the close button cannot end up
underneath the clock.

Short confirmations deliberately stay cards. "Restore factory settings?" is a
sentence and two buttons; giving it the whole display would make a routine
yes/no look like a change of screen.

## Screens opened from Home had lost their main button

The worst of the three. Hiding the duplicated heading inside those dialogs hid
the element that also carries each screen's primary control, so on a phone:

| Screen | Missing |
|---|---|
| Contacts | Add contact |
| Templates | New template |
| Reminders | New reminder |
| Send log | Export CSV, Clear |

Opening Contacts gave you a list of contacts and no way to add one. Only the
heading text is hidden now; the actions were never redundant.

## Settings stopped repeating itself

Two duplications, both of text that was already on screen:

- **The sticky subtitle.** "Accounts, appearance, data and updates" summarised
  the sixteen labelled rows starting one line below it, and being inside a
  sticky head it did not scroll away — it held space at the top of every
  screenful of a list whose whole purpose was to stop Settings being a scroll.
  Gone on phones, kept on the desktop where the head is one row of a wide grid.
- **The section naming itself twice.** Every row passes the same label to the
  dialog that the card inside already renders as its own heading, so
  "Appearance" was both the row you tapped and the first line of what opened.

## Also

The blurred band and clipped rule under a dialog's action row are gone. Both
came from `PageHead` being styled to stay readable while pinned against a page
scroller — correct on a page, and visibly wrong inside a dialog, where the rule
ran past the panel's rounded edge and was cut mid-line.

---

## Notes on how this was checked

These are layout bugs, and layout bugs are the kind that read as fixed in the
source and are not. Every claim above was measured on the running window at
390×800 rather than reasoned about:

- The three content dialogs each report `(0, 0, 390, 800)` against a
  `(390, 800)` viewport; the confirmation reports `350×254` with symmetric
  20px gutters.
- The accounts section still reports its "Add account" button after the
  heading was hidden.
- Ten screens at two widths produce no console errors.

Two compatibility traps were avoided on purpose, both the same shape as the
toggle-knob bug fixed in 0.1.15 — a modern CSS feature that simply does not
apply on older Android System WebView builds, so the fix would test clean
everywhere the author looked and ship broken to the devices least able to
absorb it:

- `:has()` is Chromium 105 and is not used for anything load-bearing here.
- `100dvh` is Chromium 108; the dialog stretches to a `fixed; inset: 0` parent
  instead, which is exact on every engine.
