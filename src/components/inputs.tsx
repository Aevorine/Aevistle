/** Recipient chips and the attachment drop zone. */

import { useMemo, useRef, useState } from 'react'
import { IconPaperclip, IconSearch, IconStar, IconX } from './icons'
import { IconButton } from './ui'
import { useI18n } from '../i18n'
import { dedupeAddresses, isValidAddress, parseAddressList, extensionOf, isRiskyAttachment } from '../core/validate'
import type { Attachment, Contact, RecentRecipient } from '../core/types'

// ---------------------------------------------------------------------------
// Recipient tag field
// ---------------------------------------------------------------------------

/**
 * One entry in the recipient picker, whoever it came from.
 *
 * The contact book and the sent-to history are two different lists answering
 * two different questions ("who do I know" and "who do I write to"), and the
 * field needs one ranked list. Flattening them here rather than at each call
 * site is what stops the two from being merged slightly differently in the
 * To, Cc and Bcc fields of the same form.
 */
interface Pick {
  key: string
  name: string
  address: string
  /** Pinned contacts and frequent correspondents sort above the rest. */
  weight: number
  pinned?: boolean
}

/** Initials for the round badge: "Wei Chen" → "W", "wei@…" → "W". */
function initialOf(pick: Pick): string {
  const source = pick.name.trim() || pick.address
  return source.slice(0, 1).toUpperCase()
}

/**
 * Would this contact match what has been typed?
 *
 * Matches on name and address, and on the *initials* of a multi-word name, so
 * "wc" finds "Wei Chen" — typing initials is how people actually reach for a
 * name they already know, and requiring the full spelling makes the completion
 * useful only to people who did not need it.
 */
function matchesQuery(pick: Pick, q: string): boolean {
  if (pick.name.toLowerCase().includes(q) || pick.address.toLowerCase().includes(q)) return true
  const initials = pick.name
    .split(/[\s·,]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toLowerCase() ?? '')
    .join('')
  return initials.length > 1 && initials.startsWith(q)
}

