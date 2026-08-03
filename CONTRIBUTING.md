# Contributing

Thanks for looking. Issues, feature requests and pull requests are all welcome.

## Getting set up

Node.js 20+ is enough for everything except the Android build.

```bash
npm install
npm run dev        # opens in a browser — no SMTP, but every other feature is live
```

The browser build is the fastest way to work on the interface. It persists to
`localStorage`, runs the real scheduling engine, and only stubs the one thing a
browser genuinely cannot do: open a socket.

For the desktop app:

```bash
npm start          # builds, then launches Electron
```

For Android you also need JDK 21, the Android SDK with platform 36 and
build-tools 36, and `android/local.properties` pointing at your SDK:

```bash
npm run build:android
```

## Where things live

```
src/core/       Platform-independent. No DOM, no Node, no Android.
                Domain types, the recurrence engine, validation, provider presets.
src/i18n/       One file per language. `en.ts` is the source of truth.
src/components/ Reusable UI primitives.
src/views/      One file per screen.
src/state/      The single store, and the only place that talks to the bridge.
electron/       Windows main process: SMTP, secret storage, tray, scheduler.
android/app/    Android: the Capacitor plugin, JavaMail, Keystore, alarms.
scripts/        Build and audit tooling.
```

The rule that keeps this workable: **`src/core` must stay portable.** If a
change there needs a file system, a socket or a platform API, it belongs behind
`PlatformBridge` instead. That is what lets the same code run in Electron, in
an Android WebView, and in a plain browser.

## Adding a language

One file, no build tooling.

1. Copy `src/i18n/en.ts` to `src/i18n/<code>.ts` and translate the values.
2. Type it as `Translations` — TypeScript will list every key you missed.
3. Register it in `src/i18n/index.ts`: add an entry to `LOCALES` (set
   `dir: 'rtl'` if the script runs right to left) and to the `TABLES` map.
4. Add `LocaleId` to `src/core/types.ts`.

A translated README under `docs/` is appreciated but not required.

## What a good change looks like

- **One thing at a time.** A PR that fixes a bug and reformats 400 lines is
  hard to review and hard to revert.
- **Match the surrounding code.** Comment density, naming and structure vary a
  little between `core`, the views and the native layers; follow whichever file
  you are in.
- **Comment the why, not the what.** `// increment i` is noise. `// KEEP, not
  REPLACE: a duplicate alarm must not send the mail twice` is the reason the
  next person does not undo your fix.
- **Run the checks.** `npm run typecheck` and `npm run audit:self` both need to
  pass. The audit is fast and catches the mistakes that matter most here.

## Touching the mail path

Anything under `electron/mailer.ts`, `android/.../MailSender.java` or
`src/core/validate.ts` deserves extra care — that is where a small mistake
turns into an open relay or a leaked password. If you change validation on one
platform, change it on the other in the same PR; the two are kept deliberately
symmetric so a user never finds that their phone accepts something their
desktop rejects.

Security issues should go through the private channel in
[SECURITY.md](SECURITY.md) rather than a public PR.

## Commit messages

Plain and specific. `Fix monthly recurrence skipping February` tells the story;
`fix bug` does not. Conventional Commits are welcome but not required.
