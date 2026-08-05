/**
 * The one seam between platform-independent code and the operating system.
 *
 * The renderer never imports `nodemailer`, never touches `fs`, and never calls
 * a Capacitor plugin directly. It asks the bridge. That is what lets the same
 * React tree ship inside Electron and inside an Android WebView, and what lets
 * the UI run in a plain browser during development.
 */

import type { ControlEndpoint, ControlRequest, ControlResponse } from './control'
import type { FeedResponse } from './feeds'
import type { PairingEvent, PairingPayload, PairMode } from './pairing'
import type { SyncListenerStatus, SyncServerRequest, SyncServerResponse } from './syncLoop'
import type {
  AppState,
  Attachment,
  InboxAccountState,
  InboxTag,
  LocaleId,
  MailAccount,
  MessageDraft,
  Platform,
  ScheduledJob,
  SecretKind,
  SendResult,
} from './types'
import type { DownloadProgress, UpdateAsset, UpdateInfo } from './update'
import type { DesktopPrefs, DownloadOutcome, TrayCommand } from './ipc-contract'

export interface AppInfo {
  version: string
  platform: Platform
  os: string
  /** Human-readable location of the state file / preferences store. */
  dataLocation: string
  /**
   * Where an unreadable state file was moved to at startup, if that happened.
   *
   * Present so the app can say "your data could not be read, here is where it
   * went" instead of simply opening empty. An app that comes up factory-fresh
   * with no message looks exactly like one that lost everything.
   */
  recoveredFrom?: string
  /**
   * Absolute path of the bundled MCP server, so the Settings card can print a
   * command that works on this machine. Desktop only.
   */
  mcpServerPath?: string
}

/**
 * What a run did to the job's own bookkeeping.
 *
 * This travels with the event on purpose. The platform scheduler owns the
 * job while it runs and updates `status`/`runCount`/`lastRunAt` on its own
 * copy; the renderer owns `state.json` and everything the user looks at. Until
 * this field existed those two never spoke: the mail went out, the activity log
 * said so, and the schedule row kept displaying the status it was created with
 * — "waiting to send", forever.
 *
 * Two things depended on that silence and were also broken by it:
 * `runCount` stayed at 0, so an "after N sends" end condition never came true;
 * and `lastRunAt`/`lastResult` stayed empty, so send conditions that ask about
 * the previous run were reading values that never changed.
 */
export interface JobRun {
  runCount: number
  lastRunAt: number
  lastResult?: 'ok' | 'failed'
  lastError?: string
  status: ScheduledJob['status']
  /** What is still due after this run. Empty means the job is finished. */
  occurrences: number[]
}

export interface JobEvent {
  jobId: string
  at: number
  result: SendResult
  /**
   * Optional so an older platform layer that does not send it still delivers a
   * usable event — the log line is written either way, the row simply does not
   * move. Absent is a missing feature; present-but-wrong would be a lie.
   */
  run?: JobRun
}

/** One folder the user is allowed to keep their data in. */
export interface DataFolderOption {
  /** `default` everywhere; `external` / `sdcard` on Android; `custom` desktop. */
  id: string
  path: string
  /** Present but unusable — an SD card slot with no card in it. */
  available: boolean
  freeBytes?: number
}

export interface DataFolder {
  path: string
  isDefault: boolean
  sizeBytes: number
  /** Whether the platform can offer a "pick any folder" dialog. */
  canPickAny: boolean
  /** Fixed choices. Always contains `default`; Android adds its volumes. */
  options: DataFolderOption[]
  /** A saved location was unreachable at startup and the default is in use. */
  fellBack?: boolean
  /**
   * What deliberately does *not* move. Passwords live in the OS keystore and
   * Android's alarm store has to stay where the system can read it without the
   * app running; saying so is better than a user assuming otherwise.
   */
  staysBehind: string[]
}

export interface DataFolderChange {
  changed: boolean
  path: string
  moved: boolean
  warning?: string
}

