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
import type {
  InboxAccountState,
  InboxFolder,
  InboxMessage,
  InboxTag,
  SendResult,
} from '../src/core/types'
import {
  endpointLadder,
  renderTransportError,
  rungBudgetMs,
  summarizeTransportError,
  totalBudgetMs,
  withDeadline,
  type Endpoint,
} from '../src/core/transport'
import { classifyError, type InboxMessageBody } from '../src/core/bridge'
import { resolveHostCached } from './mailer'
import { sanitizeMessageHtml } from './sanitizeHtml'
import { readMessageBody, writeInboxAttachments, writeMessageBody } from './inboxStore'

const INBOX_PATH = 'INBOX'
/** How many of the most recent messages populate the list per sync. */
const LIST_FETCH_LIMIT = 50
/** Of those, how many also get their body downloaded and cached eagerly. */
const BODY_PREFETCH_LIMIT = 15
/** Skip eager prefetch above this size; the message is still listed, its body just loads on demand. */
const PREFETCH_MAX_BYTES = 5 * 1024 * 1024

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
 */
function isAuthFailure(err: unknown): boolean {
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
  })

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
async function withConnection<T>(
  config: InboxAccountState,
  secret: string,
  run: (client: ImapFlow) => Promise<T>,
  /** Filled in with the rung that actually worked, for the test report. */
  onEndpoint?: (endpoint: Endpoint, client: ImapFlow) => void,
): Promise<T> {
  assertSafeConfig(config)

  const ladder = endpointLadder(config.imapPort, config.imapSecurity, true)
  const totalMs = totalBudgetMs(30)
  const resolvedHost = await resolveHostCached(config.imapHost, Math.min(totalMs / 2, 8_000))
  const perRung = rungBudgetMs(totalMs, ladder.length)

  let lastError: Error = new Error('No connection attempt was made')

  for (const endpoint of ladder) {
    const client = buildClient(config, secret, resolvedHost, endpoint, perRung)
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
      if (isAuthFailure(err)) throw err
      if (connected && classifyError(err.message) === 'auth') throw err
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
): ImapFlow {
  const client = new ImapFlow({
    host: resolvedHost,
    port: endpoint.port,
    secure: endpoint.security === 'ssl',
    ...(endpoint.security === 'starttls' ? { doSTARTTLS: true } : {}),
    // SNI and certificate identity still check against the real hostname —
    // only the connection target was swapped for the pre-resolved IP.
    servername: config.imapHost,
    auth: { user: config.imapUsername, pass: secret },
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

async function runSync(client: ImapFlow, config: InboxAccountState): Promise<InboxAccountState> {
  const lock = await client.getMailboxLock(INBOX_PATH)
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

    // Newest first, and only the ones cheap enough to be worth downloading
    // eagerly — a code from thirty seconds ago is the point of this feature,
    // one from last week is not worth a synchronous fetch on every sync.
    const prefetchUids = new Set(
      [...rows]
        .sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0))
        .filter((m) => (m.size ?? 0) <= PREFETCH_MAX_BYTES)
        .slice(0, BODY_PREFETCH_LIMIT)
        .map((m) => m.uid),
    )

    const messages: InboxMessage[] = []
    let unreadCount = 0

    for (const row of rows) {
      const uid = row.uid
      if (!uid) continue
      const seen = row.flags?.has('\\Seen') ?? false
      if (!seen) unreadCount++

      const existing = priorByUid.get(uid)
      let bodyCached = existing?.bodyCached ?? false
      let hasAttachments = hasAttachmentPart(row.bodyStructure)
      let tag: InboxTag = existing?.tag ?? 'none'

      if (prefetchUids.has(uid) && !bodyCached) {
        try {
          const full = await client.fetchOne(uid, { source: true }, { uid: true })
          if (full && full.source) {
            const cached = await parseCacheAndReturn(config.accountId, INBOX_PATH, uid, full.source)
            bodyCached = true
            hasAttachments = cached.hasAttachments
          }
        } catch {
          // The message just loads on demand instead — never worth failing
          // the whole sync over one message's body.
        }
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
        subject: row.envelope?.subject ?? '',
        date: internalDateMs(row.internalDate),
        snippet: '',
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

export async function syncInbox(
  config: InboxAccountState,
  secret: string | null,
): Promise<InboxAccountState> {
  // Called unconditionally on save (see AppState.tsx's saveInboxAccount) so
  // that platforms with a native background sync (Android's periodic
  // WorkManager) always learn about a disable, not just an enable — a no-op
  // here, but that push is what lets the other side cancel its own work.
  if (!config.enabled) return config
  if (!secret) throw new Error('No IMAP password stored for this account')
  return withConnection(config, secret, (client) => runSync(client, config))
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
  if (!secret) {
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

  if (!secret) throw new Error('No IMAP password stored for this account')
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
 * Best-effort mirror of the read state to the server's `\Seen` flag. Never
 * throws — the caller always applies the change to local state regardless,
 * and a server that is briefly unreachable should not block "mark as read"
 * in the UI the user is looking at right now.
 */
export async function setServerSeenFlag(
  config: InboxAccountState,
  secret: string | null,
  folderPath: string,
  uid: number,
  seen: boolean,
): Promise<void> {
  if (!secret) return
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
  } catch {
    /* best-effort — see doc comment */
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
  if (!secret) throw new Error('No password saved for this mailbox')

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
