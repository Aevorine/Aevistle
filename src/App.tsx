import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ComposeView } from './views/ComposeView'
import { AppProvider, useApp } from './state/AppState'
import { I18nContext, useI18n } from './i18n'
import { Banner, IconButton, ToastProvider, useToast } from './components/ui'
import { ShortcutsDialog, matchShortcut } from './components/Shortcuts'
import { HOME_SECTIONS, MOBILE_NAV, NAV, type ViewId } from './core/nav'
import { useMobileShell, useNarrow } from './components/useNarrow'
import { DataFolderSetup } from './components/DataFolderSetup'
import {
  IconActivity,
  IconCalendar,
  IconClock,
  IconCloudNode,
  IconFileText,
  IconHome,
  IconInbox,
  IconKey,
  IconKeyNode,
  IconMail,
  IconPanelLeft,
  IconSettings,
  IconUsers,
} from './components/icons'
import { CommandPalette, type PaletteTarget } from './components/CommandPalette'
import { CodeCheckProvider } from './state/CodeCheck'
import { claimStartupUpdateCheck, runUpdateCheck } from './core/update'
import brandMark from './assets/brand.png'
import { Skeleton } from './components/Skeleton'
import { ErrorBoundary } from './components/ErrorBoundary'
import { actionableHits } from './core/codeHistory'
import type { MessageDraft } from './core/types'

/**
 * One chunk per screen.
 *
 * Compose is *not* lazy: it is what the window opens on, so splitting it would
 * add a network (or, on the desktop, a disk) round trip to the one screen that
 * must already be there. Everything else is loaded when it is first opened —
 * the inbox alone pulls in the message list, the body sanitiser and the image
 * policy UI, none of which a person who only sends reminders ever needs.
 *
 * `React.lazy` remembers the module after the first import, so switching back
 * and forth costs nothing after the first visit.
 */
const loadCodes = () => import('./views/CodesView')
const loadSchedule = () => import('./views/ScheduleView')
const loadInbox = () => import('./views/InboxView')
const loadContacts = () => import('./views/ContactsView')
const loadTemplates = () => import('./views/TemplatesView')
const loadLogs = () => import('./views/LogsView')
const loadWorkCalendar = () => import('./views/WorkCalendarView')
const loadSettings = () => import('./views/SettingsView')
const loadHome = () => import('./views/HomeView')

const CodesView = lazy(() => loadCodes().then((m) => ({ default: m.CodesView })))
const ScheduleView = lazy(() => loadSchedule().then((m) => ({ default: m.ScheduleView })))
const InboxView = lazy(() => loadInbox().then((m) => ({ default: m.InboxView })))
const ContactsView = lazy(() => loadContacts().then((m) => ({ default: m.ContactsView })))
const TemplatesView = lazy(() => loadTemplates().then((m) => ({ default: m.TemplatesView })))
const LogsView = lazy(() => loadLogs().then((m) => ({ default: m.LogsView })))
const WorkCalendarView = lazy(() =>
  loadWorkCalendar().then((m) => ({ default: m.WorkCalendarView })),
)
const SettingsView = lazy(() => loadSettings().then((m) => ({ default: m.SettingsView })))
const HomeView = lazy(() => loadHome().then((m) => ({ default: m.HomeView })))

/**
 * Warm the other screens once the app is idle.
 *
 * Splitting the bundle bought a faster start and charged for it on the first
 * visit to each screen — measured at 310–456 ms, which is a visible pause on a
 * button press. Prefetching during idle time keeps the cheaper start and gives
 * the pause back: by the time anyone clicks, the chunk is already parsed.
 *
 * `requestIdleCallback` and not a timer, so this never competes with the first
 * screen actually rendering. Failures are ignored — a chunk that fails to
 * prefetch is simply loaded on demand, exactly as before.
 */
function prefetchScreens(): void {
  const warm = () => {
    for (const load of [loadCodes, loadHome, loadSettings, loadSchedule, loadLogs, loadContacts, loadTemplates, loadInbox]) {
      void load().catch(() => {})
    }
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 })
  else setTimeout(warm, 1500)
}


