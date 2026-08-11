/**
 * The one seam between platform-independent code and the operating system.
 *
 * The renderer never imports `nodemailer`, never touches `fs`, and never calls
 * a Capacitor plugin directly. It asks the bridge. That is what lets the same
 * React tree ship inside Electron and inside an Android WebView, and what lets
 * the UI run in a plain browser during development.
 */

import type { ControlAuditEntry, ControlEndpoint, ControlRequest, ControlResponse } from './control'
import type { DispatchLedgerEntry } from './dispatchLedger'
import type { FeedResponse } from './feeds'
import type { OAuthAccountStatus, OAuthConsentResult } from './oauth'
import type { PairingEvent, PairingPayload, PairMode } from './pairing'
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
  ControlScope,
  InboxAccountState,
  InboxTag,
  LocaleId,
  MailAccount,
  MessageDraft,
  Platform,
  ScheduledJob,
  SecretKind,
  SendResult,
  SharePayload,
} from './types'
import type { DownloadProgress, UpdateAsset, UpdateInfo } from './update'
import type { DesktopPrefs, DownloadOutcome, TrayCommand } from './ipc-contract'

export interface AppInfo {
  version: string
  platform: Platform
  os: string
  /** Human-readable location of the state file / preferences store. */
  dataLocation: string
  /**
   * Where each unreadable file (state, secrets) was moved to at startup, if
   * that happened.
   *
   * Present so the app can say "your data could not be read, here is where it
   * went" instead of simply opening empty. An app that comes up factory-fresh
   * with no message looks exactly like one that lost everything. An array
   * because a single crash can corrupt more than one file, and each has to be
   * named — not just whichever failed last.
   */
  recoveredFrom?: string[]
  /**
   * Absolute path of the bundled MCP server, so the Settings card can print a
   * command that works on this machine. Desktop only.
   */
  mcpServerPath?: string
}

/**
 * What a run did to the job's own bookkeeping.
 *
 * This travels with the event on purpose. The platform scheduler owns the
 * job while it runs and updates `status`/`runCount`/`lastRunAt` on its own
 * copy; the renderer owns `state.json` and everything the user looks at. Until
 * this field existed those two never spoke: the mail went out, the activity log
 * said so, and the schedule row kept displaying the status it was created with
 * — "waiting to send", forever.
 *
 * Two things depended on that silence and were also broken by it:
 * `runCount` stayed at 0, so an "after N sends" end condition never came true;
 * and `lastRunAt`/`lastResult` stayed empty, so send conditions that ask about
 * the previous run were reading values that never changed.
 */
export interface JobRun {
  runCount: number
  lastRunAt: number
  lastResult?: 'ok' | 'failed'
  lastError?: string
  status: ScheduledJob['status']
  /** What is still due after this run. Empty means the job is finished. */
  occurrences: number[]
  /**
   * Set instead of `lastResult` when a send condition said no.
   *
   * A skip is neither `'ok'` nor `'failed'`, and on Android it is the *normal*
   * case for it to happen with no UI attached — the alarm fires into a worker
   * hours after the app was last open. Without these two the drain below had
   * nothing to write, so a reminder deliberately held back left no line in the
   * activity log at all: the row's next-send time moved and nothing anywhere
   * said why the send had not happened. The live desktop event carries the same
   * two on its `SendResult`.
   */
  skipReasonKey?: string
  skipReasonValues?: Record<string, string | number>
}

export interface JobEvent {
  jobId: string
  at: number
  result: SendResult
  /**
   * Optional so an older platform layer that does not send it still delivers a
   * usable event — the log line is written either way, the row simply does not
   * move. Absent is a missing feature; present-but-wrong would be a lie.
   */
  run?: JobRun
}

/** One folder the user is allowed to keep their data in. */
export interface DataFolderOption {
  /** `default` everywhere; `external` / `sdcard` on Android; `custom` desktop. */
  id: string
  path: string
  /** Present but unusable — an SD card slot with no card in it. */
  available: boolean
  freeBytes?: number
}

export interface DataFolder {
  path: string
  isDefault: boolean
  sizeBytes: number
  /** Whether the platform can offer a "pick any folder" dialog. */
  canPickAny: boolean
  /** Fixed choices. Always contains `default`; Android adds its volumes. */
  options: DataFolderOption[]
  /** A saved location was unreachable at startup and the default is in use. */
  fellBack?: boolean
  /**
   * What deliberately does *not* move. Passwords live in the OS keystore and
   * Android's alarm store has to stay where the system can read it without the
   * app running; saying so is better than a user assuming otherwise.
   */
  staysBehind: string[]
}

