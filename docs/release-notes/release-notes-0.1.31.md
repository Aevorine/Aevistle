# Aevistle 0.1.31

A security-focused round, prompted by an external code review of 0.1.30. Four
issues, all fixed and covered by new regression checks so they cannot quietly
come back.

## A crafted email could freeze the app

The verification-code scanner that runs automatically on incoming mail used a
pattern-matching step whose running time grew with the *square* of the
message length on certain inputs — a specially-built email body (no attack on
your device required, just a message landing in an account with auto-scan
on) could make the app appear to hang for seconds at a time, longer for a
longer message. Rewritten to run in time proportional to the message length,
with a hard size limit as a second line of defense, and a new automated test
that fails the build if this regresses.

## Remote images could carry more than a picture

Loading a remote image in a received email trusted that server's declared
file type without double-checking it, which — combined with how the result
was inserted back into the already-sanitized message — could let a hostile
image server smuggle content past the sanitizer and into what you see (not
enough to run code; the message view has no script execution). Both the
declared type and the final result are now strictly validated before either
is trusted. Also closed: a handful of private/reserved network ranges the
image fetcher's anti-SSRF filter did not previously block.

## The desktop auto-updater now checks who published an update, not just that the file wasn't corrupted

Checking a download's hash only proves it matches what `SHA256SUMS.txt`
says — and that file is published to the same place, by the same
credential, as the installer itself. Anyone able to write to a release could
have replaced both together. The updater now also verifies a signature over
that manifest, checked against a key baked into the app, which a compromised
publishing credential alone cannot forge. A release that hasn't been signed
yet installs exactly as before; one that publishes a signature that fails to
verify is refused outright. Full detail in `SECURITY.md`.
