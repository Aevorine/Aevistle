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
import { fetchLatest, type DownloadProgress } from './update'
import { feedFetchVia, type FeedResponse } from './feeds'
import {
  ANDROID_REDIRECT_URI,
  androidClientIds,
  oauthProviderFor,
  oauthState,
  type OAuthAccountStatus,
  type OAuthConsentResult,
} from './oauth'
import { LocalPairingHost } from './pairingHostLocal'
import type { PairingEvent, PairMode } from './pairing'
import type { PairingEnvelope } from './pairingCrypto'
import type {
  SealedAccountSecrets,
  SyncListenerStatus,
  SyncServerRequest,
  SyncServerResponse,
} from './syncLoop'
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

/**
 * Camera access for `components/PairingScanner.tsx` is deliberately absent
 * from `AndroidPermissionApi` below — it does not need a plugin method to go
 * with it the way notifications and exact alarms do.
 *
 * `getUserMedia()` is a Web API the WebView already implements; the scanner
 * calls it directly, the same call a `<video>`-based page anywhere would
 * make. What is missing without this file's involvement is only the runtime
 * *permission* dialog, and Capacitor's own `BridgeActivity` (see
 * `MainActivity.java`) already supplies that: its `WebChromeClient`
 * implements `onPermissionRequest` and raises the standard Android camera
 * dialog for `android.permission.CAMERA`, the same class of dialog
 * `requestNotificationPermission` below raises by hand — just already wired
 * up by the framework for anything a page asks a `<video>` element for.
 * `AndroidManifest.xml` declaring the permission (with `uses-feature
 * android:required="false"`, so a camera-less device can still install the
 * app) is the only piece this repo owns.
 */
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
  /** `kind` is fixed to `'sync'` on the native side — see `AevistleNativePlugin.java`'s doc. */
  getSyncSecret(opts: { accountId: string }): Promise<{ value: string | null }>
  /**
   * Seal this device's mailbox passwords for a paired device. The WebView
   * never sees one — see `core/secretTransport.ts` and the Java method's doc.
   *
   * `envelope: null` when the keystore holds nothing for any of the named
   * accounts, which is why the whole result is not simply nullable: Capacitor
   * resolves an object, and a plugin that resolved nothing at all would be
   * indistinguishable from one that is not implemented on this build.
   */
  sealAccountSecrets(opts: {
    keyRef: string
    accountIds: string[]
  }): Promise<{ envelope: PairingEnvelope | null; accountIds?: string[] }>
  /** The receiving end: open one and write it to the keystore, answering with ids only. Rejects if it will not open. */
  openAccountSecrets(opts: {
    keyRef: string
    envelope: PairingEnvelope
  }): Promise<{ accountIds: string[] }>

  // --- OAuth2 sign-in ------------------------------------------------------
  //
  // The whole flow is native, and that is a security decision rather than a
  // convenience. The naive split — build the URL here, let native open a
  // browser, take the redirect back on a listener, exchange the code here —
  // fails twice over: `connect-src 'self'` forbids the WebView from POSTing to
  // a token endpoint at all, and routing around that would put the *refresh
  // token* through JavaScript, which is exactly the thing `sealAccountSecrets`
  // exists to avoid for passwords. So native owns the PKCE pair, the Custom
  // Tab, the redirect, the exchange and the keystore write, and what comes back
  // across the bridge is an address and a boolean.
  //
  // The provider table is still this side's, passed in on every call. Keeping
  // endpoints, scopes and authorities in `core/oauth.ts` alone means the phone
  // and the desktop cannot drift into asking for different scopes — the failure
  // that would produce is a mailbox that syncs on one device and 401s on the
  // other, with nothing on screen to connect the two.
  /**
   * Open the consent page and finish the exchange. Resolves when the user is
   * done; `cancelled` when they backed out. See `AevistleNativePlugin.java`.
   */
  oauthConsent(opts: {
    accountId: string
    providerId: string
    /**
     * Every registered Android client id for this vendor, keyed by the SHA-1 of
     * the certificate it was registered against. Native picks the one matching
     * its own signature — see `OAUTH_ANDROID_CLIENT_IDS` for why the choice
     * cannot be made on this side.
     */
    clientIds: Record<string, string>
    authorizeUrl: string
    tokenUrl: string
    /** Space-separated, already joined, so native does not re-implement the list. */
    scope: string
    redirectUri: string
    /** Vendor-specific authorize parameters (Google's `access_type`, `prompt`). */
    extraAuthParams?: Record<string, string>
    loginHint?: string
  }): Promise<{ ok: boolean; address?: string; error?: string; cancelled?: boolean }>
  /** Whether the keystore holds a grant, and whether the provider has since refused it. */
  oauthStatus(opts: {
    accountId: string
  }): Promise<{ hasGrant: boolean; rejected: boolean; address?: string }>
  oauthDisconnect(opts: { accountId: string }): Promise<void>

  sendNow(opts: { draft: MessageDraft; account: MailAccount }): Promise<SendResult>
  testConnection(opts: { account: MailAccount; secret?: string }): Promise<SendResult>

  pickFiles(): Promise<{ files: Attachment[] }>
  snapshotAttachments(opts: {
    attachments: Attachment[]
    jobId: string
  }): Promise<{ files: Attachment[] }>

  syncJobs(opts: { jobs: ScheduledJob[]; accounts: MailAccount[] }): Promise<void>
  pullJobRuns(): Promise<{ runs: Array<JobRun & { jobId: string }> }>
  notify(opts: {
    title: string
    body: string
    code?: boolean
    /** The bare code, for the notification's Copy action to put on the clipboard. */
    value?: string
    /** That action's label, translated here — the native side has no i18n. */
    copyLabel?: string
    /** The inbox message to open when the notification is tapped. */
    messageId?: string
  }): Promise<void>
  /**
   * The message a tapped notification asked for, if one is waiting.
   *
   * Polled rather than pushed. The tap is routinely what starts the app —
   * fifteen minutes after a background sync, with no WebView in the process to
   * fire an event at — so `MainActivity` parks the id and this collects it.
   */
  takePendingOpen(): Promise<{ messageId?: string }>
  /**
   * `ClipboardManager.setPrimaryClip`, because the web API cannot do this here.
   *
   * `navigator.clipboard.writeText` rejects inside an Android WebView — the
   * permission layer in front of it has no delegate to ask — so every copy
   * button in the app reported failure on this platform while working
   * everywhere else. See `core/clipboard.ts` for the full account.
   */
  clipboardWrite(opts: { text: string }): Promise<void>
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
  fetchFeed(opts: { url: string }): Promise<FeedResponse>
  /**
   * Relay one POST to a LAN endpoint — the WebView is as CSP-blocked from a
   * direct `fetch()` to a LAN address as it is from `fetchFeed`'s public
   * hosts. Mirrors `fetchFeed`'s shape (raw status + body text, parsed on the
   * JS side) rather than returning JSON directly, so a malformed reply from
   * the other device surfaces as a normal parse error instead of a
   * native-side one. Generic by design: both `pairingJoinRequest` (one POST
   * to `/pair`) and `syncRequest` (`core/syncLoop.ts`'s repeated POSTs to
   * `/sync`) are "relay this JSON body to this LAN URL", so one native method
   * serves both rather than two that would differ only in the path.
   */
  pairingRequest(opts: { url: string; body: string }): Promise<{ status: number; body: string }>
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
  /** See `saveTextFile` in the Java plugin — SAF create-document, bytes from the call. */
  saveTextFile(opts: {
    name: string
    mime: string
    text: string
  }): Promise<{ ok: boolean; cancelled: boolean; name: string }>
  saveAttachmentsTo(opts: { paths: string[] }): Promise<{ folder?: string; saved?: number }>

  /** See `UpdateInstaller.java`. Resolves with the finished `DownloadProgress`; progress arrives on the `updateProgress` listener meanwhile. */
  downloadUpdate(opts: {
    url: string
    name: string
    sizeBytes: number
  }): Promise<DownloadProgress>
  /** Rejects with the message `unknown-sources` when the per-app install toggle is off — the native side has already opened that settings screen. */
  installUpdate(opts: { path: string }): Promise<void>

  // --- LAN listeners ------------------------------------------------------
  // The accepting side of pairing and of ongoing sync. See `LanServer.java`:
  // the native side owns the socket and nothing else, and hands every request
  // body straight back here, because the keys and the state it has to be
  // judged against live on this side.

  /** Every address this device might be reachable at, best first — see `LanAddresses.java`. */
  lanAddresses(): Promise<{ addresses: string[] }>
  /**
   * Bind a one-shot `/pair` listener and report where it landed.
   *
   * Deliberately *not* "start a pairing": the payload is built here afterwards
   * (see `startPairingHost` below), because a `PairingPayload` has to carry the
   * port the OS assigned, which is only knowable after the bind. Rejects with
   * the message `no-network` when this device holds no LAN address.
   */
  startPairingHost(opts: { host?: string }): Promise<{ host: string; port: number }>
  stopPairingHost(): Promise<void>
  /** Same contract as `SyncServer.apply` on the desktop, same status shape back. */
  applySyncListener(opts: { enabled: boolean }): Promise<SyncListenerStatus>
  /** Answer a `lanRequest`. `body` is already-serialised JSON — the socket writes it verbatim. */
  respondToLanRequest(opts: { id: string; status: number; body: string }): Promise<void>

  addListener(
    eventName: 'jobEvent',
    handler: (event: JobEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    eventName: 'updateProgress',
    handler: (progress: DownloadProgress) => void,
  ): Promise<{ remove: () => Promise<void> }>
  /**
   * A request arrived on one of the two LAN listeners and a socket is waiting
   * on the answer. `kind` says which listener; `body` is unparsed text.
   */
  addListener(
    eventName: 'lanRequest',
    handler: (request: { id: string; kind: 'pair' | 'sync'; body: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const Native = registerPlugin<AevistleNativePlugin>('AevistleNative')

// ---------------------------------------------------------------------------
// The two LAN listeners, on this side of the bridge
//
// Module scope rather than inside `createAndroidBridge`, and the subscription
// is made on import rather than on first use. A `lanRequest` arrives because
// another device dialled this one; there is no call of ours to hang the
// registration off, and a request that lands before anyone subscribed is a
// socket that sits for twelve seconds and then answers 503 — which reads on the
// far side as "that device is not ready" for what is really a wiring race.
// `getBridge` caches, so this module is evaluated once.
// ---------------------------------------------------------------------------

/**
 * The HOST session. Native closes the socket when told to; this owns
 * everything else — see `core/pairingHostLocal.ts`.
 */
const pairingHost = new LocalPairingHost(() => Native.stopPairingHost())

/** Set by `onSyncServerRequest`; null while nothing is listening for one. */
let syncServerHandler: ((request: SyncServerRequest) => void) | null = null

/**
 * Turn one native `lanRequest` into the right answer.
 *
 * The `/sync` half deliberately mirrors `electron/syncServer.ts`'s `handle`
 * rather than shortcutting: the same shape check, the same 400, and the same
 * decision to pass a `pairId` this layer cannot verify through to the reducer
 * that can. What is *not* mirrored is the desktop's `hasDevice` pre-check —
 * that exists there to avoid waking the renderer for a stranger's request, and
 * here there is no renderer to wake and no cheaper place to ask.
 */
async function routeLanRequest(request: {
  id: string
  kind: 'pair' | 'sync'
  body: string
}): Promise<void> {
  const answer = (status: number, body: unknown) =>
    Native.respondToLanRequest({ id: request.id, status, body: JSON.stringify(body) })

  if (request.kind === 'pair') {
    // Never throws — see `LocalPairingHost.handle`, which is why there is no
    // catch here to turn into a socket that hangs.
    const reply = await pairingHost.handle(request.body)
    await answer(reply.status, reply.body)
    return
  }

  const handler = syncServerHandler
  if (!handler) {
    await answer(503, { ok: false, error: 'Aevistle is not ready to answer right now' })
    return
  }

  let parsed: { pairId?: unknown; envelope?: { iv?: unknown; ciphertext?: unknown } }
  try {
    parsed = JSON.parse(request.body || '{}')
  } catch {
    await answer(400, { ok: false, error: 'malformed sync request' })
    return
  }

  const pairId = typeof parsed.pairId === 'string' ? parsed.pairId : ''
  const envelope = parsed.envelope
  if (
    !pairId ||
    !envelope ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    await answer(400, { ok: false, error: 'malformed sync request' })
    return
  }

  // The native id is carried through as the `SyncServerRequest.id`, so
  // `respondToSyncServer` can answer the socket without a second map to keep in
  // step with this one.
  handler({
    id: request.id,
    pairId,
    envelope: { iv: envelope.iv, ciphertext: envelope.ciphertext },
  })
}

void Native.addListener('lanRequest', (request) => void routeLanRequest(request))

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
    getSyncSecret: (deviceId) => Native.getSyncSecret({ accountId: deviceId }).then((r) => r.value),

    async oauthConsent(accountId, providerId, loginHint): Promise<OAuthConsentResult> {
      const provider = oauthProviderFor(providerId)
      if (!provider) return { ok: false, error: 'This provider does not offer OAuth2 sign-in.' }
      const clientIds = androidClientIds(provider.vendor)
      if (Object.keys(clientIds).length === 0) {
        return {
          ok: false,
          error:
            'This build of Aevistle has no OAuth client id for Android, so it cannot start a ' +
            'sign-in. See OAUTH_ANDROID_CLIENT_IDS in src/core/oauth.ts.',
        }
      }
      try {
        const result = await Native.oauthConsent({
          accountId,
          providerId,
          clientIds,
          authorizeUrl: provider.authorizeUrl,
          tokenUrl: provider.tokenUrl,
          scope: provider.scopes.join(' '),
          redirectUri: ANDROID_REDIRECT_URI,
          ...(provider.extraAuthParams ? { extraAuthParams: provider.extraAuthParams } : {}),
          ...(loginHint ? { loginHint } : {}),
        })
        return result
      } catch (e) {
        // A plugin method the installed APK does not implement rejects here.
        // Reported as an ordinary failure rather than thrown, so the dialog says
        // "sign-in is not available on this build" instead of raising a crash
        // banner over an app that is otherwise working.
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    async oauthStatus(accountId, providerId): Promise<OAuthAccountStatus> {
      try {
        const { hasGrant, rejected, address } = await Native.oauthStatus({ accountId })
        return {
          state: oauthState(providerId || undefined, hasGrant, rejected, 'android'),
          ...(address ? { address } : {}),
        }
      } catch {
        // Same reasoning as above: an older APK simply has no grant to report.
        return { state: oauthState(providerId || undefined, false, false, 'android') }
      }
    },

    oauthDisconnect: (accountId) => Native.oauthDisconnect({ accountId }),

    async sealAccountSecrets(keyRef, accountIds): Promise<SealedAccountSecrets | null> {
      const result = await Native.sealAccountSecrets({ keyRef, accountIds })
      if (!result.envelope) return null
      return { envelope: result.envelope, accountIds: result.accountIds ?? [] }
    },
    openAccountSecrets: (keyRef, envelope) =>
      Native.openAccountSecrets({ keyRef, envelope }).then((r) => r.accountIds),

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

    async saveTextFile(name, mime, text) {
      const result = await Native.saveTextFile({ name, mime, text })
      // Widened to the shared `DownloadOutcome` here rather than in Java, so the
      // one place that decides what a save "means" stays on this side of the
      // bridge with the desktop's version of the same answer.
      return { ok: result.ok, cancelled: result.cancelled, name: result.name }
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
    /**
     * Shaped like `testConnection` above, and for the same reason.
     *
     * The Java side answers a failed *connection* with a `SendResult`, but it
     * `call.reject`s anything that goes wrong before one is attempted — a config
     * that will not parse, a keystore that will not open. A rejection is not a
     * `SendResult`, so it arrived here as a bare exception where its sibling
     * arrived as a report the dialog knows how to draw. `failedResult` is the
     * one place that difference is flattened.
     */
    async testInbox(config, secret) {
      const started = Date.now()
      try {
        return await Native.testInbox({ config, secret })
      } catch (e) {
        return failedResult(e, started)
      }
    },
    getMessageBody: (config, folderPath, uid) => Native.getMessageBody({ config, folderPath, uid }),
    setMessageFlags: (config, folderPath, uid, patch) =>
      Native.setMessageFlags({ config, folderPath, uid, patch }),
    deleteInboxMessages: (accountId, items) => Native.deleteInboxMessages({ accountId, items }),
    purgeInboxMessages: (config, items) => Native.purgeInboxMessages({ config, items }),
    fetchRemoteImage: (url) => Native.fetchRemoteImage({ url }).then((r) => r.value),
    fetchFeed: (url) => Native.fetchFeed({ url }),

    // JOINER: one POST to the address the QR code carried.
    async pairingJoinRequest(url, body) {
      const result = await Native.pairingRequest({ url, body: JSON.stringify(body) })
      try {
        return JSON.parse(result.body)
      } catch {
        throw new Error('The other device sent back something unexpected.')
      }
    },
    // `SyncLoop`'s initiating side. The same relay `pairingJoinRequest` uses,
    // pointed at `/sync` instead.
    async syncRequest(url, body) {
      const result = await Native.pairingRequest({ url, body: JSON.stringify(body) })
      try {
        return JSON.parse(result.body)
      } catch {
        throw new Error('The other device sent back something unexpected.')
      }
    },

    // --- HOST, and the accepting side of sync -------------------------------
    //
    // Both used to be absent here, on the reasoning that the WebView cannot
    // hold a LAN socket open. That is still true, and it turned out to be the
    // wrong conclusion: the socket is the only part that needed to be native.
    // `LanServer.java` holds it and decides nothing; the handshake runs in
    // `core/pairingHostLocal.ts` on the same WebCrypto the JOINER role already
    // used, and the sync answer runs in `state/AppState.tsx` on the same
    // reducer the desktop answers with.
    //
    // What that buys is every pairing direction rather than one: a phone can
    // show a code for a laptop, for a tablet, or for another phone, and none of
    // the six combinations needs a desktop in the room any more.

    lanAddresses: () => Native.lanAddresses().then((r) => r.addresses),

    async startPairingHost(mode: PairMode, pairId?: string, host?: string) {
      // Bind first, arm second: the payload has to carry the port the OS
      // assigned, so there is nothing to sign until the socket exists.
      const bound = await Native.startPairingHost({ host }).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        throw new Error(
          message === 'no-network'
            ? // Deliberately the same sentence `electron/pairingServer.ts`
              // throws, so the two platforms fail in one voice.
              'No network is available to pair over — connect to Wi-Fi or a LAN first.'
            : message,
        )
      })
      return pairingHost.start(bound.host, bound.port, mode, pairId)
    },

    stopPairingHost: () => pairingHost.stop(),

    onPairingEvent(handler: (event: PairingEvent) => void) {
      return pairingHost.onEvent(handler)
    },

    applySyncListener: (enabled: boolean) => Native.applySyncListener({ enabled }),

    onSyncServerRequest(handler: (request: SyncServerRequest) => void) {
      syncServerHandler = handler
      return () => {
        if (syncServerHandler === handler) syncServerHandler = null
      }
    },

    async respondToSyncServer(response: SyncServerResponse) {
      // The id *is* the native request id — see `routeLanRequest`. The body is
      // the whole response object, matching what `electron/syncServer.ts`
      // sends, so `SyncLoop`'s initiating side reads one shape either way.
      await Native.respondToLanRequest({
        id: response.id,
        status: response.ok ? 200 : 400,
        body: JSON.stringify(response),
      })
    },
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
     * The check goes through the plugin, because the WebView cannot make it.
     *
     * It was written as a direct `fetch` on the assumption that the WebView
     * could reach api.github.com. It cannot: the bundle is served from
     * `https://localhost` and `index.html` ships `connect-src 'self'`, so the
     * request was refused by the document's own policy and this feature has
     * never worked in a shipped Android build. The desktop copy of the same
     * shared function appeared fine only because it runs in the main process,
     * where no CSP applies.
     *
     * The download and the install now happen here too — see `downloadUpdate`
     * below. They used to be desktop-only, which left this method able to
     * announce a new version and unable to do anything about it.
     */
    async checkForUpdate() {
      const info = await Native.appInfo().catch(() => null)
      return fetchLatest(
        info?.version ?? __APP_VERSION__,
        'android',
        undefined,
        undefined,
        feedFetchVia((url) => Native.fetchFeed({ url })),
      )
    },

    /**
     * Fetch the APK into app-private storage, verified against the release's
     * published checksum. `UpdateInstaller.java` holds the reasoning; the
     * shape of what comes back is `DownloadProgress`, identical to the
     * desktop's, so `SettingsView` needs no platform branch to draw it.
     */
    downloadUpdate: (asset) =>
      Native.downloadUpdate({ url: asset.url, name: asset.name, sizeBytes: asset.sizeBytes }),

    /**
     * Hand the finished APK to the system package installer.
     *
     * The one rejection worth translating is `unknown-sources`: Android 8+
     * gates this behind a per-app settings toggle that has no request dialog,
     * so the native side opens that settings screen before rejecting, and this
     * turns the marker into something the user-facing catch can explain. Every
     * other failure already arrives as a sentence.
     */
    async installUpdate(filePath) {
      try {
        await Native.installUpdate({ path: filePath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('unknown-sources')) {
          throw new Error('ANDROID_UNKNOWN_SOURCES')
        }
        throw error
      }
    },

    onUpdateProgress(handler) {
      const pending = Native.addListener('updateProgress', handler)
      return () => {
        void pending.then((h) => h.remove())
      }
    },

    notify: (title, body, opts) =>
      Native.notify({
        title,
        body,
        code: opts?.code,
        value: opts?.value,
        copyLabel: opts?.copyLabel,
        messageId: opts?.messageId,
      }),

    /**
     * One shot, at subscribe time, and then nothing.
     *
     * Android has no live channel for this — see `takePendingOpen`. The handler
     * is called at most once, with whatever the tapped notification left
     * behind; the returned unsubscribe exists to satisfy the shared signature
     * and cancels a reply still in flight rather than detaching a listener
     * there is none of.
     */
    onOpenMessage(handler) {
      let cancelled = false
      void Native.takePendingOpen()
        .then(({ messageId }) => {
          if (!cancelled && messageId) handler(messageId)
        })
        .catch(() => {
          /* An older APK with no such method. Nothing was waiting either way. */
        })
      return () => {
        cancelled = true
      }
    },

    copyText: (text) => Native.clipboardWrite({ text }),

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
