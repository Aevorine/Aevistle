/**
 * The Settings card for the control interface.
 *
 * Two switches rather than one, and the second is not a sub-option of the
 * first for cosmetic reasons: "let a program read my schedule" and "let a
 * program send mail as me" are different decisions with different blast
 * radii, and collapsing them into a single "enable API" toggle is how an
 * interface talks someone into the second while they were agreeing to the
 * first.
 *
 * The card reports the port by reading back the file the server wrote, rather
 * than by trusting the call that started it. If the two ever disagree, what a
 * caller will actually find is the file.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, CardHeader, Switch, useToast } from '../components/ui'
import { IconFolder, IconShield } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import type { ControlEndpoint } from '../core/control'

export function ControlCard() {
  const { state, bridge, dispatch } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const [endpoint, setEndpoint] = useState<ControlEndpoint | null>(null)
  const [serverPath, setServerPath] = useState('')

  const enabled = state.settings.controlEnabled === true
  const allowSending = state.settings.controlAllowSending === true
  const calendarSubscribeEnabled = state.settings.calendarSubscribeEnabled === true
  const supported = typeof bridge?.applyControl === 'function'

  const refresh = useCallback(async () => {
    if (!bridge?.applyControl) return
    // Re-applying the settings we already have is also how the card asks
    // "where did you end up?" — the call is idempotent and returns the
    // endpoint file's contents.
    const next = await bridge
      .applyControl({ enabled, allowSending, calendarSubscribeEnabled })
      .catch(() => null)
    setEndpoint(next)
  }, [bridge, enabled, allowSending, calendarSubscribeEnabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void bridge
      ?.appInfo()
      .then((info) => setServerPath(info.mcpServerPath ?? ''))
      .catch(() => setServerPath(''))
  }, [bridge])

  if (!supported) return null

  /**
   * One command the user can paste. `claude mcp add` is how Claude Code takes
   * a stdio server; the server finds the port and token by reading
   * `~/.aevistle/endpoint.json` itself, so the command does not have to carry
   * a token that is regenerated on every launch.
   */
  const setupCommand = serverPath
    ? `claude mcp add aevistle -- node ${JSON.stringify(serverPath)}`
    : ''

  return (
    <Card>
      <CardHeader title={t('control.title')} hint={t('control.hint')} />

      {/* Same body wrapper as every other settings card, so this one lays out
          on the same grid instead of on its own ad-hoc stack. */}
      <div className="card__body">
        <Switch
          checked={enabled}
          onChange={(v) => {
            dispatch({
              type: 'patchSettings',
              // Turning the doorway off turns sending off with it. Leaving it
              // armed means flipping the first switch back on later silently
              // restores a permission the user cannot see from here.
              patch: v ? { controlEnabled: true } : { controlEnabled: false, controlAllowSending: false },
            })
          }}
          title={t('control.enable')}
          description={t('control.enableHint')}
        />

        <Switch
          checked={allowSending}
          disabled={!enabled}
          onChange={(v) => dispatch({ type: 'patchSettings', patch: { controlAllowSending: v } })}
          title={t('control.allowSending')}
          description={t('control.allowSendingHint')}
        />

        <div
          className="log__detail"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}
        >
          <IconShield size={15} />
          {endpoint ? t('control.running', { port: endpoint.port }) : t('control.stopped')}
        </div>

        <div>
          <div className="card__title">{t('control.dropTitle')}</div>
          <div className="log__detail">{t('control.dropHint')}</div>
          <div className="btn-row" style={{ marginTop: 'var(--sp-3)' }}>
            <Button
              icon={<IconFolder size={15} />}
              onClick={() => void bridge?.openDataFolder?.()}
            >
              {t('control.openFolder')}
            </Button>
            <Button
              disabled={!setupCommand}
              onClick={() => {
                void navigator.clipboard.writeText(setupCommand)
                toast.push({ tone: 'success', title: t('control.copied') })
              }}
            >
              {t('control.copyConfig')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}
