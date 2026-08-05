# Aevistle 0.1.14

The biggest release since 0.1.6: two devices can now stay in step with each
other, the calendar stops being blind to the mail scheduled on it, and there
is a seventh visual style with the first thing in this app that changes with
the seasons.

## Pairing two devices, without a server

Aevistle still has no server and no account. Pairing does not add one — it
adds a direct conversation between two devices on the same LAN, and nothing
that leaves that LAN.

Scan a QR code on the other device and the two sides run an ECDH P-256
handshake over an ephemeral, per-session keypair (`core/pairingCrypto.ts`).
The raw shared secret is not used directly: HKDF splits it into two separate
AES-GCM keys, one per direction. A single shared key would have host and
joiner both encrypting from nonce zero — the first message each way would
collide, which breaks GCM's guarantees outright. Two directional keys keep
every counter unique to the key that used it. The QR payload already carries
the exact `host:port`, so there is no mDNS, no SSDP, no discovery step of any
kind — and no fallback for two devices on different networks, because this
app has nothing to relay them through.

The renderer's CSP is `connect-src 'self'`, so it cannot make the request
itself. On desktop the request goes out through `electron/pairingServer.ts` /
`electron/syncServer.ts` in the main process; on Android, a raw-socket relay
in `AevistleNativePlugin.java` does the equivalent job, checking the
destination against the private-address ranges before it dials — the same
check `electron/main.ts`'s `isLanRelayUrl` does on desktop, because
`network_security_config.xml`'s `domain` rules have no CIDR form and cannot
express `10/8` or `192.168/16` themselves.

A **one-time** pairing exchanges data once and throws the session key away
immediately after. An **ongoing** pairing keeps the paired device and a
long-lived key, and `core/syncLoop.ts` retries its last-known LAN address on a
timer while both apps are open — no push, no relay, no persistent background
service. A cycle that cannot reach the address is skipped, not queued or
escalated, and the Settings screen says exactly that rather than implying more
than the app can promise. Sync is additive only: records merge forward by
`updatedAt`, the same rule an ordinary backup restore already uses, so
uninstalling the app on your phone can never delete a contact on your
desktop. Two devices that cannot see each other on the network exchange a
PIN-encrypted file instead, for the same one-time transfer without the LAN
requirement.

What syncs is a choice, not all-or-nothing — accounts, schedule, contacts,
templates, appearance — and paired devices are managed from one screen in
Settings.

## The calendar knows about the mail

Reminders scheduled against the working calendar now show, on the day itself:
who they go to (chips, with a count when there are more than fit), a preview
of the body without opening the reminder, and a delivery-status badge once
they have actually gone out. Dragging a reminder to a new day now shows the
*recipient's* local time while you are still dragging, not after you drop it —
the same information the delivery-window feature already computes, surfaced a
step earlier. A send that would land on a public holiday gets a suggestion
instead of silence, bulk actions apply across a whole recurring series instead
of one occurrence at a time, and the grid can be filtered by account or by
recipient. The working calendar itself now exposes a local `.ics` subscribe
address, so an external calendar app can follow the same set of working days
Aevistle already computes.

## A seventh visual style: runecircuit

Chinese-classical ink meets cyberpunk neon, with a real day form and a real
night form, an atmosphere-intensity dial, and a two-axis accent picker. It is
the first style with weather — which, as of this release, means the 24 solar
terms below.

## 24 solar terms (节气), computed rather than looked up

`cnHolidays.ts` bundles a table because statutory holidays are announcements,
not physics — there is a government notice to transcribe, and a year the
coverage stops. A solar term is the opposite: the instant the sun's apparent
ecliptic longitude crosses a multiple of 15° is pure astronomy, so
`core/solarTerms.ts` computes it from Meeus's low-precision solar-position
polynomial (*Astronomical Algorithms*, ch. 25) instead. That is good to
roughly 0.01° — on the order of a minute of time — for centuries either side
of 2000, comfortably inside the 1900–2100 span the rest of the app already
treats as its working range, and unlike a bundled table it never runs out of
years.

Solar terms tint the runecircuit calendar and nothing else. Nothing in
`workCalendar.ts` or a reminder's schedule reads them, so the worst a
computation drift at the far edge of the range could ever cost is a tint one
term early — never a wrong send time.

## Also fixed

`network_security_config.xml`'s `<domain>` entries for `localhost`,
`ip6-localhost` and `127.0.0.1` were missing an explicit `includeSubdomains`
attribute — cosmetically harmless (none of the three has a subdomain to
include), but Android's release lint treats the omission as a hard error and
refused to assemble a signed build until it was added.

## Guarded

Every new surface here has its own check, run as part of `npm run check`
alongside everything already in place:

- `check:pairing-crypto` — 29 checks: the ECDH/HKDF derivation against a fixed
  known-answer test, that a message is unreadable with the wrong directional
  key, that a tampered ciphertext fails to open, and replay rejection on the
  channel that sequences messages.
- `check:qr-decode` — 7 payloads round-tripped through this app's own QR
  encoder, into pixels, and back out through its own decoder.
- `check:android-plugin` — 37 checks across 34 declared methods and 34
  `@PluginMethod` handlers, so the JS-facing interface and the Java
  implementation cannot silently drift apart.
- `check:ipc-contract` — 819 checks across 59 IPC channels and 60
  `DesktopApi` methods, extended to cover the new pairing and sync channels.
- `check:solarterms` — 32 checks: known solar-term instants for 2020–2025
  against published values, and chronological, evenly-spaced coverage for
  1901, 1950, 2000, 2026, 2050 and 2099.
- `check:runecircuit-scope` — confirms no runecircuit-specific selector ever
  reaches a reading surface (body text, subject lines) rather than staying
  confined to chrome.
- `check:visual-styles` — 121 checks across all 7 styles and 6 locales, so a
  new style cannot ship incomplete in a locale nobody happened to check.
