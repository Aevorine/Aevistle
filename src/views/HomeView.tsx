/**
 * The hub — a phone's only door to five screens, and every platform's door to
 * six features that used to live only inside Settings.
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
 * `HOME_FEATURES` (six: the daily digest, holiday greetings, publishing the
 * working calendar for subscription, pairing, the reliability report and the
 * self-check) are different in kind. They were never screens — no tab anywhere
 * has ever pointed at them — they were sections on the Settings screen,
 * reachable only by opening Settings and scrolling or jumping to the right
 * one. That was a real report: on a desktop the sections all still exist and
 * still work, but nothing to do with "have I sent today's summary" or "is my
 * calendar shared" belongs conceptually inside a *preferences* screen, and
 * finding out meant knowing Settings was where to look. These tiles are drawn
 * unconditionally, phone or desktop, because unlike the five above they have
 * never had a dedicated door anywhere else.
 *
 * ## Round 6: on a phone this is a grid, not a list
 *
 * The eleven destinations above used to be eleven identical rows in a
 * scroller. Eleven rows of one shape say nothing about which of them matters,
 * and the list grew by one every time a feature was added — which is precisely
 * the failure the user named: 未来新置功能不会影响界面美感.
 *
 * A list has no capacity, so it cannot make that promise. A grid can. The
 * phone layout is now a coloured hero, three figures, and **eight cells:
 * seven destinations ranked by `Settings.navUsage` and an eighth that is
 * permanently 更多** (`HOME_GRID_SLOTS`, `rankHomeDestinations`). The screen's
 * height and layout no longer depend on how many destinations exist, so a
 * twelfth or a fortieth changes which seven are on top and nothing else. That
 * is the promise, expressed as a bound rather than as an intention.
 *
 * Two things keep the grid still. The ranking is stable on ties (see
 * `rankHomeDestinations`), so a fresh install shows `HOME_GRID_ORDER` and two
 * equally-used destinations keep yesterday's relative order. And the order is
 * frozen at launch (see `sessionOrder` below), so today's taps rank tomorrow's
 * grid rather than rearranging it under the finger that just tapped. A grid
 * whose contents move unbidden is one nobody builds muscle memory for, which
 * would cost more than the ranking buys.
 *
 * A desktop keeps the tile list unchanged. It has a nine-tab sidebar for the
 * five screens and plenty of width for the rest, so it has neither the problem
 * the grid solves nor the 360px constraint that shaped it.
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
 * All of them read their own state through `useApp()` — none takes a prop —
 * which is what lets the very same component mount here and inside
 * `SettingsSection` in `SettingsView.tsx` without either caller threading
 * state through the other.
 *
 * ## Why dialogs rather than navigation
 *
 * Opening a tile as an ordinary view would leave the user on a screen whose
 * tab is not lit on the sidebar (five of eleven) or that has no tab at all
 * (all six `HOME_FEATURES`), with "back" meaning whatever the previous tab
 * was. A dialog has an unambiguous close button and returns exactly to this
 * screen, which is the behaviour a hub implies. It also keeps each tile's
 * state alive for exactly as long as it is open — closing the log frees its
 * list, closing the digest tile drops its preview.
 *
 * `bodyClassName` picks between two treatments a `Modal` can give its body,
 * both already defined for `SettingsSection`'s own dialogs:
 * `modal__body--screen` for the five real screens, which already draw their
 * own padding and their own sticky heading and would otherwise get both a
 * second time; `modal__body--settings` for the features, which are Cards that
 * already draw their own frame and whose own title line is hidden by that
 * class so it does not repeat the dialog's header two lines below it.
 */

import { lazy, Suspense, useMemo, useState, type ReactElement } from 'react'
import { Modal } from '../components/ui'
import { Skeleton } from '../components/Skeleton'
import { useI18n } from '../i18n'
import { useApp } from '../state/AppState'
/*
 * `HOME_SECTIONS` is deliberately not imported any more. The grid reaches the
 * five screens through `HOME_GRID_ORDER`, which names those five plus the six
 * features in one ranked list — two lists that had to be kept in agreement
 * were the previous shape, and `HOME_GRID_ORDER` replaces both for this
 * screen's purposes. `HOME_SECTIONS` still exists and is still the answer to
 * "which screens does a phone lose from its tab bar"; it simply is no longer
 * what decides what is drawn here.
 */
