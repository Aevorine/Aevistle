/**
 * The exact surface `electron/preload.ts` exposes on `window.aevistle`.
 *
 * Kept in `src/core` on purpose: both the renderer and the preload script
 * import this file, so the contract cannot drift between the two halves
 * without TypeScript noticing.
 *
 * Security posture: this is the *entire* privilege boundary. Node integration
 * is off in the renderer, context isolation is on, and this list is the only
 * thing web content can reach. Every addition here widens the attack surface,
 * so each method takes plain serialisable data — no functions, no handles,
 * no `fs` module leaking through.
 */

import type {
  AppState,
  Attachment,
  ControlScope,
  InboxAccountState,
  InboxTag,
  LocaleId,
  MailAccount,
  MessageDraft,
  ScheduledJob,
  SecretKind,
  SeenFlagResult,
  SendResult,
  SharePayload,
} from '../types'
import type {
  AppInfo,
  DataFolder,
  DataFolderChange,
  InboxEvent,
  InboxMessageBody,
  JobEvent,
} from './bridge'
import type { DispatchLedgerEntry } from '../ops/dispatchLedger'
import type { DownloadProgress, UpdateAsset, UpdateInfo } from './update'
import type { ControlAuditEntry, ControlEndpoint, ControlRequest, ControlResponse } from '../sync/control'
import type { FeedResponse } from '../schedule/feeds'
import type { OAuthAccountStatus, OAuthConsentResult } from '../mail/oauth'
import type { PairingEvent, PairingPayload, PairMode } from '../sync/pairing'
import type { PairingEnvelope } from '../sync/pairingCrypto'
import type {
  SealedAccountSecrets,
  SyncListenerStatus,
  SyncServerRequest,
  SyncServerResponse,
} from '../sync/syncLoop'

/**
 * Tray menu items that are a request to the *window*, not to the app.
 *
 * Pausing lives here rather than in the main process even though the scheduler
 * is there: state is owned by the renderer, and a main-process pause would be
 * overwritten by the next debounced save. Same reasoning as the control
 * interface — one reducer, one source of truth, whatever the entry point.
 */
export type TrayCommand = 'compose' | 'schedule' | 'logs' | 'pauseAll' | 'resumeAll'

/**
 * The two settings whose effect lives entirely outside the window.
 *
 * Deliberately a separate shape from `Settings`: the whole settings object is
 * large, changes on every keystroke somewhere, and contains account details
 * that have no business crossing the boundary just so a checkbox can take
 * effect.
 */
export interface DesktopPrefs {
  /** Closing the window hides it instead of quitting. False means close quits. */
  minimiseToTray: boolean
  /** Register (or clear) the OS login item. */
  launchAtLogin: boolean
  /**
   * Announce a scheduled send that worked.
   *
   * Here for the same reason the two above are, and it arrived late for a worse
   * reason: the switch existed in the settings screen and the *only* thing that
   * ever read it was the manual "send now" button in the compose screen. A
   * scheduled send — the thing this application is for — notified on neither
   * outcome, because the scheduler runs in the main process and the main
   * process had never been told the setting existed.
   */
  notifyOnSuccess: boolean
  /**
   * Announce a scheduled send that failed.
   *
   * This one was read by nothing at all, anywhere. The failure notification
   * fired unconditionally, so turning the switch off changed nothing — a
   * toggle that flips and does nothing, which is precisely what the note above
   * says must not happen.
   */
  notifyOnFailure: boolean
}

/** The two numbers a taskbar overlay badge is drawn from — see `setBadgeCounts`. */
export interface BadgeCounts {
  unread: number
  armed: number
}

/** The result of a `<a download>` the main process took responsibility for. */
export interface DownloadOutcome {
  /** True only when a file is on disk under `path`. */
  ok: boolean
  /** The user closed the save dialog. Not an error — nothing should look alarmed. */
  cancelled: boolean
  /** The file name as saved, so the toast can say where it went. */
  name: string
  path?: string
  /** Electron's own word for it: `completed` | `cancelled` | `interrupted`. */
  state?: string
}

export interface DesktopApi {
  loadState(): Promise<Partial<AppState> | null>
  saveState(state: AppState): Promise<void>

  setSecret(accountId: string, secret: string, kind?: SecretKind): Promise<void>
  hasSecret(accountId: string, kind?: SecretKind): Promise<boolean>
  deleteSecret(accountId: string, kind?: SecretKind): Promise<void>

