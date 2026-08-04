/**
 * Android implementation.
 *
 * Everything that needs a socket, the keystore, the file picker or an alarm
 * goes to the `AevistleNative` Capacitor plugin (Kotlin, see
 * `android/app/src/main/java/.../AevistleNativePlugin.kt`). Bulk state stays on
 * the JS side in Capacitor Preferences.
 */

import { registerPlugin } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import type {
  AppInfo,
  DataFolder,
  DataFolderChange,
  InboxMessageBody,
  JobEvent,
  JobRun,
  PlatformBridge,
} from './bridge'
import { failedResult } from './bridge'
import { fetchLatest } from './update'
import type {
  AppState,
  Attachment,
  InboxAccountState,
  InboxTag,
  MailAccount,
  MessageDraft,
  ScheduledJob,
  SecretKind,
  SendResult,
} from './types'

const STATE_KEY = 'aevistle.state.v1'

// ---------------------------------------------------------------------------
// Android-only permission surface
//
// Not part of `PlatformBridge`, because it describes something only Android
// has: two permissions the app cannot do its job without, either of which the
// user can refuse without anything appearing to break. The desktop has no
// equivalent state to report and no settings screen to send anyone to.
//
// Consumers should reach it by narrowing rather than importing this module —
// `bridge-android.ts` pulls in the Capacitor runtime and is deliberately loaded
// only on Android (see `getBridge`). A type-only import costs nothing:
//
//   import type { AndroidPermissionApi } from '../core/bridge-android'
//   const android = bridge as Partial<AndroidPermissionApi>
//   const state = await android.permissionState?.()
// ---------------------------------------------------------------------------

/**
 * `granted` — held, or never required on this Android version.
 * `prompt`  — the system dialog would appear if asked.
 * `blocked` — asking does nothing; only system settings can change it. Either
 *             the user chose "don't allow" twice, or they turned the app's
 *             notifications off wholesale afterwards.
 */
export type NotificationPermission = 'granted' | 'prompt' | 'blocked'

/**
 * `not-required` — below Android 12, where exact alarms need no permission.
 * `denied`       — alarms are being set inexact, so a 09:00 reminder can land
 *                  materially late. There is no dialog for this one; the only
 *                  route is `openExactAlarmSettings`.
 */
export type ExactAlarmPermission = 'granted' | 'denied' | 'not-required'

export interface AndroidPermissionState {
  notifications: NotificationPermission
  exactAlarms: ExactAlarmPermission
  /**
   * Whether `requestNotificationPermission` would actually raise a dialog.
   * False when blocked — offer `openNotificationSettings` instead of a button
   * that visibly does nothing.
   */
  canAskNotifications: boolean
}

export interface AndroidPermissionApi {
  /** What the app is allowed to do right now. Cheap; safe to poll on resume. */
  permissionState(): Promise<AndroidPermissionState>
  /**
   * Raise the notification permission dialog, because the user asked for it.
   * Resolves with the state afterwards, `prompted` saying whether a dialog was
   * actually shown. Never rejects on refusal — a refusal is an answer.
   */
  requestNotificationPermission(): Promise<AndroidPermissionState & { prompted: boolean }>
  /** Open this app's notification settings. Resolves once the screen is launched. */
  openNotificationSettings(): Promise<{ opened: boolean }>
  /** Open this app's "Alarms & reminders" screen. Only meaningful on Android 12+. */
  openExactAlarmSettings(): Promise<{ opened: boolean }>
}

interface AevistleNativePlugin extends AndroidPermissionApi {
  /**
   * "Is now a moment that earns a permission dialog?"
   *
   * The native side answers, not this one: it compares the incoming jobs with
   * the ones it already had and only prompts when a reminder genuinely became
   * armed. Cold start re-sends the same jobs, so calling this on every sync
   * does not turn into a dialog on every launch. Fire-and-forget by design —
   * see the `syncJobs` implementation below.
   */
  ensureNotificationPermission(): Promise<AndroidPermissionState & { prompted: boolean }>

  setSecret(opts: { accountId: string; secret: string; kind?: SecretKind }): Promise<void>
  hasSecret(opts: { accountId: string; kind?: SecretKind }): Promise<{ value: boolean }>
  deleteSecret(opts: { accountId: string; kind?: SecretKind }): Promise<void>

  sendNow(opts: { draft: MessageDraft; account: MailAccount }): Promise<SendResult>
  testConnection(opts: { account: MailAccount; secret?: string }): Promise<SendResult>

  pickFiles(): Promise<{ files: Attachment[] }>
  snapshotAttachments(opts: {
    attachments: Attachment[]
    jobId: string
  }): Promise<{ files: Attachment[] }>

