/**
 * B3 · 送达窗口 — the contact's own working day, and what it does.
 *
 * "Every Monday at 09:00" written in Shanghai arrives at 03:00 in Los Angeles,
 * which is the one hour of the week nobody reads mail. This block is where a
 * contact gets a zone and a working week so the scheduler can land their copy
 * inside their day instead.
 *
 * The part that matters most on this screen is not the three controls, it is
 * the sentence underneath them. A settings form that does not show its own
 * effect is how this feature gets configured wrong *and stays wrong*: every
 * value here is plausible, none of them is verifiable by reading it back, and
 * the consequence only becomes visible weeks later in somebody else's inbox at
 * an unreasonable hour. So the live line answers the actual question — "a
 * reminder set for X would really go out at Y, which is Z where they are" —
 * computed by handing the window being edited to the same
 * `applyDeliveryWindows` the scheduler calls.
 *
 * The other standing rule: **a broken window is ignored, and the mail goes out
 * on time.** `windowFault` decides what "broken" means; every message here says
 * so in those words. Nothing on this screen may ever imply that mail is being
 * held, because it never is — an application whose entire purpose is delivering
 * on time does not get to invent a new way of silently not delivering.
 */

import { useMemo } from 'react'
import { Banner, Field, Switch } from './ui'
import { TimeZonePicker } from './TimeZonePicker'
import {
  DAY_ORDER,
  effectiveZone,
  faultOf,
  previewFor,
  toggleDay,
  wallTimeIn,
  wallWeekdayIn,
  wrapsMidnight,
} from './deliveryPreview'
import {
  DEFAULT_DELIVERY_WINDOW,
  DELIVERY_HORIZON_DAYS,
  type DeliveryWindow,
} from '../core/schedule/deliveryWindow'
import { computeOccurrences } from '../core/schedule/schedule'
import { useI18n, type TranslationKey } from '../i18n'
import type { ScheduledJob } from '../core/types'

/** The example instant the sentence is about, and where it came from. */
interface Planned {
  at: number
  /** True when this is a real upcoming reminder rather than a stand-in. */
  fromJob: boolean
}

const nextWholeHour = (now: number) => {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.getTime()
}

export function DeliveryWindowEditor({
  value,
  onChange,
  name,
  address,
  jobs,
}: {
  value: DeliveryWindow | undefined
  onChange: (window: DeliveryWindow | undefined) => void
  /** What to call this person in the sentence. */
  name: string
  address: string
  /** Consulted for a real send time to illustrate with. */
  jobs: ScheduledJob[]
}) {
  const { t } = useI18n()

  /**
   * The instant the preview talks about.
   *
   * Taken from the *rule*, never from `job.occurrences`. That stored list has
   * already been through `applyDeliveryWindows` once, so previewing it would
   * feed a window its own output and report "already inside this window" for
   * every setting the user could possibly type — a live line that is live about
   * nothing. `computeOccurrences` gives the time that was asked for, which is
   * the only instant a consequence can be measured against.
   */
  const planned = useMemo<Planned>(() => {
    const now = Date.now()
    const key = address.trim().toLowerCase()
    let best: number | null = null
    if (key) {
      for (const job of jobs) {
        if (!job.enabled) continue
        if (!job.draft.to.some((a) => a.trim().toLowerCase() === key)) continue
        const [first] = computeOccurrences(job.recurrence, {
          runsSoFar: job.runCount,
          count: 1,
          after: now,
        })
        if (first !== undefined && (best === null || first < best)) best = first
      }
    }
    return { at: best ?? nextWholeHour(now), fromJob: best !== null }
  }, [address, jobs])

  const on = value !== undefined
  const who = name || address || t('contacts.title')

  return (
    <div className="deliverwin">
      <Switch
        checked={on}
        onChange={(next) => onChange(next ? { ...DEFAULT_DELIVERY_WINDOW } : undefined)}
        title={t('deliver.enable')}
        description={t('deliver.enableHint')}
      />

      {value ? (
        <div className="deliverwin__body">
          <Field label={t('deliver.zone')}>
            <TimeZonePicker
              value={value.timeZone}
              onChange={(timeZone) => onChange({ ...value, timeZone })}
            />
          </Field>

          <Field label={t('deliver.hours')} labelHint={t('deliver.toExclusive')}>
            <div className="deliverwin__times">
              <label className="deliverwin__time">
                <span className="deliverwin__timelabel">{t('deliver.from')}</span>
                <input
                  className="input"
                  type="time"
                  value={value.from}
                  onChange={(e) => onChange({ ...value, from: e.target.value })}
                />
              </label>
              <label className="deliverwin__time">
                <span className="deliverwin__timelabel">{t('deliver.until')}</span>
                <input
                  className="input"
                  type="time"
                  value={value.to}
                  onChange={(e) => onChange({ ...value, to: e.target.value })}
                />
              </label>
            </div>
          </Field>

          {/*
            The same seven-cell picker the recurrence editor uses — same class,
            same Monday-first order, same touch target. A second day picker with
            its own idea of which column is Monday is a bug waiting for a
            timetable to disagree with.

            `DAY_ORDER` is the drawing order; the number handed to `toggleDay`
            is the `Date#getDay` value the window stores, where Sunday is 0.
          */}
          <Field label={t('deliver.days')}>
            <div className="daypicker">
              {DAY_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="daypicker__day"
                  aria-pressed={value.days.includes(d)}
                  onClick={() => onChange({ ...value, days: toggleDay(value.days, d) })}
                >
                  {t(`weekday.${d}` as TranslationKey)}
                </button>
              ))}
            </div>
          </Field>

          {wrapsMidnight(value) ? (
            <p className="deliverwin__note">{t('deliver.overnight')}</p>
          ) : null}

          <WindowConsequence window={value} who={who} address={address} planned={planned} />
        </div>
      ) : (
        <p className="deliverwin__note">{t('deliver.off')}</p>
      )}
    </div>
  )
}