  // --- OAuth2 sign-in ------------------------------------------------------
  // Deliberately three narrow methods rather than a general "get me a token".
  // The refresh token is written to the keystore by the main process and read
  // back only by the transports; nothing here can return one, which is what
  // keeps an XSS in the renderer from becoming a permanent mailbox credential.
  /**
   * Open the provider's consent page in the OS browser, catch the loopback
   * redirect, exchange the code, and store the refresh token.
   *
   * Resolves when the user is done — this can sit for minutes, and that is
   * correct rather than a hang. `loginHint` pre-fills the account picker and
   * nothing more; the address in the result is the one actually signed in as,
   * which may differ.
   */
  oauthConsent(
    accountId: string,
    providerId: string,
    loginHint: string,
  ): Promise<OAuthConsentResult>
  /** Whether this account is connected, never connected, or needs re-consent. */
  oauthStatus(accountId: string, providerId: string): Promise<OAuthAccountStatus>
  /** Delete the stored grant. Does not revoke it at the provider — only the user can do that. */
  oauthDisconnect(accountId: string): Promise<void>

  sendNow(draft: MessageDraft, account: MailAccount): Promise<SendResult>
  testConnection(account: MailAccount, secret?: string): Promise<SendResult>
  /** Open and authenticate ahead of a send. Resolves false if it could not. */
  prewarm(account: MailAccount): Promise<boolean>
  /** Rebuild the tray menu in the language the window is showing. */
  setUiLocale(locale: LocaleId): Promise<void>
  /**
   * Settings only the main process can act on.
   *
   * Both of these were switches in the settings screen that nothing outside the
   * renderer ever read: closing the window went to the tray whether or not the
   * user had turned that off, and "start with the computer" never registered
   * anything. A toggle that flips and does nothing is worse than no toggle, so
   * they are pushed across here whenever they change.
   */
  setDesktopPrefs(prefs: DesktopPrefs): Promise<void>
  /**
   * Unread mail and armed reminders, so the taskbar icon can carry a badge
   * while the window is minimised or hidden in the tray — the one signal a
   * mainstream mail client shows that this app did not.
   *
   * Both counts travel rather than a pre-combined total: the main process
   * decides how to draw and describe the badge (see `applyBadgeCounts` in
   * `electron/main.ts`), and a renderer-side sum would bake that decision in
   * on the wrong side of the privilege boundary for no benefit.
   */
  setBadgeCounts(counts: BadgeCounts): Promise<void>
  /** Menu items that need the window to do something. Returns an unsubscribe. */
  onTrayCommand(handler: (command: TrayCommand) => void): () => void
  /**
   * What became of a file the renderer handed over via `<a download>`.
   *
   * Exists because "we started a download" and "a file exists on disk with a
   * name you will recognise" are different claims, and only the main process
   * knows the second one. Returns an unsubscribe.
   */
  onDownloadDone(handler: (outcome: DownloadOutcome) => void): () => void

  pickFiles(): Promise<Attachment[]>
  snapshotAttachments(attachments: Attachment[], jobId: string): Promise<Attachment[]>
  revealPath(path: string): Promise<void>
  /** Hand a file to the OS's default handler for it — what "open" means for an attachment. */
  openPath(path: string): Promise<void>
  /**
   * Save clipboard image bytes as an attachment, for pasting an image straight
   * into the compose body. `data` travels as an `ArrayBuffer` — IPC structured
   * clone carries it without a base64 round trip.
   */
  attachBlob(name: string, mime: string, data: ArrayBuffer): Promise<Attachment>
  /**
   * Read one attachment back as a `data:` URL, for previewing it in place
   * rather than handing it to another program first.
   *
   * Deliberately narrower than a general file read: confined to the data
   * folder (where every attachment this app wrote lives), capped in size, and
   * it refuses any type that is not safe to render inertly — the caller gets
   * `null` rather than a URL it would then have to decide what to do with.
   * Widening either list should mean justifying it here, not at the call site.
   */
  readAttachment(path: string): Promise<{ dataUrl: string; mime: string } | null>
  /** Ask where to put a copy of an attachment, then write it there. Returns the path, or null if cancelled. */
  saveAttachmentAs(path: string, suggestedName: string): Promise<string | null>
  /** Ask for one folder, then copy every listed attachment into it. Returns how many landed. */
  saveAttachmentsTo(paths: string[]): Promise<{ folder: string; saved: number } | null>
  /**
   * Which of these paths are still readable files.
   *
   * Existence only — no contents, no directory listing, no stat fields. That
   * is the narrowest thing that answers "will this attachment actually be
   * there when the reminder fires", and widening it later should require
   * justifying a second method rather than adding a field to this one.
   */
  checkFiles(paths: string[]): Promise<Record<string, boolean>>
  /**
   * Build attachments from paths the user dropped onto the window.
   *
   * Separate from `pickFiles` because the file dialog already returns fully
   * formed attachments, while a drop only yields paths — and those paths come
   * from `webUtils.getPathForFile`, which is the *only* supported way to learn
   * a dropped file's location now that `File.path` is gone.
   */
  attachPaths(paths: string[]): Promise<Attachment[]>
  /** Resolve a dropped `File` to its real path. Renderer-side, no IPC. */
  pathForFile(file: File): string

