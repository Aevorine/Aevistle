/**
 * Long-lived IMAP connections that wait for the server to speak first.
 *
 * Polling every few minutes is a compromise: check often and you burn
 * connections against a provider's rate limit for nothing, check rarely and a
 * verification code — the whole point of the inbox — shows up after it has
 * expired. IDLE removes the tradeoff. The server holds the connection open and
 * announces new mail the moment it lands, so the interval can stay long and
 * still be beaten by seconds.
 *
 * What this file deliberately does *not* do is fetch anything. A watcher's
 * only output is "account X has something new"; the renderer answers that by
 * running its normal sync through `imap.ts`. Keeping the fetch path single
 * means push and poll cannot drift into two subtly different behaviours, and
 * this file stays small enough to reason about while holding open sockets.
 *
 * Relationship to polling: the timer in `AppState` stays on regardless. A
 * dropped connection, a provider that does not advertise IDLE, a laptop that
 * slept through the reconnect — all of them end with the poll catching up. The
 * push path is an optimisation over a working fallback, never the only way
 * mail arrives.
 */

import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import type { InboxAccountState } from '../src/core/types'
import { endpointLadder, rungBudgetMs, totalBudgetMs, withDeadline } from '../src/core/mail/transport'
import { classifyError } from '../src/core/platform/bridge'
import { resolveHostCached } from './mailer'
import { isAuthFailure } from './imap'
import { accessTokenForAccount, noteOAuthAuthFailure } from './oauth'

const INBOX_PATH = 'INBOX'

/**
 * How long to wait before reconnecting, doubling each consecutive failure.
 *
 * The ceiling matters more than the floor: an account with a wrong password
 * retries forever, and without a cap that becomes a login attempt every few
 * seconds until the provider locks it.
 */
const BACKOFF_MIN_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000

/**
 * Recycle the connection well inside the RFC 2177 29-minute limit.
 *
 * imapflow renews IDLE on its own, but a connection that has been up for
 * hours behind a NAT or a proxy can be half-dead in a way neither end has
 * noticed. Reconnecting on a timer costs one handshake and removes a class of
 * "it stopped working overnight" bug that is near-impossible to reproduce.
 */
const RECYCLE_MS = 20 * 60_000

type MailHandler = (accountId: string) => void

/**
 * Identity of a watcher's *connection settings* — a change means reconnect.
 *
 * Includes a hash of the secret itself, not just which account it belongs to:
 * without this, editing a password left the key unchanged, so `watchInboxes`
 * saw an account it already had a watcher for and kept the old connection
 * running — authenticated with the password that was just replaced — until it
 * happened to drop and reconnect on its own. Push silently kept working off a
 * credential the user believed they had rotated out. Hashed rather than
 * embedded plainly so the password itself never sits in a Map key in memory.
 *
 * An OAuth2 account has no password to hash — `secret` is `''` for those, by
 * construction in `watchInboxes` below — so `oauthAccount` is folded into the
 * key too. Without it, switching an account from a password to a connected
 * OAuth2 grant (both with the box otherwise unchanged) would hash to the same
 * key as the account's earlier, password-less "not configured yet" state and
 * never reconnect to pick up the grant.
 */
function connectionKey(config: InboxAccountState, secret: string, oauthAccount: boolean): string {
  return [
    config.accountId,
    config.imapHost,
    config.imapPort,
    config.imapSecurity,
    config.imapUsername,
    config.imapAllowInvalidCert ? '1' : '0',
    oauthAccount ? 'oauth' : 'password',
    createHash('sha256').update(secret).digest('hex'),
  ].join('|')
}

class Watcher {
  private client: ImapFlow | null = null
  private stopped = false
  private failures = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private recycleTimer: NodeJS.Timeout | null = null

  constructor(
    readonly key: string,
    private readonly config: InboxAccountState,
    private readonly secret: string,
    private readonly onMail: MailHandler,
  ) {
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.recycleTimer) clearTimeout(this.recycleTimer)
    this.reconnectTimer = null
    this.recycleTimer = null
    const client = this.client
    this.client = null
    if (client) {
      // `logout` is the polite close but waits for the server; a watcher being
      // torn down (quit, config change) should not block on that.
      client.logout().catch(() => {
        try {
          client.close()
        } catch {
          /* already gone */
        }
      })
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** this.failures, BACKOFF_MAX_MS)
    this.failures++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return

