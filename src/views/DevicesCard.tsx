/**
 * Settings management for paired devices — see `core/pairedDevices.ts` for
 * the record shape and `core/syncLoop.ts` for what actually uses it — and the
 * one place a pairing is *started*, from either end.
 *
 * Three actions plus the two roles `core/pairing.ts` describes:
 *
 * **Pair a new device** is the HOST role: mint a `pairId`, ask
 * `bridge.startPairingHost` for a ~2-minute LAN listener, draw the payload it
 * returns as a QR code, and — when the `connected` event arrives carrying an
 * `OngoingPairingSecret` — write the long-lived key to the keystore and save
 * the `PairedDevice`.
 *
 * Available on the desktop and on Android both, and it was desktop-only until
 * `LanServer.java` and `core/pairingHostLocal.ts` landed. The old restriction
 * was read off the wrong thing: Electron main is the only place that can hold a
 * LAN socket open *in Node*, which was taken to mean the only place that can
 * host at all, so a phone could scan a code and never show one. Since the
 * handshake is `core/pairing.ts` running on WebCrypto and the socket is the only
 * genuinely native part, Android needed a `ServerSocket` and nothing else.
 *
 * What that fixes is not one direction but five. Every combination now works
 * from either end — phone/computer, phone/phone, tablet/computer,
 * tablet/tablet, tablet/phone — where before, every pairing needed a desktop in
 * the room to be the one showing the code. A build with neither role (the web
 * sandbox) still draws no button and says why instead.
 *
 * **Join with a code** is the JOINER role: `PairingScanner` decodes a camera
 * frame or pasted text into a `PairingPayload`, `joinPairing` completes the
 * ECDH handshake through the trusted relay, and the same key/record pair is
 * written on this side. Available wherever `bridge.pairingJoinRequest` is —
 * desktop and Android both, since either can be the device holding the camera.
 *
 * The two sides do not save identical records. The joiner learns the host's
 * LAN address from the QR code and stores it, so it is the side that starts
 * every sync cycle; the handshake tells the host nothing about where the
 * joiner is reachable, so its record has no `lastAddress` and it only ever
 * answers. That asymmetry is why the host's confirmation says so in plain
 * language rather than leaving someone waiting for a cycle that will never
 * begin from this end.
 *
 * Only 'ongoing' pairings are offered over the LAN. A `'once'` pairing is a
 * mode the payload can carry, but nothing in this app moves a `ScopePayload`
 * across a live pairing session — `pairingServer.ts` closes the socket the
 * moment the handshake is answered — so a "just this once" button here would
 * complete a handshake and transfer nothing. The one-time path that does work
 * is the encrypted pairing file directly above this card
 * (`views/PairingFileCard.tsx`), and `devices.oneTimeInstead` points at it.
 *
 * **Revoke** deletes the record and its keystore entry on this machine only.
 * There is no way to reach out and lock the other device — this app has no
 * server and relays nothing — so the honest claim is the one made in
 * `devices.revokeConfirm`: the other side is not told anything, and finds out
 * the pairing ended the next time its own `SyncLoop` tries to decrypt a
 * request with a key this machine no longer has, at which point it is
 * prompted to re-pair. Not instant, not remote, and the copy says so.
 *
 * It is a button with a word on it, not the bare trash icon it started as.
 * The icon alone was found by nobody: it sits at the end of a row that already
 * opens with an icon, so it reads as part of the decoration rather than as the
 * one destructive control on this screen. The accessible-name problem that
 * made it an `IconButton` in the first place — every icon in `icons.tsx` is
 * `aria-hidden`, so an icon-only text button has no name at all — is answered
 * just as well by a visible label, and answered for sighted users too.
 *
 * **Leave the pairing** is that same revoke applied to every record at once,
 * offered from a row standing for *this* device at the top of the list. The
 * list held only the other devices, which left this machine's own membership
 * as the single thing on the screen with no control attached to it: someone
 * passing a laptop on could delete the rows one by one and still had no way to
 * say "take me out of this". It runs the same per-record teardown, so key
 * handling lives in exactly one place, and it is one-sided for exactly the
 * same reason — `devices.leavePairingConfirm` repeats the claim
 * `devices.revokeConfirm` makes, that the other devices keep their own records
 * until they revoke too.
 *
 * **Regenerate** re-runs the ECDH handshake with the same device (same
 * `pairId`, so sync history is untouched) and only exists for `'ongoing'`
 * rows — a `'once'` pairing kept nothing to regenerate. HOST role, the same as
 * pairing itself, and available on the same platforms.
 *
 * **Revoke this code** kills the listener a QR code points at without closing
 * the panel around it. Until it existed, the only way to take a code back was
 * to dismiss the whole dialog — which is right when you are finished and wrong
 * when you are not: someone who has just noticed the wrong person reading the
 * screen wants that code dead *and* the panel still open, ready to mint
 * another. It calls the same `bridge.stopPairingHost()` that `closeHost` and
 * the address picker already call — there is one teardown here, not three —
 * and then puts the panel into a state that cannot be mistaken for a live
 * code: the QR is gone outright, replaced by a notice and the regenerate
 * button. There is deliberately no arrangement in which the listener is down
 * and a scannable code is still drawn.
 *
 * ## Where the panels live
 *
 * All three panels are dialogs. They were cards appended after the list, which
 * is a panel opening below a button on a desktop and something else entirely on
 * a phone: Settings is itself a full-height dialog there, the devices card fills
 * it, and so the QR code or the camera preview a tap produced was off-screen
 * with no indication it had appeared. A dialog puts each panel where the tap
 * was, and gives it the one thing an appended card never had — a close button.
 * Closing runs the same teardown Cancel did, so the listener stops and the
 * camera is released rather than being left running behind a dismissed panel.
 *
 * ## The camera goes first
 *
 * Inside the joining dialog the scanner is the first thing in the body and the
 * biggest thing in it. It used to be the last: the platform picker, the name
 * field and the whole `SyncScopePicker` list rendered above it, which is
 * 400-500px of form on a 390px phone, so the viewfinder — the entire point of
 * the button that opened this — began below the fold. Making the panel a
 * dialog fixed *where* it opened without fixing *what* was at the top of it,
 * and "相机的位置操作比较不直观" is that same report arriving a second time.
 *
 * The three controls are not gone, they are behind a disclosure, because not
 * one of them has to be answered before scanning: `scopes` starts as every
 * key, `otherPlatform` starts as the opposite of whatever this device is, and
 * an empty name falls back to the platform's own. Someone pairing a phone with
 * a laptop and syncing all of it — the common case — taps "use a code" and
 * gets a camera. The one answer that genuinely is required is "at least one
 * scope", and clearing them all forces the disclosure open and puts the reason
 * where the viewfinder was, rather than leaving a dialog with nothing in it.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Modal,
  Segmented,
  StatusChip,
  useConfirm,
  useFieldId,
  useToast,
} from '../components/ui'
import {
  IconKey,
  IconLink,
  IconMonitor,
  IconQr,
  IconRefresh,
  IconSmartphone,
  IconTrash,
} from '../components/icons'
import { PairingQr, type PairingHostStatus } from '../components/PairingQr'
import { PairingScanner } from '../components/PairingScanner'
import { SyncScopePicker } from '../components/SyncScopePicker'
import { DeviceLinkAnimation } from '../components/DeviceLinkAnimation'
import { SyncConflictList } from '../components/SyncConflictList'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import type { PairedDevice, PairedDevicePlatform } from '../core/sync/pairedDevices'
import { joinPairing, type OngoingPairingSecret, type PairingPayload } from '../core/sync/pairing'
import { syncNow } from '../core/sync/activeSyncLoop'
import {
  SYNC_SERVER_PORT,
  type SyncCycleReport,
  type SyncDeviceReport,
  type SyncListenerError,
} from '../core/sync/syncLoop'
import { SYNC_SCOPE_KEYS, type SyncScopeKey } from '../core/sync/syncScope'
import { newId } from '../core/types'

const LISTENER_ERROR_KEYS: Record<SyncListenerError, TranslationKey> = {
  noNetwork: 'devices.syncNoNetwork',
  portInUse: 'devices.syncPortInUse',
  blocked: 'devices.syncBlocked',
  failed: 'devices.syncListenFailed',
}

/** How long "Synced" stays on the button before it goes back to offering the action. Long enough to be read, short enough not to look like a disabled state. */
const SYNC_DONE_MS = 4_000