export interface DataFolderChange {
  changed: boolean
  path: string
  moved: boolean
  warning?: string
}

/** A message body, already sanitized on the main-process side if it was HTML. */
export interface InboxMessageBody {
  text?: string
  sanitizedHtml?: string
  attachments: Attachment[]
  /**
   * Remote image URLs stripped out by the sanitizer, in the order their
   * placeholders appear in `sanitizedHtml` (see `src/core/remoteImagePlaceholder.ts`).
   * The renderer resolves these via `bridge.fetchRemoteImage` + `resolveRemoteImages`,
   * automatically unless the account's `showRemoteImages` policy says otherwise.
   * The fetch always happens in the main process: the sanitizer keeps the URLs out
   * of the document and the CSP keeps the iframe off the network, so a message can
   * never open a socket of its own no matter what policy is in force.
   */
  remoteImages?: string[]
  /**
   * `text/calendar` parts of the message, verbatim, when it had any.
   *
   * A meeting invitation states its time in a `DTSTART` the sending calendar
   * wrote on purpose; `core/dateExtract.ts` reads that in preference to the
   * prose next to it, which is a guess by comparison.
   *
   * **Desktop only today.** The Android inbox parses bodies natively and does
   * not lift these out yet, so a phone falls back to the prose reader — which
   * works, and says `medium`/`low` where the desktop would say `high`. Written
   * down rather than left to be discovered: an optional field that is simply
   * always absent on one platform is the shape a silently-degraded feature
   * takes.
   */
  icsParts?: string[]
}

/** New mail arrived while the app was open — the inbox analogue of `JobEvent`. */
export interface InboxEvent {
  accountId: string
  folderPath: string
  newMessageIds: string[]
}

export interface PlatformBridge {
  readonly platform: Platform

  // --- persistence --------------------------------------------------------
  loadState(): Promise<Partial<AppState> | null>
  saveState(state: AppState): Promise<void>

  // --- secrets (never stored in AppState) ---------------------------------
  /** `kind` defaults to `'smtp'` — every secret written before Phase 1 used that key. */
  setSecret(accountId: string, secret: string, kind?: SecretKind): Promise<void>
  hasSecret(accountId: string, kind?: SecretKind): Promise<boolean>
  deleteSecret(accountId: string, kind?: SecretKind): Promise<void>

  // --- OAuth2 sign-in ------------------------------------------------------
  //
  // Optional as a group, and the account dialog treats their absence as
  // "this platform cannot sign in this way" rather than as an error — the same
  // way it already hides the inbox where `syncInbox` is missing. The browser
  // preview has no trusted side to run a consent flow in, and no keystore to
  // leave the result in, so it omits all three.
  //
  // What is conspicuously missing from the group is a token reader. The
  // refresh token is written by the trusted layer and read only by the
  // transports; the most a renderer can learn is an address and a state. See
  // `core/oauth.ts` for why a public client's grant is the one credential worth
  // being strict about — it cannot be rotated by changing a password.
  /**
   * Run a consent, end to end, and leave the refresh token in the keystore.
   *
   * Takes minutes, legitimately: it resolves when the user has finished in
   * their browser. Never rejects — a cancelled sign-in comes back as
   * `{ ok: false, cancelled: true }`, because a user closing a tab is an answer
   * and not a fault.
   */
  oauthConsent?(
    accountId: string,
    providerId: string,
    loginHint: string,
  ): Promise<OAuthConsentResult>
  /**
   * Connected, never connected, or connected-but-rejected.
   *
   * The third is why this is not `hasSecret`. A refresh token the provider has
   * revoked is still a stored secret, so every existing "is there a credential"
   * check says yes right up until a scheduled send fails at an hour nobody is
   * watching. Cheap: it reads the store, it does not call the provider.
   */
  oauthStatus?(accountId: string, providerId: string): Promise<OAuthAccountStatus>
  /** Forget the stored grant. Revoking it at the provider stays the user's to do. */
  oauthDisconnect?(accountId: string): Promise<void>

  // --- mail ---------------------------------------------------------------
  sendNow(draft: MessageDraft, account: MailAccount): Promise<SendResult>
  testConnection(account: MailAccount, secret?: string): Promise<SendResult>
  /**
   * Open and authenticate before the user presses Send.
   *
   * Optional because only the desktop keeps a connection alive; Android hands
   * each send to a background worker that outlives the WebView, so there is no
   * long-lived process to hold one open in.
   */
  prewarm?(account: MailAccount): Promise<boolean>

