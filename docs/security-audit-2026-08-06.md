# Independent security audit — Aevistle

**Date:** 2026-08-06
**Commit audited:** `90e60d28ce9e8335f32094069957ce9755c99f6d` (`main`, v0.1.18)
**Scope:** credential handling, LAN listeners, Electron hardening, untrusted-content
rendering, update channel, Android specifics, supply chain.
**Method:** source reading, with every finding traced to a line and the two
headline findings reproduced with a runnable proof of concept.

> **Concurrency note.** Three other agents were editing
> `src/components/AccountDialog.tsx`, `src/views/DevicesCard.tsx`,
> `electron/pairingServer.ts`, `electron/syncServer.ts` and `electron/main.ts`
> while this audit ran. At the time of writing the working tree additionally had
> uncommitted modifications to `electron/main.ts`, `electron/preload.ts`,
> `src/core/bridge.ts`, `src/core/bridge-desktop.ts`, `src/core/ipc-contract.ts`,
> `src/core/syncLoop.ts`, `src/core/syncScope.ts` and a new
> `src/core/secretTransport.ts`. **Everything below describes the committed state
> at `90e60d2`.** Line numbers in those files may have moved; the reasoning has
> not, unless one of those edits happens to have changed it.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 5 |
| Informational | 6 |

**Top findings**

1. **H1** — A single received email can freeze the app indefinitely. The
   verification-code extractor runs an accidentally-quadratic regex over the raw
   message body, automatically, for every unexamined message. Measured: 160 KB of
   body → 15.3 s of blocked UI thread; 1 MB → roughly ten minutes.
2. **M1** — The HTML sanitiser can be bypassed. An attacker-controlled HTTP
   `Content-Type` response header is spliced verbatim into already-serialised
   HTML, letting a remote image server inject arbitrary tags into the message
   reader. Proven end to end. Both downstream defences (no-scripts sandbox,
   inherited CSP) hold, so this is a bypass of the allowlist rather than code
   execution.
3. **M2** — The in-app updater on both platforms verifies the download against a
   checksum file served by the same GitHub release. The project publishes a GPG
   signature over that checksum file, `scripts/check-signing.mjs` verifies it, and
   `SECURITY.md` explains exactly why it is needed — but no code that installs an
   update ever fetches or checks it.
4. **M3** — Remote images load automatically by default, and a stored `'never'`
   is silently upgraded to `'always'`. `SECURITY.md` states the opposite.

**Relationship to the existing tooling.** `npm run audit:self` (21 checks) and
`npm run audit:deps` both pass clean on this commit, and I agree with both
verdicts — they are correct about what they assert. Every finding below is new
except M2, which the existing `UPD-02` touches from a different angle (it checks
that a *failed* checksum fetch blocks the install; it says nothing about who
vouches for the checksum). Per-finding coverage is stated inline.

---

## High

### H1 — Regular-expression denial of service in the code extractor: one email hangs the app

**Severity:** High
**Where:** `src/core/codeExtract.ts:231` (pattern), applied at
`src/core/codeExtract.ts:436` inside `scrub()`, which is called on the full body
at `src/core/codeExtract.ts:586`; driven from
`src/state/CodeCheck.tsx:227` (`runExtraction`).
**Covered by existing tooling:** No. No check in `scripts/audit.mjs` looks at
regex complexity, and `scripts/check-code-extract.mjs` is a correctness test, not
a complexity test.

**The code**

```ts
// src/core/codeExtract.ts:231
const MIXED_TOKEN_PATTERN = /(?<![\w@.\-])(?=[^\s]*[a-z])(?=[^\s]*\d)[a-z0-9._%+-]{2,}/gi
```

```ts
// src/core/codeExtract.ts:427-440
function scrub(text: string, struck: CodeAlternative[]): string {
  let out = text.replace(ZERO_WIDTH, '')
  ...
  out = blank(out, MIXED_TOKEN_PATTERN)      // :436
```

The two lookaheads are the problem. At every one of the *n* start positions in
the subject text, `(?=[^\s]*[a-z])` greedily consumes to the next whitespace and
then backtracks the whole way looking for a lowercase letter. On input with no
whitespace and no matching character, that is O(n) work per position, so O(n²)
overall — no exponential blowup, but a quadratic one is more than enough here
because the input is unbounded.

**The input is raw and unbounded.** `src/state/CodeCheck.tsx:117-121`:

```ts
function plainText(body: InboxMessageBody): string {
  if (body.text) return body.text          // the message's own text/plain part
  ...
}
```

