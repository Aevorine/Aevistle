/**
 * The full-screen picture viewer, and the plumbing that gets bytes to it.
 *
 * Why this exists: an image "in the message body" was, until now, the literal
 * text `<img src="cid:…">` sitting in a textarea. The picture was attached and
 * would arrive correctly, but the person writing the mail could not see it —
 * which reads exactly like a feature that silently did nothing.
 *
 * So there are two halves here:
 *
 *   1. `useAttachmentImages` — turns attachment paths into `data:` URLs using
 *      the same hardened `readAttachment` bridge call the inbox preview uses.
 *      It is deliberately not a new file-reading capability: that call is
 *      confined to the data folder, size-capped, and refuses every type that
 *      is not safe to render inertly (SVG included — it is a document format
 *      that can carry script, and it stays out).
 *   2. `ImageLightbox` — the viewer itself. Zoom and pan, rotate and mirror,
 *      previous/next, and an info panel with a save/copy pair. Every control
 *      is both a button and a key, because a viewer you can only drive with
 *      the mouse is one you have to look away from the picture to use.
 *
 * Escape closes it. That is handled on the capture phase and stops the event
 * there, because this can open on top of the message reader — whose own
 * Escape handler would otherwise close the mail underneath at the same time.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { useToast } from './ui'
import {
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconFlipH,
  IconFlipV,
  IconInfo,
  IconRotateLeft,
  IconRotateRight,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from './icons'

/**
 * The types this viewer will show.
 *
 * Note what is missing: `svg`. `readAttachment` refuses it on the other side
 * of the bridge anyway, so listing it here would only produce attachments that
 * look clickable and then do nothing.
 */
const VIEWABLE_IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

export function isViewableImage(name: string): boolean {
  return VIEWABLE_IMAGE.test(name)
}

/**
 * Above this, a thumbnail is not worth the memory.
 *
 * The bridge itself allows 24 MB, which is right for "the user asked to see
 * this one file". Loading every attachment on the compose screen at that size
 * is a different question: eight of them would be 192 MB of base64 held in the
 * renderer for pictures shown at 96px. Anything larger still opens full screen
 * on demand — it just does not get a thumbnail.
 */
const THUMBNAIL_MAX_BYTES = 12 * 1024 * 1024

export type LoadedImage = { dataUrl: string; mime: string }

/**
 * Path → bytes, shared by every surface that shows a picture.
 *
 * Module-level and capped, for the same reason `imageCache` is: the compose
 * screen, the attachment list and the viewer all ask for the same file within
 * a second of each other, and re-reading a 4 MB PNG three times to show it
 * three times is work nobody asked for. `null` is cached too — a file that is
 * not viewable will not become viewable by asking again.
 */
const MAX_CACHED = 16
const cache = new Map<string, LoadedImage | null>()

