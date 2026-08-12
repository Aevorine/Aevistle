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
 * ## Round 8: the seven are the user's, the eighth is the app's
 *
 * 主界面永远只有 8 格，但是 8 格的内容可以自己选择. Both halves of that sentence
 * are kept, and they are kept by different means. The count is structural —
 * `HOME_GRID_SLOTS` destinations plus 更多, and `sanitiseHomeGrid` guarantees
 * the first number no matter what comes out of `state.json`. The contents are
 * `Settings.homeGrid`, which when it exists beats the usage ranking outright
 * and is edited by holding any cell, or from the row 更多 carries for people
 * who never discover a gesture.
 *
 * What is *not* arrangeable is the eighth cell. 更多 is the only path to
 * whatever the seven left out, so a grid that could arrange it away is a grid
 * that can be arranged into one with four features behind no door at all. The
 * fixed eighth is what makes the other seven free: there is no arrangement of
 * them that can strand anything, so the editor needs no warnings, no minimum
 * set, and no "are you sure".
 *
 * Ranking still runs, and still freezes at launch, for every device that has
 * not arranged anything — which is all of them until somebody does. Clearing
 * the arrangement (`home.arrangeReset`) sets `homeGrid` back to `undefined`
 * rather than writing today's ranking out, because "never arranged" is a state
 * with behaviour of its own and a grid frozen into the shape it happened to
 * have at the moment of the reset would not have it.
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

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { Button, IconButton, Modal } from '../components/ui'
import { Skeleton } from '../components/Skeleton'
import { useReorder } from '../components/useReorder'
import { useI18n, type TranslationKey } from '../i18n'
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
  sanitiseHomeGrid,
  type HomeFeatureId,
  type ViewId,
} from '../core/nav'
import {
  IconActivity,
  IconCalendar,
  IconChevronRight,
  IconClock,
  IconEdit,
  IconFileText,
  IconFlag,
  IconFolder,
  IconGlobe,
  IconGrip,
  IconHome,
  IconInbox,
  IconKey,
  IconLink,
  IconMail,
  IconMore,
  IconSearch,
  IconSend,
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
 * The glyphs a cell can be given instead of the app's own.
 *
 * A closed list, not "any icon in `icons.tsx`". Two reasons, and the second is
 * the one that matters. The visible reason is that a picker has to fit a phone
 * dialog and sixteen 48px targets are four rows of four; the real one is that
 * `Settings.homeGridIcons` is persisted, synced and read by code newer than the
 * device that wrote it, so what goes in it has to be a name this file promises
 * to keep — not whatever export happened to exist the day it was chosen. An id
 * that is no longer here is ignored at render (see `glyphFor`), which leaves a
 * cell looking ordinary rather than leaving the settings file unreadable.
 *
 * Ids are plain words rather than the component names, so an icon can be
 * redrawn or renamed in `icons.tsx` without stranding every device that picked
 * it. They are never shown to the user translated — the button's accessible
 * name is the id, the same way the accent swatches in Settings are labelled by
 * their colour id, because sixteen translated glyph names in six languages is a
 * lot of prose to maintain for a control whose whole content is a picture.
 */
const HOME_CELL_ICONS: Array<{ id: string; Icon: (p: { size?: number }) => ReactElement }> = [
  { id: 'clock', Icon: IconClock },
  { id: 'calendar', Icon: IconCalendar },
  { id: 'users', Icon: IconUsers },
  { id: 'file', Icon: IconFileText },
  { id: 'activity', Icon: IconActivity },
  { id: 'star', Icon: IconStar },
  { id: 'link', Icon: IconLink },
  { id: 'shield', Icon: IconShield },
  { id: 'mail', Icon: IconMail },
  { id: 'send', Icon: IconSend },
  { id: 'inbox', Icon: IconInbox },
  { id: 'key', Icon: IconKey },
  { id: 'globe', Icon: IconGlobe },
  { id: 'folder', Icon: IconFolder },
  { id: 'flag', Icon: IconFlag },
  { id: 'home', Icon: IconHome },
]

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

/**
 * Which third of the day it is — for the greeting, and for the hero's tint.
 *
 * One function because they are one fact. The greeting used to read the clock
 * itself, and letting the tint read it a second time would have been two sets
 * of hour boundaries to keep in agreement: the arrangement where the band dims
 * at six and the words go on saying 下午好 until seven, which nobody notices
 * for a release and then nobody can explain.
 *
 * The 05:00 boundary is the one thing that moved. The greeting treated
 * everything before noon as morning, so 03:00 was 早上好 — harmless on its own,
 * but it would have made a feature whose entire job is to dim the screen at
 * night *lighten* it at three in the morning, which is the hour it exists for.
 * The small hours now greet you with 晚上好, which is also what they are.
 *
 * Read at render, like the greeting always was: nothing here re-renders Home on
 * the stroke of an hour, so a screen left open across the boundary keeps the
 * previous tint until something else touches it. That was already true of the
 * words and a timer to fix it would run all day to change one colour.
 */
type PartOfDay = 'morning' | 'day' | 'night'

function partOfDay(now = new Date()): PartOfDay {
  const h = now.getHours()
  if (h < 5) return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'day'
  return 'night'
}

/** Each third of the day names itself with the string it always used. */
const GREETING_KEY: Record<PartOfDay, TranslationKey> = {
  morning: 'home.greetMorning',
  day: 'home.greetAfternoon',
  night: 'home.greetEvening',
}

/**
 * How long a finger rests on a cell before the grid becomes arrangeable, and
 * how far it may travel first.
 *
 * The same 8px slop `useReorder` uses, for the same reason — a thumb that
 * travels was scrolling the page, and turning that into a mode change would
 * rearrange somebody's home screen because they scrolled with their thumb in
 * the wrong place. The hold is longer than that hook's 320ms because this
 * gesture is not the one the user is already in the middle of: a lift inside an
 * arrange dialog is expected, and entering the dialog from an ordinary tap
 * target is not, so it asks for more deliberation before it fires.
 */
const ARRANGE_HOLD_MS = 500
const ARRANGE_SLOP_PX = 8

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
  const [arranging, setArranging] = useState(false)
  /**
   * Which arrange row has its rename/icon editor open. At most one.
   *
   * One piece of state for the whole list rather than one flag per row, for the
   * same reason `SettingsView` holds one `openSection`: "two editors open at
   * once" is then not a thing that can happen, and on a 360px dialog eight open
   * editors would be a screen nobody can find the Done button on.
   */
  const [editingCell, setEditingCell] = useState<DestId | null>(null)

  const close = () => setOpen(null)

  /** Compose is a tab; reaching it means leaving Home, so the dialog closes first. */
  const goCompose = () => {
    close()
    onCompose()
  }

  const isFeature = (id: DestId): id is HomeFeatureId =>
    HOME_FEATURES.some((f) => f.id === id)

  /**
   * What the app calls a destination, in the current language.
   *
   * Kept separate from `labelOf` because the rename editor needs both: the
   * placeholder in the name field is this, so an empty field reads as "it will
   * be called what it is called" rather than as a blank nobody can interpret.
   */
  const defaultLabelOf = useCallback(
    (id: DestId) => {
      const feature = HOME_FEATURES.find((f) => f.id === id)
      if (feature) return t(feature.labelKey)
      const item = NAV.find((n) => n.id === id)
      return item ? t(item.labelKey) : id
    },
    [t],
  )

  /**
   * What *this device* calls it — the user's name if they gave one.
   *
   * Trimmed at read rather than at write. The field stores exactly what was
   * typed so that a space in the middle of a name survives being typed (a
   * write-time trim makes "工作 日历" impossible to enter: the trailing space is
   * removed the instant it lands and the next character joins the previous
   * word), and a name that is nothing but whitespace falls back to the default
   * instead of drawing an empty cell.
   *
   * Used everywhere, not only on the grid: the arrange dialog's picker, the
   * reorder announcements and the dialog titles all go through here, because a
   * cell somebody renamed to 验证码 that is still announced as 定时发送 is a
   * rename that only half happened.
   */
  const labelOf = useCallback(
    (id: DestId) => {
      const custom = state.settings.homeGridNames?.[id]?.trim()
      return custom || defaultLabelOf(id)
    },
    [defaultLabelOf, state.settings.homeGridNames],
  )

  /**
   * Which glyph a cell draws — the chosen one, or the app's own.
   *
   * An id that is not in `HOME_CELL_ICONS` any more falls through to the
   * default rather than rendering nothing: see the note on that list.
   */
  const glyphFor = useCallback(
    (id: DestId) => {
      const chosen = state.settings.homeGridIcons?.[id]
      const custom = chosen ? HOME_CELL_ICONS.find((i) => i.id === chosen)?.Icon : undefined
      return custom ?? iconFor(id)
    },
    [state.settings.homeGridIcons],
  )

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
     so the first read still sees the *restored* settings, not the defaults.

     Called unconditionally, even on a device that has arranged its own grid and
     will not use the answer: the freeze has to happen at launch to mean
     anything, and a device that clears its arrangement at four in the afternoon
     should fall back to the ranking as it stood this morning rather than to one
     computed from a day of taps that were made against a grid the ranking did
     not draw. */
  const ranked = useMemo(() => sessionOrder(state.settings.navUsage), [state.settings])

  /**
   * The seven, either chosen or ranked.
   *
   * `homeGrid` wins outright when it exists — see `Settings.homeGrid`. It is
   * put through `sanitiseHomeGrid` on every read rather than once on load
   * because this is where a retired id has to stop being a problem: the
   * arrangement is persisted, synced and older than the code reading it, and
   * the render is the last place that can decide to draw seven cells anyway.
   */
  const gridCells = useMemo(
    () =>
      state.settings.homeGrid
        ? sanitiseHomeGrid(state.settings.homeGrid, state.settings.navUsage)
        : ranked.slice(0, HOME_GRID_SLOTS),
    [ranked, state.settings.homeGrid, state.settings.navUsage],
  )
  /* Everything the eight did not take, in ranked order. Derived by subtraction
     rather than by `ranked.slice(HOME_GRID_SLOTS)`, which was only ever correct
     while the grid *was* the first seven of `ranked` — with a hand-made
     arrangement the slice would both hide destinations that are on the grid and
     lose ones that are not. This cannot: `ranked` is every destination there
     is, so the two halves always add back up to it. */
  const overflow = useMemo(
    () => ranked.filter((id) => !gridCells.includes(id)),
    [gridCells, ranked],
  )

  const setGrid = useCallback(
    (ids: DestId[]) => dispatch({ type: 'patchSettings', patch: { homeGrid: ids } }),
    [dispatch],
  )

  /**
   * Reordering the seven, by grip, by finger and by Alt+Arrow.
   *
   * The same hook the account list and the inbox tab strip use, so this screen
   * gets the touch long-press, the HTML5 mouse drag, the keyboard path and the
   * RTL flip without a line of its own — and, more to the point, when one of
   * those is fixed it is fixed here too. `disabled` while the dialog is closed
   * so no gesture is armed against a grid nobody is editing.
   *
   * Writing through `setGrid` means the first drag on a device that has never
   * arranged anything *creates* `homeGrid`, which is exactly right: the moment
   * somebody moves a cell they have made a decision, and usage ranking stops
   * being allowed to move it back.
   */
  const arrange = useReorder({
    ids: gridCells,
    onReorder: useCallback((ids: string[]) => setGrid(ids as DestId[]), [setGrid]),
    announce: useCallback(
      (id: string, position: number, total: number) =>
        t('home.arrangeMoved', { name: labelOf(id as DestId), n: position, total }),
      [labelOf, t],
    ),
    disabled: !arranging,
  })

  /**
   * Put `next` in cell `index`, and if it was already in another cell, put that
   * cell's occupant where `next` came from.
   *
   * A swap rather than an insert, because the count is the invariant: seven
   * slots, seven destinations, no duplicates, at every intermediate state and
   * not merely at the end. An "add" would need a matching "remove" and a rule
   * for what happens when the user adds an eighth — and the honest answer to
   * that is "one of the others has to go", which is a swap wearing two steps.
   * When `next` was not on the grid at all there is nothing to swap with and
   * the outgoing destination simply falls into 更多.
   */
  const swapCell = useCallback(
    (index: number, next: DestId) => {
      const cells = [...gridCells]
      const at = cells.indexOf(next)
      if (at === index) return
      const outgoing = cells[index]
      cells[index] = next
      if (at >= 0) cells[at] = outgoing
      setGrid(cells)
    },
    [gridCells, setGrid],
  )

  /* Back to undefined, not back to today's ranking written out. The difference
     is the whole feature — see `Settings.homeGrid` — because an arrangement
     that has been cleared has to start following use again, and a grid frozen
     into the shape it happened to have at the moment of the reset would not.

     All three maps, not just the order. "恢复默认" is one promise and it is the
     only one this dialog makes: a reset that put the cells back where they
     started but left them wearing names and icons somebody chose would be a
     screen that still does not look like a fresh install, with no remaining
     control that would make it so. Names and icons are sparse override maps,
     so clearing them is the same "never touched" state a new device is in —
     including the part where the names follow the language picker again. */
  const resetGrid = useCallback(
    () =>
      dispatch({
        type: 'patchSettings',
        patch: { homeGrid: undefined, homeGridNames: undefined, homeGridIcons: undefined },
      }),
    [dispatch],
  )

  /**
   * Rename a cell, or put its name back.
   *
   * An empty (or all-whitespace) name deletes the entry rather than storing
   * `''`, and the map itself goes back to `undefined` once the last entry
   * leaves. Both halves matter: "" would be a name, and would draw a cell with
   * no label; an empty object would be an arrangement that has been touched,
   * which is a different state from never having been touched — the same
   * distinction `Settings.homeGrid` turns on.
   */
  const setCellName = useCallback(
    (id: DestId, name: string) => {
      const next = { ...(state.settings.homeGridNames ?? {}) }
      if (name.trim()) next[id] = name
      else delete next[id]
      dispatch({
        type: 'patchSettings',
        patch: { homeGridNames: Object.keys(next).length > 0 ? next : undefined },
      })
    },
    [dispatch, state.settings.homeGridNames],
  )

  /** The same rule for the glyph. `undefined` means "the app's own icon". */
  const setCellIcon = useCallback(
    (id: DestId, icon: string | undefined) => {
      const next = { ...(state.settings.homeGridIcons ?? {}) }
      if (icon) next[id] = icon
      else delete next[id]
      dispatch({
        type: 'patchSettings',
        patch: { homeGridIcons: Object.keys(next).length > 0 ? next : undefined },
      })
    },
    [dispatch, state.settings.homeGridIcons],
  )

  /**
   * Hold a cell to arrange the grid.
   *
   * A shortcut, never the only way in — the 更多 sheet carries the same command
   * as an ordinary row, because a gesture nothing on screen mentions is a
   * feature only the person who wrote it has. What the hold buys is that the
   * cell you want to move is the cell you are already touching.
   *
   * One press at a time, so one ref for the whole grid rather than one per
   * cell. `held` outlives the timer deliberately: `click` fires after
   * `pointerup`, so without it every hold would also open the destination it
   * was held on and the arrange dialog would appear behind a full-screen one.
   */
  const holdRef = useRef<{ timer: number; x: number; y: number } | null>(null)
  const heldRef = useRef(false)
  const endHold = useCallback(() => {
    if (holdRef.current) window.clearTimeout(holdRef.current.timer)
    holdRef.current = null
  }, [])
  /* A pending hold that outlives this screen would fire `setArranging` on an
     unmounted component every time somebody taps a cell and switches tabs. */
  useEffect(() => endHold, [endHold])

  const holdProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      heldRef.current = false
      endHold()
      holdRef.current = {
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          holdRef.current = null
          heldRef.current = true
          setArranging(true)
        }, ARRANGE_HOLD_MS),
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const held = holdRef.current
      if (!held) return
      const far =
        Math.abs(event.clientX - held.x) > ARRANGE_SLOP_PX ||
        Math.abs(event.clientY - held.y) > ARRANGE_SLOP_PX
      if (far) endHold()
    },
    onPointerUp: endHold,
    onPointerCancel: endHold,
    onPointerLeave: endHold,
    /* Android offers to select the label's text on a long press, on top of the
       dialog the same press is opening. The CSS half of this is already on
       `.reorder-handle`; a grid cell is a button, so this half is enough. */
    onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
  }

  /** The tap that a hold has already answered is not also a tap. */
  const unlessHeld = (run: () => void) => () => {
    if (heldRef.current) {
      heldRef.current = false
      return
    }
    run()
  }

  /*
   * The all-time `sentCount` and `errorCount` that fed the three tiles are
   * gone with the tiles — see `todaySent` below for what replaced them and
   * why. The predicates they used are not lost: `todaySent` is the same
   * `kind === 'send' && level !== 'error'` test and `todayFailed` the same
   * `level === 'error'`, each narrowed to the current day, so a figure and the
   * list it opens still cannot disagree about what the number meant.
   */

  /**
   * The two figures the top of the hero now states, both scoped to today.
   *
   * They replace a greeting, and the reason is that 早上好 is the one line on
   * this screen that is true whatever the app is doing: it says nothing about
   * whether anything is about to go out, and nothing about whether anything
   * broke overnight. Those are the two things somebody opening a mail app on a
   * phone in the morning actually needs, and until now the only place either
   * was stated was a tile captioned with an all-time total.
   *
   * Both are counted off sources already on this screen, deliberately — no new
   * store, no new derivation, nothing that can disagree with what tapping the
   * figure opens:
   *
   *   queued today  `state.jobs`, exactly as the "coming up" list below
   *                 computes it — enabled jobs whose next occurrence is today.
   *                 Paused jobs are excluded there and are excluded here, for
   *                 the same reason: a paused reminder has occurrences and is
   *                 not going to fire.
   *   failed today  `state.logs` filtered by `level === 'error'`, which is the
   *                 same predicate the third stat tile uses, narrowed to today.
   *
   * "Today" is a calendar day compared as local midnights (`daysAhead`), not a
   * rolling 24 hours: the word means the day you are in, and a reminder set for
   * 07:00 tomorrow is not "in 15 hours", it is tomorrow.
   *
   * Tapping either opens the screen that holds the underlying records — the
   * schedule for the first, the log for the second. Neither of those screens is
   * *filtered* to today, which is a real limitation and is why the figures are
   * captioned rather than left as bare numbers: the number says today, and what
   * opens is the full list it was counted from, newest first.
   */
  const todayQueued = useMemo(() => {
    const now = Date.now()
    return state.jobs.filter((j) => {
      if (!j.enabled) return false
      const at = j.occurrences.find((o) => o >= now)
      return at !== undefined && daysAhead(at, now) === 0
    }).length
  }, [state.jobs])

  const todayFailed = useMemo(() => {
    const now = Date.now()
    return state.logs.filter((l) => l.level === 'error' && daysAhead(l.at, now) === 0).length
  }, [state.logs])

  /**
   * Sent today — the third figure, and the one that let the tile strip go.
   *
   * The hero stated two facts about today and the strip underneath it stated
   * three all-time totals, and two of the five were the same fact twice in two
   * visual languages: "今天要发 0 封" over "0 待发", "今天失败 0 次" over
   * "0 错误". Screenshotted at 360px, that is one screen saying one thing twice
   * in an 18.67px sentence and a 20px/14px tile, which is exactly the drift
   * this round is meant to remove.
   *
   * So the strip goes and its one unduplicated figure — sends that went out —
   * joins the other two, scoped to today like them. Same predicate as
   * `sentCount` above, narrowed by `daysAhead`, so the two cannot disagree.
   * The all-time totals are not lost: every figure still opens the screen that
   * holds the records, and those screens are the full lists.
   */
  const todaySent = useMemo(() => {
    const now = Date.now()
    return state.logs.filter(
      (l) => l.kind === 'send' && l.level !== 'error' && daysAhead(l.at, now) === 0,
    ).length
  }, [state.logs])

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

  /* One reading of the clock, spent twice: on the words and on the band's tint
     — see `partOfDay`. */
  const tod = partOfDay()

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
    /* `glyphFor`, not `iconFor`: a destination somebody renamed and re-iconed
       on the grid has to look the same in 更多 and on the desktop list, or the
       same feature is two different things depending on which door you use. */
    const Icon = glyphFor(id)
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
            {/* `data-tod` is read by 21-home-grid.css, which mixes the band's
                colour off `--accent` accordingly — the tint and the greeting
                are one fact and are stamped from one variable. */}
            <header className="homehero" aria-label={t('nav.home')} data-tod={tod}>
              <div className="homehero__top">
                {/*
                  What the top line says, and why it stopped being a greeting.

                  早上好 is true at 07:00 whatever the app is doing. These two
                  figures are not: they are how many sends are set for today and
                  how many things failed today, and they are the two facts that
                  decide whether this screen needs anything from you. The
                  greeting keeps its words and moves down one line, where the
                  sub-line was — it is still worth saying, it was just never
                  worth the loudest line on the screen.

                  Each figure is a button, and each opens the screen that holds
                  the records it was counted from — the schedule, and the log.
                  That is the rule the three tiles below already follow, and the
                  reason neither of these is allowed to be a number this screen
                  computed on its own: a figure you cannot press through to is a
                  figure nobody can check.

                  The failures button is drawn the same whether the count is
                  zero or nine, and it is drawn at all when it is zero. "0 failed
                  today" is information — it is the answer to the question the
                  person is opening the app with — and a control that appears
                  only on bad days is one nobody learns the position of.
                */}
                <p className="homehero__today">
                  <button
                    type="button"
                    className="homehero__fact"
                    onClick={() => openDest('schedule')}
                  >
                    {t('home.todayQueued', { n: todayQueued })}
                  </button>
                  <button
                    type="button"
                    className="homehero__fact"
                    onClick={() => openDest('logs')}
                  >
                    {t('home.todaySent', { n: todaySent })}
                  </button>
                  <button
                    type="button"
                    className="homehero__fact"
                    data-alert={todayFailed > 0 || undefined}
                    onClick={() => openDest('logs')}
                  >
                    {t('home.todayFailed', { n: todayFailed })}
                  </button>
                </p>
                <button
                  type="button"
                  className="homehero__search"
                  aria-label={t('palette.open')}
                  onClick={onOpenPalette}
                >
                  <IconSearch size={19} />
                </button>
              </div>
              {/* The greeting, at the rank it is worth: one line of ordinary
                  body type under the two figures that are not. */}
              <p className="homehero__sub">{t(GREETING_KEY[tod])}</p>
              {/* The three all-time tiles that used to sit here are gone; see
                  `todaySent` for the measurement. Two of the three repeated a
                  figure the line above already states, and the third is now up
                  there with them, scoped to today like its neighbours. */}
            </header>

            <nav className="homegrid" aria-label={t('nav.home')}>
              {gridCells.map((id) => {
                const Icon = glyphFor(id)
                return (
                  <button
                    key={id}
                    type="button"
                    className="homegrid__cell"
                    data-view={id}
                    onClick={unlessHeld(() => openDest(id))}
                    {...holdProps}
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
                onClick={unlessHeld(() => setMoreOpen(true))}
                {...holdProps}
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
            {/*
              The discoverable half of "hold a cell to arrange".

              It is here, and not beside the greeting, because the hero's one
              trailing action is a contract this screen keeps in place of
              `PageHead` — see the note on the header — and a second button up
              there would break the thing the exception was granted for. 更多 is
              the permanent eighth cell and is already the answer to "where is
              the rest of it", which makes it the one place a person looking for
              a way to change the grid will certainly open.
            */}
            <button
              type="button"
              className="hometile"
              data-view="arrange"
              onClick={() => {
                setMoreOpen(false)
                setArranging(true)
              }}
            >
              <span className="hometile__icon">
                <IconEdit size={22} />
              </span>
              <span className="hometile__label">{t('home.arrangeOpen')}</span>
              <IconChevronRight size={16} className="hometile__chevron" />
            </button>
            {overflow.length === 0 ? (
              <p className="homemod__empty">{t('home.moreEmpty')}</p>
            ) : (
              overflow.map((id) => tileRow(id))
            )}
          </div>
        </Modal>
      ) : null}

      {/*
        Arranging the eight.

        A list, not the grid it edits — see `.homearrange` in
        21-home-grid.css for why eight 82px cells are the wrong shape for
        choosing between eleven names in six languages. Each row is one cell, in
        the order the cells are drawn: a grip that moves it and a picker that
        says what it is.

        The eighth row is 更多 and it is inert. That is the design decision this
        feature turns on: the seven are the user's, the door is the app's. A
        grid where 更多 could be swapped out is a grid that can be arranged into
        one with no way to reach the four destinations it left behind — and a
        hub whose contents can be made unreachable from inside the hub is not a
        hub. Keeping the eighth cell fixed is what makes the other seven safe to
        rearrange without a single "are you sure".
      */}
      {arranging ? (
        <Modal
          open
          title={t('home.arrangeTitle')}
          /* The open editor closes with the dialog. Left set, re-opening the
             arranger would show one row already expanded for a reason that
             happened three days ago. */
          onClose={() => {
            setEditingCell(null)
            setArranging(false)
          }}
          closeLabel={t('common.close')}
          fullscreen
          bodyClassName="modal__body--settings"
          footer={
            <>
              {/* Order, names and icons all at once — see `resetGrid`. */}
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingCell(null)
                  resetGrid()
                }}
              >
                {t('home.arrangeReset')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setEditingCell(null)
                  setArranging(false)
                }}
              >
                {t('common.done')}
              </Button>
            </>
          }
        >
          <p className="homemod__empty">{t('home.arrangeHint')}</p>
          {/* Outside the list it describes, so that reordering the rows cannot
              unmount the live region mid-announcement — the same reasoning as
              the account list's, which is the other caller of this hook. */}
          <span className="sr-only" role="status" aria-live="polite">
            {arrange.announcement}
          </span>
          <div className="homearrange">
            {gridCells.map((id, index) => (
              <div key={id} className="homearrange__row reorder-row" {...arrange.itemProps(id)}>
                <span className="homearrange__n" aria-hidden="true">
                  {index + 1}
                </span>
                {/*
                  A real button, in the tab order, not a decorated span. It is
                  the only way the arrow-key path is reachable at all, and a
                  grid that can only be dragged is a grid a screen-reader user
                  cannot arrange — see the same grip in `SettingsView`.

                  `aria-keyshortcuts` rather than an entry in `Shortcuts.tsx`:
                  that panel documents chords the global matcher answers, and
                  `check-shortcuts.mjs` proves each of them by feeding it to
                  `matchShortcut`. Alt+Arrow here is answered by whichever grip
                  has focus and by nothing at all otherwise.
                */}
                <button
                  type="button"
                  className="reorder-handle"
                  aria-label={t('home.arrangeHandle', { name: labelOf(id) })}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  {...arrange.handleProps(id)}
                >
                  <IconGrip size={16} />
                </button>
                {/*
                  A native select, so the whole list of destinations is one tap
                  and one control rather than a picker of its own — and so the
                  keyboard and the screen reader get it for free. Choosing one
                  that is already in another cell swaps the two; see `swapCell`.
                */}
                <select
                  className="select homearrange__pick"
                  value={id}
                  aria-label={t('home.arrangeSlot', { n: index + 1 })}
                  onChange={(event) => swapCell(index, event.target.value as DestId)}
                >
                  {ranked.map((dest) => (
                    <option key={dest} value={dest}>
                      {labelOf(dest)}
                    </option>
                  ))}
                </select>
                {/*
                  The second thing a cell can be: not only *which* destination,
                  but what it is called and what it looks like.

                  A disclosure inside the row rather than a dialog of its own.
                  Eight rows each opening a modal on top of a modal is two close
                  buttons deep on a phone, and the thing being edited — this row
                  — would be behind the thing editing it. Inline, the row you are
                  changing stays on screen and stays the row you held.
                */}
                <IconButton
                  label={t('home.cellEdit', { name: labelOf(id) })}
                  aria-expanded={editingCell === id}
                  onClick={() => setEditingCell(editingCell === id ? null : id)}
                >
                  <IconEdit size={16} />
                </IconButton>

                {editingCell === id ? (
                  <div className="homearrange__editor">
                    <label className="homearrange__field">
                      <span className="homearrange__fieldLabel">{t('home.cellName')}</span>
                      {/*
                        The app's own name is the placeholder, not the value.
                        An empty field then reads as "it will be called what it
                        is called" — and clearing the field is how you undo a
                        rename, which is the only undo this editor needs.

                        `maxLength` because the grid label is one line that
                        ellipsises: past about sixteen characters every cell
                        shows the same three dots and the rename has stopped
                        being a rename. Not a floor being lowered — the cell was
                        always one line.
                      */}
                      <input
                        className="input"
                        type="text"
                        maxLength={16}
                        value={state.settings.homeGridNames?.[id] ?? ''}
                        placeholder={defaultLabelOf(id)}
                        onChange={(event) => setCellName(id, event.target.value)}
                      />
                    </label>

                    <div className="homearrange__field">
                      <span className="homearrange__fieldLabel">{t('home.cellIcon')}</span>
                      <div className="homearrange__icons">
                        {/*
                          The first swatch is the app's own icon and it is how
                          the choice is undone. A toggle on the selected swatch
                          would have been fewer controls and an undo nobody can
                          see; this way "put it back" is a thing on the screen.
                        */}
                        {(() => {
                          const Default = iconFor(id)
                          return (
                            <button
                              type="button"
                              className="homearrange__icon"
                              aria-pressed={!state.settings.homeGridIcons?.[id]}
                              aria-label={t('home.cellIconDefault')}
                              title={t('home.cellIconDefault')}
                              onClick={() => setCellIcon(id, undefined)}
                            >
                              {Default ? <Default size={20} /> : <IconStar size={20} />}
                            </button>
                          )
                        })()}
                        {HOME_CELL_ICONS.map(({ id: iconId, Icon }) => (
                          <button
                            key={iconId}
                            type="button"
                            className="homearrange__icon"
                            aria-pressed={state.settings.homeGridIcons?.[id] === iconId}
                            /* The id, untranslated — the same choice the accent
                               swatches in Settings make, and for the same
                               reason. See `HOME_CELL_ICONS`. */
                            aria-label={iconId}
                            title={iconId}
                            onClick={() => setCellIcon(id, iconId)}
                          >
                            <Icon size={20} />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="homearrange__row homearrange__row--fixed">
              <span className="homearrange__n" aria-hidden="true">
                {HOME_GRID_SLOTS + 1}
              </span>
              <span className="homearrange__fixedlabel">{t('home.arrangeMoreFixed')}</span>
            </div>
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
