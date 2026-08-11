/**
 * The recipient card that drops out of the To / Cc / Bcc box.
 *
 * Replaces the row of quick-pick buttons that used to sit permanently under the
 * compose form. That row cost height on every screen, showed at most six people
 * and one-click-added them with no way to un-add from the same place — while
 * the space it took came straight out of the message body, on the screen where
 * the body matters most.
 *
 * Everything it can do, it does from one place: tick people, tick a whole
 * group, tick everything that matches what you typed, and untick any of it
 * again. The box behind it still takes a typed address at any point; the card
 * is an additional way in, never a gate.
 *
 * Drawn through a portal because the compose header is a grid with scrolling
 * children, and any ancestor with `overflow` would clip an absolutely
 * positioned panel — the reason the old quick bar had to live *below* the form
 * rather than next to the field it belonged to.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconSearch, IconStar, IconUsers, IconX } from './icons'
import { BP_EXPANDED } from './useNarrow'
import { useI18n } from '../i18n'
import {
  addAll,
  groupState,
  initialOf,
  matchesQuery,
  removeAll,
  sectionsOf,
  togglePick,
  type Pick,
  type PickSection,
} from '../core/mail/recipients'

/** Where the card sits when there is room to anchor it to the field. */
interface Anchor {
  left: number
  top: number
  width: number
}

const CARD_MIN_WIDTH = 320
const CARD_MAX_HEIGHT = 420
const VIEWPORT_MARGIN = 12
/**
 * Below this the card becomes a bottom sheet instead of a dropdown.
 *
 * Imported rather than spelled: this was its own `760`, and the shell's was a
 * different 760 in a different file, so the two only agreed by coincidence and
 * moving one would have silently split them. `BP_EXPANDED` is the width at
 * which the whole app stops being a stack, which is exactly the condition a
 * dropdown needs — there has to be something beside the field to drop over.
 */
const SHEET_BREAKPOINT = BP_EXPANDED - 1

