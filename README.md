<div align="center">

<img src="docs/assets/logo.png" alt="Aevistle" width="104" height="104">

# Aevistle

**Scheduled email reminders that actually arrive.**

Write an email once — with files, images or archives attached — and Aevistle
delivers it on time. Once, every weekday at 09:00, on the 1st of the month, or
on any cron expression you like. Same app on Windows and Android.

[![Release](https://img.shields.io/github/v/release/Aevorine/Aevistle?style=flat-square&color=4f46e5)](https://github.com/Aevorine/Aevistle/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-4f46e5?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64-4f46e5?style=flat-square&logo=windows)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B-4f46e5?style=flat-square&logo=android)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Languages](https://img.shields.io/badge/languages-6-4f46e5?style=flat-square)](#language)

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

## What it does

| | |
|---|---|
| 📮 **Send now or later** | The two buttons that matter are pinned to the bottom of the compose screen at every window size. You never scroll to send. |
| 📥 **Optional inbox** | Turn on IMAP for an account and Aevistle fills in the server for you, tests it before you save, then syncs a unified inbox across every account — one view, or filtered to a single account, checked on a schedule you choose. Opening a message gives it the whole window; `Esc` steps back out. `J`/`K` move between messages, `Ctrl+F` searches inside one. Received attachments preview in place — images, PDFs and text — or open with your system's own app, save anywhere you like, or reveal themselves in the file manager. Remote images stay blocked until you ask for them, and every link opens through a confirmation that shows the real destination. |
| 🔑 **Verification codes, on their own screen** | Codes and sign-in links are lifted out of arriving mail automatically and collected on a screen of their own — sender, subject, arrival time and the code itself, set large enough to read at a glance. Click anywhere on a card to copy. A notification carries the code so you need not open anything at all, and the history survives deleting the mail it came from. |
| ⚡ **Burst sending** | A single scheduled fire can send the same message several times in a row, paced by however many milliseconds you set — for stress-testing your own send path, not for spamming anyone. |
| 📎 **Any attachment, pictures in the body** | Documents, images, archives — anything up to your provider's limit. Paste a copied image straight into the message and it lands inline; any attached image can also be switched from a file to one shown inside the message, and back. Aevistle shows the real size on the wire, because base64 makes a 20 MB file into 27 MB and that is why "under the limit" attachments get bounced. |
| 🖼️ **Pictures you can actually see** | Every image on a message — embedded in the body, riding along as an attachment, or arriving in your inbox — shows as a thumbnail you can look at instead of a filename you have to guess from. Click one for a full-screen viewer: scroll to zoom, drag to pan, double-click to swap between fitted and actual size, rotate a quarter turn either way, mirror it, step through the rest of the message with the arrow keys, and read off the pixel dimensions, file size and format before saving it anywhere or copying it to the clipboard. `Esc` closes the picture and nothing else. |
| 📆 **A working calendar that shows its work** | Public holidays, weekends you define yourself, and make-up workdays — with a month grid where clicking a day switches it, one-click starting points for six countries, and a count on each date of how many reminders land there, filled in when the calendar is what moved one. |
| 📊 **You can see that it sent** | Every schedule row carries its last send, whether it succeeded, and how many times it has run. One-off reminders move to a Completed tab once they are done instead of sitting in the list still claiming to be waiting. |
| 🗑️ **Delete that means something** | Two separate actions, because they are two separate requests: remove it from Aevistle (reversible from a recycle bin that keeps it for seven days) or delete it from the mailbox on the server (not reversible, and it says so). |
| ✍️ **Focus mode** | `F9` hides everything except the message and gives the box the whole window. `Esc` brings the rest back. A live character and byte count sits on the label — one Chinese character is three bytes, and that is what a provider's size limit counts. |
| 🔁 **Real recurrence** | Once · every N minutes · daily · weekly on chosen days · monthly (with a sane rule for the 31st) · yearly · full 5-field cron. |
| 🔒 **Attachment snapshots** | Schedule a reminder for next month and Aevistle keeps its own copy of the files, so moving or renaming the originals does not silently break it. |
| ⏰ **Fires when closed** | Windows keeps a tray process; Android uses an exact alarm plus WorkManager. Closing the window does not cancel your reminders. |
| 🌙 **Catch-up policy** | Laptop was asleep across three fire times? Choose one catch-up send, or skip. You will not wake up to three identical emails. |
| 🎲 **Jitter & weekday skipping** | Spread sends across a window so your provider does not read a burst as spam, and push weekend fires to Monday. |
| 🔐 **Passwords stay put** | Encrypted by the OS — DPAPI on Windows, the hardware-backed Keystore on Android. Never in the settings file, never in an export. |
| 📂 **Your folder, your rules** | Aevistle asks where to keep your data the first time it starts, and **Settings → Data folder** moves it later. It relocates what is already there *and* repairs the paths inside existing schedules, so a reminder made last month still finds its attachment. |
| 🔌 **Connections that just work** | Port and encryption mismatched? Aevistle tries the other combination your provider accepts instead of failing with "Unexpected socket close", then offers to save whatever worked. Every attempt is bounded, so the test button always comes back. |
| 🩺 **Says what happened** | A successful test reports the endpoint it connected on and the round trip. A failed one names the cause and what to change. The activity screen keeps a running success rate and median delivery time. |
| 🌙 **Quiet hours** | Hold overnight reminders until morning. Sending by hand is never held — you are standing right there. |
| ⬆️ **Updates in the app** | Checks GitHub Releases, downloads the installer, verifies it against the published SHA-256 and hands it to the installer. Android opens the APK for the system installer. Switchable off; it sends nothing but the request. |
| 🌍 **Six languages** | English, 简体中文, Français, Español, Русский, العربية — including full right-to-left layout for Arabic. |
| 🎨 **Yours to look at** | Light and dark, following the system or pinned, six accent colours, two densities, and a typeface pairing chosen per script: Songti (宋体) for Chinese, Times New Roman for Latin text and punctuation. |

## Download

Grab the latest build from **[Releases](https://github.com/Aevorine/Aevistle/releases/latest)**.

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `Aevistle-0.1.4-win-x64-setup.exe` | Installer, adds a Start-menu and desktop shortcut |
| Windows 10/11 (x64) | `Aevistle-0.1.4-win-x64-portable.exe` | Single file, no installation, runs from a USB stick |
| Android 7.0+ | `Aevistle-0.1.4.apk` | Phones and tablets. Enable "install unknown apps" for your browser or file manager first. |

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

## Privacy

Aevistle has no server. There is no account to create, no telemetry and no
crash reporting.

A short, fixed list of things ever leave your device, and nothing else does:

1. **The SMTP connection to your own mail provider** — your message, to the
   mailbox you configured.
2. **The IMAP connection to your own mail provider** — only for accounts where
   you turned receiving on, only to fetch mail for that account.
3. **A remote image inside a received message, only when you explicitly ask to
   load it** — every image is blocked by default and replaced with a
   placeholder, because a remote `<img>` is the oldest tracking trick in email.
   The fetch itself is guarded against being redirected to your own network
   (no internal IPs, no redirects followed).
4. **An update check**, if you leave it on: an unauthenticated `GET` to
   `api.github.com` asking what the latest release is. It carries no account
   details, no message content and no usage data. Turn it off in
   **Settings → Updates** and the app makes no requests of its own at all.

Everything lives on your device:

| | Windows | Android |
|---|---|---|
| Settings, schedules, contacts, log | `<data folder>\state.json` | app storage |
| Mail passwords | `secrets.json`, encrypted with DPAPI | Android Keystore (hardware-backed where available) |
| IMAP passwords | Same file, same encryption, a separate keystore entry from the SMTP password for that account | Same Keystore, separate entry |
| Attachment snapshots | `<data folder>\attachments\` | `<data folder>/attachments` |
| Received-mail cache (bodies, attachments) | `<data folder>\inbox\` — a bounded cache with an age and size limit you can set in **Settings**, safe to delete: it just re-syncs | `<data folder>/inbox` |

The data folder starts at `%APPDATA%\Aevistle` on Windows and app-private
storage on Android, and **Settings → Data folder** moves it anywhere you can
write — a second drive, a synced folder, a USB stick. On Android the choice is
between the storage volumes the system actually lets an app write to (private,
shared, SD card), because a folder picked through the document picker cannot be
opened by the background sender hours later.

Two things deliberately stay behind: passwords, which are encrypted against
your OS user account and are useless elsewhere, and — on Android — the alarm
schedule, so that removing an SD card cannot stop a reminder from firing.

Exporting your settings never includes a password.

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

You can check all of that yourself:

```bash
npm run audit:self
```

20 checks, plain-language output, exit code 1 if anything needs attention.

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
| Security audit | `npm run audit:self` |
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
src/            the React interface (six locales, dual theme)
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
- [ ] Rich-text composer with inline images
- [ ] Import and export schedules as a file
- [ ] macOS and Linux desktop builds (the code already targets them)
- [ ] Per-recipient template variables (`{{name}}`)
- [ ] iOS

Something missing? [Open an issue](https://github.com/Aevorine/Aevistle/issues) —
feature requests are genuinely welcome.

## Contributing

Pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the
layout of the codebase and what a good change looks like. Adding a seventh
language is one file and needs no build tooling — the type system tells you
exactly which strings are missing.

## Language

| | | |
|---|---|---|
| [English](README.md) | [简体中文](docs/README.zh-CN.md) | [Français](docs/README.fr.md) |
| [Español](docs/README.es.md) | [Русский](docs/README.ru.md) | [العربية](docs/README.ar.md) |

## License

[MIT](LICENSE) © Aevistle contributors