  /**
   * Tell the platform which language the window is showing in.
   *
   * Only the desktop has UI outside the window — the tray menu — and it is
   * built before the window exists, so it starts from the OS locale and this is
   * how an explicit in-app choice catches up with it.
   */
  setUiLocale?(locale: LocaleId): Promise<void>

  /**
   * Hand the shell the two settings it, not the window, has to act on.
   *
   * Absent on Android and in the browser preview, where neither a tray nor a
   * login item exists — the settings screen hides both switches there.
   */
  setDesktopPrefs?(prefs: DesktopPrefs): Promise<void>

  /** Tray menu items that ask the window to do something. Desktop only. */
  onTrayCommand?(handler: (command: TrayCommand) => void): () => void
  /**
   * Optional: only the desktop shell can say whether a `<a download>` became a
   * real file. Where it is absent (browser preview), the browser's own
   * download UI is the feedback and callers keep their optimistic toast.
   */
  onDownloadDone?(handler: (outcome: DownloadOutcome) => void): () => void
  /**
   * Optional: write a generated file straight to a location the user picks,
   * for platforms where `<a download>` does nothing.
   *
   * Android only, and it is what lets a phone export at all. `<a download>` is
   * inert in a Capacitor WebView, so `core/download.ts` used to refuse there and
   * say so — which meant the phone could import a backup, a transfer file, a
   * pairing file and an .ics, and export none of the four. See `saveTextFile` in
   * `AevistleNativePlugin.java`.
   *
   * Returns the same `DownloadOutcome` the desktop reports after its own save
   * dialog, including `cancelled`, so callers need no platform branch.
   */
  saveTextFile?(name: string, mime: string, text: string): Promise<DownloadOutcome>

  // --- control interface (desktop only) ------------------------------------
  // Optional because only the desktop build can listen on a socket or watch a
  // folder. The Android and browser builds simply do not offer it, and the
  // settings screen hides the card rather than showing a switch that lies.
  applyControl?(settings: {
    enabled: boolean
    allowSending: boolean
    calendarSubscribeEnabled: boolean
    /** Raw, un-normalized — see `DesktopApi.applyControl`'s doc in `ipc-contract.ts`. */
    controlScopes?: ControlScope[]
  }): Promise<ControlEndpoint | null>
  onControlRequest?(handler: (request: ControlRequest) => void): () => void
  respondToControl?(response: ControlResponse): Promise<void>
  /** Every durable control-audit entry on disk, oldest first. Desktop only, same as the rest of this group. */
  getControlAudit?(): Promise<ControlAuditEntry[]>

  // --- LAN pairing (device-to-device, end-to-end encrypted) ---------------
  // See `src/core/pairing.ts`. HOST is desktop-only — only Electron main can
  // open a socket on the LAN interface. JOINER is `pairingJoinRequest` alone:
  // both desktop and Android need it (a phone scanning a laptop's code, or a
  // laptop scanning a phone's), and both are equally blocked from calling
  // `fetch()` on a LAN address directly by `connect-src 'self'` — so this is
  // present on every platform bridge except the browser preview, which has no
  // trusted layer to relay through.
  /**
   * HOST: start a ~2-minute LAN pairing session and return the QR payload.
   * `pairId` is required for `mode: 'ongoing'` — see `pairingServer.ts`.
   *
   * `host` picks which of this machine's addresses to publish; omitted, the
   * best-ranked one is used. See `lanAddresses`.
   */
  startPairingHost?(mode: PairMode, pairId?: string, host?: string): Promise<PairingPayload>
  /**
   * HOST: every address this machine could be reached at, best first.
   *
   * A desktop with a VPN client, a hypervisor or a container runtime installed
   * holds several private addresses that look identical to the one the Wi-Fi
   * card has, and only one of them is on the phone's network. The ranking in
   * `pairingServer.ts` guesses; this is what lets the user see the guess and
   * override it instead of reading a socket timeout on the other device.
   */
  lanAddresses?(): Promise<string[]>
  /** HOST: stop early. */
  stopPairingHost?(): Promise<void>
  /** HOST: listening/connected/expired/stopped/error, as they happen. */
  onPairingEvent?(handler: (event: PairingEvent) => void): () => void
  /** JOINER: relay one POST to a LAN pairing endpoint through the trusted layer. */
  pairingJoinRequest?(url: string, body: unknown): Promise<unknown>

