/**
 * The desktop half of OAuth2 — the loopback consent flow, and the access
 * tokens that come out of it.
 *
 * `src/core/oauth.ts` holds everything that is only string building and maths.
 * This file is the part that needs an operating system: a socket to catch the
 * redirect on, a browser to send the user to, and a keystore to leave the
 * refresh token in.
 *
 * ---------------------------------------------------------------------------
 * Why a loopback listener rather than a custom scheme
 * ---------------------------------------------------------------------------
 * The two redirect styles RFC 8252 allows for a native app are a private-use
 * URI scheme (`dev.aevistle.app://…`) and a loopback address. The scheme route
 * means registering a protocol handler with the OS — `setAsDefaultProtocolClient`
 * plus `app.on('open-url')` plus, on Windows, a second-instance dance to get the
 * URL into the process that is already running. It also means any other program
 * on the machine can register the same scheme and win, which is the interception
 * PKCE exists to survive but which still produces a sign-in that silently goes
 * to somebody else's window.
 *
 * A loopback listener has none of that. The port is assigned by the OS at the
 * moment of use, nothing is registered anywhere, and a competing program cannot
 * take a port that is already bound. It is also the only one of the two that
 * this application can offer without adding a protocol registration to an
 * installer that deliberately does not have one.
 *
 * ---------------------------------------------------------------------------
 * What is held where
 * ---------------------------------------------------------------------------
 * The **refresh token** goes straight into the same `safeStorage`-backed store
 * as every mail password (`electron/store.ts`), under a namespaced key. It never
 * travels to the renderer — the account dialog gets back an address and a
 * boolean, exactly the way `sealAccountSecrets` hands back an envelope rather
 * than a password.
 *
 * **Access tokens** are held in the module-level map below and nowhere else.
 * Writing them to disk would buy nothing — they last about an hour — while
 * widening what a copied data folder is worth. This map dies with the process,
 * which is the correct lifetime for a bearer token.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import {
  addressFromIdToken,
  buildAuthorizeUrl,
  codeExchangeBody,
  createPkcePair,
  isInvalidGrant,
  loopbackRedirectUri,
  oauthClientId,
  oauthProviderFor,
  oauthState,
  parseTokenResponse,
  randomUrlSafeToken,
  refreshBody,
  OAUTH_EXPIRY_SKEW_MS,
  type OAuthAccountStatus,
  type OAuthConsentResult,
  type OAuthProvider,
  type TokenSet,
} from '../src/core/oauth'

// ---------------------------------------------------------------------------
// Where the refresh token lives
// ---------------------------------------------------------------------------

/**
 * The keystore entry an account's refresh token is written under.
 *
 * `:oauth` rather than reusing the bare `accountId` (the SMTP password's key)
 * or `:imap`, for the reason `SecretKind` gives for splitting those two: one
 * mailbox can legitimately hold more than one kind of credential, and a shared
 * key means enabling one silently destroys the other. An account that used a
 * password and is being moved to OAuth2 keeps its old password entry until
 * something deletes it, which is what makes switching back a matter of changing
 * a dropdown rather than re-typing.
 *
 * It is a *derived account id* passed to the existing `getSecret`/`setSecret`
 * with the default `'smtp'` kind, rather than a fourth `SecretKind`. That is a
 * deliberate trade: `SecretKind` is declared in `src/core/types.ts` and mirrored
 * in Android's `SecretStore.java`, and widening a cross-platform enum to add one
 * desktop key would be a larger change than the feature warrants. The resulting
 * key — `<accountId>:oauth` — is exactly the shape `secretKey()` already
 * produces for `:imap`, so nothing in the store has to learn anything new.
 *
 * One consequence, stated rather than left to be found: `sealAccountSecrets`
 * enumerates `smtp` and `imap` for each account id, so a refresh token is **not**
 * carried to a paired device. That is the conservative answer and the one that
 * needs no change to `core/secretTransport.ts`'s wire format — the phone runs
 * its own consent, against its own redirect, and gets its own grant.
 */