`body.text` is the attacker's `text/plain` part, verbatim. It is never truncated
before reaching `extractFromMessage` (`src/state/CodeCheck.tsx:226-232`), and
`runExtraction` walks *every unexamined message* on a timer — no click, no
opening the message.

**Measured** (Node 24, this machine):

| Body size | Time in `MIXED_TOKEN_PATTERN` |
|---|---|
| 20 KB | 0.23 s |
| 40 KB | 0.84 s |
| 80 KB | 3.70 s |
| 160 KB | 15.30 s |

Clean 4× per doubling. Extrapolating: 1 MB ≈ 10 minutes, 4 MB ≈ 2.6 hours. Mail
bodies of 1 MB are entirely ordinary.

**Exploitation scenario.** Anyone who knows the user's email address — no network
position needed at all — sends one message whose `text/plain` part is, say,
500 KB of `!` with no whitespace. The next automatic extraction pass blocks the
renderer's single JS thread for minutes. Because the message stays unexamined
until extraction completes, and because `examined.current.add()` happens *before*
the expensive call but the loop continues to the next message, a handful of such
messages makes the app permanently unresponsive: the window will not repaint, the
UI will not accept input, and scheduled sends driven from the renderer stall. A
mailing-list address or a leaked address is enough. This is the highest-impact
finding here precisely because it needs no privileged position.

**Remediation.**

1. Cap the input. `extractFromMessage` should truncate `bodyText` to something
   like 64 KB before `scrub()` — a verification code is not in the 65th kilobyte
   of a message. This alone reduces the worst case to a few milliseconds and is
   a one-line change at `src/core/codeExtract.ts:896` and `:586`.
2. Fix the pattern regardless. The lookaheads exist to say "this token contains
   both a letter and a digit", which is better done by matching the token first
   and testing it afterwards:
   ```ts
   const MIXED_TOKEN_PATTERN = /(?<![\w@.\-])[a-z0-9._%+-]{2,}/gi
   // then in blank(): if (!/[a-z]/i.test(m) || !/\d/.test(m)) return m
   ```
   This is linear and preserves the semantics.
3. Add a check to `scripts/audit.mjs` asserting a length cap exists on the
   extractor entry point, so the cap cannot be removed silently later.

---

## Medium

### M1 — Sanitiser bypass: attacker-controlled `Content-Type` is spliced into serialised HTML

**Severity:** Medium
**Where:** `electron/remoteImage.ts:192` (constructs the data URI) and
`src/core/remoteImagePlaceholder.ts:56` (splices it in).
**Covered by existing tooling:** No. `INBOX-01` inspects the `ALLOWED_TAGS`
literal and greps `InboxView.tsx` for `dangerouslySetInnerHTML`; it never looks
at `resolveRemoteImages`, which mutates the sanitiser's output *after* it has
been produced.

**The code**

```ts
// electron/remoteImage.ts:166-192
const contentType = res.headers['content-type'] ?? ''
if (!contentType.startsWith('image/')) { ... reject ... }
...
resolve(`data:${contentType};base64,${buffer.toString('base64')}`)
```

```ts
// src/core/remoteImagePlaceholder.ts:53-58
resolved.forEach((dataUri, index) => {
  const replacement = dataUri ?? fallback
  if (!replacement) return
  out = out.split(`${BLANK_PIXEL}#${index}`).join(replacement)   // :56
})
```

`sanitize-html` escapes attribute values as it serialises. But this splice runs
on the serialised string, long after that escaping, and inserts a value the
attacker controls. `startsWith('image/')` constrains only the prefix. HTTP header
values may contain `"`, `<` and `>`, and Node's parser passes them through.

**Proof of concept** (run against a local server that emits the crafted header;
`sanitize-html` invoked with the exact options from `electron/sanitizeHtml.ts`):

```
1. content-type as Node parses it = "image/png\"><img src=\"http://tracker.example/beacon.gif"
2. remoteImage.ts gate  ct.startsWith("image/") = true
3. sanitizer output = <p>hi</p><img src="data:image/gif;base64,R0lGOD…#0" />
4. after resolveRemoteImages splice:
    <p>hi</p><img src="data:image/png"><img src="http://tracker.example/beacon.gif;base64,QUFB" />
```

The `src` attribute is closed early and a second, fully attacker-authored element
appears in the document. Arbitrary tags and attributes follow from the same
primitive.