  /** `headless` is documented on `PlatformBridge.syncJobs` in `core/bridge`. */
  syncJobs(
    jobs: ScheduledJob[],
    accounts: MailAccount[],
    headless?: {
      notifyOnSuccess: boolean
      notifyOnFailure: boolean
      inboxKnown?: boolean
      latestInbound?: Record<string, number>
    },
  ): Promise<void>
  onJobEvent(handler: (event: JobEvent) => void): () => void
  /** See `PlatformBridge.getDispatchLedgerStatus`'s doc in `bridge.ts`. */
  getDispatchLedgerStatus(): Promise<DispatchLedgerEntry[]>

  syncInbox(config: InboxAccountState): Promise<InboxAccountState>
  testInbox(config: InboxAccountState, secret?: string): Promise<SendResult>
  watchInbox(configs: InboxAccountState[]): Promise<void>
  getMessageBody(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
  ): Promise<InboxMessageBody>
  /**
   * Run arbitrary HTML through the same allowlist a received message's body
   * goes through, so a scheduled draft previewed on the calendar screen never
   * needs a render path of its own. See `electron/sanitizeHtml.ts`.
   */
  sanitizeHtml(html: string): Promise<string>
  setMessageFlags(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
    patch: { seen?: boolean; tag?: InboxTag },
  ): Promise<SeenFlagResult>
  /** Forget locally: cache files only, the mailbox is not touched. */
  deleteInboxMessages(
    accountId: string,
    items: Array<{ folderPath: string; uid: number }>,
  ): Promise<void>
  /** Delete on the server. Rejects on failure — see `purgeMessages` in `imap.ts`. */
  purgeInboxMessages(
    accountId: string,
    config: InboxAccountState,
    items: Array<{ folderPath: string; uid: number }>,
  ): Promise<void>
  fetchRemoteImage(url: string): Promise<string>
  /** Read one of the two allow-listed public feeds. See `core/feeds.ts`. */
  fetchFeed(url: string): Promise<FeedResponse>
  /** Drop the on-disk remote-image cache. Part of "reset everything". */
  clearImageCache(): Promise<void>
  onInboxEvent(handler: (event: InboxEvent) => void): () => void
  /**
   * A notification naming a message was clicked. Carries that message's id.
   *
   * The click lands in the main process — it is an Electron `Notification`, not
   * a DOM one — so the id has to come back across the boundary for the renderer
   * to act on it. Same replay treatment as `onTrayCommand`: a notification
   * clicked while the window was closed opens one, and the page it opens has
   * not mounted React yet, so the preload holds the id until someone asks.
   */
  onOpenMessage(handler: (messageId: string) => void): () => void
  /**
   * Another application handed this one something to send.
   *
   * On Windows that is a `mailto:` link followed from a browser or a document,
   * or a file sent through Explorer's Send To menu. Either way the OS starts —
   * or, with the single-instance lock, re-enters — this process with the
   * payload on the command line, so the parse happens in the main process and
   * the result comes across as an event.
   *
   * Same replay treatment as `onTrayCommand` and `onOpenMessage`, and it is
   * load-bearing rather than defensive here: a `mailto:` link with the app
   * closed *is* the launch, so the payload always predates the renderer.
   */
  onShare(handler: (share: SharePayload) => void): () => void

  /**
   * `messageId` is what makes the notification clickable-through: the main
   * process attaches a click handler that raises the window and sends the id
   * back down `onOpenMessage`. Omitted for notifications about nothing in
   * particular (a send result), where the click just raises the window.
   */
  notify(title: string, body: string, messageId?: string): Promise<void>
  openExternal(url: string): Promise<void>
  appInfo(): Promise<AppInfo>

  dataFolder(): Promise<DataFolder>
  /** Opens the OS folder picker, then moves the data there. */
  chooseDataFolder(move: boolean): Promise<DataFolderChange>
  /** Switch to a listed option — on the desktop that means `default`. */
  useDataFolder(optionId: string, move: boolean): Promise<DataFolderChange>
  openDataFolder(): Promise<void>