/**
 * The live line, and the fault banner above it when there is one.
 *
 * Split out so the preview is recomputed from the window that is on screen
 * right now — including the half-typed ones. A `09:` in the time box is a
 * `malformed` window for as long as it takes to type the minutes, and saying so
 * immediately is better than a banner that appears only once the user has
 * looked away.
 */
function WindowConsequence({
  window,
  who,
  address,
  planned,
}: {
  window: DeliveryWindow
  who: string
  address: string
  planned: Planned
}) {
  const { t, formatDateTime } = useI18n()

  const fault = faultOf(window)
  const preview = useMemo(
    () => previewFor(planned.at, [{ address, name: who, window }]),
    [planned.at, address, who, window],
  )
  const landing = preview.result.perRecipient[0]
  const zone = effectiveZone(window)
  const theirTime = wallTimeIn(preview.at, landing?.timeZone ?? zone)
  const theirWeekday = wallWeekdayIn(preview.at, landing?.timeZone ?? zone)
  const theirDay = theirWeekday === null ? '' : t(`weekday.${theirWeekday}` as TranslationKey)

  const plannedText = formatDateTime(planned.at)

  const sentence = () => {
    if (fault !== null) return t('deliver.previewIgnored', { planned: plannedText })
    if (landing?.outcome === 'impossible') {
      return t('deliver.previewImpossible', {
        days: DELIVERY_HORIZON_DAYS,
        planned: plannedText,
      })
    }
    if (preview.moved) {
      return t('deliver.previewMoved', {
        planned: plannedText,
        actual: formatDateTime(preview.at),
        theirTime: theirTime ?? '—',
        theirDay,
        name: who,
      })
    }
    return t('deliver.previewInside', {
      planned: plannedText,
      theirTime: theirTime ?? '—',
      theirDay,
      name: who,
    })
  }

  const faultKey: TranslationKey | null =
    fault === 'unknownZone'
      ? 'deliver.faultUnknownZone'
      : fault === 'malformed'
        ? 'deliver.faultMalformed'
        : fault === 'neverOpens'
          ? 'deliver.faultNeverOpens'
          : null

  return (
    <div className="deliverwin__preview">
      {faultKey ? (
        <Banner
          tone="warning"
          title={
            faultKey === 'deliver.faultUnknownZone'
              ? t(faultKey, { zone: window.timeZone })
              : t(faultKey)
          }
        >
          {/* Never "your mail is being held" — it is not, and never is. */}
          <p className="deliverwin__note">{t('deliver.faultIgnored')}</p>
        </Banner>
      ) : null}

      <p className="deliverwin__line" data-moved={preview.moved || undefined}>
        {sentence()}
      </p>
      <p className="deliverwin__source">
        {planned.fromJob ? t('deliver.previewSource') : t('deliver.previewSourceNone')}
      </p>
    </div>
  )
}
