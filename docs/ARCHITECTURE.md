# Architecture

One React + TypeScript interface, two native shells, and a single seam between
them. This document explains the decisions that are not obvious from reading the
code, and the ones that would look like mistakes without their reason attached.

```
src/core/        platform-independent: domain model, recurrence engine,
                 validation, SMTP provider presets — no DOM, no Node, no Android
src/             the React interface (six locales, dual theme, RTL)
    ↓  PlatformBridge
electron/        Windows: nodemailer + imapflow, DPAPI secrets, tray,
                 hybrid tick/precise scheduler, main-process HTML sanitization
android/         Android: JavaMail (send + receive), Keystore, AlarmManager + WorkManager
```

## The bridge is the only seam

`src/core/bridge.ts` defines `PlatformBridge`. The renderer never imports
`nodemailer`, never touches `fs`, and never calls a Capacitor plugin directly —
it asks the bridge. Three implementations satisfy it:

| File | Host | Notes |
|---|---|---|
| `bridge-desktop.ts` | Electron | Pass-through to the preload API |
| `bridge-android.ts` | Capacitor | Calls the `AevistleNative` plugin |
| `bridge-web.ts` | Plain browser | Real persistence, simulated sending |

The web bridge exists so `npm run dev` is a complete UI, and so a contributor
can work on the interface without installing an Android SDK. It refuses to
pretend a send succeeded — a browser cannot open a TCP socket, and a fake
success would be worse than an honest error.

## Recurrence lives in TypeScript only

`src/core/schedule.ts` precomputes a list of absolute timestamps. Each
platform's scheduler answers exactly one question: *wake me at T*.

That split is deliberate. Calendar rules are where scheduling software goes
wrong — leap years, months without a 31st, daylight saving transitions that make
02:30 happen twice or never, "every weekday" across a holiday. Writing them once
in one language means they can be tested without an emulator and cannot drift
between platforms.

The monthly rule for day 31: a month that has no 31st is skipped, not clamped to
the 30th. Clamping quietly changes "the last day of the month" into "the 30th",
and a user who scheduled an invoice reminder for the 31st would get it on the
wrong day four times a year without ever being told.

## Persistence, and why the files are separate

| File | Contains | Why separate |
|---|---|---|
| `state.json` | Accounts, jobs, contacts, templates, logs, settings | The file a user might copy between machines or paste into a bug report. It must never contain a credential. |
| `secrets.json` | SMTP passwords, each encrypted with `safeStorage` | Bound to the OS user account; useless anywhere else. |
| `location.json` | Which folder the other two live in | Always stays in `userData` — a pointer stored inside the folder it points at could not be found again after a restart. |
| `inbox/<accountId>/` | Cached message bodies and attachments for received mail | Deliberately outside `state.json` — a mailbox can hold gigabytes, and `state.json`'s "read the whole file, write the whole file" persistence model would make every save proportional to inbox size. It is a cache, not a source of truth: deleting it just means the next sync re-downloads. |

Writes go through a temp file and a rename, so a crash mid-write cannot truncate
the only copy of a user's schedules. A `state.json` that fails to parse is moved
aside rather than deleted: starting fresh is recoverable, silent data loss is
not.

Message *metadata* (sender, subject, date, flags, tags) still lives in
`state.json` under `inboxAccounts` — small, and the UI needs it available
without an extra round trip to disk. Bodies and attachments are the part that
scales with mailbox size, so only those go to `inbox/`.

### Moving the data folder

The desktop build lets the user point the data folder anywhere they can write.
Two details matter:

1. **Copy, then delete — never rename.** Source and target are usually on
   different volumes, where rename fails outright, and a half-finished move is
   the one outcome that loses schedules.
2. **Rewrite the paths inside the jobs.** Each scheduled job stores absolute
   paths to its attachment snapshots. Moving the files without repairing those
   paths produces the worst kind of failure: the reminder fires on time and
   arrives with nothing attached. `AppState`'s `rebaseAttachments` handles this,
   and the platform scheduler is re-armed explicitly afterwards.

