/**
 * IMAP receiving for the desktop build.
 *
 * Mirrors `mailer.ts`'s discipline for the same reason: a mismatched
 * port/security pair or a slow DNS resolver hangs an IMAP client exactly the
 * way it hung the old SMTP code (see that file's header for the measured
 * numbers) — so the same endpoint ladder, the same time budget, and the same
 * OS-resolved-DNS shortcut apply here rather than being reinvented.
 *
 * v1 scope, deliberately narrower than the full design:
 *   - INBOX only, no folder hierarchy. Verification codes and login links —
 *     the feature this exists for — arrive in the inbox; Sent/Drafts/custom
 *     folders are a real feature but not this one.
 *   - Polling only, no IDLE. A "check now" button plus a periodic timer
 *     covers the use case without a second long-lived socket per account;
 *     IDLE is a legitimate follow-up, not a cut corner that breaks anything.
 *   - Body prefetch is bounded (`BODY_PREFETCH_LIMIT`, `PREFETCH_MAX_BYTES`)
 *     so an account with years of mail does not pay to download all of it on
 *     the first sync — the rest load on demand when opened.
 */

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import {
  INBOX_LIST_FETCH_CEILING,
  INBOX_LIST_FETCH_LIMIT,
  type InboxAccountState,
  type InboxFolder,
  type InboxMessage,
  type InboxTag,
  type SeenFlagResult,
  type SendResult,
} from '../src/core/types'
import {
  endpointLadder,
  renderTransportError,
  rungBudgetMs,
  summarizeTransportError,
  TimeoutError,
  totalBudgetMs,
  withDeadline,
  type Endpoint,
} from '../src/core/mail/transport'
import { classifyError, type InboxMessageBody } from '../src/core/platform/bridge'
import { accessTokenForAccount, hasOAuthGrant, noteOAuthAuthFailure } from './oauth'
import { resolveHostCached } from './mailer'
import { sanitizeMessageHtml } from './sanitizeHtml'
import { prefetchImages } from './imagePrefetch'
import {
  attachmentMeta,
  peekMessageBody,
  readMessageBody,
  writeInboxAttachments,
  writeMessageBody,
  type CachedBody,
} from './inboxStore'

const INBOX_PATH = 'INBOX'
/**
 * How many of the most recent messages populate the list per sync.
 *
 * `INBOX_LIST_FETCH_CEILING` (`src/core/types.ts`), not a number restated
 * here. This used to be a flat 50 regardless of mailbox size — the "why does
 * it only show 50 of my 52 messages" complaint — so it is now a high ceiling
 * rather than an everyday cap: a sync lists the whole folder up to it.
 */
const LIST_FETCH_LIMIT = INBOX_LIST_FETCH_CEILING
/**
 * Of those, how many the sync itself waits for before it can answer.
 *
 * Unchanged at fifteen. What changed is that they now arrive in one batched
 * `FETCH` rather than fifteen sequential `fetchOne` calls, and that everything
 * *past* fifteen, up to `PREFETCH_TAIL_LIMIT` below, is covered too, after the
 * list is already on screen.
 */
const BODY_PREFETCH_LIMIT = 15
/**
 * And how many of the listed messages end up cached in total, counting the
 * background pass.
 *
 * The whole page. Messages 16 to 50 were never prefetched by any earlier
 * build, so opening one paid a full connection — TCP, TLS, greeting,
 * CAPABILITY, LOGIN, the post-login CAPABILITY, SELECT — before a byte of the
 * message moved. Six to eight sequential round trips for one tap, on a page of
 * mail the user can reach with one scroll.
 */
const PREFETCH_TAIL_LIMIT = INBOX_LIST_FETCH_LIMIT
/** Skip eager prefetch above this size; the message is still listed, its body just loads on demand. */
const PREFETCH_MAX_BYTES = 5 * 1024 * 1024
/**
 * What the background pass may spend in one go.
 *
 * A ceiling on work that never used to happen at all, so nothing is being
 * tightened here — the foreground tranche above is bounded exactly as it always
 * was, by count and by `PREFETCH_MAX_BYTES` per message. This exists because
 * "the rest of the page" is up to 35 messages, and 35 at the five-megabyte
 * per-message ceiling is a number worth refusing to reach in one background
 * pass. Whatever falls outside it is still listed, still opens, and is picked
 * up by the next sync.
 */
const PREFETCH_TAIL_MAX_BYTES = 40 * 1024 * 1024
/**
 * How much of a prefetched body becomes the list-row `snippet`.
 *
 * Generous on purpose: `reportMatches` (core/receipts.ts) looks for a bounced
 * send's quoted Message-ID inside this text, and a DSN quotes the original
 * headers well past where a 120-char notification preview would have cut it
 * off. `previewLine` truncates further for on-screen display; this constant
 * only bounds what search and receipt-matching have to work with.
 */
const SNIPPET_MAX_CHARS = 2000

/**
 * True when imapflow rejected the credentials, as opposed to failing to reach
 * the server at all.
 *
 * Deliberately duck-typed rather than an `instanceof` against imapflow's
 * `AuthenticationFailure`: that class is declared in the package's `.d.ts` but
 * never re-exported from its entry point, so importing it typechecks and then
 * evaluates to `undefined` at runtime. See the call site in `withConnection`.
 *
 * `serverResponseCode` covers the servers that answer
 * `NO [AUTHENTICATIONFAILED] …` without imapflow tagging the error itself.
 *
 * Exported for `imapIdle.ts`'s `Watcher`, which needs the identical check to
 * decide whether a dead access token is worth invalidating rather than just
 * retried — see the reasoning at that call site for why duplicating this
 * function there would be the wrong fix.
 */
export function isAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown }
  if (e.authenticationFailed === true) return true
  return (
    typeof e.serverResponseCode === 'string' &&
    e.serverResponseCode.toUpperCase() === 'AUTHENTICATIONFAILED'
  )
}