    const ladder = endpointLadder(this.config.imapPort, this.config.imapSecurity, true)
    const budget = totalBudgetMs(30)
    const perRung = rungBudgetMs(budget, ladder.length)

    let host: string
    try {
      host = await resolveHostCached(this.config.imapHost, Math.min(budget / 2, 8_000))
    } catch {
      this.scheduleReconnect()
      return
    }

    /*
     * An XOAUTH2 bearer token, when this account signed in with OAuth2.
     *
     * Resolved once per connection attempt, the same point `imap.ts`'s
     * `withConnection` resolves it for the polling path — reused rather than
     * reimplemented, because a second, subtly different way to mint a token
     * is exactly the kind of drift that made push silently skip these
     * accounts in the first place. `accessTokenForAccount` answers `null` for
     * every password account, which keeps this a no-op on that path.
     */
    const accessToken = await accessTokenForAccount(this.config.accountId)

    for (const endpoint of ladder) {
      if (this.stopped) return

      const client = new ImapFlow({
        host,
        port: endpoint.port,
        secure: endpoint.security === 'ssl',
        ...(endpoint.security === 'starttls' ? { doSTARTTLS: true } : {}),
        // The connection target is a pre-resolved IP; identity is still
        // checked against the real hostname. See mailer.ts on why.
        servername: this.config.imapHost,
        // Same choice `imap.ts`'s `buildClient` makes: a bearer token wins
        // over a stored password when both are somehow present, because a
        // signed-in OAuth2 account has no real password to fall back to —
        // `this.secret` is `''` for those, by construction in `watchInboxes`.
        auth: accessToken
          ? { user: this.config.imapUsername, accessToken }
          : { user: this.config.imapUsername, pass: this.secret },
        tls: { rejectUnauthorized: !this.config.imapAllowInvalidCert, minVersion: 'TLSv1.2' },
        logger: false,
        // The one place in this codebase that wants imapflow's own IDLE loop.
        disableAutoIdle: false,
        connectionTimeout: Math.min(perRung, 10_000),
        greetingTimeout: Math.min(perRung, 10_000),
        // Must outlast an idle stretch: with IDLE the socket is quiet by
        // design, and a short socket timeout would read that as a hang.
        socketTimeout: RECYCLE_MS + 60_000,
      })

      /*
       * Before `connect()`, not after the handshake succeeds.
       *
       * `ImapFlow` is an EventEmitter, and an EventEmitter that emits `'error'`
       * with no listener does not return the error — it throws it, out of
       * whatever turn of the event loop the socket died in, past the try/catch
       * around the call in flight and into `process.on('uncaughtException')`.
       * There it became a modal reading "Aevistle hit an unexpected problem —
       * read ECONNRESET" over an app in which nothing had gone wrong.
       *
       * The `drop` handler below cannot serve here: it reconnects, and it must
       * not run until there is a connection worth replacing. So the window from
       * construction until then gets a listener whose whole job is to stop the
       * throw — `connect()` and `mailboxOpen()` already reject on failure and
       * the `catch` below already handles that.
       */
      const swallowEarly = (err: unknown) => {
        console.error(
          '[aevistle] IMAP idle connection failed while opening:',
          err instanceof Error ? err.message : err,
        )
      }
      client.on('error', swallowEarly)

      let connected = false
      try {
        await withDeadline(() => client.connect(), perRung, () => client.close())
        connected = true
        if (this.stopped) {
          client.close()
          return
        }

        await client.mailboxOpen(INBOX_PATH, { readOnly: true })

        // `exists` fires whenever the server announces a new count. It also
        // fires on a count *decrease* (someone deleted mail elsewhere), which
        // is equally worth a resync — the list on screen is wrong either way.
        client.on('exists', () => {
          if (!this.stopped) this.onMail(this.config.accountId)
        })

        const drop = () => {
          if (this.stopped || this.client !== client) return
          this.client = null
          this.scheduleReconnect()
        }
        client.on('close', drop)
        // The early listener stays attached — removing it would reopen the
        // window it exists to close if `drop` ever stops being registered.
        client.on('error', drop)

        this.client = client
        this.failures = 0

        this.recycleTimer = setTimeout(() => {
          if (this.stopped || this.client !== client) return
          this.client = null
          client.logout().catch(() => {})
          // A deliberate recycle is not a failure, so it reconnects at once
          // rather than paying the backoff.
          this.failures = 0
          void this.connect()
        }, RECYCLE_MS)

        return
      } catch (e) {
        try {
          client.close()
        } catch {
          /* already gone */
        }
        /*
         * A refused bearer token, not a network hiccup. Same duck-typed check
         * `imap.ts` uses on the polling path, imported rather than
         * reimplemented — see that function's own comment for why it is not
         * an `instanceof`.
         *
         * Invalidating here is what makes the *next* reconnect attempt worth
         * making: `accessTokenForAccount` will mint a fresh token instead of
         * re-offering the one that was just refused. Without it, a watcher
         * would retry the same dead token every backoff interval and never
         * recover on its own — silently, since nothing surfaces a watcher's
         * failures to the UI (see `oauthStatusFor`/the account dialog for
         * where a refused grant is actually reported to the user).
         */
        const err = e instanceof Error ? e : new Error(String(e))
        const refusedCredentials =
          isAuthFailure(err) || (connected && classifyError(err.message) === 'auth')
        if (refusedCredentials && accessToken) {
          noteOAuthAuthFailure(this.config.accountId)
          // Every other rung would fail on the same credentials — trying them
          // only spends time and, on some providers, a lockout budget.
          break
        }
      }
    }