**Exploitation scenario.** The attacker sends an HTML mail containing
`<img src="https://attacker.example/pixel.png">` and controls that server. When
the reader fetches the image — which, per **M3**, happens automatically by
default — the server answers with
`Content-Type: image/png"><a href="https://phish.example/reset">`. The reader
frame now renders an anchor the sanitiser never approved, wrapping the rest of
the message; a click is handed to `openExternalSafely` by
`src/components/MessageBodyFrame.tsx:64-69`.

**What limits it, and why this is Medium and not High.** Two independent defences
hold and I confirmed both:

- `src/components/MessageBodyFrame.tsx:167` — `sandbox="allow-same-origin"` with
  no `allow-scripts`. Injected `<script>` and `on*` handlers cannot run.
- The frame uses `srcDoc`, which **inherits the parent document's CSP**
  (`index.html` acknowledges this explicitly). `img-src 'self' data: blob:` blocks
  the injected remote `<img>`, `style-src` blocks `@import`, and
  `frame-src 'self' data: blob:` blocks a `<meta http-equiv="refresh">` to a
  remote origin. So no code execution and no network egress from the frame.

What is left is real but bounded: arbitrary inert markup and CSS inside the
message pane — content spoofing, and link substitution that the click handler
will forward to the OS browser. The allowlist, which is defence layer one, is
defeated outright.

**Remediation.** In `electron/remoteImage.ts`, reduce the header to a bare MIME
type before it is ever interpolated:

```ts
const rawType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(rawType)) { res.resume(); reject(new Error('Not an image')); return }
// …later
resolve(`data:${rawType};base64,${buffer.toString('base64')}`)
```

Optionally also assert in `resolveRemoteImages` that `replacement` matches
`/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/`, so a future producer of
that string cannot reintroduce the same class. Worth an `INBOX-06` check that the
content-type is split on `;` before interpolation.

---

### M2 — The in-app updater trusts a checksum served by the same origin as the artefact

**Severity:** Medium
**Where:** `electron/updater.ts:40-43` (`SUMS_URLS`), `:93-112`
(`lookupChecksum`), `:168-179` (the decision);
`android/.../UpdateInstaller.java:75-78`, `:216-254`, `:338-351`.
**Covered by existing tooling:** Partially, and from a different angle. `UPD-02`
asserts that an *unreachable* checksum file throws rather than skipping
verification — which it correctly does. `scripts/check-signing.mjs` verifies that
the *published* release carries a good GPG signature. Neither asserts that the
client checks provenance, and no check connects the two.

**The code**

```ts
// electron/updater.ts:40-43
const SUMS_URLS = [
  'https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS.txt',
  'https://github.com/Aevorine/Aevistle/releases/latest/download/SHA256SUMS',
]
```

The installer comes from `github.com/Aevorine/Aevistle/releases/...`. The hash
that authorises it comes from `github.com/Aevorine/Aevistle/releases/...`. There
is a signature — `SHA256SUMS.txt.asc`, published with every release — and
`SECURITY.md:216-219` states the problem in its own words:

> `SHA256SUMS.txt` proves a download was not corrupted on the way to you. On its
> own it cannot prove who published it — the file and the binaries it describes
> come from the same place, reachable by the same credential, so anyone able to
> replace one can replace the other. That is the gap the signature closes.

The gap is closed for a human who runs `gpg --verify` by hand. It is not closed
for the updater, which is the path essentially every user will take. Grepping
both updaters: neither `electron/updater.ts` nor `UpdateInstaller.java` contains
the string `.asc`, any OpenPGP handling, or any pinned key material.

**Exploitation scenario.** An attacker who obtains the maintainer's GitHub
credential or a PAT with `contents: write` — phishing, a stolen laptop, a leaked
CI secret — edits the latest release: replaces `Aevistle-Setup-x.y.z.exe` with a
trojanised build and `SHA256SUMS.txt` with its hash. Every user who presses
"Update" downloads it over TLS from a host on the allowlist, at a path under
`/Aevorine/Aevistle/`, with a matching checksum, and the UI reports
`checksumVerified: true`. On Windows there is no second net: `SECURITY.md:272`
states the Windows builds are not code-signed. On Android the APK signature *is*
a genuine second net (the system installer enforces same-signer on upgrade), so
this finding is materially weaker there — it downgrades to "the update is refused
at install time with a confusing error" rather than silent compromise.

This is Medium rather than High because it requires compromising the publisher,
which is outside the stated threat model's day-to-day cases — but it is precisely
the scenario the project already built and published a signature to defend
against, and paid for in release-process complexity, without wiring it to the one
consumer that matters.

