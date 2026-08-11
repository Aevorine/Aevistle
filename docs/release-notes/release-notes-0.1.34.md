# Aevistle 0.1.34

## Compose

The 85% message-box floor from 0.1.33 was correct on paper and wrong on a
real phone: it is computed against the full window height, and nothing told
Android's WebView to shrink that height when the on-screen keyboard opened.
`MainActivity`'s inset listener consumed the system-bars/cutout insets and
never read the keyboard's — so the box kept the height it computed for a
keyboard-free screen, and the keyboard simply covered the bottom of it
instead of the layout giving that space back. The listener now folds the
keyboard inset into the same padding call, so the window actually shrinks
and the message box's 85% is 85% of what's left above the keyboard, not 85%
of a screen the keyboard is sitting on top of.

## Inbox

The reader's title and its action buttons (flag, delete, more) shared one
row on a phone; the buttons wrapping under a long subject read as the
buttons being secondary. They're reordered onto their own line at the very
top now, with the subject wrapping underneath, and the icons themselves are
20px instead of 16px inside their existing 44px tap targets.

## Page headings

Settings, Home, Inbox and the codes screen each repeated their own name at
the top of the page in a `设置`/`主页`/`收件箱`/`验证码` heading — already
said by the highlighted tab at the bottom of the window. Settings and Home
had nothing else in that heading, so it's gone entirely; Inbox and the codes
screen kept the sync/select-all and check-now/mark-all-read controls that
lived in the same row, with only the heading text itself dropped.

## Backup and restore

Exporting a backup can now include every account's password, encrypted
under a one-time recovery key generated at export time — 256 random bits,
shown once, never written to disk by this app. Restoring with that key back
decrypts and writes the passwords straight to the new machine's keystore, no
retyping. The encryption reuses this app's existing AES-256-GCM sealing
(`core/secretTransport.ts`, the same code the LAN device-pairing feature has
used since it shipped) rather than adding a new cryptographic primitive.

Passwords remain excluded by default; including them is an explicit toggle,
and a plain backup restores exactly as before — everything except the
password, one at a time.

Separately: pairing a new device to an already-set-up one (Settings →
Devices → "Pair a new device") already carries every account's password
across automatically as part of its ongoing sync — no recovery key needed,
because the two devices are talking to each other directly. That path
existed before this release; nothing about it changed here.
