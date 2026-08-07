# Aevistle 0.1.21

The account list and the inbox's account tabs hold up past a handful of
accounts now. Every fix in this release is the same bug in a different
component: a flex child had its automatic minimum size zeroed out —
`min-width: 0` or `overflow: hidden`, which the flexbox spec treats the same
way — with nothing behind it to catch what that protection was for. It stayed
invisible on the two- or three-account screen every earlier check ran
against, and only showed up once an account list was long enough to matter.

- The account list's row buttons sat bare on the row instead of inside their
  own container, so on a narrow window the address/host line was squeezed to
  near-zero width and wrapped one character at a time — unreadable, not just
  ugly.
- The account list's card used `overflow: hidden` inside a column flex modal
  body, which let the modal shrink the card to fit instead of scrolling past
  it. Past a screenful of accounts the rest were clipped and unreachable, with
  no visible sign anything was missing.
- The inbox's account-switching tab strip divided its width evenly among
  every account past three or four, crushing every label into the next one
  instead of falling back to the horizontal scroll it already had.
- Switching between "All accounts" and a single account in the inbox could
  show one frame of overlapping rows — the windowed list kept the previous
  account's scroll range for a moment after the item list underneath it had
  already changed.
- Settings on a phone no longer offers the daily digest, holiday greetings,
  calendar subscription and pairing cards a second time. Home has carried
  those four as tiles since 0.1.14; Settings dropped its own copies on a
  narrow window, where the duplication read as the app not knowing where it
  put its own features. A wide window is unchanged — Settings has always been
  the only door there.

Nothing about how mail is scheduled, stored, sent or encrypted changed.