  // --- ongoing sync ---------------------------------------------------------
  // See `src/core/syncLoop.ts`. Present on every platform: a `SyncLoop`
  // always plays the initiating side (`syncRequest`, the same "relay one POST
  // through the trusted layer" shape as `pairingJoinRequest`). Only the
  // desktop bridge also implements `onSyncServerRequest`/`respondToSyncServer`
  // — the accepting side, same HOST-only reasoning as pairing.
  /** Relay one POST to `http://<lan-ip>:<port>/sync`. */
  syncRequest?(url: string, body: unknown): Promise<unknown>
  /**
   * HOST only: open the LAN sync listener, or close it.
   *
   * Deliberately not automatic on launch. Binding a LAN interface is what
   * raises the Windows firewall prompt, so an app that promises no server had
   * better not ask for one before the user has paired anything — see
   * `electron/syncServer.ts`. The caller passes "this machine has at least one
   * 'ongoing' pairing", and the returned status is what the settings screen
   * shows when the socket did not come up.
   */
  applySyncListener?(enabled: boolean): Promise<SyncListenerStatus>
  /** HOST only: a request arrived on the ongoing-sync listener and wants an answer. */
  onSyncServerRequest?(handler: (request: SyncServerRequest) => void): () => void
  respondToSyncServer?(response: SyncServerResponse): Promise<void>
  /**
   * Read back an 'ongoing' pairing's own long-lived key — `keyRef` in,
   * base64 key material out, or `null` if it was revoked.
   *
   * The one deliberate exception to "a renderer never reads a secret back":
   * `setSecret`/`hasSecret`/`deleteSecret` are the whole story for an SMTP or
   * IMAP password, which can send mail or read a mailbox from anywhere once
   * it leaks. A sync key only unlocks LAN data-sync with a device that
   * already completed an authenticated pairing — see `core/pairedDevices.ts`'s
   * module doc — so `core/syncLoop.ts` needs it in the renderer to do its own
   * AES-GCM, the same WebCrypto every other pairing key already uses.
   */
  getSyncSecret?(keyRef: string): Promise<string | null>
  /**
   * Seal the keystore's passwords for these accounts, for the pairing named by
   * `keyRef`, without ever handing one back.
   *
   * The counterpart to the paragraph above, and the reason it does not have to
   * be widened. Syncing an account is only worth anything if the password
   * comes with it — the whole point is not typing it a second time on the
   * phone — but "let the renderer read a password" and "let a password move
   * between two devices the user paired on purpose" are different requests,
   * and only the second one is being granted. Everything happens on this side
   * of the boundary: the keystore read, the HKDF, the AES-GCM. What comes back
   * is a `PairingEnvelope` and the ids it covers.
   *
   * `null` when the keystore holds nothing for any of them, so a caller can
   * tell "no passwords to send" from "sent an envelope with nothing in it".
   * See `core/secretTransport.ts`, including its note on what this boundary is
   * and is not worth.
   */
  sealAccountSecrets?(keyRef: string, accountIds: string[]): Promise<SealedAccountSecrets | null>
  /**
   * The other end: open one of those and write every credential in it straight
   * into this device's keystore. Resolves with the account ids written.
   *
   * Rejects if the envelope cannot be opened — a wrong or revoked key, or a
   * bundle from a future version. The caller treats that as "the accounts
   * arrived without their passwords", never as a reason to drop the rest of
   * the sync.
   */
  openAccountSecrets?(keyRef: string, envelope: PairingEnvelope): Promise<string[]>

