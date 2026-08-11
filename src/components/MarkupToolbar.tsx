/**
 * Seven buttons over a plain textarea.
 *
 * Deliberately not a rich-text editor. The body is a `<textarea>`, the app
 * already supports Markdown as a send format, and a contenteditable would
 * bring a document model that has to be serialised back to text before it can
 * be sent — plus its own paste handling, its own undo stack, and its own
 * selection bugs. The transforms live in `core/markup.ts` as pure functions;
 * this only knows where the caret is.
 *
 * Two things it gets right that a naive version does not:
 *
 * - **`setRangeText`, not `value =`.** Assigning to `value` wipes the
 *   browser's own undo stack, so Ctrl+Z after clicking Bold would jump past
 *   everything typed before it. `setRangeText` is an undoable edit, so the
 *   toolbar joins the history rather than erasing it.
 * - **Focus comes back.** A toolbar that leaves focus on the button it just
 *   pressed makes the second click act on a stale selection, and the caret
 *   position it carefully computed is invisible to a user who now has to click
 *   back into the box.
 */

import { useId, useState, type ReactNode, type RefObject } from 'react'
import { applyMarkup, type MarkupAction } from '../core/markup'
import { useI18n, type TranslationKey } from '../i18n'
import { IconChevronDown, IconLink } from './icons'

const ACTIONS: Array<{ action: MarkupAction; glyph: ReactNode; labelKey: TranslationKey }> = [
  { action: 'bold', glyph: 'B', labelKey: 'markup.bold' },
  { action: 'italic', glyph: 'I', labelKey: 'markup.italic' },
  { action: 'code', glyph: '</>', labelKey: 'markup.code' },
  // Every other button here is a drawn glyph that matches the app's flat,
  // monochrome, currentColor-stroked icon set; a raw 🔗 emoji is a colourful
  // rendered-by-the-OS pictograph that neither respects `currentColor` nor
  // sits at the same visual weight as its six neighbours.
  { action: 'link', glyph: <IconLink size={14} />, labelKey: 'markup.link' },
  { action: 'bullet', glyph: '•', labelKey: 'markup.bullet' },
  { action: 'number', glyph: '1.', labelKey: 'markup.number' },
  { action: 'quote', glyph: '❝', labelKey: 'markup.quote' },
]

export function MarkupToolbar({
  textarea,
  onChange,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>
  onChange: (body: string) => void
}) {
  const { t } = useI18n()
  /*
   * Closed on arrival, on every screen and every visit.
   *
   * Not persisted deliberately. The default *is* the feature — it is what buys
   * the message box its extra row — and a remembered "open" would quietly give
   * that row away again for a formatting session the user finished last week.
   * Reopening costs one tap; the box being short costs every visit.
   */
  const [open, setOpen] = useState(false)
  const groupId = useId()

  const run = (action: MarkupAction) => {
    const el = textarea.current
    if (!el) return
    const result = applyMarkup(action, el.value, el.selectionStart, el.selectionEnd)

    /*
     * Replace the whole value through `setRangeText` so the edit is undoable.
     * The range is the entire field because a line-based action can rewrite
     * text well outside the selection, and computing the minimal diff to keep
     * the range tight would be a lot of machinery for no visible gain.
     */
    el.focus()
    el.setSelectionRange(0, el.value.length)
    if (typeof el.setRangeText === 'function') {
      el.setRangeText(result.text, 0, el.value.length, 'end')
    } else {
      el.value = result.text
    }
    el.setSelectionRange(result.selectionStart, result.selectionEnd)
    // React owns this value, so it has to be told; the DOM edit above exists
    // for the undo stack, not as the source of truth.
    onChange(result.text)
  }

  return (
    <>
      {/*
        The disclosure, and its sibling `.markup` below is what it discloses.

        Two elements rather than a wrapper around both, because the narrow
        layout needs them on *different rows* of `.field__tools`: the toggle
        rides the label line beside the byte count, and the strip drops to a
        full-width row of its own beneath. A wrapper would have to be a flex
        item in its own right, and everything inside it would be trapped in
        that item's width.

        The open/closed state is published as `aria-expanded` and read back by
        CSS through `.markup__toggle[aria-expanded="false"] + .markup`, so
        there is exactly one source of truth and no second data attribute that
        could disagree with the accessible one.

        Hidden entirely on a wide window (`.markup__toggle { display: none }`),
        where all seven buttons fit on the label line and folding them would be
        a tap charged for nothing. Rendering it unconditionally and letting CSS
        decide keeps the state across a window resize.
      */}
      <button
        type="button"
        className="markup__toggle"
        aria-expanded={open}
        aria-controls={groupId}
        title={t('markup.title')}
        // Same reason as the action buttons below: without this, opening the
        // strip would collapse the selection it is about to act on.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        {t('markup.title')}
        <IconChevronDown size={12} />
      </button>
      <div className="markup" role="toolbar" aria-label={t('markup.title')} id={groupId}>
        {ACTIONS.map(({ action, glyph, labelKey }) => (
          <button
            key={action}
            type="button"
            className="markup__btn"
            title={t(labelKey)}
            aria-label={t(labelKey)}
            // The mousedown default is what moves focus out of the textarea and
            // collapses the selection; without this the button would act on
            // nothing every time.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(action)}
          >
            {glyph}
          </button>
        ))}
      </div>
    </>
  )
}