function assertSafeConfig(config: InboxAccountState): void {
  if (!/^[A-Za-z0-9.\-_]+$/.test(config.imapHost)) throw new Error('Invalid IMAP host')
  if (!Number.isInteger(config.imapPort) || config.imapPort < 1 || config.imapPort > 65535) {
    throw new Error('Invalid IMAP port')
  }
}

function messageRowId(accountId: string, folderPath: string, uid: number): string {
  return `${accountId}:${folderPath}:${uid}`
}

function formatAddress(a: { name?: string; address?: string } | undefined): string {
  if (!a) return ''
  if (a.name && a.address) return `${a.name} <${a.address}>`
  return a.address ?? a.name ?? ''
}

/**
 * Every address on one envelope header, each formatted the way `formatAddress`
 * formats one.
 *
 * The whole list has always been in the FETCH reply — `envelope: true` asks for
 * it and the server sends it — and only the first entry was ever read. A message
 * addressed to five people therefore looked, in the reader, exactly like one
 * addressed to one, with no sign that anything had been dropped.
 *
 * Entries that format to nothing are removed rather than kept as blanks: an
 * envelope group ("undisclosed-recipients:;") arrives as an address object with
 * neither name nor address, and rendering it as an empty recipient would be
 * inventing a person.
 */
function formatAddressList(
  list: Array<{ name?: string; address?: string }> | undefined,
): string[] {
  return (list ?? []).map(formatAddress).filter((s) => s.length > 0)
}

/** `internalDate` is typed `Date | string` — imapflow's own docs show both shapes in the wild. */
function internalDateMs(value: Date | string | undefined): number {
  if (!value) return Date.now()
  const date = typeof value === 'string' ? new Date(value) : value
  const ms = date.getTime()
  return Number.isFinite(ms) ? ms : Date.now()
}

function hasAttachmentPart(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { disposition?: string; childNodes?: unknown[] }
  if (n.disposition === 'attachment') return true
  return (n.childNodes ?? []).some(hasAttachmentPart)
}

/** Biggest `text/calendar` part worth carrying, and how many. */
const MAX_ICS_BYTES = 256 * 1024
const MAX_ICS_PARTS = 4

/**
 * The `text/calendar` parts of a message, as text.
 *
 * An invitation states its time in a `DTSTART` that the sending calendar wrote
 * deliberately; the prose beside it ("see you Thursday") is a guess dressed up
 * as a fact. So this is the primary source for `core/dateExtract.ts` and the
 * prose reader is the fallback.
 *
 * Bounded on both axes because this is a stranger's file: a calendar export
 * with ten years of history is a legitimate `text/calendar` part and has no
 * business being parsed to find one meeting. Oversized parts are dropped
 * rather than truncated — half an iCalendar file parses to nothing useful and
 * would look like a parser bug rather than a size limit.
 */
function calendarParts(attachments: Array<{ contentType?: string; content?: Buffer }>): string[] {
  const out: string[] = []
  for (const part of attachments) {
    if (out.length >= MAX_ICS_PARTS) break
    const type = (part.contentType ?? '').toLowerCase()
    if (!type.startsWith('text/calendar')) continue
    const buffer = part.content
    if (!buffer || buffer.length === 0 || buffer.length > MAX_ICS_BYTES) continue
    out.push(buffer.toString('utf8'))
  }
  return out
}

/**
 * Parse a raw RFC822 source, sanitize its HTML, cache the result to disk, and
 * return it in the shape the bridge promises. Shared by the eager sync
 * prefetch and the on-demand `fetchMessageBody` path so the parse/sanitize/
 * cache step exists exactly once.
 */
async function parseCacheAndReturn(
  accountId: string,
  folderPath: string,
  uid: number,
  source: Buffer,
): Promise<InboxMessageBody & { hasAttachments: boolean }> {
  const parsed = await simpleParser(source)
  const sanitized = typeof parsed.html === 'string' ? sanitizeMessageHtml(parsed.html) : null

  const attachments =
    parsed.attachments.length > 0
      ? await writeInboxAttachments(accountId, folderPath, uid, parsed.attachments)
      : []

  const remoteImages = sanitized?.remoteImages ?? []
  const icsParts = calendarParts(parsed.attachments)
  await writeMessageBody(accountId, folderPath, uid, {
    text: parsed.text,
    sanitizedHtml: sanitized?.html,
    remoteImages,
    icsParts,
    // The one moment the `cid`, `inline` and declared-type facts exist. This
    // parse is where they were being thrown away: the bytes went to disk and
    // everything that said what those bytes *were* stayed in this scope, so the
    // read path had nothing left to match `<img src="cid:…">` against. Written
    // even when empty, so a body file can be told apart from one an older build
    // wrote — for that one, absent means unknown, not "no attachments".
    attachments: attachmentMeta(attachments),
  })

  /*
   * Fetch the pictures now, while nobody is looking.
   *
   * This is the single line that decouples "the message arrived" from "the
   * message was read" — see `imagePrefetch.ts` for why that is the whole
   * privacy claim rather than a performance tweak. It sits here, after the body
   * is safely on disk, because this function is the one place a body is ever
   * parsed: both the eager sync pass and the on-demand `fetchMessageBody` go
   * through it, so neither can forget.
   *
   * Deliberately not awaited, and deliberately incapable of throwing. A message
   * has to render whether or not its pictures were prefetched, and a picture
   * nobody has asked for yet must never be a reason a sync fails.
   */
  prefetchImages(remoteImages)

  return {
    text: parsed.text,
    sanitizedHtml: sanitized?.html,
    attachments,
    remoteImages,
    icsParts,
    hasAttachments: attachments.length > 0,
  }
}

/**
 * Walk the endpoint ladder like `mailer.ts`'s `overLadder`, but for a single
 * IMAP session rather than a pooled SMTP transporter — there is no warm
 * connection to keep here, `syncInbox` opens one, does its work, and closes
 * it every time (see the file header on why IDLE/pooling is deferred).
 */
/**
 * Is there anything at all to authenticate this mailbox with?
 *
 * Every caller below used to ask this as `if (!secret)`, which was exactly
 * right while a password was the only answer and is exactly wrong now: an
 * account that signed in with OAuth2 has no password by design, and refusing it
 * with "no password stored for receiving" would be the app describing its own
 * missing feature as the user's missing credential.
 */
