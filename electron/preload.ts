/**
 * The privilege boundary.
 *
 * Context isolation is on and node integration is off, so the renderer sees
 * exactly the functions listed here and nothing else — no `require`, no
 * `ipcRenderer`, no `process`. Each one forwards plain serialisable data to a
 * handler in the main process.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type DesktopApi,
  type DownloadOutcome,
  type TrayCommand,
} from '../src/core/platform/ipc-contract'
import type { InboxEvent, JobEvent } from '../src/core/platform/bridge'
import type { SharePayload } from '../src/core/types'
import type { DownloadProgress } from '../src/core/platform/update'
import type { ControlRequest } from '../src/core/sync/control'
import type { PairingEvent } from '../src/core/sync/pairing'
import type { SyncServerRequest } from '../src/core/sync/syncLoop'

/**
 * Tray commands that arrived before the page had a listener.
 *
 * Filled by the subscription below, which is installed as soon as this script
 * runs — long before React exists — and drained by the first `onTrayCommand`
 * caller.
 */
const pendingTrayCommands: TrayCommand[] = []
let trayCommandDelivered = false
ipcRenderer.on(IPC.trayCommand, (_event, command: TrayCommand) => {
  if (trayCommandDelivered) return
  pendingTrayCommands.push(command)
})

/**
 * The same treatment for a notification click, and for the same reason.
 *
 * Clicking "new mail from X" while the window is closed asks the main process
 * to open one. The page it opens has not mounted React yet, so an id sent
 * straight through would be dropped and the app would come up on whatever
 * screen it was last on — which reads as a notification that does nothing,
 * exactly the shape of bug this feature was added to remove. Only the newest
 * is kept: two clicks before the page is alive still means one message to open,
 * and it is the one clicked last.
 */
let pendingOpenMessage: string | null = null
let openMessageDelivered = false
ipcRenderer.on(IPC.openMessage, (_event, messageId: string) => {
  if (openMessageDelivered) return
  pendingOpenMessage = messageId
})

/**
 * And again for a share, where the buffer is not a safety net but the whole
 * mechanism.
 *
 * Following a `mailto:` link with Aevistle closed *starts* Aevistle. The main
 * process parses the command line before a BrowserWindow exists, and the
 * window it then opens has to load a page and mount React before anything in
 * the app can listen. Every millisecond of that is time an unbuffered
 * `webContents.send` would land in a page with no listener and vanish — the
 * exact silent no-op that makes a feature look implemented and do nothing.
 *
 * Only the newest is kept, for the same reason as above: two links followed
 * before the page is alive still means one message to write.
 *
 * `shareDelivered` tracks whether a listener is attached *right now*, not
 * whether one ever was. It used to latch on for the life of the window, which
 * meant the buffer stopped recording the moment the app first subscribed —
 * so any payload arriving while nobody was listening again was dropped with no
 * trace. There are two ordinary ways to end up in that window: React's
 * development double-mount, and the share effect resubscribing when `ready`
 * turns true, which it now does on every cold start. Cleared on unsubscribe.
 */
let pendingShare: SharePayload | null = null
let shareDelivered = false
ipcRenderer.on(IPC.share, (_event, share: SharePayload) => {
  if (shareDelivered) return
  pendingShare = share
})

