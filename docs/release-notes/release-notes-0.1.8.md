# Aevistle 0.1.8

Six things that were broken are fixed, and one thing that could never work is now said out loud instead of failing silently.

## Connection errors were unreadable, and one of them was a crash

Testing an account could report `Right-hand side of 'instanceof' is not an object` instead of what actually went wrong.

The cause was a mismatch inside a dependency rather than in the connection itself. `imapflow` declares `export class AuthenticationFailure` in its type definitions but never re-exports it from its entry point, so the import typechecked and evaluated to `undefined` at runtime — and `x instanceof undefined` throws. That throw happened inside the endpoint ladder's error handler, so it *replaced* the real connection error and escaped the ladder. Every failure surfaced as that one message.

It is now decided from the flag `imapflow` actually sets, with no import to go stale, and `npm run check:imap-auth` keeps it that way.

Alongside it, the translation from OpenSSL's own words into a sentence you can act on existed but had never been wired up, so a raw BoringSSL stack offset was the headline of the dialog. Failures now read as a sentence first, the per-endpoint trace next, and the raw text last.

## Long error text was cut off

A BoringSSL error is a single 120-character token with no spaces in it, and text only wraps at spaces — so it ran out of the dialog and was clipped. Machine strings now break anywhere they need to.

The dialog also grew: measured at an 827px window it was showing 41% of its own content while leaving 124px of screen unused, because a fixed pixel ceiling was shrinking the box on exactly the screens with room to spare.

## Back up / restore and "move reminders to another device" did nothing

Both export by handing the browser a file to download. In the packaged desktop app that saved to the Downloads folder as `<random-guid>.tmp`, discarding the name entirely — so nothing appeared to happen, and anyone who did find the file could not restore it, because the restore picker only offers `.aevistle` and `.json`.

There is now a proper save dialog with the right filename, and the "exported" confirmation waits to hear that a file exists rather than announcing it on the click. Cancelling says cancelled.

On Android this is not possible yet — its WebView cannot save this kind of file at all — so it says so rather than showing a success it cannot deliver.

## Saving an account took seconds

Saving waited for a full IMAP connect, login and message fetch before closing the dialog. Everything you typed was already stored by then; only the confirmation was waiting on the network. The sync now runs behind you, and a sync failure is still reported the way it always was.

Measured after the change: 3.5 ms median for the credential write and verification, ~6 ms for a complete save.

## Changing the address on a saved account did not update the servers

Editing an account treated every field as hand-edited, which is right for fixing a typo and wrong for replacing `me@outlook.com` with `me@gmail.com` — that left Microsoft's servers under a Gmail address.

Changing the domain now re-derives the servers, keeping only the fields you genuinely changed away from the previous provider's defaults. Twelve providers are covered by `npm run check:autoconfig`.

## The group list was smaller than everything else

The account group box used a native `<datalist>`, whose popup the browser draws outside the page at its own text size — unreachable by the app's typography. It is drawn in the page now, at the same 16px 宋体 / Times New Roman as everything around it, and opening it on an account that already has a group shows the other groups instead of an empty list.

## Microsoft accounts: password sign-in has been withdrawn

This is not a bug in the app and cannot be fixed by changing ports or encryption.

- **Personal Outlook.com, Hotmail, Live** — IMAP, POP and SMTP stopped accepting passwords, *including app passwords*, on 30 April 2026.
- **Work or school Microsoft 365** — IMAP and POP lost password sign-in in 2022–2023 and cannot be re-enabled by anyone, including Microsoft support. SMTP AUTH still accepts a password until the end of 2026, and only where an administrator has enabled it.

OAuth2 is the only way in, and Aevistle does not support it yet. The app now says this plainly when you try, and no longer links to the app-password page, which no longer helps. Until OAuth2 lands, use a provider that still accepts an app password.

---

**Verify your download** — compare against `SHA256SUMS.txt`, signed with the release GPG key:

```
certutil -hashfile Aevistle-0.1.8-win-x64-setup.exe SHA256
```

Windows installers are not code-signed, so SmartScreen will warn on first run; the hashes above are the check that actually proves what you downloaded.
