# Aevistle 0.1.17

Pairing works in every direction now. Until this release a pairing had to be
started on a computer — the phone could scan a code but never show one — so two
phones, or two tablets, or a tablet and a phone, could not be paired at all
without a desktop in the room to hold the code.

The rest is the phone and tablet interface: three panels that appeared in the
wrong place with no way to close them, a settings screen that gave tablets the
desktop layout, and a section that opened completely empty.

Nothing about how mail is scheduled, sent, stored or encrypted changed. The
pairing handshake itself is not new code — see the last section.

---

## Any two devices can pair, from either end

The phone and tablet apps can now show a pairing QR code, not just read one.
All six combinations work, and either side can be the one showing the code:

| | Computer | Phone | Tablet |
|---|---|---|---|
| **Computer** | ✅ | ✅ | ✅ |
| **Phone** | ✅ | ✅ | ✅ |
| **Tablet** | ✅ | ✅ | ✅ |

Android also answers ongoing sync now, rather than only starting it. Two phones
kept in sync no longer need a computer to be the one that listens.

The reason it was ever one-directional is worth stating, because it was a wrong
conclusion rather than a missing feature: only the desktop can hold a LAN socket
open *in Node*, and that was read as "only the desktop can host". But the
handshake is `core/pairing.ts` running on WebCrypto, which the WebView has, and
both desktop servers are deliberately dumb relays that decrypt nothing and hold
no keys. The socket was the only genuinely native part. So Android got a socket
— `LanServer.java`, which decides nothing — and the handshake runs in the app on
the same code the desktop calls, in the same order. There is still exactly one
implementation of the key exchange, and `npm run check` still guards that one.

Two limits, both stated on screen rather than discovered:

- A phone answers a sync request while the app is open. Android freezes a
  backgrounded WebView, so a request that arrives then is refused in twelve
  seconds with "not ready to answer right now" instead of being left to time
  out — the two look identical from the other device and only one is honest.
- The listening port opens on the phone only once you have a device paired for
  ongoing sync, never before.

Because a code can now have come from anything, the side scanning it stops
assuming the other device is a Windows machine and asks. That question used to
appear only when showing a code.

## The QR code and the camera appeared where you were not looking

Tapping "Pair a new device" or "Use a code from another device" added a panel
*after* the device list rather than opening one. On a desktop that reads as a
panel expanding under the button. On a phone it does not: Settings is itself a
full-height dialog there, the device list fills it, and the panel therefore
appeared below the fold — the camera switched on off-screen, and the QR code
turned up somewhere you had to go and find.

All three panels — the code, the regenerated code, and the scanner — are now
dialogs that open where the tap was, full screen on a phone or tablet, each with
a close button they never had. Closing stops the LAN listener and releases the
camera, rather than leaving either running behind a panel you dismissed.

## Tablets were being handed the desktop layout

The switch between the phone and desktop structures was a 760px media query, and
a tablet is 800px in portrait. So on a tablet, Settings rendered sixteen cards in
a two-column grid instead of rows that open, and dialogs floated as cards with
scrim down both sides.

Width is the right question for the tab bar — a 1280px tablet has room for nine
tabs and folding four behind Home would cost a tap each — but it is the wrong
question for structure. That now asks a wider one: a narrow window **or** a
touch platform. On a tablet, the daily digest, holiday greetings, publishing the
working calendar and pairing are rows you tap to open, full screen, with one way
out. The tab bar is unchanged.

## "Publish the working calendar" opened an empty screen

The row was drawn, it was tappable, and behind it was nothing at all — the card
returned nothing on Android while the row that promised it did not know.

It now says what it cannot do and why: a subscription address has to keep
answering for weeks, and Android stops a background listener long before that,
so the address would work until the app was swiped away. In its place is an
export that does work — days off and make-up workdays as a `.ics` any calendar
app on the device can import.

That needed saving a generated file to work on Android at all, which it did not:
`<a download>` is inert in the app's WebView, so every export refused outright
and said so. **That also fixes exporting a backup, a reminder transfer file and
an encrypted pairing file from a phone** — all three were blocked the same way,
and all three now open the system's save dialog.

## Also

"Paired devices" is now called "Pairing", and the strings that claimed only a
desktop can show a code, or blamed Windows for failures both platforms can have,
say something true again. All six languages.

---

## Notes on how this was checked

`npm run check` passes: typecheck, 16 checks, the six locales agreeing across
1,503 keys each, 91 feature checks, 21 security self-audit checks, and no
dependency advisories at high or above.

Two guards matter more than the rest for this release:

- `check:pairing-crypto` passes unchanged, which is the point of not
  reimplementing the handshake. A second copy in Java would have been two
  implementations that must agree forever, and the wrong one would be the one
  nobody looks at.
- `check:android-plugin` verifies all 42 declared plugin methods against 42
  `@PluginMethod` handlers. Every new native method is reachable; none is
  declared and missing, which is a failure that typechecks, builds, installs,
  and only appears when someone taps the thing.

One defect was found and fixed during review rather than after: the first
version of the pairing socket closed after the first connection of *any* kind,
so a single packet from a network scanner could have ended a pairing halfway
through. That is exactly what the desktop server refuses to do. The decision now
sits where the token is, with a socket-identity guard for the case where one
session ends as the next begins.
