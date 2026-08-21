/**
 * One editor, two boxes: a dialog on a phone, a column beside the list on a
 * tablet.
 *
 * ## What this is for
 *
 * Between 600px and 840px — a portrait tablet, a phone on its side, a half
 * screen on a laptop — there is room for a list and the thing the list opens,
 * side by side. Inbox and Settings already take it (`useTwoPane`,
 * `26-tablet.css`). The list screens behind the Home grid did not: on an 800px
 * tablet, pressing 编辑 on a contact threw a dialog over a list that was
 * perfectly readable underneath, and closing it was the only way to see the
 * list again. Editing three contacts was three dialogs.
 *
 * ## Why a component and not a `twoPane ? … : …` in each screen
 *
 * Because the editor must be written once. The alternative is the same form
 * twice per screen, and a form that exists twice is a form where a field gets
 * added to one copy — which is not hypothetical, it is the failure the
 * `ReaderShell` note in `InboxView` records for the message reader. Here the
 * caller passes `children` and a footer; this picks the box and nothing else.
 *
 * ## Why `ReaderShell` is not this component
 *
 * The reader carries three things no editor has: `immersive` (it opens full
 * screen and Escape steps *out* before it closes), `variant="reader"` (a
 * header layout keyed by attribute rather than by `:has()`, for a Chromium 51
 * WebView), and a body class shared deliberately between its two boxes. Folding
 * those in would mean every editor pays for options only one caller can use.
 * They are twins, not duplicates — and if a third caller ever needs the
 * immersive ladder, that is the moment to merge them, not before.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { Modal } from './ui'
import { pushBackHandler } from '../core/backStack'
import { useI18n } from '../i18n'

export function DetailShell({
  twoPane,
  open,
  title,
  actions,
  footer,
  onClose,
  closeLabel,
  emptyHint,
  paneLabel,
  wide,
  children,
}: {
  twoPane: boolean
  open: boolean
  title: string
  /** Controls that belong beside the heading in the pane, and in the dialog's header. */
  actions?: ReactNode
  /** The confirm/cancel row. In the pane it is pinned to the bottom of the column. */
  footer?: ReactNode
  onClose: () => void
  closeLabel: string
  /** What the empty column says when nothing is selected. A blank half-screen reads as a bug. */
  emptyHint: string
  /** Names the column for a screen reader — it is a landmark, not a dialog. */
  paneLabel: string
  wide?: boolean
  children: ReactNode
}) {
  const { t } = useI18n()

  /*
   * The system back button closes the pane's editor too.
   *
   * The dialog half gets this from `Modal`, which registers itself while open.
   * The pane half is part of the screen rather than an overlay, so nothing
   * would register for it — and on a tablet, the one device the band exists
   * for, back with an editor open would skip past it to the shell's "go to
   * Home" rule and leave the screen entirely with unsaved edits in it.
   *
   * Above the early return, because hooks cannot be called after one.
   */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!twoPane || !open) return
    return pushBackHandler(() => {
      onCloseRef.current()
      return true
    })
  }, [twoPane, open])

  if (!twoPane) {
    return (
      <Modal
        open={open}
        wide={wide}
        title={title}
        onClose={onClose}
        closeLabel={closeLabel}
        footer={footer}
      >
        {children}
      </Modal>
    )
  }

  return (
    <aside className="twopane__detail" aria-label={paneLabel}>
      {open ? (
        <>
          <div className="detailhead">
            {/*
              No close button, and none is missing: the list is already on
              screen, so there is nothing to close *back to*. Cancel lives in
              the footer with Save, where a decision about unsaved edits
              belongs — a ✕ up here would be a second, quieter way to discard
              them.
            */}
            <h2 className="detailhead__title">{title}</h2>
            {actions}
          </div>
          {/*
            `detailpane__body` is the Inbox reader's scroller class, reused
            deliberately — one column, one set of scrolling rules, rather than
            a second name that means the same thing until someone edits one of
            them. `--form` adds the padding a stack of fields needs and the
            reader does not, because the reader's frame supplies its own.
          */}
          <div className="detailpane__body detailpane__body--form">{children}</div>
          {footer ? <div className="detailpane__footer">{footer}</div> : null}
        </>
      ) : (
        <div className="detailpane__body detailpane__body--empty">
          <p className="detailpane__hint">{emptyHint}</p>
          {/* Named for a screen reader, which lands in this column with no
              visual context to tell it what the column is. */}
          <span className="sr-only">{t('twopane.emptyRole')}</span>
        </div>
      )}
    </aside>
  )
}
