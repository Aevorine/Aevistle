/**
 * The hub — a phone's only door to five screens, and every platform's door to
 * four Settings features that used to live only inside Settings.
 *
 * ## The two kinds of tile
 *
 * `HOME_SECTIONS` (five: schedule, contacts, templates, the working calendar,
 * the log) are ordinary top-level screens that simply do not fit across the
 * bottom of a 360px phone — see `core/nav.ts` for the full story. They have
 * their own tab on a desktop already, so this screen draws them only when
 * `narrow` is true; repeating five tabs that are one click away on the
 * sidebar would be a second, redundant door bought for nothing.
 *
 * `HOME_FEATURES` (four: the daily digest, holiday greetings, publishing the
 * working calendar for subscription, and pairing) are different in kind. They
 * were never screens — no tab anywhere has ever pointed at them — they were
 * four of sixteen sections on the Settings screen, reachable only by opening
 * Settings and scrolling or jumping to the right one. That was a real report:
 * on a desktop the four sections all still exist and still work, but nothing
 * to do with "have I sent today's summary" or "is my calendar shared" belongs
 * conceptually inside a *preferences* screen, and finding out meant knowing
 * Settings was where to look. These four tiles are drawn unconditionally,
 * phone or desktop, because unlike the five above they have never had a
 * dedicated door anywhere else.
 *
 * ## Two features, one screen away
 *
 * `DigestCard` and `GreetingsCard` are not imported from files of their own —
 * they are named exports of `views/SettingsView.tsx`, reached the same way
 * every other screen behind this hub is: `lazy(() => import(...))`. See the
 * comment on `DigestCard` for the reason, which is `scripts/check-digest.mjs`
 * and `scripts/check-greetings.mjs` asserting those two features' wiring by
 * reading `SettingsView.tsx`'s own source — a guard that stopped seeing the
 * code because it moved to a tidier location would be a guard that silently
 * stopped checking anything. `CalendarSubscribeCard` and `DevicesCard` were
 * already self-contained files of their own before this screen needed them,
 * so those two are imported the ordinary way.
 *
 * All four read their own state through `useApp()` — none of them takes a
 * prop — which is what lets the very same component mount here and inside
 * `SettingsSection` in `SettingsView.tsx` without either caller threading
 * state through the other. Whichever one is on screen owns the interaction;
 * closing it and reopening it from the other entry point starts fresh, which
 * is the right behaviour for a preview or a plan that nobody asked to persist.
 *
 * ## Why dialogs rather than navigation
 *
 * Opening a tile as an ordinary view would leave the user on a screen whose
 * tab is not lit on the sidebar (five of nine tiles) or that has no tab at
 * all (all four `HOME_FEATURES`), with "back" meaning whatever the previous
 * tab was. A dialog has an unambiguous close button and returns exactly to
 * this screen, which is the behaviour a hub implies. It also keeps each
 * tile's state alive for exactly as long as it is open — closing the log
 * frees its list, closing the digest tile drops its preview, rather than
 * either staying mounted behind a screen nobody is looking at.
 *
 * `bodyClassName` picks between two treatments a `Modal` can give its body,
 * both already defined in `app.css` for `SettingsSection`'s own dialogs:
 * `modal__body--screen` for the five real screens, which already draw their
 * own padding and their own sticky heading and would otherwise get both a
 * second time; `modal__body--settings` for the four features, which are Cards
 * that already draw their own frame and whose own title line is hidden by
 * that class so it does not repeat the dialog's header two lines below it —
 * exactly the treatment those same four components already get when a phone
 * opens them from inside Settings.
 */