async function hasCredential(config: InboxAccountState, secret: string | null): Promise<boolean> {
  return Boolean(secret) || (await hasOAuthGrant(config.accountId))
}

/**
 * How long the configured endpoint gets on the one retry a fully timed-out
 * ladder is allowed.
 *
 * Ninety seconds, and the number comes from a measurement rather than a
 * feeling. One of the reporting user's five accounts — same provider, same
 * host, same port as three that were fine — needed **36.7 s** to finish
 * `connect()` where the others needed 1-5 s. The ladder's per-rung slice is
 * `rungBudgetMs(30_000, 3)` = 10 s, so every rung timed out, every sync
 * failed, and the account had not synced for three days. Nothing was broken:
 * the server answered correctly, just slowly, and the app had no way to say
 * "slow" rather than "unreachable". Ninety seconds clears that measurement
 * with room for a worse day and is still bounded well under the sync interval.
 *
 * This is spent only by an account that has *already* failed every rung, so a
 * healthy mailbox never waits on it, and an account that is genuinely
 * unreachable pays it once per sync rather than per rung.
 */
const PATIENT_CONNECT_MS = 90_000

async function withConnection<T>(
  config: InboxAccountState,
  secret: string | null,
  run: (client: ImapFlow) => Promise<T>,
  /** Filled in with the rung that actually worked, for the test report. */
  onEndpoint?: (endpoint: Endpoint, client: ImapFlow) => void,
  /**
   * Allow one patient retry of the configured endpoint when every rung timed
   * out. See `PATIENT_CONNECT_MS`.
   *
   * Off by default so that adding this could not change any caller that had
   * not thought about it: a path with a person watching a spinner wants the
   * fast wrong answer far less than a background sync wants the slow right
   * one, and only the caller knows which it is.
   */
  patient = false,
): Promise<T> {
  assertSafeConfig(config)

  /*
   * An XOAUTH2 bearer token, when this account has a grant.
   *
   * Resolved from the account id alone, because `InboxAccountState` carries no
   * `authMethod` and no `providerId` — it never needed either while a password
   * was the only mechanism. `accessTokenForAccount` answers `null` for every
   * account that has never completed a consent, which is what keeps this a
   * no-op for the password path rather than a branch it has to survive.
   */
  const accessToken = await accessTokenForAccount(config.accountId)

  const ladder = endpointLadder(config.imapPort, config.imapSecurity, true)
  const totalMs = totalBudgetMs(30)
  const resolvedHost = await resolveHostCached(config.imapHost, Math.min(totalMs / 2, 8_000))
  const perRung = rungBudgetMs(totalMs, ladder.length)

  let lastError: Error = new Error('No connection attempt was made')
  /*
   * Whether the endpoint the account was *configured* with ran out of time,
   * as opposed to whatever the last rung of the ladder happened to say.
   *
   * Tracked separately because `lastError` is nearly always the wrong thing to
   * ask. A 993/ssl account's ladder is [993 ssl, 143 starttls, 993 starttls];
   * rung 1 is the one that stalls, and rungs 2 and 3 are guesses that a real
   * provider refuses in milliseconds. So by the time the loop ends `lastError`
   * is an ECONNREFUSED from a port nobody configured, and a patient retry
   * gated on `lastError` being a timeout would never fire — on exactly the
   * account it was written for. Found by writing the test, not by reading the
   * code.
   */
  let configuredRungTimedOut = false

  for (const [rung, endpoint] of ladder.entries()) {
    const client = buildClient(config, secret ?? '', resolvedHost, endpoint, perRung, accessToken)
    let connected = false
    try {
      await withDeadline(() => client.connect(), perRung, () => client.close())
      connected = true
      onEndpoint?.(endpoint, client)
      const result = await run(client)
      await client.logout().catch(() => {})
      return result
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      lastError = err
      if (rung === 0 && err instanceof TimeoutError) configuredRungTimedOut = true
      try {
        client.close()
      } catch {
        /* already gone */
      }
      // A rejected password fails identically on every port — trying the
      // next rung would only spend the provider's lockout budget for nothing.
      //
      // This used to read `err instanceof AuthenticationFailure`, importing
      // that class from 'imapflow'. It typechecked forever because
      // `lib/imap-flow.d.ts` declares `export class AuthenticationFailure`,
      // but the real entry point never re-exports it — the class only exists
      // inside `lib/tools.js`, so at runtime the binding was `undefined` and
      // `x instanceof undefined` throws "Right-hand side of 'instanceof' is
      // not an object". Thrown from inside this catch, it *replaced* the real
      // connection error and escaped the endpoint ladder, so every failure
      // surfaced as that TypeError instead of "wrong port for this security
      // mode". Duck-type on the flag imapflow actually sets (tools.js:51,
      // login.js:38, authenticate.js:17) — no import to go stale.
      const refusedCredentials = isAuthFailure(err) || (connected && classifyError(err.message) === 'auth')
      // Same reasoning as the SMTP ladder's: a bearer token the server refused
      // is worth discarding rather than re-offering until its stated expiry.
      if (refusedCredentials && accessToken) noteOAuthAuthFailure(config.accountId)
      if (refusedCredentials) throw err
    }
  }

  /*
   * Every rung ran out of time. Try the endpoint the user actually configured
   * once more, patiently.
   *
   * Only on a timeout, and deliberately: a refused password, a wrong port, a
   * host that does not resolve all failed for a reason more time cannot fix,
   * and `refusedCredentials` above has already thrown for the first of them.
   * A timeout is the one failure that is indistinguishable from "slower than
   * we were willing to wait" — which is what it turned out to be.
   *
   * `ladder[0]` rather than the whole ladder: rungs 2 and 3 are guesses at a
   * misconfiguration, and spending ninety seconds on each guess is how a sync
   * turns into a four-minute stall. Rung 1 is the endpoint the account was set
   * up with and the one that has worked before.
   */
  if (patient && configuredRungTimedOut) {
    const endpoint = ladder[0]
    const client = buildClient(config, secret ?? '', resolvedHost, endpoint, PATIENT_CONNECT_MS, accessToken)
    try {
      await withDeadline(() => client.connect(), PATIENT_CONNECT_MS, () => client.close())
      console.warn(
        `[aevistle] IMAP for ${config.imapHost} needed the patient path (>${Math.round(perRung / 1000)}s to connect) — the server is slow, not unreachable`,
      )
      onEndpoint?.(endpoint, client)
      const result = await run(client)
      await client.logout().catch(() => {})
      return result
    } catch (e) {
      try {
        client.close()
      } catch {
        /* already gone */
      }
      // The patient attempt's own failure is the more informative one: it is
      // the answer from the longest look this code is willing to take.
      lastError = e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError
}

/**
 * Exported for `scripts/check-socket-drop.mjs`, which resets the socket of a
 * client sitting idle and asserts the app survives it. Testing that through a
 * public function does not work: every one of them keeps a command in flight,
 * and a command in flight makes `ImapFlow` *reject* rather than emit `'error'`
 * — the case that crashed is the quiet one in between.
 */
export function buildClient(
  config: InboxAccountState,
  secret: string,
  resolvedHost: string,
  endpoint: Endpoint,
  perAttemptMs: number,
  /**
   * An XOAUTH2 bearer token, for an account that signed in with OAuth2.
   *
   * Optional and last so that every existing caller — including
   * `scripts/check-socket-drop.mjs`, which builds a client against a fake
   * server with five arguments — keeps working untouched.
   */
  accessToken?: string | null,
): ImapFlow {
  const client = new ImapFlow({
    host: resolvedHost,
    port: endpoint.port,
    secure: endpoint.security === 'ssl',
    ...(endpoint.security === 'starttls' ? { doSTARTTLS: true } : {}),
    // SNI and certificate identity still check against the real hostname —
    // only the connection target was swapped for the pre-resolved IP.
    servername: config.imapHost,
    // imapflow speaks XOAUTH2 natively when handed an `accessToken` instead of
    // a `pass`; the password shape below is byte-for-byte what it always was.
    auth: accessToken
      ? { user: config.imapUsername, accessToken }
      : { user: config.imapUsername, pass: secret },
    tls: {
      rejectUnauthorized: !config.imapAllowInvalidCert,
      minVersion: 'TLSv1.2',
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: Math.min(perAttemptMs, 10_000),
    greetingTimeout: Math.min(perAttemptMs, 10_000),
    socketTimeout: Math.max(perAttemptMs, 30_000),
  })

  // Same reason as the SMTP transporter in `mailer.ts`: `ImapFlow` is an
  // EventEmitter, and a reset socket emits `'error'` rather than rejecting the
  // call that is in flight. Without a listener Node throws it at the top level,
  // where it becomes a crash dialog about a mail connection the user never
  // asked about. The operations here are awaited and report their own failures,
  // so this only has to stop the throw.
  client.on('error', (err) => {
    console.error('[aevistle] IMAP connection error:', err instanceof Error ? err.message : err)
  })

  return client
}

/**
 * The first line of a cached body, for a list row that has none.
 *
 * Prefers `text`, falls back to stripping tags out of the sanitized HTML. That
 * is the same order `parseCacheAndReturn` produced the original snippet in, and
 * stripping tags from already-sanitized markup cannot reintroduce anything the
 * sanitizer took out.
 */
function snippetFromCached(body: CachedBody): string {
  const source = body.text ?? (body.sanitizedHtml ?? '').replace(/<[^>]+>/g, ' ')
  return source.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX_CHARS)
}

/**
 * Download and cache a set of message bodies in one conversation.
 *
 * This is the change that fixes "opening a mail is slow" for the messages a
 * sync was already meant to cover. The loop it replaces called
 * `client.fetchOne(uid, { source: true })` once per message, awaiting each
 * reply before sending the next request: fifteen messages meant fifteen
 * sequential round trips, spent inside the sync, before the inbox list could
 * paint. One `FETCH <uid set> (UID BODY.PEEK[])` is one request and one reply
 * stream for all of them — the same bytes, none of the waiting.
 *
 * The generator form rather than `fetchAll`: each message is parsed, sanitized
 * and written to disk as it arrives, so peak memory is one message rather than
 * the whole batch, which matters at a per-message ceiling of five megabytes.
 *
 * No `break` out of the loop, deliberately. Abandoning a FETCH mid-stream
 * leaves imapflow holding a partly-read response on a connection this function
 * does not own, so the size budget is applied by the *caller*, when it decides
 * which uids to ask for — by which point the sizes are already known from the
 * list fetch and cost nothing to check.
 *
 * Returns what each message turned out to contain, for the rows that want it.
 * A message that fails to parse is simply absent from the result and loads on
 * demand later, exactly as an unfetched one would.
 */
async function fetchBodies(
  client: ImapFlow,
  accountId: string,
  folderPath: string,
  uids: number[],
): Promise<Map<number, { snippet: string; hasAttachments: boolean }>> {
  const out = new Map<number, { snippet: string; hasAttachments: boolean }>()
  if (uids.length === 0) return out

  for await (const message of client.fetch(
    uids.join(','),
    { uid: true, source: true },
    { uid: true },
  )) {
    const uid = message.uid
    if (!uid || !message.source) continue
    try {
      const cached = await parseCacheAndReturn(accountId, folderPath, uid, message.source)
      out.set(uid, {
        snippet: (cached.text ?? '').slice(0, SNIPPET_MAX_CHARS),
        hasAttachments: cached.hasAttachments,
      })
    } catch {
      // One message's body is never worth failing a sync over — it just loads
      // on demand instead, which is what every message did before prefetching
      // existed.
    }
  }

  return out
}

/**
 * @param tailUids filled with the messages this sync wants cached but is not
 *        going to wait for. Drained by `syncInbox` once the connection is done
 *        with, so that the list can paint while the rest of the page downloads.
 */
async function runSync(
  client: ImapFlow,
  config: InboxAccountState,
  tailUids: number[],
): Promise<InboxAccountState> {
  /*
   * `readOnly`, like every other read path in this file — and unlike this line
   * until now, which was the one place a plain sync selected the mailbox for
   * writing.
   *
   * `SELECT` permits the server to set `\Seen` on a fetch; `EXAMINE` forbids
   * it. Nothing here asks for a body without `BODY.PEEK[]`, so on a
   * well-behaved server the two are identical — but "identical as long as
   * nobody adds a fetch without PEEK" is a footgun with no upside, and the
   * failure it produces is the worst kind: mail marked read on the server,
   * across every device, by an app that was only supposed to be looking.
   * `check-inbox-delivery.mjs` now holds every read path to this.
   */
  const lock = await client.getMailboxLock(INBOX_PATH, { readOnly: true })
  try {
    // `mailbox` is typed `MailboxObject | false` — `false` only outside an
    // open mailbox, which cannot happen here, but the type still has to be
    // narrowed rather than asserted away.
    const mailbox = client.mailbox
    if (!mailbox) throw new Error('INBOX did not open')
    const uidValidity = Number(mailbox.uidValidity)
    const exists = mailbox.exists

    const priorFolder = config.folders.find((f) => f.path === INBOX_PATH)
    // A changed UIDVALIDITY makes every cached UID meaningless for this
    // folder — starting over is the only safe response, not a "try to
    // reconcile" one, which could mismatch a cached body to the wrong message.
    const staleCache = priorFolder ? priorFolder.uidValidity !== uidValidity : false
    const priorByUid = new Map(
      config.messages
        .filter((m) => m.folderPath === INBOX_PATH && !staleCache)
        .map((m) => [m.uid, m]),
    )

    const folder: InboxFolder = {
      id: `${config.accountId}:${INBOX_PATH}`,
      accountId: config.accountId,
      path: INBOX_PATH,
      displayName: INBOX_PATH,
      uidValidity,
      unreadCount: 0,
      totalCount: exists,
    }

    if (exists === 0) {
      /**
       * "The mailbox is empty" is the one answer worth double-checking before
       * acting on, because acting on it throws away every cached message.
       *
       * Observed against Gmail: a SELECT that had reported 35 messages minutes
       * earlier came back with EXISTS 0, no error, and the cache was duly
       * wiped. Whatever the server's reason, a transient wrong answer must not
       * be indistinguishable from "the user emptied their inbox" — one is
       * recoverable and the other is not, so the destructive reading has to be
       * the one that needs proof.
       *
       * STATUS is a separate command answered independently of the selected
       * mailbox state, so agreement between the two is real corroboration. If
       * it disagrees, or cannot be asked, the cache stays and the next sync
       * gets another go — showing briefly stale mail costs the user nothing,
       * and deleting mail they still have costs them the feature.
       */
      const confirmation = await client.status(INBOX_PATH, { messages: true }).catch(() => null)
      const reallyEmpty = confirmation?.messages === 0
      const priorMessages = config.messages.filter((m) => m.folderPath === INBOX_PATH)

      if (!reallyEmpty && priorMessages.length > 0) {
        return {
          ...config,
          // Keep the prior counts too: reporting 0 next to a non-empty list
          // is how a bug gets read as "the list is stale", not "the server
          // said something we did not believe".
          folders: priorFolder ? [priorFolder] : [folder],
          lastSyncAt: Date.now(),
          lastSyncError: undefined,
        }
      }

      return {
        ...config,
        folders: [folder],
        messages: config.messages.filter((m) => m.folderPath !== INBOX_PATH),
        lastSyncAt: Date.now(),
        lastSyncError: undefined,
      }
    }

    const from = Math.max(1, exists - LIST_FETCH_LIMIT + 1)
    const rows = await client.fetchAll(`${from}:${exists}`, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
    })

    /*
     * What is already on disk, for the rows whose own record does not say.
     *
     * The background pass below writes bodies to the cache and to nowhere else
     * — it deliberately does not reach back into a message list that a later
     * sync is going to rebuild anyway — so `bodyCached` and `snippet` on a
     * prior row are exactly the fields that go stale. Asking the disk is how
     * they catch up, and it is also what stops this sync from re-downloading a
     * body the last one's tail already fetched.
     *
     * Skipped entirely for a row that already claims both, so this is one file
     * read per message ever, not one per message per sync.
     */
    const onDisk = new Map<number, CachedBody>()
    for (const row of rows) {
      const uid = row.uid
      if (!uid) continue
      const prior = priorByUid.get(uid)
      if (prior?.bodyCached && prior.snippet) continue
      const cached = await peekMessageBody(config.accountId, INBOX_PATH, uid)
      if (cached) onDisk.set(uid, cached)
    }

    // Newest first, and only the ones cheap enough to be worth downloading
    // eagerly — a code from thirty seconds ago is the point of this feature,
    // one from last week is not worth a synchronous fetch on every sync.
    const newestFirst = [...rows]
      .sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0))
      .filter((m): m is typeof m & { uid: number } => typeof m.uid === 'number' && m.uid > 0)
      .filter((m) => (m.size ?? 0) <= PREFETCH_MAX_BYTES)

    const uncached = (uid: number) => !(priorByUid.get(uid)?.bodyCached || onDisk.has(uid))

    /*
     * The tranche the sync waits for: whichever of the newest
     * `BODY_PREFETCH_LIMIT` *rows* still have no body.
     *
     * Sliced before the cached ones are filtered out, not after, and that order
     * is load-bearing. Filtering first would mean "the fifteen newest uncached
     * messages", which can reach much further down the page — so a sync that
     * arrived with the top of the list already cached and a gap below it would
     * suddenly have fifteen bodies to download in the foreground where the
     * previous build had none. This way the foreground can only ever do less
     * work than it used to, never more; the gap is the background pass's job.
     */
    const prefetchUids = newestFirst
      .slice(0, BODY_PREFETCH_LIMIT)
      .filter((m) => uncached(m.uid))
      .map((m) => m.uid)

    /*
     * The rest of the page, for the background pass.
     *
     * Bounded here rather than there because the sizes are already in hand from
     * the list fetch — `fetchBodies` cannot stop partway through a FETCH it has
     * started, so the budget has to be spent choosing what to ask for.
     */
    let tailBudget = PREFETCH_TAIL_MAX_BYTES
    for (const m of newestFirst.slice(BODY_PREFETCH_LIMIT, PREFETCH_TAIL_LIMIT)) {
      if (!uncached(m.uid)) continue
      const size = m.size ?? 0
      if (size <= 0 || size > tailBudget) continue
      tailBudget -= size
      tailUids.push(m.uid)
    }

    const fetched = await fetchBodies(client, config.accountId, INBOX_PATH, prefetchUids)

    const messages: InboxMessage[] = []
    let unreadCount = 0

    for (const row of rows) {
      const uid = row.uid
      if (!uid) continue
      const seen = row.flags?.has('\\Seen') ?? false
      if (!seen) unreadCount++

      /*
       * Empty means "this header was not on the message", and that has to be
       * `undefined` rather than `[]` for two reasons. `state.json` is rewritten
       * whole on every save and carries fifty of these rows per account, so an
       * empty array on each is pure weight saying nothing; and the reader is
       * entitled to treat a missing list as "we never captured it" (see
       * `InboxMessage.toAll`) rather than having to distinguish two spellings
       * of the same absence.
       */
      const toAll = formatAddressList(row.envelope?.to)
      const cc = formatAddressList(row.envelope?.cc)

      const existing = priorByUid.get(uid)
      let bodyCached = existing?.bodyCached ?? false
      let hasAttachments = hasAttachmentPart(row.bodyStructure)
      const tag: InboxTag = existing?.tag ?? 'none'
      let snippet = existing?.snippet ?? ''

      const cachedOnDisk = onDisk.get(uid)
      if (cachedOnDisk) {
        bodyCached = true
        if (!snippet) snippet = snippetFromCached(cachedOnDisk)
      }

      const justFetched = fetched.get(uid)
      if (justFetched) {
        bodyCached = true
        hasAttachments = justFetched.hasAttachments
        snippet = justFetched.snippet
      }

      messages.push({
        id: messageRowId(config.accountId, INBOX_PATH, uid),
        accountId: config.accountId,
        folderPath: INBOX_PATH,
        uid,
        uidValidity,
        messageId: row.envelope?.messageId ?? undefined,
        from: formatAddress(row.envelope?.from?.[0]),
        to: formatAddress(row.envelope?.to?.[0]),
        toAll: toAll.length > 0 ? toAll : undefined,
        cc: cc.length > 0 ? cc : undefined,
        subject: row.envelope?.subject ?? '',
        date: internalDateMs(row.internalDate),
        snippet,
        sizeBytes: row.size ?? 0,
        hasAttachments,
        seen,
        tag,
        bodyCached,
      })
    }

    return {
      ...config,
      folders: [{ ...folder, unreadCount }],
      messages,
      lastSyncAt: Date.now(),
      lastSyncError: undefined,
    }
  } finally {
    lock.release()
  }
}

