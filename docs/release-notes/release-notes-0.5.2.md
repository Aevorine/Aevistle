# Aevistle 0.5.2

Includes the CI, privacy and security repairs in 0.5.1, plus the final reviewed Dependabot updates:

- Updated Android status-bar integration to 8.0.4 and KaTeX to 0.19.0.
- Updated mailparser, nodemailer and sanitize-html type definitions.
- Updated the isolated Playwright test runner to 1.63.0.
- Removed the remaining raw request-read error from the local control HTTP response.
- Rebuilt Windows x64 setup/portable applications and the signed Android APK from the final source revision.
- Published the matching dependency-free local control package to GitHub Packages.

All original dependency PRs were resolved or superseded; the three newly generated PRs were reviewed and merged after full Node 22/24 CI passed. Only 0.5.2 and 0.5.1 are retained as published releases.

Check SHA256SUMS.txt and its detached GPG signature before installation. Desktop updates use the Ed25519 manifest signature. Private signing keys, mailbox data and local audit reports are excluded.
