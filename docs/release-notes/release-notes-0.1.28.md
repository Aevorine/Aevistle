# Aevistle 0.1.28

Two things at once: the four screens you spend the most time on were rebuilt
around how much room the text actually needs, and another round of hunting for
defects that run cleanly and do not do what they say. This time one of them was
sending mail against an instruction not to.

## The screens

### The type scale had collapsed

Three of the size tokens — "secondary", "body" and "input" — were all set to
16px. So metadata was the same size as body text on every screen, there was no
hierarchy to read, and the whole app looked like a wall of large print. There is
a real ladder now: 24px screen title, 20px for the one value a card exists to
show, 18.67px section name, 16px body and every input, 14px secondary, 12.5px
auxiliary. Inputs stay at 16px on purpose — anything smaller makes a phone zoom
in when you tap a field.

The new-reminder screen had a second problem on top of that: it raised the
smallest size to 16px for its entire subtree. Measured, that one override was
costing the message box 44px of height.

There is a reason this had survived several attempts to fix it. The layout check
in this repository hard-asserted that no text may be smaller than 15.9px, so any
change that introduced a smaller size failed the check and was reverted. That
floor is graded now — body ≥15.9, secondary ≥13.9, auxiliary ≥12.4 — and a
violation says which rank it broke.

### The inbox: 150px of a 360px screen was not text

A mail row spent its width on a checkbox, an unread dot, two 38px buttons and
three gaps, and left the subject 146px — about nine Chinese characters — which
it was then forbidden to wrap. Everything after that was an ellipsis.

The two row buttons have moved into the swipe gesture that already existed, and
the checkbox now appears only while a selection is actually in progress. The
result, measured at 360px: 20px of furniture, 272px of subject, and a
22-character subject rendering on two full lines with nothing cut off.

Nine rows on screen at once was the original target and it is not met with a
two-line subject: two lines plus a metadata line and padding is a 92px floor,
and nine rows in the available space needs 70.8px. It is six rows with a
two-line subject, eight with a short one, and nine on compact density — which
is a setting you already have. Legibility won that trade deliberately.

### New reminder: the message box now has 85% from the moment it opens

It always could reach 85%, but only after you tapped into the body and the
address block folded itself away. Before that it was 71.5% — or 52% with more
than one account configured, because the account picker added another field. A
promise kept after the fact is not kept.

It opens folded now, with a one-line summary bar that reads as a tappable field.
Measured: 85.5% on a 360×800 phone, 92.3% on an 820×1180 tablet. The account
picker lives inside the block that is not rendered, so the multi-account case is
the same number rather than 52%.

The 85% had never actually been checked. It was documented at length in the
layout script and never asserted; the number it computed divided by the window
height rather than the screen's own, and the script never simulated a phone at
all. It does both now, on the state the screen opens in, and fails below 85%.

### Verification codes and login links

The reported problem was that a login link ran outside the card. It was not the
link — that was already trimmed with an ellipsis. It was the button row: it had
no wrapping rule, and four labelled buttons need 447.5px in a 284px card, so
180px hung off the edge and dragged the whole list into sideways scrolling. The
buttons are icons on a narrow screen: 128px, one row, nothing overflowing.

The code itself is 20px rather than 24px (28px on a wide screen), and the full
login URL is now printed on the card, wrapped and clamped to two lines. It
previously existed only in a tooltip you had to hover to see.

### Found while measuring

- Every list screen reported 4px of horizontal overflow you could not scroll to,
  at every width, from a divider that extended past the page gutter.
- Account labels were clipped with no ellipsis, because the element that carries
  the ellipsis rule could never shrink.
- Once the metadata line stopped wrapping, "2 min" broke across two lines —
  41.3px of row height for a timestamp.
- The list-density setting moved every list in the app except the mail list.
- The 44px minimum touch target applied only below 560px, so an Android tablet
  at 820px — which the app does treat as a touch device — was given 28×26px
  formatting buttons.

## The defects

### Send conditions did nothing at all on Android

This is the serious one. The Android scheduler never looked at a job's
conditions. Not one line of the native code read the field. So "only send if
they have not replied", "only if this file exists", "only inside these hours" —
all six kinds — were set, saved, synced to the phone, and then ignored. The mail
went out regardless, and nothing in the activity log even mentioned that a
condition had been considered.

All six are evaluated on the device now, including "has not replied", which
reads the same downloaded mail the inbox already keeps. A condition this build
does not recognise blocks the send with a readable reason rather than passing.

### And "has not replied" did nothing for scheduled sends on the desktop either

Found while fixing the above. The desktop scheduler was never given the mailbox,
so it reported that condition unanswerable — and an unanswerable condition
deliberately sends rather than holding mail back on a guess. The effect was that
the condition worked when you pressed "Run now" and did nothing whatsoever for a
scheduled send, which is the only case it exists for.

### Sharing to Aevistle opened an empty message

Following a mailto: link or using "Send to" with the app closed opened the
compose screen with every field blank. The shared content was written into the
draft before start-up had finished, and start-up then replaced it with whatever
had last been left in the compose box. On Windows this happened every time.

### A missed reminder was never paid on Android

A reminder due while the phone was off was dropped rather than sent late, and the
schedule row kept showing a send time in the past that never advanced. It is
paid now, exactly once — the guard against sending it twice is stored on disk,
because a worker that is killed immediately after sending must not forget.

### A skipped send was reported as a failure

When a condition held mail back, the activity log showed a red "Scheduled send
failed" with an empty detail, and discarded the one useful fact: which condition
said no. It is a warning carrying the reason now. On Android, a skip that
happened while the app was closed produced no log line at all.

### Four settings that could be read but not set

All four were in the settings file, had a default, were read by code that
changed behaviour, and had no control anywhere in the app:

- **Copying a verification code to the clipboard automatically** — permanently
  on, so the app overwrote your clipboard every time it recognised a code, with
  no way to decline.
- **Keeping a history of unsent drafts** — permanently on, writing draft text to
  disk with no way to decline.
- **The size limit and retention period for downloaded mail** — 500 MB and 90
  days, with nothing in the interface that touched either.

All four are in Settings → Privacy now.

### Smaller

- A reminder moved off a holiday could be scheduled into the past, so the
  preview said it would not be sent and the desktop then sent it immediately.
- Jobs saved by an older build never caught up after a missed run, while an
  identical new one did, because two halves of the same rule disagreed about a
  missing value.
- Dragging a series that had missed a run moved it one day further than asked.
- Two English sentences appeared in the activity log in all six languages.

## Housekeeping

216 translated strings were removed — 36 helper sentences, across six languages,
whose interface element had stopped asking for them in an earlier round. The
strings stayed behind, translated, for text nobody could see. There is now a
check for that, in the direction nothing checked before: a key that no code path
can reach fails the build.

Two new checks guard what this release fixed. One holds the whole share chain —
the Android intent filters, the Windows registry entries, the command-line
parse, both buffers and the start-up ordering — because every break in it is
silent and looks like the feature was never built. The other is the graded type
floor and the 85% assertion described above.

## A note on Windows and the system share sheet

Aevistle can be your default mail application on Windows, and it appears in
Explorer's "Send to" menu. It does not appear in the Windows 11 share panel, and
it will not: that requires the application to be packaged as MSIX, and this is a
conventional installer. On Android the share sheet works as you would expect —
long-press anything, choose share, and Aevistle is in the list.