/**
 * Accounts whose background body pass is running right now.
 *
 * A guard, not a queue. Two syncs in quick succession would otherwise stack
 * their passes behind each other, each deciding what to fetch from a cache the
 * one in front of it is still writing to. A skipped pass costs nothing:
 * whatever it would have fetched is still missing at the next sync, and the
 * next sync lists it again.
 */
const tailRunning = new Set<string>()

/**
 * Download the bodies the sync did not wait for.
 *
 * Fire and forget, on purpose. Nothing on screen depends on it — every one of
 * these messages still opens exactly as it did before, just slower — and
 * `syncInbox`'s caller is the renderer waiting to paint a list. Awaiting this
 * would put the whole point of the split back where it was.
 *
 * On its own connection, because this file has no connection pool by design
 * (see the header) and `withConnection` logs out when its body returns. One
 * extra handshake buys thirty-five messages that would otherwise each cost a
 * handshake of their own, and only when there is genuinely a page of new mail
 * to catch up on: on a steady mailbox the tail is empty and this never runs.
 */
function schedulePrefetchTail(
  config: InboxAccountState,
  secret: string | null,
  uids: number[],
): void {
  if (uids.length === 0) return
  if (tailRunning.has(config.accountId)) return
  tailRunning.add(config.accountId)

  void withConnection(config, secret, async (client) => {
    const lock = await client.getMailboxLock(INBOX_PATH, { readOnly: true })
    try {
      await fetchBodies(client, config.accountId, INBOX_PATH, uids)
    } finally {
      lock.release()
    }
  })
    .catch((e) => {
      // Logged rather than swallowed: a background pass that fails every time
      // is the difference between this feature working and every message past
      // the fifteenth still paying a full connection to open, with nothing
      // anywhere on screen to say which of the two is happening.
      console.error('[aevistle] background body prefetch failed:', e)
    })
    .finally(() => {
      tailRunning.delete(config.accountId)
    })
}

