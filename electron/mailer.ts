/**
 * SMTP transport for the desktop build.
 *
 * The renderer already validates everything here. It is re-validated anyway:
 * the renderer is the part an attacker would reach first (a crafted template,
 * an imported settings file), and the main process is where a bad header
 * actually turns into bytes on a socket. Defence in depth is cheap when the
 * check is a regular expression.
 *
 * Connection handling is the other half of this file, and it is not the naive
 * version. nodemailer arms its `connectionTimeout` per resolved address, so a
 * host with eight A/AAAA records and an unreachable first address waits eight
 * timeouts before reporting anything. Measured here: smtp.gmail.com:465 with
 * `connectionTimeout: 15000` took 121 seconds to connect, smtp.qq.com:465 took
 * 132 — while the same providers answered on 587/STARTTLS in under 3. So every
 * attempt runs under an explicit budget, and when one endpoint stalls the next
 * rung of the ladder is tried instead of waiting it out.
 */

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { lookup } from 'node:dns/promises'
import path from 'node:path'
import type {
  Attachment,
  MailAccount,
  MessageDraft,
  SendResult,
  TransportDiagnostics,
  TransportSecurity,
} from '../src/core/types'
import { classifyError } from '../src/core/bridge'
import { accessTokenForAccount, noteOAuthAuthFailure } from './oauth'
import {
  endpointLadder,
  formatAttempts,
  isNegotiable,
  renderTransportError,
  rungBudgetMs,
  summarizeTransportError,
  totalBudgetMs,
  withDeadline,
  type AttemptNote,
  type Endpoint,
} from '../src/core/transport'
import { isHeaderSafe, isValidAddress, plainToHtml } from '../src/core/validate'

/** Hard ceiling regardless of settings — beyond this we would run the app out of memory. */
const ABSOLUTE_MAX_BYTES = 200 * 1024 * 1024

/**
 * Resolve the SMTP host through the operating system, not through nodemailer.
 *
 * nodemailer resolves hostnames itself with `dns.resolve4`/`dns.resolve6`,
 * which sends queries straight to the configured nameservers. That path is
 * broken on more machines than you would expect — a DNS-over-HTTPS setup, a
 * VPN that only answers through the system stub, a corporate resolver that
 * drops UDP/53 — and when it breaks it does not fail fast. Measured here:
 * `dns.resolve4('smtp.gmail.com')` took 22 s before giving up and
 * `dns.resolve4('smtp.163.com')` took 28 s, while `net.connect()` to the same
 * hosts, which goes through `getaddrinfo` like every other program on the
 * machine, connected in 53–780 ms.
 *
 * So the address is looked up here and handed over as a literal IP, which
 * makes nodemailer's resolver short-circuit. `tls.servername` still carries the
 * real hostname, so SNI and certificate identity checking are unaffected — the
 * certificate is still validated against `smtp.gmail.com`, never against the
 * address.
 *
 * Returns the hostname unchanged if the lookup fails, leaving the original
 * behaviour as the fallback rather than turning a slow path into a dead one.
 */