Android does not offer a free folder picker. A `content://` tree from the
document picker cannot be opened as a plain `File` by a background worker
running hours later, possibly after a reboot — so the choice is between the
storage volumes the system genuinely allows an app to write (private, shared,
SD card), each shown with its real path.

## Receiving mail (IMAP)

Sending is the app's promise; receiving is opt-in per account and deliberately
narrower in scope than a real mail client.

**Reuses the SMTP transport hardening rather than re-inventing it.**
`electron/imap.ts` calls into the same `endpointLadder`/`withDeadline` helpers
in `src/core/transport.ts` that `mailer.ts` uses — a misconfigured port or a
DNS server that hangs is the same failure mode on either protocol, so it gets
the same fix once.

**Untrusted HTML never reaches the renderer unsanitized.** `electron/
sanitizeHtml.ts` runs `sanitize-html` in the main process against a strict tag
and attribute allowlist (no `script`, `iframe`, `object`, `embed`, `form`,
`style`, `link`, or `on*` handlers) before a message body ever crosses the IPC
boundary. The renderer then displays it inside `<iframe sandbox srcDoc={...}>`
with no `allow-scripts` — even a sanitizer bug would still hit a wall that
cannot execute anything. This is why the codebase's zero-`innerHTML` invariant
(`ELE-04` in the audit script) survives receiving mail at all: the renderer
never holds raw HTML, sanitized or not.

**Remote images are blocked by default, not filtered by domain.** A domain
allowlist for tracking pixels is a losing game — trackers rotate hosts.
Instead, `sanitizeHtml.ts` rewrites every remote `<img src>` to a blank-pixel
placeholder before the HTML leaves the main process. Loading the real image is
an explicit user action per message (or "always" per sender), which calls
`electron/remoteImage.ts` — a fetcher that resolves DNS once and rejects
private/loopback/link-local ranges before connecting, so a message cannot use
an `<img>` tag to probe the user's own LAN.

**Every link confirms its real destination before opening.** Phishing mail
relies on link text not matching the href. Clicking a link inside a message
body always shows the resolved host before handing it to
`openExternalSafely()` — the existing safe-open path, not a second one built
for inbox.

**Credentials get a separate keystore namespace, and a fallback.** An account's
IMAP password and SMTP password are different secrets that happen to belong to
the same account; `electron/store.ts`'s `secretKey(accountId, kind)` suffixes
the keystore entry with `:imap` so turning one off can never silently clear the
other, and so a future "receiving-only" account type needs no schema change.
Reads go through `getInboxSecret()`, which falls back to the account's SMTP
password when no separate one was stored: every provider with a preset here
issues a single app password that authenticates both protocols, so demanding it
twice only creates an opportunity to mistype it. Anyone who genuinely has two
passwords still gets two entries.

**The receive config is passed, never re-read.** `saveInboxAccount` hands the
config it just wrote straight to `syncInboxAccount(id, config)`. Looking it up
from state instead is a real bug this code had: `dispatch` is asynchronous, so
the lookup returned the *previous* config, `syncInbox()` no-op'd on it because
it was still disabled, and the reducer then wrote that stale copy back over the
settings the user had typed. Turning receiving on appeared to do nothing, and
the account silently reverted to off with a blank server.

**Receiving is checked on a timer, not only on demand.** `AppState` runs one
interval per enabled account at `settings.inboxSyncMinutes` (default 5, `0`
disables), plus a pass on launch and one on `visibilitychange` for the case
where the machine was asleep through several intervals. It lives in the
renderer because the account list and its cached messages are renderer state —
a second copy in the main process would be a second thing to keep in sync, and
the two would disagree the first time a save raced a timer. Android additionally
has `InboxSyncWorker`, a WorkManager job, because there the UI process is not
guaranteed to exist.

**Both platforms can test the receive endpoint before saving.**
`testInbox()` (desktop `electron/imap.ts`, Android `MailFetcher.test`) walks the
same endpoint ladder as a real sync, opens INBOX read-only, and reports the
message and unread counts alongside the endpoint and round trip. The counts are
the point: a mailbox that opens but reports zero messages is a different problem
from one that will not open, and without them the two look identical.