export async function syncInbox(
  config: InboxAccountState,
  secret: string | null,
): Promise<InboxAccountState> {
  // Called unconditionally on save (see AppState.tsx's saveInboxAccount) so
  // that platforms with a native background sync (Android's periodic
  // WorkManager) always learn about a disable, not just an enable — a no-op
  // here, but that push is what lets the other side cancel its own work.
  if (!config.enabled) return config
  if (!(await hasCredential(config, secret))) {
    throw new Error('No IMAP password stored for this account')
  }
  const tailUids: number[] = []
  /*
   * `patient`, and this is the one call site that most needs it: a background
   * sync has nobody watching, and the cost of giving up early is not a slow
   * screen but an account that silently stops producing new-mail
   * notifications altogether. See `PATIENT_CONNECT_MS`.
   */
  const state = await withConnection(
    config,
    secret,
    (client) => runSync(client, config, tailUids),
    undefined,
    true,
  )
  schedulePrefetchTail(config, secret, tailUids)
  return state
}

/**
 * Cache the bodies of the messages either side of the one just opened.
 *
 * Reading mail is a sequence, not a set of independent taps: the message after
 * this one is the single most likely thing to be opened next, and the one
 * before it is second. Both are known the instant the reader opens anything,
 * and both cost one batched fetch — so the choice is between paying for them
 * now, while somebody is reading, or paying a full connection for one of them
 * in a moment, while somebody is waiting.
 *
 * The renderer decides what "adjacent" means, because its list may be
 * filtered, searched or sorted in ways this side cannot see. What it does not
 * get to decide is how many: two, whatever it passes, so this cannot be turned
 * into a bulk downloader by a call site that grows a feature later.
 *
 * Never throws and returns nothing worth waiting on. This is a guess about what
 * somebody will tap next; there is no failure here a user could act on, and a
 * caller that awaited it would have turned a speculative fetch into a second
 * thing slowing down the message they actually opened.
 *
 * The Android side of this (`MailFetcher.prefetchAdjacent`) additionally
 * refuses to run on a metered connection. There is no equivalent check here
 * because there is no equivalent signal: Electron exposes no metered-network
 * API, and a laptop on a phone hotspot is indistinguishable from one on
 * Ethernet. Stated rather than silently skipped.
 */