/** Icon name → component. Keeps `core/nav.ts` importable outside React. */
const NAV_ICONS = {
  mail: IconMail,
  key: IconKey,
  inbox: IconInbox,
  clock: IconClock,
  users: IconUsers,
  file: IconFileText,
  calendar: IconCalendar,
  activity: IconActivity,
  settings: IconSettings,
  home: IconHome,
} as const

/** The only two `NAV_ICONS` entries `runecircuit` redraws — a full icon-set
    swap was explicitly out of scope, so this stays a small, named pair
    rather than growing into a second copy of the map above. */
const RUNE_NAV_ICONS = {
  mail: IconCloudNode,
  key: IconKeyNode,
} as const

const COLLAPSE_KEY = 'aevistle.sidebar.collapsed'

/** Caps what a `.nav__badge` ever has to render.
 *
 * The badge sits inside `.nav__item` next to a label that already has no
 * spare width to give — narrowing the sidebar measured the layout against
 * short counts only. A three-digit count ("300" scheduled reminders, "1500"
 * unread — both things a long-lived mailbox actually reaches) pushes the
 * badge wide enough to clip the label itself ("Inbox", "Scheduled") in every
 * one of the six languages, not just the long ones. Capping the *display* at
 * two digits — the same "99+" convention every mail/chat badge uses — keeps
 * the badge's own width bounded regardless of how large the real count gets,
 * without touching `armedCount`/`unreadInboxCount`/`freshCodeCount`
 * themselves, which still carry the exact number everywhere else (Home's
 * armed-reminders line, etc.). */
function navBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function Shell() {
  const { state, ready, bridge, bootError, dispatch, undo, toggleJob } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const [view, setView] = useState<ViewId>('compose')
  const [openAccountOnMount, setOpenAccountOnMount] = useState(false)

  /**
   * Nine tabs on a desktop, five on a phone — see `core/nav.ts`.
   *
   * The *screens* are identical either way. Only which of them the bar can
   * reach directly changes, and Home is the door to the rest.
   *
   * Width, deliberately, and not `useMobileShell`. The bar is the one decision
   * on this screen that genuinely turns on how much room there is: a 1280px
   * tablet fits nine tabs, and folding four of them behind Home to match a phone
   * would cost a tap each and buy nothing back. What the tablet *did* need
   * changing is the dialog and Settings structure, which is a different question
   * asked in a different place — see `useMobileShell` below.
   */
  const narrow = useNarrow()
  const navItems = narrow ? MOBILE_NAV : NAV

  /**
   * Keep `data-shell` on the root element in step for the rest of the run.
   *
   * `main.tsx` sets it before the first paint; this is what moves it when a
   * desktop window is dragged across 760px. The return value is unused here —
   * `SettingsView` asks the same question for itself — but the effect inside is
   * what every full-screen dialog in the app is styled by.
   */
  useMobileShell(bridge?.platform === 'android')

  /**
   * Which tab to light up.
   *
   * Usually `view` itself. The exception is a phone showing one of the five
   * screens that live behind Home: `Ctrl+4` and the command palette can both
   * still land there directly (deliberately — a keyboard on a tablet should
   * not lose four shortcuts to a layout decision), and the bar has no tab of
   * their own to highlight. Without this, pressing Ctrl+4 on a narrow window
   * left every tab unlit, which reads as "nothing is selected" rather than as
   * "you are somewhere under Home".
   */
  const currentTab: ViewId = narrow && HOME_SECTIONS.includes(view) ? 'home' : view

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  )

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  /**
   * The keyboard layer.
   *
   * Registered on the window in the capture phase so a focused input cannot
   * swallow it — that is the whole point of Ctrl+K. Which keys stand down
   * inside a text field is decided by `matchShortcut`, not here, so the rule
   * and the on-screen list cannot disagree.
   *
   * Compose-local actions (send, schedule, preview, history) are broadcast as
   * a DOM event rather than threaded down as props: the shell has no business
   * knowing what state the compose form is in, and a chain of four callbacks
   * through two components to reach one button is a chain that rots.
   */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = matchShortcut(event)
      if (!action) return

      if (action === 'palette') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (action === 'help') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (action === 'undo') {
        event.preventDefault()
        const label = undo()
        if (label) toast.push({ tone: 'info', title: t('undo.restored', { what: label }) })
        return
      }
      if (action.startsWith('nav')) {
        const index = Number(action.slice(3)) - 1
        const item = NAV[index]
        if (item) {
          event.preventDefault()
          setOpenAccountOnMount(false)
          setView(item.id)
        }
        return
      }
      // send / schedule / preview / history — only meaningful on one screen.
      if (view !== 'compose') return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('aevistle:compose-action', { detail: action }))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [undo, toast, t, view])

  // "New reminder" in the tray menu. The main process has already raised the
  // window by the time this arrives; all that is left is landing on the right
  // screen.
  useEffect(() => {
    return bridge?.onTrayCommand?.((command) => {
      setOpenAccountOnMount(false)
      if (command === 'compose' || command === 'schedule' || command === 'logs') {
        setView(command)
        return
      }
      // Pausing runs through the same `toggleJob` a click does, so the
      // occurrence list is recomputed and the platform scheduler re-armed —
      // flipping `enabled` in the store directly would leave the alarm set.
      const wanted = command === 'resumeAll'
      const targets = state.jobs.filter((j) => j.enabled !== wanted)
      for (const job of targets) void toggleJob(job.id, wanted)
      if (targets.length > 0) {
        toast.push({ tone: 'info', title: t(wanted ? 'toast.allResumed' : 'toast.allPaused') })
      }
    })
  }, [bridge, state.jobs, toggleJob, toast, t])

  const armedCount = useMemo(
    () => state.jobs.filter((j) => j.enabled && j.occurrences.length > 0).length,
    [state.jobs],
  )
  const unreadInboxCount = useMemo(
    () => state.inboxAccounts.flatMap((i) => i.messages).filter((m) => !m.seen).length,
    [state.inboxAccounts],
  )
  /**
   * The badge is "act on this now", so it counts what is recent *and* unread —
   * `actionableHits`, not `freshHits`.
   *
   * It used to count `freshHits`, which is recency alone. Pressing "全部标为
   * 已读" on the Codes screen genuinely marked every hit read and the cards
   * visibly changed, but the badge kept its old number for the rest of the
   * freshness window, because nothing the button touched was an input to it.
   * There was no way to tell from the outside that the button had worked.
   *
   * The rule now lives in `core/codeHistory` and nowhere else, which is the
   * actual fix: this and the "unread outranks fresh" subtitle in
   * `views/CodesView` were two hand-written answers to one question, and they
   * drifted the moment mark-all-read was added.
   *
   * `state.codeHits` is the only dependency, and that is on purpose. `readAt`
   * changes produce a new array via the reducer, so marking read recomputes
   * immediately; the recency half only goes stale, and a badge that lingers a
   * few seconds past the ten-minute mark is not worth a timer that re-renders
   * the whole shell — the next state change picks it up.
   */
  const freshCodeCount = useMemo(() => actionableHits(state.codeHits).length, [state.codeHits])

  // Once the first screen is up and the app is idle, pull the rest in.
  useEffect(() => {
    if (ready) prefetchScreens()
  }, [ready])

  /**
   * The update check, at startup, for real.
   *
   * It used to live in the Settings card, which meant it ran when *Settings*
   * started, not when the app did. Someone who installs a build and never opens
   * that screen — which is most people, once their accounts are set up — was
   * never told a newer version existed, while a switch labelled "check for
   * updates when Aevistle starts" sat there saying otherwise.
   *
   * Four things this is careful about:
   *
   *   - `ready` gates it, so the stored settings have replaced the defaults
   *     before the switch is read. `updateCheckOnStart` defaults to *true*, so
   *     running any earlier would mean a network request on behalf of someone
   *     who had turned it off.
   *   - `claimStartupUpdateCheck` is module-level, so this fires once per
   *     launch no matter how many times anything remounts. The Settings card
   *     no longer checks on mount at all; it reads the result from the same
   *     module.
   *   - it waits for idle. An update check is the least urgent thing the app
   *     does and the first paint is the most urgent, so it is not allowed to
   *     compete — same reasoning, and the same mechanism, as the prefetch above.
   *   - `runUpdateCheck` cannot reject. A bare `void promise` here would be one
   *     bad IPC reply away from an `unhandledRejection`, which on the desktop
   *     means a native error dialog over a working app.
   *
   * And deliberately *no* cleanup. The obvious "cancel the pending check on
   * unmount" is wrong here, in a way that only shows up in development: React's
   * StrictMode mounts every effect, tears it down, and mounts it again. A
   * cleanup that cancelled the scheduled run would cancel the one the *claim*
   * had already been spent on, and the second mount would decline to re-claim
   * it — so the check would never run at all, and only in dev, which is the
   * worst place to lose it. Letting the scheduled call stand costs, at worst,
   * one toast pushed while the window is closing.
   *
   * Silent unless it finds something: a toast every launch saying "still up to
   * date" is a notification nobody asked for. The manual button in Settings is
   * the opposite case and still always reports, because a button that produces
   * no visible change reads as a button that did nothing.
   */
  useEffect(() => {
    if (!ready || !bridge || !state.settings.updateCheckOnStart) return
    if (!claimStartupUpdateCheck()) return

    const run = () => {
      void runUpdateCheck(() => bridge.checkForUpdate(), __APP_VERSION__).then((info) => {
        if (!info.available) return
        toast.push({
          tone: 'info',
          title: t('update.newVersionToast', { version: info.latest }),
          detail: t('update.newVersionToastHint'),
        })
      })
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 })
    else setTimeout(run, 2000)
  }, [ready, bridge, state.settings.updateCheckOnStart, toast, t])

  const goToAccounts = () => {
    setOpenAccountOnMount(true)
    setView('settings')
  }

  /**
   * A new-mail notification was clicked: go to the Inbox and open that message.
   *
   * Held here rather than inside `InboxView` because the screen may not be
   * mounted when the click lands — it is lazy, and the click routinely arrives
   * while the user is on Compose or while the window was closed entirely. So
   * the id is stored, the view switches, and `InboxView` picks it up when it
   * mounts and clears it through `onFocusHandled`.
   */
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null)
  const clearFocusMessage = useCallback(() => setFocusMessageId(null), [])

  useEffect(() => {
    if (!bridge?.onOpenMessage) return
    return bridge.onOpenMessage((messageId) => {
      setOpenAccountOnMount(false)
      setFocusMessageId(messageId)
      setView('inbox')
    })
  }, [bridge])

  /**
   * The draft's attachments as of the last render, for the share handler below.
   *
   * Through a ref rather than a dependency on purpose. Naming `state.draft` in
   * the effect's dependency list would tear the subscription down and build it
   * back up on every keystroke into the compose form — and on Android the
   * subscription is a one-shot poll that *consumes* the pending share, so it
   * would be collected by the first run and the resubscribe would find nothing.
   */
  const draftAttachmentsRef = useRef(state.draft.attachments)
  draftAttachmentsRef.current = state.draft.attachments

  /**
   * Another application handed us something to send.
   *
   * The share sheet on Android, a `mailto:` link or Send To on Windows. Same
   * placement and the same reasoning as `onOpenMessage` above: Compose may not
   * be the screen that is mounted, and on a cold share nothing is mounted at
   * all, so the payload is applied to the draft here and the view follows.
   *
   * Only the fields the payload actually carries are written. A `mailto:` with
   * nothing but an address must not blank out a subject the user had already
   * typed, and `setDraft` is a shallow merge — an explicit `subject: ''` would
   * do exactly that. Attachments are appended for the same reason: replacing
   * the array would silently drop files that were already on the draft.
   *
   * Gated on `ready`, which is the whole reason a cold share works at all.
   *
   * `ready` turns true in the same block that dispatches `hydrate`, and
   * `hydrate` returns `{ ...action.state }` — the stored draft included. So a
   * share applied before hydration was overwritten by whatever was last left
   * in the compose box on disk, and the user watched the app open Compose with
   * every field blank. On Windows that was not a race but a certainty: the
   * preload buffer replays the payload synchronously inside this subscribe
   * (see `onShare` there), so the `setDraft` always won the sprint and always
   * lost the war. On Android it depended on whether one bridge round-trip beat
   * another, which is worse — a text share usually vanished and an image share
   * usually survived.
   *
   * Waiting costs nothing, because neither platform throws the payload away
   * while nobody is listening: Windows holds it in the preload buffer and
   * Android leaves it parked in a static field that `takePendingShare` reads
   * and clears. Subscribing after hydration is therefore the entire fix.
   */
  useEffect(() => {
    if (!ready || !bridge?.onShare) return
    return bridge.onShare((share) => {
      const patch: Partial<MessageDraft> = {}
      if (share.to?.length) patch.to = share.to
      if (share.cc?.length) patch.cc = share.cc
      if (share.bcc?.length) patch.bcc = share.bcc
      if (share.subject) patch.subject = share.subject
      if (share.body) patch.body = share.body
      if (share.attachments?.length) {
        const merged = [...draftAttachmentsRef.current, ...share.attachments]
        /*
         * Written back into the ref, not just into the patch.
         *
         * The ref is otherwise only refreshed on render, and two shares can
         * land before React has rendered once: Explorer splits a large Send To
         * selection across several launches of the exe, and each one arrives as
         * its own `second-instance`. Reading a stale ref for the second would
         * throw away the first one's files — silently, which is the whole class
         * of bug this feature was written to avoid.
         */
        draftAttachmentsRef.current = merged
        patch.attachments = merged
      }
      if (Object.keys(patch).length > 0) dispatch({ type: 'setDraft', patch })
      setOpenAccountOnMount(false)
      setView('compose')
    })
  }, [ready, bridge, dispatch])

  /*
   * The palette's three props are `useCallback`s and not inline arrows.
   *
   * `CommandPalette` lists `onNavigate` and `onCompose` in the dependencies of
   * the memo that builds its action list — every navigation target, every
   * contact, every template and every reminder — and its result list depends on
   * that. Inline arrows are a new identity on every render of `Shell`, which
   * includes every keystroke into the compose textarea, so the whole list was
   * rebuilt and re-ranked between characters *while the palette was shut*.
   * The palette also stands down on its own now (see its `open` guard); both
   * ends are fixed because either one alone leaves the other half of the work.
   */
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const paletteNavigate = useCallback((target: PaletteTarget) => {
    setOpenAccountOnMount(false)
    setView(target)
  }, [])
  const paletteCompose = useCallback(
    (prefill?: { to?: string[]; subject?: string; body?: string }) => {
      if (prefill) dispatch({ type: 'setDraft', patch: prefill })
      setView('compose')
    },
    [dispatch],
  )

  /**
   * The frame arrives before the data does.
   *
   * This used to be a centred spinner, and it cost more than it looked like:
   * measured in the packaged app, the window painted at 732 ms but the first
   * *contentful* paint was at 1900 ms — a spinner is not content, so for over a
   * second the user had a blank window and no evidence the app was starting.
   *
   * The sidebar and a skeleton cost nothing to render (they depend on no
   * state), they make the wait legible, and they mean the layout does not jump
   * when the real screen replaces them, because it is the same layout.
   */
  /**
   * Start-up gave up. Say so.
   *
   * `ready` never becomes true when boot fails, so this branch used to fall
   * through to the loading skeleton below and stay there — an app that looked
   * like it was still starting, forever, with an empty window and no error.
   * That is indistinguishable from a hang, and it is the one state where the
   * user most needs to be told what happened.
   */
  if (bootError) {
    return (
      <div className="shell shell--boot-error">
        <div className="bootfail" role="alert">
          <h1 className="bootfail__title">{t('boot.failedTitle')}</h1>
          <p className="bootfail__detail">{bootError}</p>
          <p className="bootfail__hint">{t('boot.failedHint')}</p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="shell" data-collapsed={collapsed}>
        <aside className="sidebar">
          <div className="brand">
            <div className="brand__mark">
              <img src={brandMark} alt="" width={30} height={30} draggable={false} />
            </div>
            <div className="brand__text">
              <div className="brand__name">Aevistle</div>
            </div>
          </div>
          {/* The same list the loaded shell will draw, so the bar does not
              change length the instant the app becomes ready — on a phone that
              would be five tabs replaced by five different tabs, which reads
              as a flicker rather than as loading finishing. */}
          <nav className="nav" aria-label="Primary">
            {navItems.map((item) => {
              const Icon = NAV_ICONS[item.icon]
              return (
                <span key={item.id} className="nav__item" aria-disabled="true">
                  <span className="nav__icon">
                    <Icon size={17} />
                  </span>
                  <span className="nav__label">{t(item.labelKey)}</span>
                </span>
              )
            })}
          </nav>
        </aside>
        <main className="main">
          <Skeleton shape="form" />
        </main>
      </div>
    )
  }

  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">
            <img src={brandMark} alt="" width={30} height={30} draggable={false} />
          </div>
          <div className="brand__text">
            <div className="brand__name">Aevistle</div>
          </div>
        </div>

        <nav className="nav" aria-label="Primary">
          {navItems.map((item) => {
            const Icon =
              state.settings.visualStyle === 'runecircuit' && (item.icon === 'mail' || item.icon === 'key')
                ? RUNE_NAV_ICONS[item.icon]
                : NAV_ICONS[item.icon]
            return (
              <button
                key={item.id}
                type="button"
                className="nav__item"
                /* Names the screen for the measuring scripts. Clicking by
                   label would break the moment the app is read in one of the
                   other five languages. */
                data-view={item.id}
                aria-current={currentTab === item.id ? 'page' : undefined}
                title={t(item.labelKey)}
                onClick={() => {
                  setOpenAccountOnMount(false)
                  setView(item.id)
                }}
              >
                <span className="nav__icon">
                  <Icon size={17} />
                </span>
                <span className="nav__label">{t(item.labelKey)}</span>
                {item.id === 'schedule' && armedCount > 0 ? (
                  <span className="nav__badge">{navBadgeText(armedCount)}</span>
                ) : null}
                {item.id === 'inbox' && unreadInboxCount > 0 ? (
                  <span className="nav__badge">{navBadgeText(unreadInboxCount)}</span>
                ) : null}
                {item.id === 'codes' && freshCodeCount > 0 ? (
                  <span className="nav__badge nav__badge--accent">{navBadgeText(freshCodeCount)}</span>
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="sidebar__footer">
          {/*
            The desktop door to Home — see `core/nav.ts`'s `HomeFeatureId`/
            `HOME_FEATURES` for what is behind it, and that same file's `ViewId`
            comment for why Home itself is not a member of `NAV` above.

            Not a numbered tab. `NAV_SHORTCUTS` in `components/Shortcuts.tsx`
            gives every entry in `NAV` a `Ctrl+N`, and `check-shortcuts.mjs`
            asserts the two never drift apart in length — so a tenth entry
            there would need a `Ctrl+0` (the browser's own zoom reset, already
            ruled out by the comment on `MAX_NAV_SHORTCUT`) or would leave one
            of the nine numbered keys silently pointing at nothing. A footer
            button asks for neither: Home is a doorway to four features that
            had no door of their own before this button existed, not a
            destination competing for a shortcut the other nine already share
            out completely.
          */}
          <IconButton
            label={t('nav.home')}
            aria-current={view === 'home' ? 'page' : undefined}
            onClick={() => {
              setOpenAccountOnMount(false)
              setView('home')
            }}
          >
            <IconHome size={17} />
          </IconButton>
          <IconButton
            label={collapsed ? t('nav.expand') : t('nav.collapse')}
            onClick={() => setCollapsed((v) => !v)}
          >
            <IconPanelLeft size={17} />
          </IconButton>
        </div>
      </aside>

      {/* Keyed on `view` so switching screens clears a failure rather than
          stranding the user on it: the boundary remounts, and a screen that
          threw on data the user has since fixed elsewhere renders again. */}
      <ErrorBoundary key={view} label={view}>
      <main className="main">
        {bridge?.platform === 'web' ? (
          <div style={{ padding: 'var(--sp-4) var(--sp-5) 0' }}>
            <div style={{ maxWidth: 'var(--content-max)', marginInline: 'auto' }}>
              <Banner tone="info" title={t('preview.title')}>
                {t('preview.body')}
              </Banner>
            </div>
          </div>
        ) : null}

        <DataFolderSetup />

        {view === 'compose' ? (
          <ComposeView
            onGoToAccounts={goToAccounts}
            // The health strip names problems that live on other screens, so
            // it needs to be able to get there; a "Fix" link that does nothing
            // is worse than no link.
            onNavigate={(where) => (where === 'settings' ? goToAccounts() : setView(where))}
          />
        ) : null}

        {/* One boundary per screen, not one around the switch: a shared
            boundary would re-show the placeholder every time the *other*
            screens loaded, and the fallback would have to be generic. */}
        {view === 'codes' ? (
          <Suspense fallback={<Skeleton shape="list" rows={6} />}>
            <CodesView onGoToInbox={() => setView('inbox')} />
          </Suspense>
        ) : null}
        {view === 'inbox' ? (
          <Suspense fallback={<Skeleton shape="list" rows={8} />}>
            <InboxView
              onGoToAccounts={goToAccounts}
              focusMessageId={focusMessageId}
              onFocusHandled={clearFocusMessage}
            />
          </Suspense>
        ) : null}
        {view === 'schedule' ? (
          <Suspense fallback={<Skeleton shape="list" rows={5} />}>
            <ScheduleView onCompose={() => setView('compose')} />
          </Suspense>
        ) : null}
        {view === 'contacts' ? (
          <Suspense fallback={<Skeleton shape="list" rows={7} />}>
            <ContactsView />
          </Suspense>
        ) : null}
        {view === 'templates' ? (
          <Suspense fallback={<Skeleton shape="list" rows={4} />}>
            <TemplatesView onApplied={() => setView('compose')} />
          </Suspense>
        ) : null}
        {view === 'workcal' ? (
          <Suspense fallback={<Skeleton shape="form" />}>
            {/* Double-clicking an empty square starts a reminder for that day.
                The *date* travels through `core/composeSeed`, which the compose
                screen's send-time seed already reads; this only has to get the
                user to the screen that reads it. */}
            <WorkCalendarView onCompose={() => setView('compose')} />
          </Suspense>
        ) : null}
        {view === 'logs' ? (
          <Suspense fallback={<Skeleton shape="list" rows={8} />}>
            <LogsView />
          </Suspense>
        ) : null}
        {view === 'settings' ? (
          <Suspense fallback={<Skeleton shape="form" />}>
            <SettingsView openAccountOnMount={openAccountOnMount} />
          </Suspense>
        ) : null}

        {/* The hub — a phone's only door to five screens, and every platform's
            door to the four `HOME_FEATURES` tiles (see the sidebar footer
            button above, and `HomeView`'s own module doc for the split
            between the two kinds of tile). This used to fall back to
            `ComposeView` whenever `view` was `'home'` but the window was not
            narrow, because Home had no desktop entry point and the only way
            to land here on a wide window was a phone resized mid-visit — a
            case worth a graceful landing, not a screen worth building. Now
            that the footer button can request Home on a desktop on purpose,
            that fallback would render the wrong screen for a deliberate
            click, so `HomeView` renders unconditionally and decides for
            itself, via `narrow`, which tiles to draw. */}
        {view === 'home' ? (
          <Suspense fallback={<Skeleton shape="list" rows={5} />}>
            <HomeView
              onCompose={() => setView('compose')}
              armedCount={armedCount}
              narrow={narrow}
            />
          </Suspense>
        ) : null}
      </main>
      </ErrorBoundary>

      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onNavigate={paletteNavigate}
        onCompose={paletteCompose}
      />

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  )
}

/** Bridges the i18n object built inside AppProvider out to the context. */
function I18nBridge({ children }: { children: React.ReactNode }) {
  const { i18n } = useApp()
  return <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>
}

export default function App() {
  return (
    <AppProvider>
      <I18nBridge>
        <ToastProvider>
          {/* Above the shell, so extraction and the "check now" state outlive
              every screen switch — see the header comment in `CodeCheck`. */}
          {/* The backstop. Per-view boundaries cover the screens; this one
              covers the frame around them — the sidebar, the palette, the
              toasts — so a throw there is still a message rather than a
              white window. */}
          <ErrorBoundary label="application">
            <CodeCheckProvider>
              <Shell />
            </CodeCheckProvider>
          </ErrorBoundary>
        </ToastProvider>
      </I18nBridge>
    </AppProvider>
  )
}
