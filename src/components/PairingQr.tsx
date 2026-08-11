/**
 * The HOST side of LAN pairing: a QR code, a countdown ring, and nothing else
 * a camera needs to know about. `encodeQr`/`qrPath` are the same from-scratch
 * encoder `CodesView.tsx` already uses for sign-in links — see `core/qr.ts`.
 *
 * Deliberately dumb. This component owns no session state: it is handed a
 * payload and a status by whatever screen started the session (a later
 * feature — the settings surface this hangs off of is outside this chunk),
 * and it draws whatever it is told. The one thing it decides on its own is
 * when the ring has run out, because that has to update every second whether
 * or not anything else does.
 */

import { useEffect, useMemo, useState } from 'react'
import { Banner, Button, Field, Segmented, useToast } from './ui'
import { IconRefresh } from './icons'
import { DeviceLinkAnimation, type DeviceLinkStatus } from './DeviceLinkAnimation'
import { useI18n } from '../i18n'
import { encodeQr, qrPath } from '../core/sync/qr'
import { copyText } from '../core/platform/clipboard'
import {
  encodePairingText,
  isExpired,
  msRemaining,
  PAIRING_SESSION_MS,
  type PairingPayload,
  type PairMode,
} from '../core/sync/pairing'
import type { PairedDevicePlatform } from '../core/sync/pairedDevices'

export type PairingHostStatus = 'listening' | 'connected' | 'expired' | 'error'

export interface PairingQrProps {
  payload: PairingPayload | null
  status: PairingHostStatus
  errorMessage?: string
  /** Draw a fresh code — the only way forward once the ring runs out. */
  onRegenerate: () => void
  /**
   * Which kind of pairing the *next* code drawn will offer — see
   * `PairMode`. Not retroactive: changing it does nothing to a code already
   * on screen, since the mode is baked into that code's payload the moment
   * it is drawn (`buildHostPayload`). The caller is expected to call
   * `onRegenerate` once the user picks, the same button that already exists
   * for "the old code expired, draw a new one".
   */
  mode?: PairMode
  onModeChange?: (mode: PairMode) => void
  /** Hide the picker — for a caller that already knows the mode is fixed, like `devices.regenerate`, which only ever means 'ongoing'. */
  lockMode?: boolean
  /** The device on the other end, when the caller already knows it — `devices.regenerate` is re-running a handshake with a device already in the paired list, so its platform is not a guess. Left unset draws a generic outline until a device actually connects. */
  otherPlatform?: PairedDevicePlatform
}