export async function prefetchAdjacentBodies(
  config: InboxAccountState,
  secret: string | null,
  folderPath: string,
  uids: number[],
): Promise<void> {
  if (!config.enabled || uids.length === 0) return
  if (!(await hasCredential(config, secret))) return

  const want: number[] = []
  for (const uid of uids) {
    if (want.length >= 2) break
    if (!Number.isInteger(uid) || uid <= 0 || want.includes(uid)) continue
    if (await peekMessageBody(config.accountId, folderPath, uid)) continue
    want.push(uid)
  }
  if (want.length === 0) return

  try {
    await withConnection(config, secret, async (client) => {
      const lock = await client.getMailboxLock(folderPath, { readOnly: true })
      try {
        await fetchBodies(client, config.accountId, folderPath, want)
      } finally {
        lock.release()
      }
    })
  } catch (e) {
    console.error('[aevistle] adjacent body prefetch failed:', e)
  }
}

/** How many mailboxes a test reports on, largest first. */
const FOLDER_REPORT_LIMIT = 12

/**
 * Message counts for every mailbox the account has, so a test can answer
 * "where did my mail go" and not only "is INBOX empty".
 *
 * Archiving in Gmail moves a message out of INBOX and leaves it in All Mail;
 * deleting moves it to Trash; a filter can put it anywhere. Reporting only
 * INBOX makes all three look identical — an empty inbox with no explanation.
 *
 * Entirely best effort. A mailbox that refuses STATUS is skipped rather than
 * failing the test, because the test's real job is proving the connection
 * works, and this is extra context on top of that.
 */