  // --- files --------------------------------------------------------------
  pickFiles(): Promise<Attachment[]>
  /** Copy attachments into app-private storage so a later send still finds them. */
  snapshotAttachments(attachments: Attachment[], jobId: string): Promise<Attachment[]>
  revealPath(path: string): Promise<void>
  /**
   * Hand a file to the OS's default handler for it — desktop only, since it is
   * the only platform holding a real filesystem path an "open" can act on.
   */
  openPath?(path: string): Promise<void>
  /**
   * Save clipboard image bytes as an attachment (pasting an image into the
   * compose body). Desktop only, for the same reason `openPath` is.
   */
  attachBlob?(name: string, mime: string, data: ArrayBuffer): Promise<Attachment>
  /**
   * Read an attachment back as a `data:` URL so it can be shown in place.
   *
   * Resolves `null` for anything the platform will not preview — too large,
   * not a safe type, no longer on disk. Optional as a whole because a platform
   * that cannot do it at all should degrade to "open with the system handler",
   * not report an error for every attachment.
   */
  readAttachment?(path: string): Promise<{ dataUrl: string; mime: string } | null>
  /** Save a copy where the user chooses. Resolves null if they cancelled. */
  saveAttachmentAs?(path: string, suggestedName: string): Promise<string | null>
  /** Save every listed attachment into one chosen folder. */
  saveAttachmentsTo?(paths: string[]): Promise<{ folder: string; saved: number } | null>
  /**
   * Make sure a received attachment's bytes are on local disk, and answer
   * where they landed.
   *
   * Only implemented where a listed attachment might not have been downloaded
   * yet — which today means Android, whose sync deliberately records
   * attachment metadata and leaves the bytes on the server so a mailbox full
   * of photographs does not spend a phone's data allowance on files nobody
   * opens. The desktop writes attachments out during the body fetch, so it
   * omits this and every caller falls back to `attachment.path`.
   *
   * Idempotent: an attachment already on disk comes back without a connection
   * being opened, which is what makes preview → save → open three taps rather
   * than three downloads.
   */
  ensureAttachment?(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
    attachment: Attachment,
  ): Promise<Attachment>
  /**
   * Which of these paths still exist. Optional: platforms that cannot answer
   * simply omit it, and every caller treats "cannot check" as "do not claim
   * anything" rather than as "missing".
   */
  checkFiles?(paths: string[]): Promise<Record<string, boolean>>
  /** Turn dropped file paths into attachments. Absent where drops carry no path. */
  attachPaths?(paths: string[]): Promise<Attachment[]>
  /** The real path of a dropped `File`, where the platform can tell us. */
  pathForFile?(file: File): string

  // --- scheduling ---------------------------------------------------------
  /**
   * Hand the platform scheduler everything it needs to fire without us.
   * Accounts travel with the jobs because on Android the worker runs long
   * after the WebView is gone and cannot ask the UI for the SMTP settings —
   * it only looks the *password* up separately, from the keystore.
   */
  syncJobs(
    jobs: ScheduledJob[],
    accounts: MailAccount[],
    /**
     * What a scheduler running with no UI attached cannot ask for itself.
     *
     * The two notification switches: Android's worker used to ask each *job*
     * whether to announce a success — a field `ScheduledJob` has never carried,
     * so the answer was always the default `false` and a scheduled send that
     * worked notified on nothing, ever.
     *
     * And the inbox index, which is what makes `noReplySince` mean anything
     * away from the UI. The mailbox lives in application state, so the desktop
     * scheduler had no way to answer "have they replied" and reported the
     * condition undecidable — and undecidable deliberately *sends*, because
     * holding mail back on a guess is worse than sending it. The effect was
     * that "only if they haven't replied" worked for the Run now button and
     * quietly did nothing for every scheduled send, which is the one case it
     * was written for. Handed over here, on the same call and at the same
     * moment as the jobs themselves, so it cannot drift out of step with them.
     *
     * Optional throughout: a platform that ignores it is no worse off than
     * before, and the desktop still receives the two switches through
     * `setDesktopPrefs` as well.
     */
    headless?: {
      notifyOnSuccess: boolean
      notifyOnFailure: boolean
      /** True once at least one enabled inbox has synced. */
      inboxKnown?: boolean
      /** `core/conditions.latestInboundIndex` — sender key to epoch ms. */
      latestInbound?: Record<string, number>
      /**
       * This device's own `Settings.localDeviceId` — what the platform
       * scheduler compares each job's `executorDeviceId` against before
       * letting it actually fire. See `ScheduledJob.executorDeviceId`'s doc.
       */
      localDeviceId?: string
    },
  ): Promise<void>
  /** Fires when the platform completed a scheduled send while we were open. */
  onJobEvent(handler: (event: JobEvent) => void): () => void
  /**
   * Runs that completed with no UI attached, to be applied on open.
   *
   * Optional because it only means something where the scheduler outlives the
   * window — Android. On the desktop the live event already carries the same
   * data, and in the browser there is no scheduler to report anything.
   */
  pullJobRuns?(): Promise<Array<JobRun & { jobId: string }>>
  /**
   * Every entry currently sitting in the durable dispatch ledger, whatever
   * state it is in — see `core/dispatchLedger.ts`. Desktop only, since that
   * ledger (`electron/store.ts`'s `LEDGER_FILE`) only exists there; Android
   * keeps its own equivalent (`JobStore`'s ledger, see `scheduler.ts`'s module
   * doc) but does not expose it over the bridge today.
   *
   * Read fresh on every call rather than pushed as an event — the ledger
   * empties itself the instant a send finishes, so "reasonably current" from
   * a poll on demand (the Reliability Center's own screen, opened when
   * someone actually wants to know) is worth more than a live subscription
   * nothing else needs.
   */
  getDispatchLedgerStatus?(): Promise<DispatchLedgerEntry[]>

