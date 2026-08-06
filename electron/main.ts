/**
 * Electron main process.
 *
 * Security posture, in one place so it can be audited at a glance:
 *   - contextIsolation on, nodeIntegration off, sandbox on
 *   - the renderer is loaded from disk; no remote content ever
 *   - every `window.open` and in-page navigation to an external origin is
 *     refused and handed to the OS browser instead
 *   - `openExternal` only accepts http/https, so a crafted settings import
 *     cannot make the app run `file://` or a custom protocol handler
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  powerMonitor,
  shell,
  Tray,
} from 'electron'
import path from 'node:path'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { IPC, type DesktopPrefs, type TrayCommand } from '../src/core/ipc-contract'
import type {
  Attachment,
  InboxAccountState,
  InboxTag,
  LocaleId,
  MailAccount,
  MessageDraft,
  ScheduledJob,
  SecretKind,
  SendResult,
} from '../src/core/types'
import type { DataFolder, DataFolderChange } from '../src/core/bridge'
// The translation tables, not the i18n module: that one pulls in React for the
// context helper, and the main process has no business bundling React.
import { en } from '../src/i18n/en'
import { zhCN } from '../src/i18n/zh-CN'
import { fr } from '../src/i18n/fr'
import { es } from '../src/i18n/es'
import { ru } from '../src/i18n/ru'
import { ar } from '../src/i18n/ar'
import { fetchLatest, type UpdateAsset, type UpdateInfo } from '../src/core/update'
import {
  closeAllConnections,
  invalidateConnection,
  prewarm,
  sendMail,
  testConnection,
} from './mailer'
import { downloadUpdate } from './updater'
import { isInside } from './fsUtil'
import { Scheduler } from './scheduler'
import { ControlServer } from './controlServer'
import {
  CONTROL_DIR,
  ENDPOINT_FILE,
  type ControlEndpoint,
  type ControlResponse,
} from '../src/core/control'
import { listLanIPv4, PairingServer } from './pairingServer'
import type { PairingPayload, PairMode } from '../src/core/pairing'
import { SyncServer } from './syncServer'
import type { SyncListenerStatus, SyncServerResponse } from '../src/core/syncLoop'
import {
  dataFolderSize,
  dataLocation,
  defaultDataRoot,
  deleteSecret,
  getSecret,
  hasSecret,
  initDataRoot,
  isDefaultLocation,
  loadState,
  pruneSnapshots,
  recoveredFrom,
  saveState,
  setDataRoot,
  setSecret,
  withDataDir,
  snapshotDir,
  pastedDir,
} from './store'
import { fetchMessageBody, purgeMessages, setServerSeenFlag, syncInbox, testInbox } from './imap'
import { stopAllInboxWatchers, watchInboxes } from './imapIdle'
import { deleteAccountInboxCache, deleteMessageCache, pruneInboxCache } from './inboxStore'
import { clearImageCache, downloadRemoteImage } from './remoteImage'
import { sanitizeMessageHtml } from './sanitizeHtml'
import { fetchFeed } from './feedFetch'
import { buildIcs, calendarToEvents } from '../src/core/ics'
import { DEFAULT_WORK_CALENDAR, type WorkCalendar } from '../src/core/workCalendar'

// Bundled to CommonJS by scripts/build-electron.mjs, so __dirname is real.
const DIRNAME = __dirname
const DEV_SERVER = process.env.VITE_DEV_SERVER_URL

const TABLES = { en, 'zh-CN': zhCN, fr, es, ru, ar } as const
const SUPPORTED_LOCALES = Object.keys(TABLES) as LocaleId[]

/** Look up a tray label, falling back to English rather than to a raw key. */
function tr(locale: LocaleId, key: keyof typeof en): string {
  return TABLES[locale]?.[key] ?? en[key]
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/**
 * The language the tray menu is drawn in.
 *
 * Seeded from the OS display language once the app is ready — `app.getLocale()`
 * returns an empty string before that, which would silently pin every machine
 * to English. The renderer overrides it through `IPC.setUiLocale` once it knows
 * what the user actually picked.
 */
let uiLocale: LocaleId = 'en'
/**
 * Mirrors the two settings-screen switches whose effect is out here.
 *
 * The defaults match `DEFAULT_SETTINGS` so behaviour before the renderer has
 * booted is the behaviour the settings screen will claim. The renderer pushes
 * the real values through `IPC.setDesktopPrefs`.
 */
let desktopPrefs: DesktopPrefs = { minimiseToTray: true, launchAtLogin: false }
/**
 * Started by the OS at login, so the first window should stay out of the way.
 * Consumed once — see `ready-to-show`.
 */
let launchedHidden = process.argv.includes('--hidden')
let quitting = false
let dataFolderFellBack = false
const scheduler = new Scheduler()

// ---------------------------------------------------------------------------
// Control interface
//
// The server accepts requests; the renderer answers them. This map is the join
// between the two, and the timeout is what stops a hung window turning into a
// hung HTTP client — 30s is far longer than any of these operations, so firing
// it means something is actually wrong.
// ---------------------------------------------------------------------------

let controlSettings = { enabled: false, allowSending: false, calendarSubscribeEnabled: false }
const pendingControl = new Map<string, (response: ControlResponse) => void>()

/**
 * The working calendar as an `.ics` file, for `GET /calendar.ics`.
 *
 * Read straight off `state.json` via `loadState` rather than round-tripped
 * through the renderer the way `/control` is: that round trip exists because
 * `/control` can *change* state, and every write has to go through the one
 * reducer that owns it. This route only ever reads, and `loadState` already
 * reads exactly what the renderer last saved — the same 350ms-debounced file
 * `saveState` writes to. No i18n reaches the main process, so the two labels
 * below are plain English rather than `t('workcal.dayOff')` and
 * `t('workcal.makeupDays')` — a small, stated gap next to a live subscribe
 * feed beats blocking it on wiring a translation table into this process.
 */
async function buildCalendarIcsText(): Promise<string | null> {
  const state = await loadState<{ settings?: { workCalendar?: WorkCalendar } }>().catch(() => null)
  const calendar = state?.settings?.workCalendar ?? DEFAULT_WORK_CALENDAR
  const events = calendarToEvents(calendar, {
    holidayLabel: 'Day off',
    workdayLabel: 'Make-up working day',
  })
  return buildIcs(events, { name: 'Aevistle working calendar' })
}

const controlServer = new ControlServer({
  permissions: () => controlSettings,
  dataRoot: () => dataLocation(),
  log: (level, message, detail) => {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](`[control] ${message}`, detail ?? '')
  },
  calendarSubscribeEnabled: () => controlSettings.calendarSubscribeEnabled,
  buildCalendarIcs: () => buildCalendarIcsText(),
  execute: (request) =>
    new Promise<ControlResponse>((resolve) => {
      const window = mainWindow
      if (!window || window.webContents.isDestroyed()) {
        resolve({ id: request.id, ok: false, error: 'Aevistle window is not available' })
        return
      }
      const timer = setTimeout(() => {
        pendingControl.delete(request.id)
        resolve({ id: request.id, ok: false, error: 'timed out waiting for the app to answer' })
      }, 30_000)
      pendingControl.set(request.id, (response) => {
        clearTimeout(timer)
        pendingControl.delete(request.id)
        resolve(response)
      })
      window.webContents.send(IPC.controlRequest, request)
    }),
})