async function listFolderCounts(
  client: ImapFlow,
): Promise<Array<{ path: string; total: number; unseen: number; role?: string }>> {
  try {
    const boxes = await client.list()
    const rows: Array<{ path: string; total: number; unseen: number; role?: string }> = []

    for (const box of boxes) {
      // \Noselect mailboxes are pure containers ("[Gmail]"), not message stores.
      if (box.flags?.has('\\Noselect')) continue
      const status = await client
        .status(box.path, { messages: true, unseen: true })
        .catch(() => null)
      if (!status) continue
      rows.push({
        path: box.path,
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
        role: box.specialUse ? box.specialUse.replace('\\', '') : undefined,
      })
    }

    return rows.sort((a, b) => b.total - a.total).slice(0, FOLDER_REPORT_LIMIT)
  } catch {
    return []
  }
}

/**
 * Probe the receive endpoint without saving anything or touching the cache.
 *
 * Deliberately the mirror image of the SMTP test button: same endpoint ladder,
 * same time budget, same "tell them what to change" error shape. It opens
 * INBOX read-only and reports the counts, because "connected" on its own is
 * not the question a user is asking — they want to know whether *their* mail
 * is on the other end of it.
 */
export async function testInbox(
  config: InboxAccountState,
  secret: string | null,
): Promise<SendResult> {
  const started = Date.now()

  if (!config.imapHost.trim()) {
    return {
      ok: false,
      accepted: [],
      rejected: [],
      durationMs: 0,
      error: 'No IMAP server set',
      errorKind: 'config',
    }
  }
  if (!(await hasCredential(config, secret))) {
    return {
      ok: false,
      accepted: [],
      rejected: [],
      durationMs: 0,
      error: 'No password stored for receiving',
      errorKind: 'auth',
    }
  }

  let used: Endpoint | null = null
  let attempts = 0

  try {
    const counts = await withConnection(
      config,
      secret,
      async (client) => {
        const lock = await client.getMailboxLock(INBOX_PATH, { readOnly: true })
        let inboxTotal = 0
        let inboxUnseen = 0
        try {
          const mailbox = client.mailbox
          if (!mailbox) throw new Error('INBOX did not open')
          const status = await client.status(INBOX_PATH, { unseen: true }).catch(() => null)
          inboxTotal = mailbox.exists
          inboxUnseen = status?.unseen ?? 0
        } finally {
          lock.release()
        }

        // Counts for the other mailboxes, gathered outside the lock so a slow
        // server cannot hold INBOX selected while we walk the list. Best
        // effort throughout: this is diagnostic colour, and a provider that
        // refuses LIST should still get a working test result.
        const folders = await listFolderCounts(client)
        return { total: inboxTotal, unseen: inboxUnseen, folders }
      },
      (endpoint) => {
        used = endpoint
        attempts++
      },
    )

    const endpoint = used as Endpoint | null
    return {
      ok: true,
      accepted: [],
      rejected: [],
      durationMs: Date.now() - started,
      mailbox: counts,
      diagnostics: {
        securityUsed: endpoint?.security ?? config.imapSecurity,
        port: endpoint?.port ?? config.imapPort,
        host: config.imapHost,
        stage: 'done',
        attempts: Math.max(attempts, 1),
        adjusted:
          !!endpoint &&
          (endpoint.port !== config.imapPort || endpoint.security !== config.imapSecurity),
      },
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    // Classification reads the raw text — `classifyError` matches on OpenSSL
    // and provider wording, which a sentence written for a person would
    // destroy. What reaches the screen is the other way round.
    //
    // The sending half was given this treatment and the receiving half was
    // not, so a failed inbox test still put 120 unbroken characters of
    // BoringSSL into the dialog, and a Microsoft account — which cannot sign
    // in with a password at all any more — got a bare `AUTHENTICATIONFAILED`
    // while the paragraph explaining exactly that sat unused.
    const message = renderTransportError(
      summarizeTransportError(raw, {
        host: config.imapHost,
        port: config.imapPort,
        security: config.imapSecurity,
      }),
    )
    return {
      ok: false,
      accepted: [],
      rejected: [],
      durationMs: Date.now() - started,
      error: message,
      errorKind: classifyError(raw),
      diagnostics: {
        securityUsed: config.imapSecurity,
        port: config.imapPort,
        host: config.imapHost,
        stage: classifyError(raw) === 'auth' ? 'auth' : 'connect',
        attempts: Math.max(attempts, 1),
      },
    }
  }
}

export async function fetchMessageBody(
  config: InboxAccountState,
  secret: string | null,
  folderPath: string,
  uid: number,
): Promise<InboxMessageBody> {
  const cached = await readMessageBody(config.accountId, folderPath, uid)
  if (cached) return cached

  if (!(await hasCredential(config, secret))) {
    throw new Error('No IMAP password stored for this account')
  }
  return withConnection(config, secret, async (client) => {
    const lock = await client.getMailboxLock(folderPath)
    try {
      const full = await client.fetchOne(uid, { source: true }, { uid: true })
      if (!full || !full.source) throw new Error('Message not found')
      const result = await parseCacheAndReturn(config.accountId, folderPath, uid, full.source)
      return {
        text: result.text,
        sanitizedHtml: result.sanitizedHtml,
        attachments: result.attachments,
        remoteImages: result.remoteImages,
        icsParts: result.icsParts,
      }
    } finally {
      lock.release()
    }
  })
}

/**
 * Re-exported so `main.ts` goes on importing it from beside the function that
 * produces it. The definition, and what each `reason` means, lives in
 * `src/core/types.ts` — shared with the Android plugin, which answers the same
 * question over a completely separate code path, and with the renderer, which
 * is the one place both answers arrive.
 */
export type { SeenFlagResult }

/**
 * Mirror the read state to the server's `\Seen` flag, and say whether it
 * landed.
 *
 * Still never throws, and the caller still applies the change locally either
 * way — a server that is briefly unreachable must not block "mark as read" in
 * the window the user is looking at. What changed is that it no longer *lies*.
 * The old version returned `void`, no-op'd when there were no credentials, and
 * swallowed every error into an empty catch, so the caller had no way to
 * distinguish "the mailbox now agrees" from "nothing happened at all".
 * Both spellings of failure end the same way: the next sync reads the
 * server's flags back, the message returns to unread, and the user watches a
 * mail they have read mark itself unread again — with nothing in any log to say
 * why.
 */
export async function setServerSeenFlag(
  config: InboxAccountState,
  secret: string | null,
  folderPath: string,
  uid: number,
  seen: boolean,
): Promise<SeenFlagResult> {
  if (!(await hasCredential(config, secret))) {
    console.error(
      `[aevistle] cannot mirror \\Seen for ${config.accountId} ${folderPath}:${uid} — no password or OAuth grant for this mailbox`,
    )
    return { ok: false, reason: 'no-credential' }
  }
  try {
    await withConnection(config, secret, async (client) => {
      const lock = await client.getMailboxLock(folderPath)
      try {
        if (seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true })
      } finally {
        lock.release()
      }
    })
    return { ok: true }
  } catch (e) {
    // Enough to act on: which mailbox, which message, which direction, and the
    // error itself. A bare "flag update failed" would be one more line nobody
    // can do anything with.
    console.error(
      `[aevistle] could not set \\Seen=${seen} on ${config.accountId} ${folderPath}:${uid}:`,
      e,
    )
    return { ok: false, reason: 'failed' }
  }
}