  syncJobs(opts: { jobs: ScheduledJob[]; accounts: MailAccount[] }): Promise<void>
  pullJobRuns(): Promise<{ runs: Array<JobRun & { jobId: string }> }>
  notify(opts: { title: string; body: string; code?: boolean }): Promise<void>
  appInfo(): Promise<AppInfo>

  dataFolder(): Promise<DataFolder>
  useDataFolder(opts: { optionId: string; move: boolean }): Promise<DataFolderChange>
  openDataFolder(): Promise<void>

  // --- inbox (receiving) ---------------------------------------------------
  // Doubles as how the native side learns which accounts its periodic
  // background sync should touch — see AevistleNativePlugin.java's header
  // comment. There is no separate "push config" method.
  syncInbox(opts: { config: InboxAccountState }): Promise<InboxAccountState>
  testInbox(opts: { config: InboxAccountState; secret?: string }): Promise<SendResult>
  getMessageBody(opts: {
    config: InboxAccountState
    folderPath: string
    uid: number
  }): Promise<InboxMessageBody>
  setMessageFlags(opts: {
    config: InboxAccountState
    folderPath: string
    uid: number
    patch: { seen?: boolean; tag?: InboxTag }
  }): Promise<void>
  deleteInboxMessages(opts: {
    accountId: string
    items: Array<{ folderPath: string; uid: number }>
  }): Promise<void>
  purgeInboxMessages(opts: {
    config: InboxAccountState
    items: Array<{ folderPath: string; uid: number }>
  }): Promise<void>
  fetchRemoteImage(opts: { url: string }): Promise<{ value: string }>
  downloadInboxAttachment(opts: {
    config: InboxAccountState
    folderPath: string
    uid: number
    partIndex: number
    name: string
  }): Promise<{ name: string; size: number; mime: string; path: string }>
  readAttachment(opts: { path: string }): Promise<{ dataUrl?: string; mime?: string }>
  openPath(opts: { path: string }): Promise<void>
  saveAttachmentAs(opts: { path: string; suggestedName: string }): Promise<{ value?: string }>
  saveAttachmentsTo(opts: { paths: string[] }): Promise<{ folder?: string; saved?: number }>

