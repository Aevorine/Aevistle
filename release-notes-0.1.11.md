# Aevistle 0.1.11

The working calendar stops being a settings page and becomes the place your
scheduled mail is actually managed. Six visual styles. And two features that
had never worked in a shipped build — including one nobody had reported,
because it failed silently on one platform while reporting success.

## Two things were broken, and they were broken the same way

**The working calendar's "check online" holiday lookup never worked.** It
reported `Failed to fetch` for 2025, 2026 and 2027 alike, which reads exactly
like a network fault. It was not one: the request was refused by the
application's own Content-Security-Policy before it left the renderer, so the
year was never the variable.

**The Android in-app update check has never worked in any released build.** The
same shared code runs in the desktop main process, where no policy applies, and
reported success there — so the failure was invisible from the desktop, and on
Android it looked like "no update available" rather than like an error.

Both now go through the trusted side of the app instead. The policy was **not**
widened: a new allow-list pins the two feeds by host *and* path, checked
independently on each platform, so the renderer cannot ask the trusted side to
fetch anything else.

Note: 2027's Chinese statutory table has not been published by the State Council
yet. The button will now say so, which is a different answer from a network
error.

## The calendar is now the scheduling console

- **Day squares list their sends** — time, recipient, subject — instead of just
  counting them. Click one to open it, drag it to reschedule, double-click an
  empty day to start a reminder for that date.
- **A send-load heatmap** on a fixed absolute scale, so a square's colour means
  the same thing every time you look at it.
- **Collisions are marked per send**, not per day, and a single button spreads
  a pile-up apart. It names every reminder it will move and how far, says out
  loud that a repeating rule has no per-send exceptions, and the whole batch is
  one `Ctrl+Z`.

## New: the calendar and your mail, connected

- **The recipient's working day.** A contact can carry a time zone and working
  hours; a scheduled send lands inside *their* day. Runs after the working
  calendar and quiet hours and outranks both — so a send released into their
  morning can fall in your night. Only the `To:` line is consulted. Nothing is
  ever held back or dropped: an impossible or misconfigured window is reported
  and the message still goes out at the time you set.
- **Mail that turns into a reminder.** Meetings, appointments and deadlines are
  read out of received mail in six languages, with the sentence they came from
  shown beside the answer. Invitation attachments are read in preference to
  prose (desktop; Android falls back to the prose reader). A date the wording
  did not settle gets no one-click button and asks before creating anything.
- **A digest of your own schedule** — an optional daily mail listing what goes
  out today, this week, and any conflicts.
- **Holiday greetings, planned rather than sent.** You review the list before
  anything is created, and what is created is ordinary visible scheduled jobs.
- **Calendar merge variables**: `{{nextWorkday}}`, `{{holiday}}`,
  `{{nextHoliday}}`, `{{daysToNextHoliday}}`, `{{workdaysLeftThisWeek}}` and
  more, resolved at send time.
- **Export the times it will really send at.** The `.ics` export can emit the
  instants after holiday shifts and quiet hours, instead of a recurrence rule
  that the app has already decided not to follow. Outlook, Thunderbird and
  Apple Calendar can subscribe to the saved file; Google Calendar cannot,
  because it reads only public web addresses and this app has no server.

## Six visual styles

Aurora, Graphite, Paper, Midnight, Nordic and High contrast — each with a real
light and dark form, picked from **Settings → Appearance**. They differ in more
than hue: corner radii, shadow weight, letter-spacing and line-height move too.
Contrast ratios were computed rather than eyeballed; the contrast style reaches
WCAG AAA throughout.

Two theming bugs went with them: the switch knob was a hard-coded white in every
theme, and "match system" plus a dark OS kept the light accent glow.

## The send-time field on the compose screen

It used to be an empty date box under a "send time" label, beside a sentence
saying no time had been chosen — three parts of the screen saying the same
nothing while the state behind them held a perfectly good time. It is now
pre-filled with the next whole hour.

More importantly: that box was also shown for daily, weekly, monthly and yearly
rules, where the fire time comes from a different field. Editing it there
changed nothing, and nothing said so. The control now matches the rule.

## Speed

Measured in the packaged app with 300 reminders and 300 contacts loaded, not on
an empty profile:

| | |
|---|---|
| Cold start to first paint | 235 ms |
| Slowest first visit to a screen | 92.6 ms |
| Worst keystroke block while typing | 1.9 ms |
| Long tasks while typing | 0 |
| Worst scroll block, any screen | 0.3 ms |
| JS heap after visiting every screen | 11 MB |

The work calendar was recomputing sixty **unbounded** occurrences per reminder
for a grid showing one month — a yearly rule scanned about 22,000 days. Bounding
it to the visible range took that recompute from 383.9 ms to 43.3 ms at 300
reminders.

**Known, and not fixed here:** toggling a day on the calendar still takes about
160 ms with 300 calendar-bound reminders, because every one of them has its
occurrence list rebuilt. Below the threshold where it reads as a pause, above
where it should be.

## Interface

Every screen was measured at 360, 390, 412, 768, 1100 and 1536 pixels wide, in
all six styles — 324 combinations, all clean: no truncation, no overlap, no
horizontal scroll, and nothing smaller than 16px anywhere in the application.

Two real defects came out of that. The compose screen scrolled sideways by 97px
at 360px wide — seven 44px formatting buttons and a byte counter needing 402px
of a 360px screen, which the previous check could not see because it measured a
container rather than the elements. And an account row with a missing field
could take the entire Settings screen down with it, silently.

## Everything else

- Six languages, all now carrying the same 36 feature rows; four of them had
  been missing five.
- `npm run check` is 34 guards, every one of them fed a deliberately broken
  version to prove it can fail.