**Deletion is local-cache-only, on purpose.** Removing a message from
Aevistle's inbox view deletes the cached copy and nothing on the IMAP server.
Providers disagree wildly on what "delete" should mean over IMAP (move to
Trash, set `\Deleted` and wait for EXPUNGE, permanent removal), and guessing
wrong is a way to lose mail the user did not intend to lose. Server-side
delete, if it ships, will be an explicit, separately-confirmed action.

## Fine-grained scheduling and burst sending

`Recurrence.intervalMs` is an optional field that, when set, takes precedence
over `intervalMinutes` on the `'interval'` recurrence kind only — daily,
weekly, monthly, yearly and cron stay minute-granular, because nobody
schedules "every day at 09:00:00.250" and forcing sub-second precision through
those calendar-rule branches would add risk for no real use case.

The 15-second poll in `electron/scheduler.ts` cannot honor a sub-second
interval on its own, so it gained one addition: `armPrecise()` finds whichever
occurrence (across all jobs) is soonest and, only if it is within the next 30
seconds, arms a single extra `setTimeout` for exactly that moment. Farther out
than that and the next poll or the next `sync()` will re-evaluate it anyway —
there is no reason to let a long-lived timer go stale while jobs are edited
underneath it. Both paths call the same `tick()`, so retry/backoff logic exists
once.

`BurstPolicy` (`enabled`, `count` up to a hard cap of 500, `pacingMs`) lets one
scheduled fire send the same message several times in a row. This is local
dispatch precision, not a promise about real SMTP throughput — a provider will
rate-limit or ban an account that actually receives 500 messages in the same
millisecond, so `count` is capped outright rather than merely warned about.
Pacing needs no new connection pooling: `mailer.ts`'s existing warm,
authenticated per-account connection already means the second send in a burst
skips the handshake, so the scheduler's contribution is just a `for` loop and
an `await delay(pacingMs)`.

## Security boundaries

**Electron.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
`src/core/ipc-contract.ts` is the *entire* privilege boundary; every method takes
plain serialisable data, so no `fs` handle can leak into the renderer. Every
`window.open` and cross-origin navigation is refused and handed to the OS
browser, and `openExternal` accepts only `http:` and `https:` — a crafted
settings import cannot make the app launch a custom protocol handler.

**Mail headers.** Any string bound for a header is rejected if it contains a
line break. Header injection is how a well-meaning mail client becomes an open
relay, and the check lives in `src/core/validate.ts` where both platforms use it.

**Android.** The alarm receiver and the send worker are not exported, so no
other app can make Aevistle send mail. Passwords go to the Keystore, which is
hardware-backed where the device supports it.

**R8 is off on purpose.** JavaMail resolves its providers by reflection out of
`META-INF/javamail.*`. A shrunk build fails at the first send with "no provider
for smtp" — an error no user could diagnose. The APK is a few megabytes either
way; `android/app/build.gradle` carries the same note so nobody "optimises" it
back on.

## Attachment snapshots

When a job is scheduled, its attachments are copied into the data folder. The
original file can then be moved, renamed or deleted without silently breaking a
reminder that is supposed to fire next month.

Snapshots are pruned whenever the job list is synced: anything whose job no
longer exists is removed. The alternative — deleting on job removal — leaves
orphans behind after a crash.

## What each platform actually runs

**Windows.** A tray process with a tick scheduler. The tray icon is not
decoration: closing the window hides the app there, and without a tray entry the
user has no way back and no sign that schedules are still running. It is shipped
via `extraResources` and has a drawn fallback if the asset is ever missing.

**Android.** `AlarmManager` for the exact wake-up, `WorkManager` for the send
itself, so a failed attempt can be retried under the system's own backoff rules.
`BootReceiver` re-arms everything after a restart, because alarms do not survive
a reboot and a reminder that silently stops working after a phone restart is
indistinguishable from a broken app.

## Adding a language

One file in `src/i18n/`, exported from `index.ts`. `TranslationKey` is derived
from the English file, so the compiler lists every missing string. Right-to-left
is handled by the stylesheet through logical properties (`margin-inline-start`
rather than `margin-left`), which is why Arabic needed no per-component work.
