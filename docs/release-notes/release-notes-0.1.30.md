# Aevistle 0.1.30

Two releases folded into one — 0.1.29 was built but never actually published —
plus a round aimed at the thing device sync had never been tested against:
what happens when two devices disagree, or one of them crashes at the wrong
moment.

## Editing an existing reminder

There was no way to change a scheduled reminder after creating it — only
pause, resume, delete, or "send another," which copies the message into a
brand-new job. Fixing a typo meant deleting the whole thing and rebuilding it
by hand, conditions and retry policy included.

Every reminder now has an Edit action. It opens the compose screen with the
message, the recurrence, retry, burst, conditions and (see below) the executor
device all pre-filled from the job, and saves back onto the same reminder
rather than creating a second one — its send history and creation date are
left alone.

## Device sync: five bugs that only show up with two devices

Aevistle's phone-and-desktop pairing had not been exercised against its own
worst cases before this round. All five below only matter if you have paired
an ongoing sync between two devices; nothing here changes anything for a
single-device install.

- **Two devices could send the same reminder.** Nothing recorded which device
  a shared reminder belonged to, so a laptop and a phone both open near the
  fire time could both send it. Reminders can now be assigned to one specific
  device — "sends from" in the schedule dialog, shown only once a second
  device is actually paired. Unassigned reminders behave exactly as before.
- **Deleting a reminder on one device did not stop it on the other.** Sync
  only ever added and updated records, never removed them, so a cancelled
  reminder kept firing wherever it had already synced to. Deletions now
  propagate as an explicit "this was cancelled" record, not a guess based on
  absence — an uninstalled or reset device still cannot mass-delete the other
  side's data by simply not having it.
- **Theme and working-calendar settings could swap between devices instead of
  syncing.** Each side echoed its own current value back in the same round it
  was about to adopt the other's, so two devices with different settings
  traded them indefinitely rather than converging. They now converge on
  whichever change is actually newer.
- **A crash on Windows right after a send could cause a resend on restart.**
  The desktop scheduler tracked which reminders had fired in memory only; a
  crash between the mail going out and that fact reaching disk looked, on
  restart, exactly like a reminder that had been missed. It is durably
  recorded before the send now, the same guarantee Android already had.
- **A sync confirmation could be sent before the data was actually saved.**
  The responding device told its peer "received" as soon as the change was
  applied in memory, not once it was on disk — a crash in the debounce window
  between those two moments meant the peer believed the data had arrived when
  it never did. The confirmation now waits for the disk write.

## From 0.1.29 (not previously published)

- **The serif type system (Times New Roman / SimSun) was verified on a real
  Android device**, not just reviewed in source.
- Reader dark-mode adaptation, an inbox avatar, and a compose card redesign
  that matches the app's main screen.
- The inbox list now asserts nine rows on screen at 360px, rather than only
  reporting the count.
- Fixed: **"Reset everything" quietly never cleared the image cache on
  Windows** — the button reported success without doing this one part of what
  it claimed.
- An IMAP watcher could keep using a mailbox password after it was changed in
  Settings, because the watcher's identity never depended on the credential —
  only on which account it belonged to.
- A corrupted state file and a corrupted secrets file recovered on the same
  startup used to leave only the last one named in the settings banner; both
  are named now.
- IMAP sync now forwards a real message preview instead of leaving it blank.
- README trimmed across all six languages: four different "New in 0.1.x"
  sections that duplicated these release-notes files are now one link to
  Releases.

## Housekeeping

`npm run check` now runs the layout probe unattended (`check:layout`) instead
of only when someone remembers to launch it by hand.
