# Aevistle 0.5.1

- Updated mail, rendering, Electron, Capacitor and Android dependencies to address security advisories.
- Removed persistent demo credentials, replaced weak identifier randomness, scrubbed internal HTTP errors and removed shell-based screenshot drive commands.
- Sanitized every mail-header control character instead of just the first.
- Handled IMAP STATUS false responses safely, preserving cached mail unless the server confirms an empty inbox.
- Repaired the date-sensitive calendar regression fixture with a scoped fixed clock and real performance timing.
- Pinned CI actions to immutable upstream v7 commits.
- Hardened release/signature helpers by spawning native executables without a shell and rejecting malformed release tags.
- Added the user guide, troubleshooting pages, maintenance roadmap and a GitHub Packages workflow for the local control clients.
- Excluded local agent state and audit evidence from git. Private keys remain external.

Downloads: Windows x64 setup, Windows x64 portable, Android APK. Verify SHA256SUMS.txt with the detached GPG signature; the desktop updater uses the Ed25519 signature.
