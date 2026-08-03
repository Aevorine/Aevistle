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

interface AevistleNativePlugin {
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

export function createAndroidBridge(): PlatformBridge {
  return {
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

    syncJobs: (jobs, accounts) => Native.syncJobs({ jobs, accounts }),

    onJobEvent(handler) {
      const pending = Native.addListener('jobEvent', handler)
      return () => {
        void pending.then((h) => h.remove())
      }
    },

    syncInbox: (config) => Native.syncInbox({ config }),
    testInbox: (config, secret) => Native.testInbox({ config, secret }),
    getMessageBody: (config, folderPath, uid) => Native.getMessageBody({ config, folderPath, uid }),
    setMessageFlags: (config, folderPath, uid, patch) =>
      Native.setMessageFlags({ config, folderPath, uid, patch }),
    deleteInboxMessages: (accountId, items) => Native.deleteInboxMessages({ accountId, items }),
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
  }
}
