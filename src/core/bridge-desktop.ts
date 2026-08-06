/** Electron implementation — a thin pass-through to the preload API. */

import type { PlatformBridge } from './bridge'
import type { DesktopApi } from './ipc-contract'

export function createDesktopBridge(): PlatformBridge {
  const api = (window as unknown as { aevistle: DesktopApi }).aevistle
  if (!api) throw new Error('Desktop bridge requested but window.aevistle is missing')

  return {
    platform: 'desktop',

    loadState: () => api.loadState(),
    saveState: (state) => api.saveState(state),

    setSecret: (id, secret, kind) => api.setSecret(id, secret, kind),
    hasSecret: (id, kind) => api.hasSecret(id, kind),
    deleteSecret: (id, kind) => api.deleteSecret(id, kind),

    sendNow: (draft, account) => api.sendNow(draft, account),
    testConnection: (account, secret) => api.testConnection(account, secret),
    prewarm: (account) => api.prewarm(account),
    setUiLocale: (locale) => api.setUiLocale(locale),
    setDesktopPrefs: (prefs) => api.setDesktopPrefs(prefs),
    onTrayCommand: (handler) => api.onTrayCommand(handler),
    onDownloadDone: (handler) => api.onDownloadDone(handler),

    applyControl: (settings) => api.applyControl(settings),
    onControlRequest: (handler) => api.onControlRequest(handler),
    respondToControl: (response) => api.respondToControl(response),

    startPairingHost: (mode, pairId, host) => api.startPairingHost(mode, pairId, host),
    lanAddresses: () => api.lanAddresses(),
    stopPairingHost: () => api.stopPairingHost(),
    onPairingEvent: (handler) => api.onPairingEvent(handler),
    pairingJoinRequest: (url, body) => api.pairingJoinRequest(url, body),

    applySyncListener: (enabled) => api.applySyncListener(enabled),
    syncRequest: (url, body) => api.syncRequest(url, body),
    onSyncServerRequest: (handler) => api.onSyncServerRequest(handler),
    respondToSyncServer: (response) => api.respondToSyncServer(response),
    getSyncSecret: (keyRef) => api.getSyncSecret(keyRef),
    sealAccountSecrets: (keyRef, accountIds) => api.sealAccountSecrets(keyRef, accountIds),
    openAccountSecrets: (keyRef, envelope) => api.openAccountSecrets(keyRef, envelope),

    pickFiles: () => api.pickFiles(),
    snapshotAttachments: (attachments, jobId) => api.snapshotAttachments(attachments, jobId),
    revealPath: (path) => api.revealPath(path),
    openPath: (path) => api.openPath(path),
    attachBlob: (name, mime, data) => api.attachBlob(name, mime, data),
    readAttachment: (path) => api.readAttachment(path),
    saveAttachmentAs: (path, suggestedName) => api.saveAttachmentAs(path, suggestedName),
    saveAttachmentsTo: (paths) => api.saveAttachmentsTo(paths),
    checkFiles: (paths) => api.checkFiles(paths),
    attachPaths: (paths) => api.attachPaths(paths),
    pathForFile: (file) => api.pathForFile(file),

    syncJobs: (jobs, accounts) => api.syncJobs(jobs, accounts),
    onJobEvent: (handler) => api.onJobEvent(handler),

    syncInbox: (config) => api.syncInbox(config),
    testInbox: (config, secret) => api.testInbox(config, secret),
    watchInbox: (configs) => api.watchInbox(configs),
    getMessageBody: (config, folderPath, uid) => api.getMessageBody(config, folderPath, uid),
    sanitizeHtml: (html) => api.sanitizeHtml(html),
    setMessageFlags: (config, folderPath, uid, patch) =>
      api.setMessageFlags(config, folderPath, uid, patch),
    deleteInboxMessages: (accountId, items) => api.deleteInboxMessages(accountId, items),
    purgeInboxMessages: (config, items) =>
      api.purgeInboxMessages(config.accountId, config, items),
    fetchRemoteImage: (url) => api.fetchRemoteImage(url),
    fetchFeed: (url) => api.fetchFeed(url),
    onInboxEvent: (handler) => api.onInboxEvent(handler),

    dataFolder: () => api.dataFolder(),
    chooseDataFolder: (move) => api.chooseDataFolder(move),
    useDataFolder: (optionId, move) => api.useDataFolder(optionId, move),
    openDataFolder: () => api.openDataFolder(),

    checkForUpdate: () => api.checkForUpdate(),
    downloadUpdate: (asset) => api.downloadUpdate(asset),
    installUpdate: (filePath) => api.installUpdate(filePath),
    onUpdateProgress: (handler) => api.onUpdateProgress(handler),

    notify: (title, body) => api.notify(title, body),
    openExternal: (url) => api.openExternal(url),
    appInfo: () => api.appInfo(),
  }
}