  // --- inbox (receiving) ---------------------------------------------------
  // All optional: only the desktop has IMAP wired up so far. The Android
  // build reuses the same `com.sun.mail` JavaMail dependency already bundled
  // for SMTP (it registers an IMAP provider too — no new library needed) but
  // that wiring is later work; until then `bridge?.syncInbox` is simply
  // absent and the UI hides inbox affordances, the same way it already hides
  // install/download on platforms where those are unavailable.
  /** Connect, fetch new headers, cache bodies — returns the account's updated inbox state. */
  syncInbox?(config: InboxAccountState): Promise<InboxAccountState>
  /**
   * Probe the receive endpoint and report back, saving nothing.
   *
   * `secret` is optional so the dialog can test a password the user has typed
   * but not yet saved; omit it and the stored one is used (falling back to the
   * SMTP password for the same account, which for every provider that issues
   * app passwords is the same string).
   */
  testInbox?(config: InboxAccountState, secret?: string): Promise<SendResult>
  /**
   * Hand the platform the set of accounts that should be watched for new mail
   * over a held-open connection. Passwords are deliberately absent — the
   * platform looks them up itself, the same way the scheduler does.
   *
   * Absent on platforms with no push story (Android keeps its periodic
   * WorkManager job instead of holding a socket open in the background), and
   * the timed check runs on every platform regardless, so an implementation
   * missing here costs latency and nothing else.
   */
  watchInbox?(configs: InboxAccountState[]): Promise<void>
  /** Takes the account's inbox config (not just its id), matching `sendNow`/`testConnection`'s convention of passing the live object rather than re-reading it from disk. */
  getMessageBody?(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
  ): Promise<InboxMessageBody>
  /**
   * Sanitize an HTML string the same way a received message's body is
   * sanitized before rendering — script/style/iframe stripped, remote images
   * replaced with the blank placeholder — so a scheduled draft's HTML preview
   * never opens a second, unaudited render path. Desktop only, like every
   * other `sanitize-html`-backed call; where it is absent (Android, the
   * browser preview) the calendar's body preview falls back to plain text
   * rather than rendering anything unsanitized.
   */
  sanitizeHtml?(html: string): Promise<string>
  /**
   * `seen` best-effort mirrors to the server's `\Seen` flag; `tag` never
   * leaves the device (see `InboxTag`). Local state always updates regardless
   * of whether the server round-trip succeeds.
   */
  setMessageFlags?(
    config: InboxAccountState,
    folderPath: string,
    uid: number,
    patch: { seen?: boolean; tag?: InboxTag },
  ): Promise<void>
  /**
   * Local cache only — never issues an IMAP `\Deleted`/EXPUNGE.
   *
   * "Re-syncable" is why the caller must also record a tombstone: on its own
   * this drops the cached body and the next sync fetches the message straight
   * back. See `core/inboxRemoval.ts`.
   */
  deleteInboxMessages?(
    accountId: string,
    items: Array<{ folderPath: string; uid: number }>,
  ): Promise<void>
  /**
   * Delete on the server, for real.
   *
   * Takes the account config rather than just an id because it has to open a
   * connection. Rejects when the server refuses — a resolved promise here means
   * the mail is genuinely gone from the mailbox.
   */
  purgeInboxMessages?(
    config: InboxAccountState,
    items: Array<{ folderPath: string; uid: number }>,
  ): Promise<void>
  /**
   * Download a remote image through the trusted main process and return it as
   * a `data:` URI, so a sanitized message body never makes its own network
   * request (which is how a tracking pixel would otherwise leak the reader's
   * IP and confirm the message was opened).
   */
  fetchRemoteImage?(url: string): Promise<string>
  /**
   * Read one of the two public feeds named in `feeds.ts` through the trusted
   * side, because the renderer's `connect-src 'self'` forbids it from doing so
   * itself. Absent on the browser preview, which has no trusted side; the two
   * callers fall back to a direct `fetch` there and say so when it is refused.
   */
  fetchFeed?(url: string): Promise<FeedResponse>
  /**
   * Drop the on-disk remote-image cache. Optional because only the desktop
   * build has one — Android fetches through the plugin without caching.
   */
  clearImageCache?(): Promise<void>
  /** New mail arrived while the app was open. */
  onInboxEvent?(handler: (event: InboxEvent) => void): () => void

