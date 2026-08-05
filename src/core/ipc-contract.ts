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
  InboxAccountState,
  InboxTag,
  LocaleId,
  MailAccount,
  MessageDraft,
  ScheduledJob,
  SecretKind,
  SendResult,
} from './types'
import type {
  AppInfo,
  DataFolder,
  DataFolderChange,
  InboxEvent,
  InboxMessageBody,
  JobEvent,
} from './bridge'
import type { DownloadProgress, UpdateAsset, UpdateInfo } from './update'
import type { ControlEndpoint, ControlRequest, ControlResponse } from './control'
import type { FeedResponse } from './feeds'
import type { PairingEvent, PairingPayload, PairMode } from './pairing'
import type { SyncListenerStatus, SyncServerRequest, SyncServerResponse } from './syncLoop'

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

  syncJobs(jobs: ScheduledJob[], accounts: MailAccount[]): Promise<void>
  onJobEvent(handler: (event: JobEvent) => void): () => void

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
  ): Promise<void>
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

  notify(title: string, body: string): Promise<void>
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
  }): Promise<ControlEndpoint | null>
  /** Requests arriving from HTTP, the drop folder or the CLI. */
  onControlRequest(handler: (request: ControlRequest) => void): () => void
  /** The answer to one of those, keyed by `request.id`. */
  respondToControl(response: ControlResponse): Promise<void>

  // --- LAN pairing (device-to-device, end-to-end encrypted) --------------
  // See `src/core/pairing.ts` for the handshake and `electron/pairingServer.ts`
  // for the listener. Desktop can play either role; `pairingJoinRequest` is
  // the one both roles share, since a desktop JOINER is just as CSP-blocked
  // from a direct `fetch()` as the Android WebView is.
  /** HOST: open a ~2-minute LAN listener and return the QR payload. `pairId` is required for `mode: 'ongoing'` — see `pairingServer.ts`. */
  startPairingHost(mode: PairMode, pairId?: string): Promise<PairingPayload>
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
}

/** IPC channel names, in one place so main and preload cannot disagree. */
export const IPC = {
  loadState: 'aevistle:load-state',
  saveState: 'aevistle:save-state',
  setSecret: 'aevistle:set-secret',
  hasSecret: 'aevistle:has-secret',
  deleteSecret: 'aevistle:delete-secret',
  sendNow: 'aevistle:send-now',
  testConnection: 'aevistle:test-connection',
  prewarm: 'aevistle:prewarm',
  setUiLocale: 'aevistle:set-ui-locale',
  setDesktopPrefs: 'aevistle:set-desktop-prefs',
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
  startPairingHost: 'aevistle:start-pairing-host',
  stopPairingHost: 'aevistle:stop-pairing-host',
  pairingEvent: 'aevistle:pairing-event',
  pairingJoinRequest: 'aevistle:pairing-join-request',
  applySyncListener: 'aevistle:apply-sync-listener',
  syncRequest: 'aevistle:sync-request',
  syncServerRequest: 'aevistle:sync-server-request',
  syncServerResponse: 'aevistle:sync-server-response',
  getSyncSecret: 'aevistle:get-sync-secret',
} as const