**Remediation.** Embed the signing key's fingerprint (already in
`SECURITY.md:230`) as a constant in the app, fetch `SHA256SUMS.txt.asc` alongside
the sums file, and verify before accepting the hash. If shipping an OpenPGP
implementation is unattractive, the cheaper equivalent is to embed an Ed25519
public key and publish a detached raw signature over `SHA256SUMS.txt` —
verifiable with `crypto.verify` in Node and `java.security.Signature` on Android,
no dependency on either side. Fail closed on a missing or bad signature, exactly
as the unreachable-checksum case already does. Then extend `UPD-02` to assert the
verification exists.

---

### M3 — Remote images load by default, and a stored "never" is upgraded to "always"

**Severity:** Medium (privacy)
**Where:** `src/core/types.ts:893-900`. Documentation contradiction at
`SECURITY.md:152-155` and `SECURITY.md:136`.
**Covered by existing tooling:** No. `INBOX-02` checks only that the CSP's
`img-src` forbids remote origins — which it does, and which is irrelevant here,
because the fetch is performed by the main process and returned as a `data:` URI
that `img-src data:` permits by design.

**The code**

```ts
// src/core/types.ts:893-900
export function effectiveImagePolicy(
  stored: RemoteImagePolicy | undefined,
  chosen: boolean | undefined,
): RemoteImagePolicy {
  const value = stored ?? 'always'
  if (value === 'never' && !chosen) return 'always'
  return value
}
```

Two behaviours, both load-bearing:

- The default is `'always'` — `shouldAutoLoadImages` returns `true` unconditionally
  (`src/core/types.ts:927`), so every HTML message's remote images are fetched on
  open without being asked for.
- A **stored** `'never'` is overridden to `'always'` whenever `imagePolicyChosen`
  is falsy. The in-file comment justifies this as repairing scaffolding that was
  declared but never wired up. That reasoning is defensible for a setting nobody
  could have set; it is still a stored deny being resolved to allow, which is the
  one direction that should never be automatic.

`SECURITY.md:152` says the opposite, in the section a security reviewer would read
first:

> Every remote `<img>` is blocked by default and replaced with a placeholder;
> loading the real image is an explicit action

**Exploitation scenario.** A spammer or a targeted sender embeds a 1×1 pixel with
a per-recipient URL. On open, the desktop main process fetches it — confirming
the message was read, when, and from which IP and network. `SECURITY.md:34-36`
lists this exact attack under "Defended against". It is not, on this commit.

Two mitigating details, stated fairly: the request is made by the main process
rather than the frame, so the frame never sees the network; and the on-disk cache
(`electron/remoteImage.ts:226-245`) means one fetch per URL ever rather than one
per open, which is genuinely fewer pings than a blocking-then-clicking flow would
produce. Neither changes the fact that the first open is a confirmed read receipt
the user never authorised.

**Remediation.** Pick one and make the docs match:

- If `'always'` is the intended product decision, fix `SECURITY.md:152-155` and
  `docs/PRIVACY.md`, and surface the choice on first inbox setup rather than as a
  default nobody sees.
- If blocking is intended, change the fallback at `src/core/types.ts:897` to
  `'never'` and drop the `'never' → 'always'` upgrade at `:898`.

Either way, add a check asserting that the default in `effectiveImagePolicy`
matches the claim in `SECURITY.md`, since these drifted apart silently once.

---

## Low

### L1 — Android LAN listener is single-threaded: one idle socket stalls pairing and sync

**Severity:** Low (availability, Android only)
**Where:** `android/.../LanServer.java:216-247` (`acceptLoop`), `:110`
(`SOCKET_TIMEOUT_MS = 10_000`), `:254` (`serve`).

```java
// LanServer.java:222-226
Socket client = null;
try {
    client = server.accept();
    client.setSoTimeout(SOCKET_TIMEOUT_MS);
    serve(client);                      // synchronous, on the one accept thread
```

`serve()` runs inline on the single accept thread and begins with `readLine(in)`,
which blocks until the peer sends a newline or the 10-second timeout fires. There
is no worker pool and no per-peer limit.

**Exploitation scenario.** Anyone on the same Wi-Fi opens a TCP connection to the
sync port (fixed and well-known, `SYNC_SERVER_PORT`) or to a pairing port and
sends nothing. For ten seconds the phone accepts no other connection. Repeating
this in a loop — one connection per 10 s from one host — permanently prevents the
user pairing a device or answering a sync, with no error the user can interpret
beyond "connecting…" then a network message. Availability only: nothing is
disclosed and nothing is written.