/** A message body, already sanitized on the main-process side if it was HTML. */
export interface InboxMessageBody {
  text?: string
  sanitizedHtml?: string
  attachments: Attachment[]
  /**
   * Remote image URLs stripped out by the sanitizer, in the order their
   * placeholders appear in `sanitizedHtml` (see `src/core/remoteImagePlaceholder.ts`).
   * The renderer resolves these via `bridge.fetchRemoteImage` + `resolveRemoteImages`,
   * automatically unless the account's `showRemoteImages` policy says otherwise.
   * The fetch always happens in the main process: the sanitizer keeps the URLs out
   * of the document and the CSP keeps the iframe off the network, so a message can
   * never open a socket of its own no matter what policy is in force.
   */
  remoteImages?: string[]
  /**
   * `text/calendar` parts of the message, verbatim, when it had any.
   *
   * A meeting invitation states its time in a `DTSTART` the sending calendar
   * wrote on purpose; `core/dateExtract.ts` reads that in preference to the
   * prose next to it, which is a guess by comparison.
   *
   * **Desktop only today.** The Android inbox parses bodies natively and does
   * not lift these out yet, so a phone falls back to the prose reader — which
   * works, and says `medium`/`low` where the desktop would say `high`. Written
   * down rather than left to be discovered: an optional field that is simply
   * always absent on one platform is the shape a silently-degraded feature
   * takes.
   */
  icsParts?: string[]
}

/** New mail arrived while the app was open — the inbox analogue of `JobEvent`. */
export interface InboxEvent {
  accountId: string
  folderPath: string
  newMessageIds: string[]
}

export interface PlatformBridge {
  readonly platform: Platform

  // --- persistence --------------------------------------------------------
  loadState(): Promise<Partial<AppState> | null>
  saveState(state: AppState): Promise<void>

  // --- secrets (never stored in AppState) ---------------------------------
  /** `kind` defaults to `'smtp'` — every secret written before Phase 1 used that key. */
  setSecret(accountId: string, secret: string, kind?: SecretKind): Promise<void>
  hasSecret(accountId: string, kind?: SecretKind): Promise<boolean>
  deleteSecret(accountId: string, kind?: SecretKind): Promise<void>

  // --- mail ---------------------------------------------------------------
  sendNow(draft: MessageDraft, account: MailAccount): Promise<SendResult>
  testConnection(account: MailAccount, secret?: string): Promise<SendResult>
  /**
   * Open and authenticate before the user presses Send.
   *
   * Optional because only the desktop keeps a connection alive; Android hands
   * each send to a background worker that outlives the WebView, so there is no
   * long-lived process to hold one open in.
   */
  prewarm?(account: MailAccount): Promise<boolean>

  /**
   * Tell the platform which language the window is showing in.
   *
   * Only the desktop has UI outside the window — the tray menu — and it is
   * built before the window exists, so it starts from the OS locale and this is
   * how an explicit in-app choice catches up with it.
   */
  setUiLocale?(locale: LocaleId): Promise<void>

  /**
   * Hand the shell the two settings it, not the window, has to act on.
   *
   * Absent on Android and in the browser preview, where neither a tray nor a
   * login item exists — the settings screen hides both switches there.
   */
  setDesktopPrefs?(prefs: DesktopPrefs): Promise<void>

  /** Tray menu items that ask the window to do something. Desktop only. */
  onTrayCommand?(handler: (command: TrayCommand) => void): () => void
  /**
   * Optional: only the desktop shell can say whether a `<a download>` became a
   * real file. Where it is absent (browser preview), the browser's own
   * download UI is the feedback and callers keep their optimistic toast.
   */
  onDownloadDone?(handler: (outcome: DownloadOutcome) => void): () => void
  /**
   * Optional: write a generated file straight to a location the user picks,
   * for platforms where `<a download>` does nothing.
   *
   * Android only, and it is what lets a phone export at all. `<a download>` is
   * inert in a Capacitor WebView, so `core/download.ts` used to refuse there and
   * say so — which meant the phone could import a backup, a transfer file, a
   * pairing file and an .ics, and export none of the four. See `saveTextFile` in
   * `AevistleNativePlugin.java`.
   *
   * Returns the same `DownloadOutcome` the desktop reports after its own save
   * dialog, including `cancelled`, so callers need no platform branch.
   */
  saveTextFile?(name: string, mime: string, text: string): Promise<DownloadOutcome>

  // --- control interface (desktop only) ------------------------------------
  // Optional because only the desktop build can listen on a socket or watch a
  // folder. The Android and browser builds simply do not offer it, and the
  // settings screen hides the card rather than showing a switch that lies.
  applyControl?(settings: {
    enabled: boolean
    allowSending: boolean
    calendarSubscribeEnabled: boolean
  }): Promise<ControlEndpoint | null>
  onControlRequest?(handler: (request: ControlRequest) => void): () => void
  respondToControl?(response: ControlResponse): Promise<void>

