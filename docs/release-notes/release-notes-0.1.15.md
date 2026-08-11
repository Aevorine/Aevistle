# Aevistle 0.1.15

A phone-shaped release. Four bugs that only showed up on a real device, and a
rebuild of how the app is laid out on one.

---

## Fixed

### Pairing dialled the wrong network card

Pairing published the first non-loopback IPv4 address the operating system
listed, on the reasoning that a machine on one network has exactly one. That
reasoning does not survive a real desktop. A Windows machine with a VPN client,
a hypervisor or a container runtime installed routinely reports a dozen or more
addresses — and adapters that never got a DHCP lease each add a `169.254.x.x`
stub on top.

On one such machine the winner was `172.18.0.1`, a proxy tunnel. The phone,
one subnet away on the Wi-Fi, could only report:

```
failed to connect to /172.18.0.1 (port 10897) from /192.168.1.42 (port 34478) after 4000ms
```

Nothing on the desktop said which interface had been chosen, or that there had
been a choice.

Addresses are now ranked rather than taken in list order. `169.254.x.x` is
dropped outright; adapters whose names look virtual (`tun`, `WSL`, `vEthernet`,
Docker, VMware, VirtualBox, Bluetooth, WireGuard, Tailscale …) sort last;
`192.168.x` outranks `10.x` outranks `172.16–31.x`. On the machine above the
list goes from `172.18.0.1` to `192.168.1.7` — the Wi-Fi card, the same /24 as
the phone.

Because the ranking is still a heuristic, it is now visible. The pairing panel
prints the address the code published, and a machine with more than one
candidate gets a picker to override it. A wrong guess is something you can see
and correct instead of a four-second timeout on the other device.

### Every toggle in Settings looked broken on Android

The switch knob moved with the CSS `translate` property. That is Transforms
Level 2, which shipped in Chromium 104; Android System WebView updates through
the Play Store and lags on many OEM builds, so on those devices the declaration
was simply dropped.

The result was the worst possible failure for a toggle: the track changed
colour, so the control had clearly registered the tap, but the knob stayed put.
Every switch read as both broken and half-working — which looks exactly like a
setting that did not save.

All fourteen uses of the individual transform properties (`translate`, `scale`)
are now Level 1 `transform`, supported by every WebView that can run this app.

### Something called "path-to-app" started with Windows

Turning on "launch at login" while running Aevistle from a source checkout
registered `node_modules/electron/dist/electron.exe --hidden` in the Windows
`Run` key. With no app path in it, that entry starts Electron's built-in
placeholder window — so a development run months earlier produced a stray
window every morning that looks nothing like this app.

Login items are now only written by an installed build. An unpackaged run also
clears the entry a previous version left behind, because a packaged build could
never have: it writes a different registry key, so nothing in any user interface
referred to the broken one.

### Android could announce an update and do nothing about it

The update check worked. Downloading and installing were desktop-only, so the
phone could tell you a new version existed and then offer a link to a web page.

Android now downloads the APK in-app, with a progress bar, verified against the
release's published `SHA256SUMS` exactly as the desktop does — streamed to a
`.part` file and renamed only once the digest is accepted, so an interrupted
download can never be mistaken for a finished one. The finished file is handed
to the system package installer, which asks for your confirmation as it always
does.

The APK is written to app-private storage rather than a shared Downloads
folder, so nothing else on the device can rewrite it between the checksum
passing and the installer reading it. `REQUEST_INSTALL_PACKAGES` is new in the
manifest; it does not permit silent installation, and Android 8 and later
additionally gate it behind a per-app settings toggle. If that toggle is off,
Aevistle opens the exact settings screen that grants it and says so.

---

## Changed — the phone layout

### A Home tab, and five fewer things across the bottom

The bottom bar carried all nine tabs. On a 360px screen that never fit, and the
fallback was a horizontal scroller: four tabs sat off-screen at any moment, and
the only clue was that the strip moved if you happened to drag it. Tabs you find
by scrolling a tab bar are tabs most people never find.

The bar is now five: **Compose · Codes · Home · Inbox · Settings**. Schedules,
contacts, templates, the working calendar and the send log live behind Home, as
tiles that open full-screen and close with one button. The split is between
things you reach for by reflex and things you go to deliberately.

The desktop sidebar still lists all nine. `Ctrl+1`–`Ctrl+9` still reach all
nine on both, and on a phone the Home tab lights up when you are on one of the
five behind it.

### Settings is a list, not fourteen screens of scrolling

Sixteen sections stacked in one column made Settings about fourteen phone
screens tall, and reaching Privacy meant scrolling past every other section
first. It is now a list of sixteen rows that fits on two screens, each opening
its section in a dialog. The desktop keeps the two-column grid and its jump bar.

Sections that used to share an anchor are now their own rows, because a row is
a promise about what is behind it: **Backup and restore**, **Move reminders to
another device** and **Save an encrypted pairing file** are three separate
entries, as are **Remote control** and **Calendar subscription**.

### Less explanatory text on a phone

Descriptions under toggles, hints under fields and the blue "here is how this
screen works" notes are hidden below 760px. Each earns its place on a wide
window, sitting in the empty column beside the control it describes; on a phone
it wraps to three lines *under* the control, so a panel of eight switches
becomes thirty-two lines of which eight are the actual controls.

Warnings, errors and success messages are untouched — a phone needs those more
than a desktop does, not less. A small number of hints that are the only place a
fact appears, such as which address a pairing code published, are also kept.

### The working calendar stops explaining itself

The banner reading "No reminders use this calendar yet — it only affects
reminders with 'only send on working days' turned on" was accurate and always
first. Zero is where every install starts, so the first thing anyone ever saw on
that screen was two lines saying the screen was not doing anything, above the
calendar, on every visit. On a phone it pushed the month grid below the fold.
It is gone; the switch it pointed at still says the same thing, where you can
act on it.

The jump bar at the top of Settings is also gone on phones, where the sections
below it are already a list of the same thing.

---

## Notes

- No change to how anything is scheduled, sent, stored or encrypted.
- No new data leaves the device. The update download talks to the same GitHub
  release endpoints the update check already used, pinned to this repository.
- Six languages remain in step; the removed strings were removed from all of
  them.
