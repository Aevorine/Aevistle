# Everything Aevistle does, at full length

The [README](../README.md) names ten things in one sentence each, because a
person deciding whether to download something should not have to read fifteen
kilobytes first. This file is the other half: the same features with the
reasoning behind them, the limits stated out loud, and the arguments for why
some of them work the way they do rather than the obvious way.

> **Language.** The README exists in six languages and they move together. This
> file is English-only for now, on purpose: keeping it in six would mean a new
> feature costs six essays, which is exactly why the last release shipped
> undocumented. See the [roadmap](../README.md#roadmap).

---

## Scheduling

### Fires when closed

Windows keeps a tray process; Android uses an exact alarm plus WorkManager.
Closing the window does not cancel your reminders.

This is the claim the whole app is built to keep, and it is the one that
disqualifies every browser extension in this category — an extension can only
send while the tab that owns it is alive. Leave *Keep running in the tray* on
(Windows), and allow exact alarms and notifications when Android asks.

### Real recurrence

Once · every N minutes · daily · weekly on chosen days · monthly (with a sane
rule for the 31st) · yearly · full 5-field cron.

The 31st is the interesting case. A monthly rule set for the 31st has no
February to fire in, and there is no answer everyone agrees on — so the rule
says which one it took rather than picking silently.

### Send now or later

The two buttons that matter are pinned to the bottom of the compose screen at
every window size. You never scroll to send.

The send time sits beside them, already filled in with the next whole hour
rather than left blank, and it changes shape with the rule: a date and time for
a one-off, a time of day for a daily, weekly, monthly or yearly one — which is
the field those rules actually fire on — and no editor at all for a cron
expression, because the expression *is* the rule.

### Attachment snapshots

Schedule a reminder for next month and Aevistle keeps its own copy of the
files, so moving or renaming the originals does not silently break it.

The alternative — storing a path and reading it at send time — fails weeks
later, at 07:00, with nobody watching. A snapshot costs disk and cannot fail
that way.

### Catch-up policy

Laptop was asleep across three fire times? Choose one catch-up send, or skip.
You will not wake up to three identical emails.

### Jitter and weekend skipping

Spread sends across a window so your provider does not read a burst as spam,
and push weekend fires to Monday.

### Quiet hours

Hold overnight reminders until morning. Sending by hand is never held — you are
standing right there, and an app that refuses a button you just pressed is
broken, not polite.

Quiet hours run *before* the recipient's delivery window and lose to it; see
[Delivery windows](#delivery-windows).

### Burst sending

A single scheduled fire can send the same message several times in a row, paced
by however many milliseconds you set — for stress-testing your own send path,
not for spamming anyone.

---

## The calendar

### The month grid is the schedule

Every day square lists what actually goes out on it — time, recipient, subject.
Click one to open that reminder, drag it onto another day to move it,
double-click an empty day to start a new one for that date.

A drag says what it is about to do before it does it: a one-off moves, a
repeating rule *changes*. There is no per-occurrence exception list to write
"skip this Tuesday, send Thursday instead" into, and a drag that quietly
rewrote a weekly rule would be worse than one that refuses.

**Why the heatmap uses a fixed scale.** Squares are tinted by how busy the day
is on a fixed scale — 1, 2, 3, 5, 8 sends — so the same Tuesday is the same
shade next month. A scale normalised to the busiest day on screen would repaint
the whole month every time you added a reminder, which is decoration rather
than information.

Since 0.1.14 the grid also carries, per day: the recipients as chips and a
count, a body preview you can read without leaving the grid, delivery-status
badges on sends that have already happened, and a filter by account or
recipient. Dragging a send to a new day shows the recipient's local time
*while* you drag, so you find out that Tuesday 09:00 is their 02:00 before you
drop it, not after.

### Working days you define

Public holidays, weekends of your own choosing, and make-up workdays, on a
month grid where clicking a day switches it. One-click starting points for six
countries, the transcribed Chinese statutory tables including the 调休 make-up
days, and `.ics` in and out.

Each reminder decides for itself whether to follow the calendar, and the grid
marks which sends the calendar *moved* — the only thing that answers "did
configuring all this do anything".

Every reminder ignores the calendar by default (`workdayPolicy` starts at
`off`), which is why the impact preview exists at all: without it, someone can
enter eleven public holidays, look at the result, and see nothing change.

When a send lands on a holiday the grid offers a reschedule suggestion rather
than moving it behind your back, and a recurring series can be acted on in
bulk — pause it, shift it, or delete it — instead of one occurrence at a time.

### Sends that collide, and one button for it

Reminders landing in the same minute are marked on the day they land on. One
click spreads them within ±5 minutes and then names the ones it left where they
were and why — a cron expression owns its own minute, and a nudge that would
cross midnight is a change of *day*, which is not what a few minutes is allowed
to mean.

It changes the rule's time of day, so every future send follows; it says that
in the confirmation, and `Ctrl+Z` puts the whole batch back at once.

### Delivery windows

A contact can carry a time zone and working hours, and a reminder addressed to
them lands inside *their* day instead of yours — "every Monday at 09:00"
written in Shanghai otherwise arrives at 03:00 in Los Angeles, which is the one
hour of the week nobody reads mail.

It runs after the working calendar and after quiet hours and outranks them
both, so a message released into the recipient's morning may well be inside
your own night; that is the feature working rather than failing.

**Why only `To:` is consulted.** Somebody kept in the loop is not being
reached, and a carbon copy has no business holding up the actual recipient's
mail.

**Nothing is ever held back or dropped.** A set of windows that cannot all be
satisfied, or one that is simply misconfigured, is reported and the message
goes out at the time you set. The editor states the consequence as a sentence —
what a reminder set for a given hour would really go out at, and what time that
is where they are — because every value on that form is plausible and none of
them can be checked by reading it back.

### 24 solar terms

The 24 solar terms (二十四节气) are computed, not looked up. A solar term is the
instant the sun's apparent ecliptic longitude crosses a multiple of 15°, which
is pure astronomy: derivable from a handful of polynomial constants, with no
government notice to transcribe and no year at which the coverage simply stops.
That is the opposite of the statutory holiday tables, which have to be
transcribed because a State Council notice is not derivable from anything.

The implementation is Meeus's low-precision solar position (*Astronomical
Algorithms*, ch. 25) — mean longitude and mean anomaly as low-order polynomials
in Julian centuries since J2000, the equation of centre as a three-term series,
and a nutation/aberration correction so the result is the sun's *apparent*
longitude rather than its geometric mean position. Good to roughly 0.01°, on
the order of a minute of time, for centuries either side of 2000; comfortably
inside the 1900-2100 span the rest of the calendar code already works in.
`scripts/check-solarterms.mjs` checks it against published instants.

It is used for exactly one thing: the [runecircuit](#runecircuit) style's
monthly colour wash. **Nothing here reaches a reminder's schedule or the
working-day logic**, so a day of drift at the far edge of the range would cost
a tint one term early — never a wrong send date.

### Holiday greetings, planned rather than sent

Pick a country and a year and Aevistle works out which statutory holidays fall
where and shows you the list. Nothing exists until you press the button, and
what it then creates is ordinary visible scheduled jobs.

Consecutive days sharing one name are one occasion — National Day running 1-7
October is one greeting, not seven identical messages in a week. For a Chinese
year the State Council has not announced yet it falls back to the fixed dates
and says which source it used, rather than extrapolating last year's lunar
calendar and being wrong on purpose.

### A digest of your own schedule

Optional: one mail a day to yourself listing what goes out today, what is due
over the next seven days, and anything that collides.

It is not a background job hiding somewhere — it is an ordinary reminder in
your schedule, visible on the same screen, pausable and deletable like any
other, which is the only version of this feature this app is willing to have.
Where a number is a floor rather than a total it says so, and the body carries
the instant it was computed, because the machine may well have sent it hours
later.

### Export the times it will really send at

The `.ics` export of your reminders can write the recurrence rule, or the
instants this app has already decided on — with holiday shifts and quiet hours
applied.

Those two disagree on purpose: "every weekday at 09:00" is a true rule and a
false schedule once the calendar has moved the 1 October send to the 8th, and a
subscriber reading the rule would be looking at a plan Aevistle has decided not
to follow.

**The limit, said out loud:** Outlook, Thunderbird and Apple Calendar can
subscribe to the saved file. Google Calendar cannot — it reads only public web
addresses, and this app has no server to put one on. A worked-out list also
goes stale once it runs past the times already computed, which is why it is a
mode and not the default.

### Subscribe to the working calendar

With the setting switched on, Aevistle serves your working calendar at
`webcal://127.0.0.1:PORT/calendar.ics` — a real subscribe address you can paste
into Outlook, Thunderbird or Apple Calendar's own dialog and let it poll.

**It serves the working calendar only: holidays and make-up days, never the
reminders.** Those carry recipients and subjects, which is exactly the
sensitive half this route stays away from.

The route is deliberately unauthenticated, and that is a decision rather than
an oversight. No calendar app offers a place to put a custom `Authorization`
header, so requiring one would mean the feature does not work with any real
calendar app, in exchange for protection an attacker does not need: the port is
loopback-only, so reaching it already means code running as the same OS user,
who could read the exported file directly. What does stand between it and a
malicious page in a browser tab is `access-control-allow-origin: null`, which
refuses every origin — that, the off-by-default setting and the loopback bind
are the three guards the route gets.

---

## Two devices

### Pair over your LAN, and nothing else

Scan a QR code on the other device and the two exchange keys directly: ECDH
P-256 to agree a session key, AES-GCM for everything after that, and a one-time
token that expires two minutes after the code appears — long enough to scan,
short enough that a screenshotted code is stale by the time anyone acts on it.

**No cloud, no relay, no discovery.** There is no mDNS and no SSDP, because the
QR code already carries the exact `host:port` and there is nothing left to
discover. Both devices must be reachable on the same LAN, Wi-Fi Direct link or
hotspot; this app has no server and relays nothing through the internet, so
there is deliberately **no** fallback for two devices on different networks
that goes through anyone else's machine. When they genuinely cannot see each
other, the fallback is [a file](#the-offline-pairing-file), carried by hand.

The joiner's single POST is relayed through the trusted layer — the main
process on desktop, the native plugin on Android — rather than issued by
`fetch()` in the interface, because the renderer's own CSP is `connect-src
'self'` and widening it for this would have widened it for everything.

### What syncs, and what does not

A sync exchange rarely means "everything": someone pairing a phone wants the
schedule, not their desktop's whole contact book. You choose from five scopes —
**accounts**, **schedule** (reminders and the working calendar), **contacts**,
**templates** and **appearance** — and only what you ticked is offered.

Records that mean the same thing on both devices are recognised as the same
thing: a stable content hash per record type, deliberately ignoring the
volatile bookkeeping an export already strips (run counts, last-run times, ids,
timestamps), so two reminders created independently on two devices are deduped
rather than doubled. Exact match only, on purpose — a fuzzy "looks similar"
pass would eventually drop two contacts who happen to share a name. Same id,
different content is left alone for conflict resolution to handle rather than
guessed at.

**Passwords.** The `accounts` scope *may* carry a real password, where a backup
file never does — and the difference is the point. A backup is a file that can
end up anywhere: attached to an email, in a cloud drive, on a USB stick found
years later. A pairing payload is not a file at all; it exists only inside the
live encrypted session between two devices somebody is holding at the same
time, and stops existing when the session ends. Even then the core code never
reads a keystore itself: a secret only travels if the caller resolved one and
handed it in, and otherwise an account travels exactly as it would in a backup
— marked as having a secret, without one attached.

### Paired devices

A `once` pairing keeps nothing but a receipt in the activity log. An `ongoing`
pairing remembers the device, what it last agreed to sync, and a long-lived key
— and one screen lists those devices, what each is scoped to, and lets you
remove one.

The stored record holds a *pointer* to the key, never the key. The AES-GCM key
material lives exactly where an SMTP password lives — DPAPI-encrypted on
Windows, the hardware-backed Keystore on Android — so a leaked `state.json`
exposes a device *list*, the way it already exposes an account list, and no
more.

**Ongoing sync is honest about being a foreground feature.** While the app is
open it retries the device's last-known LAN address every so often and
exchanges whatever changed. A cycle that cannot reach that address is skipped,
not queued and not escalated. On Android that means sync happens only while
both apps are open at the same time: nothing in this app wakes up to poll,
beyond the alarms that fire scheduled sends. The Settings screen says so in
plain language rather than leaving you to discover it.

### The offline pairing file

Two devices on different Wi-Fi networks, a guest network with client isolation
on, corporate Wi-Fi that blocks device-to-device traffic, or a phone with no
camera to scan with — for all of those, the fallback is a file you carry by
hand, over a cable or a USB stick, the way a paper boarding pass covers for a
phone with no signal.

It is the ordinary backup-file shape with the scopes nobody chose emptied out,
wrapped in one extra envelope: AES-GCM, keyed by a PIN through PBKDF2 with a
random salt. When the only scope chosen is the schedule, the payload is the
existing job-only transfer format instead — that format has never carried
anything but reminders and a schedule-only pairing file should not be the
exception that starts.

**No secrets, ever** — a stricter rule than the live session gets, and for the
obvious reason: a file can be copied, backed up and re-shared long after
whoever wrote it has forgotten the PIN.

---

## Writing mail

### Any attachment, pictures in the body

Documents, images, archives — anything up to your provider's limit. Paste a
copied image straight into the message and it lands inline; any attached image
can also be switched from a file to one shown inside the message, and back.

Aevistle shows the real size on the wire, because base64 makes a 20 MB file
into 27 MB and that is why "under the limit" attachments get bounced.

### Pictures you can actually see

Every image on a message — embedded in the body, riding along as an attachment,
or arriving in your inbox — shows as a thumbnail you can look at instead of a
filename you have to guess from.

Click one for a full-screen viewer: scroll to zoom, drag to pan, double-click
to swap between fitted and actual size, rotate a quarter turn either way,
mirror it, step through the rest of the message with the arrow keys, and read
off the pixel dimensions, file size and format before saving it anywhere or
copying it to the clipboard. `Esc` closes the picture and nothing else.

### Formatting without a rich-text editor

Bold, italic, code, links, lists and quotes, inserted as Markdown into the same
plain box. It is rendered to email-safe HTML on the way out, so the recipient
gets formatting rather than asterisks.

### Merge variables

`{{name}}`, `{{email}}` and your own contact fields, filled in per recipient,
with Cc and Bcc dropped from the copies — a merge is forty private letters, not
one thread with forty people on it.

Alongside those, `{{nextWorkday}}`, `{{prevWorkday}}`, `{{holiday}}`,
`{{nextHoliday}}`, `{{nextDayOff}}`, `{{daysToNextHoliday}}`,
`{{workdaysLeftThisWeek}}` and `{{workdaysLeftThisMonth}}` read the same
working calendar that decides *when* the message goes, resolved at send time —
so a reminder the calendar pushed onto Monday does not still say "see you
tomorrow".

**Why there is no `{{isWorkday}}`.** It would have to render as a word, in a
language this part of the app does not know. A variable it cannot fill is left
standing rather than silently blanked.

### Focus mode

`F9` hides everything except the message and gives the box the whole window.
`Esc` brings the rest back. A live character and byte count sits on the label —
one Chinese character is three bytes, and that is what a provider's size limit
counts.

---

## Receiving mail

### Optional inbox

Turn on IMAP for an account and Aevistle fills in the server for you, tests it
before you save, then syncs a unified inbox across every account — one view, or
filtered to a single account, checked on a schedule you choose.

Opening a message gives it the whole window; `Esc` steps back out. `J`/`K` move
between messages, `Ctrl+F` searches inside one. Received attachments preview in
place — images, PDFs and text — or open with your system's own app, save
anywhere you like, or reveal themselves in the file manager. Remote images stay
blocked until you ask for them, and every link opens through a confirmation
that shows the real destination.

This is deliberately not a full mail client: no folder management, no push IDLE
sync, no server-side delete.

### Verification codes, on their own screen

Codes and sign-in links are lifted out of arriving mail automatically and
collected on a screen of their own — sender, subject, arrival time and the code
itself, set large enough to read at a glance. Click anywhere on a card to copy.
A notification carries the code so you need not open anything at all, and the
history survives deleting the mail it came from.

### Mail that turns into a reminder

Meetings, appointments and deadlines are read out of received mail in all six
of the app's languages, and one button turns one into a scheduled reminder.

The card shows the sentence it read the date from, so you can check it instead
of trusting it, and says out loud when the wording left the date open to more
than one reading. A real invitation carries a `text/calendar` part with the
date already stated exactly — that is read in preference to the prose, on
Windows; the Android inbox does not keep those parts, so it falls back to the
prose reader.

**Saying nothing is the preferred failure:** a missed date costs one read of
the mail, a wrong one costs a meeting.

### Search where you mean

Narrow the inbox search to the sender, the subject or the preview text —
because looking for a person turns up every newsletter that mentions their
name.

### Swipe on a phone

Swipe a message to remove it or to flip whether it has been read. Deliberately
not the server-side delete: that one cannot be undone and has no business
behind a gesture.

### Delete that means something

Two separate actions, because they are two separate requests: remove it from
Aevistle (reversible from a recycle bin that keeps it for seven days) or delete
it from the mailbox on the server (not reversible, and it says so).

---

## Appearance and language

### Seven visual styles

Aurora, Graphite, Paper, Midnight, Nordic, [runecircuit](#runecircuit) and High
contrast, picked from preview tiles in **Settings → Appearance**.

A style is not a colour swap: each one also retunes the corner radius, the line
height and how much shadow is allowed to exist, which is what makes Graphite
read as a different piece of software rather than the same one in grey. Every
style ships a real light form and a real dark one, so "match the system" keeps
working whichever you choose.

**High contrast** is the one where a number is the design — every text pair
clears 7:1, WCAG AAA, including the tertiary timestamps and the semantic
colours on their own tinted backgrounds, which is where AAA schemes usually
stop quietly. Its borders are visible on purpose, at 3.9:1 in light and 6.3:1
in dark, past the 3:1 asked of a control boundary.

On top of the styles: light and dark following the system or pinned, seven
accent colours — retuned by each style rather than taken away, so the choice
survives switching to High contrast — two densities, and a typeface pairing
chosen per script, Songti (宋体) for Chinese and Times New Roman for Latin text
and punctuation.

### runecircuit

Chinese-classical ink aesthetics fused with cyberpunk neon: printed-ink borders
and seal-stamp rings over live circuit traces, in a real day form and a real
night form rather than one look dimmed.

Three dials belong to this style alone:

- **Atmosphere intensity**, 0-100, governing how strongly the ceremonial layer
  shows — card grain, the neon mix in a hover glow, the solar-term wash, the
  seal-stamp and ink-bloom motion. It defaults to 60, and an install that
  predates it reads as 60 rather than as "off". Motion is skipped outright for
  anyone whose system asks for reduced motion.
- **A two-axis accent picker**, because one dial was not enough here. The
  printed-ink half (`ink`, `crimson`, `moonwhite`, `gold`) draws a card border
  at rest, the nav underline and the seal-stamp ring; the live-trace half
  (`cyan`, `magenta`, `blue`) is what the accent tokens keep resolving from.
  The seven-way accent picker is replaced by these two for this style only.
- **A solar-term calendar tint**, which is where the
  [24 solar terms](#24-solar-terms) surface: the month grid takes a colour wash
  from whichever term the month sits in.

### Six languages

English, 简体中文, Français, Español, Русский, العربية — including full
right-to-left layout for Arabic, not translated strings in a left-to-right
frame. Adding a seventh is one file and needs no build tooling; the type system
tells you exactly which strings are missing.

---

## Living with it

### You can see that it sent

Every schedule row carries its last send, whether it succeeded, and how many
times it has run. One-off reminders move to a Completed tab once they are done
instead of sitting in the list still claiming to be waiting.

### Connections that just work

Port and encryption mismatched? Aevistle tries the other combination your
provider accepts instead of failing with "Unexpected socket close", then offers
to save whatever worked. Every attempt is bounded, so the test button always
comes back.

### Says what happened

A successful test reports the endpoint it connected on and the round trip. A
failed one names the cause and what to change. The activity screen keeps a
running success rate and median delivery time.

### Keyboard, and a panel that tells the truth

Every tab has a number, every shortcut is listed, and the list is generated
from the tabs themselves — so it cannot drift out of date the way it once had.

### Take your reminders with you

Export your schedules to a file and import them on another install. No account,
no server, no password ever goes into that file — it is safe to keep in a
backup.

### Passwords stay put

Encrypted by the OS — DPAPI on Windows, the hardware-backed Keystore on
Android. Never in the settings file, never in an export. The same store holds
the long-lived keys of [paired devices](#paired-devices).

### Your folder, your rules

Aevistle asks where to keep your data the first time it starts, and
**Settings → Data folder** moves it later. It relocates what is already there
*and* repairs the paths inside existing schedules, so a reminder made last
month still finds its attachment. See [PRIVACY.md](PRIVACY.md) for what stays
behind and why.

### Updates in the app

Checks GitHub Releases, downloads the installer, verifies it against the
published SHA-256 and hands it to the installer. Android opens the APK for the
system installer. Switchable off; it sends nothing but the request, whitelisted
by host *and* exact path, and it leaves from the trusted process rather than
from the part of the app that renders mail.

---

**See also** — [PRIVACY.md](PRIVACY.md) for storage and what leaves the device,
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit, and the
`docs/release-notes/` directory for what changed when.