/**
 * Delete messages on the server.
 *
 * The opposite of `setServerSeenFlag` in temperament: this one throws. A read
 * flag that failed to mirror costs nothing and fixes itself on the next sync,
 * but a deletion that failed while the row already vanished from the app reads
 * as "deleted" for a message still sitting in the mailbox — and the user finds
 * out weeks later from another client, if at all. Every silent-failure bug
 * this project has fixed had that shape.
 *
 * `messageDelete` is used rather than adding `\Deleted` by hand: ImapFlow
 * routes it through MOVE to the Trash folder where the server supports it and
 * falls back to flag-plus-expunge where it does not, which is the behaviour
 * people expect from "delete" in every other mail client.
 *
 * Grouped by folder because each one needs its own mailbox lock, and deleting
 * by uid across folders would otherwise silently address the wrong messages —
 * uids are only unique within a mailbox.
 */
export async function purgeMessages(
  config: InboxAccountState,
  secret: string | null,
  items: Array<{ folderPath: string; uid: number }>,
): Promise<void> {
  if (items.length === 0) return
  if (!(await hasCredential(config, secret))) throw new Error('No password saved for this mailbox')

  const byFolder = new Map<string, number[]>()
  for (const { folderPath, uid } of items) {
    const list = byFolder.get(folderPath)
    if (list) list.push(uid)
    else byFolder.set(folderPath, [uid])
  }

  await withConnection(config, secret, async (client) => {
    for (const [folderPath, uids] of byFolder) {
      const lock = await client.getMailboxLock(folderPath)
      try {
        const done = await client.messageDelete(uids, { uid: true })
        // ImapFlow answers `false` for "the server did not do it" without
        // throwing. Letting that through would be the same silent success the
        // rest of this comment is about.
        if (!done) throw new Error(`The server refused to delete from ${folderPath}`)
      } finally {
        lock.release()
      }
    }
  })
}
