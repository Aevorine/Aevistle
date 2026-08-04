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

/**
 * Tray menu items that are a request to the *window*, not to the app.
 *
 * Pausing lives here rather than in the main process even though the scheduler
 * is there: state is owned by the renderer, and a main-process pause would be
 * overwritten by the next debounced save. Same reasoning as the control
 * interface — one reducer, one source of truth, whatever the entry point.
 */
export type TrayCommand = 'compose' | 'schedule' | 'logs' | 'pauseAll' | 'resumeAll'

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
   * report where it ended up. Returns null when the interface is off.
   */
  applyControl(settings: { enabled: boolean; allowSending: boolean }): Promise<ControlEndpoint | null>
  /** Requests arriving from HTTP, the drop folder or the CLI. */
  onControlRequest(handler: (request: ControlRequest) => void): () => void
  /** The answer to one of those, keyed by `request.id`. */
  respondToControl(response: ControlResponse): Promise<void>
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
  setMessageFlags: 'aevistle:set-message-flags',
  deleteInboxMessages: 'aevistle:delete-inbox-messages',
  purgeInboxMessages: 'aevistle:purge-inbox-messages',
  fetchRemoteImage: 'aevistle:fetch-remote-image',
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
} as const
