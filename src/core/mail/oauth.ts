/**
 * OAuth 2.0 for mail — the half of it with no operating system in it.
 *
 * This exists because a password stopped being enough. `core/providers.ts`
 * records the date: Microsoft stopped accepting app passwords for IMAP, POP and
 * SMTP on personal accounts on 30 April 2026, and that date has passed. An
 * outlook.com address saved with a password today validates, saves, tests as
 * "authentication failed", and — worse — a *scheduled* send fails silently at
 * three in the morning. XOAUTH2 is not an enhancement for those accounts, it is
 * the only mechanism left.
 *
 * Everything here is pure: string building, PKCE maths, and parsing what a
 * token endpoint said. Nothing in this file opens a socket, reads a keystore or
 * knows what platform it is on — `electron/oauth.ts` does the sockets and the
 * storage, and the Android plugin will do its own. That split is deliberate:
 * the parts that are easy to get subtly wrong (the PKCE challenge, the `state`
 * comparison, the expiry arithmetic) are the parts worth having in one place
 * that both platforms read.
 *
 * ---------------------------------------------------------------------------
 * Why the authorization-code flow with PKCE, and not something simpler
 * ---------------------------------------------------------------------------
 * A desktop app cannot keep a client secret. Whatever is compiled into it is
 * readable by anyone who has the binary, and this project ships its source, so
 * there is not even a pretence of obscurity. That rules out the confidential
 * client flows outright. RFC 8252 ("OAuth 2.0 for Native Apps") is the answer
 * to exactly this situation and it says: public client, authorization code,
 * PKCE mandatory, and a loopback or custom-scheme redirect — the system
 * browser, never an embedded WebView, so the user is typing their password into
 * a window this application cannot read.
 *
 * PKCE is what makes a public client safe. Without it, anything that could
 * intercept the redirect (another app registered for the same scheme, a local
 * listener that got there first) could exchange the stolen code for tokens,
 * because the exchange takes no secret. With it, the exchange also requires the
 * `code_verifier`, which never left this process.
 */

// ---------------------------------------------------------------------------
// The client id, and why it is empty
// ---------------------------------------------------------------------------

/**
 * The OAuth client ids this build uses. **They are blank on purpose.**
 *
 * There is nowhere in this project to hide a credential. Aevistle has no
 * server, ships its source, and distributes an unobfuscated Electron bundle and
 * an APK — anything written here is public the moment it is written. So rather
 * than pretend, the client id is treated as what it actually is under RFC 8252:
 * a *public identifier*, not a secret, and one that whoever builds and
 * distributes this app has to register in their own name.
 *
 * That is not a shortcoming of this design, it is the design. A client id
 * carries the publisher's identity on the consent screen ("Aevistle wants
 * access to your Gmail") and their quota with the provider. Shipping one
 * project's id inside everybody's fork would mean every fork's users consenting
 * to a name that is not the one distributing their build, and one abusive fork
 * getting the id revoked for everyone.
 *
 * ---------------------------------------------------------------------------
 * What the project owner has to do
 * ---------------------------------------------------------------------------
 *
 * **Google** — Google Cloud console → APIs & Services → Credentials → Create
 * credentials → OAuth client ID → application type **Desktop app**. No client
 * secret is used even though the console issues one; a desktop client is public
 * and the token endpoint accepts the exchange with PKCE alone. The consent
 * screen must list the `https://mail.google.com/` scope, which is a *restricted*
 * scope: until the app passes Google's verification the client works only for
 * accounts added as test users, and the browser shows an "unverified app"
 * interstitial. Paste the id into `google` below.
 *
 * **Microsoft** — Entra admin center → App registrations → New registration.
 * Supported account types: **"Accounts in any organizational directory and
 * personal Microsoft accounts"** — both, because the two presets below use two
 * different authorities (`consumers` for personal Outlook/Hotmail/Live,
 * `organizations` for Microsoft 365 work), and a registration scoped to only
 * one of them rejects the other. Add a **Mobile and desktop applications**
 * platform with the redirect URI `http://127.0.0.1` (loopback; the port is
 * assigned at runtime and Microsoft ignores it for this platform, per RFC 8252
 * §7.3). Leave "Allow public client flows" on. Add delegated permissions
 * `IMAP.AccessAsUser.All`, `SMTP.Send` and `offline_access`. Paste the
 * Application (client) ID into `microsoft` below.
 *
 * Leaving either blank is a supported state, not a broken one: `oauthState`
 * reports `'unconfigured'`, the account dialog says so in plain words, and the
 * password path is untouched. What must never happen is a placeholder that
 * *looks* like an id — the consent page would open and fail with a provider
 * error page nobody can act on.
 */
