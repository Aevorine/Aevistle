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
 * **Regenerate** re-runs the ECDH handshake with the same device (same
 * `pairId`, so sync history is untouched) and only exists for `'ongoing'`
 * rows — a `'once'` pairing kept nothing to regenerate. HOST role, the same as
 * pairing itself, and available on the same platforms.
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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Segmented,
  StatusChip,
  useConfirm,
  useFieldId,
  useToast,
} from '../components/ui'
import { IconKey, IconLink, IconMonitor, IconQr, IconSmartphone, IconTrash } from '../components/icons'
import { PairingQr, type PairingHostStatus } from '../components/PairingQr'
import { PairingScanner } from '../components/PairingScanner'
import { SyncScopePicker } from '../components/SyncScopePicker'
import { DeviceLinkAnimation } from '../components/DeviceLinkAnimation'
import { SyncConflictList } from '../components/SyncConflictList'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import type { PairedDevice, PairedDevicePlatform } from '../core/pairedDevices'
import { joinPairing, type OngoingPairingSecret, type PairingPayload } from '../core/pairing'
import { SYNC_SERVER_PORT, type SyncListenerError } from '../core/syncLoop'
import { SYNC_SCOPE_KEYS, type SyncScopeKey } from '../core/syncScope'
import { newId } from '../core/types'

const LISTENER_ERROR_KEYS: Record<SyncListenerError, TranslationKey> = {
  noNetwork: 'devices.syncNoNetwork',
  portInUse: 'devices.syncPortInUse',
  blocked: 'devices.syncBlocked',
  failed: 'devices.syncListenFailed',
}

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

  const [joining, setJoining] = useState(false)
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinDone, setJoinDone] = useState(false)
  const [joinError, setJoinError] = useState('')

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
    void loadAddresses()
  }

  const closeHost = () => {
    void bridge?.stopPairingHost?.()
    setSession(null)
    setHostStarted(false)
  }

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
  }

  const closeJoin = () => {
    setJoining(false)
    setJoinBusy(false)
    setJoinDone(false)
    setJoinError('')
  }

  // --- rows -----------------------------------------------------------------

  const revoke = async (device: PairedDevice) => {
    const ok = await confirm({
      title: t('devices.revoke'),
      body: t('devices.revokeConfirm'),
      confirmLabel: t('devices.revoke'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    await revokePairedDevice(device.id)
    toast.push({ tone: 'info', title: t('devices.revoke'), detail: device.label })
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
        onChange={setScopes}
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
            state.pairedDevices.map((device) => (
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
                    second line. */}
                <div className="log__actions">
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
                  {/* `IconButton`, not a `Button` holding an icon: every icon
                      in `icons.tsx` is `aria-hidden`, so a text button with
                      only an icon in it has no accessible name at all. Same
                      control as the delete on every other `.log` row. */}
                  <IconButton label={t('devices.revoke')} onClick={() => void revoke(device)}>
                    <IconTrash size={16} />
                  </IconButton>
                </div>
              </div>
            ))
          )}

          {state.pairedDevices.some((d) => d.mode === 'ongoing') ? (
            <Banner tone="info">{t('devices.ongoingHint')}</Banner>
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
                <PairingQr
                  payload={hostPayload}
                  status={hostStatus}
                  errorMessage={hostError}
                  onRegenerate={() => void startHost(session)}
                  mode="ongoing"
                  lockMode
                  otherPlatform={otherPlatform}
                />
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
            <PairingQr
              payload={hostPayload}
              status={hostStatus}
              errorMessage={hostError}
              onRegenerate={() => void startHost(session)}
              mode="ongoing"
              lockMode
              otherPlatform={session.device.platform}
            />
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
            <div className="field__hint field__hint--keep">{t('devices.joinHint')}</div>
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
            ) : (
              <>
                {shareForm()}
                {joinBusy ? (
                  <DeviceLinkAnimation
                    status="connecting"
                    size="card"
                    leftPlatform={thisPlatform}
                    rightPlatform={otherPlatform}
                  />
                ) : joinError ? (
                  // The camera stays off until this is cleared: the code that
                  // failed is still on the other device's screen, and a scanner
                  // put straight back would decode it again on the next frame.
                  <>
                    {/* `.mono`, as `AccountDialog` does with the same class of
                        string: this is whatever `joinPairing` threw, which
                        normally embeds `http://<host>:<port>/…` — one token
                        with nothing to break at. */}
                    <Banner tone="danger">
                      <div className="mono">{joinError}</div>
                    </Banner>
                    <div className="btn-row">
                      <Button variant="primary" onClick={() => setJoinError('')}>
                        {t('common.retry')}
                      </Button>
                    </div>
                  </>
                ) : scopes.size > 0 ? (
                  // No `onCancel`: the dialog's own close button is the one way
                  // out now, and a second one inside the scanner is a second
                  // answer to "how do I get rid of this". `PairingScanner`
                  // releases the camera on unmount, which closing the dialog is.
                  <PairingScanner onDecoded={onDecoded} />
                ) : (
                  // Nothing. `SyncScopePicker` already says "choose at least
                  // one" in place, which is both the reason the camera is off
                  // and the thing to do about it.
                  null
                )}
              </>
            )}
          </div>
        </Modal>
      ) : null}

      <SyncConflictList />
      {confirmElement}
    </>
  )
}
