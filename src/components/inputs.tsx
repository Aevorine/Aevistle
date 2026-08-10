/** Recipient chips and the attachment drop zone. */

import { useMemo, useRef, useState } from 'react'
import { IconPaperclip, IconSearch, IconUsers, IconX } from './icons'
import { IconButton } from './ui'
import { RecipientPicker } from './RecipientPicker'
import { useI18n } from '../i18n'
import { dedupeAddresses, isValidAddress, parseAddressList, extensionOf, isRiskyAttachment } from '../core/validate'
import { buildPool } from '../core/recipients'
import type { Attachment, Contact, RecentRecipient } from '../core/types'

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
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  suggestions?: Contact[]
  recents?: RecentRecipient[]
  pickerLabel?: string
  id?: string
}) {
  const [text, setText] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
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

  return (
    <div className="tagfield-wrap" ref={wrapRef}>
      <div
        className="tagfield"
        onClick={() => {
          inputRef.current?.focus()
          if (pickerLabel !== undefined) setPickerOpen(true)
        }}
      >
        {values.map((address) => {
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
        <input
          ref={inputRef}
          id={id}
          className="tagfield__input"
          value={text}
          placeholder={values.length === 0 ? placeholder : ''}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showPicker}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // The IME owns Enter while a candidate window is open; committing
            // the raw pinyin there would put "weichen" in as an address.
            if (e.nativeEvent.isComposing) return
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
            if (pickerLabel !== undefined) setPickerOpen(true)
          }}
          onBlur={() => {
            // Only commit leftover text when the card is not up. While it is,
            // the same text is the card's filter — committing it would turn
            // "fin" (meaning: show me the finance group) into an invalid
            // recipient chip the moment focus moved.
            if (text.trim() && !showPicker) commit(text)
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