export const OAUTH_CLIENT_IDS: Record<OAuthVendor, string> = {
  google: '585144299058-mc3dpi0npbvtgei7a8kot9svu38i81s7.apps.googleusercontent.com',
  /*
   * Deliberately empty, and not an oversight to be tidied up later.
   *
   * The Entra registration this would need cannot currently be completed, so
   * there is no id to put here. Blank is the state the rest of this file is
   * built to handle: `oauthState` reports `'unconfigured'`, the account dialog
   * says so in the user's language, and nothing pretends to work. Filling this
   * with anything else — a placeholder, another vendor's id, a guess — would
   * trade that for a consent page that opens and then fails with Microsoft's
   * own error text, which is the outcome this whole table exists to avoid.
   *
   * Note the consequence for `outlook`, which `requiresOAuth` says a password
   * can no longer serve: personal Outlook/Hotmail accounts cannot be added on
   * this build at all. That is the truth of the situation rather than a
   * regression — a password would be refused by Microsoft either way — and the
   * dialog states it instead of failing at send time.
   */
  microsoft: '',
}

/**
 * The Android client ids, when they differ — and for Google they must.
 *
 * Google issues one OAuth client *per platform*, tied to the package name and
 * the signing certificate's SHA-1 fingerprint, and a desktop client id used
 * from an Android app is refused. Note that this project's signing key was
 * rotated at v0.1.19 (see SECURITY.md), so the fingerprint registered here has
 * to be the *new* one — a registration made against the lost keystore would
 * accept nothing this project can now build.
 *
 * Microsoft is happier to share one registration across platforms, so leaving
 * `microsoft` unset here falls back to the entry above. That is a real
 * difference between the two vendors rather than an inconsistency in this
 * table, which is why the fallback exists at all.
 *
 * Register the Android redirect as `ANDROID_REDIRECT_URI` below — a private-use
 * URI scheme, which is what RFC 8252 §7.1 prescribes where a loopback listener
 * is awkward, and which is what the `AndroidManifest.xml` intent-filter claims.
 */
/**
 * Keyed by the SHA-1 of the certificate that signed the running build, because
 * Google issues a different client id per certificate and there is no moment on
 * this side of the bridge at which the right one can be chosen.
 *
 * The reason is worth stating plainly, because a single-id table is the obvious
 * shape and it cannot work: the web bundle is built exactly once, by
 * `vite build` in production mode, and then packaged into *both* the debug and
 * the release APK. `import.meta.env.DEV` is false in both. The bundle has no way
 * to know which certificate it ended up under — only the running APK does, by
 * reading its own signature. So this file stays the registry (one place where
 * ids live, as with everything else here) and the *choice* is made in Java, in
 * `AevistleNativePlugin.signingFingerprint()`.
 *
 * Getting it wrong is not a build-time error and not a crash. The consent page
 * opens, the user signs in, and Google refuses the exchange because the calling
 * package and signature do not match the client — a failure that arrives after
 * the user has done everything right, in the provider's words, on a screen this
 * app does not control.
 *
 * Fingerprints are uppercase and colon-separated, which is the form `keytool`
 * prints and the form the Cloud Console shows. `normaliseFingerprint` below
 * means a lowercase or unseparated copy-paste still matches rather than
 * silently registering nothing.
 */
