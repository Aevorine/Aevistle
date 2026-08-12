/**
 * Aevistle — shared domain model.
 *
 * Everything in `src/core` is platform-agnostic: it runs unchanged inside the
 * Electron renderer and inside the Android WebView. Anything that needs an OS
 * (sockets, keystore, file dialogs, alarms) goes through `PlatformBridge`.
 */

import type { CodeRule, ReasonCode } from './ops/codeExtract'
import type { DeliveryWindow } from './schedule/deliveryWindow'
import type { LinkPurpose, LinkRisk } from './mail/linkPurpose'
import type { SendCondition } from './schedule/conditions'
import type { OutboxItem } from './ops/outbox'
import type { DraftSnapshot } from './sync/snapshots'
import type { CalendarWarning, WorkCalendar, WorkdayPolicy } from './schedule/workCalendar'
import type { PairedDevice } from './sync/pairedDevices'
import type { ConflictSnapshot } from './sync/syncConflict'

export type Platform = 'desktop' | 'android' | 'web'

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type TransportSecurity = 'ssl' | 'starttls' | 'none'

/**
 * How an account proves who it is.
 *
 * `'oauth2'` is XOAUTH2 — the SASL mechanism both SMTP and IMAP accept a
 * bearer token through. It is not a nicety: Microsoft stopped accepting app
 * passwords for IMAP/POP/SMTP on personal accounts on 30 April 2026, so for an
 * outlook.com/hotmail.com/live.com address it is now the *only* mechanism that
 * works at all, and Google is travelling the same road.
 *
 * The stored secret for an OAuth2 account is the long-lived **refresh** token.
 * Access tokens are minted from it and held in memory only — they expire in
 * about an hour, so writing them to disk would buy nothing and widen what a
 * stolen keystore is worth. See `core/oauth.ts`.
 */
export type AuthMethod = 'password' | 'none' | 'oauth2'

/**
 * What a stored credential is *for*. Both keystores (`electron/store.ts`'s
 * `secrets.json`, Android's `SecretStore.java`) key by account id alone —
 * `'smtp'` keeps that bare key so every secret ever written stays readable
 * with zero migration; `'imap'` gets a namespaced key so a receiving
 * credential for the same account can never collide with (and silently
 * overwrite) the sending one. `'sync'` is the same idea for an 'ongoing'
 * paired device's long-lived key — see `core/pairedDevices.ts`'s `keyRef`.
 */
export type SecretKind = 'smtp' | 'imap' | 'sync'

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
  /**
   * Where this account sits in a list the user has arranged by hand.
   *
   * Optional, and absent on every account written before drag-ordering
   * existed. Sorting treats "no order" as "after everything that has one,
   * in the array order it already had", so a store that has never been
   * reordered looks exactly as it did — the field only starts mattering once
   * somebody drags something.
   *
   * One number, shared by both places accounts are listed. Settings reads
   * `state.accounts` and the inbox reads `state.inboxAccounts`, which are
   * separate arrays whose orders were never guaranteed to agree; hanging both
   * off this single field is what stops "third in Settings, first in the
   * inbox" from being possible at all, rather than something the two screens
   * have to be kept in step about by hand.
   */
  order?: number
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

/**
 * What another application handed us to send.
 *
 * Three OS mechanisms produce one of these — Android's share sheet, a
 * `mailto:` link, and Explorer's Send To menu — and they all mean the same
 * thing: someone was in another app, chose Aevistle, and brought part of a
 * message with them.
 *
 * Every field is optional because every source fills in a different subset. A
 * bare `mailto:someone@example.com` carries one address and nothing else; a
 * photo shared from the gallery carries one attachment and nothing else; a
 * "share this article" carries a subject and a body. Whatever is absent is
 * simply left as the user already had it.
 *
 * Deliberately not `Partial<MessageDraft>`. The sender is describing an
 * intention, not editing a draft, and these six fields are the whole of what
 * the platforms can express. Widening it would let another application decide
 * this app's `accountId`, `priority` or `bodyFormat`.
 */
