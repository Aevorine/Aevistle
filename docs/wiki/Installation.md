中文：[安装](安装.md)

## Choose a build

Download from the [latest release](https://github.com/Aevorine/Aevistle/releases/latest). Both Windows files run the same application.

| Build | How to use it |
|---|---|
| Windows x64 setup | Run the setup executable and follow the installer |
| Windows x64 portable | Run the portable executable without an installer |
| Android APK | Install on a device that supports Android APK packages |

The portable executable does not mean that credentials and schedules sit beside the executable. The app's data location is shown in Settings; see [Data location](Data-location.md).

## Verify the download

Compare the file's SHA-256 with SHA256SUMS.txt from the same release. The manifest has a detached GPG signature, and desktop updates check its Ed25519 signature. The public-key fingerprint and verification procedure are in [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md).

Windows EXEs do not currently have an Authenticode certificate signature. A Windows publisher warning and a release-manifest signature are different mechanisms. Verify the project release before deciding to run a downloaded file.

## Android

Allow the selected installation source when Android asks, then open the app. Check that the device supports Android APKs before treating an installation failure as a permissions problem. Notifications, exact alarms and background execution need their own permissions after installation.

## Next

Continue with [First-run setup](First-run-setup.md). If the release page or file download fails, see [Troubleshooting](Troubleshooting.md).