export function oauthSecretRef(accountId: string): string {
  return `${accountId}:oauth`
}

/**
 * The entry recording *which* provider an account's grant was made against.
 *
 * This is not a secret and it is in the credential store anyway, which wants
 * justifying. A refresh token can only be renewed at the endpoint that issued
 * it — `consumers` and `organizations` are two different Microsoft authorities
 * and a token from one is rejected by the other — so the token is useless
 * without knowing which one it came from, and the two facts have to be stored
 * together or they can drift apart.
 *
 * The alternative was `state.json`, and that is the wrong file. The receiving
 * path reaches this module through `InboxAccountState`, which carries an
 * `accountId` and no provider; and the *scheduler* fires with no window open,
 * so anything living in renderer-owned state is unavailable at exactly the
 * moment a 03:00 send needs it. The keystore is the one store both transports
 * can read without a renderer. Encrypting a provider id costs nothing and keeps
 * the pair inseparable — deleting one deletes the other.
 */
function oauthProviderRef(accountId: string): string {
  return `${accountId}:oauth-provider`
}

/**
 * The keystore, injected rather than imported.
 *
 * `electron/store.ts` imports `electron`, and this module is reached from
 * `mailer.ts` and `imap.ts` — both of which are bundled standalone by
 * `scripts/check-socket-drop.mjs` with `electron` marked external. Importing the
 * store here would drag a stub `require('electron')` into that bundle for no
 * reason. A three-method seam registered once from `main.ts` keeps this file's
 * dependency list to `node:http` and `node:crypto`, and has the pleasant side
 * effect that an unregistered store degrades to "no OAuth accounts" instead of
 * throwing.
 */
export interface OAuthSecretStore {
  read(ref: string): Promise<string | null>
  write(ref: string, secret: string): Promise<void>
  clear(ref: string): Promise<void>
}

let secretStore: OAuthSecretStore | null = null

export function useOAuthSecretStore(store: OAuthSecretStore): void {
  secretStore = store
}

// ---------------------------------------------------------------------------
// Access tokens, in memory only
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string
  /** Absolute epoch ms, as the provider stated it. The skew is applied on read. */
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

/**
 * Accounts whose refresh token the provider has rejected.
 *
 * The whole point of `preflight.ts:146` growing a notion of "credential present
 * but stale" is that this state is otherwise invisible: `hasSecret` says yes,
 * validation passes, and the first symptom is a send that failed overnight. A
 * rejection is recorded here the moment the token endpoint says `invalid_grant`,
 * and cleared the moment a new grant is stored.
 *
 * In memory rather than on disk deliberately. A revoked grant is a fact about
 * the provider, not about this machine, and re-checking it costs one token
 * request on the next send — whereas a stale *persisted* "needs re-consent" flag
 * would keep telling a user to reconnect an account that already works.
 */
const rejected = new Set<string>()

/**
 * Refreshes in flight, so a burst of sends against one account does not fire
 * one token request per message. Two sends starting in the same tick both find
 * an expired token, and without this both would race to replace it — spending
 * the provider's rate limit and, on a vendor that rotates refresh tokens,
 * invalidating each other's brand new one.
 */
const inFlight = new Map<string, Promise<string | null>>()

/** Forget an account's cached token — after a re-consent, a disconnect, or an auth failure. */
export function invalidateOAuthToken(accountId: string): void {
  tokenCache.delete(accountId)
  inFlight.delete(accountId)
}

/**
 * A mail server rejected this account's credentials.
 *
 * Called from the transports rather than inferred here, because only they can
 * tell "the token was refused" from "the connection failed". The next use will
 * mint a fresh token; if that also fails the grant is marked as needing consent
 * and stays that way until somebody re-runs it.
 */
export function noteOAuthAuthFailure(accountId: string): void {
  invalidateOAuthToken(accountId)
}

/** Drop everything held for an account. Called when it is deleted or switched back to a password. */
export async function forgetOAuthAccount(accountId: string): Promise<void> {
  invalidateOAuthToken(accountId)
  rejected.delete(accountId)
  await secretStore?.clear(oauthSecretRef(accountId)).catch(() => {})
  await secretStore?.clear(oauthProviderRef(accountId)).catch(() => {})
}