The desktop is not affected — `node:http` handles connections asynchronously —
which makes this a platform asymmetry rather than a design decision.

**Remediation.** Hand each accepted socket to a small bounded `ExecutorService`
(2–4 threads is ample) so `accept()` returns immediately, and lower
`SOCKET_TIMEOUT_MS` for the header phase specifically — a LAN peer sends its
request line in milliseconds.

### L2 — No replay protection on the long-lived sync channel

**Severity:** Low
**Where:** `src/core/pairingCrypto.ts:232-241` (`openWithRandomIv`),
`src/core/syncLoop.ts:491` (`respondToSyncRequest`).

The ephemeral `PairingChannel` has strict replay protection — the IV *is* a
counter and the receiver requires it to climb by exactly one
(`src/core/pairingCrypto.ts:278-296`). Its long-lived sibling deliberately has
none: `sealWithRandomIv` uses a random IV, and `openWithRandomIv` accepts any IV
that authenticates. The reasoning given at `src/core/pairingCrypto.ts:208-220` is
sound and is about *nonce reuse across restarts*, which random IVs genuinely
solve. But the replay consequence is nowhere stated, and nothing else supplies
it: there is no nonce cache, no freshness window, and no timestamp check in
`respondToSyncRequest`.

**Exploitation scenario.** An attacker on the same LAN passively captures one
`/sync` POST (it is plain HTTP; the body is ciphertext but the envelope is the
whole message) and replays it byte-for-byte hours later. The GCM tag validates
under the same long-lived key, `openWithRandomIv` succeeds, and `performExchange`
applies the stale `incoming.changed`.

**Why Low.** `applyExchange` merges on `updatedAt` with last-writer-wins, so a
replayed old payload mostly loses to the newer local state. The practical effect
is bounded to re-applying data that was already applied — resurrecting a
just-deleted reminder is the plausible worst case, not disclosure. The attacker
cannot read the reply.

**Remediation.** Put a monotonic counter or a `sentAt` timestamp *inside* the
sealed payload, and have `respondToSyncRequest` reject anything not strictly
newer than the last accepted value for that `pairId` (or outside a ±5-minute
window, given `clockOffsetMs` is already tracked). `PairedDevice` already
persists per-device state, so there is somewhere to keep the high-water mark.

### L3 — `pairId` is broadcast in cleartext on every sync poll

**Severity:** Low (privacy / linkability)
**Where:** `electron/syncServer.ts:138`; the initiator side at
`src/core/syncLoop.ts:572`.

```ts
const pairId = String(body.pairId ?? '')     // outside the sealed envelope
```

The routing identifier has to be outside the envelope — the server must pick a
key before it can decrypt — so this is a reasonable design. The consequence is
that a stable, unique per-pair identifier is emitted in the clear on a fixed,
well-known port at every poll interval, on whatever network the user is attached
to. A passive observer on a café or hotel network can fingerprint the device, and
recognise the same device on a later visit, without decrypting anything. The
fixed port and `/sync` path also identify the application.

**Remediation.** Either derive a rotating identifier (e.g. HMAC of the long-lived
key over the current epoch bucket, checked against each known device — a handful
of HMACs per request), or accept the leak and record it in `docs/PRIVACY.md`
alongside the sync feature, and gate the listener on the user having opted into
sync on untrusted networks. The former is more work than the finding justifies;
documenting it is probably the right call.

### L4 — `isDisallowedAddress` misses several non-public ranges

**Severity:** Low
**Where:** `electron/remoteImage.ts:39-64`.

The check covers 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, and the
IPv6 equivalents including `::ffff:` mapping (which correctly fails closed for
unmappable forms — I checked). Not covered:

- `100.64.0.0/10` — CGNAT, in real use by mobile carriers and some ISPs, and the
  address space a subscriber's peers sit in on those networks.
- `192.0.0.0/24` (IETF protocol assignments), `198.18.0.0/15` (benchmarking).
- `224.0.0.0/4` (multicast) and `240.0.0.0/4` (reserved).

These only matter for a hostname resolving into one of them, since literal IPs in
those ranges are also unblocked. Impact is a narrow SSRF against a carrier-side
or reserved-range host, which is a much weaker position than the RFC1918 cases
already blocked.

**Remediation.** Add the ranges to `isDisallowedAddress`. The existing `INBOX-05`
check will keep guarding the structure; consider extending it to assert the range
list by content.