  // --- data folder --------------------------------------------------------
  /** Where the app keeps everything, and where else it could. */
  dataFolder(): Promise<DataFolder>
  /** Free choice via the OS folder picker. Desktop only — see `canPickAny`. */
  chooseDataFolder(move: boolean): Promise<DataFolderChange>
  /** Switch to one of the offered options, `default` included. */
  useDataFolder(optionId: string, move: boolean): Promise<DataFolderChange>
  openDataFolder(): Promise<void>

  // --- updates ------------------------------------------------------------
  /** Ask the release feed whether a newer build exists. Never throws. */
  checkForUpdate(): Promise<UpdateInfo>
  /**
   * Fetch and verify the new build.
   *
   * Desktop only. Android returns `undefined`, because installing an APK has to
   * go through the system package installer and that means handing the URL to
   * the browser rather than downloading it ourselves.
   */
  downloadUpdate?(asset: UpdateAsset): Promise<DownloadProgress>
  installUpdate?(filePath: string): Promise<void>
  onUpdateProgress?(handler: (progress: DownloadProgress) => void): () => void

  // --- misc ---------------------------------------------------------------
  /**
   * `code: true` marks a verification code, which some platforms route to a
   * separate, higher-importance channel — the whole value of that one is being
   * readable without switching apps. Platforms with a single notification
   * surface ignore it.
   */
  notify(
    title: string,
    body: string,
    opts?: {
      code?: boolean
      /**
       * The bare code, when `code` is set.
       *
       * Android puts a Copy button on the notification and this is what it
       * writes to the clipboard. It has to arrive separately because the title
       * is a worded sentence — a button that pasted "Verification code:
       * 482 913" into a verification field would be worse than no button.
       */
      value?: string
      /**
       * That button's label, already translated.
       *
       * The native layer has no access to `src/i18n`, and this is the only
       * control the app ever puts on a notification; passing the word down is
       * what stops it being the single untranslated string in the product.
       */
      copyLabel?: string
      /**
       * The inbox message this notification is about, if any.
       *
       * A notification that raises the window and leaves the reader to go and
       * find the mail themselves is only half of one. Where a platform can
       * carry it, this id comes back through `onOpenMessage` when the
       * notification is tapped, and the app opens that message.
       */
      messageId?: string
    },
  ): Promise<void>
  /**
   * The user tapped a notification that named a message. Opens it.
   *
   * Desktop delivers this as an event, because the click happens in the main
   * process while the window is already alive. Android cannot: the tap may be
   * what starts the app, hours after any WebView existed, so it stores the id
   * and this handler is called once at startup with whatever was waiting. Both
   * shapes are the same to the caller — subscribe, get told, unsubscribe.
   */
  onOpenMessage?(handler: (messageId: string) => void): () => void
  /**
   * Another application handed us something to send. Opens Compose with it.
   *
   * Android's share sheet, a `mailto:` link and Explorer's Send To all arrive
   * here. Same two delivery shapes as `onOpenMessage` and for the same reason:
   * the desktop can push it as an event because the window is already alive,
   * Android cannot because the share is what started the process. Both look
   * identical to the caller — subscribe, get told at most once per share,
   * unsubscribe.
   *
   * Optional: the web build has no OS to be shared to.
   */
  onShare?(handler: (share: SharePayload) => void): () => void
  openExternal(url: string): Promise<void>
  appInfo(): Promise<AppInfo>
  /**
   * Put text on the system clipboard, natively.
   *
   * Android only, and it is not an optimisation there — it is the only path
   * that works. See `core/clipboard.ts`, which owns the fallback ladder and is
   * what every caller in the app should actually be using; this method exists
   * to be the first rung of it. Platforms whose WebView honours
   * `navigator.clipboard` leave it undefined rather than reimplementing it.
   */
  copyText?(text: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    aevistle?: unknown
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
  }
}

export function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'web'
  if (window.aevistle) return 'desktop'
  const cap = window.Capacitor
  if (cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android') return 'android'
  return 'web'
}

