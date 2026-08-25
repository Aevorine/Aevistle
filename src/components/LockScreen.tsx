/**
 * The screen the app lock shows instead of the shell.
 *
 * *Instead of*, not on top of: `App.tsx` returns this before the shell
 * renders, so nothing behind it exists to be read out of the DOM, screenshot
 * by a shoulder-surfer, or reached by a stray focus order. The verify runs
 * against the stored chain from `core/security/pinHash.ts` — ~60k hash
 * rounds, so each wrong guess costs real work — and the input clears on a
 * miss, because a wrong PIN left standing invites "fix one digit" guessing.
 *
 * What this is not, said plainly where the code lives: it is a screen lock.
 * The data on disk is not encrypted by it, and the Settings card that
 * enables it tells the user the same thing in their own language.
 */

import { useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './ui'
import { hashPin, timingSafeEqualHex } from '../core/security/pinHash'
import type { AppLockSettings } from '../core/types'
import brandMark from '../assets/brand.png'

export function LockScreen({ lock, onUnlock }: { lock: AppLockSettings; onUnlock: () => void }) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (busy || pin.length === 0) return
    setBusy(true)
    // One frame between press and hash: the chain briefly holds the thread,
    // and the button's pressed state should paint before it does.
    window.setTimeout(() => {
      const ok = timingSafeEqualHex(hashPin(pin, lock.salt, lock.iterations), lock.hash)
      setBusy(false)
      setPin('')
      if (ok) onUnlock()
      else setError(true)
    }, 16)
  }

  return (
    <div className="applock" role="dialog" aria-label={t('applock.locked')}>
      <div className="applock__card">
        <img className="applock__mark" src={brandMark} alt="" width={44} height={44} draggable={false} />
        <div className="applock__title">{t('applock.locked')}</div>
        <input
          className="input applock__input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          aria-label={t('applock.pinLabel')}
          placeholder={t('applock.pinLabel')}
          value={pin}
          onChange={(e) => {
            setPin(e.target.value)
            setError(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {/* Reserved height, so the card does not jump on the first miss. */}
        <div className="applock__error" role="alert">
          {error ? t('applock.wrongPin') : ''}
        </div>
        <Button variant="primary" size="lg" disabled={busy || pin.length === 0} onClick={submit}>
          {t('applock.unlock')}
        </Button>
      </div>
    </div>
  )
}
