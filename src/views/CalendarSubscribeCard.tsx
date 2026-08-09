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
 *
 * ## What a phone gets instead
 *
 * This used to `return null` when `bridge.applyControl` was absent, which is
 * every Android build. It is also a `SettingsSection`, so on a phone the row was
 * still drawn, still tappable, and opened a dialog with nothing whatsoever in it
 * — the "why is publishing the working calendar empty?" report. A section that
 * renders nothing is worse than one that is missing: the row promises something
 * is behind it.
 *
 * A phone cannot hold a listening socket open for the weeks a calendar
 * subscription implies — the OS stops the process, and pretending otherwise
 * would publish an address that works until the app is swiped away. So the
 * honest offer is the other half of the same job: the same events, written once
 * to a file the device's own calendar app can import. `core/ics.ts` builds it
 * from the same `calendarToEvents` the desktop's `/calendar.ics` endpoint and
 * the Calendar screen's export both use, so all three agree by construction.
 */

import { useCallback, useEffect, useState } from 'react'
import { Banner, Button, Card, CardHeader, Switch, useToast } from '../components/ui'
import { IconCalendar, IconDownload } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import type { ControlEndpoint } from '../core/control'
import { buildIcs, calendarToEvents } from '../core/ics'
import { statutoryNames } from '../core/cnHolidays'
import { holidayNameFor } from '../core/holidayPresets'
import { saveGeneratedFile } from '../core/download'
import { copyText } from '../core/clipboard'
import { DEFAULT_WORK_CALENDAR } from '../core/workCalendar'

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

  /**
   * The calendar as a file.
   *
   * Named without `nameFor`'s preset argument, unlike the Calendar screen's own
   * export: the preset id it passes is remembered in `localStorage` by that
   * screen and is not part of the saved calendar, so reading it here would
   * couple this card to another screen's private key. The statutory table is the
   * part that actually carries names people recognise, and
   * `holidayNameFor` falls back to matching the date against every bundled
   * preset when it is given no id — so a date with a well-known name still gets
   * it, and one without falls back to "day off", exactly as the desktop
   * endpoint does.
   */
  const exportIcs = async () => {
    const calendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR
    const statutory = statutoryNames()
    const events = calendarToEvents(calendar, {
      nameFor: (iso) => holidayNameFor(iso, { statutory }),
      holidayLabel: t('workcal.dayOff'),
      workdayLabel: t('workcal.makeupDays'),
    })
    if (events.length === 0) {
      toast.push({ tone: 'info', title: t('workcal.none') })
      return
    }

    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`
    const { outcome, unsupported } = await saveGeneratedFile(
      buildIcs(events, { name: t('workcal.title') }),
      `aevistle-working-calendar-${stamp}.ics`,
      'text/calendar',
    )

    // The same three-way report every other export in this app makes. Waiting
    // for the answer rather than toasting on the click is the point: a save
    // dialog the user backed out of must not say "exported".
    if (unsupported) {
      toast.push({ tone: 'error', title: t('download.androidUnsupported') })
      return
    }
    if (!outcome) {
      toast.push({ tone: 'success', title: t('cal.ics.exported', { name: '' }) })
      return
    }
    if (outcome.cancelled) {
      toast.push({ tone: 'info', title: t('download.cancelled') })
      return
    }
    toast.push(
      outcome.ok
        ? { tone: 'success', title: t('cal.ics.exported', { name: outcome.name }) }
        : { tone: 'error', title: t('download.failed'), detail: outcome.name },
    )
  }

  /**
   * No live address on this platform, so the card is the export and the reason.
   *
   * Deliberately still a full section rather than a hidden row: the working
   * calendar is shared by pairing, so someone who set one up on their computer
   * and then went looking for it on their phone needs to find out here that the
   * publishing half is desktop-only — not by finding nothing at all.
   */
  if (!supported) {
    return (
      <Card>
        <CardHeader title={t('cal.subscribe.toggle')} hint={t('cal.subscribe.hint')} />
        <div className="card__body form-rows">
          <Banner tone="info">{t('cal.subscribe.mobileNoServer')}</Banner>
          <div className="btn-row">
            <Button
              variant="primary"
              icon={<IconDownload size={15} />}
              onClick={() => void exportIcs()}
            >
              {t('cal.subscribe.exportIcs')}
            </Button>
          </div>
          <div className="field__hint field__hint--keep">{t('cal.subscribe.exportIcsHint')}</div>
        </div>
      </Card>
    )
  }

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
                    void copyText(url).then((ok) => {
                      toast.push(
                        ok
                          ? { tone: 'success', title: t('control.copied') }
                          : { tone: 'error', title: t('inbox.copyFailed') },
                      )
                    })
                  }}
                >
                  {t('common.copy')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="field__hint">{t('cal.subscribe.limit')}</div>
        <div className="field__hint">{t('cal.subscribe.mobileNoServer')}</div>
      </div>
    </Card>
  )
}
