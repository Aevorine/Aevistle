# Aevistle 0.1.26

An audit release. Nothing here is a new feature; it is the result of going
looking for the kind of defect that does not announce itself — code that runs,
returns cleanly, logs nothing, and does not do the thing it says it does. Eight
were found, and every one of them had been shipping.

## Two notification switches that could not affect anything

Settings has had "announce successes" and "announce failures" since early on.
Neither did what its label said, on either platform, in four separate ways:

- **`notifyOnFailure` was read by nothing at all.** Not one line of TypeScript
  anywhere in the project consulted it. The desktop's failure notification
  fired unconditionally, so turning the switch off changed nothing.
- **`notifyOnSuccess` was read only by the compose screen's own send button.**
  A *scheduled* send — the thing this application exists to do — never
  announced success on the desktop, because the scheduler runs in the main
  process and the main process had never been told the setting existed.
- **On Android, success notifications were wired to a field that has never
  existed.** `SendWorker` asked each job for `notifyOnSuccess`; `ScheduledJob`
  does not define it and nothing has ever written it, so `optBoolean(…, false)`
  returned `false` every time. A scheduled send that worked has never once
  raised a notification on Android, whatever the settings screen showed.
- **On Android, failure notifications ignored the switch too**, at both of the
  places that raise one.

All four are fixed by giving the two settings a route to the code that acts on
them: `setDesktopPrefs` on the desktop, alongside the two switches that had
exactly this problem before them, and `syncJobs` on Android, which the
background worker already reads its jobs from. The desktop's scheduled-send
notifications are also translated now, and name the reminder rather than
printing its internal id.

## Two Android event streams that were never connected

`onJobEvent` and `onInboxEvent` are declared in the Android bridge, and both
subscribed to event names nothing in the Java plugin ever emitted —
`notifyListeners` was called for two unrelated things and for nothing else.
Subscribing succeeded, so from the web side nothing looked wrong. What it cost:

- a scheduled send completing **while you were looking at the schedule screen**
  left its row saying "waiting to send" until you switched apps and came back;
- mail found by the background sync did not appear until the app's own timer
  came round, up to five minutes later.

Both ends are connected now. The workers publish through a plugin instance that
registers itself while a WebView is alive, and the emit is a no-op when nothing
is open — so the closed-app path still runs entirely on the queue-and-drain
mechanism it always did, and nothing new can be lost with the app shut.

## A leftover debug override in the Inbox screen

`const canUseInbox = Boolean(bridge?.syncInbox) || true /*TEMP-VERIFY*/`

The `|| true` made the condition constant. Two consequences, both quiet: the
browser preview, whose bridge has no receiving support at all, drew the whole
Inbox screen — sync button, account filter, bulk actions — none of which could
do anything; and the empty state that would have explained why became
unreachable code.

Fixed by separating the two questions that had been collapsed into one. Whether
the platform can *fetch* now gates only the sync button. Whether there is
anything worth drawing is a different question, and mail already in the store
is still shown — hiding real messages because more cannot be fetched would have
been the same class of bug facing the other way.

## A dependency advisory that had been failing the build for weeks

`npm run check` ended in a red `nanoid` advisory that predated this work and had
been treated as permanent scenery. It was real and one line from fixed:
GHSA-2v37-7h3g-55p8, high severity, reachable at runtime through
`sanitize-html → postcss`. Pinned to a fixed version.

`npm run check` now exits zero.

## 402 dead translation entries

67 keys that nothing in the project references, across all six locales —
leftovers from screens that were reorganised (the verification-code list moved
out of the inbox and became its own screen; the export/import section went
away). Removed. Anything still in use would have failed the type checker, since
the translation key type is derived from the English table.

## And a new gate, so the Android one cannot come back

The most interesting defect above is the third: Java reading a JSON field the
TypeScript side never writes. It cannot fail loudly — `optBoolean` has a
default, and the default is a perfectly ordinary value — so it produced a
feature that was off forever while every existing check stayed green.

`check:native-fields` now reads every field the Android sources pull out of
JSON and requires something in `src/` to write it, with an explicit allowance
for the one field that legitimately comes from elsewhere (an OAuth token
response). It carries a self-test that injects the exact fault and requires the
check to go red.

Two things were looked for and not found, which is worth recording: there are no
settings fields that nothing reads (the two above were the last), and there are
no empty `catch` blocks in either language.
