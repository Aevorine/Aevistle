# Where your data lives

The [README](../README.md#privacy) states the short version: Aevistle has no
server, and a fixed five-item list is everything that ever leaves your device.
This file is the rest of it — where each thing is stored, what moving the data
folder does and does not move, and why two things deliberately stay behind.

---

## What leaves the device, in full

1. **The SMTP connection to your own mail provider** — your message, to the
   mailbox you configured.
2. **The IMAP connection to your own mail provider** — only for accounts where
   you turned receiving on, only to fetch mail for that account.
3. **A remote image inside a received message, only when you explicitly ask to
   load it** — every image is blocked by default and replaced with a
   placeholder, because a remote `<img>` is the oldest tracking trick in email.
   The fetch itself is guarded against being redirected to your own network (no
   internal IPs, no redirects followed).
4. **An update check**, if you leave it on: an unauthenticated `GET` to
   `api.github.com` asking what the latest release is. It carries no account
   details, no message content and no usage data. Turn it off in
   **Settings → Updates** and the app never makes this one on its own.
5. **A public holiday table, only when you press "check online"** — an
   unauthenticated `GET` for one year's dates.

Both 4 and 5 are whitelisted by host *and* exact path, and both leave from the
trusted process rather than from the part of the app that renders mail, which
has no outbound network reach at all.

With updates switched off, every remaining request in that list is one you
pressed a button for.

**Pairing adds nothing to this list.** Two paired devices talk to each other
directly on your own network — see
[FEATURES.md](FEATURES.md#pair-over-your-lan-and-nothing-else). There is no
cloud account, no relay and no discovery service, which is also why two devices
on different networks have no online fallback at all.

---

## Everything lives on your device

| | Windows | Android |
|---|---|---|
| Settings, schedules, contacts, log | `<data folder>\state.json` | app storage |
| Mail passwords | `secrets.json`, encrypted with DPAPI | Android Keystore (hardware-backed where available) |
| IMAP passwords | Same file, same encryption, a separate keystore entry from the SMTP password for that account | Same Keystore, separate entry |
| Paired-device keys | Same store as a mail password; `state.json` holds only a pointer | Same Keystore, separate entry |
| Attachment snapshots | `<data folder>\attachments\` | `<data folder>/attachments` |
| Received-mail cache (bodies, attachments) | `<data folder>\inbox\` — a bounded cache with an age and size limit you can set in **Settings**, safe to delete: it just re-syncs | `<data folder>/inbox` |

---

## The data folder

It starts at `%APPDATA%\Aevistle` on Windows and app-private storage on
Android, and **Settings → Data folder** moves it anywhere you can write — a
second drive, a synced folder, a USB stick. Moving it relocates what is already
there *and* repairs the paths recorded inside existing schedules, so a reminder
made last month still finds its attachment.

On Android the choice is between the storage volumes the system actually lets
an app write to (private, shared, SD card), because a folder picked through the
document picker cannot be opened by the background sender hours later — and a
reminder that cannot read its own attachment at 07:00 is a reminder that fails
silently.

## Two things deliberately stay behind

- **Passwords**, which are encrypted against your OS user account and are
  useless elsewhere. Moving them would move ciphertext nothing at the
  destination can open.
- **On Android, the alarm schedule**, so that removing an SD card cannot stop a
  reminder from firing.

Exporting your settings never includes a password. Neither does a pairing file
carried between two devices by hand — see
[FEATURES.md](FEATURES.md#the-offline-pairing-file) for why that rule is
stricter there than in a live pairing session.

---

The threat model and how to report a vulnerability are in
[SECURITY.md](../SECURITY.md). You can check the hardening claims yourself with
`npm run audit:self` — 21 checks, plain-language output.