const pairingServer = new PairingServer({
  log: (level, message, detail) => {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](`[pairing] ${message}`, detail ?? '')
  },
})
pairingServer.onEvent((event) => {
  mainWindow?.webContents.send(IPC.pairingEvent, event)
})

/**
 * The accepting side of ongoing sync — see `syncServer.ts`'s module doc.
 *
 * Never started here. Like `pairingServer`, it opens a socket only once the
 * renderer asks for one (`IPC.applySyncListener`), because the renderer is
 * the side that knows whether `state.pairedDevices` holds an 'ongoing' entry
 * — and binding a LAN interface for a user who has never paired anything buys
 * a firewall prompt and nothing else.
 */
const pendingSync = new Map<string, (response: SyncServerResponse) => void>()
const syncServer = new SyncServer({
  log: (level, message, detail) => {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](`[sync] ${message}`, detail ?? '')
  },
  hasDevice: (pairId) => hasSecret(pairId, 'sync'),
  execute: (request) =>
    new Promise<SyncServerResponse | null>((resolve) => {
      const window = mainWindow
      if (!window || window.webContents.isDestroyed()) {
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        pendingSync.delete(request.id)
        resolve({ id: request.id, ok: false, error: 'timed out waiting for the app to answer' })
      }, 30_000)
      pendingSync.set(request.id, (response) => {
        clearTimeout(timer)
        pendingSync.delete(request.id)
        resolve(response)
      })
      window.webContents.send(IPC.syncServerRequest, request)
    }),
})

/**
 * Is this a URL a LAN relay is willing to touch?
 *
 * `pairingJoinRequest` and `syncRequest` both exist so the renderer's own
 * `connect-src 'self'` does not stop it reaching a LAN host (see `feeds.ts`
 * for the same problem with two public hosts). Without this check either
 * would instead be a generic SSRF proxy: anything in the renderer could ask
 * the main process to fetch an arbitrary URL on its behalf. So both the
 * scheme (`http:` — no TLS cert exists for a self-picked LAN address) and the
 * path (the one route the matching server actually serves) are pinned, and
 * the host has to be a private IPv4 address, never a public one and never a
 * hostname that could resolve to one. `expectedPath` is the one difference
 * between the two callers — `/pair` for `pairingServer.ts`'s one-shot
 * handshake, `/sync` for `syncServer.ts`'s ongoing listener.
 */
function isLanRelayUrl(raw: string, expectedPath: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' || url.pathname !== expectedPath) return false
  const octets = url.hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  const [a, b] = octets
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local — some hotspot configurations hand these out
    a === 127 // same-machine, for development
  )
}

async function pairingJoinRequest(url: string, body: unknown): Promise<unknown> {
  if (!isLanRelayUrl(url, '/pair')) {
    throw new Error('Pairing only talks to a private LAN address.')
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The other device sent back something unexpected.')
  }
}

/** The initiating half of `core/syncLoop.ts` reaching a peer — see `isLanRelayUrl`'s doc. */
async function syncRequest(url: string, body: unknown): Promise<unknown> {
  if (!isLanRelayUrl(url, '/sync')) {
    throw new Error('Sync only talks to a private LAN address.')
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The other device sent back something unexpected.')
  }
}

/**
 * Where the server ended up, for the settings screen to show. Read back from
 * the file the server wrote rather than kept in a second variable, so what the
 * user is told and what a caller will find cannot disagree.
 */
async function readEndpoint(): Promise<ControlEndpoint | null> {
  try {
    const raw = await fs.readFile(
      path.join(dataLocation(), CONTROL_DIR, ENDPOINT_FILE),
      'utf8',
    )
    return JSON.parse(raw) as ControlEndpoint
  } catch {
    return null
  }
}

/**
 * Keep a main-process error from becoming Electron's raw crash dialog.
 *
 * Without a handler here, anything that throws outside a request — a keystore
 * call, a timer callback, a rejected promise nobody awaited — reaches Electron's
 * default reporter, which shows the user a modal titled "A JavaScript error
 * occurred in the main process" containing a BoringSSL stack trace. That dialog
 * is unactionable and, worse, it is the *only* thing they see: the app is often
 * still perfectly usable underneath it.
 *
 * So: name the cause where we recognise it, keep running where it is safe to,
 * and never show a stack trace to someone who just wanted to send an email.
 */
/**
 * Errors the keystore raises when the saved passwords are not ours to read.
 *
 * Chromium keeps the key that encrypts saved passwords in its own `Local
 * State`, wrapped by the OS. When that wrapping no longer matches this machine
 * or this OS account — a restored backup, a copied profile folder, a rebuilt
 * Windows user — the unwrap fails deep in BoringSSL and surfaces as
 * `error:1e000065 ... BAD_DECRYPT`.
 */
function isKeystoreError(message: string): boolean {
  return /BAD_DECRYPT|Cipher functions|bad decrypt|keystore/i.test(message)
}

/**
 * A remote end went away. Expected, not exceptional.
 *
 * This application exists to talk to mail servers over the internet. Sockets
 * get reset by servers reclaiming idle connections, by NAT tables expiring, by
 * a laptop moving between access points, by a VPN reconnecting. Every one of
 * those is a normal Tuesday, and every one of them is handled where it happens:
 * a send retries on a fresh connection, a sync reports itself in the health
 * strip, a warm connection is dropped and reopened on demand.
 *
 * What was not handled was the case where the error belongs to *no* call —
 * a pooled connection dying while nothing was being sent. Those reached the
 * crash reporter and produced "Aevistle hit an unexpected problem — read
 * ECONNRESET" over an app in which nothing had gone wrong. The listeners in
 * `mailer.ts` and `imap.ts` stop that at the source; this is the backstop for
 * whatever socket nobody has thought of yet, because the right answer for a
 * network error is never a modal.
 */
function isNetworkError(err: unknown, message: string): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (
    typeof code === 'string' &&
    /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE)$/.test(
      code,
    )
  ) {
    return true
  }
  // Some layers stringify the code into the message and lose the property.
  return /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN)\b|socket hang up|premature close/i.test(
    message,
  )
}

function describeMainProcessError(err: unknown): { title: string; detail: string } {
  const message = err instanceof Error ? err.message : String(err)

  return {
    title: 'Aevistle hit an unexpected problem',
    detail: `${message}\n\nThe app is still running. If this keeps happening, please report it.`,
  }
}

/**
 * One modal per process, ever.
 *
 * A failing timer or a retrying connection raises the *same* error on every
 * tick. `showErrorBox` is modal and blocking, so the second one queues behind
 * the first and the user ends up dismissing a dialog that reappears until they
 * kill the app. Reporting a repeat is worth nothing anyway: the console line
 * below is still written every time.
 */
let modalShown = false