function remember(path: string, value: LoadedImage | null) {
  if (cache.has(path)) cache.delete(path)
  cache.set(path, value)
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Testing seam, and what the settings screen calls when the data folder moves. */
export function clearAttachmentImageCache() {
  cache.clear()
}

/**
 * Put bytes somebody else already read into the shared cache.
 *
 * The inbox reads an attachment itself before opening the viewer — it has to,
 * because "the bridge refused this file" is the difference between showing a
 * picture and handing the file to the operating system, and that answer is
 * needed *before* anything opens. Seeding the result here is what stops the
 * same multi-megabyte file being read a second time one render later.
 */
export function seedAttachmentImage(path: string, value: LoadedImage | null) {
  remember(path, value)
}

export type ImageSource = {
  /** Stable across renders — the attachment id, so React keys stay put. */
  id: string
  name: string
  path: string
  size?: number
}

/**
 * Load the given attachments as data URLs.
 *
 * The returned map holds one entry per path once it has been decided:
 * `undefined` (absent) means "still loading", `null` means "cannot be shown
 * here". Callers use the difference — a spinner is right for the first and
 * wrong for the second.
 */
export function useAttachmentImages(items: ImageSource[]): Record<string, LoadedImage | null> {
  const { bridge } = useApp()
  // The counter, not just the setter: this is what the memo below re-runs on
  // as entries land. Depending on the setter (which never changes identity)
  // would leave every caller looking at an empty map forever.
  const [tick, force] = useState(0)

  // The identity of `items` changes on every keystroke (it is derived from the
  // draft), so the effect keys off the paths, not the array.
  //
  // `cache.has(path)` is part of the test on purpose: a file over the thumbnail
  // budget is not read in bulk, but if something has already read it
  // deliberately — the inbox does, before opening the viewer — it must still
  // join the run. Filtering it out anyway is how a click on a 15 MB photograph
  // ends up opening nothing and reporting nothing.
  const key = items
    .filter(
      (it) =>
        isViewableImage(it.name) && ((it.size ?? 0) <= THUMBNAIL_MAX_BYTES || cache.has(it.path)),
    )
    .map((it) => it.path)
    // More pictures than the cache holds would evict the earliest while the
    // latest were still arriving, and the strip would flicker as they took
    // turns. The rest keep their file-type tag, which is visible rather than
    // silent.
    .slice(0, MAX_CACHED)
    .join('\x00')

  useEffect(() => {
    const paths = key ? key.split('\x00') : []
    const wanted = paths.filter((p) => p && !cache.has(p))
    if (wanted.length === 0 || !bridge?.readAttachment) return
    let alive = true
    void (async () => {
      for (const path of wanted) {
        let value: LoadedImage | null = null
        try {
          const result = await bridge.readAttachment?.(path)
          if (result?.dataUrl) value = { dataUrl: result.dataUrl, mime: result.mime }
        } catch {
          /* Not viewable here. The file is still attached and still sends. */
        }
        if (!alive) return
        remember(path, value)
        force((n) => n + 1)
      }
    })()
    return () => {
      alive = false
    }
  }, [key, bridge])

  return useMemo(() => {
    const out: Record<string, LoadedImage | null> = {}
    for (const path of key ? key.split('\x00') : []) {
      if (cache.has(path)) out[path] = cache.get(path) ?? null
    }
    return out
    // `tick` is what re-runs this as entries land; `cache` is module state.
  }, [key, tick])
}

// --- the viewer -------------------------------------------------------------

const ZOOM_MIN = 0.05
const ZOOM_MAX = 16
const ZOOM_STEP = 1.25

type View = {
  /** 1 = one image pixel per CSS pixel. `null` means "fit the window". */
  scale: number | null
  rotation: number
  flipH: boolean
  flipV: boolean
  x: number
  y: number
}

const RESET: View = { scale: null, rotation: 0, flipH: false, flipV: false, x: 0, y: 0 }

export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: (ImageSource & { dataUrl: string; mime: string })[]
  index: number
  onIndex: (next: number) => void
  onClose: () => void
}) {
  const { t, formatBytes } = useI18n()
  const { bridge } = useApp()
  const toast = useToast()

  const [view, setView] = useState<View>(RESET)
  const [showInfo, setShowInfo] = useState(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null)

  const current = images[index]
  const count = images.length

  // A new picture starts fitted and unrotated. Carrying the previous one's
  // 400% zoom over to the next image is the single most annoying thing a
  // viewer can do.
  useEffect(() => {
    setView(RESET)
    setNatural(null)
  }, [current?.path])

  // The stage size decides what "fit" means, and it changes when the window
  // does — including when the info panel opens beside the picture.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.round(r.width), h: Math.round(r.height) })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * The scale at which the whole picture is visible.
   *
   * Capped at 1: blowing a 64px icon up to fill a 1400px window is not
   * "showing it fully", it is showing nine large squares.
   */
  const fitScale = useMemo(() => {
    if (!natural || box.w === 0 || box.h === 0) return 1
    const turned = view.rotation % 180 !== 0
    const w = turned ? natural.h : natural.w
    const h = turned ? natural.w : natural.h
    if (w === 0 || h === 0) return 1
    return Math.min(box.w / w, box.h / h, 1)
  }, [natural, box, view.rotation])

  const scale = view.scale ?? fitScale

  const setScaleAbout = useCallback(
    (next: number, originX: number, originY: number) => {
      setView((v) => {
        const from = v.scale ?? fitScale
        const to = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
        if (to === from) return v
        const k = to / from
        return {
          ...v,
          scale: to,
          // Keep whatever is under the cursor under the cursor.
          x: originX - (originX - v.x) * k,
          y: originY - (originY - v.y) * k,
        }
      })
    },
    [fitScale],
  )

  const zoomBy = useCallback(
    (factor: number) => setScaleAbout((view.scale ?? fitScale) * factor, 0, 0),
    [setScaleAbout, view.scale, fitScale],
  )

  const fit = useCallback(() => setView((v) => ({ ...v, scale: null, x: 0, y: 0 })), [])
  const actual = useCallback(() => setView((v) => ({ ...v, scale: 1, x: 0, y: 0 })), [])
  const rotate = useCallback(
    (delta: number) =>
      setView((v) => ({ ...v, rotation: (((v.rotation + delta) % 360) + 360) % 360, x: 0, y: 0 })),
    [],
  )

  const step = useCallback(
    (delta: number) => {
      if (count < 2) return
      onIndex((index + delta + count) % count)
    },
    [count, index, onIndex],
  )

  const save = useCallback(async () => {
    if (!current) return
    if (bridge?.saveAttachmentAs) {
      const saved = await bridge.saveAttachmentAs(current.path, current.name)
      if (saved) toast.push({ tone: 'success', title: t('image.saved', { name: current.name }) })
      return
    }
    // Browser preview: hand it to the download shelf rather than doing nothing.
    const a = document.createElement('a')
    a.href = current.dataUrl
    a.download = current.name
    a.click()
  }, [bridge, current, t, toast])

  const copy = useCallback(async () => {
    if (!current) return
    try {
      const blob = await (await fetch(current.dataUrl)).blob()
      // The clipboard only takes PNG reliably; anything else goes through a
      // canvas first. A JPEG copied as `image/jpeg` is rejected outright by
      // Chromium, which would look like the button doing nothing.
      let png = blob
      if (blob.type !== 'image/png') {
        png = await new Promise<Blob>((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d')
            if (!ctx) {
              reject(new Error('no 2d context'))
              return
            }
            ctx.drawImage(img, 0, 0)
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png')
          }
          img.onerror = () => reject(new Error('decode failed'))
          img.src = current.dataUrl
        })
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      toast.push({ tone: 'success', title: t('image.copied') })
    } catch (e) {
      toast.push({
        tone: 'error',
        title: t('image.copyFailed'),
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }, [current, t, toast])

  /**
   * Keys, on the capture phase.
   *
   * Capture rather than bubble because this viewer can be open on top of the
   * full-screen message reader, whose own Escape handler is on `document`. Let
   * the event through and one keypress closes both, dropping the user back to
   * the message list from a picture they only wanted to shut.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const handled = () => {
        e.preventDefault()
        // Both, and deliberately. `stopPropagation` keeps the key away from
        // the reader's own Escape handler further up the tree;
        // `stopImmediatePropagation` also keeps it away from one registered on
        // `document` itself, which is where every dialog in this application
        // puts its. Without the second, one Escape closes the picture and the
        // message underneath it in the same keystroke.
        e.stopPropagation()
        e.stopImmediatePropagation()
      }
      switch (e.key) {
        case 'Escape':
          handled()
          onClose()
          break
        case 'ArrowRight':
        case 'j':
        case 'J':
          handled()
          step(1)
          break
        case 'ArrowLeft':
        case 'k':
        case 'K':
          handled()
          step(-1)
          break
        case '+':
        case '=':
          handled()
          zoomBy(ZOOM_STEP)
          break
        case '-':
        case '_':
          handled()
          zoomBy(1 / ZOOM_STEP)
          break
        case '0':
          handled()
          fit()
          break
        case '1':
          handled()
          actual()
          break
        case 'r':
          handled()
          rotate(90)
          break
        case 'R':
          handled()
          rotate(-90)
          break
        case 'h':
        case 'H':
          handled()
          setView((v) => ({ ...v, flipH: !v.flipH }))
          break
        case 'v':
        case 'V':
          handled()
          setView((v) => ({ ...v, flipV: !v.flipV }))
          break
        case 'i':
        case 'I':
          handled()
          setShowInfo((s) => !s)
          break
        default:
          break
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose, step, zoomBy, fit, actual, rotate])

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const ox = e.clientX - r.left - r.width / 2
    const oy = e.clientY - r.top - r.height / 2
    setScaleAbout(scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), ox, oy)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.id !== e.pointerId) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    setView((v) => ({ ...v, scale: v.scale ?? fitScale, x: v.x + dx, y: v.y + dy }))
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null
  }

  if (!current) return null

  const transform = [
    'translate(-50%, -50%)',
    `translate(${view.x}px, ${view.y}px)`,
    `rotate(${view.rotation}deg)`,
    `scale(${scale * (view.flipH ? -1 : 1)}, ${scale * (view.flipV ? -1 : 1)})`,
  ].join(' ')

  const zoomPercent = Math.round(scale * 100)

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      onMouseDown={(e) => {
        // Click the backdrop to leave. The picture and the bars stop the event,
        // so only the empty space around them closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="lightbox__bar lightbox__bar--top">
        <div className="lightbox__title" title={current.name}>
          {current.name}
        </div>
        {count > 1 ? (
          <div className="lightbox__counter">{t('image.of', { i: index + 1, n: count })}</div>
        ) : null}
        <div className="lightbox__spacer" />
        <button
          type="button"
          className="lightbox__btn"
          aria-pressed={showInfo}
          aria-label={t('image.info')}
          title={`${t('image.info')} (I)`}
          onClick={() => setShowInfo((s) => !s)}
        >
          <IconInfo size={17} />
        </button>
        <button
          type="button"
          className="lightbox__btn"
          aria-label={t('image.close')}
          title={`${t('image.close')} (Esc)`}
          onClick={onClose}
        >
          <IconX size={17} />
        </button>
      </div>

      <div
        className="lightbox__stage"
        ref={stageRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (view.scale === null ? actual() : fit())}
        data-dragging={dragRef.current !== null || undefined}
      >
        <img
          className="lightbox__image"
          src={current.dataUrl}
          alt={current.name}
          draggable={false}
          style={{ transform }}
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
        />

        {count > 1 ? (
          <>
            <button
              type="button"
              className="lightbox__nav lightbox__nav--prev"
              aria-label={t('image.prev')}
              title={`${t('image.prev')} (←)`}
              onClick={(e) => {
                e.stopPropagation()
                step(-1)
              }}
            >
              <IconChevronLeft size={26} />
            </button>
            <button
              type="button"
              className="lightbox__nav lightbox__nav--next"
              aria-label={t('image.next')}
              title={`${t('image.next')} (→)`}
              onClick={(e) => {
                e.stopPropagation()
                step(1)
              }}
            >
              <IconChevronRight size={26} />
            </button>
          </>
        ) : null}

        {showInfo ? (
          <div className="lightbox__info">
            <div className="lightbox__inforow">
              <span className="lightbox__infokey">{t('image.name')}</span>
              <span className="lightbox__infoval">{current.name}</span>
            </div>
            <div className="lightbox__inforow">
              <span className="lightbox__infokey">{t('image.dimensions')}</span>
              <span className="lightbox__infoval">
                {natural ? `${natural.w} × ${natural.h}` : '—'}
              </span>
            </div>
            <div className="lightbox__inforow">
              <span className="lightbox__infokey">{t('image.size')}</span>
              <span className="lightbox__infoval">
                {current.size ? formatBytes(current.size) : '—'}
              </span>
            </div>
            <div className="lightbox__inforow">
              <span className="lightbox__infokey">{t('image.format')}</span>
              <span className="lightbox__infoval">{current.mime}</span>
            </div>
            <div className="lightbox__infoactions">
              <button type="button" className="lightbox__btn" onClick={() => void save()}>
                <IconDownload size={16} />
                <span>{t('image.saveAs')}</span>
              </button>
              <button type="button" className="lightbox__btn" onClick={() => void copy()}>
                <IconCopy size={16} />
                <span>{t('image.copy')}</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="lightbox__bar lightbox__bar--bottom">
        <button
          type="button"
          className="lightbox__btn"
          aria-label={t('image.zoomOut')}
          title={`${t('image.zoomOut')} (−)`}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <IconZoomOut size={17} />
        </button>
        <span className="lightbox__zoom">{zoomPercent}%</span>
        <button
          type="button"
          className="lightbox__btn"
          aria-label={t('image.zoomIn')}
          title={`${t('image.zoomIn')} (+)`}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <IconZoomIn size={17} />
        </button>
        <span className="lightbox__sep" />
        <button
          type="button"
          className="lightbox__btn"
          aria-pressed={view.scale === null}
          title={`${t('image.fit')} (0)`}
          onClick={fit}
        >
          {t('image.fit')}
        </button>
        <button
          type="button"
          className="lightbox__btn"
          aria-pressed={view.scale === 1}
          title={`${t('image.actual')} (1)`}
          onClick={actual}
        >
          {t('image.actual')}
        </button>
        <span className="lightbox__sep" />
        <button
          type="button"
          className="lightbox__btn"
          aria-label={t('image.rotateLeft')}
          title={`${t('image.rotateLeft')} (Shift+R)`}
          onClick={() => rotate(-90)}
        >
          <IconRotateLeft size={17} />
        </button>
        <button
          type="button"
          className="lightbox__btn"
          aria-label={t('image.rotateRight')}
          title={`${t('image.rotateRight')} (R)`}
          onClick={() => rotate(90)}
        >
          <IconRotateRight size={17} />
        </button>
        <button
          type="button"
          className="lightbox__btn"
          aria-pressed={view.flipH}
          aria-label={t('image.flipH')}
          title={`${t('image.flipH')} (H)`}
          onClick={() => setView((v) => ({ ...v, flipH: !v.flipH }))}
        >
          <IconFlipH size={17} />
        </button>
        <button
          type="button"
          className="lightbox__btn"
          aria-pressed={view.flipV}
          aria-label={t('image.flipV')}
          title={`${t('image.flipV')} (V)`}
          onClick={() => setView((v) => ({ ...v, flipV: !v.flipV }))}
        >
          <IconFlipV size={17} />
        </button>
      </div>
    </div>
  )
}

/**
 * The strip of pictures shown under the message body, and on the preview.
 *
 * One click opens the viewer. Everything about how the images are found is the
 * caller's business — this only draws what it is handed, which is what lets the
 * same component sit under the compose body, in the attachment list, and in the
 * send preview without three copies of the markup.
 */
export function ImageStrip({
  images,
  onOpen,
  label,
  hint,
}: {
  images: (ImageSource & { dataUrl: string; mime: string })[]
  onOpen: (index: number) => void
  label?: string
  /** Shown beside the label once there is something to click. */
  hint?: string
}) {
  // Nothing at all when there are no pictures: an empty "Pictures" heading on
  // a text-only draft is a row of height spent saying nothing.
  if (images.length === 0) return null
  return (
    <div className="imagestrip">
      {label ? (
        <div className="imagestrip__head">
          <span className="imagestrip__label">{label}</span>
          {hint ? <span className="imagestrip__hint">{hint}</span> : null}
        </div>
      ) : null}
      <div className="imagestrip__items">
        {images.map((img, i) => (
          <button
            key={img.id}
            type="button"
            className="imagestrip__item"
            onClick={() => onOpen(i)}
            title={img.name}
          >
            <img className="imagestrip__thumb" src={img.dataUrl} alt={img.name} draggable={false} />
            <span className="imagestrip__name">{img.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
