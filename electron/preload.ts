/**
 * The privilege boundary.
 *
 * Context isolation is on and node integration is off, so the renderer sees
 * exactly the functions listed here and nothing else — no `require`, no
 * `ipcRenderer`, no `process`. Each one forwards plain serialisable data to a
 * handler in the main process.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type DesktopApi, type TrayCommand } from '../src/core/ipc-contract'
import type { InboxEvent, JobEvent } from '../src/core/bridge'
import type { DownloadProgress } from '../src/core/update'
import type { ControlRequest } from '../src/core/control'

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
  setMessageFlags: (config, folderPath, uid, patch) =>
    ipcRenderer.invoke(IPC.setMessageFlags, config, folderPath, uid, patch),
  deleteInboxMessages: (accountId, items) =>
    ipcRenderer.invoke(IPC.deleteInboxMessages, accountId, items),
  purgeInboxMessages: (accountId, config, items) =>
    ipcRenderer.invoke(IPC.purgeInboxMessages, accountId, config, items),
  fetchRemoteImage: (url) => ipcRenderer.invoke(IPC.fetchRemoteImage, url),

  onInboxEvent: (handler) => {
    const listener = (_event: unknown, payload: InboxEvent) => handler(payload)
    ipcRenderer.on(IPC.inboxEvent, listener)
    return () => ipcRenderer.removeListener(IPC.inboxEvent, listener)
  },

  onTrayCommand: (handler) => {
    const listener = (_event: unknown, command: TrayCommand) => handler(command)
    ipcRenderer.on(IPC.trayCommand, listener)
    return () => ipcRenderer.removeListener(IPC.trayCommand, listener)
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

  onUpdateProgress: (handler) => {
    const listener = (_event: unknown, payload: DownloadProgress) => handler(payload)
    ipcRenderer.on(IPC.updateProgress, listener)
    return () => ipcRenderer.removeListener(IPC.updateProgress, listener)
  },
}

contextBridge.exposeInMainWorld('aevistle', api)
