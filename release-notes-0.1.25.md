# Aevistle 0.1.25

Mail arriving in a mailbox this app was watching produced no notification at
all. Not a poor one — none. On both platforms the only things that had ever
raised a notification were a scheduled send's result and a verification code,
so everything else landed in the inbox in complete silence, and on Android the
silence was total: the background sync that runs on the system's own schedule,
with the app closed, never notified about anything.

That is what this release is mostly about, along with two smaller things that
were reported at the same time — a copy button that failed on every Android
device, and two fields in the add-account form that were the same word twice.

## Copying a verification code on Android said "copy failed"

It had never worked. The screen that exists so a code can be copied in one tap
was, on the platform where that matters most, a screen that found the code,
displayed it correctly, and then refused to copy it.

The cause is not in this app's logic. `navigator.clipboard.writeText()` — the
modern clipboard API, called from a real tap, on a page served over
`https://localhost` and therefore in a genuine secure context — is refused
inside an Android WebView. The asynchronous clipboard write goes through
Chromium's permission service, and a WebView has no delegate that can answer
for `clipboard-write`: the hook it does have covers audio, video, MIDI and
protected media, and nothing else. So the promise rejects, and the `catch`
around it did the only thing it could, which was to report a failure.

Every copy in the app now goes through one place that tries three routes in
order: the Android clipboard directly, through a new native method, which needs
no permission at all and is the API the platform actually intends for this; then
the web call, which is what Windows and the browser preview use; then a hidden
text field and the older `execCommand`, so a build running somewhere neither of
the first two reaches still copies. That covers the codes screen, the sign-in
link, the pairing code, the calendar subscription URL and the remote-control
configuration — all of which were failing on Android in the same way, and two of
which were worse than failing: they announced "copied" whether or not anything
had reached the clipboard, which on Android was every single time.

Automatic copy of a code while waiting for one has therefore also never worked
on a phone. It does now.

## New mail is announced, and the notification takes you to it

There is a new switch in Settings → Notifications, on by default, next to the
verification-code one. What it produces is a notification carrying the sender,
the subject and the first line of the message, wearing the app's own icon, and
tapping it opens that message.

What counts as new is deliberately narrow, because the obvious version of this
feature fires constantly for the wrong reasons. Three rules:

- **Nothing from the first sync after launch.** That sync discovers the whole
  mailbox, and every message in it is "new" to a process that has just started.
  Without this rule, opening the app means a burst of notifications about mail
  you read yesterday.
- **Nothing already read elsewhere.** A message flagged as seen was read in
  webmail or on another device, and arriving here is not an event.
- **Nothing older than half an hour.** A mailbox that has been offline for a
  week catches up in one sync. Those messages are new to the cache and old to
  the world, so the age is judged from the message's own date rather than from
  when we happened to hear about it.

Quiet hours suppress it, which is a deliberate difference from the code
notification: someone waiting for a code at 02:00 is waiting on purpose, and a
newsletter at 02:00 is exactly what a nightly window exists to hold back.

On Windows the click raises the window — restoring it first if it was minimised,
and opening one if the app was closed to the tray — and then opens the message.
Every notification the desktop raises now carries the app icon and does
something when clicked, including the scheduled-send failure notice, which
previously had neither.

On Android there is more to it, because the app is usually not running:

- **The background sync notifies.** The fifteen-minute WorkManager pass now
  compares what came back against what it already had and raises a notification
  for genuine arrivals. This is the change that makes the feature exist at all
  on a phone.
- **Notifications wear the app's mark.** The small icon was the platform's
  generic sync glyph, which is what every background sync on the device uses;
  it is now a purpose-drawn envelope, tinted with the app's own accent, with the
  launcher icon beside it.
- **Tapping opens the message.** Including from a cold start, where the tap is
  what launches the app and there is no page to deliver an event to — the id is
  parked and collected when the app is ready.
- **Several arrivals collapse into one group** rather than stacking up as
  separate rows.
- **A code notification has a Copy button.** The whole point of that
  notification is not having to switch apps, and it previously stopped one step
  short: you could read the code and then had to type it. The button writes it
  to the clipboard from the shade and dismisses the notification, without
  opening the app.

One limit, stated plainly: with the app fully closed, the background pass
reports *new mail*, not *a verification code*. Recognising a code means reading
the message body, and the background sync fetches headers only. Codes are still
recognised and announced whenever the app is running.

## "Your name" and "Account remark" were the same word twice

The add-account form had two fields that both asked for a name and meant
opposite things. `Sender name` goes into the message header and is what the
person receiving your mail reads; `Account alias` never leaves the device and is
what this app's own account list calls that mailbox. Written as "你的名字" and
"账号备注" — "Your name" and "Display name" in English — nothing distinguished
them, and the layout made it worse: one sat in step 1 and the other was folded
away inside "More settings", so the two were never on screen together to be
compared.

They now share a row, each with a note on its label line saying where its value
shows up, and directly underneath is a line printing both as they will actually
appear — `Recipients see: 张三 <me@gmail.com> · Listed here as: Gmail`. The note
is on the label line specifically so it survives on a phone, where the
stylesheet culls the ordinary hint text under an input. The email address moved
to a row of its own to make room, which it had earned anyway: it is the largest
control in the dialog and the field every other one is derived from.

## Also

- Two new gates in `npm run check`. One holds the new-mail rules to the same
  window and the same three tests on both platforms — the decision exists twice,
  in TypeScript for the app and in Java for the background worker, and two
  implementations of one rule drift silently. The other requires the handful of
  strings the Android background worker words for itself to be translated in
  every locale, for the same reason `check:i18n` exists on the other side of the
  bridge: a missing translation there does not fail, it quietly falls back to
  English.
