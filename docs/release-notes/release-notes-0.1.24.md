# Aevistle 0.1.24

Typing on Android did not reach the app. That is the plain version of a report
that arrived in two halves — "I enter the email address and nothing fills
itself in", and "I type in one box and the box I filled a moment ago goes
empty" — which sounded like two bugs in the add-account form and were one line
of configuration underneath it.

`android.captureInput` was on. It is Capacitor's hook for hardware keyboards
and barcode scanners, and it works by handing the Android keyboard a
non-editing input connection: there is no text buffer for the keyboard to
compose into, so the system falls back to raw key events, and anything it
cannot express as a keycode — a predicted word, any Chinese input, an emoji —
arrives by a route that Capacitor handles with `document.activeElement.value =
… + '…'`. That assignment writes straight into the page. It fires no input
event. React therefore never learned a key had been pressed: the box looked
filled, the app's own state was still empty, and the next time anything at all
re-drew — one keystroke in the password field, a switch, the seconds counter on
a connection test — every field snapped back to the empty value the app
believed in. Whichever box you touched, the others cleared, which is exactly
what was described. It is also why the address filled nothing in: automatic
configuration runs off that same change event, so the provider, both servers,
both ports, the encryption and the username were never derived at all. Nothing
in the Android code was reading key events, so the setting was buying nothing
and costing every text field in the app. It is off, documented where it lives,
and `npm run check` now fails if it comes back — including if it comes back
only in the copy inside the APK, which is the form of this that would otherwise
be fixed in the repository and still broken on the phone.

With typing working, the add-account screen was rebuilt around what it actually
does. The address is the form: every keystroke in it re-derives the provider,
the send and receive servers, both ports, the encryption and the username. So
it goes first, in the largest control in the dialog, and directly underneath it
is a panel saying what it just decided — the provider it matched, and the two
servers it wrote, printed rather than described. That panel is also the only
honest way to present a guess: an address on a domain no preset knows still
gets values, derived from the `smtp.`/`imap.` convention almost every mail host
follows, and a guessed host looks exactly like a known-good one right up until
the connection test fails. It now says so, in the warning palette, with the
values it guessed on screen.

The credential moved ahead of the server settings. Those two boxes hold the
only thing on the screen a person has to go and fetch from somewhere else — an
app password from the provider's own site, or a round trip through the browser
for OAuth2 — while everything below them was filled in automatically the moment
the address was typed. Putting the machine's work above the person's meant
scrolling past four correct fields to reach the one empty one. The password
gained a show/hide control, which a phone needs more than a desktop does: it is
sixteen characters of provider-generated noise, and getting it wrong otherwise
costs a full connection test to find out.

One layout fault turned up while checking that: a domain with no preset is
printed inside a sentence — "no preset for `<domain>`" — and a domain is a
single unbreakable token. A long corporate one needed about 295px of the 182px
that column gets on a 360px screen, and with nothing to break at the text ran
straight out of the panel and gave the whole dialog a sideways scrollbar. It
wraps now.

Both READMEs now answer the Google sign-in error, because it is not a fault
anyone can fix from inside the app. "Aevistle has not completed the Google
verification process — Error 403: access_denied" is the state of this project's
Google Cloud registration: IMAP and SMTP accept only the `https://mail.google.com/`
scope, Google classes that as restricted, and a restricted-scope app stays in
testing — admitting only hand-listed test users and refusing everyone else with
that 403 — until it passes a verification that requires an independent CASA
Tier 2 security assessment, renewed annually. App passwords are unaffected and
remain the supported path for Gmail; the README says so, and says what building
with your own client id would take for anyone who wants the button instead.

Three numbered steps, then two blocks marked optional. The server settings stay
expanded on every screen size rather than folding away into an "advanced"
disclosure — a wrong port is the commonest reason a send fails, and a port you
cannot see is one you cannot fix. The display name is now marked optional,
because it always was. The address, username, password and host boxes tell an
Android keyboard not to capitalise or autocorrect what goes into them, which is
how `Me@Gmail.con` was becoming a plausible thing to end up with — and since
the domain drives the whole of automatic configuration, a helpfully corrected
one silently meant no provider matched.
