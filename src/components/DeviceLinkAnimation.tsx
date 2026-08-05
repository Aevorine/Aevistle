/**
 * Two devices and a line between them — the one picture this app is allowed
 * to draw for "syncing," because every other picture lies about what is
 * happening. No cloud: nothing here is stored anywhere but these two
 * machines. No upward arrow: nothing is being *sent up* to anything. No
 * server glyph, spinning or otherwise: there is no third machine in this
 * story, ever, by design — see `core/pairing.ts`'s module doc. A pulse
 * travelling straight from one glyph to the other is the only shape that
 * does not imply a piece of infrastructure that does not exist.
 *
 * Pure inline SVG/CSS, the same hand-drawn approach as `components/icons.tsx`
 * — the device glyphs *are* `IconMonitor`/`IconSmartphone` from there, just
 * laid out further apart with a line drawn between them, not a new icon set.
 *
 * `size` exists so every sync-touching screen reaches for this one component
 * instead of inventing its own illustration: `inline` sits beside a line of
 * status text (`PairingQr.tsx`), `card` fills a card header
 * (`DevicesCard.tsx`), `full` is sized for a screen of its own if one ever
 * needs it.
 */

import type { ReactNode } from 'react'
import { IconMonitor, IconSmartphone } from './icons'
import { useI18n } from '../i18n'
import type { PairedDevicePlatform } from '../core/pairedDevices'

export type DeviceLinkStatus = 'connecting' | 'connected' | 'error'
export type DeviceLinkSize = 'inline' | 'card' | 'full'

export interface DeviceLinkAnimationProps {
  status: DeviceLinkStatus
  size?: DeviceLinkSize
  /** The device this screen is running on. Defaults to `'windows'`: every call site that knows a status here is either the HOST (always desktop, see `core/pairing.ts`) or a settings screen listing devices this desktop already paired. */
  leftPlatform?: PairedDevicePlatform
  /** The device on the other end. Left unset before it is known — the moment before a code is scanned, or in the settings header when the list is mixed — and drawn as a generic outline rather than guessed at. */
  rightPlatform?: PairedDevicePlatform
}

const GLYPH_SIZE: Record<DeviceLinkSize, number> = { inline: 16, card: 26, full: 40 }

function DeviceGlyph({ platform, size }: { platform?: PairedDevicePlatform; size: number }) {
  if (platform === 'android') return <IconSmartphone size={size} />
  if (platform === 'windows') return <IconMonitor size={size} />
  // Unknown yet — a plain rounded rectangle rather than guessing a shape,
  // matching the stroke weight and grid the rest of `icons.tsx` uses.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeDasharray="3 2.5"
      />
    </svg>
  )
}

export function DeviceLinkAnimation({
  status,
  size = 'card',
  leftPlatform = 'windows',
  rightPlatform,
}: DeviceLinkAnimationProps) {
  const { t } = useI18n()
  const glyphSize = GLYPH_SIZE[size]
  const statusKey = status === 'connecting' ? 'connecting' : status === 'connected' ? 'connected' : 'broken'

  let line: ReactNode
  if (status === 'error') {
    line = (
      <>
        <span className="devlink__seg" />
        <svg className="devlink__break" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M6 2 4 8h4l-2 6 6-8H8l2-6Z" />
        </svg>
        <span className="devlink__seg" />
      </>
    )
  } else {
    line = (
      <span className="devlink__seg devlink__seg--full">
        {status === 'connecting' ? <span className="devlink__pulse" /> : null}
      </span>
    )
  }

  return (
    <div
      className={`devlink devlink--${size} devlink--${status}`}
      role="img"
      aria-label={t('pairing.linkVisual.alt')}
    >
      <span className="devlink__glyph">
        <DeviceGlyph platform={leftPlatform} size={glyphSize} />
      </span>
      <span className="devlink__line">{line}</span>
      <span className="devlink__glyph">
        <DeviceGlyph platform={rightPlatform} size={glyphSize} />
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {t(`pairing.linkVisual.${statusKey}`)}
      </span>
    </div>
  )
}