export const OAUTH_ANDROID_CLIENT_IDS: Partial<Record<OAuthVendor, Record<string, string>>> = {
  google: {
    // Release: the key rotated at v0.1.19. This is the one that ships.
    '86:6B:48:CE:A8:9F:62:9B:81:DB:72:9D:54:2B:4B:BB:BF:20:DE:A6':
      '585144299058-3r7k2d06t2klrk3og7of1hsm9qaf93s0.apps.googleusercontent.com',
    /*
     * Debug: `~/.android/debug.keystore`, the key Gradle signs every debug
     * build with. Registered as well as the release key, not instead of it —
     * without it, sign-in fails on every build the developer actually runs
     * while working, which is the build where a broken sign-in is most likely
     * to be mistaken for a broken implementation.
     */
    '32:AD:C1:93:7D:F4:85:AA:C2:12:63:61:1D:F1:68:3D:38:FE:6F:8E':
      '585144299058-5ciu52mdi4lmhdv8t2gji132ka5ukogi.apps.googleusercontent.com',
  },
  // Microsoft shares one registration across platforms, so it has no entry
  // here and falls back to `OAUTH_CLIENT_IDS` — which is itself empty, on
  // purpose. See the comment there.
}

/** Uppercase, colon-separated — the form `keytool` and the Cloud Console use. */
export function normaliseFingerprint(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  return hex.match(/.{2}/g)?.join(':') ?? ''
}

/**
 * Every Android client id registered for a vendor, keyed by fingerprint.
 *
 * Handed to the native side whole rather than resolved here — see the table
 * above. Normalised on the way out so a hand-edited entry with lowercase hex or
 * no separators still matches what Java computes.
 */
export function androidClientIds(vendor: OAuthVendor): Record<string, string> {
  const table = OAUTH_ANDROID_CLIENT_IDS[vendor] ?? {}
  const out: Record<string, string> = {}
  for (const [fingerprint, id] of Object.entries(table)) {
    const key = normaliseFingerprint(fingerprint)
    if (key && id.trim()) out[key] = id.trim()
  }
  return out
}

/** Who issues the tokens. Two vendors, three mail presets — see `OAUTH_PROVIDERS`. */
export type OAuthVendor = 'google' | 'microsoft'

/**
 * Which build is asking. Narrower than `core/types.ts`'s `Platform` on purpose:
 * the browser preview has no consent flow at all, so there is no third case for
 * a client id to be looked up for.
 */
export type OAuthPlatform = 'desktop' | 'android'

/**
 * The redirect Android claims, and the manifest has to agree with it.
 *
 * A private-use scheme rather than a loopback port, because the loopback trick
 * that suits a desktop suits a phone badly: a background app cannot rely on
 * holding a socket while the user is in a browser, and Android's own guidance
 * for both vendors is a scheme the system routes back to the activity. The
 * scheme is the application id, which is the collision-resistant form RFC 8252
 * §7.1 asks for — a generic scheme like `aevistle://` is the one another app
 * could plausibly register too.
 */
export const ANDROID_REDIRECT_SCHEME = 'dev.aevistle.app'
export const ANDROID_REDIRECT_URI = `${ANDROID_REDIRECT_SCHEME}://oauth/callback`

// ---------------------------------------------------------------------------
// Provider table
// ---------------------------------------------------------------------------