export function TagField({
  values,
  onChange,
  placeholder,
  suggestions = [],
  recents = [],
  /** Show the always-visible quick-pick bar. Off for Cc/Bcc, which are secondary. */
  quickBar,
  id,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  suggestions?: Contact[]
  recents?: RecentRecipient[]
  quickBar?: boolean
  id?: string
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = (raw: string) => {
    const parsed = parseAddressList(raw)
    if (parsed.length === 0) return
    onChange(dedupeAddresses([...values, ...parsed]))
    setText('')
  }

  const add = (address: string) => {
    onChange(dedupeAddresses([...values, address]))
    setText('')
    setHighlight(0)
  }

  const taken = useMemo(() => new Set(values.map((v) => v.toLowerCase())), [values])

  /**
   * Everyone worth offering, ranked once.
   *
   * Contacts carry the names, the history carries the evidence of who is
   * actually written to; an address in both keeps the contact's name and gains
   * the history's weight. Weights are deliberately coarse — pinned beats
   * frequent beats known — because the exact ordering inside a band matters
   * far less than the bands being right.
   */
  const pool = useMemo((): Pick[] => {
    const byAddress = new Map<string, Pick>()
    for (const c of suggestions) {
      const key = c.address.toLowerCase()
      byAddress.set(key, {
        key,
        name: c.name,
        address: c.address,
        weight: c.pinned ? 1000 : 10,
        pinned: c.pinned,
      })
    }
    for (const r of recents) {
      const key = r.address.toLowerCase()
      const existing = byAddress.get(key)
      // Damped, so one address written to forty times cannot bury everyone.
      const bump = Math.min(400, Math.log2(r.count + 1) * 60)
      if (existing) existing.weight += bump
      else {
        byAddress.set(key, {
          key,
          name: r.name ?? '',
          address: r.address,
          weight: bump,
        })
      }
    }
    return [...byAddress.values()].sort((a, b) => b.weight - a.weight || a.address.localeCompare(b.address))
  }, [suggestions, recents])

  const available = useMemo(() => pool.filter((p) => !taken.has(p.key)), [pool, taken])

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase()
    if (q.length === 0) return []
    return available.filter((p) => matchesQuery(p, q)).slice(0, 8)
  }, [text, available])

  /**
   * Common recipients, offered before anything is typed — "at least give me
   * the common ones" was the ask, and a field that only helps once you have
   * started spelling an address is not that.
   */
  const quickPicks = useMemo(() => available.slice(0, 8), [available])

  /** Contact tags, so a whole group can be added in one click. */
  const groups = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of suggestions) {
      for (const tag of c.tags) {
        if (!tag) continue
        const bucket = map.get(tag) ?? []
        bucket.push(c.address)
        map.set(tag, bucket)
      }
    }
    return [...map.entries()]
      .filter(([, addresses]) => addresses.some((a) => !taken.has(a.toLowerCase())))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 6)
  }, [suggestions, taken])

  const dropdown = text.trim().length > 0 ? matches : focused ? quickPicks : []
  const active = dropdown[Math.min(highlight, dropdown.length - 1)]

  return (
    <div className="tagfield-wrap">
      <div className="tagfield" onClick={() => inputRef.current?.focus()}>
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
          aria-expanded={dropdown.length > 0}
          onChange={(e) => {
            setText(e.target.value)
            setHighlight(0)
          }}
          onKeyDown={(e) => {
            // The IME owns Enter while a candidate window is open; committing
            // the raw pinyin there would put "weichen" in as an address.
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown' && dropdown.length > 0) {
              e.preventDefault()
              setHighlight((h) => (h + 1) % dropdown.length)
            } else if (e.key === 'ArrowUp' && dropdown.length > 0) {
              e.preventDefault()
              setHighlight((h) => (h - 1 + dropdown.length) % dropdown.length)
            } else if (e.key === 'Enter' && active) {
              e.preventDefault()
              add(active.address)
            } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
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
          onFocus={() => setFocused(true)}
          onBlur={() => {
            if (text.trim()) commit(text)
            setFocused(false)
          }}
        />
      </div>

      {dropdown.length > 0 ? (
        <div className="tagfield__menu" role="listbox">
          {text.trim().length === 0 ? (
            <div className="tagfield__suggestheader">{t('compose.commonRecipients')}</div>
          ) : null}
          {dropdown.map((p, i) => (
            <button
              key={p.key}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className="tagfield__option"
              data-active={i === highlight || undefined}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                add(p.address)
              }}
            >
              <span className="avatar" aria-hidden="true">
                {initialOf(p)}
              </span>
              <span className="tagfield__optiontext">
                <span className="tagfield__optionname">{p.name || p.address}</span>
                <span className="tagfield__optionaddress">{p.address}</span>
              </span>
              {p.pinned ? <IconStar size={13} className="tagfield__pin" /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {/*
        The always-on quick bar.
        The dropdown only exists while the field has focus, which means the
        common recipients are invisible exactly when someone is deciding who to
        write to. This row is the answer to "give me the common ones": name and
        address both on show, one click to add.
      */}
      {quickBar && (quickPicks.length > 0 || groups.length > 0) ? (
        <div className="quickpicks">
          <span className="quickpicks__label">{t('compose.commonRecipients')}</span>
          {quickPicks.slice(0, 6).map((p) => (
            <button
              key={p.key}
              type="button"
              className="quickpick"
              onClick={() => add(p.address)}
              title={p.address}
            >
              <span className="avatar" aria-hidden="true">
                {initialOf(p)}
              </span>
              <span className="quickpick__text">
                <span className="quickpick__name">{p.name || p.address}</span>
                {p.name ? <span className="quickpick__address">{p.address}</span> : null}
              </span>
            </button>
          ))}
          {groups.map(([tag, addresses]) => (
            <button
              key={`g_${tag}`}
              type="button"
              className="quickpick quickpick--group"
              onClick={() => onChange(dedupeAddresses([...values, ...addresses]))}
              title={t('compose.addGroupHint', { n: addresses.length })}
            >
              <span className="quickpick__text">
                <span className="quickpick__name">{tag}</span>
                <span className="quickpick__address">{t('compose.groupCount', { n: addresses.length })}</span>
              </span>
            </button>
          ))}
        </div>
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
  limitMb,
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
  limitMb: number
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
        <div className="dropzone__title">{t('compose.dropHere')}</div>
        <div className="dropzone__hint">{t('compose.dropHint', { limit: limitMb })}</div>
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