  // --- LAN pairing (device-to-device, end-to-end encrypted) ---------------
  // See `src/core/pairing.ts`. HOST is desktop-only — only Electron main can
  // open a socket on the LAN interface. JOINER is `pairingJoinRequest` alone:
  // both desktop and Android need it (a phone scanning a laptop's code, or a
  // laptop scanning a phone's), and both are equally blocked from calling
  // `fetch()` on a LAN address directly by `connect-src 'self'` — so this is
  // present on every platform bridge except the browser preview, which has no
  // trusted layer to relay through.
  /**
   * HOST: start a ~2-minute LAN pairing session and return the QR payload.
   * `pairId` is required for `mode: 'ongoing'` — see `pairingServer.ts`.
   *
   * `host` picks which of this machine's addresses to publish; omitted, the
   * best-ranked one is used. See `lanAddresses`.
   */
  startPairingHost?(mode: PairMode, pairId?: string, host?: string): Promise<PairingPayload>
  /**
   * HOST: every address this machine could be reached at, best first.
   *
   * A desktop with a VPN client, a hypervisor or a container runtime installed
   * holds several private addresses that look identical to the one the Wi-Fi
   * card has, and only one of them is on the phone's network. The ranking in
   * `pairingServer.ts` guesses; this is what lets the user see the guess and
   * override it instead of reading a socket timeout on the other device.
   */
  lanAddresses?(): Promise<string[]>
  /** HOST: stop early. */
  stopPairingHost?(): Promise<void>
  /** HOST: listening/connected/expired/stopped/error, as they happen. */
  onPairingEvent?(handler: (event: PairingEvent) => void): () => void
  /** JOINER: relay one POST to a LAN pairing endpoint through the trusted layer. */
  pairingJoinRequest?(url: string, body: unknown): Promise<unknown>

  // --- ongoing sync ---------------------------------------------------------
  // See `src/core/syncLoop.ts`. Present on every platform: a `SyncLoop`
  // always plays the initiating side (`syncRequest`, the same "relay one POST
  // through the trusted layer" shape as `pairingJoinRequest`). Only the
  // desktop bridge also implements `onSyncServerRequest`/`respondToSyncServer`
  // — the accepting side, same HOST-only reasoning as pairing.
  /** Relay one POST to `http://<lan-ip>:<port>/sync`. */
  syncRequest?(url: string, body: unknown): Promise<unknown>
  /**
   * HOST only: open the LAN sync listener, or close it.
   *
   * Deliberately not automatic on launch. Binding a LAN interface is what
   * raises the Windows firewall prompt, so an app that promises no server had
   * better not ask for one before the user has paired anything — see
   * `electron/syncServer.ts`. The caller passes "this machine has at least one
   * 'ongoing' pairing", and the returned status is what the settings screen
   * shows when the socket did not come up.
   */
  applySyncListener?(enabled: boolean): Promise<SyncListenerStatus>
  /** HOST only: a request arrived on the ongoing-sync listener and wants an answer. */
  onSyncServerRequest?(handler: (request: SyncServerRequest) => void): () => void
  respondToSyncServer?(response: SyncServerResponse): Promise<void>
  /**
   * Read back an 'ongoing' pairing's own long-lived key — `keyRef` in,
   * base64 key material out, or `null` if it was revoked.
   *
   * The one deliberate exception to "a renderer never reads a secret back":
   * `setSecret`/`hasSecret`/`deleteSecret` are the whole story for an SMTP or
   * IMAP password, which can send mail or read a mailbox from anywhere once
   * it leaks. A sync key only unlocks LAN data-sync with a device that
   * already completed an authenticated pairing — see `core/pairedDevices.ts`'s
   * module doc — so `core/syncLoop.ts` needs it in the renderer to do its own
   * AES-GCM, the same WebCrypto every other pairing key already uses.
   */
  getSyncSecret?(keyRef: string): Promise<string | null>