import { lazy, Suspense, useState, type ReactElement } from 'react'
import { Modal } from '../components/ui'
import { Skeleton } from '../components/Skeleton'
import { useI18n } from '../i18n'
import { HOME_FEATURES, HOME_SECTIONS, NAV, type HomeFeatureId, type ViewId } from '../core/nav'
import {
  IconActivity,
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconFileText,
  IconLink,
  IconShield,
  IconStar,
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

/** Already self-contained files of their own — see the module doc. */
const CalendarSubscribeCard = lazy(() =>
  import('./CalendarSubscribeCard').then((m) => ({ default: m.CalendarSubscribeCard })),
)
const DevicesCard = lazy(() => import('./DevicesCard').then((m) => ({ default: m.DevicesCard })))

/**
 * Exported from `SettingsView.tsx`, not from files of their own — see the
 * module doc's "Two features, one screen away" for why, and the comment on
 * `DigestCard` in that file for the full reasoning.
 */
const DigestCard = lazy(() =>
  import('./SettingsView').then((m) => ({ default: m.DigestCard })),
)
const GreetingsCard = lazy(() =>
  import('./SettingsView').then((m) => ({ default: m.GreetingsCard })),
)
/*
 * Lazy like the rest, and it matters more here than for its neighbours: this
 * panel pulls in the bridge, the OAuth state machine and the self-check core to
 * answer a question most sessions never ask. Loading it eagerly would put the
 * cost of diagnosing a broken app onto every launch of a working one.
 */
const SelfCheckPanel = lazy(() =>
  import('../components/SelfCheckPanel').then((m) => ({ default: m.SelfCheckPanel })),
)
/** Already a self-contained file of its own, like `DevicesCard`/`CalendarSubscribeCard` above. */
const ReliabilityView = lazy(() =>
  import('./ReliabilityView').then((m) => ({ default: m.ReliabilityView })),
)

/** Icons for the five `HOME_SECTIONS` tiles, keyed by the same ids. */
const TILE_ICONS: Partial<Record<ViewId, (p: { size?: number }) => ReactElement>> = {
  schedule: IconClock,
  contacts: IconUsers,
  templates: IconFileText,
  workcal: IconCalendar,
  logs: IconActivity,
}

/** Icons for the four `HOME_FEATURES` tiles, keyed by the same ids. */
const FEATURE_ICONS: Record<HomeFeatureId, (p: { size?: number }) => ReactElement> = {
  digest: IconFileText,
  greetings: IconStar,
  calendarsub: IconCalendar,
  pairing: IconLink,
  reliability: IconShield,
  selfcheck: IconActivity,
}

export function HomeView({
  onCompose,
  armedCount,
  narrow,
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
  /**
   * Whether to also draw the five `HOME_SECTIONS` tiles.
   *
   * True on a phone, where they have nowhere else to be reached from — that
   * is the reason this screen exists at all, see the module doc. False on a
   * desktop, where each of the five already has its own sidebar tab, so
   * drawing them again here would be a second, redundant door to five places
   * one click away already. The four `HOME_FEATURES` tiles are drawn either
   * way, since they are the actual reason a desktop needed this screen.
   */
  narrow: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState<ViewId | HomeFeatureId | null>(null)

  const close = () => setOpen(null)

  /** Compose is a tab; reaching it means leaving Home, so the dialog closes first. */
  const goCompose = () => {
    close()
    onCompose()
  }

  const isFeature = (id: ViewId | HomeFeatureId): id is HomeFeatureId =>
    HOME_FEATURES.some((f) => f.id === id)

  const labelOf = (id: ViewId | HomeFeatureId) => {
    const feature = HOME_FEATURES.find((f) => f.id === id)
    if (feature) return t(feature.labelKey)
    const item = NAV.find((n) => n.id === id)
    return item ? t(item.labelKey) : id
  }

  return (
    <div className="view view--home">
      <div className="view__inner">
        {/* No page heading: the highlighted Home tab already says where you
            are, and this screen has no action to keep a `.page-head` for. */}

        <div className="hometiles">
          {narrow
            ? HOME_SECTIONS.map((id) => {
                const Icon = TILE_ICONS[id]
                return (
                  <button
                    key={id}
                    type="button"
                    className="hometile"
                    /* Same attribute the sidebar tabs carry, so the measuring and
                       screenshot scripts can reach these tiles by id rather than
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
              })
            : null}

          {HOME_FEATURES.map(({ id }) => {
            const Icon = FEATURE_ICONS[id]
            return (
              <button
                key={id}
                type="button"
                className="hometile"
                data-view={id}
                onClick={() => setOpen(id)}
              >
                <span className="hometile__icon">
                  <Icon size={22} />
                </span>
                <span className="hometile__label">{labelOf(id)}</span>
                <IconChevronRight size={16} className="hometile__chevron" />
              </button>
            )
          })}
        </div>
      </div>

      {/* One dialog, whichever tile is open. A dialog per tile would mount nine
          `Modal`s and nine lazy boundaries to show at most one. */}
      {open ? (
        <Modal
          open
          title={labelOf(open)}
          onClose={close}
          closeLabel={t('common.close')}
          fullscreen
          bodyClassName={isFeature(open) ? 'modal__body--settings' : 'modal__body--screen'}
        >
          <Suspense fallback={<Skeleton shape="list" rows={6} />}>
            {open === 'schedule' ? <ScheduleView onCompose={goCompose} /> : null}
            {open === 'contacts' ? <ContactsView /> : null}
            {open === 'templates' ? <TemplatesView onApplied={goCompose} /> : null}
            {open === 'workcal' ? <WorkCalendarView onCompose={goCompose} /> : null}
            {open === 'logs' ? <LogsView /> : null}
            {open === 'digest' ? <DigestCard /> : null}
            {open === 'greetings' ? <GreetingsCard /> : null}
            {open === 'calendarsub' ? <CalendarSubscribeCard /> : null}
            {open === 'pairing' ? <DevicesCard /> : null}
            {open === 'reliability' ? <ReliabilityView /> : null}
            {open === 'selfcheck' ? <SelfCheckPanel /> : null}
          </Suspense>
        </Modal>
      ) : null}
    </div>
  )
}
