# Security

Aevistle holds the password to your mailbox and can send mail as you without
you being present. That is a meaningful amount of trust, so this document says
plainly what the app defends against, what it does not, and how to tell us when
we got it wrong.

## Reporting a vulnerability

Please **do not** open a public issue for a security bug.

Use GitHub's private reporting:
**[Report a vulnerability](https://github.com/Aevorine/Aevistle/security/advisories/new)**

Useful things to include: what you did, what happened, which build and OS, and
whether you needed local access. A proof of concept helps but is not required —
a clear description of the flaw is enough to get started.

Expect a first reply within a week. If a fix is warranted it ships in the next
release with credit, unless you would rather not be named.

## Threat model

**Defended against**

- Another user account on the same computer reading your mail password
- An app on the same Android device triggering a send, or reading stored data
- A network attacker between you and your mail server reading credentials
- Malicious content in a message — a subject, body, template or attachment name —
  escalating into extra mail headers or code execution
- A corrupted or hand-edited settings file crashing the app or escaping its
  data directory
- A **received** message's HTML escalating into script execution, or a remote
  image inside one being used to probe your own network or confirm the
  message was opened

**Not defended against, and cannot be**

- Malware already running as *your* user on *your* machine. It can read the
  keystore exactly as the app can; every local credential store has this
  property.
- A compromised or hostile mail provider. Aevistle authenticates to the server
  you name and hands it your message — this applies equally to sending and to
  receiving.
- Someone with your unlocked device. There is no separate app lock yet.
- Traffic analysis. Your provider necessarily knows who you mailed and when,
  and, for accounts with receiving turned on, who mailed you.

## How credentials are stored

The password is never written into the settings file, never included in an
export, and never sent anywhere other than the SMTP server you configured.

| Platform | Mechanism |
|---|---|
| Windows | Electron `safeStorage`, backed by DPAPI. The ciphertext is bound to your Windows user account; copying `secrets.json` to another machine yields nothing. |
| Android | A 256-bit AES-GCM key generated in the Android Keystore, hardware-backed on devices with a secure element. The key is non-exportable — even a rooted device cannot read it out, only ask the keystore to use it. |

`state.json` (schedules, contacts, activity log) is deliberately kept separate
from `secrets.json` so that the file a user might copy or paste into a bug
report never contains a credential.

An account's IMAP password (for receiving) and SMTP password (for sending)
are stored under separate keystore entries, even though they belong to the
same account — namespaced by a `:imap` suffix on the storage key. Turning
receiving off, or removing just the IMAP credential, can never clobber the
SMTP password the account still needs to send.

**Remote images and SSRF.** Loading a remote image on request is a
"fetch an attacker-chosen URL" primitive, so the destination is checked against
private, loopback and link-local ranges before anything connects. Two paths
have to be covered, not one: hostnames resolve through a custom `lookup` hook
so the address checked is the address connected to (no DNS-rebinding gap), and
URLs that already contain a literal IP are rejected up front — those never
reach the hook at all, because the networking stack only resolves what needs
resolving. `INBOX-05` in `scripts/audit.mjs` fails the build if either half
goes missing.

If no separate receiving password was ever stored, receiving falls back to the
account's own sending password. This does not widen anything: it is the same
credential, for the same account, held under the same OS encryption, used
against the server the same account already authenticates to. Every provider
with a preset here issues one app password covering both protocols, and asking
for it a second time only adds a way to mistype it. Storing a distinct IMAP
password still takes precedence.

## Hardening choices, and why

**SMTP header injection.** The single highest-impact bug class in any mail
client. A newline inside a subject or an address lets an attacker append
`Bcc:` or a new body and turn the app into an open relay. Every string bound
for a header is rejected if it contains CR, LF, NUL, VT, FF, U+2028 or U+2029 —
in the renderer, again in the Electron main process, and again in the Android
sender. Three checks for one bug is deliberate: the renderer is the part an
attacker reaches first, and the other two are where a bad header would become
bytes on a socket.

**Renderer privileges.** `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. The renderer reaches the operating system only through the
method list in `src/core/ipc-contract.ts`, which takes plain serialisable data
and nothing else. A cross-site scripting bug in the UI stays a UI bug.

**Content Security Policy.** `script-src 'self'` with no `unsafe-inline` and no
`unsafe-eval`; `object-src`, `frame-src` and `frame-ancestors` are `none`. The
app never loads remote content, so nothing legitimate is lost.

**Navigation.** `window.open` is intercepted and denied; cross-origin
`will-navigate` is cancelled. `openExternal` accepts only `http:` and `https:`,
so a crafted link cannot hand a `file://` path or a custom protocol handler to
the OS.

**TLS.** Certificates are verified and TLS 1.2 is the floor. Accepting invalid
certificates is a per-account switch, painted red, that says in plain words
what it costs you. It exists because self-hosted servers with private CAs are
real, not because it is ever a good default.

**Attachments.** Paths are resolved and stat-ed before a connection is opened,
so a missing file fails cleanly rather than half-sending. The filename written
into the MIME part is passed through `basename`, so a crafted name cannot talk
the receiving client into writing outside its downloads folder. There is a hard
total-size ceiling independent of the per-provider limit.

**Android components.** `AlarmReceiver` is `exported="false"` — without that,
any app on the device could broadcast an intent and make Aevistle send mail.
`allowBackup="false"` keeps `adb backup` from copying schedules and settings off
the device. `usesCleartextTraffic="false"`. The permission list is four entries
long and each one is justified in a comment in the manifest.

**Content URIs.** Files picked on Android are copied into app-private storage
immediately. A `content://` grant expires; a reminder scheduled for next month
would otherwise find its attachment unreadable.

**Received mail.** Receiving is opt-in per account and everything below
applies the moment it is turned on:

- A message's HTML is sanitized to a strict tag/attribute allowlist — no
  `script`, `iframe`, `object`, `embed`, `form`, `style`, `link`, `meta`, or
  `on*` handler survives — before it crosses any process or WebView boundary.
  On desktop this happens in the Electron main process, in
  `electron/sanitizeHtml.ts` (`sanitize-html`); on Android, in
  `InboxSanitizer.java` (Jsoup `Safelist`), which goes one step stricter and
  drops the `style` attribute entirely rather than trying to filter individual
  CSS properties.
- The sanitized result is rendered inside a sandboxed `<iframe>` with no
  `allow-scripts`, so even a sanitizer bug would still hit a wall that cannot
  execute anything — the renderer never uses `innerHTML` or
  `dangerouslySetInnerHTML` for message content, the same invariant the audit
  script already enforced everywhere else in the codebase.
- Every remote `<img>` is blocked by default and replaced with a placeholder;
  loading the real image is an explicit action, and the fetch that follows
  goes through a resolver that rejects private, loopback, and link-local
  addresses before connecting — so a message cannot use an `<img>` tag to probe
  your own LAN or a cloud metadata endpoint. **Desktop** closes this
  completely: Node's `http(s).request` takes a custom DNS resolver, so the
  address checked is the exact same one connected to, with no gap for a
  DNS-rebinding attacker to answer differently between the two. **Android**
  has a narrower version of the same guard — `java.net.HttpURLConnection` has
  no equivalent hook, so the check and the connection resolve the hostname
  separately, leaving a small window for a rebinding attack. Pinning the
  connection to the checked IP address would close it, but breaks TLS SNI for
  any image host behind SNI-based virtual hosting (most real CDNs); the
  trade-off was made in the guard's favour of not breaking HTTPS for the
  common case, with the gap noted here rather than silently accepted.
- Clicking a link inside a message body always shows the resolved destination
  host before handing it to the same `openExternalSafely()` path a template's
  links already used — link text and href disagreeing is the oldest phishing
  trick in email.
- Removing a message from the inbox view deletes the local cache only —
  Aevistle never sends an IMAP `\Deleted`/EXPUNGE to the server. Providers
  disagree on what server-side "delete" should even mean; guessing wrong risks
  losing mail the user did not intend to lose.

**Supply chain.** On desktop: `nodemailer` and `imapflow` for SMTP/IMAP,
`mailparser` and `sanitize-html` for parsing and sanitizing received mail,
plus the Capacitor packages used only on mobile. On Android: `android-mail`
and `android-activation` (send and receive both go through the same JavaMail
dependency) and Jsoup (received-mail sanitization). The icon set is
hand-drawn SVG rather than an icon library, and there is no analytics,
crash-reporting or auto-update dependency. `package-lock.json` is committed.

## Checking it yourself

```bash
npm run audit:self
```

Twenty-one checks covering committed credentials, `.gitignore` coverage,
Electron window flags, navigation guards, CSP strictness, `eval`/`innerHTML`
usage, header-injection guards on both platforms, TLS configuration, attachment
path handling, Android manifest exposure, keystore usage, dependency surface,
received-mail sanitization, remote-image CSP coverage, IMAP credential
namespacing, the `revealPath` path guard, and update-checksum fail-closed
behavior. Exit code 1 if anything needs attention.

Alongside it:

```bash
npm run audit:deps      # advisories, against registry.npmjs.org
npm run check           # the above plus typecheck and every behavioural guard
```

`audit:deps` distinguishes three outcomes rather than two: clean, an advisory
at or above the threshold (exit 1), and *the database could not be reached* —
which is reported loudly and does not pass silently as if nothing were wrong.

### Verifying what you downloaded

Every release publishes `SHA256SUMS.txt` next to the binaries.

```bash
sha256sum -c SHA256SUMS.txt
```

### The checksums themselves are signed

`SHA256SUMS.txt` proves a download was not corrupted on the way to you. On its
own it cannot prove who published it — the file and the binaries it describes
come from the same place, reachable by the same credential, so anyone able to
replace one can replace the other. That is the gap the signature closes.

```bash
gpg --import aevistle-public-key.asc     # published with every release
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

Signing key fingerprint:

```
<!-- AEVISTLE_GPG_FINGERPRINT -->not yet published
```

If `gpg --verify` reports anything other than a good signature from that
fingerprint, do not install the download — whatever else is wrong, it did not
come from this project's key.

Maintainers: the key is created once with `scripts/setup-signing-key.ps1`
(Windows) or `scripts/setup-signing-key.sh`. On Windows use the PowerShell one
— typing `bash` there resolves to WSL, which has a different home directory, so
the key would land where nothing else can find it. After that `npm run
release:sign -- <tag>` signs and publishes, and `npm run check:signing` fails
if a published release is missing its signature.

### The Android package

The Android package is signed with a key that has not changed since the first
release and will not change. Check that the APK you have is the one this
project built:

```bash
apksigner verify --print-certs Aevistle-<version>.apk
```

```
Signer #1 certificate SHA-256 digest: 563e9757d43f821986d271d0c27e9b7422124d9d7d024d230dd28f6f7697d08d
Signer #1 certificate SHA-1 digest:   15e23a5fb7ec677cabcfd50529c22e873d20a29d
```

A different fingerprint means a different signer — not a new version of this
app. The Windows builds are **not** code-signed (see "Hardening choices"), so
`SHA256SUMS.txt` is the only integrity check available for those.

It runs on the source tree, so it works on a clone as well as on this
repository.

## Supported versions

Pre-1.0, only the latest release receives fixes.

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
