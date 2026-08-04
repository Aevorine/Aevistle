import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { ComposeView } from './views/ComposeView'
import { AppProvider, useApp } from './state/AppState'
import { I18nContext, useI18n } from './i18n'
import { Banner, IconButton, ToastProvider, useToast } from './components/ui'
import { ShortcutsDialog, matchShortcut } from './components/Shortcuts'
import { NAV, type ViewId } from './core/nav'
import { DataFolderSetup } from './components/DataFolderSetup'
import {
  IconActivity,
  IconCalendar,
  IconClock,
  IconFileText,
  IconInbox,
  IconKey,
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
import { freshHits } from './core/codeHistory'

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
    for (const load of [loadCodes, loadSettings, loadSchedule, loadLogs, loadContacts, loadTemplates, loadInbox]) {
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
} as const

const COLLAPSE_KEY = 'aevistle.sidebar.collapsed'

function Shell() {
  const { state, ready, bridge, bootError, dispatch, undo, toggleJob } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const [view, setView] = useState<ViewId>('compose')
  const [openAccountOnMount, setOpenAccountOnMount] = useState(false)

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
  /** Codes recent enough to still be usable — the badge is "act on this now". */
  const freshCodeCount = useMemo(() => freshHits(state.codeHits).length, [state.codeHits])

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
              <div className="brand__tagline">{t('app.tagline')}</div>
            </div>
          </div>
          <nav className="nav" aria-label="Primary">
            {NAV.map((item) => {
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
            <div className="brand__tagline">{t('app.tagline')}</div>
          </div>
        </div>

        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => {
            const Icon = NAV_ICONS[item.icon]
            return (
              <button
                key={item.id}
                type="button"
                className="nav__item"
                /* Names the screen for the measuring scripts. Clicking by
                   label would break the moment the app is read in one of the
                   other five languages. */
                data-view={item.id}
                aria-current={view === item.id ? 'page' : undefined}
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
                  <span className="nav__badge">{armedCount}</span>
                ) : null}
                {item.id === 'inbox' && unreadInboxCount > 0 ? (
                  <span className="nav__badge">{unreadInboxCount}</span>
                ) : null}
                {item.id === 'codes' && freshCodeCount > 0 ? (
                  <span className="nav__badge nav__badge--accent">{freshCodeCount}</span>
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="sidebar__footer">
          <IconButton
            label={collapsed ? t('nav.expand') : t('nav.collapse')}
            onClick={() => setCollapsed((v) => !v)}
          >
            <IconPanelLeft size={17} />
          </IconButton>
        </div>
      </aside>

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
            <InboxView onGoToAccounts={goToAccounts} />
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
      </main>

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
          <CodeCheckProvider>
            <Shell />
          </CodeCheckProvider>
        </ToastProvider>
      </I18nBridge>
    </AppProvider>
  )
}