  // --- files --------------------------------------------------------------
  pickFiles(): Promise<Attachment[]>
  /** Copy attachments into app-private storage so a later send still finds them. */
  snapshotAttachments(attachments: Attachment[], jobId: string): Promise<Attachment[]>
  revealPath(path: string): Promise<void>
  /**
   * Hand a file to the OS's default handler for it — desktop only, since it is
   * the only platform holding a real filesystem path an "open" can act on.
   */
  openPath?(path: string): Promise<void>
  /**
   * Save clipboard image bytes as an attachment (pasting an image into the
   * compose body). Desktop only, for the same reason `openPath` is.
   */
  attachBlob?(name: string, mime: string, data: ArrayBuffer): Promise<Attachment>
  /**
   * Read an attachment back as a `data:` URL so it can be shown in place.
   *
   * Resolves `null` for anything the platform will not preview — too large,
   * not a safe type, no longer on disk. Optional as a whole because a platform
   * that cannot do it at all should degrade to "open with the system handler",
   * not report an error for every attachment.
   */
  readAttachment?(path: string): Promise<{ dataUrl: string; mime: string } | null>
  /** Save a copy where the user chooses. Resolves null if they cancelled. */
  saveAttachmentAs?(path: string, suggestedName: string): Promise<string | null>
  /** Save every listed attachment into one chosen folder. */
  saveAttachmentsTo?(paths: string[]): Promise<{ folder: string; saved: number } | null>
  /**
   * Make sure a received attachment's bytes are on local disk, and answer
   * where they landed.
   *
   * Only implemented where a listed attachment might not have been downloaded
   * yet — which today means Android, whose sync deliberately records
   * attachment metadata and leaves the bytes on the server so a mailbox full
   * of photographs does not spend a phone's data allowance on files nobody
   * opens. The desktop writes attachments out during the body fetch, so it
   * omits this and every caller falls back to `attachment.path`.
   *
   * Idempotent: an attachment already on disk comes back without a connection
   * being opened, which is what makes preview → save → open three taps rather
   * than three downloads.
   */
  ensureAttachment?(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
    attachment: Attachment,
  ): Promise<Attachment>
  /**
   * Which of these paths still exist. Optional: platforms that cannot answer
   * simply omit it, and every caller treats "cannot check" as "do not claim
   * anything" rather than as "missing".
   */
  checkFiles?(paths: string[]): Promise<Record<string, boolean>>
  /** Turn dropped file paths into attachments. Absent where drops carry no path. */
  attachPaths?(paths: string[]): Promise<Attachment[]>
  /** The real path of a dropped `File`, where the platform can tell us. */
  pathForFile?(file: File): string

  // --- scheduling ---------------------------------------------------------
  /**
   * Hand the platform scheduler everything it needs to fire without us.
   * Accounts travel with the jobs because on Android the worker runs long
   * after the WebView is gone and cannot ask the UI for the SMTP settings —
   * it only looks the *password* up separately, from the keystore.
   */
  syncJobs(jobs: ScheduledJob[], accounts: MailAccount[]): Promise<void>
  /** Fires when the platform completed a scheduled send while we were open. */
  onJobEvent(handler: (event: JobEvent) => void): () => void
  /**
   * Runs that completed with no UI attached, to be applied on open.
   *
   * Optional because it only means something where the scheduler outlives the
   * window — Android. On the desktop the live event already carries the same
   * data, and in the browser there is no scheduler to report anything.
   */
  pullJobRuns?(): Promise<Array<JobRun & { jobId: string }>>