/**
 * Are we inside the desktop shell but without the bridge it should have injected?
 *
 * This matters because of what the fallback is. `detectPlatform` answers "no
 * `window.aevistle`" with `'web'`, and the web bridge is a working app: it
 * keeps state in localStorage and its scheduling maths runs. So a preload that
 * failed to load — a sandbox change, a bad path, a throw inside preload.cjs —
 * would not produce a broken-looking app. It would produce a normal-looking one
 * that quietly writes to browser storage instead of the data folder and arms no
 * alarms at all, and the user would only find out when the mail never arrived.
 *
 * The user-agent is the honest signal here: Electron puts its own token in it,
 * and that token is there whether or not our preload ran.
 */
export function isDesktopShellWithoutBridge(): boolean {
  if (typeof window === 'undefined' || window.aevistle) return false
  return / Electron\//.test(navigator.userAgent ?? '')
}

let cached: PlatformBridge | null = null

/**
 * Resolve the bridge for the current host. Implementations are imported lazily
 * so that, for example, the Capacitor runtime is never pulled into the Electron
 * bundle and vice versa.
 */
export async function getBridge(): Promise<PlatformBridge> {
  if (cached) return cached

  // Refuse to quietly become the browser sandbox inside the desktop app. See
  // `isDesktopShellWithoutBridge` — falling back here loses the user's data
  // folder and their entire schedule while looking completely normal.
  if (isDesktopShellWithoutBridge()) {
    throw new Error(
      'The desktop bridge did not load, so Aevistle cannot reach your data folder or the ' +
        'scheduler. Reinstalling usually fixes this. Your existing data has not been touched.',
    )
  }

  const platform = detectPlatform()

  if (platform === 'desktop') {
    const mod = await import('./bridge-desktop')
    cached = mod.createDesktopBridge()
  } else if (platform === 'android') {
    const mod = await import('./bridge-android')
    cached = mod.createAndroidBridge()
  } else {
    const mod = await import('./bridge-web')
    cached = mod.createWebBridge()
  }

  return cached
}

/**
 * The bridge, if one has already been resolved, without awaiting anything.
 *
 * For the handful of callers that run inside a user gesture and cannot afford
 * to yield first — `core/clipboard.ts` is the one that made this necessary. A
 * clipboard write is only honoured while the gesture is still live on some
 * engines, and `await getBridge()` inside a click handler is enough of a pause
 * to lose it. Answers `null` before the first `getBridge()` has resolved,
 * which every caller must treat as "use the web path", never as an error: by
 * the time any of them can be pressed, `AppState` has long since resolved it.
 */
export function getBridgeSync(): PlatformBridge | null {
  return cached
}

/** Test seam — lets a unit test or a story inject a fake. */
export function __setBridge(bridge: PlatformBridge | null): void {
  cached = bridge
}

// ---------------------------------------------------------------------------
// Shared helpers used by every implementation
// ---------------------------------------------------------------------------

/**
 * Classify a transport error so the UI can say something useful about it.
 *
 * Order matters. `handshake` is tested before the generic `tls` and `network`
 * cases because "Unexpected socket close" contains the word "socket" and would
 * otherwise be filed as a network problem — sending the user off to check
 * their Wi-Fi when the actual fix is a different port.
 */
export function classifyError(message: string): SendResult['errorKind'] {
  const m = message.toLowerCase()
  if (/auth|535|534|password|credential|login|应用专用|授权码/.test(m)) return 'auth'
  if (/unexpected socket close|wrong version number|greeting never received|econnreset|epipe|etls|handshake/.test(m)) {
    return 'handshake'
  }
  if (/no answer from the server|timed out|timeout|etimedout/.test(m)) return 'timeout'
  if (/certificate|self[- ]signed|tls|ssl|depth zero|unable to verify/.test(m)) return 'tls'
  if (/enotfound|econnrefused|ehostunreach|enetunreach|network|dns|getaddrinfo|socket/.test(m)) return 'network'
  if (/550|551|553|recipient|no such user|mailbox unavailable/.test(m)) return 'recipient'
  if (/552|quota|exceeded|too large|message size/.test(m)) return 'quota'
  if (/enoent|no such file|permission denied|eacces/.test(m)) return 'attachment'
  if (/invalid|missing|required|port|host/.test(m)) return 'config'
  return 'unknown'
}

export function failedResult(error: unknown, startedAt: number): SendResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    accepted: [],
    rejected: [],
    durationMs: Date.now() - startedAt,
    error: message,
    errorKind: classifyError(message),
  }
}
