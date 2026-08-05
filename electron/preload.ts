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
} from '../src/core/ipc-contract'
import type { InboxEvent, JobEvent } from '../src/core/bridge'
import type { DownloadProgress } from '../src/core/update'
import type { ControlRequest } from '../src/core/control'
import type { PairingEvent } from '../src/core/pairing'
import type { SyncServerRequest } from '../src/core/syncLoop'

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

const api: DesktopApi = {
  loadState: () => ipcRenderer.invoke(IPC.loadState),
  saveState: (state) => ipcRenderer.invoke(IPC.saveState, state),

  setSecret: (accountId, secret, kind) => ipcRenderer.invoke(IPC.setSecret, accountId, secret, kind),
  hasSecret: (accountId, kind) => ipcRenderer.invoke(IPC.hasSecret, accountId, kind),
  deleteSecret: (accountId, kind) => ipcRenderer.invoke(IPC.deleteSecret, accountId, kind),

  sendNow: (draft, account) => ipcRenderer.invoke(IPC.sendNow, draft, account),
  testConnection: (account, secret) => ipcRenderer.invoke(IPC.testConnection, account, secret),
  prewarm: (account) => ipcRenderer.invoke(IPC.prewarm, account),
  setUiLocale: (locale) => ipcRenderer.invoke(IPC.setUiLocale, locale),
  setDesktopPrefs: (prefs) => ipcRenderer.invoke(IPC.setDesktopPrefs, prefs),

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

  syncJobs: (jobs, accounts) => ipcRenderer.invoke(IPC.syncJobs, jobs, accounts),

  onJobEvent: (handler) => {
    const listener = (_event: unknown, payload: JobEvent) => handler(payload)
    ipcRenderer.on(IPC.jobEvent, listener)
    return () => ipcRenderer.removeListener(IPC.jobEvent, listener)
  },

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

  notify: (title, body) => ipcRenderer.invoke(IPC.notify, title, body),
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

  onUpdateProgress: (handler) => {
    const listener = (_event: unknown, payload: DownloadProgress) => handler(payload)
    ipcRenderer.on(IPC.updateProgress, listener)
    return () => ipcRenderer.removeListener(IPC.updateProgress, listener)
  },
}

contextBridge.exposeInMainWorld('aevistle', api)