export interface SharePayload {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  attachments?: Attachment[]
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
 * How long a `JobTombstone` is kept before it is pruned.
 *
 * Sync only happens while both devices are open at once (see
 * `core/syncLoop.ts`'s module doc), so two paired devices can easily go a
 * couple of weeks between exchanges. 90 days matches the longest existing
 * retention default (`inboxCacheRetentionDays`) — long enough that a phone
 * left in a drawer over a long trip still gets the cancellation, short enough
 * that the list does not grow forever for a job deleted years ago.
 */
export const JOB_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

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
  /**
   * `occurrences` before the working calendar and quiet hours shifted them —
   * what `computeOccurrences` produced, unshifted. And the `runCount` it was
   * computed against, since a run can end an `afterCount` rule on a day the
   * calendar never touched, which this cache would not otherwise know.
   *
   * Exists purely so that re-arming a job after a calendar or quiet-hours edit
   * can re-shape this list instead of re-running the day-by-day search that
   * built it — a search that depends only on the *recurrence*, never on the
   * calendar. Read as "no cache" when absent, which is true of every job the
   * moment it comes out of hydrate: see the comment where that is cleared for
   * why a value computed in a previous session is not trusted here, even if
   * it looks numerically still in the future.
   */
  rawOccurrences?: number[]
  /** The `runCount` `rawOccurrences` was computed against. See above. */
  rawOccurrencesRunCount?: number
  /**
   * `Settings.localDeviceId` of the one device allowed to actually fire this
   * job. Absent (the default, and every job from before this existed) means
   * "whichever device has it enabled" — unchanged behaviour, and the only
   * sane default for someone who has never paired a second device.
   *
   * Set once two devices are paired and syncing the same job: without this,
   * both devices' schedulers independently decide the same occurrence is
   * theirs to send, and a laptop and a phone that are both open near the
   * fire time can both send it. This field does not stop the job from
   * *syncing* everywhere — every device still sees it, can edit it, pause it,
   * or delete it — it only gates who is allowed to let it actually fire.
   * See `electron/scheduler.ts` and the Android `AevistleScheduler`/
   * `SendWorker`, which both read it the same way.
   */
  executorDeviceId?: string
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
  /**
   * When this person's mail should land — their time zone and working hours.
   *
   * Optional, and absent means "no window", which is why adding it changes
   * nothing for any contact that already exists: a reminder goes out when it
   * was scheduled unless somebody has said otherwise about this recipient.
   * See `core/deliveryWindow.ts` for what happens when several recipients'
   * windows cannot all be satisfied.
   */
  deliveryWindow?: DeliveryWindow
  createdAt: number
  /**
   * Optional so a contact saved before this existed still loads. Read as
   * `createdAt` at the point something needs a definite number — see
   * `core/syncScope.ts` and `core/syncConflict.ts`, the two places that
   * actually compare it, for why "never edited since creation" is the right
   * fallback rather than "just synced" (`Date.now()`), which would make every
   * pre-existing contact look like it just changed.
   */
  updatedAt?: number
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
/**
 * `runecircuit`'s own two-axis accent, replacing the seven-way `AccentId`
 * picker for that style only — see the block comment beside `--accent-classical`
 * in theme.css for why one dial was not enough. `accentBase` is the printed-ink
 * half (a card border at rest, the nav underline, the seal-stamp ring);
 * `accentCyber` is the live-trace half that `--accent`/`--accent-text` keep
 * resolving from, same as always.
 */
export type AccentBase = 'ink' | 'crimson' | 'moonwhite' | 'gold'
export type AccentCyber = 'cyan' | 'magenta' | 'blue'
/**
 * How the whole surface is drawn, one layer above `ThemeMode`.
 *
 * Theme decides bright or dim; this decides what the page is made of — the
 * neutrals, the corner radius, how much shadow is allowed, how far apart the
 * lines sit. `midnight` is dark-committed and `contrast` is the accessibility
 * one; see the block comments in `styles/theme.css` for what each is for.
 */
export type VisualStyle =
  | 'aurora'
  | 'graphite'
  | 'paper'
  | 'midnight'
  | 'nordic'
  | 'runecircuit'
  | 'contrast'
export type Density = 'comfortable' | 'compact'
export type LocaleId = 'en' | 'zh-CN' | 'fr' | 'es' | 'ru' | 'ar'
/**
 * What the user picked, which is not the same as which language is showing.
 * `'system'` defers to the OS display language and keeps deferring to it, so a
 * machine that changes language does not leave the app behind.
 */
export type LocalePreference = LocaleId | 'system'

/**
 * A grantable slice of what the control interface (`core/control.ts`) can do.
 *
 * Defined here rather than in `core/control.ts` even though every other
 * control-protocol type lives there, because `control.ts` already imports
 * from this file (`InboxTag`, `Recurrence`) and `Settings.controlScopes`
 * below needs the type — importing it back the other way would make the two
 * files depend on each other. `control.ts` imports `ControlScope` from here
 * instead, the same as its other two imports.
 *
 * `write.contacts` has no operation behind it yet — `controlExecutor.ts` has
 * no control op that writes a contact — so it is a defined-but-unused scope,
 * kept so the type is ready the day one is added rather than being extended
 * (and every existing token silently regranted) at that point. It is also
 * why the Settings screen shows no checkbox for it: a switch that flips and
 * changes nothing is worse than no switch (see `DesktopPrefs`'s doc in
 * `core/bridge.ts` for the same call made about `notifyOnFailure` once).
 */
export type ControlScope =
  | 'read.schedule'
  | 'read.inbox'
  | 'read.contacts'
  | 'write.schedule'
  | 'write.contacts'
  | 'send.immediate'

/** Every scope that exists, for validating what a settings file claims to grant. */
export const ALL_CONTROL_SCOPES: readonly ControlScope[] = [
  'read.schedule',
  'read.inbox',
  'read.contacts',
  'write.schedule',
  'write.contacts',
  'send.immediate',
]

export interface Settings {
  themeMode: ThemeMode
  /**
   * Required, not optional, because `DEFAULT_SETTINGS` is merged under every
   * stored settings object at boot — an install written before this existed
   * reads as `'aurora'`, which is the look it already had.
   */
  visualStyle: VisualStyle
  accent: AccentId
  /**
   * `runecircuit`'s own accent choice, on the two axes described beside
   * `AccentBase`/`AccentCyber` above. Optional and defaulted at the read site
   * (`?? 'ink'` / `?? 'cyan'`), same convention as `listDensity` — an install
   * from before this existed has never touched either dial.
   */
  accentBase?: AccentBase
  accentCyber?: AccentCyber
  /**
   * How strongly `runecircuit`'s ceremonial layer shows: card grain, the
   * hover glow's neon mix, the solar-term wash, seal-stamp/ink-bloom motion.
   * 0-100; read as `--intensity` (0-1) everywhere those tokens are declared.
   * Optional for the same reason `accentBase` is — an older install reads as
   * the default via `?? 60`, not as "off".
   */
  themeIntensity?: number
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
   * When `workCalendar` last changed on *this* device. Undefined reads as 0 —
   * older than anything a peer could send. This is what lets device sync
   * (`core/syncLoop.ts`) treat the calendar as last-write-wins instead of
   * exchanging whichever value each side happened to hold before the other's
   * update arrived, which is a swap, not a sync.
   */
  workCalendarUpdatedAt?: number
  /**
   * Tint each day on the working calendar by how many sends land on it.
   *
   * On by default; the switch exists for the reader who finds five shades of
   * the accent distracting rather than informative, not because the heatmap is
   * expensive to compute — `loadLevel` runs once per day inside the marks memo
   * either way, and this only decides whether the result reaches the grid.
   */
  calendarHeatmapEnabled?: boolean
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
   *
   * Doubles as the grant for the `send.immediate` scope below — see
   * `effectiveControlScopes` in `core/control.ts`. Kept as its own field
   * rather than folded into `controlScopes` so this one master switch stays
   * exactly as legible and as easy to audit at a glance as it always was.
   */
  controlAllowSending?: boolean
  /**
   * Fine-grained permissions for the control interface, narrowing what
   * `controlEnabled` alone used to grant unconditionally. See `ControlScope`
   * and `OP_SCOPES` in `core/control.ts` for which operation needs which
   * scope.
   *
   * Optional so an install written before this field existed reads as every
   * scope granted — `normalizeControlScopes(undefined)` — which is exactly
   * what flipping `controlEnabled` on used to mean, so nobody's already-
   * working automation silently stops on upgrade. A fresh install starts the
   * same way (see `DEFAULT_SETTINGS`) and the settings screen is where a user
   * narrows it down from there.
   *
   * `send.immediate` is deliberately never read from here — see
   * `controlAllowSending`'s doc — so this array only needs to carry the other
   * five.
   */
  controlScopes?: ControlScope[]
  /**
   * Serve the working calendar as a live `.ics` address on the same loopback
   * server the control interface uses, so a desktop calendar app can subscribe
   * once and stay current instead of being re-exported by hand. Off by
   * default, and independent of `controlEnabled` — mirroring it rather than
   * riding on it: someone who wants their calendar app to see holidays and
   * make-up days has not thereby agreed to let a program create reminders, and
   * the reverse is just as true.
   *
   * Unlike the control API this route is deliberately unauthenticated (see
   * `electron/controlServer.ts`), so it is judged on its own — only the
   * working calendar's dates go out, never a reminder's recipients or subject.
   */
  calendarSubscribeEnabled?: boolean

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
   * Raise a system notification when ordinary mail arrives.
   *
   * Optional and defaults to on. Until this setting existed there was nothing
   * to switch: a mailbox the app was actively watching could take delivery of
   * anything that was not a verification code in complete silence, on both
   * platforms, which is the whole of what "the new-mail notification is not
   * good enough" turned out to mean.
   *
   * What qualifies is decided by `core/newMail.ts`, not here — unseen, newer
   * than half an hour, and not part of the first sync after launch. Quiet
   * hours suppress it too, which is a deliberate asymmetry with
   * `notifyOnCode`: a code is time-critical by nature and someone waiting for
   * one at 02:00 is waiting on purpose, whereas a newsletter at 02:00 is the
   * exact thing a nightly window exists to hold back.
   */
  notifyOnNewMail?: boolean
  /**
   * Put a freshly found code straight on the clipboard.
   *
   * Only ever fires while "waiting for a code" is switched on, and only for the
   * first high-confidence code of that wait. Silently replacing the clipboard
   * is a real cost — whatever was there is gone — so it is confined to the
   * window where the user has explicitly said the next code is what they want.
   */
  autoCopyCode?: boolean
  /**
   * Corrections the user has made to code extraction, per sender domain.
   *
   * Stored rather than inferred each time, because the whole value of a
   * correction is that it survives the mail it was made in being deleted.
   */
  codeRules?: CodeRule[]
  /**
   * Row height across the list screens. `standard` is the default; `compact`
   * fits about a third more rows, `roomy` is for reading at a distance.
   *
   * Distinct from `density`, which is the global control spacing scale — this
   * one only moves list rows, and the two are set from different places.
   */
  listDensity?: 'compact' | 'standard' | 'roomy'
  /**
   * How large the text is, everywhere.
   *
   * Implemented as a root `font-size` rather than as a second type scale,
   * because the whole scale is already in `rem` — `--text-xs` through
   * `--text-2xl` and every `--sp-*` step. Changing the root moves all of them
   * together and in proportion, which is the difference between "large text"
   * and "the same layout with bigger letters in it": the gaps grow with the
   * words, so a paragraph at 125% reads like a paragraph rather than like a
   * cramped one.
   *
   * The control ladder (`--ctl-*`) stays in px on purpose. A button does not
   * need to be 25% taller because its label is; it needs to be *at least* as
   * tall as its label, which `min-height` plus a grown line box already gives
   * — measured, a 48px button becomes 50px at `larger` and stops there. Making
   * the ladder scale too would push the tab bar and every row height up with
   * it and cost a list row per screen for nothing.
   *
   * Not the same thing as the system font-size setting, and not a replacement
   * for it: Android's own text scaling still applies on top of this, because
   * nothing here pins the root size in px.
   */
  textScale?: 'standard' | 'large' | 'larger'
  /**
   * Move the screen down into thumb reach on a phone.
   *
   * A phone is held at the bottom and the screen is taller than a thumb. The
   * app already puts what it can down there — the tab bar, the send buttons —
   * but a screen's own title row and its actions are at the top by definition,
   * and on a 6.7" phone the top corner is a two-handed reach.
   *
   * Off by default, and it costs what it says: the content column loses the
   * band it is pushed down by. On the compose screen that band comes out of
   * the message box, which is the one place in this app where height is
   * already contested — so this is offered rather than assumed, and the
   * settings copy says so.
   *
   * Phone only. `data-shell="mobile"` gates it in the stylesheet: on a desktop
   * window there is a pointer and nothing to reach for.
   */
  oneHand?: boolean
  /**
   * How many times each Home destination has been opened on *this* device.
   *
   * The phone Home screen is an eight-cell grid: seven destinations ranked by
   * this map, and an eighth cell that is permanently 更多. That bound is the
   * mechanism behind "新加的功能不会破坏界面美感" — a twelfth or fortieth
   * feature changes which seven are on top and nothing else, because the
   * screen's shape does not depend on how many destinations exist. See
   * `styles/app/21-home-grid.css` and `views/HomeView.tsx`.
   *
   * Deliberately NOT part of `AppearanceSettings` (`core/ops/backup.ts`), so
   * it does not travel over the 'appearance' sync scope. Two devices are used
   * differently — a phone opens codes and the inbox, a desktop opens the
   * calendar and the log — and a ranking is only useful if it describes the
   * device you are holding. It is still inside `Settings`, so an ordinary
   * backup carries it and a restored install starts from a familiar layout
   * rather than the cold default order.
   *
   * Keys are `ViewId | HomeFeatureId` (`core/nav.ts`). Untyped as
   * `Record<string, number>` rather than a mapped type over those unions
   * because a persisted file outlives the code that wrote it: an id that has
   * since been renamed or removed must be able to sit in this map harmlessly
   * and be ignored at read time, not make the whole settings object fail to
   * type-check after an upgrade.
   */
  navUsage?: Record<string, number>
  /**
   * The eight Home cells, chosen by hand, in the order they are drawn.
   *
   * `undefined` means "nobody has arranged this yet", and the grid falls back
   * to `navUsage`'s ranking — which is the whole of what 0.3.3 had. The moment
   * this array exists it wins outright: an arrangement someone sat down and
   * made is not something a usage counter gets to quietly rearrange under
   * their finger three days later.
   *
   * Exactly `HOME_GRID_SLOTS` entries and no duplicates, enforced by
   * `sanitiseHomeGrid` in `core/nav.ts` rather than by the type, for the same
   * reason `navUsage` is a loose `Record`: this is persisted data that outlives
   * the code that wrote it, and an id retired in a later version has to be
   * droppable at read time instead of making the settings file fail to parse.
   *
   * Not in `AppearanceSettings`, for the same reason `navUsage` is not — see
   * its note above. A phone's eight and a desktop's eight are different eights.
   */
  homeGrid?: string[]
  /**
   * Show the one-card summary — who, how many, how big, when — before a send
   * actually goes. Default on. Off is for people who send the same message to
   * the same person all day and have measured that the extra tap costs them
   * more than a mis-send would.
   */
  composePreflight?: boolean
  /**
   * Repaint a received HTML body for dark mode instead of showing the sender's
   * white page inside a dark app. Default on, and always overridable per
   * message from the reader — see `MessageBodyFrame`. Some senders' layouts
   * do not survive inversion, which is why the escape hatch is per message and
   * one tap away rather than buried here.
   */
  readerDarkInvert?: boolean
  /** Collapse quoted history in a received message behind one line. */
  readerFoldQuotes?: boolean
  /**
   * Short vibrations on send, on failure, and on copying a code. Android only
   * — `navigator.vibrate` is a no-op on the desktop build — and off by default
   * on no device: it is on, because the whole point is knowing a send went
   * without looking at the screen, and a person who does not want it will find
   * it here on their first annoyed visit.
   */
  haptics?: boolean
  /**
   * When any `AppearanceSettings` field (`core/backup.ts`) last changed on
   * *this* device. Same last-write-wins role as `workCalendarUpdatedAt` — see
   * its doc — but for the "match my theme" scope instead of the calendar.
   */
  appearanceUpdatedAt?: number
  /**
   * This install's own stable identity, minted once at first boot and never
   * regenerated. Distinct from `PairedDevice.id`, which names a *pairing
   * relationship* and is shared between exactly two devices — the whole
   * reason this field exists is that neither device can otherwise tell "is
   * this id me?" apart from "is this id my peer?", since a pairing id looks
   * identical from both ends. Exchanged with a peer over ongoing sync (see
   * `SyncExchangePayload.selfDeviceId`) so it can be written into
   * `ScheduledJob.executorDeviceId`.
   */
  localDeviceId?: string
  /**
   * Whether the remote-image control in Settings has ever been used.
   *
   * A migration marker, not a preference: see `effectiveImagePolicy`. It is
   * app-wide because the thing it records — "the user has seen and answered
   * this question" — is app-wide, while the answer itself is stored per
   * account in `InboxAccountState.showRemoteImages`.
   */
  imagePolicyChosen?: boolean

  // --- daily digest ---------------------------------------------------------
  /**
   * Mail the user a summary of their own schedule once a day.
   *
   * Implemented as an ordinary scheduled reminder with a fixed id, not as a
   * second timer: the app's whole design is one recurrence engine budgeting
   * absolute timestamps while the two native schedulers only answer "wake me at
   * T", and a digest with its own clock would be a second answer to the
   * question that engine exists to own. See `core/digest.ts`.
   */
  digestEnabled: boolean
  /** 'HH:mm', local. Fed straight into the recurrence as a daily rule. */
  digestTime: string
  /** Which account sends it. Unset falls back to `defaultAccountId`. */
  digestAccountId?: string
  /** Where it goes. Empty means the sending account's own address — yourself. */
  digestTo?: string

  // --- holiday greetings ----------------------------------------------------
  /**
   * Defaults for the greeting *planner*, which is a button and not a
   * background task. Nothing in this group causes mail to exist; the user
   * reviews a plan and confirms it, and what that creates is ordinary visible
   * scheduled jobs. See `core/greetings.ts` for why that is not negotiable.
   */
  greetingCountry: string
  /** 'HH:mm', local — when a created greeting leaves on its day. */
  greetingTime: string
  /**
   * Templates. Empty means "use the translated default", so the suggestion
   * arrives in the user's own language instead of in English forever.
   */
  greetingSubject: string
  greetingBody: string
  greetingAccountId?: string
}

/**
 * Below this `themeIntensity`, `runecircuit`'s seal-stamp/ink-bloom motion is
 * skipped outright — `data-atmosphere-motion` in AppState.tsx — rather than
 * just playing faintly. A keyframe scaled to near-zero opacity is still a
 * keyframe someone has to sit through; a low intensity should mean "quiet",
 * not "the same animation, harder to see".
 */
export const ATMOSPHERE_MOTION_MIN = 15

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'system',
  visualStyle: 'aurora',
  accent: 'azure',
  accentBase: 'ink',
  accentCyber: 'cyan',
  themeIntensity: 60,
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
  calendarHeatmapEnabled: true,
  offlineQueueEnabled: true,
  draftHistoryEnabled: true,
  updateCheckOnStart: true,
  controlEnabled: false,
  controlAllowSending: false,
  // Every scope but `send.immediate` (governed by `controlAllowSending`
  // alone — see that field's doc). Matches what `controlEnabled` used to
  // grant unconditionally, before scopes existed to narrow it.
  controlScopes: ALL_CONTROL_SCOPES.filter((s) => s !== 'send.immediate'),
  calendarSubscribeEnabled: false,
  inboxCacheMaxMb: 500,
  inboxCacheRetentionDays: 90,
  inboxSyncMinutes: 5,
  inboxPush: true,
  notifyOnCode: true,
  notifyOnNewMail: true,
  autoCopyCode: true,
  codeRules: [],
  listDensity: 'standard',
  textScale: 'standard',
  oneHand: false,
  /* Empty, not a seeded order. The grid falls back to `HOME_GRID_ORDER`'s
     hand-chosen default until this device has actually opened something —
     see `core/nav.ts`. Seeding counts here would be inventing usage that
     never happened, and would then have to be out-weighed before the real
     ranking could show through. */
  navUsage: {},
  /* Absent, not pre-filled with the default eight. The distinction is the
     feature: `undefined` means "never arranged", which is what lets the grid
     keep ranking by use until somebody actually arranges it. Writing the
     default order in here would make every fresh install look like a decision
     had already been made, and would freeze the order for people who never
     opened the editor. */
  homeGrid: undefined,
  composePreflight: true,
  readerDarkInvert: true,
  readerFoldQuotes: true,
  haptics: true,
  imagePolicyChosen: false,
  digestEnabled: false,
  digestTime: '08:00',
  digestTo: '',
  greetingCountry: 'CN',
  greetingTime: '09:00',
  greetingSubject: '',
  greetingBody: '',
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

/**
 * How many of a folder's most recent messages `electron/imap.ts`'s
 * `runSync` populates the list with, per account, per sync.
 *
 * Shared rather than redeclared: `runSync` is the only place that enforces
 * it, but the UI needs the identical number to tell the user honestly what
 * they are looking at (`InboxView.tsx`'s "showing the most recent N"
 * banner) — a copy typed separately in each file is exactly the kind of
 * number that quietly drifts apart from what the code actually does. There
 * is no pagination yet: a folder with more than this many messages on the
 * server has the rest sitting there, unseen by this app, until a load-older
 * page is built. See `InboxFolder.totalCount`, which is where the gap
 * between "on the server" and "in this list" becomes visible.
 */
export const INBOX_LIST_FETCH_LIMIT = 50

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
  /**
   * The folder's true size on the server (IMAP `EXISTS`), not how many of its
   * messages made it into `InboxAccountState.messages` — that list is capped
   * at `INBOX_LIST_FETCH_LIMIT`. The two agreeing is the common case; the two
   * disagreeing is the fact `InboxView.tsx`'s recent-mail banner exists to
   * surface rather than leave silent.
   */
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

  // --- explainability and purpose (added after the "98052" misread) ---------
  /*
   * Everything below is optional, so a `state.json` written by an older build
   * loads unchanged and simply shows the plainer card it always showed. The
   * cards are not re-extracted on upgrade: the mail they came from is routinely
   * deleted the moment the code is used, and a screen that blanked out its
   * history to gain an explanation nobody asked for would be a bad trade.
   */
  /** Why this value was picked, and what lost — see `core/codeExtract`. */
  reasons?: ExtractReason[]
  /** Runners-up and struck-out numbers, so a wrong pick is one press from right. */
  alternatives?: CodeAlternative[]
  /** Links only: what the link is for, where it lands, what to be careful of. */
  link?: LinkFacts
  /** When the mail said the code or link stops working (epoch ms). */
  expiresAt?: number
  /** The mail said it can only be used once. */
  oneTime?: boolean
}

/**
 * Mirrors `codeExtract.ExtractReason`; declared here so state stays self-describing.
 *
 * `code` is the union rather than `string`, and that is load-bearing: the panel
 * renders each one through `t(\`codes.reason.${code}\`)`, so a reason with no
 * translation is a compile error instead of a raw key on screen in one of six
 * languages nobody on this project reads.
 */
export interface ExtractReason {
  code: ReasonCode
  detail?: string
}

export interface CodeAlternative {
  value: string
  reasons: ExtractReason[]
  /** False for numbers struck out before scoring — shown as excluded, not as options. */
  eligible: boolean
}

/** The part of a link analysis worth keeping after the mail body is gone. */
export interface LinkFacts {
  purpose: LinkPurpose
  purposeConfidence: 'high' | 'medium' | 'low'
  host: string
  domain: string
  risks: LinkRisk[]
  /** The text written on the link in the mail, when there was any. */
  anchorText?: string
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
  /** Devices paired with `mode: 'ongoing'`. See `core/pairedDevices.ts`. Empty for a 'once' pairing, which keeps no record. */
  pairedDevices: PairedDevice[]
  /** Losing records from an automatic newer-wins sync resolution, kept for one-click "keep mine instead". See `core/syncConflict.ts`. */
  syncConflicts: ConflictSnapshot[]
  /**
   * One entry per `ScheduledJob` deleted on this device, kept so device sync
   * can tell a peer "this was cancelled" instead of the peer's copy simply
   * sitting there forever — see `core/syncLoop.ts`'s module doc on why an
   * ordinary additive merge cannot express a delete. Pruned by age, not by
   * confirmation that every peer has caught up: see `JOB_TOMBSTONE_MAX_AGE_MS`.
   */
  deletedJobs: JobTombstone[]
  schemaVersion: number
}

/** A `ScheduledJob` id that no longer exists, and when it stopped — see `AppState.deletedJobs`. */
export interface JobTombstone {
  id: string
  deletedAt: number
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