const RING_RADIUS = 15
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function PairingQr({
  payload,
  status,
  errorMessage,
  onRegenerate,
  mode,
  onModeChange,
  lockMode,
  otherPlatform,
}: PairingQrProps) {
  const { t } = useI18n()
  const toast = useToast()
  const [now, setNow] = useState(() => Date.now())
  /**
   * Whether the code is also shown as text, for a device that cannot scan it.
   *
   * It had to be added, not merely surfaced: `PairingScanner` has offered
   * "paste code instead" since it was written, `pairing.cameraDeniedHint` tells
   * a user whose camera was refused to paste "the code shown on the other
   * device", and `devices.joinHint` says to paste "the text underneath it" —
   * and this component drew the QR and nothing else, so there was no text
   * underneath it and never had been. Every manual route out of a missing or
   * denied camera pointed at something that did not exist.
   *
   * Folded by default because scanning is the path that works, and a 200-odd
   * character blob sitting under the code would suggest otherwise.
   */
  const [showText, setShowText] = useState(false)

  useEffect(() => {
    if (!payload || status !== 'listening') return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [payload, status])

  const remaining = payload ? msRemaining(payload, now) : 0
  const expired = status === 'expired' || (payload ? isExpired(payload, now) : false)
  const fraction = payload ? Math.max(0, Math.min(1, remaining / PAIRING_SESSION_MS)) : 0
  const seconds = Math.ceil(remaining / 1000)

  const codeText = useMemo(
    () => (payload && !expired ? encodePairingText(payload) : ''),
    [payload, expired],
  )

  const qr = useMemo(() => (codeText ? encodeQr(codeText) : null), [codeText])

  // `expired` folds into 'error': the picture a stopped clock draws is the
  // same broken line a refused connection does — either way, nothing is
  // still trying and a fresh code is the only way forward.
  const linkStatus: DeviceLinkStatus =
    status === 'connected' ? 'connected' : status === 'error' || expired ? 'error' : 'connecting'

  return (
    <div className="pairqr">
      <p className="pairqr__hint">{t('pairing.scanPrompt')}</p>

      {mode && onModeChange && !lockMode ? (
        <Field label={t('sync.mode.title')} hint={mode === 'once' ? t('sync.mode.onceHint') : t('sync.mode.ongoingHint')}>
          <Segmented
            value={mode}
            onChange={onModeChange}
            ariaLabel={t('sync.mode.title')}
            options={[
              { value: 'once', label: t('sync.mode.once') },
              { value: 'ongoing', label: t('sync.mode.ongoing') },
            ]}
          />
        </Field>
      ) : null}

      <div className="pairqr__frame">
        {qr && status !== 'connected' ? (
          <svg
            className="pairqr__code"
            viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
            shapeRendering="crispEdges"
            role="img"
            aria-label={t('pairing.title')}
          >
            {/* Fixed white plate in both themes — a camera reading an inverted
                code is a coin flip, the same reasoning as `CodesView.tsx`. */}
            <rect width={qr.size + 8} height={qr.size + 8} fill="#fff" />
            <path d={qrPath(qr)} fill="#000" />
          </svg>
        ) : (
          <div className="pairqr__placeholder" aria-hidden="true" />
        )}

        {status === 'listening' && payload ? (
          <svg className="pairqr__ring" viewBox="0 0 32 32" aria-hidden="true">
            <circle className="pairqr__ringTrack" cx="16" cy="16" r={RING_RADIUS} />
            <circle
              className="pairqr__ringValue"
              cx="16"
              cy="16"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
            />
          </svg>
        ) : null}
      </div>

      {/* The same code, in the form a device with no working camera can take.
          `PairingScanner`'s paste box wants exactly this string, so it is
          rendered verbatim rather than prettied up — and read-only rather than
          disabled, because a disabled textarea is not selectable, which is the
          whole point of it on a phone that has to hand it to a keyboard.

          Only while the code is live. A code that has expired or been spent is
          not something to leave copyable on screen, for the same reason
          `revokeCode` in `DevicesCard.tsx` clears the payload outright rather
          than merely hiding the QR. */}
      {codeText && status === 'listening' ? (
        <div className="pairqr__manual">
          <Button variant="ghost" aria-expanded={showText} onClick={() => setShowText((open) => !open)}>
            {showText ? t('pairing.hideCodeText') : t('pairing.showCodeText')}
          </Button>
          {showText ? (
            <div className="form-rows">
              <textarea
                className="textarea textarea--mono"
                rows={3}
                readOnly
                value={codeText}
                aria-label={t('pairing.showCodeText')}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="field__hint field__hint--keep">{t('pairing.codeTextHint')}</div>
              <div className="btn-row">
                <Button
                  onClick={() => {
                    void copyText(codeText).then((ok) => {
                      // Reporting the outcome rather than announcing success
                      // unconditionally: this used to say "copied" whether or
                      // not anything reached the clipboard, which on Android
                      // was every single time.
                      toast.push(
                        ok
                          ? { tone: 'success', title: t('toast.copied') }
                          : { tone: 'error', title: t('inbox.copyFailed') },
                      )
                    })
                  }}
                >
                  {t('common.copy')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <DeviceLinkAnimation status={linkStatus} size="inline" rightPlatform={otherPlatform} />

      <div className="pairqr__status" role="status" aria-live="polite">
        {status === 'listening' && !expired ? (
          <>
            <p className="pairqr__statusLine">{t('pairing.waitingForDevice')}</p>
            <p className="pairqr__countdown">{t('pairing.expiresIn', { n: Math.max(0, seconds) })}</p>
          </>
        ) : null}
        {status === 'connected' ? (
          <>
            <p className="pairqr__statusLine pairqr__statusLine--ok">{t('pairing.connected')}</p>
            <p className="pairqr__countdown">{t('pairing.secureChannel')}</p>
          </>
        ) : null}
        {expired && status !== 'connected' ? <p className="pairqr__statusLine">{t('pairing.expired')}</p> : null}
      </div>

      {/* `.mono`: this is the raw rejection from `bridge.startPairingHost` — an
          Electron/Node error carrying a path or `listen EADDRINUSE …`, one
          unbreakable token that otherwise ran out of the banner. Same
          treatment `AccountDialog` gives the same class of string. */}
      {errorMessage ? (
        <Banner tone="danger">
          <div className="mono">{errorMessage}</div>
        </Banner>
      ) : null}

      {status === 'connected' ? (
        <Banner tone="success">{t('pairing.secureChannelHint')}</Banner>
      ) : expired ? (
        <Banner tone="warning">{t('pairing.codeExpired')}</Banner>
      ) : (
        <>
          <Banner tone="info">{t('pairing.networkRequired')}</Banner>
          <p className="pairqr__note">{t('pairing.oneConnectionOnly')}</p>
        </>
      )}

      {(expired || status === 'error') && status !== 'connected' ? (
        <Button variant="primary" icon={<IconRefresh size={16} />} onClick={onRegenerate}>
          {t('pairing.regenerate')}
        </Button>
      ) : null}
    </div>
  )
}
