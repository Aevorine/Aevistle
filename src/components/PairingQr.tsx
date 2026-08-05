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
import { Banner, Button, Field, Segmented } from './ui'
import { IconRefresh } from './icons'
import { DeviceLinkAnimation, type DeviceLinkStatus } from './DeviceLinkAnimation'
import { useI18n } from '../i18n'
import { encodeQr, qrPath } from '../core/qr'
import {
  encodePairingText,
  isExpired,
  msRemaining,
  PAIRING_SESSION_MS,
  type PairingPayload,
  type PairMode,
} from '../core/pairing'
import type { PairedDevicePlatform } from '../core/pairedDevices'

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
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!payload || status !== 'listening') return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [payload, status])

  const remaining = payload ? msRemaining(payload, now) : 0
  const expired = status === 'expired' || (payload ? isExpired(payload, now) : false)
  const fraction = payload ? Math.max(0, Math.min(1, remaining / PAIRING_SESSION_MS)) : 0
  const seconds = Math.ceil(remaining / 1000)

  const qr = useMemo(() => {
    if (!payload || expired) return null
    return encodeQr(encodePairingText(payload))
  }, [payload, expired])

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
