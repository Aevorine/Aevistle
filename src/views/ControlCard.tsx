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
 *
 * ## What a phone gets instead
 *
 * This used to `return null` when `bridge.applyControl` was absent, which is
 * every Android build — `applyControl` is implemented only in
 * `core/bridge-desktop.ts`, and neither `core/bridge-android.ts` nor
 * `core/bridge-web.ts` has it. But this card is also a `SettingsSection` (see
 * `views/SettingsView.tsx`, `id="set-control"`), and on a phone that wrapper
 * draws a tappable row regardless and mounts the children in a full-height
 * dialog — so "控制接口" was a row that opened a title bar, a close button and
 * nothing else. A section that renders nothing is worse than one that is
 * missing: the row promises something is behind it. `views/CalendarSubscribeCard.tsx`
 * had exactly this bug and exactly this fix; its header comment is the sibling
 * of this paragraph.
 *
 * What the desktop is really offering here is a process that holds a loopback
 * HTTP port open for as long as you are working, which is not a thing an
 * Android app is permitted to be: the OS stops the process, and a port this
 * app advertised would answer until the moment it was swiped away. So the
 * unsupported branch renders the explanation and *not* the two switches — a
 * switch whose value nothing reads is worse than no switch, because it looks
 * like it took effect.
 *
 * The honest nearest thing is the other half of the same job. The control
 * interface exists so a program can create reminders; a phone cannot host that
 * program, but it can be the device the reminders ring on. Pairing and sync are
 * genuinely implemented on Android (`startPairingHost`, `applySyncListener`,
 * `syncRequest` in `core/bridge-android.ts`, over `LanServer.java`'s socket), and
 * `syncJobs` arms the arriving jobs as real alarms — so a schedule a program
 * created on the paired computer is already on its way here. That is pointed at
 * in prose rather than with a button: the destination is another
 * `SettingsSection` (`set-devices`), whose open/closed state is private to that
 * wrapper, so a "take me there" button could only be wired by lifting state out
 * of `components/SettingsSection.tsx` — a larger change than a cross-reference
 * is worth, and a button that scrolled to an anchor would do nothing at all
 * inside this dialog.
 */

import { useCallback, useEffect, useState } from 'react'
import { Banner, Button, Card, CardHeader, Switch, useToast } from '../components/ui'
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

  /**
   * No loopback port on this platform, so the card is the reason and the route
   * that does work.
   *
   * Deliberately still a full section rather than a hidden row — see this
   * file's header comment. Someone who set the control interface up on their
   * computer and then went looking for it on their phone has to find out here
   * that hosting it is desktop-only, and where the reminders it creates will
   * turn up instead; finding an empty dialog tells them neither.
   */
  if (!supported) {
    return (
      <Card>
        <CardHeader title={t('control.title')} hint={t('control.hint')} />
        <div className="card__body form-rows">
          <Banner tone="info">{t('control.mobileNoServer')}</Banner>
          <div className="field__hint field__hint--keep">{t('control.mobilePaired')}</div>
        </div>
      </Card>
    )
  }

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
