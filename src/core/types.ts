/**
 * Aevistle — shared domain model.
 *
 * Everything in `src/core` is platform-agnostic: it runs unchanged inside the
 * Electron renderer and inside the Android WebView. Anything that needs an OS
 * (sockets, keystore, file dialogs, alarms) goes through `PlatformBridge`.
 */

import type { SendCondition } from './conditions'
import type { OutboxItem } from './outbox'
import type { DraftSnapshot } from './snapshots'
import type { CalendarWarning, WorkCalendar, WorkdayPolicy } from './workCalendar'

export type Platform = 'desktop' | 'android' | 'web'

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type TransportSecurity = 'ssl' | 'starttls' | 'none'
export type AuthMethod = 'password' | 'none'

/**
 * What a stored credential is *for*. Both keystores (`electron/store.ts`'s
 * `secrets.json`, Android's `SecretStore.java`) key by account id alone —
 * `'smtp'` keeps that bare key so every secret ever written stays readable
 * with zero migration; `'imap'` gets a namespaced key so a receiving
 * credential for the same account can never collide with (and silently
 * overwrite) the sending one.
 */
export type SecretKind = 'smtp' | 'imap'

/**
 * An outgoing mail account. Note what is *absent*: the password. Secrets live
 * in the OS keystore (DPAPI on Windows, EncryptedSharedPreferences on Android)
 * and are referenced by `id` only, so this object is safe to serialise to disk
 * and safe to export.
 */