### L5 — FileProvider paths are far broader than the file's own comment claims

**Severity:** Low
**Where:** `android/app/src/main/res/xml/file_paths.xml`.

```xml
<!-- Deliberately narrow. … Notably absent: the data folder root. -->
<paths …>
    <external-path name="my_images" path="." />
    <cache-path name="my_cache_images" path="." />
```

The comment describes a carefully-scoped set of four attachment directories plus
`updates/`. The first two lines — Capacitor's scaffolding defaults, left in place
— expose the *entire* external storage root and the *entire* cache directory
through the same provider.

The provider is `exported="false"` with `grantUriPermissions="true"`, so no other
app can query it; a URI has to be minted and granted by this app. Every call site
that mints one is properly confined (`AevistleNativePlugin.java:1061-1067` and
`UpdateInstaller.java:400-411` both canonicalise and range-check first), so there
is no path from here to a leak today. What this is, is a latent contradiction: the
next `getUriForFile` call written against the comment rather than the file will be
wrong, and the file says it is narrow when it is not.

**Remediation.** Delete the two scaffolding lines if nothing needs them (a build
and a manual attachment-open will confirm), or amend the comment to describe what
is actually configured.

---

## Informational

- **I1 — The `uuid` override is benign.** `"overrides": {"uuid": "^14.0.1"}`
  resolves exactly one path: `@capacitor/cli@8.5.0 → xcode@3.0.1 → uuid@14.0.1`.
  `@capacitor/cli` is a devDependency used by `cap sync`; `uuid` reaches neither
  the Electron bundle nor the APK. It is a version bump on a build tool, not a
  patch masking a vulnerable transitive dependency. I looked specifically for the
  latter and there is nothing there.

- **I2 — `jsqr@1.4.0` is unmaintained.** It parses camera frames during QR pairing
  — attacker-influenceable input if someone can put a display in front of the
  camera, which is a stretch. No advisory exists and `npm audit` is clean. Worth
  knowing it has had no release in years; not worth acting on now.

- **I3 — Loopback is inside the LAN relay allowlist "for development".**
  `electron/main.ts:282` (`a === 127`) and
  `AevistleNativePlugin.java:542,565`. A compromised renderer could POST arbitrary
  JSON to any loopback port, restricted to paths `/pair` and `/sync`. A very
  narrow SSRF, gated behind a renderer compromise the whole preload design exists
  to prevent. Consider gating on `!app.isPackaged`.

- **I4 — `snapshotAttachments` does not confine its source paths.**
  `electron/main.ts:1097-1104` calls `fs.copyFile(a.path, target)` with `a.path`
  taken from the renderer unchecked; `AevistleNativePlugin.java:1276-1281` is the
  same shape. The *destination* is basename-confined on both. This is an arbitrary
  file read that becomes an emailed attachment — but only from a renderer that is
  already compromised, and every other path handler in both files
  (`readAttachment`, `openPath`, `revealPath`, `saveAttachmentAs`,
  `saveAttachmentsTo`) *is* confined. Adding the same `isInside` / `insideDataRoot`
  guard here would make the file consistent, at the cost of rejecting attachments
  the user legitimately picked from Documents — so it needs care, not a one-line
  fix. Noted for the record.

- **I5 — `has()` diverges between platforms.** `electron/store.ts:455` decrypts to
  answer "is a password stored", deliberately, with a good comment explaining the
  silent failure that motivated it. `SecretStore.java:119` only checks key
  presence. Android therefore still has the bug the desktop fixed: after a
  keystore rotation the account reports a stored password that cannot be read.
  Not a vulnerability; a correctness gap in a security-adjacent path.

- **I6 — The offline pairing file's 6-digit PIN.** `src/core/pairingFile.ts:29-45`
  — PBKDF2-SHA256 at 300,000 iterations over a 6-digit PIN is roughly 20 bits of
  entropy, brute-forceable offline by anyone holding the file. The file carries no
  credentials (`buildBackup` clears `hasSecret` on every account), so the exposure
  is schedules, contacts and settings. The module documents this accurately and
  tells the user to treat the file like a backup. No action needed; recorded so it
  is not rediscovered as a finding.

---

## Areas examined and found sound

Stated explicitly, because a clean area is a result.

