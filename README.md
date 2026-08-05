<div align="center">

<img src="docs/assets/logo.png" alt="Aevistle" width="104" height="104">

# Aevistle

**Scheduled email reminders that actually arrive.**

Write an email once — attach files, images or archives — and Aevistle sends it
on time, even with the window closed. Once, every weekday at 09:00, on the 1st
of the month, or on any cron expression you like. It knows your public
holidays, so the Monday report does not go out on a Monday nobody is working.
Windows and Android, no account, no server, no telemetry. Two devices stay in
step over your own network — no cloud in the middle.

*The weekly report every Friday. The invoice on the 1st. The birthday message
at midnight while you are asleep.*

[![Release](https://img.shields.io/github/v/release/Aevorine/Aevistle?style=flat-square&color=4f46e5)](https://github.com/Aevorine/Aevistle/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Aevorine/Aevistle/ci.yml?branch=main&style=flat-square&color=4f46e5&label=checks)](https://github.com/Aevorine/Aevistle/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-4f46e5?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64-4f46e5?style=flat-square&logo=windows)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B-4f46e5?style=flat-square&logo=android)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Languages](https://img.shields.io/badge/languages-6-4f46e5?style=flat-square)](#language)

### [⬇ Download](https://github.com/Aevorine/Aevistle/releases/latest) · [What it does](#what-it-does) · [Privacy](#privacy) · [Security](#security)

**English** ·
[简体中文](docs/README.zh-CN.md) ·
[Français](docs/README.fr.md) ·
[Español](docs/README.es.md) ·
[Русский](docs/README.ru.md) ·
[العربية](docs/README.ar.md)

</div>

---

<div align="center">
<img src="docs/assets/screenshot-compose.png" alt="The Aevistle compose window" width="880">
</div>

---

## Why this exists

Every mail client can send an email. Almost none of them can promise you it
will go out at 07:00 next Tuesday with the right file attached, whether or not
you remember, whether or not the app is open.

Aevistle is that promise first. No account to create — it connects to the SMTP
server you already have (Gmail, Outlook, QQ, 163, your company's server) and
sends. Receiving is there too, but it stays out of the way until you turn it
on: point an account at its IMAP server and Aevistle pulls in a unified inbox,
lifts out verification codes and login links automatically, and leaves
everything else alone by default.

**People use it to** send a weekly report every Friday at 17:00 · remind a class
about homework the night before it is due · mail an invoice on the 1st of every
month · post a birthday message at midnight while asleep · deliver a rent
reminder every 30 days · schedule a follow-up so a reply lands in the morning
rather than at 02:00 · grab a login code the moment it lands without switching
apps.

**It might not be for you if** you want a full-featured mail client — no folder
management, no push IDLE sync, no server-side delete, on purpose — a marketing
tool with tracking pixels and open rates, or a hosted service that keeps sending
while your devices are switched off. Aevistle sends and reads from *your*
machine using *your* mailbox, which is exactly why it needs no account of its
own and collects nothing.

## Privacy

Aevistle has no server. There is no account to create, no telemetry and no
crash reporting.

A short, fixed list of things ever leaves your device: **the SMTP connection to
your own provider**; **the IMAP connection to your own provider**, for accounts
where you turned receiving on; **a remote image in a received message**, only
when you ask for that one by name; **an update check** to `api.github.com`, if
you leave it on; and **one year of public holiday dates**, when you press
"check online". The last two are whitelisted by host *and* exact path and leave
from the trusted process, not from the part of the app that renders mail —
which has no outbound network reach at all.

Pairing two devices adds nothing to that list. They talk to each other on your
own network, with no cloud and no relay in the middle.

> With updates switched off, every remaining request in that list is one you
> pressed a button for.

Where each thing is stored, what moving the data folder does, and the two
things that deliberately stay behind → **[docs/PRIVACY.md](docs/PRIVACY.md)**.

## What it does

| | |
|---|---|
| ⏰ **Fires when closed** | A tray process on Windows, an exact alarm plus WorkManager on Android. Closing the window does not cancel your reminders. [→](docs/FEATURES.md#fires-when-closed) |
| 🔁 **Real recurrence** | Once, every N minutes, daily, weekly, monthly, yearly, or a full 5-field cron expression. [→](docs/FEATURES.md#real-recurrence) |
| 📎 **Attachments that survive the wait** | Files are snapshotted when you schedule, so moving or renaming the original does not silently break the send. [→](docs/FEATURES.md#attachment-snapshots) |
| 🎌 **Working calendars** | Public holidays, weekends of your own choosing, 调休 make-up days, six country presets and `.ics` both ways. Each reminder opts in. [→](docs/FEATURES.md#working-days-you-define) |
| 🌐 **Delivery windows** | A reminder lands inside the *recipient's* working day, not yours — and it is reported, never held back, when the windows cannot agree. [→](docs/FEATURES.md#delivery-windows) |
| 📆 **The month grid is the schedule** | Drag to move, click to open, tinted by how busy the day is — plus recipient chips, a body preview and delivery badges. [→](docs/FEATURES.md#the-month-grid-is-the-schedule) |
| 📥 **Optional inbox** | IMAP, unified across accounts, remote images blocked by default, with verification codes lifted onto a screen of their own. [→](docs/FEATURES.md#optional-inbox) |
| 🔤 **Merge variables** | Per-recipient contact fields plus calendar ones like `{{nextWorkday}}`, resolved at send time, with Cc and Bcc dropped from the copies. [→](docs/FEATURES.md#merge-variables) |
| 🔐 **Passwords stay put** | Encrypted by the OS: DPAPI on Windows, the hardware-backed Keystore on Android. Never in the settings file, never in an export. [→](docs/FEATURES.md#passwords-stay-put) |
| 🎨 **Seven visual styles** | Each with a real light and a real dark form, and one of them WCAG AAA throughout rather than approximately. [→](docs/FEATURES.md#seven-visual-styles) |

Thirty-six of these, each with the reasoning behind it →
**[docs/FEATURES.md](docs/FEATURES.md)**

## New in 0.1.16

Repairs to the phone layout 0.1.15 introduced — no feature changed, and nothing
about how mail is scheduled, sent, stored or encrypted was touched.

- **Dialogs are the screen, not a card floating on it.** A settings section
  opened with a gutter all round and the tab bar showing through underneath.
  Content dialogs now go edge to edge, closed with the button in the header;
  short confirmations deliberately stay cards.
- **Screens opened from Home had lost their main button.** Hiding a duplicated
  heading also hid the element carrying each screen's primary control, so
  Contacts offered no way to add a contact. Only the heading text goes now.
- **Settings stopped repeating itself** — the sticky subtitle that summarised
  the rows directly beneath it, and each section naming itself twice.

Measured on the running window rather than reasoned about: the three content
dialogs each report `(0, 0, 390, 800)` in a `390×800` viewport, the
confirmation `350×254` with symmetric gutters.

## New in 0.1.15

- **📲 Android updates itself.** The check always worked; downloading and
  installing were desktop-only, so the phone could announce a new version and
  then offer a link to a web page. It now fetches the APK in-app with a
  progress bar, verified against the release's published `SHA256SUMS`, and
  hands it to the system installer — which still asks you to confirm. The file
  is written to app-private storage, not a shared Downloads folder.
- **🏠 A Home tab, and a bottom bar that fits.** Nine tabs never fit a 360px
  screen; the bar had quietly been a horizontal scroller with four of them
  off-screen. It is five now — Compose, Codes, Home, Inbox, Settings — with
  schedules, contacts, templates, the working calendar and the send log behind
  Home. The desktop sidebar still lists all nine, and `Ctrl+1`–`Ctrl+9` still
  reach all nine on both.
- **⚙️ Settings is a list, not fourteen screens of scrolling.** Sixteen sections
  in one column made reaching Privacy a scroll past every other section. On a
  phone it is now sixteen rows that open one at a time; the desktop keeps its
  two-column grid. Explanatory text under toggles stands down on phones —
  warnings and errors never do.
- **📡 Pairing dials the right network card.** It used to publish the first
  address the OS listed, which on a machine with a VPN, a hypervisor or a
  container runtime was routinely a virtual adapter no phone can reach — a
  four-second timeout on the other device and no clue anywhere. Addresses are
  ranked now, the chosen one is printed beside the QR code, and a multi-homed
  machine gets a picker.

Also fixed: toggle switches whose knob never moved on older Android WebView
builds, and a "launch at login" entry a source checkout could leave pointing at
Electron's own placeholder window.

## New in 0.1.14

- **🔗 Pair two devices over your LAN, and nothing else.** Scan a QR code on the
  other device: ECDH P-256 + AES-GCM, a one-time token that expires in two
  minutes, and no cloud and no relay server at any point. Choose what syncs —
  accounts, schedule, contacts, templates, appearance — and manage paired
  devices from one screen. Two devices that cannot see each other exchange a
  PIN-encrypted file instead.
- **📅 The calendar knows about the mail.** Recipient chips and mail counts per
  day, a density heatmap, body preview without leaving the grid, the
  recipient's local time shown *while* you drag to reschedule, a suggestion
  when a send lands on a holiday, bulk actions across a recurring series,
  filtering by account or recipient, delivery-status badges, and a local `.ics`
  subscribe address for the working calendar.
- **🎨 A new visual style: runecircuit.** Chinese-classical ink meets cyberpunk
  neon, with day and night forms, an atmosphere-intensity dial and a two-axis
  accent picker. The seventh style, and the first one with weather.
- **🌾 24 solar terms (节气), computed rather than looked up.** Meeus's solar
  position, not a bundled table — so there is no year the coverage stops. It
  tints the calendar; it never touches a send time.

Written up at length in **[docs/FEATURES.md](docs/FEATURES.md)**; what changed
before this is in the `release-notes-0.1.*.md` files.

## Download

Grab the latest build from **[Releases](https://github.com/Aevorine/Aevistle/releases/latest)**.

| Platform | File to pick | Notes |
|---|---|---|
| Windows 10/11 (x64) | `Aevistle-<version>-win-x64-setup.exe` | Installer, adds a Start-menu and desktop shortcut |
| Windows 10/11 (x64) | `Aevistle-<version>-win-x64-portable.exe` | Single file, no installation, runs from a USB stick |
| Android 7.0+ | `Aevistle-<version>.apk` | Phones and tablets. Enable "install unknown apps" for your browser or file manager for this first install; later updates are offered inside the app. |

`<version>` is whatever the [latest release](https://github.com/Aevorine/Aevistle/releases/latest)
page is showing — the badge at the top of this page reads it from the same
place. Deliberately not written out here, so this table cannot go stale.

> **Verifying a download.** Every release publishes `SHA256SUMS.txt`, a
> detached signature `SHA256SUMS.txt.asc`, and the public key that made it:
>
> ```bash
> gpg --import aevistle-public-key.asc
> gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
> sha256sum -c SHA256SUMS.txt
> ```
>
> The checksums alone prove the file arrived intact; the signature proves it
> came from this project's key. The fingerprint is in
> [SECURITY.md](SECURITY.md).

> Windows SmartScreen will warn about an unrecognised publisher. That is what a
> release without a paid code-signing certificate looks like; choose
> **More info → Run anyway**, or check the SHA-256 from the release page first.

## Getting started

1. **Add your mailbox.** Settings → Add account. Pick your provider and Aevistle
   fills in the server, port and encryption for you.
2. **Get an app password.** Gmail, Outlook, Yahoo, iCloud, QQ and 163 all refuse
   your normal login password from a third-party app. The account dialog links
   straight to the page where you create one.
3. **Test the connection.** One button. It authenticates without sending
   anything, so you find out now rather than at 03:00.
4. **Write your reminder**, attach what you need, and choose **Schedule**.

<div align="center">
<img src="docs/assets/screenshot-settings.png" alt="Aevistle settings, showing the mail account and data folder cards" width="880">
</div>

For scheduled sends to fire while the window is closed, leave
*Keep running in the tray* on (Windows), and allow exact alarms and
notifications when Android asks.

## Security

The threat model, the hardening choices, and how to report a vulnerability are
in **[SECURITY.md](SECURITY.md)**.

The short version: the renderer runs with no Node access, context isolation on
and a strict CSP; every string bound for a mail header is rejected if it
contains a line break (that is how open relays happen); TLS certificates are
verified unless you explicitly turn that off per account; a received message's
HTML is sanitized in the main process to a strict allowlist before it ever
reaches the renderer, and rendered in a sandboxed iframe with no script
execution allowed regardless; and the Android alarm receiver is not exported,
so no other app can make Aevistle send mail.

You can check all of that yourself with `npm run audit:self` — **21 checks**,
plain-language output, exit code 1 if anything needs attention.

## Build from source

**Requirements** — Node.js 20+, and for Android: JDK 17+, Android SDK
(platform 36, build-tools 35+). `npm run build:android` finds a JDK and an SDK
that are installed but not on `PATH`, so setting `JAVA_HOME` is optional.

```bash
git clone https://github.com/Aevorine/Aevistle.git
cd Aevistle
npm install
```

| Task | Command |
|---|---|
| Run in a browser (no SMTP, everything else live) | `npm run dev` |
| Type-check | `npm run typecheck` |
| Security audit (21 checks) | `npm run audit:self` |
| Everything CI runs (42 checks) | `npm run check` |
| Run the desktop app | `npm start` |
| Build Windows installers | `npm run dist:win` |
| Build the Android APK | `npm run build:android` |

Release signing for Android reads `~/.aevistle/keystore.properties` or the
`AEVISTLE_KEYSTORE*` environment variables. Without either, the build falls
back to the debug key so you still get an installable APK.

## How it is put together

One React + TypeScript interface, two native shells.

```
src/core/        platform-independent: domain model, recurrence engine,
                 validation, SMTP provider presets — no DOM, no Node, no Android
src/            the React interface (six locales, seven visual styles, each in
                 a real light and a real dark form)
    ↓ PlatformBridge — the single seam between the UI and an operating system
electron/       Windows: nodemailer + imapflow, DPAPI secret storage, tray,
                hybrid tick/precise scheduler, HTML sanitization for received mail
android/        Android: JavaMail (send + receive), Keystore, AlarmManager + WorkManager
```

The recurrence engine deliberately lives in TypeScript only. It precomputes a
list of absolute timestamps, and each platform's scheduler just answers "wake
me at T" — so every calendar rule (leap years, short months, DST, weekend
skipping) exists once, in one language, and is testable without an emulator.

More detail in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Roadmap

Not promises — the things most likely to come next.

- [ ] OAuth 2.0 for Gmail and Microsoft 365, so app passwords stop being needed
- [ ] A rich-text composer. Inline images already work; the box itself is still
      plain text with Markdown
- [ ] macOS and Linux desktop builds (the code already targets them)
- [ ] `docs/FEATURES.md` in the other five languages
- [ ] iOS

Something missing? [Open an issue](https://github.com/Aevorine/Aevistle/issues) —
feature requests are genuinely welcome.

## Contributing

Pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the
layout of the codebase and what a good change looks like, and
**[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** for how people are expected to
treat each other here. Adding a seventh language is one file and needs no build
tooling — the type system tells you exactly which strings are missing.

Bug reports and feature requests have
[templates](https://github.com/Aevorine/Aevistle/issues/new/choose); every pull
request runs the same `npm run check` you would run locally.

## Language

| | | |
|---|---|---|
| [English](README.md) | [简体中文](docs/README.zh-CN.md) | [Français](docs/README.fr.md) |
| [Español](docs/README.es.md) | [Русский](docs/README.ru.md) | [العربية](docs/README.ar.md) |

## License

[MIT](LICENSE) © Aevistle contributors
