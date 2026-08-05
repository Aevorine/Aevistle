/**
 * The phone-only hub for the five screens that came off the bottom bar.
 *
 * ## Why this exists
 *
 * The bottom bar carried all nine tabs. On a 360px phone that never fit, and
 * the fallback was a horizontal scroller: four tabs sat off-screen at any
 * moment, and the only indication was that the strip moved if you happened to
 * drag it sideways. Tabs you find by scrolling a tab bar are tabs most people
 * do not find, so half the app was, in practice, unreachable on the platform
 * where screen space is scarcest.
 *
 * Five tabs fit. The other five live here, as tiles, each opening its screen in
 * a dialog you close to come back — see `core/nav.ts`'s `HOME_SECTIONS` for
 * which five and why those.
 *
 * ## Why dialogs rather than navigation
 *
 * Opening these as ordinary views would work, and would leave the user on a
 * screen whose tab is not on the bar: nothing highlighted, and "back" meaning
 * whatever the last tab was. A dialog has an unambiguous close button and puts
 * you back exactly where you were, which is the behaviour a hub screen implies.
 *
 * It also keeps the五 screens' own state alive for exactly as long as they are
 * open and no longer — closing the log frees its list, rather than leaving it
 * mounted behind a tab nobody is looking at.
 *
 * ## What this is not
 *
 * Not rendered on a desktop at all. The sidebar there still lists all nine
 * screens, because there is room for nine and an extra tap to reach five of
 * them would be a cost with nothing bought. `App.tsx` decides; this component
 * assumes it has already been decided.
 */

import { lazy, Suspense, useState, type ReactElement } from 'react'
import { Modal, PageHead } from '../components/ui'
import { Skeleton } from '../components/Skeleton'
import { useI18n } from '../i18n'
import { HOME_SECTIONS, NAV, type ViewId } from '../core/nav'
import {
  IconActivity,
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconFileText,
  IconUsers,
} from '../components/icons'

const ScheduleView = lazy(() =>
  import('./ScheduleView').then((m) => ({ default: m.ScheduleView })),
)
const ContactsView = lazy(() =>
  import('./ContactsView').then((m) => ({ default: m.ContactsView })),
)
const TemplatesView = lazy(() =>
  import('./TemplatesView').then((m) => ({ default: m.TemplatesView })),
)
const WorkCalendarView = lazy(() =>
  import('./WorkCalendarView').then((m) => ({ default: m.WorkCalendarView })),
)
const LogsView = lazy(() => import('./LogsView').then((m) => ({ default: m.LogsView })))

/** Icons for the five, keyed by the same ids `HOME_SECTIONS` lists. */
const TILE_ICONS: Partial<Record<ViewId, (p: { size?: number }) => ReactElement>> = {
  schedule: IconClock,
  contacts: IconUsers,
  templates: IconFileText,
  workcal: IconCalendar,
  logs: IconActivity,
}

export function HomeView({
  onCompose,
  armedCount,
}: {
  /**
   * Both the schedule and the calendar can start a new reminder, and both then
   * need the compose screen — which is a *tab*, not something this hub can put
   * in a dialog on top of itself. So the request is passed up, and the caller
   * closes whatever is open by navigating away from Home entirely.
   */
  onCompose: () => void
  /** Drawn on the schedule tile, the one count worth seeing without opening anything. */
  armedCount: number
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState<ViewId | null>(null)

  const close = () => setOpen(null)

  /** Compose is a tab; reaching it means leaving Home, so the dialog closes first. */
  const goCompose = () => {
    close()
    onCompose()
  }

  const labelOf = (id: ViewId) => {
    const item = NAV.find((n) => n.id === id)
    return item ? t(item.labelKey) : id
  }

  return (
    <div className="view view--home">
      <div className="view__inner">
        <PageHead title={t('home.title')} subtitle={t('home.subtitle')} />

        <div className="hometiles">
          {HOME_SECTIONS.map((id) => {
            const Icon = TILE_ICONS[id]
            return (
              <button
                key={id}
                type="button"
                className="hometile"
                /* Same attribute the sidebar tabs carry, so the measuring and
                   screenshot scripts can reach these five by id rather than by
                   a label that changes with the language. */
                data-view={id}
                onClick={() => setOpen(id)}
              >
                <span className="hometile__icon">{Icon ? <Icon size={22} /> : null}</span>
                <span className="hometile__label">{labelOf(id)}</span>
                {id === 'schedule' && armedCount > 0 ? (
                  <span className="hometile__badge">{armedCount}</span>
                ) : null}
                <IconChevronRight size={16} className="hometile__chevron" />
              </button>
            )
          })}
        </div>
      </div>

      {/* One dialog, whichever tile is open. A dialog per tile would mount five
          `Modal`s and five lazy boundaries to show at most one. */}
      {open ? (
        <Modal
          open
          title={labelOf(open)}
          onClose={close}
          closeLabel={t('common.close')}
          fullscreen
          /* The thing inside is a whole screen, and a screen already owns its
             own padding, its own max-width and its own sticky heading. Letting
             the dialog body add a second set of all three left the schedule
             list inset twice from a 360px edge and gave it two headings. */
          bodyClassName="modal__body--screen"
        >
          <Suspense fallback={<Skeleton shape="list" rows={6} />}>
            {open === 'schedule' ? <ScheduleView onCompose={goCompose} /> : null}
            {open === 'contacts' ? <ContactsView /> : null}
            {open === 'templates' ? <TemplatesView onApplied={goCompose} /> : null}
            {open === 'workcal' ? <WorkCalendarView onCompose={goCompose} /> : null}
            {open === 'logs' ? <LogsView /> : null}
          </Suspense>
        </Modal>
      ) : null}
    </div>
  )
}
