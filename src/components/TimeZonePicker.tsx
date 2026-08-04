/**
 * Choosing one of 400-odd IANA time zones, drawn in the page.
 *
 * Two things this is deliberately not:
 *
 * - **Not a bare `<select>`.** Four hundred options in a native menu is a list
 *   nobody scrolls; the zone you want is found by typing, not by hunting.
 * - **Not a `<datalist>`.** Chromium paints that popup as browser chrome
 *   *outside the document*: page CSS cannot style it and a DOM probe cannot
 *   even see it. PROJECT-BRIEF §4 records the afternoon where "every control on
 *   this page is at least 16px" and "the text in that list is tiny" were both
 *   true, and only one of them was measurable. Anything that has to look right
 *   has to be drawn in the page.
 *
 * So this follows `RecipientPicker`: a filtered list of real rows, keyboard
 * reachable, with the ticked one marked. It differs in one respect on purpose —
 * the list is **in flow** rather than portalled and absolutely positioned.
 * `RecipientPicker` hangs off a field inside a grid with scrolling ancestors,
 * where an absolute panel would be clipped; this one lives inside
 * `.modal__body`, which is itself the scroller. An in-flow panel there can
 * never be clipped, never overlaps anything, and scrolls into view by itself on
 * a 360px screen. It costs the modal some height while it is open, which is
 * exactly the moment that height is what the user wants.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconGlobe, IconSearch } from './icons'
import { useI18n } from '../i18n'
import { deviceZone, filterZones, wallTimeIn } from './deliveryPreview'
import { knownTimeZones } from '../core/deliveryWindow'

export function TimeZonePicker({
  value,
  onChange,
  id,
}: {
  /** An IANA id, or `''` meaning "whatever zone this device is in". */
  value: string
  onChange: (zone: string) => void
  id?: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Built once. `Intl.supportedValuesOf` is not cheap and the answer cannot
  // change while the app is running.
  const zones = useMemo(() => knownTimeZones(), [])
  const here = useMemo(() => deviceZone(), [])
  const { shown, hidden } = useMemo(() => filterZones(zones, query), [zones, query])

  /**
   * `''` is a real choice, not an empty one: it means "follow this device",
   * which is what `DEFAULT_DELIVERY_WINDOW` ships with and the right answer for
   * a colleague in the same office. It sits at the top rather than being
   * offered as a checkbox somewhere else.
   */
  const rows = useMemo(
    () => (query.trim().length === 0 ? ['', ...shown] : shown),
    [query, shown],
  )

  useEffect(() => setActive(0), [query, open])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
  }, [open])

  /*
   * Escape closes the list, not the dialog behind it.
   *
   * The contact editor is a `Modal`, and every Modal in this app listens for
   * Escape on `document`. React's own `stopPropagation` has no effect on a
   * listener attached there, so this is the same capture-phase +
   * `stopImmediatePropagation` shape the recipient card and the image viewer
   * both had to arrive at.
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.isComposing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  // Keep the highlighted row on screen when the arrows walk past the edge.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-zonerow="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (zone: string) => {
    onChange(zone)
    setOpen(false)
    setQuery('')
  }

  const nowThere = wallTimeIn(Date.now(), value)
  const label = value || t('deliver.zoneSender', { zone: here })

  return (
    <div className="zonepick">
      <button
        type="button"
        id={id}
        className="input zonepick__value"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <IconGlobe size={15} aria-hidden="true" />
        <span className="zonepick__id">{label}</span>
        {nowThere ? (
          <span className="zonepick__now">{t('deliver.zoneNow', { time: nowThere })}</span>
        ) : null}
      </button>

      {open ? (
        <div className="zonepick__panel">
          <div className="zonepick__searchrow">
            <IconSearch size={15} aria-hidden="true" className="zonepick__searchicon" />
            <input
              ref={searchRef}
              className="input zonepick__search"
              value={query}
              spellCheck={false}
              placeholder={t('deliver.zoneSearch')}
              aria-label={t('deliver.zoneSearch')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  if (rows.length === 0) return
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  setActive((i) => (i + step + rows.length) % rows.length)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const zone = rows[active]
                  if (zone !== undefined) choose(zone)
                }
              }}
            />
          </div>

          <div className="zonepick__list" role="listbox" aria-label={t('deliver.zone')} ref={listRef}>
            {rows.map((zone, index) => {
              const chosen = zone === value
              return (
                <button
                  key={zone || '_device'}
                  type="button"
                  role="option"
                  aria-selected={chosen}
                  data-zonerow={index}
                  data-active={index === active || undefined}
                  className="zonepick__row"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(zone)}
                >
                  <span
                    className={`zonepick__tick${chosen ? ' zonepick__tick--on' : ''}`}
                    aria-hidden="true"
                  >
                    {chosen ? <IconCheck size={12} /> : null}
                  </span>
                  <span className="zonepick__rowid">
                    {zone || t('deliver.zoneSender', { zone: here })}
                  </span>
                </button>
              )
            })}

            {rows.length === 0 ? (
              <p className="zonepick__empty">{t('deliver.zoneNone', { q: query.trim() })}</p>
            ) : null}
          </div>

          {hidden > 0 ? <p className="zonepick__more">{t('deliver.zoneMore', { n: hidden })}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
