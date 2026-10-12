中文：[从源码构建](从源码构建.md)

## Requirements

| Part | Requirement in this source revision |
|---|---|
| JavaScript | Node.js 22.12.0 or newer, npm |
| Windows packaging | Windows x64 build environment |
| Android | JDK 21 and Android SDK platform 36 |
| Android package | minSdkVersion 24 |
| Publishing | External signing keys and authorized GitHub access |

Check package.json and the Android build configuration when following a newer revision.

## Run from source

Clone the repository, enter its directory and install the locked dependencies:

~~~powershell
git clone https://github.com/Aevorine/Aevistle.git
cd Aevistle
npm ci
~~~

This creates the local development checkout and dependencies. Choose a command for the path you need:

| Task | Command |
|---|---|
| Browser demo, without native SMTP transport | `npm run dev` |
| Native desktop app | `npm start` |
| Type checking | `npm run typecheck` |
| Existing complete CI checks | `npm run check` |
| Windows installer and portable packages | `npm run dist:win` |
| Android release APK | `npm run build:android` |

The isolated UI-check dependencies live under tests. Install them with npm ci --prefix tests before intentionally running checks that need them. Browser checks also require a compatible installed browser.

## Artifacts and signing

Windows packaging writes under release. Android builds produce android/app/build/outputs/apk/release/app-release.apk. Release signing keys remain outside the repository, in the maintainer's external configuration or environment.

An Android release build without valid signing configuration fails; it does not silently publish a debug-signed replacement. Do not copy private keys, passwords or keystore files into source control or Actions secrets.

The release script requires a matching version and artifacts, signs the manifest, uploads, downloads the public copies and verifies hashes and signatures. Publishing requires release authority and signing material; see [scripts/release.mjs](https://github.com/Aevorine/Aevistle/blob/main/scripts/release.mjs) and [SECURITY.md](https://github.com/Aevorine/Aevistle/blob/main/SECURITY.md).
