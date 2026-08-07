/**
 * One block of Settings, rendered as a card on a desktop and as a row that
 * opens a dialog on a phone.
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
 * So the phone gets a different structure, not a restyle: a list of sixteen
 * rows, each opening its section in a full-height dialog with one close button.
 * The rows fit on two screens; the section you open is the only thing on
 * screen; and closing it puts you back exactly where you were, which scrolling
 * never quite does.
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

import { useState, type ReactNode } from 'react'
import { IconChevronRight } from './icons'
import { Modal } from './ui'

export function SettingsSection({
  id,
  label,
  icon,
  narrow,
  closeLabel,
  hideOnNarrow,
  children,
}: {
  /**
   * The anchor id the wide layout's jump bar scrolls to.
   *
   * Still emitted on a phone even though nothing there scrolls to it: these
   * ids are also how `scripts/layout-probe.mjs` and the screenshot tooling
   * find a section, and a measuring script that silently found nothing would
   * report a passing measurement of the wrong thing.
   */
  id: string
  label: string
  icon: ReactNode
  narrow: boolean
  closeLabel: string
  /**
   * Drops the row (and the dialog behind it) on a phone, leaving only the
   * anchor div, for the handful of sections `HomeView`'s `HOME_FEATURES`
   * already puts one tap away from the tab bar. A wide window has no such
   * shortcut — Settings is already the only door — so this never touches the
   * `!narrow` branch below, and the row keeps its place there unconditionally.
   * Without it, opening the app to Home and then to Settings offered the same
   * digest/greetings/calendar-subscribe/pairing card behind two different
   * buttons, which read as the phone not knowing where it put its own
   * features rather than as two doors to one room.
   */
  hideOnNarrow?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  if (!narrow) {
    return (
      <>
        <div id={id} className="settings-section" />
        {children}
      </>
    )
  }

  if (hideOnNarrow) {
    return <div id={id} className="settings-section" />
  }

  return (
    <>
      <div id={id} className="settings-section" />
      <button type="button" className="settingsrow" onClick={() => setOpen(true)}>
        <span className="settingsrow__icon">{icon}</span>
        <span className="settingsrow__label">{label}</span>
        <IconChevronRight size={16} className="settingsrow__chevron" />
      </button>
      {/*
        Mounted only while open, so a shut section costs nothing beyond the
        element tree above. `Modal` returns null when `open` is false, but the
        children would still have been constructed *and* their component
        elements handed to React to reconcile — this way the section genuinely
        does not exist until it is asked for.
      */}
      {open ? (
        <Modal
          open
          title={label}
          onClose={() => setOpen(false)}
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
