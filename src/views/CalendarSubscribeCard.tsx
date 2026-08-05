/**
 * The Settings card for the calendar subscribe address.
 *
 * A sibling of `ControlCard`, not a section inside it: switching this on
 * publishes the working calendar's holidays and make-up days on the same
 * loopback port `ControlCard` uses, and the two are independent decisions
 * (see `Settings.calendarSubscribeEnabled`). Folding them into one switch
 * would mean someone who only wants their calendar app to see the working
 * calendar has also, without a separate choice, opened the door to a program
 * creating reminders.
 *
 * Reports the port the same way `ControlCard` does — by reading back the
 * endpoint file the server wrote, not by trusting the settings just sent.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, CardHeader, Switch, useToast } from '../components/ui'
import { IconCalendar } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import type { ControlEndpoint } from '../core/control'

export function CalendarSubscribeCard() {
  const { state, bridge, dispatch } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const [endpoint, setEndpoint] = useState<ControlEndpoint | null>(null)

  const enabled = state.settings.calendarSubscribeEnabled === true
  const controlEnabled = state.settings.controlEnabled === true
  const controlAllowSending = state.settings.controlAllowSending === true
  const supported = typeof bridge?.applyControl === 'function'

  const refresh = useCallback(async () => {
    if (!bridge?.applyControl) return
    const next = await bridge
      .applyControl({ enabled: controlEnabled, allowSending: controlAllowSending, calendarSubscribeEnabled: enabled })
      .catch(() => null)
    setEndpoint(next)
  }, [bridge, controlEnabled, controlAllowSending, enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!supported) return null

  const url = endpoint ? `http://127.0.0.1:${endpoint.port}/calendar.ics` : ''

  return (
    <Card>
      <CardHeader title={t('cal.subscribe.toggle')} hint={t('cal.subscribe.hint')} />
      <div className="card__body">
        <Switch
          checked={enabled}
          onChange={(v) => dispatch({ type: 'patchSettings', patch: { calendarSubscribeEnabled: v } })}
          title={t('cal.subscribe.toggle')}
          description={t('cal.subscribe.hint')}
        />

        {enabled ? (
          <div>
            <div className="card__title">{t('cal.subscribe.url')}</div>
            <div className="btn-row" style={{ marginTop: 'var(--sp-2)' }}>
              <code className="yearlist__url">{url || t('control.stopped')}</code>
              {url ? (
                <Button
                  variant="ghost"
                  icon={<IconCalendar size={15} />}
                  onClick={() => {
                    void navigator.clipboard.writeText(url)
                    toast.push({ tone: 'success', title: t('control.copied') })
                  }}
                >
                  {t('common.copy')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="field__hint">{t('cal.subscribe.limit')}</div>
        <div className="field__hint">{t('cal.subscribe.androidUnsupported')}</div>
      </div>
    </Card>
  )
}