export function RecipientPicker({
  open,
  values,
  onChange,
  onClose,
  pool,
  query,
  anchorRef,
  label,
}: {
  open: boolean
  values: string[]
  onChange: (next: string[]) => void
  onClose: () => void
  pool: Pick[]
  /** What has been typed in the field. The card filters by it live. */
  query: string
  anchorRef: React.RefObject<HTMLElement | null>
  /** "To" / "Cc" / "Bcc", for the card's own heading. */
  label: string
}) {
  const { t } = useI18n()
  const cardRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [sheet, setSheet] = useState(false)
  const [active, setActive] = useState(-1)

  const taken = useMemo(
    () => new Set(values.map((v) => v.trim().toLowerCase())),
    [values],
  )

  /**
   * What the card is showing right now.
   *
   * Already-chosen people stay in the list rather than disappearing from it,
   * which is the opposite of what the old inline dropdown did. A list you can
   * only add from needs a second place to remove from; a list of ticks does
   * not.
   */
  const filtered = useMemo(() => pool.filter((p) => matchesQuery(p, query)), [pool, query])
  const sections = useMemo(() => sectionsOf(filtered), [filtered])

  /** Flat order for the arrow keys, matching what the eye sees top to bottom. */
  const flat = useMemo(() => sections.flatMap((s) => s.picks), [sections])

  const allShown = useMemo(() => {
    // A person in two tags appears twice above; "select all" must not count
    // them twice or the button would offer a number nobody can reach.
    const seen = new Set<string>()
    const unique: Pick[] = []
    for (const p of flat) {
      if (seen.has(p.key)) continue
      seen.add(p.key)
      unique.push(p)
    }
    return unique
  }, [flat])

  const shownSelected = allShown.filter((p) => taken.has(p.key)).length
  const everyShownSelected = allShown.length > 0 && shownSelected === allShown.length

  // --- placement ------------------------------------------------------------

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const isSheet = window.innerWidth <= SHEET_BREAKPOINT
      setSheet(isSheet)
      if (isSheet) {
        setAnchor(null)
        return
      }
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.max(CARD_MIN_WIDTH, Math.min(rect.width, window.innerWidth - VIEWPORT_MARGIN * 2))
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, rect.left),
        window.innerWidth - width - VIEWPORT_MARGIN,
      )
      // Flip above the field when there is more room there — a card that opens
      // downward off the bottom of a short window is a card nobody can read.
      const below = window.innerHeight - rect.bottom - VIEWPORT_MARGIN
      const above = rect.top - VIEWPORT_MARGIN
      const top = below < 220 && above > below ? Math.max(VIEWPORT_MARGIN, rect.top - Math.min(CARD_MAX_HEIGHT, above) - 6) : rect.bottom + 6
      setAnchor({ left, top, width })
    }
    place()
    window.addEventListener('resize', place)
    // Capture phase: the compose form scrolls inside a pane, not the document,
    // so a listener on `window` alone would never hear it move.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorRef])

  // --- dismissal ------------------------------------------------------------

  useEffect(() => {
    if (!open) return
    /*
     * Escape is listened for in three other places in this app — the compose
     * screen's focus mode, every Modal, and the global shortcut table — and
     * two of those are on `document`/`window`, where React's own
     * `stopPropagation` has no effect at all. Capture phase plus
     * `stopImmediatePropagation` is the only thing that closes just this card.
     * The image viewer and the account dialog each learned this the hard way.
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The IME's candidate window owns Escape while it is up.
      if (e.isComposing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    /*
     * `mousedown`, not `click`: the field's own blur handler runs first, and by
     * the time a click lands the card may already be gone. Clicks inside the
     * card and inside the field it belongs to both count as "still using it".
     */
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (cardRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onClose, anchorRef])

  // Typing narrows the list, so a highlight held over from the previous query
  // would point at a different person than the one under it.
  useEffect(() => setActive(-1), [query])

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (flat.length === 0) return
        e.preventDefault()
        setActive((i) => {
          const step = e.key === 'ArrowDown' ? 1 : -1
          const next = i < 0 ? (step > 0 ? 0 : flat.length - 1) : (i + step + flat.length) % flat.length
          return next
        })
        return
      }
      if (e.key === 'Enter' && active >= 0 && flat[active]) {
        e.preventDefault()
        // Toggle, not "pick and close": this is a multi-select, and closing on
        // the first choice would make choosing a second one a second journey.
        e.stopImmediatePropagation()
        onChange(togglePick(values, flat[active]))
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && allShown.length > 0) {
        e.preventDefault()
        e.stopImmediatePropagation()
        onChange(everyShownSelected ? removeAll(values, allShown) : addAll(values, allShown))
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, flat, active, values, onChange, allShown, everyShownSelected])

  // Keep the highlighted row on screen when the arrows walk past the edge.
  useEffect(() => {
    if (active < 0) return
    cardRef.current
      ?.querySelector<HTMLElement>(`[data-row="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  let rowIndex = -1
  const body = (
    <div
      ref={cardRef}
      className={`recipicker${sheet ? ' recipicker--sheet' : ''}`}
      style={sheet || !anchor ? undefined : { left: anchor.left, top: anchor.top, width: anchor.width }}
      role="dialog"
      aria-label={label}
      // The field keeps the caret; clicking the card must not steal it, or the
      // next character typed would go nowhere.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('input')) return
        e.preventDefault()
      }}
    >
      <div className="recipicker__head">
        <span className="recipicker__title">
          <IconUsers size={15} aria-hidden="true" />
          {label}
        </span>
        <span className="recipicker__count">{t('compose.pickerSelected', { n: values.length })}</span>
        <button
          type="button"
          className="recipicker__close"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <IconX size={14} />
        </button>
      </div>

      <div className="recipicker__bar">
        <button
          type="button"
          className="btn btn--ghost recipicker__all"
          disabled={allShown.length === 0}
          onClick={() =>
            onChange(everyShownSelected ? removeAll(values, allShown) : addAll(values, allShown))
          }
        >
          {everyShownSelected
            ? t('compose.pickerClearShown', { n: allShown.length })
            : t('compose.pickerSelectAll', { n: allShown.length })}
        </button>
        {values.length > 0 ? (
          <button type="button" className="btn btn--ghost" onClick={() => onChange([])}>
            {t('compose.pickerClearAll')}
          </button>
        ) : null}
      </div>

      <div className="recipicker__list">
        {sections.length === 0 ? (
          <p className="recipicker__empty">
            <IconSearch size={16} aria-hidden="true" />
            {pool.length === 0 ? t('compose.pickerNoContacts') : t('compose.pickerEmpty')}
          </p>
        ) : null}

        {sections.map((section) => (
          <section className="recipicker__section" key={section.id}>
            <SectionHeader
              section={section}
              taken={taken}
              onToggle={() =>
                onChange(
                  groupState(section.picks, taken) === 'all'
                    ? removeAll(values, section.picks)
                    : addAll(values, section.picks),
                )
              }
            />
            {section.picks.map((p) => {
              rowIndex += 1
              const index = rowIndex
              const checked = taken.has(p.key)
              return (
                <button
                  key={`${section.id}_${p.key}`}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  data-row={index}
                  data-active={index === active || undefined}
                  className="recipicker__row"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onChange(togglePick(values, p))}
                >
                  <span className={`recipicker__tick${checked ? ' recipicker__tick--on' : ''}`} aria-hidden="true">
                    {checked ? <IconCheck size={12} /> : null}
                  </span>
                  <span className="avatar" aria-hidden="true">
                    {initialOf(p)}
                  </span>
                  <span className="recipicker__who">
                    <span className="recipicker__name">{p.name || p.address}</span>
                    {p.name ? <span className="recipicker__address">{p.address}</span> : null}
                  </span>
                  {p.pinned ? <IconStar size={13} className="recipicker__pin" /> : null}
                </button>
              )
            })}
          </section>
        ))}
      </div>

      <p className="recipicker__hint">{t('compose.pickerHint')}</p>
    </div>
  )

  return createPortal(
    sheet ? (
      <div className="recipicker__scrim" role="presentation">
        {body}
      </div>
    ) : (
      body
    ),
    document.body,
  )
}

function SectionHeader({
  section,
  taken,
  onToggle,
}: {
  section: PickSection
  taken: Set<string>
  onToggle: () => void
}) {
  const { t } = useI18n()
  const state = groupState(section.picks, taken)
  const title =
    section.kind === 'tag'
      ? section.tag
      : section.kind === 'pinned'
        ? t('compose.pickerPinned')
        : section.kind === 'untagged'
          ? t('compose.pickerUntagged')
          : t('compose.pickerHistory')
  return (
    <button
      type="button"
      className="recipicker__group"
      onClick={onToggle}
      title={t('compose.pickerGroupAll', { n: section.picks.length })}
    >
      <span
        className={`recipicker__tick recipicker__tick--${state}`}
        aria-hidden="true"
      >
        {state === 'all' ? <IconCheck size={12} /> : state === 'some' ? <span className="recipicker__dash" /> : null}
      </span>
      <span className="recipicker__grouptitle">{title}</span>
      <span className="recipicker__groupcount">{section.picks.length}</span>
    </button>
  )
}