/**
 * The provider a grant was made against.
 *
 * `presetId` wins when the caller has one — the account dialog and the SMTP
 * path both do, and trusting the live account is what makes changing the
 * provider dropdown take effect. The stored value is the fallback for the
 * receiving path, which only ever holds an `InboxAccountState`.
 */
async function resolvePresetId(
  accountId: string,
  presetId: string | undefined,
): Promise<string | undefined> {
  if (presetId) return presetId
  return (await secretStore?.read(oauthProviderRef(accountId))) ?? undefined
}

/**
 * Whether this account has completed a consent at some point.
 *
 * The cheap question, and the one the receiving path needs *before* it decides
 * it has no credential. Every `if (!secret)` guard in `imap.ts` predates OAuth2
 * and would otherwise refuse an account that has a perfectly good grant and no
 * password — the "no password stored for receiving" message on a mailbox that
 * was never going to have one. Says nothing about whether the grant still
 * works; that is `oauthStatusFor`'s job and it costs a network round trip.
 */
export async function hasOAuthGrant(accountId: string): Promise<boolean> {
  if (!secretStore) return false
  return Boolean(await secretStore.read(oauthSecretRef(accountId)))
}

/** What the account dialog and preflight should say about this account right now. */
export async function oauthStatusFor(
  accountId: string,
  presetId: string | undefined,
): Promise<OAuthAccountStatus> {
  const stored = secretStore ? await secretStore.read(oauthSecretRef(accountId)) : null
  return { state: oauthState(presetId, Boolean(stored), rejected.has(accountId)) }
}

// ---------------------------------------------------------------------------
// Talking to the token endpoint
// ---------------------------------------------------------------------------

/** Long enough for a slow link, short enough that a send does not hang on it. */
const TOKEN_REQUEST_TIMEOUT_MS = 20_000

/**
 * POST a form to a token endpoint and parse the answer.
 *
 * `parseTokenResponse` is given the body whether the status was 2xx or not:
 * both vendors return their machine-readable `{"error":"invalid_grant"}` with a
 * 400, and reading the status first would throw away the one field that decides
 * whether re-consent is needed.
 */
async function postToken(url: string, body: URLSearchParams): Promise<TokenSet> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`The sign-in server answered ${response.status} with an unreadable body`)
  }
  return parseTokenResponse(parsed)
}

/**
 * Store whatever the provider handed back, keeping the old refresh token when
 * it handed back none.
 *
 * This is the single most damaging thing to get wrong in a refresh flow.
 * Microsoft rotates: every refresh returns a *new* refresh token and retires the
 * one used, so failing to write it back leaves the account working until the
 * old token's grace period lapses and then dead. Google does not rotate: it
 * returns no `refresh_token` on a refresh at all, so blindly writing what came
 * back would erase a perfectly good grant on the first renewal. Both behaviours
 * are correct for their vendor and both are handled by the same rule — write
 * when there is something to write, keep otherwise.
 */
