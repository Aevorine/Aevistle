One click on the tray icon shows the window; the next click puts it away. Three
starting states, and only one of them means "hide" — a minimised window still
reports itself as visible, and a window sitting behind a browser is one you want
brought forward. Both of those used to be treated as "put it away", which is why
clicking the icon so often appeared to do nothing.

Two switches in Settings turned out to be decorations. Nothing in the desktop
shell had ever read **Keep running in the tray when closed** or **Start with the
computer**, so closing the window went to the tray whichever way you had set it,
and the login item was never registered. Both work now, and starting at login
opens to the tray rather than putting a window in front of you.

## Choosing recipients

The row of quick-pick faces under the compose form is gone. Clicking the To, Cc
or Bcc box now opens a card listing everyone you know, grouped by contact tag:

- a tick per person, so a name can be un-picked from the same place it was picked
- a tick per group that fills, half-fills or empties the whole group
- **Select all**, acting on whatever you have typed to narrow the list — search
  "finance", press select-all, and you have added those five people
- typing any address at all still works exactly as before; the card is another
  way in, never a gate

Search matches names, addresses, group names, and the initials of a name.

## Reminders that never fired

A yearly reminder imported from an `.ics` file went out **one month early**, and
a January one **never went out at all**. Two places wrote the month counting from
zero and the one place that decides whether today is a send day subtracted one
first — so January became -1 and matched no date in any year, while the reminder
sat in the list marked as armed with no next send. Dragging a yearly reminder on
the calendar had the same fault: the confirmation said October and the send
landed in September.

Importing reminders from another device armed nothing. The jobs appeared, said
they were scheduled, and on Android not a single alarm was registered.

## Crashes and silence

- The app could disappear entirely — React's "Maximum update depth exceeded" —
  after enough browsing, scrolling and typing. The windowed lists measured row
  heights after *every* render including unrelated ones, rebuilt their resize
  observer each time (which is specified to fire immediately, so that alone kept
  it going), and let the visible window slide as rows above it were corrected.
  It took all three activities to reproduce because each supplied a different
  part of the loop.
- **Saves that fail are no longer silent.** If the data folder cannot be written
  to, the health strip says so. Previously everything you had done that session
  was on screen, none of it was on disk, and the only trace was a line in a
  console with no window.
- An unreadable settings file used to be renamed and the app would open
  factory-fresh with no message — indistinguishable, from the inside, from
  having lost everything. It now says what happened and where the file went.
- Testing an inbox connection showed a raw 120-character OpenSSL dump. It shows
  a sentence now, with the technical detail underneath.
- Four pieces of advice the app was written to give — including the explanation
  that Microsoft no longer accepts a password here at all — existed in no
  language file, so the screen displayed the untranslated key `error.use993Ssl`.
- Exporting a calendar, an activity log or an `.ics` said "exported" the instant
  you clicked, while the save dialog was still open, and said it again if you
  cancelled. On Android it said it while doing nothing at all.
- A portable install is now offered the portable build. It used to be handed the
  installer, quietly turning a USB-stick copy into an installed second one.

## The interface, on a phone

Until now a 320px phone and a 719px tablet were handed byte-identical CSS. There
is a phone layer now, and these are measured numbers rather than impressions:

| | before | after |
|---|---|---|
| Message box visible on a 360×800 screen | 62px (7.8%) | **309px (39%)** |
| Ninth navigation tab at 360px | off-screen, scrollbar hidden | on screen |
| Compose header buttons | two rows | one row |

Across nine screens at six widths from 360 to 1536: no horizontal scrolling, no
clipped text, no overlapping elements. Tap targets are 44px, except the
navigation tabs and calendar cells, which cannot be — nine tabs and seven columns
divided by a 360px screen leave 38px, and making them wider is what put a tab
off the edge in the first place.

Five CSS variables were referenced and had never been defined, which a browser
answers by discarding the whole rule without a word: the outer half of every
focus ring had never once been drawn, and the sticky section bar in Settings had
no background, so cards scrolled through its text. Two unrelated components both
claimed the class `.swatch`, and the calendar legend was rendering as five large
circles it was never meant to have.

## Faster

- Typing one character in the message body used to re-render every screen in the
  app, because the shared context object was rebuilt on every change.
- Marking an already-cached message as cached produced a new object, which
  restarted the verification-code watcher, which fetched the same messages
  again, on a timer.
- The character and byte counters re-encoded the entire message on every render.

---

**Verifying this download.** `SHA256SUMS.txt` is signed; `SHA256SUMS.txt.asc`
and `aevistle-public-key.asc` are published beside it.

```bash
gpg --import aevistle-public-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

On Windows without gpg: `certutil -hashfile Aevistle-0.1.9-win-x64-setup.exe SHA256`.

**Which file?** `setup.exe` installs and adds shortcuts. `portable.exe` is a
single file that runs from anywhere, including a USB stick. `.apk` is for
Android 7.0 and later — enable "install unknown apps" for your browser first.

Windows SmartScreen will warn about an unrecognised publisher, because this
release is not signed with a paid code-signing certificate. Choose **More info →
Run anyway**, or check the SHA-256 above first.