function reportMainProcessError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error('[aevistle] main process error:', err)

  /*
   * An unreadable keystore is not a crash and must never open a modal.
   *
   * It used to. The app was still perfectly usable underneath — mail could be
   * read, jobs could be edited, and every account whose password had become
   * unreadable was *already* being reported inside the app, because
   * `hasSecret` decrypts rather than checking for the presence of a blob (see
   * `store.ts`) and `health.noSecret` counts exactly those accounts. So the
   * dialog said, modally and in English regardless of the interface language,
   * something the interface behind it was already saying in place, next to the
   * account it was true of, with a button that fixed it.
   *
   * So it is logged and dropped here, and the account list is left to say it.
   */
  if (isKeystoreError(message)) return

  // Likewise a dead socket: logged, never modal. See `isNetworkError`.
  if (isNetworkError(err, message)) return

  if (modalShown) return
  modalShown = true
  const { title, detail } = describeMainProcessError(err)
  // `showErrorBox` works before the app is ready, which `dialog.showMessageBox`
  // does not — and the errors worth catching here happen at startup.
  try {
    dialog.showErrorBox(title, detail)
  } catch {
    // A failure to report a failure is not worth crashing over.
  }
}

process.on('uncaughtException', reportMainProcessError)
process.on('unhandledRejection', reportMainProcessError)

/*
 * Windows decides which taskbar button a running window belongs to by its
 * AppUserModelID, and ours has to be the same string the installer stamped on
 * the shortcut. electron-builder's NSIS template calls
 * `WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"`, and `APP_ID` is the
 * `appId` from electron-builder.yml — so this literal and `dev.aevistle.app`
 * there are one value written twice, and must be changed together.
 *
 * Without the call the process keeps the default ID Windows derives from the
 * executable path, which matches nothing. The window then gets its own taskbar
 * button instead of merging into the pinned one, "Pin to taskbar" produces a
 * second entry that launches a second copy, and toast notifications — the
 * thing a scheduler exists to produce — are attributed to an unregistered app.
 * Verified on the 0.1.17 install: the Start-menu shortcut at
 * %APPDATA%\Microsoft\Windows\Start Menu\Programs\Aevistle.lnk carries
 * System.AppUserModel.ID = "dev.aevistle.app" in its property store, and the
 * running process was claiming something else entirely.
 *
 * Called at module scope rather than inside `whenReady`, because it has to be
 * in place before the first window or Notification exists.
 */
if (process.platform === 'win32') app.setAppUserModelId('dev.aevistle.app')

// A second copy would run the schedule twice and send everything in duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  revealWindow()
})

/**
 * Bring the window to the user, whatever state it is in.
 *
 * `show()` on its own is not enough: a *minimised* window still counts as
 * shown, so `show()` does nothing and the click reads as broken. Restore
 * first, then show, then focus.
 */
function revealWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * One click on the tray icon toggles the window.
 *
 * Three starting states and only one of them means "hide": the window is in
 * front of the user and they clicked the icon to put it away. A window that is
 * merely *visible* is not the same thing — it can be minimised (which Electron
 * still reports as visible, the trap this function exists to avoid) or sitting
 * behind a browser, and in both of those cases the click means "bring it here".
 */
function toggleWindowFromTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  const inFront =
    mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()
  if (inFront) {
    mainWindow.hide()
    return
  }
  revealWindow()
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * The window's own size, remembered across launches.
 *
 * Lives in `userData` and never in the data folder, for the same reason the
 * folder pointer does: it is a property of this screen on this machine, and
 * syncing it would have a laptop and a desktop fighting over one rectangle.
 *
 * It exists because the compose screen's message box is the only thing on that
 * card with `flex-grow` — every pixel the window gains lands in it. Opening at
 * a fixed 880px and forgetting that the user maximised was capping the box at
 * about eleven lines however large their display was.
 */
type WindowState = { width: number; height: number; x?: number; y?: number; maximized?: boolean }

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window.json')
}

function readWindowState(): WindowState | null {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>
    // A saved rectangle is only usable if it is still a rectangle. Corrupt or
    // half-written JSON must degrade to the default size, never to a 0x0
    // window the user cannot find or grab.
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null
    if (parsed.width < 880 || parsed.height < 620) return null
    return {
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
      x: typeof parsed.x === 'number' ? Math.round(parsed.x) : undefined,
      y: typeof parsed.y === 'number' ? Math.round(parsed.y) : undefined,
      maximized: parsed.maximized === true,
    }
  } catch {
    return null
  }
}

/**
 * Saved on resize and on close, and deliberately not on every frame of a drag:
 * `resize` fires continuously, and `writeFileSync` per frame would stutter a
 * window someone is still dragging. The debounce means the last size wins.
 *
 * The *restored* bounds are what is stored, never the maximised ones — a
 * maximised window reports the whole screen, and restoring that as a normal
 * window on a smaller display would put the title bar off-screen.
 */
let saveWindowTimer: NodeJS.Timeout | null = null
function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
  const bounds = mainWindow.getNormalBounds()
  const state: WindowState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: mainWindow.isMaximized(),
  }
  try {
    writeFileSync(windowStatePath(), JSON.stringify(state), 'utf8')
  } catch {
    // A window size is not worth a dialog. Next launch uses the default.
  }
}

function scheduleWindowSave(): void {
  if (saveWindowTimer) clearTimeout(saveWindowTimer)
  saveWindowTimer = setTimeout(saveWindowState, 400)
}