  checkForUpdate(): Promise<UpdateInfo>
  /** Fetch the installer, verify it, and report where it landed. */
  downloadUpdate(asset: UpdateAsset): Promise<DownloadProgress>
  /** Hand the finished installer to the OS. The app closes so it can be replaced. */
  installUpdate(filePath: string): Promise<void>
  onUpdateProgress(handler: (progress: DownloadProgress) => void): () => void

  // --- control interface (Claude Code and other callers) -----------------
  /**
   * Start or stop the loopback server to match the settings just saved, and
   * report where it ended up. Returns null when *both* `enabled` and
   * `calendarSubscribeEnabled` are off — the server has no reason to be up.
   */
  applyControl(settings: {
    enabled: boolean
    allowSending: boolean
    /** Serves `GET /calendar.ics` on the same server. See `core/types.ts`. */
    calendarSubscribeEnabled: boolean
    /**
     * Raw, un-normalized — main computes `effectiveControlScopes` itself
     * (`core/control.ts`) rather than trusting a pre-resolved array, so a
     * bad shape here fails closed the same way it would if it came straight
     * off disk.
     */
    controlScopes?: ControlScope[]
  }): Promise<ControlEndpoint | null>
  /** Requests arriving from HTTP, the drop folder or the CLI. */
  onControlRequest(handler: (request: ControlRequest) => void): () => void
  /** The answer to one of those, keyed by `request.id`. */
  respondToControl(response: ControlResponse): Promise<void>
  /** Every durable control-audit entry on disk, oldest first. See `electron/store.ts`'s `loadControlAudit`. */
  getControlAudit(): Promise<ControlAuditEntry[]>

  // --- LAN pairing (device-to-device, end-to-end encrypted) --------------
  // See `src/core/pairing.ts` for the handshake and `electron/pairingServer.ts`
  // for the listener. Desktop can play either role; `pairingJoinRequest` is
  // the one both roles share, since a desktop JOINER is just as CSP-blocked
  // from a direct `fetch()` as the Android WebView is.
  /**
   * HOST: open a ~2-minute LAN listener and return the QR payload. `pairId` is
   * required for `mode: 'ongoing'` — see `pairingServer.ts`.
   *
   * `host` overrides which of this machine's addresses is bound and published.
   * Omitted, the ranked best from `lanAddresses()` is used; passing one of the
   * others is how the user corrects a machine whose interfaces defeat the
   * ranking. Anything not currently on this machine is refused.
   */
  startPairingHost(mode: PairMode, pairId?: string, host?: string): Promise<PairingPayload>
  /**
   * Every address this machine could be paired at, best first.
   *
   * Exists because the ranking in `pairingServer.ts` is a heuristic over
   * interface names, and a heuristic that is wrong silently costs the user a
   * four-second timeout on the other device with no clue in it. Showing the
   * list turns "it does not work" into "it is offering the wrong one".
   */
  lanAddresses(): Promise<string[]>
  /** HOST: stop early — the countdown ran out, or the user left the screen. */
  stopPairingHost(): Promise<void>
  onPairingEvent(handler: (event: PairingEvent) => void): () => void
  /** JOINER: relay one POST to `http://<lan-ip>:<port>/pair`. Any other host or path is refused — see `main.ts`. */
  pairingJoinRequest(url: string, body: unknown): Promise<unknown>

  // --- ongoing sync (LAN-only, no relay) -----------------------------------
  // See `src/core/syncLoop.ts`. The listener (`electron/syncServer.ts`) is
  // desktop-only, same reasoning as pairing's HOST role — only Electron main
  // can hold a LAN socket open. It never decrypts anything itself: every
  // request is handed to the renderer, which holds the only copy of the
  // long-lived keys.
  /** Open or close the LAN sync listener, and say what happened. See `syncServer.ts` on why this is not automatic. */
  applySyncListener(enabled: boolean): Promise<SyncListenerStatus>
  /** The initiating side of a sync cycle: relay one POST to `http://<lan-ip>:<port>/sync`. */
  syncRequest(url: string, body: unknown): Promise<unknown>
  /** The accepting side (desktop only): a request arrived on the sync listener and wants an answer. */
  onSyncServerRequest(handler: (request: SyncServerRequest) => void): () => void
  respondToSyncServer(response: SyncServerResponse): Promise<void>
  /** See `PlatformBridge.getSyncSecret`'s doc in `bridge.ts` for why this exists at all. */
  getSyncSecret(keyRef: string): Promise<string | null>
  /**
   * Seal the keystore's passwords for these accounts under this pairing's own
   * key, and return only the envelope.
   *
   * Deliberately not `getSecret(accountId)` plus sealing in the renderer,
   * which is the shape that would have been half the code: the reason this
   * privilege boundary has no secret reader on it is that the renderer is
   * where web content runs, and adding one for the convenience of a background
   * poll would be paying for a feature with the app's one real security
   * property. Main reads the keystore, main does the crypto, and the widest
   * thing the renderer gains is a ciphertext. See `core/secretTransport.ts`.
   */
  sealAccountSecrets(keyRef: string, accountIds: string[]): Promise<SealedAccountSecrets | null>
  /** The receiving end: open one and write what is inside straight to the keystore, answering with account ids only. */
  openAccountSecrets(keyRef: string, envelope: PairingEnvelope): Promise<string[]>
}

