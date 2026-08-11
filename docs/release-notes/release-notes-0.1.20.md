# Aevistle 0.1.20

Gmail can be added without a password now, and when something does not work the
app will tell you which layer stopped rather than repeating whatever the last
one said.

Those two are the release. The first was not optional — Microsoft stopped
accepting app passwords for IMAP, POP and SMTP on personal accounts on 30 April
2026, and that date has passed, so a password on an `outlook.com` address now
validates, saves, and then fails at three in the morning with nobody watching.
The second exists because "mail does not work on my phone and I cannot tell you
why" is a sentence this app had no answer for.

The rest is a screen that can no longer take the whole window down with it,
accounts you can put in the order you actually use them, and a compose box that
stops stuttering when the outbox is full.

Nothing about how mail is scheduled, stored or encrypted changed. Passwords are
still held by DPAPI on Windows and the hardware-backed Keystore on Android, and
the password path is untouched for every account already using it.

---

## Sign in instead of typing a password

Accounts have an authentication method now: **Password** or **OAuth 2.0**. The
OAuth path opens your system browser, you sign in to Google or Microsoft
directly, and the app receives a token it can refresh — it never sees what you
typed.

It is the authorization-code flow with PKCE, as a public client, per RFC 8252:

- **The system browser, never an embedded WebView.** Your password is typed
  into a window this application cannot read.
- **No client secret, anywhere.** A desktop app cannot keep one — this project
  ships its source and an unobfuscated bundle — so it does not pretend to. The
  token exchange is authorised by PKCE alone, and `npm run check:public-client`
  fails the build if a `client_secret` is ever added on any platform.
- **The loopback redirect is bound before the browser opens,** on a port the
  operating system assigns, and it accepts exactly one request. Android uses a
  private-use URI scheme instead, which is what the manifest's intent-filter
  claims and what §7.1 prescribes.
- **`state` is compared, and a mismatched callback is discarded** without
  reaching the token endpoint.

Two honest limits, both stated on screen rather than discovered at send time:

- **Personal Outlook, Hotmail and Live addresses cannot be added on this
  build.** They need a Microsoft client id and the Entra registration behind it
  could not be completed, so that entry is deliberately blank. The account
  dialog says "not configured in this build" in your language. This is not a
  regression — Microsoft would refuse the password too — it is the same outcome
  reported at the point where you can act on it instead of hours later.
- **Gmail shows an "unverified app" screen** until Google's review of the
  restricted `https://mail.google.com/` scope completes. Until then it works for
  accounts added as test users.

If you build this project yourself, the client ids are public identifiers rather
than secrets, and `src/core/oauth.ts` documents exactly what to register with
each provider and where to paste the result. Leaving one blank is a supported
state.

## A self-check that names the layer

Settings has a self-check that walks the stack from the bottom up — platform,
native bridge, notification permission, exact alarms, account fields,
credential, SMTP, IMAP, armed reminders, outbox — and reports each layer
separately.

The point is the ordering. The first failure going up is the one worth acting
on and everything above it is noise: an account with a flawless SMTP
configuration and no native bridge underneath it is not an account problem, and
telling you to check your password would send you somewhere nothing can be
fixed.

Two rules keep it from lying. A probe that throws is recorded as a fact rather
than aborting the run, so the check can report more than one thing. And nothing
is judged from a missing answer — a probe that never ran reports "skipped", not
"failed", because defaulting to failure is how a panel ends up confidently
blaming SMTP on a build that never called SMTP.

Every verdict rule is pure and tested by `npm run check:selfcheck`; the screen
only gathers the facts.

## One bad record no longer blanks the window

React unmounts the whole tree when a render throws and nothing catches it. For
an app whose job is to be sitting there when a reminder is due, that is the
worst available failure: the window goes white, the sends are still on disk and
still armed, and there is nothing on screen to say either.

That was reachable in practice. A single contact with a missing field threw
inside `buildPool`, and one tag field took all nine screens with it.

There are error boundaries around each view and around the shell now. A screen
that cannot render costs you that screen — the sidebar stays, the other tabs
work, and the reminder due in ten minutes is still armed. Because most of these
are data-shaped rather than permanent, the failed view offers a retry button
instead of demanding you restart the application to find out.

## Put your accounts in the order you use them

Accounts can be reordered by hand, and the order is the same in Settings and on
the inbox tab strip. Three ways in, because one is not enough for all of them:

- **Mouse** — drag the grip, using the operating system's own drag cursor.
- **Touch** — long-press to lift, then travel anywhere; the list auto-scrolls
  near an edge. This had to be its own implementation: HTML5 drag and drop never
  fires `dragstart` from a finger in Android's WebView.
- **Keyboard** — Ctrl/Alt/Cmd + arrow on a focused grip, with the new position
  announced in a live region. A list that can only be dragged is a list a
  screen-reader user cannot arrange at all, and finding your own mailbox is not
  an optional corner of this app.

## Typing stayed smooth with a full outbox

The outbox strip had no height limit, so a queue built up over an offline
afternoon rendered every item — and because the strip reads app state and the
draft lives there, all of them re-rendered on every keystroke. Measured at 150
queued messages: 65 ms of blocked main thread per keystroke on average, 244 ms
at the 95th percentile, against a 16.7 ms frame. Empty queue, same typing:
26 ms.

Six are listed now and the rest become a count — failures first, then whichever
will be retried soonest, because an arbitrary six out of a hundred would bury
the only ones needing a decision.

## Under the floor

- **Empty `catch` blocks on the Android side must explain themselves.**
  `JobStore.recordRun` once threw partway through its bookkeeping and swallowed
  it bare: the message had already been sent, and the Schedule screen showed the
  job as armed forever. `npm run check:silent-failure` now fails on any catch
  whose body has no code and no reasoning written next to it.
- **A browser regression suite.** Playwright specs covering account reordering,
  the outbox cap, the self-check, boot with a damaged job, a phantom inbox
  account, and that one failing view leaves the others alone. It carries its own
  dependency island so the root lockfile stays still. Traces and screenshots are
  never committed — a retained trace is a full DOM recording of the app with the
  fixture's addresses in it.
- **Four new guards in `npm run check`:** `check:silent-failure`,
  `check:oauth-redirect`, `check:selfcheck`, `check:public-client`.

## Verifying this download

Every release publishes `SHA256SUMS.txt` and a detached GPG signature over it,
plus the public key. The release script hashes, signs, uploads, then downloads
the published copies back and verifies those — a successful upload is not
evidence that what landed is what was built.

The Android signing key rotated at v0.1.19. If you are coming from v0.1.18 or
earlier on Android, uninstall before installing this one; Android will refuse
the upgrade otherwise. See `SECURITY.md`.