function createWindow(): void {
  const saved = readWindowState()
  mainWindow = new BrowserWindow({
    // Sized for the serif type scale: 16 px body text needs more line length
    // than the 14 px it replaced before the layout starts feeling cramped.
    // Only the fallback: a remembered size wins, and a remembered maximised
    // state is applied below once the window exists.
    width: saved?.width ?? 1280,
    height: saved?.height ?? 880,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161b' : '#eceef1',
    autoHideMenuBar: true,
    title: 'Aevistle',
    webPreferences: {
      preload: path.join(DIRNAME, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      /*
       * Electron's built-in PDF viewer is a plugin, and without this it does
       * not exist — a PDF attachment opens into an empty frame with no error.
       * It does not re-enable NPAPI or anything like it; the only thing it
       * turns on in a modern Electron is the PDF viewer, and the frame that
       * uses it is `sandbox=""` with an opaque origin.
       */
      plugins: true,
    },
  })

  /* Maximise before the first paint, not after: `show()` on a restored window
     followed by `maximize()` is a visible jump, and the renderer would lay the
     compose form out twice at two different heights. */
  if (saved?.maximized) mainWindow.maximize()

  /*
   * Started by the OS at login means started for the schedule. Showing the
   * window would make "start with the computer" feel like an intrusion every
   * morning, and the tray icon is already there to open it.
   */
  mainWindow.once('ready-to-show', () => {
    // Only the *first* window of the session may stay hidden. `--hidden` is
    // still in `process.argv` for as long as the process lives, so re-reading
    // it would mean that every later window — the one the tray icon asks for,
    // most of all — also refused to appear.
    if (launchedHidden && tray) {
      launchedHidden = false
      return
    }
    mainWindow?.show()
  })

  mainWindow.on('resize', scheduleWindowSave)
  mainWindow.on('move', scheduleWindowSave)
  mainWindow.on('maximize', scheduleWindowSave)
  mainWindow.on('unmaximize', scheduleWindowSave)

  if (DEV_SERVER) {
    void mainWindow.loadURL(DEV_SERVER)
  } else {
    void mainWindow.loadFile(path.join(DIRNAME, '..', 'dist', 'index.html'))
  }

  // Any attempt to open a new window goes to the OS browser, never to a new
  // Electron window with our preload attached.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url)
    return { action: 'deny' }
  })

  // Saving a file the renderer produced.
  //
  // "Back up" and "move reminders to another device" both hand the user a
  // Blob through `<a download>`. Without this handler, that measurably does
  // the wrong thing in the packaged build: no dialog appears, and the file
  // lands in the Downloads folder named `<random-guid>.tmp` — the
  // `suggestedFilename` is discarded entirely. Measured on 0.1.7: a 23-byte
  // payload arrived as `3901de1a-…-884a3f6db676.tmp`, 23 bytes, correct
  // content, unrecognisable name.
  //
  // That is why both features read as broken. Nothing visibly happens; and
  // even someone who finds the file cannot restore it, because the restore
  // picker filters on `.aevistle,application/json` and a `.tmp` is not
  // offered. Export appearing to fail and import appearing to fail were the
  // same defect seen from two ends.
  //
  // `showSaveDialogSync` rather than the promise form because `setSavePath`
  // is only honoured inside this callback — returning first and resolving
  // later puts us back on the default path. It blocks the main process while
  // the dialog is open, which is acceptable for an explicitly user-initiated
  // save and is bounded by how long they take to click.
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const suggested = item.getFilename() || 'aevistle-export'
    const ext = path.extname(suggested).replace(/^\./, '')
    const saveOptions = {
      defaultPath: path.join(app.getPath('downloads'), suggested),
      ...(ext
        ? {
            filters: [
              { name: ext.toUpperCase(), extensions: [ext] },
              { name: 'All files', extensions: ['*'] },
            ],
          }
        : {}),
    }
    // Parented to the window when there is one, so the dialog is modal to it
    // rather than a stray top-level window someone can lose behind the app.
    const owner = mainWindow
    const target = owner
      ? dialog.showSaveDialogSync(owner, saveOptions)
      : dialog.showSaveDialogSync(saveOptions)

    if (!target) {
      // Cancelling is a normal outcome, not a failure, but it must not leave
      // the half-written temp file behind.
      item.cancel()
      mainWindow?.webContents.send(IPC.downloadDone, { ok: false, cancelled: true, name: suggested })
      return
    }

    item.setSavePath(target)
    item.once('done', (_e, state) => {
      // The renderer used to toast "exported" the instant the click handler
      // ran, which said "saved" even when the dialog was cancelled or the
      // disk was full. Now it waits to be told what actually happened.
      mainWindow?.webContents.send(IPC.downloadDone, {
        ok: state === 'completed',
        cancelled: false,
        name: path.basename(target),
        path: target,
        state,
      })
    })
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (new URL(url).origin !== new URL(current).origin) {
      event.preventDefault()
      void openExternalSafely(url)
    }
  })

  // Closing the window keeps the scheduler alive in the tray; quitting is
  // explicit. Without this, "send at 3am" would only work if the user left the
  // window open, which nobody does.
  mainWindow.on('close', (event) => {
    // Written straight away rather than through the debounce: on a real quit
    // the timer would never fire, and the last resize before closing is
    // exactly the size the user meant to keep.
    saveWindowState()
    if (!quitting && tray && desktopPrefs.minimiseToTray) {
      event.preventDefault()
      mainWindow?.hide()
      return
    }
    // The switch is off, so closing means closing. `window-all-closed` will
    // not do it for us — it deliberately keeps the process alive whenever a
    // tray icon exists, which is the behaviour the user just turned off.
    if (!quitting) {
      quitting = true
      app.quit()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createTray(): void {
  // The tray icon is what keeps the app alive after the window is closed, which
  // is the whole point of a scheduler — so a missing asset must not silently
  // cost the user their 07:00 send. `nativeImage` returns an empty image for a
  // path that does not exist instead of throwing, and `new Tray(<empty>)` is
  // what actually throws, so both are handled and there is a drawn fallback.
  const candidates = [
    path.join(DIRNAME, '..', 'build', 'tray.png'),
    path.join(process.resourcesPath ?? '', 'build', 'tray.png'),
  ]

  let icon = nativeImage.createEmpty()
  for (const candidate of candidates) {
    const loaded = nativeImage.createFromPath(candidate)
    if (!loaded.isEmpty()) {
      icon = loaded
      break
    }
  }
  if (icon.isEmpty()) icon = fallbackTrayIcon()

  try {
    tray = new Tray(icon)
  } catch {
    tray = null
    return
  }

  tray.setToolTip('Aevistle')
  refreshTrayMenu()

  // Windows delivers a single left click as `click`, and a double click as
  // `click` *followed by* `double-click`. Handling both with different
  // behaviour would make one double click toggle twice and flicker, so the
  // second gesture is deliberately left unbound here.
  tray.on('click', toggleWindowFromTray)
  if (process.platform === 'darwin') tray.on('double-click', revealWindow)
}

/**
 * (Re)draw the tray menu in `uiLocale`.
 *
 * Electron has no way to relabel an existing menu, so the whole template is
 * rebuilt. That is cheap and happens only when the language changes.
 */
function refreshTrayMenu(): void {
  if (!tray) return
  const label = (
    key:
      | 'tray.open'
      | 'tray.compose'
      | 'tray.quit'
      | 'tray.schedule'
      | 'tray.logs'
      | 'tray.pauseAll'
      | 'tray.resumeAll'
      | 'tray.nothingDue'
      | 'tray.nextAt',
  ) => tr(uiLocale, key)

  const send = (command: TrayCommand) => () => {
    revealWindow()
    mainWindow?.webContents.send(IPC.trayCommand, command)
  }

  /**
   * When the next reminder actually goes out.
   *
   * This is the one thing worth putting in a tray menu that is otherwise just
   * shortcuts: the window is closed, the app is a small icon, and the only
   * question anyone has is "is it still going to fire?". A menu that cannot
   * answer that is a menu with no reason to be read.
   */
  const jobs = scheduler.snapshot().filter((j) => j.enabled)
  const next = jobs
    .flatMap((j) => j.occurrences)
    .filter((t) => t > Date.now())
    .sort((a, b) => a - b)[0]
  const anyEnabled = jobs.length > 0

  const nextLabel =
    next === undefined
      ? label('tray.nothingDue')
      : `${label('tray.nextAt')} ${new Date(next).toLocaleString(uiLocale)}`

  tray.setContextMenu(
    Menu.buildFromTemplate([
      // Disabled on purpose: it is a readout, not a command. Making it
      // clickable would invite the guess that clicking sends it now.
      { label: nextLabel, enabled: false },
      { type: 'separator' },
      { label: label('tray.open'), click: revealWindow },
      { label: label('tray.compose'), click: send('compose') },
      { label: label('tray.schedule'), click: send('schedule') },
      { label: label('tray.logs'), click: send('logs') },
      { type: 'separator' },
      anyEnabled
        ? { label: label('tray.pauseAll'), click: send('pauseAll') }
        : { label: label('tray.resumeAll'), click: send('resumeAll') },
      { type: 'separator' },
      {
        label: label('tray.quit'),
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

/**
 * The closest supported locale for the OS display language.
 *
 * `app.getLocale()` is only reliable after the `ready` event, so this is called
 * lazily rather than at module scope — Electron returns `''` before then, which
 * would silently pin every machine to English.
 */
function systemLocale(): LocaleId {
  const raw = (app.isReady() ? app.getLocale() : '').toLowerCase()
  if (!raw) return 'en'
  if (raw.startsWith('zh')) return 'zh-CN'
  const base = raw.split('-')[0]
  const match = SUPPORTED_LOCALES.find((id) => id === raw || id.split('-')[0] === base)
  return match ?? 'en'
}

/**
 * A 16×16 accent-coloured square, drawn from raw pixels.
 *
 * Not pretty, but a tray entry the user can right-click is the difference
 * between "schedules keep running" and "closing the window stopped everything",
 * so there is always one even if the packaged asset went missing.
 */
function fallbackTrayIcon(): Electron.NativeImage {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4 + 0] = 0xe5 // B
    pixels[i * 4 + 1] = 0x46 // G
    pixels[i * 4 + 2] = 0x4f // R
    pixels[i * 4 + 3] = 0xff // A
  }
  return nativeImage.createFromBuffer(pixels, { width: size, height: size })
}

async function openExternalSafely(url: string): Promise<void> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await shell.openExternal(parsed.toString())
  } catch {
    /* not a URL we are willing to hand to the OS */
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.loadState, () => loadState())
  ipcMain.handle(IPC.saveState, (_e, state: unknown) => saveState(state))

  // Any change to a credential invalidates the connection it authenticated,
  // otherwise the next send would go out over a socket logged in as the old
  // user — which succeeds, silently, from the wrong account.
  ipcMain.handle(IPC.setSecret, (_e, id: string, secret: string, kind?: SecretKind) => {
    if (!kind || kind === 'smtp') invalidateConnection(id)
    return setSecret(id, secret, kind)
  })
  ipcMain.handle(IPC.hasSecret, (_e, id: string, kind?: SecretKind) => hasSecret(id, kind))
  ipcMain.handle(IPC.deleteSecret, async (_e, id: string, kind?: SecretKind) => {
    if (!kind || kind === 'smtp') invalidateConnection(id)
    await deleteSecret(id, kind)
    // The IMAP secret and the cached bodies/attachments it unlocked are
    // deleted together — a credential with no cache to read is a leak
    // waiting to be noticed, not a feature.
    if (kind === 'imap') await deleteAccountInboxCache(id).catch(() => {})
  })
  // `kind` is fixed here, not taken from the renderer — see `PlatformBridge.getSyncSecret`'s doc.
  ipcMain.handle(IPC.getSyncSecret, (_e, keyRef: string) => getSecret(keyRef, 'sync'))

  ipcMain.handle(IPC.sendNow, async (_e, draft: MessageDraft, account: MailAccount) => {
    const secret = await getSecret(account.id)
    return sendMail(draft, account, secret)
  })

  ipcMain.handle(IPC.prewarm, async (_e, account: MailAccount) => {
    const secret = await getSecret(account.id)
    return prewarm(account, secret)
  })

  ipcMain.handle(IPC.setDesktopPrefs, (_e, prefs: DesktopPrefs) => {
    // Coerced rather than trusted: `minimiseToTray` decides whether closing the
    // window quits the app, and `undefined` there would read as "quit".
    const next = {
      minimiseToTray: prefs?.minimiseToTray !== false,
      launchAtLogin: prefs?.launchAtLogin === true,
    }
    const loginChanged = next.launchAtLogin !== desktopPrefs.launchAtLogin
    desktopPrefs = next
    // Only written when it actually changes: this touches the registry on
    // Windows, and the renderer pushes prefs on every settings edit.
    //
    // `app.isPackaged` is not a nicety here. Run from a checkout, `process
    // .execPath` is `node_modules/electron/dist/electron.exe` and the app
    // directory is an argument Electron only gets because npm passed it — so
    // the login item Windows records is `electron.exe --hidden` with no app
    // path at all. At the next boot that launches Electron's built-in
    // "path-to-app" placeholder window instead of Aevistle: a stray window
    // every morning, from a dev run months earlier, that looks nothing like
    // this app and offers no way to work out what put it there.
    //
    // A development build has no business writing to the user's Run key at
    // all. `clearDevLoginItem` below cleans up after the versions that did.
    if (loginChanged && process.platform !== 'linux' && app.isPackaged) {
      try {
        app.setLoginItemSettings({
          openAtLogin: next.launchAtLogin,
          // Started by the OS means started for the schedule, not to be stared
          // at — the tray icon is the whole point of the option.
          args: next.launchAtLogin ? ['--hidden'] : [],
        })
      } catch (error) {
        console.error('[aevistle] could not update the login item:', error)
      }
    }
  })

  ipcMain.handle(IPC.setUiLocale, (_e, locale: LocaleId) => {
    // Validated rather than trusted: this value goes straight into menu labels,
    // and an unknown key would index the table to `undefined`.
    if (!SUPPORTED_LOCALES.includes(locale) || locale === uiLocale) return
    uiLocale = locale
    refreshTrayMenu()
  })

  ipcMain.handle(
    IPC.testConnection,
    async (_e, account: MailAccount, secret?: string) => {
      const pass = secret ?? (await getSecret(account.id))
      // Drop any warm connection first: the dialog may be testing settings the
      // user has edited but not saved, and reusing a pool opened with the old
      // ones would report success for a configuration that does not exist yet.
      invalidateConnection(account.id)
      return testConnection(account, pass)
    },
  )

  /**
   * Attachments from a drag-and-drop, built from the paths the renderer
   * resolved with `webUtils.getPathForFile`.
   *
   * Directories are skipped rather than half-attached: dropping a folder is a
   * plausible mistake, and silently attaching nothing while the other files in
   * the same drop succeed is the confusing half of that. Same bounded batch as
   * `checkFiles` — a drop of ten thousand files is not a drop worth honouring.
   */
  ipcMain.handle(IPC.attachPaths, async (_e, paths: string[]): Promise<Attachment[]> => {
    if (!Array.isArray(paths)) return []
    const files: Attachment[] = []
    for (const filePath of paths.slice(0, 50)) {
      if (typeof filePath !== 'string' || filePath.length === 0) continue
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue
        files.push({
          id: `att_${Date.now()}_${files.length}`,
          name: path.basename(filePath),
          size: stat.size,
          mime: guessMime(filePath),
          source: 'path',
          path: filePath,
          addedAt: Date.now(),
          inline: false,
        })
      } catch {
        /* Unreadable file in a multi-file drop must not lose the rest. */
      }
    }
    return files
  })

  ipcMain.handle(IPC.pickFiles, async (): Promise<Attachment[]> => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add attachments',
    })
    if (result.canceled) return []

    const files: Attachment[] = []
    for (const filePath of result.filePaths) {
      try {
        const stat = await fs.stat(filePath)
        files.push({
          id: `att_${Date.now()}_${files.length}`,
          name: path.basename(filePath),
          size: stat.size,
          mime: guessMime(filePath),
          source: 'path',
          path: filePath,
          addedAt: Date.now(),
          inline: false,
        })
      } catch {
        /* skip anything we cannot stat */
      }
    }
    return files
  })

  ipcMain.handle(
    IPC.snapshotAttachments,
    async (_e, attachments: Attachment[], jobId: string): Promise<Attachment[]> => {
      const dir = snapshotDir(jobId)
      await fs.mkdir(dir, { recursive: true })
      const out: Attachment[] = []
      for (const a of attachments) {
        // basename() strips any directory component, so a crafted name cannot
        // write outside the snapshot directory.
        const target = path.join(dir, `${a.id}_${path.basename(a.name)}`)
        await fs.copyFile(a.path, target)
        out.push({ ...a, source: 'copy', path: target })
      }
      return out
    },
  )

  /**
   * Does this file still exist?
   *
   * Unlike `revealPath` this is *not* confined to the data folder, and that is
   * deliberate: an attachment is normally a file somewhere in Documents, and
   * confining the check would make it answer "missing" for every real
   * attachment — a check that is always wrong is worse than no check. What
   * keeps it safe is how little it returns: one boolean per path the renderer
   * already knew about, no contents, no listing, no metadata. It cannot be
   * used to enumerate anything, only to confirm a guess the renderer made.
   */
  ipcMain.handle(IPC.checkFiles, async (_e, paths: string[]) => {
    const out: Record<string, boolean> = {}
    if (!Array.isArray(paths)) return out
    // A bounded batch: this is called from a live preview, and an unbounded
    // list would let one draft stat ten thousand paths on every keystroke.
    for (const p of paths.slice(0, 200)) {
      if (typeof p !== 'string' || p.length === 0) continue
      try {
        const stat = await fs.stat(p)
        out[p] = stat.isFile()
      } catch {
        out[p] = false
      }
    }
    return out
  })

  ipcMain.handle(IPC.revealPath, (_e, target: string) => {
    // A bare renderer-supplied string — confine it to the data folder.
    // Without this, `target` could be any path on disk (e.g. `../../..`).
    const resolved = path.resolve(target)
    const root = path.resolve(dataLocation())
    if (resolved !== root && !isInside(resolved, root)) return
    shell.showItemInFolder(resolved)
  })

  /**
   * Open a file with the OS's default handler for it — what "double-click an
   * attachment" means, and the piece the inbox never had: `revealPath` above
   * only ever highlighted the file in a folder, it did not open it. Confined
   * to the data folder for the same reason `revealPath` is; every attachment
   * this app itself wrote (received-mail attachments, pasted images) lives
   * there, so the confinement costs nothing real.
   */
  ipcMain.handle(IPC.openPath, async (_e, target: string) => {
    const resolved = path.resolve(target)
    const root = path.resolve(dataLocation())
    if (resolved !== root && !isInside(resolved, root)) return
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
  })

  /**
   * Read an attachment back for previewing it inside the window.
   *
   * Three separate limits, because this is the one method here that returns
   * file *contents* rather than a boolean or a path:
   *
   *   - confined to the data folder, exactly as `openPath` and `revealPath`
   *     are, so a crafted path cannot read `id_rsa`;
   *   - capped at `PREVIEW_MAX_BYTES`, because the result crosses IPC as a
   *     base64 string and doubles in size doing it — a 200 MB video would
   *     otherwise be turned into a 270 MB string in the renderer's heap;
   *   - restricted to types that render inertly. PDFs, images and plain text
   *     are shown in a sandboxed frame that cannot execute anything; SVG is
   *     *excluded on purpose* despite being an image, because it is a document
   *     format that can carry script.
   *
   * `null` rather than a thrown error for "not previewable": the caller's
   * fallback is to offer the OS handler instead, which is a normal outcome,
   * not a failure worth a red toast.
   */
  ipcMain.handle(IPC.readAttachment, async (_e, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return null
    const resolved = path.resolve(target)
    const root = path.resolve(dataLocation())
    if (!isInside(resolved, root)) return null
    const mime = guessMime(resolved)
    if (!PREVIEWABLE_MIME.test(mime)) return null
    try {
      const stat = await fs.stat(resolved)
      if (!stat.isFile() || stat.size > PREVIEW_MAX_BYTES) return null
      const bytes = await fs.readFile(resolved)
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, mime }
    } catch {
      return null
    }
  })

  /**
   * "Save a copy of this attachment somewhere I chose."
   *
   * The *source* is confined to the data folder like every other path handler;
   * the *destination* is not, and must not be — the whole point is to put the
   * file where the user wants it, and they picked that place in an OS dialog
   * a moment ago rather than a renderer choosing it for them.
   */
  ipcMain.handle(IPC.saveAttachmentAs, async (_e, target: string, suggestedName: string) => {
    const resolved = path.resolve(String(target ?? ''))
    const root = path.resolve(dataLocation())
    if (!isInside(resolved, root)) return null
    const result = await dialog.showSaveDialog({
      defaultPath: path.basename(String(suggestedName || '') || resolved),
    })
    if (result.canceled || !result.filePath) return null
    await fs.copyFile(resolved, result.filePath)
    return result.filePath
  })

  /** The same, for every attachment on a message at once: one folder, one dialog. */
  ipcMain.handle(IPC.saveAttachmentsTo, async (_e, targets: string[]) => {
    if (!Array.isArray(targets) || targets.length === 0) return null
    const root = path.resolve(dataLocation())
    const sources = targets
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => path.resolve(p))
      .filter((p) => isInside(p, root))
    if (sources.length === 0) return null

    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]

    let saved = 0
    for (const source of sources) {
      // Never overwrite: two mails routinely attach `invoice.pdf`, and a
      // silent overwrite here would destroy the first one with no way to tell.
      const target = await uniqueTarget(folder, path.basename(source))
      try {
        await fs.copyFile(source, target)
        saved++
      } catch {
        /* One unwritable file must not abandon the rest of the batch. */
      }
    }
    return { folder, saved }
  })

  /**
   * Save a clipboard image as an attachment, for pasting one straight into
   * the compose body. `data` arrives as an `ArrayBuffer` over IPC's
   * structured clone — no base64 round trip.
   */
  ipcMain.handle(
    IPC.attachBlob,
    async (_e, name: string, mime: string, data: ArrayBuffer): Promise<Attachment> => {
      const dir = pastedDir()
      await fs.mkdir(dir, { recursive: true })
      const id = `paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      // basename() so a crafted name cannot write outside the pasted
      // directory — the same discipline every other renderer-supplied
      // filename in this file follows.
      const safeName = path.basename(name || 'pasted-image.png')
      const target = path.join(dir, `${id}_${safeName}`)
      await fs.writeFile(target, Buffer.from(data))
      const stat = await fs.stat(target)
      return {
        id,
        name: safeName,
        size: stat.size,
        mime: mime || guessMime(target),
        source: 'copy',
        path: target,
        addedAt: Date.now(),
        inline: false,
      }
    },
  )

  ipcMain.handle(
    IPC.syncJobs,
    async (_e, jobs: ScheduledJob[], accounts: MailAccount[]) => {
      scheduler.sync(jobs, accounts)
      // The tray shows the next fire time, so it is stale the moment the
      // schedule changes. Redrawing here is what keeps "next: 09:00 tomorrow"
      // from still saying that after the reminder has been deleted.
      refreshTrayMenu()
      await pruneSnapshots(jobs.map((j) => j.id))
    },
  )

  // --- inbox (receiving) ---------------------------------------------------

  /**
   * The receive password, falling back to the send password for the same
   * account.
   *
   * Every provider this app ships a preset for issues one app password that
   * authenticates both SMTP and IMAP — Gmail, Outlook, QQ, 163, Yahoo, Zoho.
   * Making people paste the same string into a second box teaches them the
   * two are unrelated, and typo'ing it produces an authentication failure
   * that looks like the app is broken. They stay separate keys in the store,
   * so anyone who genuinely has two passwords can still set them apart.
   */
  async function getInboxSecret(accountId: string): Promise<string | null> {
    return (await getSecret(accountId, 'imap')) ?? (await getSecret(accountId, 'smtp'))
  }

  ipcMain.handle(
    IPC.testInbox,
    async (_e, config: InboxAccountState, secret?: string): Promise<SendResult> => {
      const pass = secret || (await getInboxSecret(config.accountId))
      return testInbox(config, pass)
    },
  )

  /**
   * Point the push watchers at the accounts that currently want one.
   *
   * The renderer sends configs without passwords — those never leave the main
   * process — so the secret for each is looked up here before handing the set
   * to the watcher pool, which reconciles it against what is already running.
   */
  ipcMain.handle(IPC.watchInbox, async (_e, configs: InboxAccountState[]) => {
    const withSecrets = await Promise.all(
      configs.map(async (config) => ({
        config,
        secret: await getInboxSecret(config.accountId),
      })),
    )
    watchInboxes(withSecrets, (accountId) => {
      // The watcher only ever says "something changed"; the renderer runs the
      // same sync it would have run on a timer. One fetch path, not two.
      mainWindow?.webContents.send(IPC.inboxEvent, {
        accountId,
        folderPath: 'INBOX',
        newMessageIds: [],
      })
    })
  })

  ipcMain.handle(IPC.syncInbox, async (_e, config: InboxAccountState) => {
    const secret = await getInboxSecret(config.accountId)
    const result = await syncInbox(config, secret)
    // A cache that only ever grows would eventually make "check now" slower
    // than the sync it triggers — pruning after every sync keeps it bounded
    // without a separate timer to forget about.
    const state = await loadState<{ settings?: { inboxCacheMaxMb?: number; inboxCacheRetentionDays?: number } }>()
    await pruneInboxCache(
      config.accountId,
      state?.settings?.inboxCacheMaxMb ?? 500,
      state?.settings?.inboxCacheRetentionDays ?? 90,
    ).catch(() => {})
    return result
  })

  ipcMain.handle(
    IPC.getMessageBody,
    async (_e, config: InboxAccountState, folderPath: string, uid: number) => {
      const secret = await getInboxSecret(config.accountId)
      return fetchMessageBody(config, secret, folderPath, uid)
    },
  )

  /**
   * The calendar's per-reminder body preview reuses this rather than opening
   * a render path of its own — a scheduled draft's HTML carries the same
   * injection surface as a received message, so it goes through the same
   * allowlist. See `CalendarDayPanel.tsx`.
   */
  ipcMain.handle(IPC.sanitizeHtml, async (_e, html: string) => sanitizeMessageHtml(html).html)

  ipcMain.handle(
    IPC.setMessageFlags,
    async (
      _e,
      config: InboxAccountState,
      folderPath: string,
      uid: number,
      patch: { seen?: boolean; tag?: InboxTag },
    ) => {
      // `tag` never reaches here — it is local-only by design (see `InboxTag`
      // in types.ts) and the renderer never sends it over this channel for
      // anything but `seen`.
      if (patch.seen === undefined) return
      const secret = await getInboxSecret(config.accountId)
      await setServerSeenFlag(config, secret, folderPath, uid, patch.seen)
    },
  )

  ipcMain.handle(
    IPC.deleteInboxMessages,
    async (_e, accountId: string, items: Array<{ folderPath: string; uid: number }>) => {
      await deleteMessageCache(accountId, items)
    },
  )

  /**
   * The other half of deleting: the message itself, on the server.
   *
   * Deliberately not merged into the handler above. That one is a local
   * cleanup that is fine to fail quietly; this one changes the user's mailbox
   * and must say so when it does not work.
   */
  ipcMain.handle(
    IPC.purgeInboxMessages,
    async (
      _e,
      accountId: string,
      config: InboxAccountState,
      items: Array<{ folderPath: string; uid: number }>,
    ) => {
      const secret = await getSecret(accountId, 'imap')
      await purgeMessages(config, secret, items)
      // Only after the server agreed. Dropping the cache first would leave the
      // app with no copy of a message that is still in the mailbox.
      await deleteMessageCache(accountId, items)
    },
  )

  ipcMain.handle(IPC.fetchRemoteImage, (_e, url: string) => downloadRemoteImage(url))
  ipcMain.handle(IPC.fetchFeed, (_e, url: string) => fetchFeed(url))
  ipcMain.handle(IPC.clearImageCache, () => clearImageCache())

  ipcMain.handle(IPC.notify, (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })

  ipcMain.handle(IPC.openExternal, (_e, url: string) => openExternalSafely(url))

  ipcMain.handle(
    IPC.applyControl,
    async (
      _e,
      settings: { enabled: boolean; allowSending: boolean; calendarSubscribeEnabled: boolean },
    ): Promise<ControlEndpoint | null> => {
      controlSettings = settings
      await controlServer.apply()
      return readEndpoint()
    },
  )

  ipcMain.handle(IPC.controlResponse, (_e, response: ControlResponse) => {
    pendingControl.get(response.id)?.(response)
  })

  ipcMain.handle(
    IPC.startPairingHost,
    (_e, mode: PairMode, pairId?: string, host?: string): Promise<PairingPayload> =>
      pairingServer.start(mode, pairId, host),
  )
  // Read fresh on every call rather than cached at startup: laptops join and
  // leave networks, and a VPN going up or down rewrites this list without the
  // app being told. A stale list would offer an address that is gone.
  ipcMain.handle(IPC.lanAddresses, () => listLanIPv4())
  ipcMain.handle(IPC.stopPairingHost, () => pairingServer.stop())
  ipcMain.handle(IPC.pairingJoinRequest, (_e, url: string, body: unknown) =>
    pairingJoinRequest(url, body),
  )

  ipcMain.handle(IPC.syncRequest, (_e, url: string, body: unknown) => syncRequest(url, body))
  ipcMain.handle(IPC.syncServerResponse, (_e, response: SyncServerResponse) => {
    pendingSync.get(response.id)?.(response)
  })
  ipcMain.handle(
    IPC.applySyncListener,
    (_e, enabled: boolean): Promise<SyncListenerStatus> => syncServer.apply(enabled),
  )

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    platform: 'desktop' as const,
    os: `${process.platform} ${process.arch}`,
    dataLocation: dataLocation(),
    recoveredFrom: recoveredFrom(),
    // Packaged builds get it from extraResources; a dev run reads it straight
    // out of the repo, so the Settings command is correct either way.
    mcpServerPath: app.isPackaged
      ? path.join(process.resourcesPath, 'integrations', 'mcp-server.mjs')
      : path.join(DIRNAME, '..', 'integrations', 'mcp-server.mjs'),
  }))

  // --- data folder --------------------------------------------------------

  ipcMain.handle(IPC.dataFolder, async (): Promise<DataFolder> => {
    return {
      path: dataLocation(),
      isDefault: isDefaultLocation(),
      sizeBytes: await dataFolderSize(),
      canPickAny: true,
      options: [{ id: 'default', path: defaultDataRoot(), available: true }],
      fellBack: dataFolderFellBack || undefined,
      // Passwords are encrypted against the OS user account, so they are of no
      // use in a folder on a stick anyway. Saying so beats a user moving the
      // folder to a shared drive and assuming their credentials went too.
      staysBehind: ['secrets'],
    }
  })

  ipcMain.handle(
    IPC.chooseDataFolder,
    async (_e, move: boolean): Promise<DataFolderChange> => {
      const before = dataLocation()
      const parent = mainWindow
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: dataLocation(),
            title: 'Choose where Aevistle keeps its data',
          })
        : await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: dataLocation(),
          })

      if (result.canceled || result.filePaths.length === 0) {
        return { changed: false, path: dataLocation(), moved: false }
      }

      // The dialog returns the container the user chose; the data itself
      // always lands in an AevistleData folder inside it.
      const outcome = await setDataRoot(withDataDir(result.filePaths[0]), move)
      dataFolderFellBack = false
      return {
        changed: outcome.root !== before,
        path: outcome.root,
        moved: outcome.moved,
        warning: outcome.warning,
      }
    },
  )

  ipcMain.handle(
    IPC.useDataFolder,
    async (_e, optionId: string, move: boolean): Promise<DataFolderChange> => {
      // The desktop build offers exactly one preset: back to the default.
      if (optionId !== 'default') throw new Error(`Unknown data folder option: ${optionId}`)
      const before = dataLocation()
      const outcome = await setDataRoot(defaultDataRoot(), move)
      dataFolderFellBack = false
      return {
        changed: outcome.root !== before,
        path: outcome.root,
        moved: outcome.moved,
        warning: outcome.warning,
      }
    },
  )

  ipcMain.handle(IPC.openDataFolder, async () => {
    await fs.mkdir(dataLocation(), { recursive: true }).catch(() => {})
    await shell.openPath(dataLocation())
  })

  // --- updates ------------------------------------------------------------

  ipcMain.handle(
    IPC.checkForUpdate,
    (): Promise<UpdateInfo> =>
      // electron-builder sets this only in the portable build, and it is the
      // only signal there is: both builds are the same code in the same asar.
      fetchLatest(
        app.getVersion(),
        'desktop',
        undefined,
        Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
      ),
  )

  ipcMain.handle(IPC.downloadUpdate, async (_e, asset: UpdateAsset) => {
    const target = path.join(app.getPath('downloads'), 'Aevistle')
    return downloadUpdate(asset, target, (progress) => {
      mainWindow?.webContents.send(IPC.updateProgress, progress)
    })
  })

  ipcMain.handle(IPC.installUpdate, async (_e, filePath: string) => {
    // Only ever launch something we put in our own download folder — a path
    // arriving from the renderer is otherwise a request to run arbitrary code.
    const expected = path.join(app.getPath('downloads'), 'Aevistle')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(expected) + path.sep)) {
      throw new Error('Refusing to launch a file from outside the download folder')
    }
    await fs.access(resolved)

    // Quit first: the installer replaces files this process has open, and on
    // Windows that fails with a file-in-use error the user cannot interpret.
    quitting = true
    scheduler.stop()
    setTimeout(() => {
      void shell.openPath(resolved).finally(() => app.quit())
    }, 300)
  })
}

/**
 * What `readAttachment` is willing to hand back.
 *
 * SVG is excluded even though it is an image: it is a document that can carry
 * script, and the preview frame's job is to be boring. Everything here either
 * has no scripting model at all, or is displayed by Chromium's own hardened
 * viewer (PDF).
 */
const PREVIEWABLE_MIME = /^(image\/(png|jpeg|gif|webp|bmp|avif)|application\/pdf|text\/(plain|csv))$/

/** 24 MB of file becomes ~32 MB of base64 in transit; past that, offer the OS handler instead. */
const PREVIEW_MAX_BYTES = 24 * 1024 * 1024

/** `invoice.pdf` → `invoice (2).pdf` when the first one is already there. */
async function uniqueTarget(folder: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let candidate = path.join(folder, name)
  for (let n = 2; n < 1000; n++) {
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
    candidate = path.join(folder, `${stem} (${n})${ext}`)
  }
  return candidate
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    txt: 'text/plain',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return map[ext] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Undo the login item a development run should never have written.
 *
 * Versions before this one called `setLoginItemSettings` regardless of how the
 * app was started, so anyone who turned "launch at login" on while running
 * from a checkout has a `Run` entry pointing at
 * `node_modules/electron/dist/electron.exe --hidden` — no app path, so every
 * boot opens Electron's own "path-to-app" placeholder window. Turning the
 * switch back off in a *packaged* build would not clear it: that build writes
 * a different key (`electron.app.Aevistle`, from its own product name), and the
 * dev one, `electron.app.Electron`, would sit there forever with nothing in any
 * user interface that referred to it.
 *
 * So the cleanup has to happen from the same kind of process that made the
 * mess. Restricted to unpackaged runs for exactly that reason — a packaged
 * build calling this would clear its *own*, entirely legitimate entry and
 * silently turn the feature off.
 */
function clearDevLoginItem(): void {
  if (app.isPackaged || process.platform === 'linux') return
  try {
    if (!app.getLoginItemSettings().openAtLogin) return
    app.setLoginItemSettings({ openAtLogin: false, args: [] })
    console.warn(
      '[aevistle] removed a login item left behind by a development run — ' +
        'launch-at-login only applies to an installed build.',
    )
  } catch (error) {
    console.error('[aevistle] could not clear the development login item:', error)
  }
}

void app.whenReady().then(() => {
  // Before anything reads or writes: the user may have pointed the data folder
  // somewhere else, and loading state from the default folder first would show
  // them an empty app.
  dataFolderFellBack = initDataRoot().fellBack

  clearDevLoginItem()

  // Now that `app.getLocale()` answers, the tray can be built in the OS
  // language straight away instead of flashing English until the window loads.
  uiLocale = systemLocale()

  registerIpc()
  // The tray comes first so that the window's `ready-to-show` can tell whether
  // staying hidden would strand the user with no way to open the app. Building
  // it needs nothing from the window.
  createTray()
  createWindow()

  scheduler.on('jobEvent', (payload) => {
    mainWindow?.webContents.send(IPC.jobEvent, payload)
    if (!payload.result.ok && Notification.isSupported()) {
      new Notification({
        title: 'Aevistle — scheduled send failed',
        body: payload.result.error ?? 'Unknown error',
      }).show()
    }
  })
  scheduler.start()

  // The drop folder is served whether or not the port is open: a request left
  // there while the app was closed is the case it exists for.
  void controlServer.startDropWatcher()

  // The 15-second poll would otherwise leave a due job waiting out however
  // much of the current tick is left after the machine wakes back up.
  powerMonitor.on('resume', () => scheduler.wake())
  powerMonitor.on('unlock-screen', () => scheduler.wake())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  scheduler.stop()
  void controlServer.dispose()
  void pairingServer.stop()
  void syncServer.stop()
  closeAllConnections()
  // Held-open IDLE sockets would otherwise keep the process from exiting
  // cleanly, and leave the provider counting a connection that is gone.
  stopAllInboxWatchers()
})

app.on('window-all-closed', () => {
  // With a tray icon the app deliberately keeps running so schedules fire —
  // unless the user has said they do not want that, in which case the last
  // window closing is the end of the session.
  if (!desktopPrefs.minimiseToTray) {
    app.quit()
    return
  }
  if (!tray && process.platform !== 'darwin') app.quit()
})
