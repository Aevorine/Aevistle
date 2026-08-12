/** Recipient chips and the attachment drop zone. */

import { useMemo, useRef, useState } from 'react'
import { IconPaperclip, IconSearch, IconUsers, IconX } from './icons'
import { IconButton } from './ui'
import { RecipientPicker } from './RecipientPicker'
import { useI18n } from '../i18n'
import { dedupeAddresses, isValidAddress, parseAddressList, extensionOf, isRiskyAttachment } from '../core/mail/validate'
import { buildPool, matchesQuery } from '../core/mail/recipients'
import type { Attachment, Contact, RecentRecipient } from '../core/types'

/**
 * How many characters before the inline dropdown appears, and how many people
 * it offers.
 *
 * Two, because one character matches most of a contact book and offering that
 * is offering a scrollbar. Three rows, because the panel hangs over the subject
 * row and the head of the message box on a 360px screen: three `--ctl-md` rows
 * plus the border is 146px, which clears the recipient row it belongs to and
 * still leaves the message visible underneath. The full list is one tap away on
 * the button that has always opened it.
 */
const SUGGEST_MIN_CHARS = 2
const SUGGEST_ROWS = 3

// ---------------------------------------------------------------------------
// Recipient tag field
// ---------------------------------------------------------------------------

export function TagField({
  values,
  onChange,
  placeholder,
  suggestions = [],
  recents = [],
  /**
   * The label the picker card announces itself with ("To", "Cc", "Bcc").
   *
   * Also the switch that turns the card on at all: a field without one keeps
   * the plain typing behaviour, which is what the tests and any future
   * non-recipient use of this component want.
   */
  pickerLabel,
  id,
  /**
   * Show at most this many chips, then a "+N" pill that reveals the rest.
   *
   * There was no cap at all, and on a phone that is not a cosmetic gap. A chip
   * is 54px tall here because `.chip__remove` has to clear the 48px tap floor,
   * so measured heights ran 1 recipient ≈ 120px, 3 ≈ 240px, **10 ≈ 660px** —
   * taller than the message box it sits above, with no `max-height` and no
   * scroller anywhere in the stylesheet. The only reason it never showed was
   * that the whole band used to be folded behind a summary bar; opening it
   * with ten recipients pushed the message off-screen entirely, and nothing
   * asserted against that because the layout probe measures the folded state.
   *
   * Undefined means no cap, which is what every wide caller wants: a desktop
   * chip is 30px and ten of them are ~190px in a 700px column.
   */
  maxVisible,
  /**
   * Complete inline after two characters instead of throwing the picker card up
   * on focus.
   *
   * Opt-in rather than the default, and the reason is the card's own breakpoint:
   * below 840px `RecipientPicker` becomes a bottom sheet, so on a phone the old
   * behaviour covered the screen the instant "To" was tapped — before a
   * character had been typed — and the soft keyboard then covered *that*. Above
   * 840px the card is an anchored dropdown beside the field and is exactly
   * right, which is why this is a prop and not a rewrite: the compose screen
   * passes it on the narrow branch, and every other caller keeps what it had.
   *
   * The card is not removed on this path. The button inside the field still
   * opens it, and it is still the only way to tick a whole group.
   */
  inlineSuggest,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  suggestions?: Contact[]
  recents?: RecentRecipient[]
  pickerLabel?: string
  id?: string
  maxVisible?: number
  inlineSuggest?: boolean
}) {
  const [text, setText] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Which row Enter would take. -1 is "none yet", not "the first one". */
  const [active, setActive] = useState(-1)
  /** Escape closes the list without clearing what was typed; the next keystroke
      brings it back. Per-query, so it can never leave the field permanently
      without completion. */
  const [dismissed, setDismissed] = useState(false)
  /* Reveal is per-visit and deliberately not persisted: the cap exists to
     protect the message box, and a field that stayed expanded from last time
     would hand that protection away before the user has typed anything. */
  const [showAll, setShowAll] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const commit = (raw: string) => {
    const parsed = parseAddressList(raw)
    if (parsed.length === 0) return
    onChange(dedupeAddresses([...values, ...parsed]))
    setText('')
  }

  const pool = useMemo(() => buildPool(suggestions, recents), [suggestions, recents])

  const showPicker = pickerLabel !== undefined && pickerOpen

  /**
   * The people worth offering for what has been typed so far.
   *
   * `pool` is already ranked — pinned, then frequent, then merely known — so
   * this only filters and cuts, and the top of the list is the person you write
   * to most among those that match. Anyone already on the field is dropped:
   * a completion that re-adds an address the chip beside it already holds is a
   * row that does nothing when you press Enter on it.
   */
  const suggested = useMemo(() => {
    if (!inlineSuggest || dismissed) return []
    const query = text.trim()
    if (query.length < SUGGEST_MIN_CHARS) return []
    const taken = new Set(values.map((v) => v.trim().toLowerCase()))
    return pool
      .filter((p) => !taken.has(p.key) && matchesQuery(p, query))
      .slice(0, SUGGEST_ROWS)
  }, [inlineSuggest, dismissed, text, pool, values])

  /*
   * A highlight held over from the previous query points at whoever now happens
   * to be in that position, which is how Enter adds the wrong person. Reset
   * whenever the list changes, and let Enter with nothing highlighted mean "the
   * top one" — see the key handler.
   */
  const suggestOpen = suggested.length > 0
  const takeSuggestion = (index: number) => {
    const pick = suggested[index]
    if (!pick) return
    onChange(dedupeAddresses([...values, pick.address]))
    setText('')
    setActive(-1)
    inputRef.current?.focus()
  }

  return (
    <div className="tagfield-wrap" ref={wrapRef}>
      <div
        className="tagfield"
        onClick={() => {
          inputRef.current?.focus()
          if (pickerLabel !== undefined) setPickerOpen(true)
        }}
      >
        {(maxVisible === undefined || showAll ? values : values.slice(0, maxVisible)).map((address) => {
          const valid = isValidAddress(address)
          const known = pool.find((p) => p.key === address.toLowerCase())
          return (
            <span
              className={`chip chip--recipient ${valid ? '' : 'chip--invalid'}`}
              key={address}
              title={address}
            >
              <span className="chip__text">{known?.name ? `${known.name} · ${address}` : address}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label={`Remove ${address}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(values.filter((v) => v !== address))
                }}
              >
                <IconX size={11} />
              </button>
            </span>
          )
        })}
        {/* The "+N" pill, and it is a button rather than a chip on purpose:
            it is the only thing in this row that is not a recipient, and
            giving it the chip shape would make "+7 人" look like an address
            somebody could remove. Counts what is hidden, not the total. */}
        {maxVisible !== undefined && !showAll && values.length > maxVisible ? (
          <button
            type="button"
            className="tagfield__more"
            onClick={(e) => {
              e.stopPropagation()
              setShowAll(true)
            }}
          >
            +{values.length - maxVisible}
          </button>
        ) : null}
        <input
          ref={inputRef}
          id={id}
          className="tagfield__input"
          value={text}
          placeholder={values.length === 0 ? placeholder : ''}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showPicker || suggestOpen}
          onChange={(e) => {
            setText(e.target.value)
            // The list about to be rendered is a different list. A highlight
            // held over from the previous query points at whoever now happens to
            // sit in that position, which is exactly how Enter adds the wrong
            // person — the same reset `RecipientPicker` does on its own query.
            setActive(-1)
            setDismissed(false)
          }}
          onKeyDown={(e) => {
            // The IME owns Enter while a candidate window is open; committing
            // the raw pinyin there would put "weichen" in as an address.
            if (e.nativeEvent.isComposing) return
            /*
             * The inline list gets first refusal on the keys it owns.
             *
             * Enter with the list up takes the highlighted row, or the top one
             * when nothing is highlighted — "type two letters and press Enter"
             * has to work without an arrow key, because on a phone there is no
             * arrow key. Enter with the list *down* falls through to the commit
             * below, which is what makes an address nobody knows still typeable.
             */
            if (suggestOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setActive((at) => {
                const step = e.key === 'ArrowDown' ? 1 : -1
                const next = (at < 0 ? (step > 0 ? 0 : suggested.length - 1) : at + step)
                return (next + suggested.length) % suggested.length
              })
              return
            }
            if (suggestOpen && e.key === 'Enter') {
              e.preventDefault()
              takeSuggestion(active < 0 ? 0 : active)
              return
            }
            if (suggestOpen && e.key === 'Escape') {
              // Close the list, keep the text. Escape here means "I meant what I
              // typed" — an address that happens to be a prefix of a contact's
              // is a real case, and without this there is no way to reach the
              // commit path while a match is on screen.
              e.preventDefault()
              setActive(-1)
              setDismissed(true)
              return
            }
            if (e.key === 'ArrowDown' && pickerLabel !== undefined && !pickerOpen) {
              e.preventDefault()
              setPickerOpen(true)
            } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
              // The card, when it is open and something is highlighted, has
              // already handled Enter in the capture phase and stopped it.
              // Reaching here means "commit what I typed", which is the whole
              // point of a field that also accepts any address at all.
              if (text.trim()) {
                e.preventDefault()
                commit(text)
              }
            } else if (e.key === 'Backspace' && !text && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (/[,;\s]/.test(pasted)) {
              e.preventDefault()
              commit(pasted)
            }
          }}
          onFocus={() => {
            // Not on the `inlineSuggest` path: below 840px the card is a bottom
            // sheet, so opening it here covered the screen the instant "To" was
            // tapped, before a character had been typed, and the soft keyboard
            // then covered that. The dropdown below is what answers instead, and
            // the button in the field still opens the card on demand.
            if (pickerLabel !== undefined && !inlineSuggest) setPickerOpen(true)
          }}
          onBlur={() => {
            // Only commit leftover text when neither list is up. While one is,
            // the same text is that list's filter — committing it would turn
            // "fin" (meaning: show me the finance group) into an invalid
            // recipient chip the moment focus moved. An address is the one thing
            // that survives either way, which is the rule `RecipientPicker`'s
            // own `onClose` already follows.
            if (!text.trim() || showPicker) return
            if (suggestOpen && !text.includes('@')) {
              setText('')
              setActive(-1)
              return
            }
            commit(text)
          }}
        />
        {pickerLabel !== undefined ? (
          <button
            type="button"
            className="tagfield__open"
            aria-label={pickerLabel}
            aria-expanded={showPicker}
            onClick={(e) => {
              e.stopPropagation()
              setPickerOpen((v) => !v)
            }}
          >
            <IconUsers size={15} />
          </button>
        ) : null}
      </div>

      {/*
        The two-character dropdown. Hangs under the field, never over it — see
        `.tagsuggest` for the geometry that keeps it clear of the row on a 360px
        screen.

        `onPointerDown` preventing default is what makes tapping a row work at
        all: without it the field blurs first, `onBlur` clears or commits the
        text, the list unmounts, and the `click` lands on nothing. The row still
        does its work on `click`, so the keyboard path is unchanged.
      */}
      {suggestOpen ? (
        <div className="tagsuggest" role="listbox" aria-label={pickerLabel}>
          {suggested.map((pick, index) => (
            <button
              key={pick.key}
              type="button"
              role="option"
              aria-selected={index === active}
              data-active={index === active || undefined}
              className="tagsuggest__item"
              onPointerDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => takeSuggestion(index)}
            >
              {pick.name ? <span className="tagsuggest__name">{pick.name}</span> : null}
              <span className="tagsuggest__address">{pick.address}</span>
            </button>
          ))}
        </div>
      ) : null}

      {pickerLabel !== undefined ? (
        <RecipientPicker
          open={pickerOpen}
          values={values}
          onChange={onChange}
          onClose={() => {
            setPickerOpen(false)
            // What is left in the box was doing double duty: an address to add
            // *and* the card's filter. Only the first reading survives the card
            // closing — "finance", typed to find a group, must not be left
            // behind as a red invalid chip.
            if (text.includes('@')) commit(text)
            else setText('')
          }}
          pool={pool}
          query={text}
          anchorRef={wrapRef}
          label={pickerLabel}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'])

function kindLabel(name: string): string {
  const ext = extensionOf(name)
  if (IMAGE_EXT.has(ext)) return 'IMG'
  if (ARCHIVE_EXT.has(ext)) return 'ZIP'
  return (ext || '?').slice(0, 4).toUpperCase()
}

/**
 * The search box used by every list screen.
 *
 * It was previously copy-pasted, inline styles and all, into each view that
 * needed one — which is exactly how two screens end up with search boxes that
 * are almost, but not quite, the same. One component, one look.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div className="search">
      <IconSearch size={15} className="search__icon" />
      <input
        className="input search__input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export function AttachmentPicker({
  attachments,
  onAdd,
  onRemove,
  onToggleInline,
  onDropPaths,
  presence,
  thumbnails,
  onPreview,
}: {
  attachments: Attachment[]
  onAdd: () => void
  onRemove: (id: string) => void
  /** Only offered for images — everything else can only ride along as a file. */
  onToggleInline?: (id: string) => void
  /**
   * Path → `data:` URL, for the ones that have been read back.
   *
   * A row showing "IMG" and a filename is a row that cannot answer "which
   * picture is that?", which is the question people actually have when a draft
   * carries four screenshots. Missing entries just keep the type tag.
   */
  thumbnails?: Record<string, string>
  /** Open the full-screen viewer on this attachment. Only wired for images. */
  onPreview?: (id: string) => void
  /**
   * Handle a real drop. Absent where the platform cannot resolve a dropped
   * file to a path, in which case the drop falls back to opening the picker —
   * which is what this component did for every platform until Electron's
   * `webUtils` gave us the path back.
   */
  onDropPaths?: (files: FileList) => void
  /**
   * Path → still on disk. `undefined` for the whole map, or for one path,
   * means "not known" and is shown as nothing at all. Only an explicit `false`
   * earns the red mark — a flag that appears when the check merely failed is a
   * flag people learn to ignore.
   */
  presence?: Record<string, boolean>
}) {
  const { t, formatBytes } = useI18n()
  const [dragging, setDragging] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <div
        className="dropzone"
        data-dragging={dragging}
        role="button"
        tabIndex={0}
        onClick={onAdd}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onAdd()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          // Attach what was actually dropped, where the platform can tell us
          // where it came from. Everywhere else, fall back to the picker
          // rather than pretending the drop did nothing.
          if (onDropPaths && e.dataTransfer.files.length > 0) onDropPaths(e.dataTransfer.files)
          else onAdd()
        }}
      >
        <IconPaperclip size={22} />
        {/* The affordance, and nothing else. The size cap used to be spelled
            out on a second line here — grey prose on a screen whose complaint
            is that there is no room for the message — and it is the one number
            the app already enforces for you: an oversized file is refused with
            the limit in the message, at the moment it matters. */}
        <div className="dropzone__title">{t('compose.dropHere')}</div>
      </div>

      {attachments.length > 0 ? (
        <div className="attachments">
          {attachments.map((a) => {
            const gone = presence?.[a.path] === false
            const thumb = thumbnails?.[a.path]
            const viewable = thumb !== undefined && onPreview !== undefined
            return (
            <div
              className={`attachment ${isRiskyAttachment(a.name) ? 'attachment--risky' : ''}`}
              data-missing={gone || undefined}
              key={a.id}
            >
              {/* The picture itself where we have it, the file-type tag where
                  we do not. Clickable only in the first case — a tag that
                  opens nothing is the kind of dead control this app keeps
                  finding in its own screens. */}
              {viewable ? (
                <button
                  type="button"
                  className="attachment__icon attachment__icon--thumb"
                  onClick={() => onPreview(a.id)}
                  title={t('image.openHint')}
                >
                  <img src={thumb} alt="" draggable={false} />
                </button>
              ) : (
                <div className="attachment__icon attachment__icon--tag">
                  {kindLabel(a.name)}
                </div>
              )}
              <div className="attachment__body">
                <div className="attachment__name" title={gone ? a.path : a.name}>
                  {a.name}
                </div>
                <div className="attachment__meta">
                  {gone ? (
                    <span className="attachment__gone">{t('compose.attachmentGone')}</span>
                  ) : null}
                  {formatBytes(a.size)}
                  {a.source === 'copy' ? ' · copy' : ''}
                  {a.inline ? ` · ${t('compose.inlineBadge')}` : ''}
                </div>
              </div>
              {onToggleInline && IMAGE_EXT.has(extensionOf(a.name)) ? (
                <button
                  type="button"
                  className="attachment__action"
                  aria-pressed={a.inline}
                  onClick={() => onToggleInline(a.id)}
                  title={a.inline ? t('compose.inlineRemove') : t('compose.inlineAdd')}
                >
                  {a.inline ? t('compose.inlineRemove') : t('compose.inlineAdd')}
                </button>
              ) : null}
              <IconButton label={t('common.delete')} onClick={() => onRemove(a.id)}>
                <IconX size={15} />
              </IconButton>
            </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