  // --- inbox (receiving) ---------------------------------------------------
  // All optional: only the desktop has IMAP wired up so far. The Android
  // build reuses the same `com.sun.mail` JavaMail dependency already bundled
  // for SMTP (it registers an IMAP provider too — no new library needed) but
  // that wiring is later work; until then `bridge?.syncInbox` is simply
  // absent and the UI hides inbox affordances, the same way it already hides
  // install/download on platforms where those are unavailable.
  /** Connect, fetch new headers, cache bodies — returns the account's updated inbox state. */
  syncInbox?(config: InboxAccountState): Promise<InboxAccountState>
  /**
   * Probe the receive endpoint and report back, saving nothing.
   *
   * `secret` is optional so the dialog can test a password the user has typed
   * but not yet saved; omit it and the stored one is used (falling back to the
   * SMTP password for the same account, which for every provider that issues
   * app passwords is the same string).
   */
  testInbox?(config: InboxAccountState, secret?: string): Promise<SendResult>
  /**
   * Hand the platform the set of accounts that should be watched for new mail
   * over a held-open connection. Passwords are deliberately absent — the
   * platform looks them up itself, the same way the scheduler does.
   *
   * Absent on platforms with no push story (Android keeps its periodic
   * WorkManager job instead of holding a socket open in the background), and
   * the timed check runs on every platform regardless, so an implementation
   * missing here costs latency and nothing else.
   */
  watchInbox?(configs: InboxAccountState[]): Promise<void>
  /** Takes the account's inbox config (not just its id), matching `sendNow`/`testConnection`'s convention of passing the live object rather than re-reading it from disk. */
  getMessageBody?(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
  ): Promise<InboxMessageBody>
  /**
   * Sanitize an HTML string the same way a received message's body is
   * sanitized before rendering — script/style/iframe stripped, remote images
   * replaced with the blank placeholder — so a scheduled draft's HTML preview
   * never opens a second, unaudited render path. Desktop only, like every
   * other `sanitize-html`-backed call; where it is absent (Android, the
   * browser preview) the calendar's body preview falls back to plain text
   * rather than rendering anything unsanitized.
   */
  sanitizeHtml?(html: string): Promise<string>
  /**
   * `seen` best-effort mirrors to the server's `\Seen` flag; `tag` never
   * leaves the device (see `InboxTag`). Local state always updates regardless
   * of whether the server round-trip succeeds.
   */
  setMessageFlags?(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
    patch: { seen?: boolean; tag?: InboxTag },
  ): Promise<void>
  /**
   * Local cache only — never issues an IMAP `\Deleted`/EXPUNGE.
   *
   * "Re-syncable" is why the caller must also record a tombstone: on its own
   * this drops the cached body and the next sync fetches the message straight
   * back. See `core/inboxRemoval.ts`.
   */
  deleteInboxMessages?(
    accountId: string,
    items: Array<{ folderPath: string; uid: number }>,
  ): Promise<void>
  /**
   * Delete on the server, for real.
   *
   * Takes the account config rather than just an id because it has to open a
   * connection. Rejects when the server refuses — a resolved promise here means
   * the mail is genuinely gone from the mailbox.
   */
  purgeInboxMessages?(
    config: InboxAccountState,
    items: Array<{ folderPath: string; uid: number }>,
  ): Promise<void>
  /**
   * Download a remote image through the trusted main process and return it as
   * a `data:` URI, so a sanitized message body never makes its own network
   * request (which is how a tracking pixel would otherwise leak the reader's
   * IP and confirm the message was opened).
   */
  fetchRemoteImage?(url: string): Promise<string>
  /**
   * Read one of the two public feeds named in `feeds.ts` through the trusted
   * side, because the renderer's `connect-src 'self'` forbids it from doing so
   * itself. Absent on the browser preview, which has no trusted side; the two
   * callers fall back to a direct `fetch` there and say so when it is refused.
   */
  fetchFeed?(url: string): Promise<FeedResponse>
  /**
   * Drop the on-disk remote-image cache. Optional because only the desktop
   * build has one — Android fetches through the plugin without caching.
   */
  clearImageCache?(): Promise<void>
  /** New mail arrived while the app was open. */
  onInboxEvent?(handler: (event: InboxEvent) => void): () => void

  // --- data folder --------------------------------------------------------
  /** Where the app keeps everything, and where else it could. */
  dataFolder(): Promise<DataFolder>
  /** Free choice via the OS folder picker. Desktop only — see `canPickAny`. */
  chooseDataFolder(move: boolean): Promise<DataFolderChange>
  /** Switch to one of the offered options, `default` included. */
  useDataFolder(optionId: string, move: boolean): Promise<DataFolderChange>
  openDataFolder(): Promise<void>

  // --- updates ------------------------------------------------------------
  /** Ask the release feed whether a newer build exists. Never throws. */
  checkForUpdate(): Promise<UpdateInfo>
  /**
   * Fetch and verify the new build.
   *
   * Desktop only. Android returns `undefined`, because installing an APK has to
   * go through the system package installer and that means handing the URL to
   * the browser rather than downloading it ourselves.
   */
  downloadUpdate?(asset: UpdateAsset): Promise<DownloadProgress>
  installUpdate?(filePath: string): Promise<void>
  onUpdateProgress?(handler: (progress: DownloadProgress) => void): () => void