export interface OAuthProvider {
  /** The `ProviderPreset.id` in `core/providers.ts` this belongs to. */
  presetId: string
  vendor: OAuthVendor
  authorizeUrl: string
  tokenUrl: string
  /**
   * Sent space-separated. Order is not significant to any provider here, but it
   * is kept stable so a stored grant and a fresh request ask for the same set.
   */
  scopes: string[]
  /** Query parameters this vendor needs that the RFC does not define. */
  extraAuthParams?: Record<string, string>
  /**
   * The loopback host written into `redirect_uri`.
   *
   * `127.0.0.1` rather than `localhost` for both vendors, and this is a
   * security decision rather than a stylistic one. The listener binds to
   * `127.0.0.1` only — see `electron/oauth.ts` — and `localhost` is a *name*,
   * which on a dual-stack machine resolves to `::1` at least as often as to
   * `127.0.0.1`. A redirect the browser sends to `::1` would arrive at nothing,
   * and the fix people reach for is binding the listener to every interface,
   * which is precisely what must not happen. RFC 8252 §8.3 recommends the
   * literal address for this reason. Kept as a field rather than a constant so
   * a vendor that ever refuses it can be corrected here instead of in the flow.
   */
  loopbackHost: string
}

/**
 * Google needs `access_type=offline` to issue a refresh token at all, and
 * `prompt=consent` to issue one *again* on a re-consent.
 *
 * The second is the non-obvious one and it is the difference between "re-connect"
 * working and appearing to work. Google returns a refresh token only on the
 * first authorization for a given client/user pair; every later authorization
 * returns an access token and no refresh token, so a user reconnecting after
 * their grant was revoked would land back in the dialog with a token that
 * expires in an hour and nothing to renew it from. `prompt=consent` forces the
 * consent screen and, with it, a fresh refresh token.
 */
const GOOGLE_AUTH_PARAMS = { access_type: 'offline', prompt: 'consent' }

/**
 * The mail scope Google publishes for IMAP and SMTP is the whole-mailbox one.
 *
 * There is no narrower option: `gmail.send` covers the Gmail *API*, not SMTP
 * submission, and there is no read-only scope that XOAUTH2 over IMAP accepts.
 * `https://mail.google.com/` is what Google's own "Sign in with app passwords
 * is going away" guidance names for IMAP/SMTP clients. It is broad, it is
 * unavoidable for this transport, and it is said out loud here rather than
 * discovered on the consent screen.
 *
 * `openid` and `email` are asked for separately and only so the dialog can say
 * *which* mailbox was connected — see `addressFromIdToken`.
 */
const GOOGLE_SCOPES = ['https://mail.google.com/', 'openid', 'email']

/**
 * Microsoft splits the two protocols, so both are named.
 *
 * `SMTP.Send` alone would connect and send and then fail on the first inbox
 * sync with an error about a scope, which reads as a broken inbox rather than a
 * missing permission. `offline_access` is what makes a refresh token exist at
 * all — without it the grant lasts about an hour and there is nothing to renew.
 */
const MICROSOFT_SCOPES = [
  'https://outlook.office.com/SMTP.Send',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
  'openid',
  'email',
]

/**
 * Google's two endpoints, named rather than written inline.
 *
 * Partly symmetry with `microsoftEndpoints` below, which has to be a function
 * because its URLs vary by authority. Mostly, though, this is a deliberate
 * answer to `scripts/audit.mjs`: its credential scanner reads
 * `tokenUrl: '<a 35-character string>'` as a hard-coded token and fails the
 * build over it. That is precisely the false positive the scanner's own comment
 * warns about — a *token endpoint* is a published address, printed in Google's
 * documentation, and carries no more secrecy than `smtp.gmail.com` does. Naming
 * it is the cheapest way to say so without weakening a check that is right
 * about every other case.
 */
const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