**Credential storage at rest — sound on both platforms.**
`electron/store.ts:383-432` uses Electron `safeStorage` (DPAPI/Keychain/libsecret)
and *refuses to store* rather than falling back to plaintext when the keystore is
unavailable (`:375-381`) — the right direction to fail. Secrets live in a separate
`secrets.json` from `state.json`, written `mode: 0o600` via temp-file-and-rename.
`SecretStore.java` uses a non-exportable AES-256-GCM key generated in the Android
Keystore with a per-message IV. I traced the IPC surface for leaks: the renderer
never receives a password back — `sendNow`, `prewarm`, `testInbox`, `syncInbox`,
`getMessageBody`, `watchInbox` all look the secret up in the main process
(`electron/main.ts:961-969`, `:1303-1361`). `setSecret`'s error path logs the raw
keystore error to console but interpolates only a static message into what the
user sees (`electron/store.ts:405-412`) — the comment explains exactly why, and it
is the correct call. Secrets are excluded from the pairing/sync scope payload by
`syncScope`/`backup`, and `MOVABLE` deliberately excludes them from being carried
to a synced data folder. No secret reaches `state.json`, an export, a log line, or
a crash dialog on any path I could find.

**The pairing handshake — sound.** 32 bytes of `crypto.getRandomValues` for the
token (`pairingCrypto.ts:96`), ECDH P-256 with HKDF-SHA256 salted by that token,
separate directional AES-256-GCM keys with an explanation of why one key would be
a nonce collision. The QR code carries the host's public key out of band, so an
active MITM has no position: the joiner authenticates the host by the `epk` it
scanned, the host authenticates the joiner by the token only the scanner has.
Constant-time comparison on both sides — `timingSafeEqual` on desktop
(`pairingServer.ts:204-207`), a hand-written loop with a correct comment on Android
(`pairingHostLocal.ts:74-79`). Time-bounded to 120 s, checked against the host's
own clock before the token is looked at, and genuinely single-use: the listener
closes on the first *successful* handshake, while a wrong token deliberately does
not tear the session down. Body size capped at 64 KB. Brute force is a non-issue
at 256 bits, which is why the absence of rate limiting is fine here rather than a
finding. `importPublicKeyB64` relies on WebCrypto's own point validation, which is
correct — invalid-curve attacks are not reachable.

**Electron hardening — sound, and unusually thorough.** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, `webSecurity` left
at its secure default (`electron/main.ts:620-635`). `setWindowOpenHandler` denies
every `window.open` and routes to `openExternalSafely`; `will-navigate` cancels
cross-origin navigation (`:673-676`, `:743-749`); `openExternalSafely` accepts only
`http:`/`https:` (`:924-932`), closing the `file://` and custom-protocol-handler
class. `plugins: true` is present but is only the PDF viewer, and the frame using
it is `sandbox=""`. I went through the preload surface method by method looking for
a confused deputy and did not find one: `openPath`, `revealPath`, `readAttachment`,
`saveAttachmentAs` and `saveAttachmentsTo` are all confined to the data root via
`path.resolve` + `isInside`; `installUpdate` refuses anything outside
`downloads/Aevistle` (`:1575-1583`); `attachBlob` and `snapshotAttachments`
basename their destination filenames; `setUiLocale` validates against the supported
list rather than indexing the table with renderer input (`:1008-1014`);
`setDesktopPrefs` coerces rather than trusts (`:971-977`); `getSyncSecret` pins
`kind` in the main process rather than accepting it from the renderer (`:959`).
`isLanRelayUrl` (`:264-284`) is a genuinely well-built anti-SSRF gate: scheme,
exact path and literal-private-IPv4 all pinned, no hostnames.

**SSRF defence on remote images — sound in its hard part.** The DNS-rebinding gap
is properly closed by passing a custom `lookup` into `http(s).request` so the
address checked is the address connected to, *and* by rejecting literal IPs up
front because `net.connect` never consults the hook for those
(`electron/remoteImage.ts:91-145`). The `{all: true}` happy-eyeballs shape is
handled and every returned address is filtered, so the race is closed too.
Redirects are refused outright rather than re-checked. Response size capped on both
the declared header and the running total. This is better than most production
implementations; L4 is a completeness note, not a break.

**Message-body isolation — sound.** `sandbox="allow-same-origin"` with no
`allow-scripts`, `srcDoc` inheriting a genuinely strict parent CSP
(`script-src 'self'`, no `unsafe-inline`, no `unsafe-eval`, `object-src 'none'`,
`base-uri 'none'`, `form-action 'none'`). Search highlighting is done by walking
text nodes from the parent rather than injecting a script — the right choice, and
the comment says why. `dangerouslySetInnerHTML` appears nowhere on the message
path. These layers are what contain M1.