async function persistTokens(
  accountId: string,
  presetId: string,
  tokens: TokenSet,
): Promise<void> {
  if (tokens.refreshToken) {
    await secretStore?.write(oauthSecretRef(accountId), tokens.refreshToken)
    // Written beside the token every time rather than only on first consent, so
    // an account moved between the two Microsoft presets cannot end up with a
    // `consumers` token filed under `organizations`.
    await secretStore?.write(oauthProviderRef(accountId), presetId)
  }
  tokenCache.set(accountId, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
  rejected.delete(accountId)
}

/**
 * An access token for this account, minted from the stored refresh token if the
 * cached one is gone or nearly gone.
 *
 * Returns `null` rather than throwing for the two "this is not an OAuth
 * account" cases — no provider, no client id, no stored grant — because both
 * transports call this unconditionally and an account that was never connected
 * should fall through to the same "no credential" path a passwordless account
 * takes, not blow up with a stack trace about OAuth.
 *
 * It *does* throw when there is a grant and it could not be turned into a token.
 * That is a real failure with a real fix, and swallowing it would produce an
 * SMTP `AUTH` with no credential and a server error about the password.
 */
export async function accessTokenForAccount(
  accountId: string,
  presetId?: string,
): Promise<string | null> {
  if (!secretStore) return null

  const cached = tokenCache.get(accountId)
  if (cached && cached.expiresAt - Date.now() > OAUTH_EXPIRY_SKEW_MS) return cached.accessToken

  const pending = inFlight.get(accountId)
  if (pending) return pending

  const run = (async () => {
    const preset = await resolvePresetId(accountId, presetId)
    const provider = oauthProviderFor(preset)
    if (!provider) return null
    const clientId = oauthClientId(provider)
    if (!clientId) return null

    const refreshToken = await secretStore!.read(oauthSecretRef(accountId))
    if (!refreshToken) return null

    try {
      const tokens = await postToken(provider.tokenUrl, refreshBody({ clientId, refreshToken }))
      await persistTokens(accountId, preset!, tokens)
      return tokens.accessToken
    } catch (error) {
      if (isInvalidGrant(error)) {
        // The grant is gone — revoked in the provider's dashboard, expired after
        // six months idle (Google's rule for an unverified app), or invalidated
        // by a password change. Retrying cannot help, and saying "authentication
        // failed" would send the user to reset a password that is not involved.
        rejected.add(accountId)
        tokenCache.delete(accountId)
        throw new Error(
          'This account needs to be reconnected: the mail provider has withdrawn the ' +
            'sign-in Aevistle was using. Open the account and press Reconnect.',
        )
      }
      throw error
    }
  })().finally(() => inFlight.delete(accountId))

  // Registered after the chain is built but before it can settle: the async
  // function suspends on its first `await` (a store read) and `.finally` runs no
  // earlier than the microtask after that, so no join can miss this entry.
  inFlight.set(accountId, run)
  return run
}

// ---------------------------------------------------------------------------
// The consent flow
// ---------------------------------------------------------------------------

/** How long the listener waits for the browser before giving up and closing. */
const CONSENT_TIMEOUT_MS = 5 * 60_000

/** A callback body is a code and a state; nothing legitimate is anywhere near this. */
const MAX_CALLBACK_URL = 8 * 1024

/**
 * The app's own families, named literally, single-quoted because they are
 * written into a double-quoted HTML `style` attribute.
 *
 * The page below renders in the user's default browser, not in the app, so it
 * cannot reach `src/styles/theme.css` — no stylesheet link, no `@font-face`,
 * by design (see `resultPage`). `system-ui` was therefore not "the app's
 * font falling back gracefully"; it was a different typeface entirely, and
 * this is the last screen of a sign-in that starts inside Aevistle.
 *
 * System faces only, for the same reason the message reader's stack is (see
 * `src/components/MessageBodyFrame.tsx`): the bundled "Aevistle Text" family
 * cannot be served here. On Windows that lands on real Times New Roman and
 * real SimSun/宋体 and matches the app closely; anywhere without them it
 * lands on the platform serif, which is a near miss rather than a match.
 */
const RESULT_FONT_STACK =
  "'Times New Roman', Times, 'SimSun', '宋体', 'Songti SC', 'Noto Serif SC', 'Noto Serif CJK SC', serif"

/**
 * The page the browser lands on when it is over.
 *
 * Entirely self-contained — no stylesheet, no script, no image. It is served
 * from a socket this app opened for about four seconds and it has to render
 * correctly with the network already irrelevant. It also has to be honest about
 * failure: a consent that was refused must not show a page that says "you can
 * close this window" while the app sits waiting.
 */
function resultPage(title: string, detail: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  // Longhands rather than the `font:` shorthand: the shorthand cannot carry a
  // family list containing quoted names without also re-stating weight, style
  // and variant, and the h1 below is given an absolute 20px rather than
  // `1.25rem` so the heading rank is the app's own step and not a multiple of
  // whatever default size this particular browser is configured with.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aevistle</title></head>
<body style="font-family:${RESULT_FONT_STACK};font-size:16px;line-height:1.6;margin:0;display:grid;place-items:center;min-height:100vh;background:#14161b;color:#eceef1">
<main style="max-width:32rem;padding:2rem;text-align:center">
<h1 style="font-size:20px;margin:0 0 .75rem">${escape(title)}</h1>
<p style="margin:0;opacity:.8">${escape(detail)}</p>
</main></body></html>`
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

interface CallbackOutcome {
  code?: string
  error?: string
  cancelled?: boolean
}

/**
 * Bind 127.0.0.1 on an OS-assigned port, wait for exactly one callback, and
 * close.
 *
 * Bound to the loopback address and nothing else. This is the property that
 * makes the whole flow safe to run on a laptop in a coffee shop: no interface
 * that anything off this machine can reach is ever listening, so the window in
 * which a socket exists is a window only this machine's own processes can see.
 *
 * The listener is closed on every path out — a callback, a timeout, or a throw
 * — and open keep-alive sockets are destroyed with it, because `server.close()`
 * alone waits for them and would leave the port bound for as long as the
 * browser felt like holding the connection.
 */
async function awaitCallback(
  expectedState: string,
  onListening: (port: number) => Promise<void>,
): Promise<CallbackOutcome> {
  const sockets = new Set<Socket>()
  let server: Server | null = null

  const shutdown = async (): Promise<void> => {
    const closing = server
    server = null
    if (!closing) return
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }

  try {
    return await new Promise<CallbackOutcome>((resolve, reject) => {
      let settled = false
      const finish = (outcome: CallbackOutcome) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }

      const handle = (req: IncomingMessage, res: ServerResponse) => {
        const send = (status: number, html: string) => {
          res.writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            // Nothing here is meant to be read by a page — same posture as
            // `controlServer.ts` and `pairingServer.ts`.
            'x-content-type-options': 'nosniff',
            // The URL carries an authorization code. A referrer header taking it
            // to whatever the result page might link to (it links nowhere, but
            // the guarantee should not depend on that) is a leak for free.
            'referrer-policy': 'no-referrer',
            connection: 'close',
          })
          res.end(html)
        }

        // A callback is a browser navigation, so anything but GET is either a
        // probe or a mistake, and neither should be able to settle the flow.
        if (req.method !== 'GET' || (req.url ?? '').length > MAX_CALLBACK_URL) {
          send(405, resultPage('Not this address', 'Aevistle is not serving anything here.'))
          return
        }

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/oauth/callback') {
          send(404, resultPage('Not this address', 'Aevistle is not serving anything here.'))
          return
        }

        // `state` first, before the code is so much as read. This is the CSRF
        // check: without it, anything able to reach this port could hand the
        // flow an authorization code of its own choosing and have Aevistle
        // exchange it and store the resulting grant — connecting the user's
        // account to somebody else's mailbox.
        const state = url.searchParams.get('state') ?? ''
        if (!timingSafeStringEqual(state, expectedState)) {
          send(
            400,
            resultPage(
              'That sign-in did not match',
              'Aevistle ignored it. Start the sign-in again from the app.',
            ),
          )
          return
        }

        const error = url.searchParams.get('error')
        if (error) {
          const description = url.searchParams.get('error_description') ?? error
          send(
            200,
            resultPage('Sign-in was not completed', 'You can close this tab and go back to Aevistle.'),
          )
          finish({
            error: description,
            cancelled: error === 'access_denied' || error === 'user_cancelled_authorize',
          })
          return
        }

        const code = url.searchParams.get('code') ?? ''
        if (!code) {
          send(400, resultPage('Sign-in was not completed', 'No authorization code arrived.'))
          finish({ error: 'The provider redirected back without an authorization code' })
          return
        }

        send(
          200,
          resultPage('Signed in', 'You can close this tab. Aevistle has what it needs.'),
        )
        finish({ code })
      }

      const listener = createServer(handle)
      listener.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      listener.once('error', reject)
      server = listener

      const timer = setTimeout(() => {
        finish({ cancelled: true, error: 'The sign-in was not completed in time' })
      }, CONSENT_TIMEOUT_MS)
      timer.unref?.()

      // Port 0: the OS picks one. A fixed port would collide with whatever else
      // is running and would be the one thing about this flow another program
      // could predict.
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address()
        const port = typeof address === 'object' && address ? address.port : 0
        if (!port) {
          finish({ error: 'Could not open a local port to complete the sign-in' })
          return
        }
        void onListening(port).catch((e: unknown) => {
          finish({ error: e instanceof Error ? e.message : String(e) })
        })
      })
    })
  } finally {
    await shutdown()
  }
}

export interface ConsentOptions {
  accountId: string
  /** The `ProviderPreset.id` — `gmail`, `outlook` or `office365`. */
  presetId: string
  /** Pre-fills the account picker. Advisory only; the result says who signed in. */
  loginHint?: string
  /** `openExternalSafely` from `main.ts`, passed in so this file needs no `electron` import. */
  openExternal(url: string): Promise<void>
}

/**
 * Run one consent, end to end, and leave the refresh token in the keystore.
 *
 * Never rejects. Every failure comes back as `{ ok: false, error }` with a
 * sentence in it, because the caller is a dialog: an unhandled rejection here
 * would surface as the generic "unexpected problem" modal over an app that is
 * working fine and a sign-in the user merely cancelled.
 */
export async function runConsent(options: ConsentOptions): Promise<OAuthConsentResult> {
  const provider = oauthProviderFor(options.presetId)
  if (!provider) {
    return { ok: false, error: 'This provider does not offer OAuth2 sign-in.' }
  }
  const clientId = oauthClientId(provider)
  if (!clientId) {
    return { ok: false, error: unconfiguredMessage(provider) }
  }
  if (!secretStore) {
    return { ok: false, error: 'The credential store is not available.' }
  }

  try {
    const { verifier, challenge } = await createPkcePair()
    const state = randomUrlSafeToken(32)
    let redirectUri = ''

    const outcome = await awaitCallback(state, async (port) => {
      redirectUri = loopbackRedirectUri(provider, port)
      await options.openExternal(
        buildAuthorizeUrl({
          provider,
          clientId,
          redirectUri,
          challenge,
          state,
          loginHint: options.loginHint,
        }),
      )
    })

    if (outcome.cancelled) return { ok: false, cancelled: true, error: outcome.error }
    if (outcome.error || !outcome.code) {
      return { ok: false, error: outcome.error ?? 'The sign-in did not complete.' }
    }

    const tokens = await postToken(
      provider.tokenUrl,
      codeExchangeBody({ clientId, code: outcome.code, verifier, redirectUri }),
    )

    if (!tokens.refreshToken) {
      // Without one there is nothing to renew from, so the account would work
      // for an hour and then stop — which is worse than refusing now, because
      // the failure would arrive at whatever time the next scheduled send was.
      return {
        ok: false,
        error:
          'The provider signed you in but did not issue a long-lived token, so Aevistle ' +
          'could not keep the connection. Remove Aevistle from your account’s connected ' +
          'apps and try again.',
      }
    }

    await persistTokens(options.accountId, options.presetId, tokens)
    return { ok: true, address: addressFromIdToken(tokens.idToken) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * What to say when nobody filled the client id in.
 *
 * Named rather than inlined because it is the one failure here that is about
 * the *build* and not about the user's account, and a message that sends
 * somebody to check their password over it would waste an afternoon.
 */
function unconfiguredMessage(provider: OAuthProvider): string {
  return (
    `This build of Aevistle has no ${provider.vendor === 'google' ? 'Google' : 'Microsoft'} ` +
    'OAuth client id, so it cannot start a sign-in. Whoever built it needs to register the ' +
    'app and fill in OAUTH_CLIENT_IDS in src/core/oauth.ts.'
  )
}