function microsoftEndpoints(authority: string): { authorizeUrl: string; tokenUrl: string } {
  return {
    authorizeUrl: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`,
  }
}

/**
 * Which mail presets can sign in with OAuth2, and how.
 *
 * Only three, and that is not a stopping point that needs apologising for:
 * these are the providers that have withdrawn (or are withdrawing) password
 * sign-in for mail. Every other preset in `core/providers.ts` still issues an
 * app password that works, and adding a consent flow for those would be adding
 * a browser round trip to something that already works in one paste.
 *
 * `outlook` and `office365` share a vendor and a client id but not an
 * authority. Personal Outlook/Hotmail/Live accounts live in `consumers`;
 * Microsoft 365 work and school accounts live in `organizations`. `common`
 * would accept both, and is the wrong choice here precisely because it accepts
 * both: someone picking "Outlook / Hotmail" and signing in with their work
 * account would get a grant against the wrong directory, and the failure would
 * arrive later as a mailbox that will not open.
 */
export const OAUTH_PROVIDERS: OAuthProvider[] = [
  {
    presetId: 'gmail',
    vendor: 'google',
    authorizeUrl: GOOGLE_AUTHORIZE_ENDPOINT,
    tokenUrl: GOOGLE_TOKEN_ENDPOINT,
    scopes: GOOGLE_SCOPES,
    extraAuthParams: GOOGLE_AUTH_PARAMS,
    loopbackHost: '127.0.0.1',
  },
  {
    presetId: 'outlook',
    vendor: 'microsoft',
    ...microsoftEndpoints('consumers'),
    scopes: MICROSOFT_SCOPES,
    loopbackHost: '127.0.0.1',
  },
  {
    presetId: 'office365',
    vendor: 'microsoft',
    ...microsoftEndpoints('organizations'),
    scopes: MICROSOFT_SCOPES,
    loopbackHost: '127.0.0.1',
  },
]

export function oauthProviderFor(presetId: string | undefined): OAuthProvider | undefined {
  if (!presetId) return undefined
  return OAUTH_PROVIDERS.find((p) => p.presetId === presetId)
}

/** True when this mail preset has a consent flow at all. */
export function supportsOAuth(presetId: string | undefined): boolean {
  return oauthProviderFor(presetId) !== undefined
}

/**
 * True when a password cannot work for this preset any more, whatever the user
 * types.
 *
 * Only personal Microsoft accounts, and only because the withdrawal date has
 * passed. Work accounts (`office365`) still accept a password for SMTP
 * submission when an administrator has enabled Authenticated SMTP, so telling
 * that user their password is useless would be wrong. Gmail still issues app
 * passwords. The list is expected to grow; each entry should be a date that has
 * gone by, not a date that is coming.
 */
export function requiresOAuth(presetId: string | undefined): boolean {
  return presetId === 'outlook'
}

/**
 * Vendors whose Android client id must be registered separately, with no
 * falling back to the desktop one.
 *
 * Google issues a client *per platform*, bound to the package name and the
 * signing certificate's SHA-1. A desktop client id sent from the phone is not
 * "probably fine" — Google refuses it, and refuses it at the consent page,
 * after the browser has opened and the user has been asked to trust something.
 * Microsoft is the opposite: one registration serves every platform, so the
 * fallback is not a shortcut there, it is the correct configuration.
 *
 * This set exists because of the specific order the ids arrived in. The desktop
 * Google client was registered first and the Android one had not been created
 * yet — and with a blanket fallback, filling in the desktop id would have
 * *broken* Android sign-in that had until then honestly said "not configured".
 * A half-finished registration must degrade to the app's own clear message, not
 * to a provider error page the user cannot act on.
 */
const ANDROID_CLIENT_REQUIRED: ReadonlySet<OAuthVendor> = new Set<OAuthVendor>(['google'])

/**
 * The registered client id for a provider on this platform, or `''` when nobody
 * has filled one in.
 */
export function oauthClientId(
  provider: OAuthProvider,
  platform: OAuthPlatform = 'desktop',
): string {
  if (platform === 'android') {
    /*
     * Android never resolves to a single id here — which certificate signed
     * the running build is a fact only the APK holds. What this answers is the
     * question every *caller* on this side actually has: "is sign-in
     * configured at all", which is what `oauthState` and the account dialog
     * turn into a button or an explanation. The real selection happens in Java
     * from the map `androidClientIds` hands over.
     *
     * The non-empty string is the vendor's first registered id, so callers
     * that only test truthiness behave correctly and callers that use the
     * value get something real rather than a sentinel that would eventually be
     * sent to a provider.
     */
    const registered = Object.values(androidClientIds(provider.vendor))
    if (registered.length) return registered[0]
    if (ANDROID_CLIENT_REQUIRED.has(provider.vendor)) return ''
  }
  return (OAUTH_CLIENT_IDS[provider.vendor] ?? '').trim()
}

// ---------------------------------------------------------------------------
// What the UI needs to know
// ---------------------------------------------------------------------------

/**
 * The five states an OAuth account can be in, kept apart because four of them
 * have different fixes and one of them is not a problem.
 *
 * `unsupported`  — this provider has no consent flow; use a password.
 * `unconfigured` — no client id in this build. Nothing the *user* can fix.
 * `disconnected` — configured, but nobody has signed in yet.
 * `connected`    — there is a refresh token and it worked the last time it was used.
 * `needsConsent` — there *is* a refresh token and the provider has rejected it.
 *
 * The last one is the reason this type exists rather than a boolean. A revoked
 * or expired refresh token looks exactly like a stored working one from the
 * outside: `hasSecret` is true, validation passes, preflight is happy, and the
 * first thing that goes wrong is a scheduled send at an hour nobody is watching.
 * Naming the state is what lets it be reported before the send instead of after.
 */
export type OAuthConnectionState =
  | 'unsupported'
  | 'unconfigured'
  | 'disconnected'
  | 'connected'
  | 'needsConsent'

export interface OAuthAccountStatus {
  state: OAuthConnectionState
  /**
   * The mailbox the grant is for, as the provider named it. Absent when nothing
   * is connected, and absent for a grant made by a build that did not ask for
   * the `email` scope — in which case the dialog falls back to the address in
   * the form, which is what it had before.
   */
  address?: string
}

/** Everything a completed consent hands back to the renderer. Note what is absent: the token. */
export interface OAuthConsentResult {
  ok: boolean
  /** The mailbox that was actually signed into, which is not always the one typed. */
  address?: string
  /** Present only on failure. Already a sentence; never a raw provider blob. */
  error?: string
  /** True when the user closed the browser or pressed "cancel" — not an error to shout about. */
  cancelled?: boolean
}

/**
 * The state to report for an account, from facts the caller already has.
 *
 * Deliberately takes booleans rather than a `MailAccount`: the account dialog
 * asks this about a form that has not been saved yet, and the preflight asks it
 * about a stored one, and neither should have to build the other's shape.
 */
/**
 * The part of the state that can be worked out from the build alone.
 *
 * `unsupported` and `unconfigured` are facts about this executable — a preset
 * with no consent flow, or a client id nobody filled in — and are true before
 * any keystore is consulted. Everything else needs to know whether a grant is
 * stored, which only the trusted layer can answer.
 *
 * The distinction earns its own function because of what the alternative costs.
 * `validateAccount` and `buildPreflight` are pure and synchronous by design;
 * without this they would either have to grow an async keystore call or guess,
 * and a guess here means blocking a send for an account that works perfectly —
 * which is a worse failure than the one this whole file exists to prevent.
 * Returns `undefined` for "ask something that can read the store".
 */
export function oauthConfigProblem(
  presetId: string | undefined,
  platform: OAuthPlatform = 'desktop',
): 'unsupported' | 'unconfigured' | undefined {
  const provider = oauthProviderFor(presetId)
  if (!provider) return 'unsupported'
  if (!oauthClientId(provider, platform)) return 'unconfigured'
  return undefined
}

export function oauthState(
  presetId: string | undefined,
  hasRefreshToken: boolean,
  rejected: boolean,
  platform: OAuthPlatform = 'desktop',
): OAuthConnectionState {
  const provider = oauthProviderFor(presetId)
  if (!provider) return 'unsupported'
  if (!oauthClientId(provider, platform)) return 'unconfigured'
  if (!hasRefreshToken) return 'disconnected'
  return rejected ? 'needsConsent' : 'connected'
}

// ---------------------------------------------------------------------------
// PKCE and the authorization request
// ---------------------------------------------------------------------------

/**
 * Base64url without padding, which is what RFC 7636 asks for and what every
 * provider here rejects the padded form of.
 */
function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A high-entropy random string, for the `code_verifier` and for `state`.
 *
 * 32 bytes rather than the RFC's 43-character minimum expressed as characters:
 * 256 bits through base64url comes out at 43 characters, which satisfies the
 * length rule by construction instead of by counting.
 */
export function randomUrlSafeToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buffer)
  return base64Url(buffer)
}

export interface PkcePair {
  /** Never leaves this process. Sent only on the token exchange. */
  verifier: string
  /** The SHA-256 of the verifier, which is the only half the browser sees. */
  challenge: string
}

/**
 * S256 only. `plain` is still in RFC 7636 and is worth nothing here — it sends
 * the verifier through the browser, which is the exact thing the challenge
 * exists to avoid — so it is not offered, not even as a fallback for a provider
 * that dislikes S256. Both providers here require S256 anyway.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlSafeToken(32)
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

/** The loopback address the provider will redirect back to, once a port is known. */
export function loopbackRedirectUri(provider: OAuthProvider, port: number): string {
  return `http://${provider.loopbackHost}:${port}/oauth/callback`
}

/**
 * The consent page URL.
 *
 * `login_hint` is a convenience and nothing more — it pre-fills the account
 * picker with the address already typed into the dialog. The user can sign in
 * as somebody else, which is why the flow reads the address back out of the
 * token response rather than assuming this one was honoured.
 */
export function buildAuthorizeUrl(options: {
  provider: OAuthProvider
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  loginHint?: string
}): string {
  const url = new URL(options.provider.authorizeUrl)
  const params = url.searchParams
  params.set('client_id', options.clientId)
  params.set('response_type', 'code')
  params.set('redirect_uri', options.redirectUri)
  params.set('scope', options.provider.scopes.join(' '))
  params.set('code_challenge', options.challenge)
  params.set('code_challenge_method', 'S256')
  params.set('state', options.state)
  if (options.loginHint) params.set('login_hint', options.loginHint)
  for (const [key, value] of Object.entries(options.provider.extraAuthParams ?? {})) {
    params.set(key, value)
  }
  return url.toString()
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

/**
 * Renew this many milliseconds before the provider's own expiry.
 *
 * An access token that is valid for four more seconds is not usable: an SMTP
 * session takes a DNS lookup, a TCP handshake, a TLS handshake and an EHLO
 * before it authenticates, and a token that dies in the middle of that produces
 * an authentication failure indistinguishable from a wrong password.
 */
export const OAUTH_EXPIRY_SKEW_MS = 120_000

export interface TokenSet {
  accessToken: string
  /**
   * Present on the first exchange, and present again on every refresh for
   * providers that rotate. Absent means "keep the one you have" — see
   * `electron/oauth.ts`, where getting this wrong would throw away a working
   * grant on the first renewal.
   */
  refreshToken?: string
  /** Absolute epoch ms, already resolved from the relative `expires_in`. */
  expiresAt: number
  /** Only ever read locally, and only to name the mailbox. See `addressFromIdToken`. */
  idToken?: string
}

/**
 * The form body for exchanging an authorization code.
 *
 * No `client_secret`. A public client does not have one, and sending an empty
 * string is worse than sending nothing — Google reads it as a malformed
 * confidential-client request and answers `invalid_client`.
 */
export function codeExchangeBody(options: {
  clientId: string
  code: string
  verifier: string
  redirectUri: string
}): URLSearchParams {
  return new URLSearchParams({
    client_id: options.clientId,
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.verifier,
    redirect_uri: options.redirectUri,
  })
}

/**
 * The form body for minting a fresh access token.
 *
 * `scope` is deliberately not repeated. Both vendors return the originally
 * granted scopes, and re-sending a list that has drifted since the grant was
 * made is how a refresh turns into an `invalid_scope` on an account that was
 * working yesterday.
 */
export function refreshBody(options: {
  clientId: string
  refreshToken: string
}): URLSearchParams {
  return new URLSearchParams({
    client_id: options.clientId,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  })
}

/**
 * Turn a token endpoint's JSON into a `TokenSet`, or throw something a person
 * can read.
 *
 * The `error` branch matters as much as the success branch. Both vendors answer
 * a dead refresh token with HTTP 400 and `{"error":"invalid_grant"}`, and
 * `invalid_grant` is the single fact this whole file exists to surface: it means
 * re-consent, not retry, and every layer above needs to be able to tell it apart
 * from a network blip that a retry would fix.
 */
export function parseTokenResponse(raw: unknown, now = Date.now()): TokenSet {
  if (!raw || typeof raw !== 'object') throw new Error('The sign-in server sent an unreadable reply')
  const body = raw as Record<string, unknown>

  if (typeof body.error === 'string') {
    const description =
      typeof body.error_description === 'string' ? body.error_description : body.error
    const error = new Error(description) as Error & { oauthError?: string }
    error.oauthError = body.error
    throw error
  }

  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (!accessToken) throw new Error('The sign-in server did not return an access token')

  // `expires_in` is optional in RFC 6749 and both vendors send it. An hour is
  // the value both use, and it is the right guess when it is missing: too short
  // costs one extra refresh, too long costs a failed send.
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600

  return {
    accessToken,
    ...(typeof body.refresh_token === 'string' && body.refresh_token
      ? { refreshToken: body.refresh_token }
      : {}),
    expiresAt: now + expiresIn * 1000,
    ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {}),
  }
}

/** True when the provider said the refresh token is dead rather than that it is busy. */
export function isInvalidGrant(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const tagged = error as { oauthError?: unknown; message?: unknown }
  if (typeof tagged.oauthError === 'string') {
    const code = tagged.oauthError.toLowerCase()
    return code === 'invalid_grant' || code === 'invalid_request' || code === 'unauthorized_client'
  }
  return typeof tagged.message === 'string' && /invalid_grant/i.test(tagged.message)
}

/**
 * The mailbox address out of an OpenID Connect id token.
 *
 * **This is not treated as a security token and it is not verified.** No
 * signature check, no issuer check, no audience check — and none is needed for
 * what it is used for, which is putting "connected as name@example.com" on a
 * label. The token arrived over TLS as the direct response to a request this
 * process made to the provider's own token endpoint; there is no third party in
 * that exchange to have forged it. If it is ever used for anything that grants
 * access, that changes and this comment stops being true.
 *
 * Returns `undefined` rather than throwing on anything unexpected. A label is
 * not worth failing a completed sign-in over.
 */
export function addressFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined
  const segments = idToken.split('.')
  if (segments.length < 2) return undefined
  try {
    const padded = segments[1].replace(/-/g, '+').replace(/_/g, '/')
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(
            atob(padded)
              .split('')
              .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
              .join(''),
          )
        : Buffer.from(padded, 'base64').toString('utf8')
    const claims = JSON.parse(json) as Record<string, unknown>
    // Google puts it in `email`. Microsoft puts a personal account's address in
    // `email` too, but a work account's in `preferred_username` — and only
    // sometimes in both, which is why the order matters rather than the choice.
    for (const claim of ['email', 'preferred_username', 'upn']) {
      const value = claims[claim]
      if (typeof value === 'string' && value.includes('@')) return value
    }
  } catch {
    /* an unparseable label is not a failure worth reporting */
  }
  return undefined
}