/** IPC channel names, in one place so main and preload cannot disagree. */
export const IPC = {
  loadState: 'aevistle:load-state',
  saveState: 'aevistle:save-state',
  setSecret: 'aevistle:set-secret',
  hasSecret: 'aevistle:has-secret',
  deleteSecret: 'aevistle:delete-secret',
  oauthConsent: 'aevistle:oauth-consent',
  oauthStatus: 'aevistle:oauth-status',
  oauthDisconnect: 'aevistle:oauth-disconnect',
  sendNow: 'aevistle:send-now',
  testConnection: 'aevistle:test-connection',
  prewarm: 'aevistle:prewarm',
  setUiLocale: 'aevistle:set-ui-locale',
  setDesktopPrefs: 'aevistle:set-desktop-prefs',
  setBadgeCounts: 'aevistle:set-badge-counts',
  trayCommand: 'aevistle:tray-command',
  downloadDone: 'aevistle:download-done',
  pickFiles: 'aevistle:pick-files',
  snapshotAttachments: 'aevistle:snapshot-attachments',
  revealPath: 'aevistle:reveal-path',
  openPath: 'aevistle:open-path',
  attachBlob: 'aevistle:attach-blob',
  readAttachment: 'aevistle:read-attachment',
  saveAttachmentAs: 'aevistle:save-attachment-as',
  saveAttachmentsTo: 'aevistle:save-attachments-to',
  checkFiles: 'aevistle:check-files',
  attachPaths: 'aevistle:attach-paths',
  syncJobs: 'aevistle:sync-jobs',
  getDispatchLedgerStatus: 'aevistle:get-dispatch-ledger-status',
  syncInbox: 'aevistle:sync-inbox',
  testInbox: 'aevistle:test-inbox',
  watchInbox: 'aevistle:watch-inbox',
  getMessageBody: 'aevistle:get-message-body',
  sanitizeHtml: 'aevistle:sanitize-html',
  setMessageFlags: 'aevistle:set-message-flags',
  deleteInboxMessages: 'aevistle:delete-inbox-messages',
  purgeInboxMessages: 'aevistle:purge-inbox-messages',
  fetchRemoteImage: 'aevistle:fetch-remote-image',
  fetchFeed: 'aevistle:fetch-feed',
  clearImageCache: 'aevistle:clear-image-cache',
  inboxEvent: 'aevistle:inbox-event',
  openMessage: 'aevistle:open-message',
  share: 'aevistle:share',
  notify: 'aevistle:notify',
  openExternal: 'aevistle:open-external',
  appInfo: 'aevistle:app-info',
  dataFolder: 'aevistle:data-folder',
  chooseDataFolder: 'aevistle:choose-data-folder',
  useDataFolder: 'aevistle:use-data-folder',
  openDataFolder: 'aevistle:open-data-folder',
  jobEvent: 'aevistle:job-event',
  checkForUpdate: 'aevistle:check-for-update',
  downloadUpdate: 'aevistle:download-update',
  installUpdate: 'aevistle:install-update',
  updateProgress: 'aevistle:update-progress',
  applyControl: 'aevistle:apply-control',
  controlRequest: 'aevistle:control-request',
  controlResponse: 'aevistle:control-response',
  getControlAudit: 'aevistle:get-control-audit',
  startPairingHost: 'aevistle:start-pairing-host',
  lanAddresses: 'aevistle:lan-addresses',
  stopPairingHost: 'aevistle:stop-pairing-host',
  pairingEvent: 'aevistle:pairing-event',
  pairingJoinRequest: 'aevistle:pairing-join-request',
  applySyncListener: 'aevistle:apply-sync-listener',
  syncRequest: 'aevistle:sync-request',
  syncServerRequest: 'aevistle:sync-server-request',
  syncServerResponse: 'aevistle:sync-server-response',
  getSyncSecret: 'aevistle:get-sync-secret',
  sealAccountSecrets: 'aevistle:seal-account-secrets',
  openAccountSecrets: 'aevistle:open-account-secrets',
} as const