    this.scheduleReconnect()
  }
}

const watchers = new Map<string, Watcher>()

/**
 * Reconcile the running watchers against the accounts that want one.
 *
 * Called on every save and on startup, so it must be cheap and idempotent for
 * the common case where nothing changed: an account whose connection settings
 * are identical keeps its existing connection rather than being torn down and
 * rebuilt, which would drop the socket every time the user edited anything.
 */
export function watchInboxes(
  configs: Array<{
    config: InboxAccountState
    secret: string | null
    /**
     * True when this account has no stored IMAP password but does have an
     * OAuth2 grant — `electron/main.ts` resolves this from the same
     * `hasOAuthGrant` check `imap.ts`'s polling path uses, since the caller
     * is already in an async context and this function is not.
     *
     * Without it, an account that signed in with Gmail one-click had
     * `secret: null` and was filtered out below exactly like an account with
     * no credential at all — the bug this parameter exists to close: push
     * silently skipped every OAuth2 account and fell back to the slower
     * polling path with nothing in the UI saying so.
     */
    oauthAccount?: boolean
  }>,
  onMail: MailHandler,
): void {
  const wanted = new Map<
    string,
    { config: InboxAccountState; secret: string; oauthAccount: boolean }
  >()
  for (const { config, secret, oauthAccount } of configs) {
    const eligible = Boolean(secret) || Boolean(oauthAccount)
    if (!config.enabled || !eligible || !config.imapHost || !config.imapUsername) continue
    wanted.set(connectionKey(config, secret ?? '', Boolean(oauthAccount)), {
      config,
      secret: secret ?? '',
      oauthAccount: Boolean(oauthAccount),
    })
  }

  for (const [key, watcher] of watchers) {
    if (!wanted.has(key)) {
      watcher.stop()
      watchers.delete(key)
    }
  }

  for (const [key, { config, secret }] of wanted) {
    if (watchers.has(key)) continue
    watchers.set(key, new Watcher(key, config, secret, onMail))
  }
}

/** Drop every connection — called on quit so sockets do not outlive the app. */
export function stopAllInboxWatchers(): void {
  for (const watcher of watchers.values()) watcher.stop()
  watchers.clear()
}
