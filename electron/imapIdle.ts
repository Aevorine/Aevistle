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

import { ImapFlow } from 'imapflow'
import type { InboxAccountState } from '../src/core/types'
import { endpointLadder, rungBudgetMs, totalBudgetMs, withDeadline } from '../src/core/transport'
import { resolveHostCached } from './mailer'

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

/** Identity of a watcher's *connection settings* — a change means reconnect. */
function connectionKey(config: InboxAccountState): string {
  return [
    config.accountId,
    config.imapHost,
    config.imapPort,
    config.imapSecurity,
    config.imapUsername,
    config.imapAllowInvalidCert ? '1' : '0',
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
        auth: { user: this.config.imapUsername, pass: this.secret },
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

      try {
        await withDeadline(() => client.connect(), perRung, () => client.close())
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
      } catch {
        try {
          client.close()
        } catch {
          /* already gone */
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
  configs: Array<{ config: InboxAccountState; secret: string | null }>,
  onMail: MailHandler,
): void {
  const wanted = new Map<string, { config: InboxAccountState; secret: string }>()
  for (const { config, secret } of configs) {
    if (!config.enabled || !secret || !config.imapHost || !config.imapUsername) continue
    wanted.set(connectionKey(config), { config, secret })
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