**Update transport — sound apart from M2.** HTTPS enforced with default
certificate validation on both platforms; host allowlist *and* repo-path pinning
so `github.com/someone-else/...` is refused; Android additionally rejects
credentials in the URL and non-443 ports, and re-checks every redirect hop against
the same allowlist (`UpdateInstaller.java:128-194`). Downloads stream to `.part`
and rename only after the hash decision. Downgrade is not forceable through the
normal path — `available` requires `isNewer` (`src/core/update.ts:73-75`), and
`compareVersions` handles the `0.10.0` vs `0.9.0` trap correctly. Android's install
path canonicalises before minting the FileProvider URI and never silently installs.

**Android manifest — sound.** `AlarmReceiver` is `exported="false"`. `BootReceiver`
is exported but every action in its filter (`BOOT_COMPLETED`,
`LOCKED_BOOT_COMPLETED`, `MY_PACKAGE_REPLACED`,
`SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED`) is a system-protected broadcast
that a third-party app cannot send. `allowBackup="false"`,
`usesCleartextTraffic="false"` plus a `network_security_config` that trusts system
CAs only (so a user-installed CA cannot intercept), with the cleartext carve-out
scoped to `.local`/`home.arpa`/loopback and the numeric-range check correctly
pushed into Java. `isPrivateIPv4` even rejects leading zeros with a comment
explaining the octal-vs-decimal parse divergence — a detail most implementations
miss. Permission list is four entries plus camera, each justified.

**Path traversal — checked and clean.** Every renderer-supplied path on both
platforms is canonicalised and prefix-checked, with the one exception noted at I4.
`safeName()` on Android strips to a basename and then to `[A-Za-z0-9._-]`. No
file-serving route exists on any of the three HTTP listeners — they serve exactly
one POST path each and 404 everything else — so there is no traversal surface
there at all.

**Request-body bounds — checked and clean.** Every listener caps: 64 KB pairing
(desktop and Android), 512 KB sync, 2 MB control, 8 KB per header line on Android
with an explicit reason. Chunked encoding is refused on Android rather than parsed.

**Supply chain — clean.** `npm audit` against the real registry reports no
advisories at any level. All five runtime dependencies are at or near current
(`sanitize-html@2.17.6`, `nodemailer@9.0.3`, `imapflow@1.6.5`, `mailparser@3.9.14`,
`jsqr@1.4.0`), transitively pulling `htmlparser2@10.1.0`, `postcss@8.5.25`,
`parse-srcset@1.0.2` — none with a known open CVE. `electron@43.2.0` is current.
`package-lock.json` is committed. `audit-deps.mjs`'s three-way outcome
(clean / advisory / *could not check*) is the right design and I could not find a
way to make it report clean when it had checked nothing.

**Other regexes over attacker text — checked, only one is a problem.** I
benchmarked the suspicious patterns rather than eyeballing them.
`EMAIL_PATTERN` (`codeExtract.ts:224`) is linear despite its shape — each
repetition consumes a literal `.`, so the alternation is unambiguous: 20 KB in
0.35 ms. The anchor extractor
`/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi` (`codeExtract.ts:854`) *is*
quadratic in principle (600 ms on 20 k malformed `<a ` tokens), but it runs only
on already-sanitized HTML where every tag is well-formed and closed, which bounds
`[^>]*` to one tag — not reachable. `dateExtract.ts`'s locale patterns are all
explicitly bounded (`{0,28}`, `{1,3}`, `{1,4}`) and its `MAX_HITS = 4` short-circuit
caps the work. `linkPurpose.ts`'s patterns are anchored alternations with no nested
quantifiers. `MIXED_TOKEN_PATTERN` is the sole outlier, and it is H1.

---

## Suggested priority

1. **H1** — cap the extractor input. One line, removes a trivially-triggered hang.
2. **M1** — split the content-type on `;` and validate it. Also one line.
3. **M3** — decide whether `'always'` is the intent, then make code and docs agree.
4. **M2** — wire signature verification into both updaters. The largest piece of
   work here, and the one with the highest ceiling if the publisher is ever
   compromised.
5. **L1** — a bounded executor in `LanServer`.
6. L2–L5 and the informational items as they fit.

Three of the five items above are one- or two-line changes. The self-audit passing
clean is accurate for what it asserts; the gap is in what it does not yet assert,
and each finding above names the check that would have caught it.