async function resolveHost(host: string, timeoutMs: number): Promise<string> {
  try {
    const settled = await Promise.race([
      lookup(host, { all: true, verbatim: false }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (!settled || settled.length === 0) return host
    // `verbatim: false` sorts IPv4 ahead of IPv6, which is the right default
    // for SMTP: providers publish AAAA records that are frequently unreachable
    // from consumer connections, and each dead address costs a full timeout.
    return settled[0].address || host
  } catch {
    return host
  }
}

/**
 * The credential an attempt authenticates with, resolved once per operation.
 *
 * Two fields rather than one string because the two mechanisms are not
 * interchangeable at the point of use: a password is a stored constant, while an
 * access token is minted on demand, expires within the hour, and must not be
 * fetched again per rung of the endpoint ladder. Resolving both up front means
 * the ladder, the warm pool and the fingerprint all see one settled value.
 *
 * Exactly one of the two is ever set. `authMethod: 'none'` leaves both null,
 * which is the same "no credential" the transport already handled.
 */
interface Credential {
  /** `authMethod: 'password'` only. */
  pass: string | null
  /** `authMethod: 'oauth2'` only — a bearer token, never the refresh token. */
  accessToken: string | null
}

/**
 * Turn the stored secret into something to authenticate with.
 *
 * For a password account this is a rename and nothing else. For an OAuth2 one
 * it is where the refresh token in the keystore becomes an hour-long bearer
 * token, which is why it is `async` and why it happens before the connection
 * rather than inside it — a token request in the middle of an SMTP handshake
 * would be spending the connection's time budget on HTTP.
 */
async function resolveCredential(
  account: MailAccount,
  secret: string | null,
): Promise<Credential> {
  if (account.authMethod !== 'oauth2') return { pass: secret, accessToken: null }
  return {
    pass: null,
    accessToken: await accessTokenForAccount(account.id, account.providerId),
  }
}

function buildTransport(
  account: MailAccount,
  credential: Credential,
  endpoint: Endpoint,
  perAttemptMs: number,
  resolvedHost: string,
  pooled = false,
): Transporter {
  return nodemailer.createTransport({
    host: resolvedHost,
    port: endpoint.port,
    secure: endpoint.security === 'ssl',
    requireTLS: endpoint.security === 'starttls',
    // XOAUTH2 first, and only when the account is actually an OAuth2 one. The
    // password branch below is untouched: nodemailer builds a plain `AUTH LOGIN`
    // / `AUTH PLAIN` from `{ user, pass }` exactly as it always did, and an
    // account that never opted into OAuth2 cannot reach the first branch at all.
    auth:
      account.authMethod === 'oauth2' && credential.accessToken
        ? { type: 'OAuth2', user: account.username, accessToken: credential.accessToken }
        : account.authMethod === 'password' && credential.pass
          ? { user: account.username, pass: credential.pass }
          : undefined,
    tls: {
      rejectUnauthorized: !account.allowInvalidCert,
      minVersion: 'TLSv1.2',
      servername: account.host,
    },
    // Kept short on purpose. This is the per-address budget, not the budget the
    // user experiences; the deadline below is what bounds the whole operation.
    connectionTimeout: Math.min(perAttemptMs, 10_000),
    greetingTimeout: Math.min(perAttemptMs, 10_000),
    socketTimeout: Math.max(perAttemptMs, 60_000),
    // Pooling is what makes a send feel instant. An SMTP send is DNS, TCP, TLS,
    // EHLO, AUTH, then the message — the first five are the expensive part and
    // none of them depend on *this* message. Holding the authenticated
    // connection open means the second send onwards is one round trip.
    ...(pooled
      ? {
          pool: true,
          // One connection: this app sends one message at a time, and several
          // parallel logins is exactly what makes a provider flag an account.
          maxConnections: 1,
          maxMessages: Infinity,
          // Keeps NAT and the server's own idle timer from silently dropping it.
          socketTimeout: 10 * 60_000,
        }
      : {}),
  })
}

// ---------------------------------------------------------------------------
// Warm connections
//
// Keyed by account. Anything that would change what the connection *is* —
// server, port, credentials, certificate policy — is folded into a fingerprint,
// so editing an account cannot leave a stale pool authenticated as the old user.
// The secret is hashed rather than stored, so a heap dump of this map is not a
// password list.
// ---------------------------------------------------------------------------

interface Warm {
  transporter: Transporter
  endpoint: Endpoint
  fingerprint: string
  idleTimer: NodeJS.Timeout
}

const warmPool = new Map<string, Warm>()

/** Long enough to cover a working session, short enough not to sit on a socket overnight. */
const IDLE_MS = 10 * 60_000

function fingerprint(account: MailAccount, credential: Credential): string {
  return createHash('sha256')
    .update(
      [
        account.host,
        account.port,
        account.security,
        account.username,
        account.authMethod,
        account.allowInvalidCert ? '1' : '0',
        credential.pass ?? '',
        // The access token belongs in here for the same reason the password
        // does, and it earns its place more often: a pooled connection stays
        // authenticated under whichever token opened it, so a renewal an hour
        // in must produce a different fingerprint and force a reconnect rather
        // than keep sending down a session the server is about to close.
        credential.accessToken ?? '',
      ].join('\x00'),
    )
    .digest('hex')
}

function dropWarm(accountId: string): void {
  const warm = warmPool.get(accountId)
  if (!warm) return
  warmPool.delete(accountId)
  clearTimeout(warm.idleTimer)
  try {
    warm.transporter.close()
  } catch {
    /* already gone */
  }
}

function touchWarm(accountId: string): void {
  const warm = warmPool.get(accountId)
  if (!warm) return
  clearTimeout(warm.idleTimer)
  warm.idleTimer = setTimeout(() => dropWarm(accountId), IDLE_MS)
  warm.idleTimer.unref?.()
}

/** Close every pooled connection — called when the app is quitting. */
export function closeAllConnections(): void {
  for (const id of [...warmPool.keys()]) dropWarm(id)
}

/**
 * The connection to send on, opening and authenticating one if needed.
 *
 * The endpoint ladder only runs when there is no usable warm connection, and
 * the endpoint it settles on is remembered — so the cost of negotiating a
 * mismatched port is paid once per session rather than once per message.
 */
async function warmConnection(
  account: MailAccount,
  credential: Credential,
  budgetMs: number,
): Promise<{ warm: Warm; attempts: number; opened: boolean }> {
  const print = fingerprint(account, credential)
  const existing = warmPool.get(account.id)
  if (existing && existing.fingerprint === print) {
    touchWarm(account.id)
    return { warm: existing, attempts: 0, opened: false }
  }
  // Settings changed under us — the old connection is authenticated as
  // somebody else and must not be reused.
  if (existing) dropWarm(account.id)

  const outcome = await overLadder(
    account,
    credential,
    async (transporter) => {
      await transporter.verify()
      return true
    },
    budgetMs,
    true,
  )

  if (!outcome.value || !outcome.transporter) {
    throw outcome.error ?? new Error('Could not open a connection')
  }

  const warm: Warm = {
    transporter: outcome.transporter,
    endpoint: outcome.endpoint,
    fingerprint: print,
    idleTimer: setTimeout(() => dropWarm(account.id), IDLE_MS),
  }
  warm.idleTimer.unref?.()
  warmPool.set(account.id, warm)
  return { warm, attempts: outcome.attempts, opened: true }
}

/**
 * Open and authenticate ahead of time so the next send is one round trip.
 *
 * Called when the compose screen opens. Failure is deliberately silent: this is
 * an optimisation, and a user who is only browsing their schedules should never
 * see an error about a connection they did not ask for.
 */
export async function prewarm(account: MailAccount, secret: string | null): Promise<boolean> {
  try {
    assertSafeAccount(account)
    const credential = await resolveCredential(account, secret)
    await warmConnection(account, credential, totalBudgetMs(account.timeoutMs / 1000))
    return true
  } catch {
    return false
  }
}

/** Forget an account's connection — after an edit, a delete, or a password change. */
export function invalidateConnection(accountId: string): void {
  dropWarm(accountId)
}

function assertSafeAccount(account: MailAccount): void {
  if (!isValidAddress(account.fromAddress)) throw new Error('Invalid from address')
  if (!isHeaderSafe(account.fromName)) throw new Error('Invalid sender name')
  if (!/^[A-Za-z0-9.\-_]+$/.test(account.host)) throw new Error('Invalid SMTP host')
  if (!Number.isInteger(account.port) || account.port < 1 || account.port > 65535) {
    throw new Error('Invalid SMTP port')
  }
}

function assertSafeDraft(draft: MessageDraft): void {
  if (!isHeaderSafe(draft.subject)) throw new Error('Subject contains an illegal character')
  for (const address of [...draft.to, ...draft.cc, ...draft.bcc]) {
    if (!isValidAddress(address)) throw new Error(`Invalid recipient: ${address}`)
  }
  for (const a of draft.attachments) {
    if (!isHeaderSafe(a.name)) throw new Error(`Illegal attachment name: ${a.name}`)
  }
}

/**
 * Resolve and stat every attachment before opening a connection.
 *
 * Doing this up front means a missing file produces a clear "attachment could
 * not be read" instead of a half-delivered message, and it is the point where
 * a path is checked at all — a saved job is just JSON, so its `path` field is
 * attacker-controlled if that JSON ever came from somewhere else.
 */
async function resolveAttachments(
  attachments: Attachment[],
): Promise<Array<{ filename: string; path: string; cid?: string }>> {
  const out: Array<{ filename: string; path: string; cid?: string }> = []
  let total = 0

  for (const a of attachments) {
    const resolved = path.resolve(a.path)
    let stat
    try {
      stat = await fs.stat(resolved)
    } catch {
      throw new Error(`Attachment not found: ${a.name}`)
    }
    if (!stat.isFile()) throw new Error(`Attachment is not a file: ${a.name}`)

    total += stat.size
    if (total > ABSOLUTE_MAX_BYTES) throw new Error('Attachments exceed the maximum total size')

    out.push({
      filename: path.basename(a.name),
      path: resolved,
      ...(a.inline && a.cid ? { cid: a.cid } : {}),
    })
  }

  return out
}

function bodyParts(draft: MessageDraft): { text?: string; html?: string } {
  if (draft.bodyFormat === 'html') {
    return { html: draft.body, text: draft.body.replace(/<[^>]+>/g, ' ') }
  }
  // Markdown never reaches here: `forTransport` renders it to HTML at the
  // boundary between the app and the platform layer, so both this and the
  // Android sender see `html` and neither needs a parser. Anything still
  // marked markdown at this point is a draft that bypassed that boundary, and
  // it is treated as plain text rather than shipped with visible asterisks.
  return { text: draft.body, html: plainToHtml(draft.body) }
}

interface AttemptOutcome<T> {
  value?: T
  error?: Error
  endpoint: Endpoint
  /** Only returned for pooled runs, where the caller keeps the connection. */
  transporter?: Transporter
  /**
   * What every rung ran into. The last error alone is misleading — the ladder
   * ends on the least conventional endpoint, so its failure is the least
   * informative one of the set.
   */
  notes: AttemptNote[]
}

/**
 * Cached DNS answers, so a warm session does not re-resolve on every send.
 *
 * Short TTL on purpose: long enough that a burst of sends pays for one lookup,
 * short enough that a provider moving traffic between addresses is picked up
 * within a couple of minutes.
 */
const hostCache = new Map<string, { address: string; at: number }>()
const HOST_TTL_MS = 120_000

/** Exported for `electron/imap.ts` — IMAP hits the same slow-resolver problem SMTP did. */
export async function resolveHostCached(host: string, timeoutMs: number): Promise<string> {
  const hit = hostCache.get(host)
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.address
  const address = await resolveHost(host, timeoutMs)
  hostCache.set(host, { address, at: Date.now() })
  return address
}

/**
 * Walk the endpoint ladder until something works.
 *
 * Each rung gets its own slice of the budget so a blackholed port cannot spend
 * the whole thing, and a failure that could not possibly be fixed by a
 * different endpoint (a rejected password) stops the walk immediately.
 *
 * A rung that is already known to work is tried first: `warmPool` remembers the
 * endpoint from last time, so a user whose port was auto-corrected does not pay
 * for the correction again on every reconnect.
 */
async function overLadder<T>(
  account: MailAccount,
  credential: Credential,
  run: (transporter: Transporter) => Promise<T>,
  totalMs: number,
  keepOpen = false,
): Promise<AttemptOutcome<T> & { attempts: number }> {
  const known = warmPool.get(account.id)?.endpoint
  const ladder = endpointLadder(account.port, account.security, account.autoNegotiate !== false)
  if (known) {
    const i = ladder.findIndex((e) => e.port === known.port && e.security === known.security)
    if (i > 0) ladder.unshift(...ladder.splice(i, 1))
  }

  const startedAll = Date.now()

  // One entry per rung that failed. Collected rather than discarded because
  // the ladder ends on the least conventional endpoint, so `last` on its own
  // describes the least informative attempt of the set.
  const notes: AttemptNote[] = []

  // Resolved once, outside the ladder: the address does not change between
  // ports, and paying for a lookup on every rung would be the same mistake in
  // a different place.
  const resolvedHost = await resolveHostCached(account.host, Math.min(totalMs / 2, 8_000))

  const perRung = rungBudgetMs(totalMs - (Date.now() - startedAll), ladder.length)

  let last: Error = new Error('No connection attempt was made')
  let attempts = 0

  for (const endpoint of ladder) {
    attempts++
    const remaining = totalMs - (Date.now() - startedAll)
    // Ration what is left rather than starting a rung that cannot finish; a
    // half-second attempt produces a misleading error, not a faster answer.
    if (remaining < 2_000 && attempts > 1) break
    const budget = Math.min(perRung, remaining)

    const transporter = buildTransport(account, credential, endpoint, budget, resolvedHost, keepOpen)
    let succeeded = false
    try {
      const value = await withDeadline(() => run(transporter), budget, () => transporter.close())
      succeeded = true
      return { value, endpoint, attempts, notes, ...(keepOpen ? { transporter } : {}) }
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e))
      notes.push({ port: endpoint.port, security: endpoint.security, error: last.message })
      // A bearer token the server refused is worth throwing away, whatever the
      // reason. Tokens can be revoked mid-life, and a cached one that is still
      // minutes from its stated expiry would otherwise be handed to every
      // attempt until that expiry passed — turning one refused sign-in into an
      // hour of them. Discarding costs one token request on the next send.
      if (account.authMethod === 'oauth2' && classifyError(last.message) === 'auth') {
        noteOAuthAuthFailure(account.id)
      }
      if (!isNegotiable(classifyError(last.message), last.message)) {
        return { error: last, endpoint, attempts, notes }
      }
    } finally {
      // A pooled connection that worked is the caller's to keep; everything
      // else is closed here, including the pooled ones that failed.
      if (!succeeded || !keepOpen) {
        try {
          transporter.close()
        } catch {
          /* already closed by the deadline handler */
        }
      }
    }
  }

  return {
    error: last,
    endpoint: ladder[ladder.length - 1] ?? { port: account.port, security: account.security },
    attempts,
    notes,
  }
}

function diagnosticsFor(
  account: MailAccount,
  endpoint: Endpoint,
  attempts: number,
  stage: TransportDiagnostics['stage'],
): TransportDiagnostics {
  return {
    securityUsed: endpoint.security,
    port: endpoint.port,
    host: account.host,
    stage,
    attempts,
    adjusted: endpoint.port !== account.port || endpoint.security !== account.security,
  }
}

function failure(
  error: Error,
  startedAt: number,
  account: MailAccount,
  endpoint: Endpoint,
  attempts: number,
  notes: AttemptNote[] = [],
): SendResult {
  const raw = error.message || String(error)
  // Classification stays on the raw text: `classifyError` matches on provider
  // and OpenSSL wording, and a sentence written for a person would defeat it.
  const kind = classifyError(raw)
  // What reaches the screen is the other way round — a sentence first, the
  // per-rung trace next, the OpenSSL dump last. Before this, `error` was the
  // raw text, which is how a BoringSSL stack offset ended up as the headline
  // of the account dialog and overflowed it.
  const message = renderTransportError(
    summarizeTransportError(raw, {
      host: account.host,
      port: endpoint.port,
      security: endpoint.security,
    }),
    formatAttempts(notes),
  )
  return {
    ok: false,
    accepted: [],
    rejected: [],
    durationMs: Date.now() - startedAt,
    error: message,
    errorKind: kind,
    diagnostics: diagnosticsFor(
      account,
      endpoint,
      attempts,
      kind === 'auth' ? 'auth' : kind === 'timeout' ? 'connect' : 'tls',
    ),
  }
}

export async function sendMail(
  draft: MessageDraft,
  account: MailAccount,
  secret: string | null,
  totalTimeoutMs?: number,
): Promise<SendResult> {
  const started = Date.now()
  const fallbackEndpoint: Endpoint = { port: account.port, security: account.security }

  try {
    assertSafeAccount(account)
    assertSafeDraft(draft)

    const attachments = await resolveAttachments(draft.attachments)
    const { text, html } = bodyParts(draft)

    const from = account.fromName
      ? { name: account.fromName, address: account.fromAddress }
      : account.fromAddress

    const headers: Record<string, string> = {}
    if (draft.requestReadReceipt) {
      headers['Disposition-Notification-To'] = account.fromAddress
    }

    const base = {
      from,
      replyTo: account.replyTo || undefined,
      subject: draft.subject,
      text,
      html,
      attachments,
      priority: draft.priority,
      headers,
    }

    // A send carries a payload, so it is given a longer floor than a bare
    // connection test: the ladder still applies, but abandoning a transfer that
    // is genuinely in progress would be worse than waiting.
    const budget = Math.max(totalTimeoutMs ?? totalBudgetMs(account.timeoutMs / 1000), 45_000)

    const deliver = async (transporter: Transporter) => {
      const accepted: string[] = []
      const rejected: string[] = []
      let messageId: string | undefined

      if (draft.individualDelivery) {
        // One message per recipient so nobody sees anyone else's address.
        for (const address of [...draft.to, ...draft.cc, ...draft.bcc]) {
          const info = await transporter.sendMail({ ...base, to: address })
          accepted.push(...(info.accepted as string[]).map(String))
          rejected.push(...(info.rejected as string[]).map(String))
          messageId = info.messageId
        }
      } else {
        const info = await transporter.sendMail({
          ...base,
          to: draft.to,
          cc: draft.cc.length > 0 ? draft.cc : undefined,
          bcc: draft.bcc.length > 0 ? draft.bcc : undefined,
        })
        accepted.push(...(info.accepted as string[]).map(String))
        rejected.push(...(info.rejected as string[]).map(String))
        messageId = info.messageId
      }

      return { accepted, rejected, messageId }
    }

    /**
     * Send over the warm connection, opening one if there is none.
     *
     * The retry matters: a pooled connection can be closed by the server, a
     * NAT table or a laptop lid between one send and the next, and that shows
     * up as a write error on a socket that looked fine. One silent reconnect
     * turns a confusing failure into a slightly slower success — but only
     * once, so a genuinely broken account still fails fast.
     */
    const credential = await resolveCredential(account, secret)
    let warmed = await warmConnection(account, credential, budget)
    let attempts = warmed.attempts
    let result

    try {
      result = await withDeadline(
        () => deliver(warmed.warm.transporter),
        budget,
        () => invalidateConnection(account.id),
      )
    } catch (first) {
      const message = first instanceof Error ? first.message : String(first)
      const kind = classifyError(message)
      // A dead connection is worth one retry. A rejected password is not.
      if (warmed.opened || kind === 'auth' || kind === 'recipient' || kind === 'quota') {
        throw first
      }
      invalidateConnection(account.id)
      // Re-resolved rather than reused: the reconnect may be happening on the
      // far side of an access token's expiry, and opening a fresh connection
      // with the token that just died would spend the retry on a certainty.
      warmed = await warmConnection(account, await resolveCredential(account, secret), budget)
      attempts += warmed.attempts
      result = await withDeadline(
        () => deliver(warmed.warm.transporter),
        budget,
        () => invalidateConnection(account.id),
      )
    }

    touchWarm(account.id)
    const { accepted, rejected, messageId } = result
    return {
      ok: rejected.length === 0 && accepted.length > 0,
      messageId,
      accepted,
      rejected,
      durationMs: Date.now() - started,
      diagnostics: diagnosticsFor(account, warmed.warm.endpoint, attempts, 'done'),
      ...(rejected.length > 0
        ? { error: `Rejected: ${rejected.join(', ')}`, errorKind: 'recipient' as const }
        : {}),
    }
  } catch (e) {
    return failure(
      e instanceof Error ? e : new Error(String(e)),
      started,
      account,
      fallbackEndpoint,
      0,
    )
  }
}

/**
 * Open a connection and authenticate, without sending anything.
 *
 * Always returns within the budget. That is the whole point: the previous
 * version could sit on `verify()` for two minutes with the button stuck on
 * "Testing…", which reads as a frozen app rather than a slow network.
 */
export async function testConnection(
  account: MailAccount,
  secret: string | null,
  totalTimeoutMs?: number,
): Promise<SendResult> {
  const started = Date.now()
  const fallbackEndpoint: Endpoint = { port: account.port, security: account.security }

  try {
    assertSafeAccount(account)
    const budget = totalTimeoutMs ?? totalBudgetMs(account.timeoutMs / 1000)

    const outcome = await overLadder(
      account,
      await resolveCredential(account, secret),
      async (transporter) => {
        await transporter.verify()
        return true
      },
      budget,
    )

    if (!outcome.value) {
      return failure(
        outcome.error ?? new Error('Could not connect'),
        started,
        account,
        outcome.endpoint,
        outcome.attempts,
        outcome.notes,
      )
    }

    return {
      ok: true,
      accepted: [],
      rejected: [],
      durationMs: Date.now() - started,
      diagnostics: diagnosticsFor(account, outcome.endpoint, outcome.attempts, 'done'),
    }
  } catch (e) {
    return failure(
      e instanceof Error ? e : new Error(String(e)),
      started,
      account,
      fallbackEndpoint,
      0,
    )
  }
}

/** Re-exported so the main process can label an unusable security value. */
export type { TransportSecurity }