const api: DesktopApi = {
  loadState: () => ipcRenderer.invoke(IPC.loadState),
  saveState: (state) => ipcRenderer.invoke(IPC.saveState, state),

  setSecret: (accountId, secret, kind) => ipcRenderer.invoke(IPC.setSecret, accountId, secret, kind),
  hasSecret: (accountId, kind) => ipcRenderer.invoke(IPC.hasSecret, accountId, kind),
  deleteSecret: (accountId, kind) => ipcRenderer.invoke(IPC.deleteSecret, accountId, kind),

  oauthConsent: (accountId, providerId, loginHint) =>
    ipcRenderer.invoke(IPC.oauthConsent, accountId, providerId, loginHint),
  oauthStatus: (accountId, providerId) =>
    ipcRenderer.invoke(IPC.oauthStatus, accountId, providerId),
  oauthDisconnect: (accountId) => ipcRenderer.invoke(IPC.oauthDisconnect, accountId),

  sendNow: (draft, account) => ipcRenderer.invoke(IPC.sendNow, draft, account),
  testConnection: (account, secret) => ipcRenderer.invoke(IPC.testConnection, account, secret),
  prewarm: (account) => ipcRenderer.invoke(IPC.prewarm, account),
  setUiLocale: (locale) => ipcRenderer.invoke(IPC.setUiLocale, locale),
  setDesktopPrefs: (prefs) => ipcRenderer.invoke(IPC.setDesktopPrefs, prefs),
  backgroundMailCheckState: () => ipcRenderer.invoke(IPC.backgroundMailCheckState),
  toggleShortcutState: () => ipcRenderer.invoke(IPC.toggleShortcutState),
  setBadgeCounts: (counts) => ipcRenderer.invoke(IPC.setBadgeCounts, counts),

  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),
  snapshotAttachments: (attachments, jobId) =>
    ipcRenderer.invoke(IPC.snapshotAttachments, attachments, jobId),
  revealPath: (p) => ipcRenderer.invoke(IPC.revealPath, p),
  openPath: (p) => ipcRenderer.invoke(IPC.openPath, p),
  attachBlob: (name, mime, data) => ipcRenderer.invoke(IPC.attachBlob, name, mime, data),
  readAttachment: (p) => ipcRenderer.invoke(IPC.readAttachment, p),
  saveAttachmentAs: (p, suggestedName) =>
    ipcRenderer.invoke(IPC.saveAttachmentAs, p, suggestedName),
  saveAttachmentsTo: (paths) => ipcRenderer.invoke(IPC.saveAttachmentsTo, paths),
  checkFiles: (paths) => ipcRenderer.invoke(IPC.checkFiles, paths),
  attachPaths: (paths) => ipcRenderer.invoke(IPC.attachPaths, paths),
  // Not IPC: `webUtils` resolves the path in the renderer's own process. It
  // is the supported replacement for `File.path`, which Electron removed —
  // and it is why a drop can finally attach the file that was dropped rather
  // than reopening the picker.
  pathForFile: (file) => webUtils.getPathForFile(file),

  syncJobs: (jobs, accounts, headless) =>
    ipcRenderer.invoke(IPC.syncJobs, jobs, accounts, headless),

  onJobEvent: (handler) => {
    const listener = (_event: unknown, payload: JobEvent) => handler(payload)
    ipcRenderer.on(IPC.jobEvent, listener)
    return () => ipcRenderer.removeListener(IPC.jobEvent, listener)
  },
  getDispatchLedgerStatus: () => ipcRenderer.invoke(IPC.getDispatchLedgerStatus),

  syncInbox: (config) => ipcRenderer.invoke(IPC.syncInbox, config),
  testInbox: (config, secret) => ipcRenderer.invoke(IPC.testInbox, config, secret),
  watchInbox: (configs) => ipcRenderer.invoke(IPC.watchInbox, configs),
  getMessageBody: (config, folderPath, uid) =>
    ipcRenderer.invoke(IPC.getMessageBody, config, folderPath, uid),
  sanitizeHtml: (html) => ipcRenderer.invoke(IPC.sanitizeHtml, html),
  setMessageFlags: (config, folderPath, uid, patch) =>
    ipcRenderer.invoke(IPC.setMessageFlags, config, folderPath, uid, patch),
  deleteInboxMessages: (accountId, items) =>
    ipcRenderer.invoke(IPC.deleteInboxMessages, accountId, items),
  purgeInboxMessages: (accountId, config, items) =>
    ipcRenderer.invoke(IPC.purgeInboxMessages, accountId, config, items),
  fetchRemoteImage: (url) => ipcRenderer.invoke(IPC.fetchRemoteImage, url),
  fetchFeed: (url) => ipcRenderer.invoke(IPC.fetchFeed, url),
  clearImageCache: () => ipcRenderer.invoke(IPC.clearImageCache),

  onInboxEvent: (handler) => {
    const listener = (_event: unknown, payload: InboxEvent) => handler(payload)
    ipcRenderer.on(IPC.inboxEvent, listener)
    return () => ipcRenderer.removeListener(IPC.inboxEvent, listener)
  },

  onTrayCommand: (handler) => {
    // Anything that arrived before React mounted is replayed here.
    //
    // "Compose" from the tray menu with the window closed used to do nothing
    // visible: the main process opened a window and sent the command into a
    // page that had not run a line of app code yet, so the message was
    // dropped and the app came up on whatever screen it was last on. The
    // preload script, unlike the page, is alive the whole time — so it is the
    // one place that can hold the command until someone is listening.
    trayCommandDelivered = true
    const queued = pendingTrayCommands.splice(0)
    const listener = (_event: unknown, command: TrayCommand) => handler(command)
    ipcRenderer.on(IPC.trayCommand, listener)
    for (const command of queued) handler(command)
    return () => ipcRenderer.removeListener(IPC.trayCommand, listener)
  },

  onDownloadDone: (handler) => {
    const listener = (_event: unknown, outcome: DownloadOutcome) => handler(outcome)
    ipcRenderer.on(IPC.downloadDone, listener)
    return () => ipcRenderer.removeListener(IPC.downloadDone, listener)
  },

  onOpenMessage: (handler) => {
    openMessageDelivered = true
    const queued = pendingOpenMessage
    pendingOpenMessage = null
    const listener = (_event: unknown, messageId: string) => handler(messageId)
    ipcRenderer.on(IPC.openMessage, listener)
    if (queued) handler(queued)
    return () => ipcRenderer.removeListener(IPC.openMessage, listener)
  },

  onShare: (handler) => {
    // Whatever the command line carried is replayed here — see the buffer at
    // the top of this file for why that is the only thing that can work.
    shareDelivered = true
    const queued = pendingShare
    pendingShare = null
    const listener = (_event: unknown, share: SharePayload) => handler(share)
    ipcRenderer.on(IPC.share, listener)
    if (queued) handler(queued)
    return () => {
      ipcRenderer.removeListener(IPC.share, listener)
      shareDelivered = false
    }
  },

  notify: (title, body, messageId) => ipcRenderer.invoke(IPC.notify, title, body, messageId),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),

  dataFolder: () => ipcRenderer.invoke(IPC.dataFolder),
  chooseDataFolder: (move) => ipcRenderer.invoke(IPC.chooseDataFolder, move),
  useDataFolder: (optionId, move) => ipcRenderer.invoke(IPC.useDataFolder, optionId, move),
  openDataFolder: () => ipcRenderer.invoke(IPC.openDataFolder),

  checkForUpdate: () => ipcRenderer.invoke(IPC.checkForUpdate),
  downloadUpdate: (asset) => ipcRenderer.invoke(IPC.downloadUpdate, asset),
  installUpdate: (filePath) => ipcRenderer.invoke(IPC.installUpdate, filePath),

  applyControl: (settings) => ipcRenderer.invoke(IPC.applyControl, settings),
  respondToControl: (response) => ipcRenderer.invoke(IPC.controlResponse, response),
  onControlRequest: (handler) => {
    const listener = (_event: unknown, payload: ControlRequest) => handler(payload)
    ipcRenderer.on(IPC.controlRequest, listener)
    return () => ipcRenderer.removeListener(IPC.controlRequest, listener)
  },
  getControlAudit: () => ipcRenderer.invoke(IPC.getControlAudit),

  startPairingHost: (mode, pairId, host) =>
    ipcRenderer.invoke(IPC.startPairingHost, mode, pairId, host),
  lanAddresses: () => ipcRenderer.invoke(IPC.lanAddresses),
  stopPairingHost: () => ipcRenderer.invoke(IPC.stopPairingHost),
  pairingJoinRequest: (url, body) => ipcRenderer.invoke(IPC.pairingJoinRequest, url, body),
  onPairingEvent: (handler) => {
    const listener = (_event: unknown, payload: PairingEvent) => handler(payload)
    ipcRenderer.on(IPC.pairingEvent, listener)
    return () => ipcRenderer.removeListener(IPC.pairingEvent, listener)
  },

  applySyncListener: (enabled) => ipcRenderer.invoke(IPC.applySyncListener, enabled),
  syncRequest: (url, body) => ipcRenderer.invoke(IPC.syncRequest, url, body),
  respondToSyncServer: (response) => ipcRenderer.invoke(IPC.syncServerResponse, response),
  onSyncServerRequest: (handler) => {
    const listener = (_event: unknown, payload: SyncServerRequest) => handler(payload)
    ipcRenderer.on(IPC.syncServerRequest, listener)
    return () => ipcRenderer.removeListener(IPC.syncServerRequest, listener)
  },
  getSyncSecret: (keyRef) => ipcRenderer.invoke(IPC.getSyncSecret, keyRef),
  sealAccountSecrets: (keyRef, accountIds) =>
    ipcRenderer.invoke(IPC.sealAccountSecrets, keyRef, accountIds),
  openAccountSecrets: (keyRef, envelope) =>
    ipcRenderer.invoke(IPC.openAccountSecrets, keyRef, envelope),

  onUpdateProgress: (handler) => {
    const listener = (_event: unknown, payload: DownloadProgress) => handler(payload)
    ipcRenderer.on(IPC.updateProgress, listener)
    return () => ipcRenderer.removeListener(IPC.updateProgress, listener)
  },
}

contextBridge.exposeInMainWorld('aevistle', api)
