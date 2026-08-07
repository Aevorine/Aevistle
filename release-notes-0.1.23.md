# Aevistle 0.1.23

The desktop sidebar carried a line under the logo saying what the app does —
useful the first time, and then permanently in the way of the one thing a
navigation rail is actually for. It is gone, and the extra vertical room let
the rail narrow further: from 208px down to 185px, re-measured the same way
the last cut was — real `scrollWidth`/`clientWidth` against every nav label in
all six languages, not estimated. That first measurement missed something the
first cut didn't have to account for: unread and scheduled-count badges. A
mailbox with hundreds of unread messages was pushing "Inbox" past its column
and clipping it, in every language, because the badge digits were never part
of the width budget. Badges now cap their display at "99+", the same
convention every mail and chat app uses, and the rail is re-verified clipping-
free with that in place.

Adding a mail account on a phone was one long form — sixteen-odd fields in a
single column, the address box no bigger than any other field despite being
the one thing everybody actually has to type. It is now grouped into named
sections: address first and enlarged, since that's the field that drives
everything else; server settings next, still fully visible because a
disabled-test-button explanation has to point at fields you can actually see;
optional extras (label, group, reply-to, the two advanced switches) folded
under a "more settings" disclosure that starts open on desktop and closed on
a phone; receiving last. Fixing this also surfaced a genuine React bug: a
native `<details>` element's `open` attribute does not reliably clear itself
through a state update, so the "more settings" panel could stay expanded
across different accounts' edit dialogs. It is now synced with a ref instead
of trusted to the attribute.

A pass through every long-winded hint, banner and tooltip in the app —
desktop and Android both, including the handful that survive the phone's
usual rule of hiding explanatory text — cut the ones that were saying the
same thing twice across two different screens (the Windows Defender firewall
notice, the Microsoft OAuth2 cutoff explanation, the four port/encryption
hints) down to one clear version each, and trimmed a dozen more that spent a
sentence explaining *why* before ever getting to what to do about it. Nothing
that states a port number, a deadline, a URL, or a promise about what does or
doesn't happen to your data (server mail, plaintext passwords, automatic
sending) was touched — those stayed exactly as specific as they were.

Also: the crash-recovery screen — the one that appears if a single screen
fails to render — was hard-coded in English regardless of the app's language
setting. It now reads in whichever of the six languages you're using, same as
everywhere else, and still says the one thing that screen exists to say:
your accounts, scheduled sends and mail are untouched by a rendering crash.

Nothing about how mail is scheduled, stored, sent or encrypted changed.