  // --- misc ---------------------------------------------------------------
  /**
   * `code: true` marks a verification code, which some platforms route to a
   * separate, higher-importance channel — the whole value of that one is being
   * readable without switching apps. Platforms with a single notification
   * surface ignore it.
   */
  notify(title: string, body: string, opts?: { code?: boolean }): Promise<void>
  openExternal(url: string): Promise<void>
  appInfo(): Promise<AppInfo>
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    aevistle?: unknown
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
  }
}

export function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'web'
  if (window.aevistle) return 'desktop'
  const cap = window.Capacitor
  if (cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android') return 'android'
  return 'web'
}

/**
 * Are we inside the desktop shell but without the bridge it should have injected?
 *
 * This matters because of what the fallback is. `detectPlatform` answers "no
 * `window.aevistle`" with `'web'`, and the web bridge is a working app: it
 * keeps state in localStorage and its scheduling maths runs. So a preload that
 * failed to load — a sandbox change, a bad path, a throw inside preload.cjs —
 * would not produce a broken-looking app. It would produce a normal-looking one
 * that quietly writes to browser storage instead of the data folder and arms no
 * alarms at all, and the user would only find out when the mail never arrived.
 *
 * The user-agent is the honest signal here: Electron puts its own token in it,
 * and that token is there whether or not our preload ran.
 */
export function isDesktopShellWithoutBridge(): boolean {
  if (typeof window === 'undefined' || window.aevistle) return false
  return / Electron\//.test(navigator.userAgent ?? '')
}

let cached: PlatformBridge | null = null

/**
 * Resolve the bridge for the current host. Implementations are imported lazily
 * so that, for example, the Capacitor runtime is never pulled into the Electron
 * bundle and vice versa.
 */
export async function getBridge(): Promise<PlatformBridge> {
  if (cached) return cached

  // Refuse to quietly become the browser sandbox inside the desktop app. See
  // `isDesktopShellWithoutBridge` — falling back here loses the user's data
  // folder and their entire schedule while looking completely normal.
  if (isDesktopShellWithoutBridge()) {
    throw new Error(
      'The desktop bridge did not load, so Aevistle cannot reach your data folder or the ' +
        'scheduler. Reinstalling usually fixes this. Your existing data has not been touched.',
    )
  }

  const platform = detectPlatform()

  if (platform === 'desktop') {
    const mod = await import('./bridge-desktop')
    cached = mod.createDesktopBridge()
  } else if (platform === 'android') {
    const mod = await import('./bridge-android')
    cached = mod.createAndroidBridge()
  } else {
    const mod = await import('./bridge-web')
    cached = mod.createWebBridge()
  }

  return cached
}

/** Test seam — lets a unit test or a story inject a fake. */
export function __setBridge(bridge: PlatformBridge | null): void {
  cached = bridge
}

// ---------------------------------------------------------------------------
// Shared helpers used by every implementation
// ---------------------------------------------------------------------------

/**
 * Classify a transport error so the UI can say something useful about it.
 *
 * Order matters. `handshake` is tested before the generic `tls` and `network`
 * cases because "Unexpected socket close" contains the word "socket" and would
 * otherwise be filed as a network problem — sending the user off to check
 * their Wi-Fi when the actual fix is a different port.
 */
export function classifyError(message: string): SendResult['errorKind'] {
  const m = message.toLowerCase()
  if (/auth|535|534|password|credential|login|应用专用|授权码/.test(m)) return 'auth'
  if (/unexpected socket close|wrong version number|greeting never received|econnreset|epipe|etls|handshake/.test(m)) {
    return 'handshake'
  }
  if (/no answer from the server|timed out|timeout|etimedout/.test(m)) return 'timeout'
  if (/certificate|self[- ]signed|tls|ssl|depth zero|unable to verify/.test(m)) return 'tls'
  if (/enotfound|econnrefused|ehostunreach|enetunreach|network|dns|getaddrinfo|socket/.test(m)) return 'network'
  if (/550|551|553|recipient|no such user|mailbox unavailable/.test(m)) return 'recipient'
  if (/552|quota|exceeded|too large|message size/.test(m)) return 'quota'
  if (/enoent|no such file|permission denied|eacces/.test(m)) return 'attachment'
  if (/invalid|missing|required|port|host/.test(m)) return 'config'
  return 'unknown'
}

export function failedResult(error: unknown, startedAt: number): SendResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    accepted: [],
    rejected: [],
    durationMs: Date.now() - startedAt,
    error: message,
    errorKind: classifyError(message),
  }
}