export interface MailAccount {
  id: string
  label: string
  fromName: string
  fromAddress: string
  replyTo?: string
  host: string
  port: number
  security: TransportSecurity
  username: string
  authMethod: AuthMethod
  /** True when a secret for this account exists in the OS keystore. */
  hasSecret: boolean
  providerId?: string
  /**
   * Free-text group this account belongs to — "Work", "Personal", a client's
   * name. Purely an organising device: it changes how accounts are listed and
   * picked, never which one is used. Optional, so every account written by an
   * earlier build reads as ungrouped rather than as a group called `undefined`.
   */
  group?: string
  /** Socket + greeting timeout for a *single* connection attempt. */
  timeoutMs: number
  /**
   * When the chosen port/encryption pair fails at the handshake, try the other
   * pairs that are plausible for this port before giving up.
   *
   * This exists because "Unexpected socket close" is what a server sends when
   * you speak plaintext at an implicit-TLS port (or the reverse), and that
   * message tells a non-technical user nothing they can act on. Trying the two
   * other combinations takes a few seconds and usually just works.
   */
  autoNegotiate: boolean
  /**
   * Accept self-signed / mismatched TLS certificates. Off by default and
   * surfaced in the UI as a red toggle — it disables the only protection
   * against an active network attacker reading your mail password.
   */
  allowInvalidCert: boolean
  /** Max messages per connection before reconnecting (provider rate limits). */
  poolMaxMessages: number
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type BodyFormat = 'plain' | 'html' | 'markdown'
export type Priority = 'low' | 'normal' | 'high'

export interface Attachment {
  id: string
  name: string
  size: number
  mime: string
  /**
   * `path`  — reference the file where it sits (immediate sends).
   * `copy`  — an app-private snapshot taken at scheduling time, so a reminder
   *           set for 03:00 still finds its attachment if the original moved.
   * `imap`  — listed on a received message but not yet downloaded. `path` is
   *           empty until something asks for it; see `ensureAttachment`.
   */
  source: 'path' | 'copy' | 'imap'
  /** Empty for an `imap` attachment that has not been downloaded yet. */
  path: string
  /**
   * Which attachment part of the source message this was, counting only
   * attachments and in document order.
   *
   * The identity a later download has to work from. The `id` cannot serve:
   * it is minted per parse, and a body read back out of the on-disk cache has
   * to name the same MIME part the server still holds.
   */
  partIndex?: number
  addedAt: number
  /** Embed in the HTML body rather than attaching (images only). */
  inline: boolean
  cid?: string
}

export interface MessageDraft {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  bodyFormat: BodyFormat
  attachments: Attachment[]
  accountId: string
  priority: Priority
  requestReadReceipt: boolean
  /** Send one message per recipient instead of exposing the whole To: list. */
  individualDelivery: boolean
  /**
   * Expand `{{name}}` and friends per recipient before sending — a mail merge.
   * Implies one message each, so it supersedes `individualDelivery` when on.
   * Optional: absent means off, which is what every existing draft means.
   */
  mergeEnabled?: boolean
}

export function emptyDraft(accountId = ''): MessageDraft {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    bodyFormat: 'plain',
    attachments: [],
    accountId,
    priority: 'normal',
    requestReadReceipt: false,
    individualDelivery: false,
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type RecurrenceKind =
  | 'once'
  | 'interval'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'cron'

export type EndMode = 'never' | 'onDate' | 'afterCount'

/**
 * What to do when the machine was asleep across a fire time.
 * `fireOnce` — send one catch-up message on wake (default; a reminder you
 *              missed is still worth having).
 * `skip`     — drop missed runs silently.
 */
export type CatchUpPolicy = 'fireOnce' | 'skip'

export interface Recurrence {
  kind: RecurrenceKind
  /** Epoch ms. For repeating kinds this is the earliest allowed fire time. */
  startAt: number
  /** 'HH:mm', local time — used by daily / weekly / monthly / yearly. */
  timeOfDay: string
  intervalMinutes?: number
  /**
   * Sub-minute repeat cadence for the `'interval'` kind. Takes precedence over
   * `intervalMinutes` when set. Deliberately not extended to the calendar
   * kinds (daily/weekly/monthly/yearly/cron) — nobody schedules "every day at
   * 09:00:00.250", and those branches stay minute-granular on purpose.
   */
  intervalMs?: number
  /** 0 = Sunday … 6 = Saturday. */
  weekdays?: number[]
  dayOfMonth?: number
  /** A 31st in a 30-day month: clamp to the last day, or skip that month. */
  monthDayFallback: 'last' | 'skip'
  /**
   * Which month a yearly rule fires in. **0 = January**, matching
   * `Date.getMonth()`.
   *
   * Spelled out because it once was not: three of the four places that touch
   * this field agreed on 0-based and the fourth — the one that decides whether
   * a given day is a send day — read it as 1-based.
   */
  month?: number
  /** Standard 5-field cron: minute hour day-of-month month day-of-week. */
  cron?: string
  endMode: EndMode
  endDate?: number
  maxRuns?: number
  /** Random 0..n second delay per run, to dodge provider burst limits. */
  jitterSeconds: number
  /** Push Sat/Sun fires to the next Monday. */
  skipWeekends: boolean
  /**
   * What to do when a fire time lands on a non-working day — a weekend, or a
   * public holiday from the calendar in `Settings.workCalendar`.
   *
   * Strictly more expressive than `skipWeekends` above, which stays for the
   * jobs that already use it: this one knows about holidays and make-up
   * workdays, and can move a reminder *earlier* rather than only later. Absent
   * means `'off'`, so nothing changes for a schedule written before it existed.
   */
  workdayPolicy?: WorkdayPolicy
  catchUp: CatchUpPolicy
}

export function defaultRecurrence(now = Date.now()): Recurrence {
  const start = new Date(now + 5 * 60_000)
  return {
    kind: 'once',
    startAt: start.getTime(),
    timeOfDay: `${pad2(start.getHours())}:${pad2(start.getMinutes())}`,
    monthDayFallback: 'last',
    endMode: 'never',
    jitterSeconds: 0,
    skipWeekends: false,
    catchUp: 'fireOnce',
  }
}

export interface RetryPolicy {
  maxAttempts: number
  backoffSeconds: number
  backoffFactor: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffSeconds: 60,
  backoffFactor: 3,
}

export type JobStatus = 'idle' | 'armed' | 'running' | 'done' | 'failed' | 'paused'

/** Highest `count` a burst may request — a hard cap, not a soft warning. */
export const MAX_BURST_COUNT = 500

/**
 * Send the same message more than once when a job fires, paced rather than
 * all at once. Attached to the job (not the recurrence) because it is a
 * property of "what happens at fire time", independent of how often the fire
 * time itself repeats.
 */
export interface BurstPolicy {
  enabled: boolean
  /** 1..MAX_BURST_COUNT. Rejected outright above the cap, not just warned. */
  count: number
  /** Delay between each send in the burst. */
  pacingMs: number
}

export const DEFAULT_BURST: BurstPolicy = {
  enabled: false,
  count: 1,
  pacingMs: 200,
}

export interface ScheduledJob {
  id: string
  name: string
  enabled: boolean
  draft: MessageDraft
  recurrence: Recurrence
  /** Precomputed upcoming fire times, ascending. Refilled by the core. */
  occurrences: number[]
  runCount: number
  lastRunAt?: number
  lastResult?: 'ok' | 'failed'
  lastError?: string
  retry: RetryPolicy
  status: JobStatus
  burst?: BurstPolicy
  /**
   * Set when this job was created as one stage of a multi-stage reminder —
   * "a week before, the day before, and on the day". Jobs in a chain share the
   * id, and the schedule screen groups them by it.
   *
   * Optional, and everything that does not know about chains keeps working:
   * the scheduler, retries, quiet hours and the control API all see an
   * ordinary job. See `core/chain.ts`.
   */
  chainId?: string
  /** How far before the event this stage fires, in ms. 0 is the event itself. */
  chainLeadMs?: number
  /**
   * Checks made at fire time. All must pass or the run is skipped — with a log
   * line saying which one blocked it, never in silence. See `core/conditions`.
   */
  conditions?: SendCondition[]
  /**
   * Set when the working calendar could not honour this job's `workdayPolicy`
   * — a fire time it had to drop entirely, or a pile-up it had to leave sharing
   * an instant. Absent means the last recomputation was clean.
   *
   * Stored on the job rather than only logged because a log line scrolls away
   * and a reminder that will never be sent should keep saying so. See
   * `core/workCalendar.ts`.
   */
  calendarWarning?: CalendarWarning
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Results & logs
// ---------------------------------------------------------------------------

export type ErrorKind =
  | 'auth'
  | 'network'
  | 'tls'
  /** The port and the encryption mode disagree — the server hung up mid-handshake. */
  | 'handshake'
  /** No answer at all within the deadline. Distinct from a refused connection. */
  | 'timeout'
  | 'recipient'
  | 'attachment'
  | 'quota'
  | 'config'
  | 'unknown'

/**
 * What actually happened on the wire.
 *
 * Reported for successes as well as failures: "connected in 380 ms over
 * TLS 1.3" is the difference between a user trusting the Save button and a
 * user wondering whether the green tick meant anything.
 */
export interface TransportDiagnostics {
  /** The encryption mode that finally worked — may differ from the one asked for. */
  securityUsed: TransportSecurity
  port: number
  host: string
  /** How far it got: dns → connect → tls → greeting → auth → done. */
  stage: 'dns' | 'connect' | 'tls' | 'greeting' | 'auth' | 'done'
  /** Number of encryption modes tried before one worked. */
  attempts: number
  /** True when auto-negotiation had to override the user's chosen mode. */
  adjusted?: boolean
}

export interface SendResult {
  ok: boolean
  /**
   * The run was deliberately not attempted because a send condition said so.
   * Kept distinct from both success and failure: nothing went wrong, and
   * nothing was delivered, and a UI that shows only a green tick or a red cross
   * has to lie about one of the two.
   */
  skipped?: boolean
  /** Translation key naming the condition that blocked it. */
  skipReasonKey?: string
  skipReasonValues?: Record<string, string | number>
  messageId?: string
  accepted: string[]
  rejected: string[]
  durationMs: number
  error?: string
  /** Machine-readable failure class, used to decide whether retrying helps. */
  errorKind?: ErrorKind
  diagnostics?: TransportDiagnostics
  /**
   * Only set by an inbox connection test: what the server reported for INBOX.
   * A test that connects but shows "0 messages" against a mailbox the user
   * knows is full is a different problem from one that cannot connect at all,
   * and without these numbers the two look identical on screen.
   *
   * `folders` is the rest of the account's mailboxes with their counts. It
   * answers the question INBOX alone cannot: mail that has been archived is
   * gone from INBOX but still sitting in All Mail, and telling that apart from
   * mail that was actually deleted is the difference between "nothing is
   * wrong" and "something ate your mail".
   */
  mailbox?: {
    total: number
    unseen: number
    folders?: Array<{ path: string; total: number; unseen: number; role?: string }>
  }
}

export interface LogEntry {
  id: string
  at: number
  kind: 'send' | 'schedule' | 'error' | 'system' | 'security'
  level: 'info' | 'warn' | 'error'
  title: string
  detail?: string
  jobId?: string
  recipients?: number
  durationMs?: number
  /**
   * The `Message-ID` the server gave this send. It is the only durable link
   * between "we sent this" and a bounce that arrives twenty minutes later in
   * the inbox — see `core/receipts`. Optional: entries written before delivery
   * tracking existed simply cannot be correlated, which is the truth.
   */
  messageId?: string
}

// ---------------------------------------------------------------------------
// Contacts, templates, settings
// ---------------------------------------------------------------------------

export interface Contact {
  id: string
  name: string
  address: string
  tags: string[]
  note?: string
  /**
   * Extra columns for mail merge: `{{company}}`, `{{invoice}}`, whatever this
   * particular list needs. Every key here becomes a usable `{{variable}}` for
   * that recipient — see `core/mergeVars`.
   */
  fields?: Record<string, string>
  /** Keep at the top of the list, above the alphabet. */
  pinned?: boolean
  createdAt: number
}

export interface Template {
  id: string
  name: string
  subject: string
  body: string
  bodyFormat: BodyFormat
  createdAt: number
  updatedAt: number
}

export type ThemeMode = 'system' | 'light' | 'dark'
export type AccentId = 'azure' | 'indigo' | 'teal' | 'violet' | 'amber' | 'rose' | 'emerald'
export type Density = 'comfortable' | 'compact'
export type LocaleId = 'en' | 'zh-CN' | 'fr' | 'es' | 'ru' | 'ar'
/**
 * What the user picked, which is not the same as which language is showing.
 * `'system'` defers to the OS display language and keeps deferring to it, so a
 * machine that changes language does not leave the app behind.
 */
export type LocalePreference = LocaleId | 'system'

export interface Settings {
  themeMode: ThemeMode
  accent: AccentId
  density: Density
  locale: LocalePreference
  /** Ask before sending to more than N recipients at once. */
  bulkConfirmThreshold: number
  /** Warn when total attachment size exceeds this (MB). */
  attachmentWarnMb: number
  /** Hard refusal above this (MB) — most providers reject past ~25 MB. */
  attachmentMaxMb: number
  /** Snapshot attachments into app storage when scheduling. */
  snapshotAttachments: boolean
  notifyOnSuccess: boolean
  notifyOnFailure: boolean
  minimiseToTray: boolean
  launchAtLogin: boolean
  logRetentionDays: number
  /**
   * Hard ceiling on how many activity entries are kept, whatever their age.
   *
   * Days alone is not a retention policy on a busy account: a thousand sends
   * inside the window are a thousand rows of recipients still on disk. Both
   * limits apply, and whichever bites first wins.
   */
  logMaxEntries: number
  /** Redact recipient addresses in the on-disk log. */
  redactLogs: boolean

  // --- delivery limits ----------------------------------------------------
  /**
   * Hold scheduled sends that land inside a nightly window until it ends.
   * An immediate send is never held — the user is standing right there.
   */
  quietHoursEnabled: boolean
  /** 'HH:mm' local. Start may be later than end; the window then wraps midnight. */
  quietStart: string
  quietEnd: string
  /** Seconds to wait for one connection attempt before moving on. */
  connectTimeoutSeconds: number
  /**
   * Which days count as working days, shared by every schedule that opts into
   * `Recurrence.workdayPolicy`. Optional so an older install reads as "the
   * usual Saturday and Sunday, no holidays".
   */
  workCalendar?: WorkCalendar
  /**
   * Hold a send that fails for a reason a retry could fix, and try again on a
   * backoff instead of losing it. On by default — the alternative is retyping.
   */
  offlineQueueEnabled?: boolean
  /** Keep a rolling history of the compose draft so a mistake is recoverable. */
  draftHistoryEnabled?: boolean

  // --- updates ------------------------------------------------------------
  /** Ask GitHub for the latest release when the app starts. Sends no user data. */
  updateCheckOnStart: boolean

  // --- control interface ----------------------------------------------------
  /**
   * Let other programs on this machine — Claude Code, a script, a scheduler —
   * read the app's state and create reminders. Off by default: it opens a
   * loopback port, and a port nobody asked for is an attack surface nobody
   * audited. Optional so an install written by an older build reads as off.
   */
  controlEnabled?: boolean
  /**
   * Additionally let those callers send mail immediately. Separate from the
   * switch above on purpose: reading state and queuing a reminder can be
   * undone, and mail that has left cannot.
   */
  controlAllowSending?: boolean

  // --- sending account -----------------------------------------------------
  /**
   * Preferred sender for new drafts. When unset, `upsertAccount` falls back to
   * "first account added" — the behaviour every earlier build already had, so
   * leaving this unset changes nothing for an existing install.
   */
  defaultAccountId?: string

  // --- inbox cache ----------------------------------------------------------
  /** Eviction ceiling for cached message bodies/attachments, combined across accounts. */
  inboxCacheMaxMb: number
  /** Cached bodies older than this (and already read) are evicted first. */
  inboxCacheRetentionDays: number
  /**
   * How often enabled accounts are checked for new mail, in minutes. `0` turns
   * automatic checking off and leaves only the refresh button.
   *
   * Optional so an install written by an older build keeps working: absent
   * means "use the default", not "never check".
   */
  inboxSyncMinutes?: number
  /**
   * Hold a connection open per receiving account so new mail arrives at once
   * instead of at the next check. Optional and defaults to on; the timed check
   * keeps running either way, so turning this off costs latency only.
   */
  inboxPush?: boolean
  /**
   * Raise a system notification when a verification code arrives, carrying the
   * code itself so it can be read without opening anything.
   *
   * Optional and defaults to on. Only high-confidence hits qualify: a
   * notification that fires on a guess trains people to ignore the ones that
   * are right.
   */
  notifyOnCode?: boolean
  /**
   * Row height across the list screens. `standard` is the default; `compact`
   * fits about a third more rows, `roomy` is for reading at a distance.
   *
   * Distinct from `density`, which is the global control spacing scale — this
   * one only moves list rows, and the two are set from different places.
   */
  listDensity?: 'compact' | 'standard' | 'roomy'
  /**
   * Whether the remote-image control in Settings has ever been used.
   *
   * A migration marker, not a preference: see `effectiveImagePolicy`. It is
   * app-wide because the thing it records — "the user has seen and answered
   * this question" — is app-wide, while the answer itself is stored per
   * account in `InboxAccountState.showRemoteImages`.
   */
  imagePolicyChosen?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'system',
  accent: 'azure',
  density: 'comfortable',
  locale: 'system',
  bulkConfirmThreshold: 10,
  attachmentWarnMb: 10,
  attachmentMaxMb: 25,
  snapshotAttachments: true,
  notifyOnSuccess: true,
  notifyOnFailure: true,
  minimiseToTray: true,
  launchAtLogin: false,
  logRetentionDays: 30,
  logMaxEntries: 500,
  redactLogs: false,
  quietHoursEnabled: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  connectTimeoutSeconds: 20,
  workCalendar: { weekend: [0, 6], holidays: [], workdays: [] },
  offlineQueueEnabled: true,
  draftHistoryEnabled: true,
  updateCheckOnStart: true,
  controlEnabled: false,
  controlAllowSending: false,
  inboxCacheMaxMb: 500,
  inboxCacheRetentionDays: 90,
  inboxSyncMinutes: 5,
  inboxPush: true,
  notifyOnCode: true,
  listDensity: 'standard',
  imagePolicyChosen: false,
}

// ---------------------------------------------------------------------------
// Inbox (receiving)
// ---------------------------------------------------------------------------

/**
 * Local-only, never synced back to the server as an IMAP keyword. Keeping it
 * device-local sidesteps negotiating PERMANENTFLAGS support per provider for
 * a feature that only needs to exist for this one user on this one device.
 */
export type InboxTag = 'none' | 'flagged' | 'important'

export interface InboxMessage {
  id: string
  accountId: string
  folderPath: string
  uid: number
  /** Stale cached UIDs are worthless the moment this changes — see InboxFolder. */
  uidValidity: number
  messageId?: string
  from: string
  to: string
  subject: string
  /** Epoch ms. */
  date: number
  snippet: string
  sizeBytes: number
  hasAttachments: boolean
  seen: boolean
  tag: InboxTag
  /** Whether the sanitized body is present in the on-disk cache right now. */
  bodyCached: boolean
}

export interface InboxFolder {
  id: string
  accountId: string
  path: string
  displayName: string
  /**
   * IMAP's UIDVALIDITY for this folder. If it changes between syncs, every
   * cached UID for the folder is stale and must be re-fetched from scratch —
   * getting this wrong silently mismatches a cached body to the wrong message.
   */
  uidValidity: number
  unreadCount: number
  totalCount: number
}

/**
 * What a received message is allowed to do about the images it points at.
 *
 * `always` is the default, and it does *not* mean the body iframe reaches the
 * network — it never does. The sanitizer still replaces every remote `<img
 * src>` with a blank pixel and hands the URLs back separately, and the CSP
 * still forbids the frame from loading anything but `data:`; "always" only
 * decides whether the reader kicks off the main-process fetch by itself
 * instead of waiting for a click. The SSRF/private-address shield in
 * `electron/remoteImage.ts` is on the same path either way.
 *
 * `never` keeps the blank pixels and the "load images" button.
 * `allowlist` loads automatically only for senders in `imageAllowlist`.
 */
export type RemoteImagePolicy = 'never' | 'always' | 'allowlist'

/**
 * The policy actually in force, with one piece of history folded in.
 *
 * `showRemoteImages` shipped for two releases as scaffolding: it was declared,
 * defaulted to `'never'`, and never read or written by anything. So a stored
 * `'never'` in an install made before this was wired up is the old default,
 * not a decision anyone made — and honouring it would leave existing users
 * with images blocked while a fresh install shows them. `imagePolicyChosen`
 * records the first time the user actually touches the control; until then a
 * stored `'never'` is treated as the new default.
 */
export function effectiveImagePolicy(
  stored: RemoteImagePolicy | undefined,
  chosen: boolean | undefined,
): RemoteImagePolicy {
  const value = stored ?? 'always'
  if (value === 'never' && !chosen) return 'always'
  return value
}

/**
 * The domain an address belongs to, lowercased — `"Bank <no-reply@Bank.com>"`
 * becomes `"bank.com"`. Empty string when the header does not contain one,
 * which callers must treat as "not allowlistable" rather than as a wildcard.
 */
export function senderDomain(from: string): string {
  const angled = /<([^>]*)>/.exec(from)
  const address = (angled ? angled[1] : from).trim()
  const at = address.lastIndexOf('@')
  if (at < 0) return ''
  return address.slice(at + 1).trim().toLowerCase().replace(/[>\s]+$/, '')
}

/**
 * Whether this message's images should load without being asked for.
 *
 * The allowlist matches the sender's domain and its subdomains, so adding
 * `example.com` also covers `mail.example.com` — the alternative is a list
 * that grows one entry per sending host and still misses the next one.
 */
export function shouldAutoLoadImages(
  policy: RemoteImagePolicy,
  from: string,
  allowlist: string[] | undefined,
): boolean {
  if (policy === 'always') return true
  if (policy !== 'allowlist') return false
  const domain = senderDomain(from)
  if (!domain) return false
  return (allowlist ?? []).some((entry) => {
    const allowed = entry.trim().toLowerCase()
    return allowed.length > 0 && (domain === allowed || domain.endsWith(`.${allowed}`))
  })
}

export interface InboxAccountState {
  accountId: string
  enabled: boolean
  imapHost: string
  imapPort: number
  imapSecurity: TransportSecurity
  imapUsername: string
  imapAllowInvalidCert: boolean
  folders: InboxFolder[]
  /** Lightweight rows only — bodies/attachments live in the on-disk cache, not here. */
  messages: InboxMessage[]
  lastSyncAt?: number
  lastSyncError?: string
  showRemoteImages: RemoteImagePolicy
  imageAllowlist: string[]
  /**
   * Messages removed from this app but still on the server.
   *
   * Without this list "delete" was cosmetic: the row vanished, and the next
   * automatic sync — five minutes later by default — fetched the same message
   * back off the server and put it straight back. Nothing recorded that it had
   * been removed, so nothing could filter it out.
   *
   * The whole row is kept, not just the uid, so restoring is instant and works
   * even for a message that has since fallen outside the window a sync looks
   * at. That is also what makes this list the recycle bin rather than a
   * separate structure holding the same thing twice.
   */
  removed?: RemovedMessage[]
}

export interface RemovedMessage {
  message: InboxMessage
  /** When it was removed, for the retention sweep. */
  at: number
}

/** How long a removed message stays restorable. */
export const REMOVED_RETENTION_MS = 7 * 86_400_000
/**
 * Hard ceiling on the recycle bin, applied before the age sweep.
 *
 * "Delete all" on a busy mailbox is one gesture that produces hundreds of
 * entries, and this list lives in `state.json` — the same file the log cap
 * exists to keep small.
 */
export const REMOVED_CAP = 500

export function defaultInboxAccountState(accountId: string): InboxAccountState {
  return {
    accountId,
    enabled: false,
    imapHost: '',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: '',
    imapAllowInvalidCert: false,
    folders: [],
    messages: [],
    // Shown, not blocked. Blocking by default protected against a read receipt
    // the sender gets for free, but it did it by making every HTML message
    // arrive visibly broken — and the fetch goes through the main process's
    // vetted path either way, so the iframe still never touches the network.
    showRemoteImages: 'always',
    imageAllowlist: [],
  }
}

/**
 * A verification code or sign-in link, kept in its own list rather than being
 * recomputed from the mailbox cache every time the screen opens.
 *
 * Two reasons it is stored and not derived. A code is wanted *now* — reading
 * bodies back out of the cache to re-extract it puts an IMAP round trip
 * between the user and the six digits they are waiting for. And the mail it
 * came from is routinely deleted the moment the code has been used, which is
 * exactly when someone discovers they needed it a second time.
 */
export interface CodeHit {
  id: string
  kind: 'code' | 'link'
  value: string
  confidence: 'high' | 'medium' | 'low'
  /** Which part of the message produced it — a wrong answer has to be explainable. */
  source: 'subject' | 'body' | 'link'
  accountId: string
  messageId: string
  /** Sender, as it appeared on the message. */
  from: string
  subject: string
  /** When the message was sent (epoch ms). */
  date: number
  /** When this app first saw it (epoch ms). */
  foundAt: number
  /** Set the first time it was copied, so "already used" can be shown. */
  copiedAt?: number
  /**
   * Set the first time the card was opened, whether or not the copy succeeded.
   *
   * Separate from `copiedAt` on purpose: a code can be read off the screen and
   * typed by hand into a phone, and that still means the user is done with it.
   * Tying "dealt with" to a successful clipboard write would leave those cards
   * looking unhandled forever.
   */
  readAt?: number
}

/**
 * An address the user has actually sent to, with how often and how recently.
 *
 * The contact book answers "who do I know"; this answers "who do I write to",
 * and they are not the same list. Kept separate from `Contact` so that using
 * an address once never silently adds a permanent contact record.
 */
export interface RecentRecipient {
  address: string
  /** Display name, when one was known at the time. */
  name?: string
  count: number
  lastUsedAt: number
}

export interface AppState {
  accounts: MailAccount[]
  jobs: ScheduledJob[]
  contacts: Contact[]
  templates: Template[]
  logs: LogEntry[]
  settings: Settings
  draft: MessageDraft
  inboxAccounts: InboxAccountState[]
  /** Recent versions of the compose draft, newest first. See `core/snapshots`. */
  draftSnapshots: DraftSnapshot[]
  /** Sends waiting for the network to come back. See `core/outbox`. */
  outbox: OutboxItem[]
  /** Verification codes and sign-in links, newest first. */
  codeHits: CodeHit[]
  /** Addresses sent to before, for the compose screen's quick picks. */
  recentRecipients: RecentRecipient[]
  schemaVersion: number
}

/**
 * Bumped for documentation only — every field added since v1 is optional or
 * has a default folded in at hydration time (`{ ...DEFAULT, ...stored }` in
 * `AppState.tsx`), so old `state.json` files load unchanged with no migrate
 * step required.
 */
export const SCHEMA_VERSION = 2

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function newId(prefix = ''): string {
  const rnd =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}_${rnd}` : rnd
}