  addListener(
    eventName: 'jobEvent',
    handler: (event: JobEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const Native = registerPlugin<AevistleNativePlugin>('AevistleNative')

export function createAndroidBridge(): PlatformBridge & AndroidPermissionApi {
  const bridge: PlatformBridge & AndroidPermissionApi = {
    platform: 'android',

    async loadState() {
      const { value } = await Preferences.get({ key: STATE_KEY })
      if (!value) return null
      try {
        return JSON.parse(value) as Partial<AppState>
      } catch {
        // A corrupted store must not brick the app; start clean instead.
        await Preferences.remove({ key: STATE_KEY })
        return null
      }
    },

    async saveState(state: AppState) {
      await Preferences.set({ key: STATE_KEY, value: JSON.stringify(state) })
    },

    setSecret: (accountId, secret, kind) => Native.setSecret({ accountId, secret, kind }),
    hasSecret: (accountId, kind) => Native.hasSecret({ accountId, kind }).then((r) => r.value),
    deleteSecret: (accountId, kind) => Native.deleteSecret({ accountId, kind }),

    async sendNow(draft, account) {
      const started = Date.now()
      try {
        return await Native.sendNow({ draft, account })
      } catch (e) {
        return failedResult(e, started)
      }
    },

    async testConnection(account, secret) {
      const started = Date.now()
      try {
        return await Native.testConnection({ account, secret })
      } catch (e) {
        return failedResult(e, started)
      }
    },

    async pickFiles() {
      const { files } = await Native.pickFiles()
      return files
    },

    async snapshotAttachments(attachments, jobId) {
      const { files } = await Native.snapshotAttachments({ attachments, jobId })
      return files
    },

    async revealPath() {
      // Android has no "show in folder" equivalent worth surfacing; "Save
      // as…" below is what someone reaching for it actually wants.
    },

    /**
     * Fetch the bytes if they are not here yet, then answer with the same
     * attachment carrying a real path.
     *
     * A `partIndex` is required to ask the server for the right MIME part. Its
     * absence means the record predates this feature, and re-syncing the
     * message is the only way to obtain one — so this returns the attachment
     * untouched rather than downloading the wrong part.
     */
    async ensureAttachment(config, folderPath, uid, attachment) {
      if (attachment.path) return attachment
      if (attachment.partIndex === undefined) return attachment
      const file = await Native.downloadInboxAttachment({
        config,
        folderPath,
        uid,
        partIndex: attachment.partIndex,
        name: attachment.name,
      })
      return {
        ...attachment,
        name: file.name || attachment.name,
        size: file.size || attachment.size,
        mime: file.mime || attachment.mime,
        path: file.path,
      }
    },

    async readAttachment(path) {
      const result = await Native.readAttachment({ path })
      return result.dataUrl && result.mime
        ? { dataUrl: result.dataUrl, mime: result.mime }
        : null
    },

    openPath: (path) => Native.openPath({ path }),

    async saveAttachmentAs(path, suggestedName) {
      const { value } = await Native.saveAttachmentAs({ path, suggestedName })
      return value ?? null
    },

    async saveAttachmentsTo(paths) {
      const result = await Native.saveAttachmentsTo({ paths })
      return result.saved === undefined ? null : { folder: result.folder ?? '', saved: result.saved }
    },

    /**
     * Arm the schedule, then — separately — let the native side decide whether
     * this was the moment to ask for notification permission.
     *
     * Two calls rather than one for a specific reason. Capacitor's permission
     * request holds the originating call open until the user answers the
     * dialog, and the caller of `syncJobs` awaits it before it will believe the
     * schedule is armed. Folding the request into this call would mean a
     * permission dialog left on screen hangs the arm path, and a health strip
     * that reads "reminders are not armed" while they are. So: await the
     * arming, fire the question after it, and never let the answer to the
     * question affect whether arming succeeded.
     */
    async syncJobs(jobs, accounts) {
      await Native.syncJobs({ jobs, accounts })
      void Native.ensureNotificationPermission().catch(() => {})
    },

    // Sends that fired while the app was closed — which on Android is most of
    // them. Without this the mail goes out and the schedule row keeps saying
    // "waiting to send" until the job is edited by hand.
    async pullJobRuns() {
      const { runs } = await Native.pullJobRuns()
      return Array.isArray(runs) ? runs : []
    },

    onJobEvent(handler) {
      const pending = Native.addListener('jobEvent', handler)
      return () => {
        void pending.then((h) => h.remove())
      }
    },

    /** Same shape as `syncJobs`: switching an inbox on is the other moment
     * where "we would like to notify you" needs no explaining. */
    async syncInbox(config) {
      const updated = await Native.syncInbox({ config })
      void Native.ensureNotificationPermission().catch(() => {})
      return updated
    },
    testInbox: (config, secret) => Native.testInbox({ config, secret }),
    getMessageBody: (config, folderPath, uid) => Native.getMessageBody({ config, folderPath, uid }),
    setMessageFlags: (config, folderPath, uid, patch) =>
      Native.setMessageFlags({ config, folderPath, uid, patch }),
    deleteInboxMessages: (accountId, items) => Native.deleteInboxMessages({ accountId, items }),
    purgeInboxMessages: (config, items) => Native.purgeInboxMessages({ config, items }),
    fetchRemoteImage: (url) => Native.fetchRemoteImage({ url }).then((r) => r.value),
    // No native push exists yet — WorkManager's periodic sync updates its own
    // cache silently and the UI catches up on the next manual or app-open
    // sync, the same way `onJobEvent` is declared here but never actually
    // fires natively either (see AlarmReceiver/SendWorker: nothing calls
    // notifyListeners for it). A real event bridge is a legitimate follow-up,
    // not a gap unique to inbox.
    onInboxEvent() {
      return () => {}
    },

    dataFolder: () => Native.dataFolder(),

    async chooseDataFolder() {
      // Android hands out storage by volume, not by arbitrary path: a folder
      // picked through the document picker gives back a content:// tree that
      // the background sender cannot open as a plain file. The listed volumes
      // are the ones that genuinely work.
      throw new Error('Choose one of the listed storage locations instead.')
    },

    useDataFolder: (optionId, move) => Native.useDataFolder({ optionId, move }),

    async openDataFolder() {
      await Native.openDataFolder()
    },

    /**
     * The WebView can reach the GitHub API directly, so the check needs no
     * native code. Installing does: an APK has to go through the system
     * package installer, which means handing the URL to the browser rather
     * than downloading it here.
     */
    async checkForUpdate() {
      const info = await Native.appInfo().catch(() => null)
      return fetchLatest(info?.version ?? __APP_VERSION__, 'android')
    },

    notify: (title, body, opts) => Native.notify({ title, body, code: opts?.code }),

    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },

    appInfo: () => Native.appInfo(),

    // --- Android-only permission surface -----------------------------------
    // Straight pass-throughs. The decisions — when a dialog is worth raising,
    // which settings screen an OEM actually has — all live natively, in
    // Permissions.java, because they are all questions about the device.
    permissionState: () => Native.permissionState(),
    requestNotificationPermission: () => Native.requestNotificationPermission(),
    openNotificationSettings: () => Native.openNotificationSettings(),
    openExactAlarmSettings: () => Native.openExactAlarmSettings(),
  }

  return bridge
}
