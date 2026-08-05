/**
 * The JOINER side of reading a pairing code: point a camera at it, or paste
 * the text by hand.
 *
 * Deliberately dumb, the same posture `PairingQr.tsx` takes on the HOST side:
 * this component's whole job is "hand back a decoded `PairingPayload`, or say
 * why it could not." What happens next — calling `joinPairing`
 * (`core/pairing.ts`), choosing what to sync, storing the result — belongs to
 * a screen that does not exist in this codebase yet. `PairingQr.tsx` itself
 * spent a chunk in exactly that state before `DevicesCard.tsx` arrived to
 * wire it in; this is the JOINER half of the same pairing, one chunk behind
 * for the same reason.
 *
 * Camera first, paste always reachable: a phone without a rear camera, a
 * desktop without a webcam, and someone who would simply rather type the
 * `aevistle-pair:…` text read off another screen all land on the same
 * decoder (`core/qrDecode.ts`) — a QR code is just that text with a picture
 * around it, so offering both costs nothing beyond a toggle. `getUserMedia`
 * is called directly, the same plain Web API any page uses; nothing here
 * goes through a Capacitor plugin (see `bridge-android.ts`'s note on why).
 */

import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Segmented } from './ui'
import { useI18n } from '../i18n'
import { decodeQr } from '../core/qrDecode'
import { decodePairingText, type PairingPayload } from '../core/pairing'

export interface PairingScannerProps {
  /** Fires once, with a payload that parsed and has not expired — the caller still has to act on it. */
  onDecoded: (payload: PairingPayload) => void
  onCancel?: () => void
}

type ScanMode = 'scan' | 'paste'

function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

export function PairingScanner({ onDecoded, onCancel }: PairingScannerProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<ScanMode>(() => (cameraAvailable() ? 'scan' : 'paste'))
  const [cameraDenied, setCameraDenied] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  /**
   * One effect owns the whole camera lifetime: request the stream, read
   * frames off it in a loop, and tear both down the moment the mode changes
   * away from `'scan'` or this component unmounts. `cancelled`/`done` guard
   * against the two ways that teardown can lose a race — the permission
   * prompt is still open when the user switches to paste, or a frame decodes
   * successfully in the instant after `onDecoded` was already called for a
   * previous one.
   */
  useEffect(() => {
    if (mode !== 'scan') return
    let cancelled = false
    let done = false
    let stream: MediaStream | null = null
    let frame = 0

    const stop = () => {
      if (frame) cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
    }

    const tick = () => {
      if (cancelled || done) return
      const video = videoRef.current
      if (video && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        if (!canvasRef.current) canvasRef.current = document.createElement('canvas')
        const canvas = canvasRef.current
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const text = decodeQr(pixels.data, canvas.width, canvas.height)
          if (text) {
            const payload = decodePairingText(text)
            if (payload) {
              done = true
              stop()
              onDecoded(payload)
              return
            }
            // A real QR code, just not one of ours (or one this app version
            // does not recognise) — say so, but keep scanning: the code
            // that *is* right might be the very next frame.
            setError(t('pairing.invalidCode'))
          }
        }
      }
      frame = requestAnimationFrame(tick)
    }

    setError('')
    setCameraDenied(false)
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop())
          return
        }
        stream = s
        const video = videoRef.current
        if (video) {
          video.srcObject = s
          void video.play().catch(() => {})
        }
        frame = requestAnimationFrame(tick)
      })
      .catch(() => {
        if (cancelled) return
        setCameraDenied(true)
        setMode('paste')
      })

    return () => {
      cancelled = true
      stop()
    }
  }, [mode, onDecoded, t])

  const submitPaste = () => {
    const payload = decodePairingText(pasteText.trim())
    if (!payload) {
      setError(t('pairing.invalidCode'))
      return
    }
    setError('')
    onDecoded(payload)
  }

  return (
    <div className="pairscan">
      {cameraAvailable() ? (
        <Segmented
          value={mode}
          onChange={(v) => {
            setError('')
            setMode(v)
          }}
          ariaLabel={t('pairing.scanQr')}
          options={[
            { value: 'scan', label: t('pairing.scanQr') },
            { value: 'paste', label: t('pairing.pasteCodeInstead') },
          ]}
        />
      ) : null}

      {mode === 'scan' ? (
        <div className="pairscan__frame">
          {/* No visible controls of its own — decoding runs silently off
              whatever frame is on screen, the same "just point it" feel as
              any other QR scanner. */}
          <video ref={videoRef} className="pairscan__video" muted playsInline autoPlay aria-hidden="true" />
        </div>
      ) : (
        <div className="form-rows">
          <textarea
            className="textarea textarea--mono"
            rows={3}
            value={pasteText}
            onChange={(e) => {
              setError('')
              setPasteText(e.target.value)
            }}
            placeholder="aevistle-pair:…"
            aria-label={t('pairing.pasteCodeInstead')}
          />
          <div className="btn-row">
            <Button variant="primary" disabled={!pasteText.trim()} onClick={submitPaste}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}

      {cameraDenied ? (
        <Banner tone="warning" title={t('pairing.cameraDenied')}>
          {t('pairing.cameraDeniedHint')}
        </Banner>
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {onCancel ? (
        <div className="btn-row">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
