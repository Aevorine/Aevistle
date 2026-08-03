/**
 * Browser fallback — used by `npm run dev` and by anyone who opens the built
 * `dist/` in a plain browser.
 *
 * It is a real, usable sandbox: state persists to localStorage, scheduling
 * maths runs for real, and the UI behaves exactly as it does on desktop. The
 * one thing it cannot do is open a TCP socket, so sends are simulated and
 * clearly reported as such rather than silently pretending to succeed.
 */

import type {
  AppInfo,
  DataFolder,
  DataFolderChange,
  JobEvent,
  PlatformBridge,
} from './bridge'
import type { AppState, Attachment, MailAccount, MessageDraft, SendResult } from './types'
import { newId } from './types'
import { fetchLatest } from './update'

const STATE_KEY = 'aevistle.state.v1'
const SECRET_KEY = 'aevistle.secrets.demo'

function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SECRET_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function writeSecrets(map: Record<string, string>): void {
  localStorage.setItem(SECRET_KEY, JSON.stringify(map))
}

export function createWebBridge(): PlatformBridge {
  const listeners = new Set<(e: JobEvent) => void>()

  return {
    platform: 'web',

    async loadState() {
      const raw = localStorage.getItem(STATE_KEY)
      if (!raw) return null
      try {
        return JSON.parse(raw) as Partial<AppState>
      } catch {
        localStorage.removeItem(STATE_KEY)
        return null
      }
    },

    async saveState(state: AppState) {
      localStorage.setItem(STATE_KEY, JSON.stringify(state))
    },

    async setSecret(accountId, secret) {
      const map = readSecrets()
      map[accountId] = secret
      writeSecrets(map)
    },
    async hasSecret(accountId) {
      return Boolean(readSecrets()[accountId])
    },
    async deleteSecret(accountId) {
      const map = readSecrets()
      delete map[accountId]
      writeSecrets(map)
    },

    async sendNow(draft: MessageDraft, _account: MailAccount): Promise<SendResult> {
      const started = Date.now()
      await new Promise((r) => setTimeout(r, 450))
      const recipients = [...draft.to, ...draft.cc, ...draft.bcc]
      return {
        ok: false,
        accepted: [],
        rejected: recipients,
        durationMs: Date.now() - started,
        error: 'Browser preview cannot open an SMTP connection. Install the desktop or Android build to send for real.',
        errorKind: 'config',
      }
    },

    async testConnection(): Promise<SendResult> {
      return {
        ok: false,
        accepted: [],
        rejected: [],
        durationMs: 0,
        error: 'Browser preview cannot open an SMTP connection.',
        errorKind: 'config',
      }
    },

    async pickFiles(): Promise<Attachment[]> {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = () => {
          const files = Array.from(input.files ?? [])
          resolve(
            files.map((f) => ({
              id: newId('att'),
              name: f.name,
              size: f.size,
              mime: f.type || 'application/octet-stream',
              source: 'path' as const,
              path: f.name,
              addedAt: Date.now(),
              inline: false,
            })),
          )
        }
        input.oncancel = () => resolve([])
        input.click()
      })
    },

    async snapshotAttachments(attachments) {
      return attachments
    },

    async revealPath() {},

    async syncJobs() {},

    onJobEvent(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },

    async notify(title, body) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },

    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },

    // The browser decides where localStorage lives; there is nothing to choose.
    async dataFolder(): Promise<DataFolder> {
      return {
        path: 'browser localStorage',
        isDefault: true,
        sizeBytes: (localStorage.getItem(STATE_KEY) ?? '').length,
        canPickAny: false,
        options: [],
        staysBehind: [],
      }
    },

    async chooseDataFolder(): Promise<DataFolderChange> {
      throw new Error('The browser preview cannot store data outside the browser.')
    },

    async useDataFolder(): Promise<DataFolderChange> {
      throw new Error('The browser preview cannot store data outside the browser.')
    },

    async openDataFolder() {},

    // The check is a plain fetch, so it works in the preview too — and it is
    // the one place the preview can tell someone where to get a real build.
    checkForUpdate: () => fetchLatest(__APP_VERSION__, 'web'),

    async appInfo(): Promise<AppInfo> {
      return {
        version: __APP_VERSION__,
        platform: 'web',
        os: navigator.userAgent,
        dataLocation: 'browser localStorage',
      }
    },
  }
}