/**
 * What the last press of "sync now" produced.
 *
 * `'unavailable'` and `'threw'` are not the same thing as a cycle that ran and
 * went badly, and flattening all three into one "sync failed" is exactly the
 * unactionable message this button exists to avoid: one means the loop is not
 * running on this device yet, one means the attempt itself broke, and the
 * third has a per-device answer for each device.
 */
type SyncNowResult =
  | { kind: 'unavailable' }
  | { kind: 'threw'; detail: string }
  | { kind: 'report'; report: SyncCycleReport }

/** Which handshake the open panel is running — the two differ only in what the `connected` event is allowed to write. */
type HostSession =
  | { kind: 'new'; pairId: string }
  | { kind: 'regenerate'; device: PairedDevice }

function platformIcon(platform: PairedDevice['platform']) {
  return platform === 'android' ? <IconSmartphone size={16} /> : <IconMonitor size={16} />
}

export function DevicesCard() {
  const { state, dispatch, bridge, revokePairedDevice, syncListener } = useApp()
  const { t, formatDateTime, formatRelative } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [session, setSession] = useState<HostSession | null>(null)
  const [hostStarted, setHostStarted] = useState(false)
  const [hostPayload, setHostPayload] = useState<PairingPayload | null>(null)
  const [hostStatus, setHostStatus] = useState<PairingHostStatus>('listening')
  const [hostError, setHostError] = useState<string | undefined>(undefined)
  /**
   * The user took the code back — see `revokeCode`. Its own flag rather than a
   * `PairingHostStatus`, because that type is the *host's* report of what the
   * session is doing and this is the one transition the host never announces:
   * `stopPairingHost` drops the listener without emitting anything the effect
   * below could hear.
   */
  const [hostRevoked, setHostRevoked] = useState(false)

  const [joining, setJoining] = useState(false)
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinDone, setJoinDone] = useState(false)
  const [joinError, setJoinError] = useState('')
  /**
   * Whether the joining dialog's name/platform/scope controls are unfolded.
   * Closed to begin with, which is the whole of "the camera goes first" in the
   * module doc: every one of those three has a working default, so none of
   * them is worth the screen the viewfinder needs.
   */
  const [joinOptions, setJoinOptions] = useState(false)

  const [scopes, setScopes] = useState<Set<SyncScopeKey>>(() => new Set(SYNC_SCOPE_KEYS))
  const [label, setLabel] = useState('')
  /**
   * What is on the other end — asked, not inferred, and defaulted to the
   * opposite of whatever this device is.
   *
   * It used to be hard-coded to `'android'` for the HOST role and to
   * `'windows'` for the JOINER, on the reasoning that a pairing code can only
   * have been served by the desktop build. That reasoning is gone: a phone
   * hosts now (see `bridge-android.ts`), so a joiner accepting a code has no
   * way to know whether it came from a laptop, a tablet or another phone, and
   * a record that guessed wrong shows the wrong icon and the wrong name for the
   * rest of the pairing's life.
   *
   * The default is the *opposite* platform rather than a fixed one because the
   * common case for both roles is pairing a phone with a computer; someone
   * pairing two phones changes one control.
   */
  const [otherPlatform, setOtherPlatform] = useState<PairedDevicePlatform>(() =>
    bridge?.platform === 'android' ? 'windows' : 'android',
  )
  const labelId = useFieldId('devlabel')

  /**
   * Which of this machine's addresses the QR code will publish.
   *
   * Empty string means "whichever `pairingServer.ts` ranks first", which is
   * the right answer on the overwhelming majority of machines and the only
   * one a phone-and-a-laptop household ever needs.
   *
   * The picker exists for the machines where ranking by interface name cannot
   * win. A desktop with a VPN client, a hypervisor and a container runtime
   * installed reports a fistful of private addresses that are indistinguishable
   * from the Wi-Fi card's by shape alone — `172.18.0.1` looks exactly as much
   * like a LAN as `192.168.1.7` does. Guess wrong and the *phone* is the only
   * thing that finds out, four seconds later, as
   * `failed to connect to /172.18.0.1 … after 4000ms`.
   *
   * So the guess is shown, and it is editable. It is not a setting and is not
   * persisted: the answer changes when the laptop moves between networks, and
   * a remembered address would be wrong exactly when someone is least likely
   * to look at it.
   */
  const [hostAddress, setHostAddress] = useState('')
  const [addresses, setAddresses] = useState<string[]>([])
  const addressId = useFieldId('devaddr')

  /**
   * The device whose scopes are being edited, and the set as it stands.
   *
   * `PairedDevice.scopes` was written once, at pairing time, and there was no
   * way back to it afterwards — which made "choose what syncs" a question
   * asked exactly once, in a dialog whose whole point was that the answer had
   * good defaults and could be skipped. Someone who paired a phone with
   * everything checked and later decided their contacts should stay on the
   * desktop had to revoke the pairing and run the whole handshake again.
   *
   * Edited on this side only, and that is not a limitation to apologise for:
   * `buildChangedPayload` filters by the *sender's* own scopes, so turning
   * 'contacts' off here stops this device from putting contacts on the wire.
   * It does not, and cannot, stop the other device from sending its own — that
   * is the other device's copy of this same switch, and this app has no way to
   * reach across and flip it. `devices.editScopesHint` says so.
   */
  const [editingScopes, setEditingScopes] = useState<PairedDevice | null>(null)
  const [draftScopes, setDraftScopes] = useState<Set<SyncScopeKey>>(() => new Set())

  /**
   * "Sync now" — the only way to start a cycle on purpose.
   *
   * Until this existed, everything on this screen was governed by
   * `SYNC_POLL_INTERVAL_MS`: change something, then wait up to ninety seconds
   * with nothing on screen distinguishing "it is about to go" from "it has
   * been quietly failing since you changed networks last Tuesday". A pairing
   * that has silently stopped working looks identical to one that is simply
   * between polls, and a user has no way to ask.
   *
   * Three states rather than a boolean, because "just finished" has to be
   * visible for a moment or a successful press is indistinguishable from a
   * press that did not register — a cycle over a LAN with nothing to exchange
   * finishes faster than the eye can follow the spinner.
   */
  const [syncPhase, setSyncPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const [syncResult, setSyncResult] = useState<SyncNowResult | null>(null)
  /**
   * Bumped on every press, and used as the result banner's `key`.
   *
   * `Banner` fades an `info`/`success` message out on its own timer and only
   * resets that when its `title` or `tone` changes — so pressing twice in a
   * row, with the same outcome both times, would show nothing the second
   * time. A key that changes per press is what makes the second press a new
   * banner rather than the same, already-dismissed one.
   */
  const [syncRun, setSyncRun] = useState(0)
  const syncDoneTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (syncDoneTimer.current !== null) window.clearTimeout(syncDoneTimer.current)
    },
    [],
  )

  const runSyncNow = async () => {
    if (syncPhase === 'running') return
    if (syncDoneTimer.current !== null) window.clearTimeout(syncDoneTimer.current)
    setSyncRun((n) => n + 1)
    setSyncPhase('running')
    setSyncResult(null)

    // `null` rather than a rejected promise when there is no loop: see
    // `core/sync/activeSyncLoop.ts` for why the loop is reached this way at
    // all, and which builds never register one.
    const pending = syncNow()
    if (!pending) {
      setSyncResult({ kind: 'unavailable' })
      setSyncPhase('idle')
      return
    }

    let result: SyncNowResult
    try {
      result = { kind: 'report', report: await pending }
    } catch (e) {
      // `runCycle` catches every per-device failure itself and reports it in
      // the result, so anything arriving here broke outside of any one
      // device's exchange. Rare, and worth saying out loud rather than
      // rendering as an empty "0 devices" success.
      result = { kind: 'threw', detail: e instanceof Error ? e.message : String(e) }
    }
    setSyncResult(result)

    // The button says "Synced" only when every device actually did. A cycle
    // where one of three peers was unreachable is not a success, and the
    // banner below is the part worth reading in that case — so the label goes
    // straight back to offering the action rather than claiming an outcome.
    const clean =
      result.kind === 'report' && result.report.ran && result.report.devices.every((d) => d.outcome === 'synced')
    if (clean) {
      setSyncPhase('done')
      syncDoneTimer.current = window.setTimeout(() => setSyncPhase('idle'), SYNC_DONE_MS)
    } else {
      setSyncPhase('idle')
    }
  }

  /**
   * One device's outcome, in a sentence that names what to do about it.
   *
   * Every branch supplies exactly the placeholders its own string uses —
   * `translate` leaves a `{slot}` it was given no value for standing on screen
   * as literal braces, so a shared "pass everything" call would print
   * `{address}` into the two messages that have no address to print.
   */
  const syncProblemLine = (report: SyncDeviceReport): string => {
    const device = report.device.label
    switch (report.outcome) {
      case 'noAddress':
        return t('devices.syncNowNoAddress', { device })
      case 'unreachable':
        return t('devices.syncNowUnreachable', {
          device,
          address: report.address ? `${report.address.host}:${report.address.port}` : '',
        })
      case 'refused':
        return t('devices.syncNowRefused', { device, detail: report.detail ?? '' })
      // 'synced' never reaches here — the caller filters it out — but naming
      // it keeps this switch exhaustive, so a new `SyncDeviceOutcome` is a
      // compile error here rather than a device that silently says nothing.
      case 'synced':
      case 'failed':
        return t('devices.syncNowFailed', { device, detail: report.detail ?? '' })
    }
  }

  const syncNowBanner = () => {
    if (!syncResult) return null
    if (syncResult.kind === 'unavailable') {
      return <Banner tone="warning">{t('devices.syncNowUnavailable')}</Banner>
    }
    if (syncResult.kind === 'threw') {
      return (
        <Banner tone="danger" title={t('devices.syncNowResult')}>
          {t('devices.syncNowFailed', { device: t('devices.thisDevice'), detail: syncResult.detail })}
        </Banner>
      )
    }
    const { report } = syncResult
    // `keep`, because this one is a report on something the user asked for
    // and a phone hides every un-kept `info` banner outright — see `Banner`.
    if (!report.ran) {
      return (
        <Banner tone="info" keep>
          {t('devices.syncNowBusy')}
        </Banner>
      )
    }
    const problems = report.devices.filter((d) => d.outcome !== 'synced')
    const synced = report.devices.length - problems.length
    if (problems.length === 0) {
      return <Banner tone="success">{t('devices.syncNowOk', { n: synced })}</Banner>
    }
    return (
      <Banner tone="warning" title={t('devices.syncNowResult')}>
        {synced > 0 ? <div>{t('devices.syncNowOk', { n: synced })}</div> : null}
        {problems.map((problem) => (
          <div key={problem.device.id}>{syncProblemLine(problem)}</div>
        ))}
      </Banner>
    )
  }

  const canHost = Boolean(bridge?.startPairingHost)
  const canJoin = Boolean(bridge?.pairingJoinRequest)
  const thisPlatform: PairedDevicePlatform = bridge?.platform === 'android' ? 'android' : 'windows'

  const platformName = (platform: PairedDevicePlatform) =>
    t(platform === 'android' ? 'devices.platformAndroid' : 'devices.platformWindows')

  // --- HOST -----------------------------------------------------------------

  /**
   * Reassigned every render so the handler the event subscription calls always
   * sees the scopes and name as they are now — the user is free to keep
   * editing both while the code is on screen, and neither travels in the
   * payload.
   */
  const connectedRef = useRef<(open: HostSession, secret: OngoingPairingSecret) => void>(() => {})
  connectedRef.current = (open, secret) => {
    if (!bridge) return
    if (open.kind === 'regenerate') {
      if (secret.pairId !== open.device.id) return
      void bridge.setSecret(open.device.id, secret.longLivedKeyB64, 'sync').then(() => {
        dispatch({
          type: 'upsertPairedDevice',
          device: { ...open.device, clockOffsetMs: secret.clockOffsetMs },
        })
        toast.push({ tone: 'success', title: t('devices.regenerate'), detail: open.device.label })
        setSession(null)
      })
      return
    }
    if (secret.pairId !== open.pairId) return
    const name = label.trim() || platformName(otherPlatform)
    void bridge.setSecret(secret.pairId, secret.longLivedKeyB64, 'sync').then(() => {
      dispatch({
        type: 'upsertPairedDevice',
        device: {
          id: secret.pairId,
          label: name,
          platform: otherPlatform,
          pairedAt: Date.now(),
          mode: 'ongoing',
          scopes: [...scopes],
          keyRef: secret.pairId,
          // No `lastAddress`: the handshake carries the joiner's public key,
          // not its address, so this side has nothing to reach out to and
          // every cycle with this device is one the joiner starts.
          clockOffsetMs: secret.clockOffsetMs,
        },
      })
      toast.push({ tone: 'success', title: t('pairing.connected'), detail: name })
    })
  }

  useEffect(() => {
    if (!session || !bridge?.onPairingEvent) return
    return bridge.onPairingEvent((event) => {
      if (event.type === 'listening') {
        setHostPayload(event.payload)
        setHostStatus('listening')
      } else if (event.type === 'connected') {
        setHostStatus('connected')
        if (event.ongoing) connectedRef.current(session, event.ongoing)
      } else if (event.type === 'expired') {
        setHostStatus('expired')
      } else if (event.type === 'error') {
        setHostStatus('error')
        setHostError(event.message)
      }
    })
  }, [session, bridge])

  const startHost = async (open: HostSession) => {
    if (!bridge?.startPairingHost) return
    setSession(open)
    setHostStarted(true)
    setHostPayload(null)
    setHostError(undefined)
    setHostStatus('listening')
    setHostRevoked(false)
    try {
      const payload = await bridge.startPairingHost(
        'ongoing',
        open.kind === 'new' ? open.pairId : open.device.id,
        hostAddress || undefined,
      )
      setHostPayload(payload)
    } catch (e) {
      setHostStatus('error')
      setHostError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Asked for when the panel opens, not held in a ref or fetched once at
   * mount: between one pairing attempt and the next the laptop may have moved
   * onto a different network, or a VPN may have come up and added an address
   * that was not there before. This is cheap (one `os.networkInterfaces()`
   * call) and always current.
   */
  const loadAddresses = async () => {
    if (!bridge?.lanAddresses) return
    try {
      const found = await bridge.lanAddresses()
      setAddresses(found)
      // Deliberately left on "" (= let the host rank) rather than pinned to
      // `found[0]`. They resolve to the same address today, but pinning would
      // freeze this attempt's choice against a network that changes underneath
      // it between opening the panel and pressing the button.
      if (hostAddress && !found.includes(hostAddress)) setHostAddress('')
    } catch {
      // A build without the handler, or a call that failed: the picker simply
      // does not appear and pairing behaves exactly as it did before it existed.
      setAddresses([])
    }
  }

  const openNewPairing = () => {
    setSession({ kind: 'new', pairId: newId('pair') })
    setHostStarted(false)
    setHostPayload(null)
    setHostError(undefined)
    setHostStatus('listening')
    setHostRevoked(false)
    void loadAddresses()
  }

  const closeHost = () => {
    void bridge?.stopPairingHost?.()
    setSession(null)
    setHostStarted(false)
    setHostRevoked(false)
  }

  /**
   * Take back the code that is on screen, without taking the panel with it.
   *
   * The teardown is `closeHost`'s and the address picker's, unchanged and
   * unduplicated: one `stopPairingHost()`, after which nothing on this machine
   * will answer the token baked into that QR. What differs is only what is
   * left standing — the dialog, so the regenerate path is one tap away instead
   * of a fresh trip through the settings card.
   *
   * `hostPayload` is cleared along with the flag rather than merely being
   * hidden. Nothing downstream should be able to redraw a code whose listener
   * is gone; leaving the payload in state and relying on every reader to
   * check a second variable is exactly the arrangement that ends in a
   * scannable code with nothing behind it.
   */
  const revokeCode = () => {
    void bridge?.stopPairingHost?.()
    setHostPayload(null)
    setHostRevoked(true)
  }

  /**
   * The one control the two host dialogs share below the code: "revoke this"
   * while a code is live, and "draw another" once it is not. `null` in every
   * other state — there is nothing to revoke before a payload arrives, and a
   * connected session has already spent its code.
   */
  const hostCodeAction = (open: HostSession) =>
    hostRevoked ? (
      <Button
        variant="primary"
        icon={<IconRefresh size={15} />}
        onClick={() => void startHost(open)}
      >
        {t('pairing.regenerate')}
      </Button>
    ) : hostPayload && hostStatus === 'listening' ? (
      <Button variant="ghost" onClick={revokeCode}>
        {t('devices.revokeCode')}
      </Button>
    ) : null

  /** What stands where the QR code was. See `revokeCode`. */
  const revokedNotice = () => (
    <Banner tone="warning" title={t('devices.codeRevoked')}>
      {t('devices.codeRevokedHint')}
    </Banner>
  )

  // --- JOINER ---------------------------------------------------------------

  const runJoin = async (payload: PairingPayload) => {
    const post = bridge?.pairingJoinRequest
    if (!bridge || !post) return
    setJoinBusy(true)
    setJoinError('')
    try {
      const joined = await joinPairing(payload, { postJson: (url, body) => post(url, body) })
      if (!joined.ongoing) {
        setJoinError(t('devices.joinNotOngoing'))
        return
      }
      const name = label.trim() || platformName(otherPlatform)
      await bridge.setSecret(joined.ongoing.pairId, joined.ongoing.longLivedKeyB64, 'sync')
      dispatch({
        type: 'upsertPairedDevice',
        device: {
          id: joined.ongoing.pairId,
          label: name,
          // Whatever the user said it was. Nothing in the handshake carries the
          // host's platform, and since `bridge-android.ts` learned to host, the
          // host is no longer necessarily a desktop.
          platform: otherPlatform,
          pairedAt: Date.now(),
          mode: 'ongoing',
          scopes: [...scopes],
          keyRef: joined.ongoing.pairId,
          lastAddress: { host: payload.host, port: SYNC_SERVER_PORT },
          clockOffsetMs: joined.ongoing.clockOffsetMs,
        },
      })
      setJoinDone(true)
      toast.push({ tone: 'success', title: t('pairing.connected'), detail: name })
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e))
    } finally {
      setJoinBusy(false)
    }
  }

  /**
   * `PairingScanner` tears its camera down and reopens it whenever `onDecoded`
   * changes identity, so this has to be stable across every keystroke in the
   * name field — hence the ref rather than a `useCallback` over live state.
   */
  const joinRef = useRef<(payload: PairingPayload) => void>(() => {})
  joinRef.current = (payload) => void runJoin(payload)
  const onDecoded = useCallback((payload: PairingPayload) => joinRef.current(payload), [])

  const openJoin = () => {
    setJoining(true)
    setJoinBusy(false)
    setJoinDone(false)
    setJoinError('')
    // Folded again on every opening: the point of the disclosure is that the
    // camera is what a tap on "use a code" produces, and a remembered
    // expansion would put the form back on top for everyone who ever opened
    // it once.
    setJoinOptions(false)
  }

  const closeJoin = () => {
    setJoining(false)
    setJoinBusy(false)
    setJoinDone(false)
    setJoinError('')
    setJoinOptions(false)
  }

  /**
   * Open because the user opened it, or open because it has to be: an empty
   * scope set is the one state where an answer is compulsory, and the control
   * that answers it cannot be behind a fold.
   *
   * `scopes` outlives a dialog — it is settings-card state, not dialog state,
   * so a set emptied and then closed comes back empty next time, with
   * `joinOptions` freshly reset to `false` by `openJoin`. That is the case
   * this second term exists for; the latch in `shareForm`'s `onChange` covers
   * the same session.
   */
  const optionsOpen = joinOptions || scopes.size === 0

  // --- rows -----------------------------------------------------------------

  /**
   * Forget pairings on this side — the records and the keystore entries behind
   * their `keyRef`s, which is all `revokePairedDevice` in `state/AppState.tsx`
   * does and all either caller here needs. Factored out of `revoke` when the
   * "leave the pairing" row arrived, so that key handling has one home rather
   * than one per button.
   *
   * Sequential rather than `Promise.all`: every call ends in a `dispatch`, and
   * a `forgetSecrets` failure on one device must not abandon the rest.
   */
  const forget = async (devices: PairedDevice[]) => {
    for (const device of devices) await revokePairedDevice(device.id)
  }

  const revoke = async (device: PairedDevice) => {
    const ok = await confirm({
      title: t('devices.revoke'),
      body: t('devices.revokeConfirm'),
      confirmLabel: t('devices.revoke'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    await forget([device])
    toast.push({ tone: 'info', title: t('devices.revoke'), detail: device.label })
  }

  /**
   * The same thing, for every record at once, from this device's own row.
   *
   * One-sided in exactly the way one revoke is, and
   * `devices.leavePairingConfirm` says so rather than letting "leave the
   * pairing" imply a mutual divorce: this machine drops its records and its
   * keys, the others keep theirs and find out the way they always do, when a
   * `SyncLoop` cycle can no longer be decrypted.
   */
  const leavePairing = async () => {
    const ok = await confirm({
      title: t('devices.leavePairing'),
      body: t('devices.leavePairingConfirm'),
      confirmLabel: t('devices.leavePairing'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    await forget(state.pairedDevices)
    toast.push({ tone: 'info', title: t('devices.leavePairing'), detail: t('devices.thisDevice') })
  }

  /**
   * The two questions both roles have to ask, in one place.
   *
   * The platform picker used to live only in the HOST branch. Both roles write
   * a `PairedDevice`, both need its `platform`, and only the user knows — so it
   * belongs to whatever they have in common rather than to one of them.
   */
  const shareForm = () => (
    <>
      <Field label={t('devices.otherPlatform')}>
        <Segmented
          value={otherPlatform}
          onChange={setOtherPlatform}
          ariaLabel={t('devices.otherPlatform')}
          options={[
            { value: 'android', label: t('devices.platformAndroid'), icon: <IconSmartphone size={14} /> },
            { value: 'windows', label: t('devices.platformWindows'), icon: <IconMonitor size={14} /> },
          ]}
        />
      </Field>
      <Field label={t('devices.deviceLabel')} hint={t('devices.deviceLabelHint')} htmlFor={labelId}>
        <input
          id={labelId}
          className="input"
          value={label}
          placeholder={platformName(otherPlatform)}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <SyncScopePicker
        scopes={scopes}
        onChange={(next) => {
          // Emptying the set is what makes this picker compulsory in the
          // joining dialog, and a control that is about to be needed again
          // should not fold itself away the moment it is used. Latching the
          // disclosure open here means re-checking a scope brings the camera
          // back without pulling the list out from under the finger that just
          // fixed it. Meaningless in the host dialog, which has no
          // disclosure; harmless there for the same reason.
          if (next.size === 0) setJoinOptions(true)
          setScopes(next)
        }}
        accounts={state.accounts}
        jobsCount={state.jobs.length}
        contactsCount={state.contacts.length}
        templatesCount={state.templates.length}
      />
    </>
  )

  return (
    <>
      <Card>
        <CardHeader
          title={t('devices.title')}
          action={
            state.pairedDevices.length > 0 ? (
              <DeviceLinkAnimation status="connected" size="inline" rightPlatform={state.pairedDevices[0].platform} />
            ) : undefined
          }
        />
        <div className="card__body form-rows">
          <div className="btn-row">
            {canHost ? (
              <Button
                variant="primary"
                icon={<IconQr size={15} />}
                disabled={session !== null || joining}
                onClick={openNewPairing}
              >
                {t('devices.pairNew')}
              </Button>
            ) : null}
            {canJoin ? (
              <Button
                icon={<IconLink size={15} />}
                disabled={session !== null || joining}
                onClick={openJoin}
              >
                {t('devices.joinNew')}
              </Button>
            ) : null}
          </div>

          {/* No host role on this build means no "pair a new device" button at
              all — this says which device can start one instead. */}
          {!canHost && canJoin ? <Banner tone="info">{t('devices.hostDesktopOnly')}</Banner> : null}
          {!canHost && !canJoin ? <Banner tone="warning">{t('devices.pairingUnavailable')}</Banner> : null}
          <div className="field__hint">{t('devices.oneTimeInstead')}</div>

          {state.pairedDevices.length === 0 ? (
            <EmptyState
              icon={<IconKey size={20} />}
              title={t('devices.empty')}
              hint={t('devices.emptyHint')}
            />
          ) : (
            <>
              {/* This device, at the top of a list that used to describe only
                  the other end of every pairing.

                  Same `.log` shape as the rows under it on purpose: it is a
                  member of the same set, and the thing it offers — leaving —
                  is the same revoke those rows offer, aimed at the one record
                  holder the list never showed. Rendered only alongside real
                  rows; with nothing paired there is no membership to leave and
                  `EmptyState` above is the whole truth of the screen. */}
              <div className="log" style={{ alignItems: 'center' }}>
                {platformIcon(thisPlatform)}
                <div className="log__body">
                  <div className="log__title">{t('devices.thisDevice')}</div>
                  <div className="log__detail">
                    {t('devices.thisDeviceDetail', {
                      platform: platformName(thisPlatform),
                      n: state.pairedDevices.length,
                    })}
                  </div>
                </div>
                <div className="log__actions">
                  <Button
                    variant="ghost"
                    icon={<IconTrash size={16} />}
                    onClick={() => void leavePairing()}
                  >
                    {t('devices.leavePairing')}
                  </Button>
                </div>
              </div>

              {state.pairedDevices.map((device) => (
                <div key={device.id} className="log" style={{ alignItems: 'center' }}>
                  {platformIcon(device.platform)}
                  <div className="log__body">
                    <div className="log__title">{device.label}</div>
                    <div className="log__detail">
                      {device.mode === 'ongoing' ? t('devices.modeOngoing') : t('devices.modeOnce')}
                      {' · '}
                      {t('devices.pairedOn', { when: formatDateTime(device.pairedAt) })}
                      {' · '}
                      {device.lastSyncedAt
                        ? t('devices.lastSynced', { when: formatRelative(device.lastSyncedAt) })
                        : t('sync.status.unreachable')}
                    </div>
                    <div className="btn-row" style={{ marginTop: 'var(--sp-1)' }}>
                      {SYNC_SCOPE_KEYS.filter((key) => device.scopes.includes(key)).map((key) => (
                        <StatusChip key={key} tone="neutral" label={t(`sync.scope.${key}`)} />
                      ))}
                    </div>
                  </div>
                  {/* Its own element rather than two buttons loose on the row:
                      `.btn` is `white-space: nowrap`, so at a phone width the
                      pair could not shrink and `.log__body` — the only flexible
                      thing here — collapsed to nothing, taking the device's name
                      with it. The wrapper is what the ≤560px rule moves onto a
                      second line, which is also what keeps the labelled revoke
                      below from re-breaking that name now that it is wider than
                      the icon it replaced. */}
                  <div className="log__actions">
                    {device.mode === 'ongoing' ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDraftScopes(new Set(device.scopes))
                          setEditingScopes(device)
                        }}
                      >
                        {t('devices.editScopes')}
                      </Button>
                    ) : null}
                    {device.mode === 'ongoing' ? (
                      <Button
                        variant="ghost"
                        disabled={!canHost}
                        title={canHost ? undefined : t('devices.regenerateHint')}
                        onClick={() => void startHost({ kind: 'regenerate', device })}
                      >
                        {t('devices.regenerate')}
                      </Button>
                    ) : null}
                    {/* A `Button` carrying both the trash icon and the word,
                        where this was an `IconButton` holding the icon alone.
                        The icon-only form was chosen for a real reason — every
                        icon in `icons.tsx` is `aria-hidden`, so a text button
                        with nothing but an icon inside has no accessible name —
                        and a visible label satisfies that reason outright,
                        while also being the thing people were failing to find.
                        A row that already opens with a platform icon does not
                        read its closing icon as the one destructive control on
                        the screen. */}
                    <Button
                      variant="ghost"
                      icon={<IconTrash size={16} />}
                      onClick={() => void revoke(device)}
                    >
                      {t('devices.revoke')}
                    </Button>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Both halves of the same subject: what sync does on its own, and
              the one control for making it happen now. The button is drawn
              only alongside an 'ongoing' pairing — a list of `'once'` rows has
              nothing for a cycle to reach, and a button that could only ever
              report "0 devices" is worse than no button. */}
          {state.pairedDevices.some((d) => d.mode === 'ongoing') ? (
            <>
              <Banner tone="info">{t('devices.ongoingHint')}</Banner>
              <div className="btn-row">
                <Button
                  icon={<IconRefresh size={15} />}
                  loading={syncPhase === 'running'}
                  onClick={() => void runSyncNow()}
                >
                  {syncPhase === 'running'
                    ? t('devices.syncNowRunning')
                    : syncPhase === 'done'
                      ? t('devices.syncNowDone')
                      : t('devices.syncNow')}
                </Button>
              </div>
              <div className="field__hint">{t('devices.syncNowHint')}</div>
              {/* A keyed `Fragment` rather than a wrapper element: `.form-rows`
                  spaces its children with `gap`, so an empty `<div>` standing
                  in for "no result yet" would open a hole under the hint. See
                  `syncRun` for why the key is what makes a second press
                  visible at all. */}
              <Fragment key={syncRun}>{syncNowBanner()}</Fragment>
            </>
          ) : null}

          {syncListener?.error ? (
            <Banner tone="danger" title={t('devices.syncUnavailable')}>
              {t(LISTENER_ERROR_KEYS[syncListener.error], { port: SYNC_SERVER_PORT })}
              {/* Its own block, not an inline `<code>` appended to the
                  sentence: the OS message ran straight into the full stop —
                  "…puis rouvrez cet écran.listen EADDRINUSE 0.0.0.0:47821" —
                  which reads as a typo rather than as two separate things.
                  `AccountDialog` puts the same class of string in the same
                  place for the same reason. */}
              {syncListener.detail ? <div className="mono">{syncListener.detail}</div> : null}
            </Banner>
          ) : null}

          {/* A firewall that denies by dropping packets never fails the bind — see
              `SyncListenerError` — so this is the only place the user can be told
              where to look when a listener that came up cleanly hears nothing. */}
          {syncListener?.listening ? (
            <Banner tone="info">{t('devices.syncListening', { address: syncListener.address ?? '' })}</Banner>
          ) : null}
        </div>
      </Card>

      {/*
        Dialogs, not cards appended to the list.

        All three of these used to render as another `<Card>` after the one
        above, which on a desktop reads as a panel opening underneath the
        button. On a phone it does not: Settings is a full-height dialog, the
        devices card fills it, and the panel a tap opened was somewhere below
        the fold — so "Use a code from another device" turned the camera on
        off-screen, and the QR code appeared somewhere the person holding the
        phone had to go looking for. That is the "the pop-up card is in the
        wrong place" and "the camera is not where the tap was" report.

        A dialog puts each one where the tap was, gives it the whole screen on
        a phone or tablet (see the `data-shell="mobile"` rules in `app.css`),
        and — the part that was missing entirely — one unambiguous way out of
        it. `onClose` is the same teardown the Cancel buttons already ran, so
        closing the QR panel drops the LAN listener and closing the scanner
        releases the camera, rather than leaving either running behind a
        dismissed dialog.
      */}
      {session?.kind === 'new' ? (
        <Modal
          open
          fullscreen
          title={t('devices.pairNew')}
          onClose={closeHost}
          closeLabel={t('common.close')}
        >
          <div className="form-rows">
            {hostStarted ? (
              <>
                {/* Either the code or the notice that it is no longer one —
                    never both, and never the code without a listener behind
                    it. See `revokeCode`. */}
                {hostRevoked ? (
                  revokedNotice()
                ) : (
                  <PairingQr
                    payload={hostPayload}
                    status={hostStatus}
                    errorMessage={hostError}
                    onRegenerate={() => void startHost(session)}
                    mode="ongoing"
                    lockMode
                    otherPlatform={otherPlatform}
                  />
                )}
                {hostStatus === 'connected' ? (
                  <Banner tone="info">{t('devices.hostConnectedHint')}</Banner>
                ) : null}

                {/* Which address the code actually published, in plain text
                    beside the QR block.

                    The QR encodes it, but a QR code is not readable by the
                    person holding it, so when the other device times out the
                    only party who can tell that the wrong interface was chosen
                    is the one who cannot see the choice. Printing it makes the
                    two halves of the diagnosis available in the same place:
                    this line says `172.18.0.1`, the phone's error says
                    `172.18.0.1`, and the fix is one button away instead of
                    being a mystery. */}
                {hostPayload && hostStatus !== 'connected' ? (
                  // `--keep`: exempt from the narrow-screen hint cull. This is
                  // the only place the published address is legible to a human,
                  // and it is the half of the diagnosis the *other* device's
                  // timeout cannot supply.
                  <div className="field__hint field__hint--keep">
                    {t('devices.hostAddressShown', { address: hostPayload.host })}
                  </div>
                ) : null}

                <div className="btn-row">
                  <Button variant={hostStatus === 'connected' ? 'primary' : 'ghost'} onClick={closeHost}>
                    {hostStatus === 'connected' ? t('common.done') : t('common.cancel')}
                  </Button>
                  {/* "Revoke this code" while one is live, "generate a new
                      code" once it is not — the same slot, because they are
                      the two halves of one decision and the panel deliberately
                      survives the first so it can offer the second. */}
                  {hostCodeAction(session)}
                  {addresses.length > 1 && hostStatus !== 'connected' ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        // Drops the listener before going back, so the old
                        // address stops accepting the moment a different one
                        // is being considered.
                        void bridge?.stopPairingHost?.()
                        setHostStarted(false)
                        setHostPayload(null)
                        setHostRevoked(false)
                      }}
                    >
                      {t('devices.hostAddressChange')}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                {shareForm()}

                {/* Only when there is a decision to make. One address is not a
                    choice, and a select with a single option in it is a
                    question the user cannot answer wrong but still has to
                    read. Zero addresses means no network at all, which
                    `startHost` reports properly a moment later. */}
                {addresses.length > 1 ? (
                  <Field
                    label={t('devices.hostAddress')}
                    hint={t('devices.hostAddressHint')}
                    htmlFor={addressId}
                  >
                    <select
                      id={addressId}
                      className="input"
                      value={hostAddress}
                      onChange={(e) => setHostAddress(e.target.value)}
                    >
                      <option value="">
                        {t('devices.hostAddressAuto', { address: addresses[0] })}
                      </option>
                      {addresses.map((address) => (
                        <option key={address} value={address}>
                          {address}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}

                <div className="btn-row">
                  <Button
                    variant="primary"
                    icon={<IconQr size={15} />}
                    disabled={scopes.size === 0}
                    onClick={() => void startHost(session)}
                  >
                    {t('devices.showCode')}
                  </Button>
                  <Button variant="ghost" onClick={closeHost}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      ) : null}

      {session?.kind === 'regenerate' ? (
        <Modal
          open
          fullscreen
          title={t('devices.regenerate')}
          onClose={closeHost}
          closeLabel={t('common.close')}
        >
          <div className="form-rows">
            <div className="field__hint field__hint--keep">{session.device.label}</div>
            {hostRevoked ? (
              revokedNotice()
            ) : (
              <PairingQr
                payload={hostPayload}
                status={hostStatus}
                errorMessage={hostError}
                onRegenerate={() => void startHost(session)}
                mode="ongoing"
                lockMode
                otherPlatform={session.device.platform}
              />
            )}
            {/* This panel had no button row of its own — `PairingQr` carries
                the only control it ever needed, and closing is the header's
                job. Taking a code back is neither of those, so the row exists
                now, and only while there is something in it. */}
            {hostCodeAction(session) ? (
              <div className="btn-row">{hostCodeAction(session)}</div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {joining ? (
        <Modal
          open
          fullscreen
          title={t('devices.joinTitle')}
          onClose={closeJoin}
          closeLabel={t('common.close')}
        >
          <div className="form-rows">
            {joinDone ? (
              <>
                <DeviceLinkAnimation
                  status="connected"
                  size="card"
                  leftPlatform={thisPlatform}
                  rightPlatform={otherPlatform}
                />
                <Banner tone="success" title={t('pairing.connected')}>
                  {t('pairing.secureChannelHint')}
                </Banner>
                <div className="btn-row">
                  <Button variant="primary" onClick={closeJoin}>
                    {t('common.done')}
                  </Button>
                </div>
              </>
            ) : joinBusy ? (
              <DeviceLinkAnimation
                status="connecting"
                size="card"
                leftPlatform={thisPlatform}
                rightPlatform={otherPlatform}
              />
            ) : joinError ? (
              // The camera stays off until this is cleared: the code that
              // failed is still on the other device's screen, and a scanner put
              // straight back would decode it again on the next frame. Nothing
              // else is drawn either — the form used to sit above this, which
              // meant the error and its Retry could be the second screenful of
              // a dialog reporting that something went wrong.
              <>
                {/* `.mono`, as `AccountDialog` does with the same class of
                    string: this is whatever `joinPairing` threw, which normally
                    embeds `http://<host>:<port>/…` — one token with nothing to
                    break at. */}
                <Banner tone="danger">
                  <div className="mono">{joinError}</div>
                </Banner>
                <div className="btn-row">
                  <Button variant="primary" onClick={() => setJoinError('')}>
                    {t('common.retry')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* The viewfinder, first and largest — see "The camera goes
                    first" in the module doc. Everything below it is optional
                    and says so by being folded away.

                    No `onCancel`: the dialog's own close button is the one way
                    out, and a second one inside the scanner is a second answer
                    to "how do I get rid of this". `PairingScanner` releases the
                    camera on unmount, which closing the dialog is. */}
                {scopes.size > 0 ? (
                  <PairingScanner onDecoded={onDecoded} />
                ) : (
                  // The one required answer, in the place the camera would
                  // have been rather than as silence below a form. Clearing
                  // every scope also forces the disclosure open (see
                  // `optionsOpen`), so `SyncScopePicker`'s own "choose at least
                  // one" is on screen with this, not behind a fold.
                  <Banner tone="warning">{t('devices.joinNeedsScope')}</Banner>
                )}

                {/* Under the camera now, not above it. It is an instruction for
                    someone already pointing a lens at something, so it reads
                    better as a caption than as a preamble — and `--keep` still
                    exempts it from the narrow-screen hint cull, because on a
                    phone it is the only thing saying that pasting the text is
                    also an option. */}
                <div className="field__hint field__hint--keep">{t('devices.joinHint')}</div>

                {/* Not drawn while the scope set is empty. `optionsOpen` is
                    forced true there, so a toggle would be a button that
                    visibly does nothing — the form has to stay open until the
                    thing only it can fix is fixed. */}
                {scopes.size > 0 ? (
                  <div className="btn-row">
                    <Button
                      variant="ghost"
                      aria-expanded={optionsOpen}
                      onClick={() => setJoinOptions((open) => !open)}
                    >
                      {optionsOpen ? t('devices.joinOptionsHide') : t('devices.joinOptionsShow')}
                    </Button>
                  </div>
                ) : null}

                {optionsOpen ? (
                  shareForm()
                ) : (
                  // What the folded form currently answers, so that leaving it
                  // folded is a decision rather than an omission. An ordinary
                  // hint, so a narrow screen drops it: it is an explanation of
                  // defaults, and the defaults hold whether or not it is read.
                  <div className="field__hint">
                    {t('devices.joinOptionsSummary', {
                      name: label.trim() || platformName(otherPlatform),
                      platform: platformName(otherPlatform),
                      n: scopes.size,
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      ) : null}

      {/* Changing what an existing pairing sends — see `editingScopes`.
          The same `SyncScopePicker` both pairing roles show, so the list a
          person is re-answering is visibly the list they answered before.
          Saving writes only `scopes`: the key, the sync history and the
          address are the pairing itself and have nothing to do with this
          choice. */}
      {editingScopes ? (
        <Modal
          open
          fullscreen
          title={t('devices.editScopes')}
          onClose={() => setEditingScopes(null)}
          closeLabel={t('common.close')}
        >
          <div className="form-rows">
            <div className="field__hint field__hint--keep">{editingScopes.label}</div>
            <SyncScopePicker
              scopes={draftScopes}
              onChange={setDraftScopes}
              accounts={state.accounts}
              jobsCount={state.jobs.length}
              contactsCount={state.contacts.length}
              templatesCount={state.templates.length}
            />
            {/* One-sided, and said out loud rather than left to be discovered
                the next time something arrives that was just switched off. */}
            <Banner tone="info">{t('devices.editScopesHint')}</Banner>
            <div className="btn-row">
              <Button
                variant="primary"
                disabled={draftScopes.size === 0}
                onClick={() => {
                  dispatch({
                    type: 'upsertPairedDevice',
                    device: { ...editingScopes, scopes: [...draftScopes] },
                  })
                  toast.push({ tone: 'success', title: t('devices.editScopes'), detail: editingScopes.label })
                  setEditingScopes(null)
                }}
              >
                {t('common.save')}
              </Button>
              <Button variant="ghost" onClick={() => setEditingScopes(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      <SyncConflictList />
      {confirmElement}
    </>
  )
}
