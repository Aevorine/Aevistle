中文：[应用更新](应用更新.md)

## Update sources

Use the application's opt-in update check or download the [latest project release](https://github.com/Aevorine/Aevistle/releases/latest) yourself. Windows setup, Windows portable and Android APK are separate artifacts; choose the same platform and the intended install type.

## What verification means

| Check | Purpose |
|---|---|
| SHA-256 manifest | Detect a changed or incomplete downloaded file |
| Detached GPG signature | Verify the release manifest against the published key |
| Ed25519 manifest signature | Verify the desktop update manifest against the embedded key |
| Android APK signature | Verify the installed package's signer and upgrade compatibility |

Windows Authenticode certificate signing is not currently configured. It is separate from manifest verification. The procedure and public-key fingerprint are in [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md).

## Keep your data

Before changing installation type or moving machines, export a backup and note the data folder shown in Settings. Do not clear account data to fix a failed download. Android upgrades require compatible signing identity; an install signed with another key is not an equivalent upgrade.

If automatic downloading fails, use the official release page and verify its files. See [Data location](Data-location.md) and [Troubleshooting](Troubleshooting.md).
