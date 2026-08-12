/**
 * One block of Settings, rendered as a card on a desktop and as a full-height
 * dialog on a phone.
 *
 * Settings is sixteen cards. On a wide window that is a two-column grid you
 * scan in a couple of seconds. On a 360px phone it is a single column roughly
 * fourteen screens tall, and every one of those screens is a control you were
 * not looking for — finding "Privacy" means scrolling past accounts, the data
 * folder, backups, transfers, pairing files, devices, remote control, calendar
 * subscriptions, updates, appearance, sending, the digest, greetings and
 * notifications. A jump bar was the previous answer and it does not survive the
 * width: thirteen labels in a horizontally scrolling strip pinned to the top of
 * the screen is a second navigation system competing with the one at the bottom
 * of the screen, and it ate the first 44px of every settings screen to do it.
 *
 * So the phone gets a different structure, not a restyle: an index of grouped
 * rows, each opening its section in a full-height dialog with one close button.
 * The index fits on about a screen and a half; the section you open is the only
 * thing on screen; and closing it puts you back exactly where you were, which
 * scrolling never quite does.
 *
 * ## Why the row is not in here any more
 *
 * It used to be: this component drew its own row, held its own `open` state,
 * and a `hideOnNarrow` flag dropped four sections' rows entirely because Home
 * already had tiles for them. That produced the defect this round exists to
 * fix — twelve rows for sixteen sections, with the daily digest, holiday
 * greetings, calendar publishing and device pairing reachable *only* from Home,
 * three of them behind 更多. Somebody who opened Settings looking for the daily
 * digest found nothing, and nothing pointing anywhere.
 *
 * Rows in the section and rows in a group cannot both be true: a group is an
 * ordering across sections, and a component that only knows about itself cannot
 * be ordered. So the index (`views/SettingsView.tsx`) owns the rows, their
 * order, their captions and their inline values, and owns which section is
 * open; this component owns the anchor and the dialog. The section's label
 * still arrives as a prop, from the same table the row title comes from, so the
 * row you tapped and the dialog that opened cannot disagree about their name.
 *
 * ## Why a wrapper and not sixteen files
 *
 * The obvious refactor — one component per section — founders on how much
 * state these blocks share. The account list, the account dialog, the digest
 * preview, the greetings plan, the app info and the reset confirmation are held
 * by `SettingsView` and read by several sections each; splitting them into
 * files means either threading a dozen props through every one or lifting the
 * state into a context that exists solely to be torn apart again. Both are
 * larger, riskier changes than the layout question deserves, and neither makes
 * the sections any easier to read.
 *
 * A wrapper leaves every section's markup exactly where it is and where its
 * state is. What it costs is that `children` is *built* on a phone even when
 * the dialog is shut — but built, not rendered: JSX is object construction, and
 * the expensive sections (`DevicesCard`, `BackupCard`, `UpdateCard` …) are
 * component elements, so none of their hooks, effects or network calls run
 * until the dialog actually mounts them.
 */

import { type ReactNode } from 'react'
import { Modal } from './ui'

export function SettingsSection({
  id,
  label,
  narrow,
  closeLabel,
  open,
  onClose,
  children,
}: {
  /**
   * The anchor id the wide layout's jump bar scrolls to.
   *
   * Still emitted on a phone even though nothing there scrolls to it: these
   * ids are also how `scripts/layout-probe.mjs` and the screenshot tooling
   * find a section, and a measuring script that silently found nothing would
   * report a passing measurement of the wrong thing. They are also the keys
   * the phone index opens sections by, so an id that drifted would show up as
   * a row that opens nothing rather than as a silent measurement.
   */
  id: string
  label: string
  narrow: boolean
  closeLabel: string
  /** Phone only. Ignored on a wide window, where every section is on the page. */
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  if (!narrow) {
    return (
      <>
        <div id={id} className="settings-section" />
        {children}
      </>
    )
  }

  return (
    <>
      <div id={id} className="settings-section" />
      {/*
        Mounted only while open, so a shut section costs nothing beyond the
        anchor above. `Modal` returns null when `open` is false, but the
        children would still have been constructed *and* their component
        elements handed to React to reconcile — this way the section genuinely
        does not exist until it is asked for.
      */}
      {open ? (
        <Modal
          open
          title={label}
          onClose={onClose}
          closeLabel={closeLabel}
          fullscreen
          bodyClassName="modal__body--settings"
        >
          {children}
        </Modal>
      ) : null}
    </>
  )
}
