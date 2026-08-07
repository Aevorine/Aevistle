#!/usr/bin/env node
/**
 * The OAuth2 redirect URI is written down in three places that cannot see each
 * other. This gate makes them agree.
 *
 *   1. `src/core/oauth.ts` — `ANDROID_REDIRECT_SCHEME` / `ANDROID_REDIRECT_URI`,
 *      which is what the app *asks* the provider to redirect to.
 *   2. `android/app/src/main/AndroidManifest.xml` — the `<intent-filter>` that
 *      decides which URLs Android will hand back to this app.
 *   3. Google Cloud Console and Microsoft Entra, which refuse anything they were
 *      not told about. That one is outside the repository, which is exactly why
 *      the two that are inside it must not be allowed to drift.
 *
 * Why this is worth a gate rather than care:
 *
 *   - Every failure mode here is silent at build time and invisible in review.
 *     Change the scheme in the TypeScript and the app builds, installs, opens
 *     the consent page, the user signs in — and then the browser lands on a URL
 *     no app claims. Android shows a "cannot open" page or a chooser; the
 *     `PluginCall` is never resolved, so the dialog spins forever. Nothing
 *     logs an error, because from the app's point of view nothing happened.
 *   - Change it in the manifest instead and the symptom is identical.
 *   - The scheme is also the *package name*, so an `applicationId` rename —
 *     the ordinary kind of change nobody would connect to sign-in — breaks it
 *     from a third direction. So that is checked too.
 *
 * A private-use URI scheme must be one the app can legitimately claim (RFC 8252
 * §7.1): reverse-DNS on a domain the project controls. A short, generic scheme
 * is one another app can also register, and Android resolves a contested scheme
 * with a chooser — which in this flow means handing somebody else's app an
 * authorization code. The scheme being equal to the application id is what makes
 * it collision-resistant, so that equality is the rule, not a coincidence.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let checks = 0
let failed = 0

function check(label, condition, detail = '') {
  checks++
  if (condition) return
  failed++
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n  the OAuth2 redirect agrees across TypeScript, the manifest and the package name\n')

// --- 1. what the app asks for ----------------------------------------------

const oauthTs = read('src/core/oauth.ts')

const schemeMatch = oauthTs.match(/export const ANDROID_REDIRECT_SCHEME\s*=\s*'([^']+)'/)
check('ANDROID_REDIRECT_SCHEME is declared in src/core/oauth.ts', Boolean(schemeMatch))
const scheme = schemeMatch?.[1]

const uriMatch = oauthTs.match(/export const ANDROID_REDIRECT_URI\s*=\s*`\$\{ANDROID_REDIRECT_SCHEME\}:\/\/([^`]+)`/)
check(
  'ANDROID_REDIRECT_URI is built from ANDROID_REDIRECT_SCHEME',
  Boolean(uriMatch),
  'it must interpolate the scheme rather than repeat it, or the two can disagree on their own',
)
const remainder = uriMatch?.[1] ?? ''
const host = remainder.split('/')[0]

// --- 2. what Android will hand back ----------------------------------------

const manifest = read('android/app/src/main/AndroidManifest.xml')

const dataTags = [...manifest.matchAll(/<data\s+([^>]*?)\/>/g)].map((m) => m[1])
const attrs = (tag, name) => tag.match(new RegExp(`android:${name}="([^"]*)"`))?.[1]
const oauthFilter = dataTags.find((tag) => attrs(tag, 'scheme') === scheme)

check(
  `AndroidManifest.xml has an <intent-filter> claiming the "${scheme}" scheme`,
  Boolean(oauthFilter),
  'without it the consent redirect lands nowhere and the sign-in dialog never settles',
)
check(
  `...and it is scoped to the "${host}" host`,
  oauthFilter ? attrs(oauthFilter, 'host') === host : false,
  `manifest host is ${oauthFilter ? attrs(oauthFilter, 'host') : '(none)'}, oauth.ts expects ${host}`,
)

// The filter is useless without BROWSABLE: a browser cannot start an activity
// that has not said browsers may. This is the single most common way a redirect
// filter is written wrongly, because it looks complete without it.
const browsableBlock = manifest.includes('android.intent.category.BROWSABLE')
check('the redirect intent-filter is BROWSABLE', browsableBlock, 'a browser cannot start it otherwise')

// singleTask, so the redirect arrives at the running instance as onNewIntent
// rather than launching a second copy that has no pending call to resolve.
check(
  'MainActivity is launchMode="singleTask"',
  /android:launchMode="singleTask"/.test(manifest),
  'otherwise the redirect starts a fresh activity with no pending consent to finish',
)

// --- 3. the package name ----------------------------------------------------

const gradle = read('android/app/build.gradle')
const applicationId = gradle.match(/applicationId\s+"([^"]+)"/)?.[1]

check('applicationId is declared in android/app/build.gradle', Boolean(applicationId))
check(
  'the redirect scheme is the application id',
  scheme === applicationId,
  `scheme "${scheme}" vs applicationId "${applicationId}" — RFC 8252 §7.1 wants a scheme only this app can claim`,
)

// --- 4. no invented credentials --------------------------------------------

/*
 * A client id must be either a real registration or empty. The states in
 * `oauthState` are built so that empty is honest and handled; a placeholder is
 * the one value that produces a consent page which opens and then fails with
 * the provider's own error text, which no user can act on.
 */