import {
  HOME_FEATURES,
  HOME_GRID_SLOTS,
  NAV,
  rankHomeDestinations,
  type HomeFeatureId,
  type ViewId,
} from '../core/nav'
import {
  IconActivity,
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconFileText,
  IconLink,
  IconMore,
  IconSearch,
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

type DestId = ViewId | HomeFeatureId

/** Icons for the five `HOME_SECTIONS` tiles, keyed by the same ids. */
const TILE_ICONS: Partial<Record<ViewId, (p: { size?: number }) => ReactElement>> = {
  schedule: IconClock,
  contacts: IconUsers,
  templates: IconFileText,
  workcal: IconCalendar,
  logs: IconActivity,
}

/** Icons for the six `HOME_FEATURES` tiles, keyed by the same ids. */
const FEATURE_ICONS: Record<HomeFeatureId, (p: { size?: number }) => ReactElement> = {
  digest: IconFileText,
  greetings: IconStar,
  calendarsub: IconCalendar,
  pairing: IconLink,
  reliability: IconShield,
  selfcheck: IconActivity,
}

/** One lookup over both maps — the grid does not care which kind an id is. */
function iconFor(id: DestId): ((p: { size?: number }) => ReactElement) | undefined {
  return FEATURE_ICONS[id as HomeFeatureId] ?? TILE_ICONS[id as ViewId]
}

/**
 * The grid order, decided once per app launch and then frozen.
 *
 * `rankHomeDestinations` is a pure function of `navUsage`, and `navUsage`
 * changes the instant a cell is tapped — so ranking on every render would
 * reorder the grid *while the dialog that tap opened is still on screen*, and
 * the cells would be somewhere else when it closed. On a fresh install, where
 * every count is zero, the first tap on the third cell moves it to the front.
 * That is the exact failure the ranking is supposed to avoid: a grid people
 * stop building muscle memory for because it moves under them.
 *
 * So the order is read once, at the first render after launch, and held for
 * the life of the process. Today's taps rank tomorrow's grid. Module scope
 * rather than component state because this screen unmounts every time you
 * switch tabs — `useState` would re-freeze a *new* order on every return to
 * Home, which is the same problem at a slower tempo.
 */
let frozenOrder: DestId[] | null = null
function sessionOrder(usage: Record<string, number> | undefined): DestId[] {
  frozenOrder ??= rankHomeDestinations(usage)
  return frozenOrder
}

const DAY_MS = 86_400_000

/**
 * Which calendar day `at` falls on, relative to now: 0 today, 1 tomorrow, more
 * beyond. Compared as local midnights rather than by dividing the difference,
 * so 23:30 → 00:30 is "tomorrow" (six hours later, one day on) rather than
 * "today", which is what the reader means by the word.
 */
function daysAhead(at: number, now: number): number {
  const a = new Date(at)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

export function HomeView({
  onCompose,
  armedCount,
  narrow,
  onOpenPalette,
}: {
  /**
   * Both the schedule and the calendar can start a new reminder, and both then
   * need the compose screen — which is a *tab*, not something this hub can put
   * in a dialog on top of itself. So the request is passed up, and the caller
   * closes whatever is open by navigating away from Home entirely.
   */
  onCompose: () => void
  /** Drawn as the first of the three figures, and as the schedule cell's badge. */
  armedCount: number
  /**
   * Whether this is the phone layout.
   *
   * True on a phone, where the five `HOME_SECTIONS` have nowhere else to be
   * reached from — that is the reason this screen exists at all, see the
   * module doc — and where the grid replaces the tile list. False on a
   * desktop, where each of the five already has its own sidebar tab, so
   * drawing them again here would be a second, redundant door to five places
   * one click away already.
   */
  narrow: boolean
  /**
   * Opens the Ctrl+K command palette.
   *
   * The shortcut itself is unreachable on Android — there is no keyboard —
   * which left the one platform whose home screen folds five other screens
   * behind this hub with no way to search any of them. Drawn only when
   * `narrow` is true: a desktop already has Ctrl+K on a real keyboard, so a
   * second, on-screen door to the same dialog there would be a button with
   * nothing to add.
   */
  onOpenPalette: () => void
}) {
  const { t, formatDateTime } = useI18n()
  const { state, dispatch } = useApp()
  const [open, setOpen] = useState<DestId | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)

  const close = () => setOpen(null)

  /** Compose is a tab; reaching it means leaving Home, so the dialog closes first. */
  const goCompose = () => {
    close()
    onCompose()
  }

  const isFeature = (id: DestId): id is HomeFeatureId =>
    HOME_FEATURES.some((f) => f.id === id)

  const labelOf = (id: DestId) => {
    const feature = HOME_FEATURES.find((f) => f.id === id)
    if (feature) return t(feature.labelKey)
    const item = NAV.find((n) => n.id === id)
    return item ? t(item.labelKey) : id
  }

  /**
   * Open a destination and record that it was opened.
   *
   * The count is what ranks the grid tomorrow — see `Settings.navUsage`. It is
   * written on open rather than on close so a tile that is opened and
   * immediately dismissed still counts: the user went looking for it, which is
   * the signal being measured, and whether they found what they wanted is a
   * different question this ranking is not trying to answer.
   *
   * `navUsage` is not one of the appearance keys, so this patch does not stamp
   * `appearanceUpdatedAt` or push anything over the sync scope — see the
   * appearance-key list in `state/AppState.tsx`.
   */
  const openDest = (id: DestId) => {
    const usage = state.settings.navUsage
    dispatch({
      type: 'patchSettings',
      patch: { navUsage: { ...usage, [id]: (usage?.[id] ?? 0) + 1 } },
    })
    setMoreOpen(false)
    setOpen(id)
  }

  /* Frozen at launch on purpose — see `sessionOrder`. The dependency is the
     settings object rather than `navUsage` because the freeze happens inside
     and this only has to run once; it is here rather than at module top level
     so the first read still sees the *restored* settings, not the defaults. */
  const ranked = useMemo(() => sessionOrder(state.settings.navUsage), [state.settings])
  const gridCells = ranked.slice(0, HOME_GRID_SLOTS)
  const overflow = ranked.slice(HOME_GRID_SLOTS)

  /*
   * Sends and errors, counted off the same log the 发送记录 screen shows — so
   * tapping a figure and reading the list it opens can never disagree about
   * what the number meant. `kind === 'send'` alone would count failed sends as
   * successes; `level === 'error'` alone would miss nothing but also spans
   * kinds other than sends, which is correct for a figure captioned "errors".
   */
  const sentCount = useMemo(
    () => state.logs.filter((l) => l.kind === 'send' && l.level !== 'error').length,
    [state.logs],
  )
  const errorCount = useMemo(() => state.logs.filter((l) => l.level === 'error').length, [state.logs])

  /*
   * The next three sends, soonest first.
   *
   * `occurrences` is precomputed and ascending (see `ScheduledJob`), so the
   * first entry at or after now is this job's next fire — no recurrence maths
   * happens here. Paused jobs are excluded because a paused reminder has
   * occurrences but is not going to fire, and a list captioned "coming up"
   * that includes it would be lying.
   */
  const upcoming = useMemo(() => {
    const now = Date.now()
    return state.jobs
      .filter((j) => j.enabled)
      .map((j) => ({
        id: j.id,
        name: j.name,
        at: j.occurrences.find((o) => o >= now),
        /* The second line. Addresses rather than a restatement of the badge —
           see the note where it is rendered. */
        to: (j.draft?.to ?? []).join(', '),
      }))
      .filter((x): x is { id: string; name: string; at: number; to: string } => x.at !== undefined)
      .sort((a, b) => a.at - b.at)
      .slice(0, 3)
  }, [state.jobs])

  const greeting = () => {
    const h = new Date().getHours()
    if (h < 12) return t('home.greetMorning')
    if (h < 18) return t('home.greetAfternoon')
    return t('home.greetEvening')
  }

  /**
   * The two-line badge on an upcoming row: which day, then the clock time.
   *
   * Day and month only past tomorrow, not `dateStyle: 'short'`. Measured, that
   * style renders "2026/8/15" in zh-CN, which made the third badge half again
   * as wide as the two above it — a column that stops being a column, and
   * exactly the kind of drift this round exists to remove. The year is not
   * information here: everything in this list is within the scheduling horizon,
   * and if it were not, the row above it would say so.
   *
   * Both styles have to be cancelled explicitly. `formatDateTime` merges
   * `{dateStyle: 'medium', timeStyle: 'short'}` in as defaults, and `Intl`
   * throws `TypeError: Invalid option` when either style is combined with a
   * component option like `month` — the spec allows one spelling or the other,
   * never both. Left in, that is not a wrong-looking badge, it is an exception
   * out of the render that takes the whole screen down to its error boundary,
   * and only for someone whose next reminder is more than a day out.
   */
  const whenBadge = (at: number) => {
    const ahead = daysAhead(at, Date.now())
    const day =
      ahead === 0
        ? t('workcal.today')
        : ahead === 1
          ? t('home.tomorrow')
          : formatDateTime(at, {
              dateStyle: undefined,
              timeStyle: undefined,
              month: 'numeric',
              day: 'numeric',
            })
    return { day, time: formatDateTime(at, { timeStyle: 'short', dateStyle: undefined }) }
  }

  /** The row shape the desktop keeps, and the 更多 sheet reuses. */
  const tileRow = (id: DestId) => {
    const Icon = iconFor(id)
    return (
      <button
        key={id}
        type="button"
        className="hometile"
        /* Same attribute the sidebar tabs carry, so the measuring and
           screenshot scripts can reach these by id rather than a label that
           changes with the language. */
        data-view={id}
        onClick={() => openDest(id)}
      >
        <span className="hometile__icon">{Icon ? <Icon size={22} /> : null}</span>
        <span className="hometile__label">{labelOf(id)}</span>
        {/* No count badge here. The one destination that carries a count is
            `schedule`, and neither caller of this row draws it: the desktop
            list is `HOME_FEATURES` only (the five screens have sidebar tabs of
            their own), and 更多 holds whatever fell past the grid's seventh
            cell — where a count would be a number nobody can see. The grid
            cell draws it instead. */}
        <IconChevronRight size={16} className="hometile__chevron" />
      </button>
    )
  }

  return (
    <div className={narrow ? 'view view--home view--home-grid' : 'view view--home'}>
      <div className="view__inner">
        {narrow ? (
          <>
            {/*
              No `PageHead` here, and that is a deliberate exception to "all six
              views render this". `PageHead` paints its own `--bg` bar and adds
              its own palette button from `PaletteContext` — inside a coloured
              hero that came out as a white stripe across the top of the accent
              block with two identical magnifiers in it, one from the context
              and one from this screen's own `action`.

              What `PageHead` exists to guarantee is that every screen names
              itself once, in the same rank, in the same place, with one trailing
              action. This hero keeps that contract by other means: the greeting
              is the heading, `aria-label` names the screen for a screen reader
              the way `hideTitle` did, and there is exactly one action, at the
              trailing edge, where `PageHead` would have put it.
            */}
            <header className="homehero" aria-label={t('nav.home')}>
              <div className="homehero__top">
                <p className="homehero__greet">{greeting()}</p>
                <button
                  type="button"
                  className="homehero__search"
                  aria-label={t('palette.open')}
                  onClick={onOpenPalette}
                >
                  <IconSearch size={19} />
                </button>
              </div>
              <p className="homehero__sub">
                {armedCount > 0 ? t('home.heroArmed', { n: armedCount }) : t('home.heroClear')}
              </p>
              <div className="homestats">
                <button type="button" className="homestat" onClick={() => openDest('schedule')}>
                  <span className="homestat__n">{armedCount}</span>
                  <span className="homestat__k">{t('home.statArmed')}</span>
                </button>
                <button type="button" className="homestat" onClick={() => openDest('logs')}>
                  <span className="homestat__n">{sentCount}</span>
                  <span className="homestat__k">{t('home.statSent')}</span>
                </button>
                <button type="button" className="homestat" onClick={() => openDest('logs')}>
                  <span className="homestat__n">{errorCount}</span>
                  <span className="homestat__k">{t('home.statErrors')}</span>
                </button>
              </div>
            </header>

            <nav className="homegrid" aria-label={t('nav.home')}>
              {gridCells.map((id) => {
                const Icon = iconFor(id)
                return (
                  <button
                    key={id}
                    type="button"
                    className="homegrid__cell"
                    data-view={id}
                    onClick={() => openDest(id)}
                  >
                    <span className="homegrid__plate">
                      {Icon ? <Icon size={21} /> : null}
                      {id === 'schedule' && armedCount > 0 ? (
                        <span className="homegrid__badge">{armedCount > 99 ? '99+' : armedCount}</span>
                      ) : null}
                    </span>
                    <span className="homegrid__label">{labelOf(id)}</span>
                  </button>
                )
              })}
              {/* Always the eighth cell, even when nothing has overflowed into
                  it — a grid whose last cell appears and disappears with the
                  feature count is the shape-changes-with-content problem this
                  layout exists to remove. With an empty overflow it opens a
                  sheet that says so, which is a truthful empty state rather
                  than a missing control. */}
              <button
                type="button"
                className="homegrid__cell homegrid__cell--more"
                data-view="more"
                onClick={() => setMoreOpen(true)}
              >
                <span className="homegrid__plate">
                  <IconMore size={21} />
                </span>
                <span className="homegrid__label">{t('home.more')}</span>
              </button>
            </nav>

            <section className="homemod">
              <div className="homemod__head">
                <h2 className="homemod__title">{t('home.upcoming')}</h2>
                <button type="button" className="homemod__more" onClick={() => openDest('schedule')}>
                  {t('home.upcomingAll', { n: armedCount })}
                </button>
              </div>
              {upcoming.length === 0 ? (
                <p className="homemod__empty">{t('home.upcomingEmpty')}</p>
              ) : (
                upcoming.map((u) => {
                  const w = whenBadge(u.at)
                  return (
                    <button
                      key={u.id}
                      type="button"
                      className="homemod__row"
                      onClick={() => openDest('schedule')}
                    >
                      <span className="homemod__when">
                        <span>{w.day}</span>
                        <b>{w.time}</b>
                      </span>
                      <span className="homemod__text">
                        <span className="homemod__t1">{u.name}</span>
                        {/* Who it goes to, not when it goes — the badge to the
                            left already says when, and a second line that
                            repeated it in longhand ("今天 16:48" beside
                            "2026 年 8 月 12 日 16:48") was two lines spending
                            themselves on one fact. Falls back to the full date
                            only when there is nobody to name, which is the one
                            case where it is not a repetition. */}
                        <span className="homemod__t2">
                          {u.to || formatDateTime(u.at, { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                      </span>
                      <IconChevronRight size={16} />
                    </button>
                  )
                })
              )}
            </section>
          </>
        ) : (
          <div className="hometiles">
            {/* A desktop reaches all five `HOME_SECTIONS` from its own sidebar
                tabs, so only the features are drawn here — unchanged from
                before this screen grew a phone layout. */}
            {HOME_FEATURES.map(({ id }) => tileRow(id))}
          </div>
        )}
      </div>

      {/* Everything the grid had no room for. Deliberately the row shape rather
          than a second grid: a grid says "these are the important ones", and by
          construction these are the ones that are not. */}
      {moreOpen ? (
        <Modal
          open
          title={t('home.moreTitle')}
          onClose={() => setMoreOpen(false)}
          closeLabel={t('common.close')}
          fullscreen
          bodyClassName="modal__body--settings"
        >
          <div className="homemore">
            {overflow.length === 0 ? (
              <p className="homemod__empty">{t('home.moreEmpty')}</p>
            ) : (
              overflow.map((id) => tileRow(id))
            )}
          </div>
        </Modal>
      ) : null}

      {/* One dialog, whichever tile is open. A dialog per tile would mount
          eleven `Modal`s and eleven lazy boundaries to show at most one. */}
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
