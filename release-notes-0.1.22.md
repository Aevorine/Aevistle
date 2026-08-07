# Aevistle 0.1.22

The desktop and tablet sidebar was sized to the longest label any of the six
languages needed — Spanish's "Bandeja de entrada" — which meant the other five
languages carried 30-40px of rail they never used. Spanish and French had a
shorter, equally standard word for the same tab ("Recibidos", "Réception"),
and giving that back dropped the true minimum from 244px to 208px with zero
truncation, measured against every label in every language, not estimated.

- Sidebar narrowed 244px -> 208px, handing that width to whichever screen is
  open next to it. Verified with the real rendered `scrollWidth`/`clientWidth`
  of every nav label, in all six languages including right-to-left Arabic, and
  the icon-only collapsed rail is unaffected.
- Spanish and French inbox tab: "Bandeja de entrada" -> "Recibidos", "Boîte de
  réception" -> "Réception" — shorter, standard alternatives used by other
  mail clients, not an abbreviation invented for this fix.

Two other things were reported as missing and turned out already to be
working once checked against this build rather than an older install:
account setup fills in the SMTP/IMAP host, port, encryption and provider the
moment an address is typed — no button press — on both platforms, since the
form is the same code either way; and the update card's check, signed
download and install flow has been wired end to end on Windows and Android
since a much earlier release. If either still looks broken on your device
after installing this build, that is a real bug and worth reporting again.

Nothing about how mail is scheduled, stored, sent or encrypted changed.