const ids = [...oauthTs.matchAll(/^\s*(google|microsoft):\s*'([^']*)'/gm)].map((m) => m[2])
const placeholder = ids.find(
  (id) => id && !/\.apps\.googleusercontent\.com$/.test(id) && !/^[0-9a-f-]{36}$/i.test(id),
)
check(
  'no placeholder client ids',
  placeholder === undefined,
  placeholder ? `"${placeholder}" is neither a Google client id, an Entra GUID, nor empty` : '',
)

// --- 5. the Android registry is keyed by real fingerprints -----------------

/*
 * The Android table maps a signing-certificate SHA-1 to the client id
 * registered against it, and Java looks the running build up in it by computing
 * its own fingerprint. That lookup is an exact string match, so a key that is
 * merely *shaped wrong* — 19 bytes because a pair was dropped in a paste, hex
 * with no separators, lowercase — matches nothing and produces "no OAuth client
 * is registered for this build" on a build whose client is registered fine.
 *
 * `normaliseFingerprint` absorbs case and separators at runtime, so what is
 * enforced here is the part it cannot fix: the wrong number of bytes. Twenty is
 * not negotiable — SHA-1 is 160 bits — and a 19- or 21-byte key is always a
 * typo, never a choice.
 */
const androidBlock = oauthTs.match(
  /export const OAUTH_ANDROID_CLIENT_IDS[^=]*=\s*\{([\s\S]*?)\n\}/,
)?.[1]
check('the Android client table is present', Boolean(androidBlock))

const entries = [...(androidBlock ?? '').matchAll(/'([0-9A-Fa-f:]{20,})'\s*:\s*\n?\s*'([^']+)'/g)]
check(
  'the Android table has at least one registration',
  entries.length > 0,
  'an empty table is a supported state, but this project has registered ids — an empty one now means they were lost in an edit',
)
for (const [, fingerprint, id] of entries) {
  const bytes = fingerprint.replace(/[^0-9A-Fa-f]/g, '').length / 2
  check(
    `fingerprint ${fingerprint.slice(0, 11)}… is a 20-byte SHA-1`,
    bytes === 20,
    `it is ${bytes} bytes — Java computes 20 and will match nothing`,
  )
  check(
    `…and maps to a Google client id`,
    /\.apps\.googleusercontent\.com$/.test(id),
    `got "${id}"`,
  )
}
// Two distinct certificates, two distinct clients. Registering one id under
// both fingerprints is a paste error that looks right and fails on exactly one
// of the two builds.
const uniqueIds = new Set(entries.map((e) => e[2]))
check(
  'each registered certificate has its own client id',
  uniqueIds.size === entries.length,
  'the same client id appears under more than one fingerprint',
)

console.log(`\n  ${checks} checks${failed ? `, ${failed} failed` : ''}`)
console.log(failed ? '\n  Redirect configuration is inconsistent.\n' : '\n  All clear.\n')
process.exit(failed ? 1 : 0)
