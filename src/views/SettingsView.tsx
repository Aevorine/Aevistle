import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Segmented,
  StatusChip,
  Switch,
  useConfirm,
  useToast,
  PageHead,
} from '../components/ui'
import {
  IconAlert,
  IconCalendar,
  IconChevronRight,
  IconDatabase,
  IconDownload,
  IconExternal,
  IconFileText,
  IconFolder,
  IconGlobe,
  IconGrip,
  IconInfo,
  IconKey,
  IconLink,
  IconMail,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconSend,
  IconShield,
  IconStar,
  IconSun,
  IconTrash,
} from '../components/icons'
import { AccountDialog } from '../components/AccountDialog'
import { BackupCard } from './BackupCard'
import { PairingFileCard } from './PairingFileCard'
import { DevicesCard } from './DevicesCard'
import { ScheduleTransferCard } from './ScheduleTransferCard'
import { ControlCard } from './ControlCard'
import { CalendarSubscribeCard } from './CalendarSubscribeCard'
import { SectionNav } from '../components/SectionNav'
import { SettingsSection } from '../components/SettingsSection'
import { useMobileShell, useTwoPane } from '../components/useNarrow'
import {
  accountGroupKey,
  accountLabel,
  groupAccounts,
  knownGroups,
  needsStoredPassword,
  orderedAccounts,
} from '../core/mail/accounts'
import { useReorder } from '../components/useReorder'
import { useApp } from '../state/AppState'
import { LOCALES, useI18n, type TranslationKey } from '../i18n'
import { DEFAULT_RETRY, defaultRecurrence, effectiveImagePolicy, emptyDraft } from '../core/types'
import type {
  AccentBase,
  AccentCyber,
  AccentId,
  Density,
  InboxAccountState,
  LocalePreference,
  MailAccount,
  ThemeMode,
  VisualStyle,
} from '../core/types'
import { buildDigest, DIGEST_JOB_ID } from '../core/mail/digest'
import { renderDigestBody, renderDigestSubject } from '../core/mail/digestText'
import {
  GREETING_COUNTRIES,
  greetingJobId,
  planGreetings,
  type GreetingOccasion,
} from '../core/mail/greetings'
import { HOLIDAY_PRESETS } from '../core/schedule/holidayPresets'
import type { AppInfo, DataFolder, DataFolderChange } from '../core/platform/bridge'
import { lastUpdateCheck, onUpdateCheck, runUpdateCheck } from '../core/platform/update'
import type { DownloadProgress, UpdateInfo } from '../core/platform/update'

/**
 * The seven visual styles, in the order they are offered.
 *
 * `aurora` first because it is the default and the one an existing install is
 * already wearing; `contrast` last because it is the answer to a need rather
 * than a taste. The colours each tile paints itself in are not here — they are
 * `--preview-*` in theme.css, beside the style's own tokens, so the tile and
 * the style it advertises cannot drift apart.
 */
const STYLES: Array<{ id: VisualStyle; labelKey: TranslationKey }> = [
  { id: 'aurora', labelKey: 'settings.style.aurora' },
  { id: 'graphite', labelKey: 'settings.style.graphite' },
  { id: 'paper', labelKey: 'settings.style.paper' },
  { id: 'midnight', labelKey: 'settings.style.midnight' },
  { id: 'nordic', labelKey: 'settings.style.nordic' },
  { id: 'runecircuit', labelKey: 'settings.style.runecircuit' },
  { id: 'contrast', labelKey: 'settings.style.contrast' },
]

/**
 * Just the seven names. The colours used to be spelled out here as fourteen
 * hex literals copied from theme.css, and a copy of a palette is a palette that
 * can be wrong: it showed the light halves whenever the theme was "match
 * system" on a machine in dark mode, because a constant cannot see a media
 * query. Each swatch now paints itself from `--accent-<id>-now`, which is the
 * one the app is actually using — including under the `contrast` style, which
 * retunes all seven for AAA.
 */
const ACCENTS: AccentId[] = ['azure', 'indigo', 'teal', 'violet', 'amber', 'rose', 'emerald']

/**
 * runecircuit's own accent, on two axes instead of the seven above — see the
 * block comment beside `--accent-classical` in theme.css. Swatches paint from
 * `--classical-<id>-now`/`--cyber-<id>-now`, the same "-now" trick as `ACCENTS`.
 */
const ACCENT_BASES: Array<{ id: AccentBase; labelKey: TranslationKey }> = [
  { id: 'ink', labelKey: 'settings.accentBase.ink' },
  { id: 'crimson', labelKey: 'settings.accentBase.crimson' },
  { id: 'moonwhite', labelKey: 'settings.accentBase.moonwhite' },
  { id: 'gold', labelKey: 'settings.accentBase.gold' },
]
const ACCENT_CYBERS: Array<{ id: AccentCyber; labelKey: TranslationKey }> = [
  { id: 'cyan', labelKey: 'settings.accentCyber.cyan' },
  { id: 'magenta', labelKey: 'settings.accentCyber.magenta' },
  { id: 'blue', labelKey: 'settings.accentCyber.blue' },
]

const REPO_URL = 'https://github.com/Aevorine/Aevistle'

/**
 * What a row promises when you tap it.
 *
 * `panel` opens a set of preferences you change and leave changed. `action` is
 * a one-shot verb — back this up, move it to another device — which is a
 * different kind of thing to find in a list of settings and is drawn as one
 * (see `.settingsrow--action` in `styles/app/25-settings.css`). The distinction
 * is not decoration: a preference row is safe to open out of curiosity, and an
 * action row is where the irreversible things live.
 */
type SettingsRowKind = 'panel' | 'action'

/**
 * The phone index: four groups, sixteen rows, in the order they are read.
 *
 * ## Why this table and not sixteen self-drawing rows
 *
 * Each section used to draw its own row from inside `SettingsSection`, and four
 * of them (`set-digest`, `set-greetings`, `set-calendarsub`, `set-devices`)
 * drew none at all because `HomeView` already had tiles for them. Twelve rows,
 * sixteen sections: opening Settings to look for the daily digest found nothing
 * and pointed nowhere, and three of the four missing ones sat behind Home's 更多
 * at three taps. The Home tiles stay — two doors into one room is right when
 * both doors are where somebody would look — but Settings has to be one of
 * them.
 *
 * A row cannot decide its own position in a group, so the order lives here
 * rather than in the sixteen sections below. This table is also the single
 * source of every section's *name*: the row title, the dialog title and the
 * wide window's jump-bar entry are all `t(labelKey)` from this one place, so a
 * row that opens a dialog with a different name on it is not a thing that can
 * happen.
 *
 * The ids are the anchor ids the sections emit, which is what
 * `scripts/layout-probe.mjs` finds them by — an id that drifted here would show
 * up immediately as a row that opens nothing.
 */
const SETTINGS_GROUPS: Array<{
  captionKey: TranslationKey
  rows: Array<{ id: string; labelKey: TranslationKey; icon: ReactNode; kind: SettingsRowKind }>
}> = [
  {
    captionKey: 'settings.group.common',
    rows: [
      { id: 'set-appearance', labelKey: 'settings.appearance', icon: <IconSun size={17} />, kind: 'panel' },
      { id: 'set-notifications', labelKey: 'settings.notifications', icon: <IconAlert size={17} />, kind: 'panel' },
      { id: 'set-sending', labelKey: 'settings.sending', icon: <IconSend size={17} />, kind: 'panel' },
    ],
  },
  {
    captionKey: 'settings.group.mail',
    rows: [
      { id: 'set-accounts', labelKey: 'account.title', icon: <IconMail size={17} />, kind: 'panel' },
      { id: 'set-privacy', labelKey: 'settings.privacy', icon: <IconShield size={17} />, kind: 'panel' },
      { id: 'set-digest', labelKey: 'settings.digest', icon: <IconFileText size={17} />, kind: 'panel' },
      { id: 'set-greetings', labelKey: 'settings.greetings', icon: <IconStar size={17} />, kind: 'panel' },
    ],
  },
  {
    captionKey: 'settings.group.data',
    rows: [
      { id: 'set-backup', labelKey: 'backup.title', icon: <IconDatabase size={17} />, kind: 'action' },
      { id: 'set-transfer', labelKey: 'transfer.title', icon: <IconSend size={17} />, kind: 'action' },
      { id: 'set-devices', labelKey: 'devices.title', icon: <IconLink size={17} />, kind: 'panel' },
      /* Renamed from `cal.subscribe.toggle` — "Publish the working calendar for
         subscription" is what the switch inside does, and a switch's sentence is
         not a place's name. The switch keeps its own wording. */
      { id: 'set-calendarsub', labelKey: 'settings.row.calendarSub', icon: <IconCalendar size={17} />, kind: 'panel' },
      { id: 'set-data', labelKey: 'data.title', icon: <IconFolder size={17} />, kind: 'panel' },
      /* Same again, from `pairing.file.export` — "Save an encrypted pairing
         file" is the button, and the button is still called that inside. The
         two were not merged with the control interface below: one row is one
         promise, and "pairing and control" behind a single row would be two. */
      { id: 'set-pairingfile', labelKey: 'settings.row.pairingFile', icon: <IconKey size={17} />, kind: 'panel' },
      { id: 'set-control', labelKey: 'control.title', icon: <IconGlobe size={17} />, kind: 'panel' },
    ],
  },
  {
    captionKey: 'settings.group.about',
    rows: [
      { id: 'set-update', labelKey: 'update.title', icon: <IconDownload size={17} />, kind: 'panel' },
      { id: 'set-about', labelKey: 'settings.about', icon: <IconInfo size={17} />, kind: 'panel' },
    ],
  },
]

/** Section id → the one key that names it, everywhere it is named. */
const SECTION_LABEL_KEYS: Record<string, TranslationKey> = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((group) => group.rows.map((row) => [row.id, row.labelKey])),
)

export function SettingsView({ openAccountOnMount }: { openAccountOnMount?: boolean }) {
  const {
    state,
    dispatch,
    saveAccount,
    saveInboxAccount,
    testInboxAccount,
    deleteAccount,
    bridge,
    resetEverything,
    permissions,
    fixPermission,
  } = useApp()

  const { t } = useI18n()

  /**
   * Phone layout is a different structure, not a restyle — see
   * `components/SettingsSection.tsx`. Everything below renders identically in
   * both; only the wrapper decides whether a section is a card on the page or
   * a row that opens a dialog.
   *
   * `useMobileShell`, not `useNarrow`: an Android tablet is 800px in portrait
   * and 1280px in landscape, so on width alone it fell to the desktop branch and
   * got sixteen cards in a two-column grid. The sections that the report named —
   * the daily digest, holiday greetings, publishing the calendar, pairing — were
   * therefore not tappable rows opening a screen there; they were cards already
   * expanded on the page, which is the thing being asked for on a phone and the
   * wrong thing on a touch screen of any size. See `useNarrow.ts`.
   */
  const narrow = useMobileShell(bridge?.platform === 'android')

  /**
   * 600-839px: the index and the section it opens, side by side.
   *
   * The same hook the Inbox reads for the same band — see `useNarrow.ts`. One
   * hook rather than one test per screen, because the two screens that split
   * have to split at the same width or the app changes shape twice on the way
   * across one drag, which is the defect this whole round exists to remove.
   *
   * It changes nothing about what a section *is*: `SettingsSection` still
   * renders each one either as markup on the page or as a full-height dialog,
   * and here it is told "as markup" for exactly the one that is selected and
   * "as a dialog, shut" for the other fifteen. So the pane holds the same
   * component tree the phone dialog holds and the desktop page holds — there
   * is no third rendering of a section to keep in step.
   */
  const twoPane = useTwoPane()

  /** Passed to every section so the dialog's close button is translated once, here, rather than sixteen times. */
  const closeLabel = t('common.close')

  /**
   * Which section's dialog is open, on a phone.
   *
   * One piece of state for all sixteen rather than one `useState` inside each
   * section, because the rows are now an index (`SETTINGS_GROUPS`) and the
   * index has to be able to open a section it does not contain the markup of.
   * It also makes "two dialogs at once" unrepresentable, which sixteen
   * independent booleans did not.
   */
  const [openSection, setOpenSection] = useState<string | null>(null)
  const closeSection = useCallback(() => setOpenSection(null), [])

  /**
   * Which section the two-pane band is showing.
   *
   * `null` — nothing tapped yet — is a legitimate state on a phone, where it
   * means "the index, no dialog". Beside a pane it would mean an empty half
   * of the screen on arrival, which says nothing and looks broken, so the band
   * falls back to the first row of the first group. Derived rather than
   * written into `openSection` on mount: a default that is state has to be
   * cleared again when the window narrows, and the version of this that forgot
   * to do that opened a dialog on a phone nobody had asked for.
   */
  const selectedSection = twoPane ? (openSection ?? SETTINGS_GROUPS[0].rows[0].id) : openSection

  /**
   * "Is this section a dialog, rather than markup on the page?" — the question
   * `SettingsSection`'s `narrow` prop actually asks.
   *
   * On a phone: all sixteen, one of which is open. On a desktop: none, all
   * sixteen are cards. In the band: the selected one is markup — so it renders
   * into the pane — and the other fifteen stay shut dialogs, which is how only
   * one section's markup exists at a time without `SettingsSection` needing a
   * third mode.
   */
  const dialogFor = useCallback(
    (id: string) => (twoPane ? selectedSection !== id : narrow),
    [twoPane, selectedSection, narrow],
  )

  /**
   * Leaving the band puts the index back.
   *
   * Selecting a row in the two-pane layout writes to the same `openSection`
   * the phone opens dialogs from — deliberately, so that widening a window
   * carries the section you were reading straight into the pane. Narrowing has
   * to be handled, though, and was not: dragging a 768px window down to a
   * phone width left `openSection` set and a full-height dialog opened over
   * the index, on a screen nobody had tapped. Measured, not reasoned about —
   * the browser run for this change hit it and could not get back to the tab
   * bar.
   *
   * The clear is in the cleanup rather than in an effect that watches for
   * `!twoPane`, so it fires exactly on the true→false transition and never on
   * a phone that was never in the band.
   */
  useEffect(() => {
    if (!twoPane) return
    return () => setOpenSection(null)
  }, [twoPane])

  /** The one name a section has — row title, dialog title and jump-bar entry. */
  const sectionLabel = useCallback((id: string) => t(SECTION_LABEL_KEYS[id]), [t])

  /**
   * The update check's answer, for the Updates row's inline value.
   *
   * Read from the shared store rather than by asking again: `App` runs the
   * check at launch and `UpdateCard` below reads the same two functions, so
   * this is the answer that already exists. A row that triggered a network
   * request to draw itself would turn opening Settings into an update check.
   */
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(() => lastUpdateCheck())
  useEffect(() => onUpdateCheck(setUpdateInfo), [])

  /**
   * The jump bar's entries.
   *
   * No calendar entry. It was a card on this screen once; it is a top-level
   * tab now (`core/nav.ts`), and what was left behind was a jump-bar button
   * pointing at an empty marker div sitting immediately above the Updates card
   * — so "Work calendar" silently scrolled you to Updates, and the
   * IntersectionObserver highlighted it as the section you were reading.
   *
   * `set-transfer`, `set-pairingfile` and `set-calendarsub` used to be missing
   * for a duller reason than that: `ScheduleTransferCard`, `PairingFileCard`
   * and `CalendarSubscribeCard` all render further down this same page — they
   * are three of the sections below — but nobody had added their entries here,
   * so the only way to reach any of them on a wide window was to scroll past
   * it by hand rather than jump to it. Placed in page order, not alphabetical
   * or added-last order: the bar exists to mirror a top-to-bottom scroll, and
   * `SectionNav`'s `IntersectionObserver` would otherwise highlight a bar entry
   * in one position while the section it names sat in a different one.
   */
  const navSections = useMemo(
    () =>
      [
        'set-accounts',
        'set-data',
        'set-backup',
        'set-transfer',
        'set-pairingfile',
        'set-devices',
        'set-control',
        'set-calendarsub',
        'set-update',
        'set-appearance',
        'set-sending',
        'set-digest',
        'set-greetings',
        'set-notifications',
        'set-privacy',
        'set-about',
      ].map((id) => ({ id, label: sectionLabel(id) })),
    [sectionLabel],
  )
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [dialogOpen, setDialogOpen] = useState(Boolean(openAccountOnMount))
  const [editing, setEditing] = useState<MailAccount | undefined>(undefined)
  const [info, setInfo] = useState<AppInfo | null>(null)
  // Swallowed, this left the About card showing dashes where the platform and
  // the data location should be — the one place a person looks to find out
  // where their mail is actually stored, blank and with nothing to explain it.
  const [infoError, setInfoError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) return
    void bridge.appInfo().then(
      (value) => {
        setInfo(value)
        setInfoError(null)
      },
      (e: unknown) => setInfoError(e instanceof Error ? e.message : String(e)),
    )
  }, [bridge])

  const s = state.settings
  const patch = (p: Partial<typeof s>) => dispatch({ type: 'patchSettings', patch: p })

  // The daily digest and holiday greetings used to have their state and
  // handlers here too. They are now `DigestCard` and `GreetingsCard`, defined
  // as their own exported components below `SettingsView` in this same file —
  // see the comment on `DigestCard` for why "their own component" did not also
  // mean "their own file" this time.

  /*
   * The account list, in the arrangement the user dragged it into.
   *
   * Computed once and shared three ways: the rows are rendered from
   * `accountGroups`, the reorder gesture is handed the flat sequence of the
   * same thing, and the reducer gets that sequence straight back. The old code
   * called `groupAccounts(state.accounts)` twice in the same expression — once
   * for the rows and once just to ask how many groups there were — which
   * rebuilt every bucket on every render of a screen that re-renders on every
   * keystroke in any of its sixteen sections.
   *
   * The flat list is `orderedAccounts`, not `state.accounts`: the drag has to
   * be reasoned about in the sequence the user is looking at, and grouping
   * rearranges that sequence. Handing the hook the raw array would mean
   * "the row below this one" and "the next id in the list" were different
   * accounts as soon as anybody used groups.
   */
  const accountGroups = useMemo(() => groupAccounts(state.accounts), [state.accounts])
  const accountOrder = useMemo(() => orderedAccounts(state.accounts).map((a) => a.id), [state.accounts])
  const accountsById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts])

  const reorder = useReorder({
    ids: accountOrder,
    // Groups are drawn as contiguous blocks in a fixed alphabetical sequence,
    // so a row cannot legally leave its own block — see `accountGroupKey`.
    scopeOf: useCallback((id: string) => accountGroupKey(accountsById.get(id)), [accountsById]),
    onReorder: useCallback((ids: string[]) => dispatch({ type: 'reorderAccounts', ids }), [dispatch]),
    announce: useCallback(
      (id: string, position: number, total: number) => {
        const account = accountsById.get(id)
        return t('account.reorderMoved', {
          name: account ? accountLabel(account) : '',
          n: position,
          total,
        })
      },
      [accountsById, t],
    ),
    // One account is already in its final position, and a grip beside it is a
    // control that cannot do anything.
    disabled: state.accounts.length < 2,
  })

  /**
   * The account the app sends as — the one fact the top of this screen is for.
   *
   * `hasSecret` (through `needsStoredPassword`, so an OAuth2 grant is not
   * reported as a missing password) is the whole health check, deliberately:
   * it is already on screen in the account list below, it is the difference
   * between an account that can send and one that cannot, and it costs nothing.
   * No probe, no connection test, no new field — a chip at the top of Settings
   * that opened a socket every time the screen mounted would be a worse bug
   * than the one it reports.
   */
  const defaultAccount = useMemo(() => {
    if (state.accounts.length === 0) return undefined
    return state.accounts.find((a) => a.id === s.defaultAccountId) ?? state.accounts[0]
  }, [state.accounts, s.defaultAccountId])
  const identityNeedsAttention = !defaultAccount || needsStoredPassword(defaultAccount)

  /**
   * What each row says about itself, on the right-hand side.
   *
   * This is not garnish. Below 760px every `hint` and `description` in this
   * application is hidden by the stylesheet, so on the screen this index exists
   * for, a row is a name and a chevron and nothing else — "Sending" with no way
   * to learn whether quiet hours are on without opening it. The value is the
   * only channel left, which is why each string carries its own noun ("Quiet
   * 22:00–07:00", "Log kept 30 days") rather than a bare state word: a row may
   * report a different fact when the first one does not exist yet, and a value
   * that names itself stays readable when it does.
   *
   * Every one of these is read from state this screen already holds. Nothing
   * here starts a request.
   */
  const rowValues = useMemo<Record<string, string | undefined>>(() => {
    const themeLabel = t(
      s.themeMode === 'light'
        ? 'settings.themeLight'
        : s.themeMode === 'dark'
          ? 'settings.themeDark'
          : 'settings.themeSystem',
    )
    const scale = s.textScale ?? 'standard'
    const scaleLabel = t(
      scale === 'large'
        ? 'settings.textScaleLarge'
        : scale === 'larger'
          ? 'settings.textScaleLarger'
          : 'settings.textScaleStandard',
    )
    const notifyOn = [s.notifyOnSuccess, s.notifyOnFailure, s.notifyOnCode !== false].filter(
      Boolean,
    ).length
    const blocking = state.inboxAccounts.some(
      (inbox) => effectiveImagePolicy(inbox.showRemoteImages, s.imagePolicyChosen) !== 'always',
    )
    const countryKey = HOLIDAY_PRESETS.find((p) => p.id === s.greetingCountry)?.labelKey
    /* The folder's name, not its path: a phone's data location is forty
       characters of `/storage/emulated/0/…` and the row is one line. The full
       path is inside, on the About card, where there is room for it. */
    const folder = (info?.dataLocation ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
    return {
      'set-appearance': `${themeLabel} · ${scaleLabel}`,
      'set-notifications':
        notifyOn === 0 ? t('settings.value.allOff') : t('settings.value.onCount', { n: notifyOn }),
      'set-sending': s.quietHoursEnabled
        ? t('settings.value.quiet', { from: s.quietStart, to: s.quietEnd })
        : t('settings.value.quietOff'),
      'set-accounts': t('settings.value.accounts', { n: state.accounts.length }),
      /* Remote images when there is a mailbox to receive any, and the log
         retention when there is not — the setting on this card somebody is most
         likely to have an opinion about, in either case. */
      'set-privacy':
        state.inboxAccounts.length === 0
          ? t('settings.value.logDays', { n: s.logRetentionDays })
          : blocking
            ? t('settings.value.imagesBlocked')
            : t('settings.value.imagesShown'),
      'set-digest': s.digestEnabled
        ? t('settings.value.dailyAt', { time: s.digestTime })
        : t('settings.value.off'),
      'set-greetings': countryKey ? t(countryKey as TranslationKey) : undefined,
      'set-devices':
        state.pairedDevices.length === 0
          ? t('settings.value.noDevices')
          : t('settings.value.devices', { n: state.pairedDevices.length }),
      'set-calendarsub': s.calendarSubscribeEnabled
        ? t('settings.value.on')
        : t('settings.value.off'),
      'set-data': folder,
      'set-control': s.controlEnabled ? t('settings.value.on') : t('settings.value.off'),
      /* Silent when the check itself failed. "Up to date" would be a claim
         nothing behind it supports, and this row is one line with no room to
         explain the difference — the card inside says so properly. */
      'set-update': !updateInfo
        ? undefined
        : updateInfo.available
          ? t('settings.value.updateReady', { version: updateInfo.latest })
          : updateInfo.error
            ? undefined
            : t('settings.value.latest', { version: updateInfo.current }),
      'set-about': info?.version ?? __APP_VERSION__,
    }
  }, [t, s, state.accounts.length, state.inboxAccounts, state.pairedDevices.length, info, updateInfo])

  const removeAccount = async (account: MailAccount) => {
    const ok = await confirm({
      title: t('account.deleteConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    await deleteAccount(account.id)
    toast.push({ tone: 'info', title: t('toast.deleted') })
  }

  const resetAll = async () => {
    const ok = await confirm({
      title: t('settings.resetAll'),
      body: t('settings.resetConfirm'),
      confirmLabel: t('settings.resetAll'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    await resetEverything()
    toast.push({ tone: 'info', title: t('common.done') })
  }

  /* --- the index --------------------------------------------------------
     Sixteen rows in four groups, and one card above them naming the account
     this app sends as. The card is not a sixteenth setting: it is the answer
     to "is this thing working", which is the question somebody actually
     arrives on this screen with, and it is a door into the accounts section
     rather than a second place to edit one.

     Held as a value rather than written inline because it is rendered in two
     different places — inside the scrolling column on a phone, and as the left
     pane of its own in the 600-839px band. Two copies of it would be two lists
     of sixteen rows to keep in the same order. */
  const settingsIndex = (
    <div className="settingsindex">
      <button
        type="button"
        className="settingsid"
        onClick={() => setOpenSection('set-accounts')}
      >
        <span className="settingsid__avatar" aria-hidden="true">
          <IconMail size={20} />
        </span>
        <span className="settingsid__body">
          <span className="settingsid__name">
            {defaultAccount ? accountLabel(defaultAccount) : t('settings.identityNoAccount')}
          </span>
          {defaultAccount ? (
            <span className="settingsid__address">{defaultAccount.fromAddress}</span>
          ) : null}
        </span>
        <StatusChip
          tone={identityNeedsAttention ? 'warning' : 'success'}
          label={
            identityNeedsAttention
              ? t('settings.identityAttention')
              : t('settings.identityHealthy')
          }
          dot
        />
        <IconChevronRight size={16} className="settingsrow__chevron" />
      </button>

      {SETTINGS_GROUPS.map((group) => (
        <div className="settingsgroup" key={group.captionKey}>
          <div className="settingsgroup__caption">{t(group.captionKey)}</div>
          <div className="settingsgroup__list">
            {group.rows.map((row) => {
              const value = rowValues[row.id]
              return (
                <button
                  key={row.id}
                  type="button"
                  className={`settingsrow settingsrow--${row.kind}`}
                  /* Beside a pane the row is no longer a door you go through
                     and come back from — it is a tab, and the one whose
                     section is showing has to say so, or tapping a row
                     changes the right half of the screen and nothing on the
                     left half moves. Only in the band: on a phone the row
                     opens a dialog and there is nothing to mark as current
                     once it closes. */
                  aria-current={twoPane && selectedSection === row.id ? 'true' : undefined}
                  onClick={() => setOpenSection(row.id)}
                >
                  <span className="settingsrow__icon">{row.icon}</span>
                  <span className="settingsrow__label">{t(row.labelKey)}</span>
                  {/* An action row carries no value: "Backup and restore"
                      has no current state, it has a thing it does, and a
                      grey word beside it would only look like one. */}
                  {row.kind === 'panel' && value ? (
                    <span className="settingsrow__value">{value}</span>
                  ) : null}
                  <IconChevronRight size={16} className="settingsrow__chevron" />
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )

  return (
    /* Two columns in the 600-839px band, one everywhere else. The left pane is
       the index; the right one is `.view__inner`, which already holds every
       section and needed no rearranging to become a pane — only a scroller of
       its own. */
    <div className={`view view--settings${twoPane ? ' view--twopane' : ''}`}>
      {twoPane ? (
        <div className="twopane__list">
          {/* The palette button belongs over the index, not over the section.
              It opens the command palette for the whole app, and a lone
              magnifying glass at the top of a panel showing "Appearance" reads
              as a search of that panel. */}
          <PageHead title={t('nav.settings')} hideTitle />
          {settingsIndex}
        </div>
      ) : null}
      {/* A grid, not a column — on a desktop. Sixteen cards stacked one per row
          is a ribbon of settings down the middle of a 2560px monitor with
          nothing either side of it; the anchor markers span the full width so
          the section nav still lands on the right place.

          On a phone the same grid would be one column anyway, and what it
          holds there is not cards but rows (see `SettingsSection`), which want
          to sit flush against each other as a single list rather than floating
          apart with card gaps between them. `--list` is that difference. */}
      <div
        className={`view__inner ${narrow ? 'view__inner--list' : 'view__inner--grid'}${
          twoPane ? ' twopane__detail' : ''
        }`}
      >
        {/* No page *heading*: the tab already highlighted at the bottom (or
            side) of the window says "设置" the moment this screen is open, and
            repeating it here was the only thing this head ever held.

            There is now one thing to keep, which is why the head is back with
            `hideTitle` — the parameter written for exactly this case. On a
            phone `PageHead` draws the search button that opens the command
            palette, and Settings was one of two tabs with no way to reach it
            without a keyboard. The band costs one control's height and only on
            a phone; on a desktop the button is hidden and this collapses to
            nothing, which is what it was before. */}
        {twoPane ? null : <PageHead title={t('nav.settings')} hideTitle />}


        {/* Top of the screen, not tucked into the data card: an app that came
            up factory-fresh because its state file would not parse is
            indistinguishable, from the inside, from one that lost everything.
            It used to rename the file and say nothing at all. */}
        {info?.recoveredFrom?.length ? (
          <Banner tone="warning">
            {t('data.recovered')}
            {info.recoveredFrom.map((path) => (
              <code key={path} className="mono" style={{ display: 'block' }}>
                {path}
              </code>
            ))}
          </Banner>
        ) : null}

        {/* The jump bar, on wide windows only.

            The alternative to it there is tabs, and tabs hide settings behind a
            guess about which one they are under. On a phone it is neither: the
            sections are already a list of rows, so a strip of thirteen labels
            pinned above them is a second index of the same thing, scrolling
            sideways, eating the top of a screen that has none to spare. The
            list itself is built once per language change, above — written
            inline it was a new array on every render, and `SectionNav` keys an
            IntersectionObserver over eight elements on exactly that value. */}
        {narrow ? null : <SectionNav sections={navSections} />}

        {/* On a phone the index is the screen, so it belongs in the column
            with everything else. In the band it is the left pane and is
            rendered above, outside this box. */}
        {narrow && !twoPane ? settingsIndex : null}

        {/* --- accounts ---------------------------------------------------- */}
        <SettingsSection
          id="set-accounts"
          label={sectionLabel('set-accounts')}
          narrow={dialogFor('set-accounts')}
          closeLabel={closeLabel}
          open={openSection === 'set-accounts'}
          onClose={closeSection}
        >
        <Card flush>
          <CardHeader
            title={t('account.title')}
            /* No reorder instructions. They used to sit here as a hint
               whenever there was more than one account; removed on request
               (2026-08-12). The grip is still draggable, still long-pressable
               on touch, and still takes Ctrl/Alt + arrows from the keyboard —
               `aria-keyshortcuts` on the handle is what announces that now,
               to the people who need it announced, instead of a sentence
               every sighted user reads once and then reads forever. */
            action={
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                onClick={() => {
                  setEditing(undefined)
                  setDialogOpen(true)
                }}
              >
                {t('account.add')}
              </Button>
            }
          />
          {/*
            Where a keyboard move gets said out loud.

            Dragging tells you where the row went by showing you; Alt+Arrow
            tells you nothing at all unless something announces it, and a
            screen-reader user pressing it four times would otherwise have to
            re-read the whole list to find out whether any of them worked. Kept
            outside the list it describes so that reordering the rows cannot
            unmount the live region mid-announcement — a region that is removed
            and re-added is a region that has to be re-registered, and anything
            it was about to say is lost.
          */}
          <span className="sr-only" role="status" aria-live="polite">
            {reorder.announcement}
          </span>
          {state.accounts.length === 0 ? (
            /* Was a bare styled div — the only "nothing here" in the app that
               was not an EmptyState, and the only one with no way forward. */
            <EmptyState
              icon={<IconMail size={24} />}
              title={t('compose.noAccount')}
              action={
                <Button
                  variant="primary"
                  icon={<IconPlus size={16} />}
                  onClick={() => {
                    setEditing(undefined)
                    setDialogOpen(true)
                  }}
                >
                  {t('account.add')}
                </Button>
              }
            />
          ) : (
            // Grouped once there is more than one group — see `core/accounts`
            // for why ungrouped sorts last, and why the accounts inside each
            // group come out in the order they were dragged into.
            accountGroups.flatMap((group) => [
              ...(accountGroups.length > 1
                ? [
                    <div className="section-label section-label--inset" key={`h-${group.name ?? '_'}`}>
                      {group.name ?? t('account.ungrouped')}
                    </div>,
                  ]
                : []),
              ...group.accounts.map((a) => {
              const isDefault = (s.defaultAccountId || state.accounts[0]?.id) === a.id
              return (
                <div
                  className="log reorder-row"
                  key={a.id}
                  style={{ alignItems: 'center' }}
                  {...reorder.itemProps(a.id)}
                >
                  {/*
                    The grip is a real button, not a decorated span.

                    It has to be in the tab order for the arrow-key path to be
                    reachable at all, it has to take a keydown, and it has to
                    announce itself as something you operate. A `<div>` with a
                    `draggable` attribute is none of those — it is a control
                    that exists only for people who can see it and point at it,
                    which is the exact failure mode this feature would have had
                    if it had shipped as drag-only.

                    `aria-keyshortcuts` rather than an entry in `Shortcuts.tsx`:
                    the panel documents chords the *global* matcher answers, and
                    `check-shortcuts.mjs` executes that promise by feeding every
                    listed chord to `matchShortcut`. Alt+Arrow here is answered
                    by whichever grip has focus and by nothing at all otherwise,
                    so listing it globally would be documenting a shortcut that
                    does not exist anywhere the panel is open.
                  */}
                  {state.accounts.length > 1 ? (
                    <button
                      type="button"
                      className="reorder-handle"
                      aria-label={t('account.reorderHandle', { name: accountLabel(a) })}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      {...reorder.handleProps(a.id)}
                    >
                      <IconGrip size={16} />
                    </button>
                  ) : null}
                  <div className="log__body">
                    <div className="log__title">
                      {a.label || a.fromAddress}
                      {isDefault ? (
                        <span className="chip" style={{ marginInlineStart: 8 }}>
                          {t('account.default')}
                        </span>
                      ) : null}
                    </div>
                    <div className="log__detail">
                      {/*
                        `?.` because a `state.json` that predates this field, or
                        that a person edited by hand, otherwise throws here —
                        and a throw during render takes the *whole Settings
                        screen* with it. Measured: 0 elements, no message, no
                        way back, which is the same silent-blank failure the
                        boot path was hardened against. The account row is worth
                        showing with one field missing; it is not worth losing
                        every other setting over.
                      */}
                      {a.fromAddress} · {a.host}:{a.port} · {a.security?.toUpperCase() ?? '—'}
                      {/* Not `!a.hasSecret` — see `needsStoredPassword`. An
                          OAuth2 account has a grant rather than a password, and
                          announcing "password: none" beside a mailbox that is
                          signed in and sending is a statement this row has no
                          business making. */}
                      {needsStoredPassword(a) ? ` · ${t('account.password')}: ${t('common.none')}` : ''}
                    </div>
                  </div>
                  {/*
                    `.log__actions`, not bare buttons on the row — see the
                    class's own comment in `app.css`. Bare, `!isDefault`'s
                    "Make default" button is `white-space: nowrap` text that
                    cannot shrink; `.log__body` is the only flexible thing on
                    the row, so on a narrow window it collapsed toward zero
                    and pushed `overflow-wrap: anywhere` onto the address/host
                    line, which is what wrapped it one character at a time
                    instead of at the spaces around its own `·` separators.
                    Grouped like this, the ≤760px rule that already exists for
                    `.log__actions` gives the buttons a line of their own
                    instead of squeezing the text next to them.
                  */}
                  <div className="log__actions">
                    {!isDefault ? (
                      <Button
                        variant="ghost"
                        onClick={() => patch({ defaultAccountId: a.id })}
                      >
                        {t('account.makeDefault')}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(a)
                        setDialogOpen(true)
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                    <IconButton label={t('common.delete')} onClick={() => removeAccount(a)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </div>
                </div>
              )
              }),
            ])
          )}
        </Card>

        {/* --- receiving ------------------------------------------------------
            How often new mail is fetched, and whether the server may push.

            These two lived on the inbox screen itself, in a row above the list,
            and that row was on screen every time anyone opened their mail —
            for a decision made once a year. They are settings, and they are
            about the accounts listed directly above them, so this is where
            they belong; the inbox screen got the ~300px of chrome back.

            Rendered whether or not a bridge exists. `inboxSyncMinutes` and
            `inboxPush` are read by the scheduler regardless (`AppState`), so a
            person who has not added a mailbox yet can still say how they want
            it checked when they do — and a block that vanishes is a block
            nobody can find their way back to. */}
        <Card>
          <Field label={t('inbox.syncEvery')} hint={t('inbox.syncEveryHint')}>
            <select
              className="select"
              value={String(s.inboxSyncMinutes ?? 5)}
              onChange={(e) => patch({ inboxSyncMinutes: Number(e.target.value) })}
            >
              {/* `inbox.syncOff` / `inbox.syncMinutes` rather than a generic
                  "off" and the scheduler's "in N minutes": these are the
                  strings this control has always used, they read as a period
                  rather than as a countdown, and they came across from the
                  inbox screen with the control they belong to. */}
              {[0, 1, 3, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? t('inbox.syncOff') : t('inbox.syncMinutes', { n: m })}
                </option>
              ))}
            </select>
          </Field>
          <Switch
            checked={s.inboxPush !== false}
            onChange={(v) => patch({ inboxPush: v })}
            title={t('inbox.push')}
            description={t('inbox.pushHint')}
          />
        </Card>
        </SettingsSection>

        {/* --- data folder --------------------------------------------------
            Directly under Accounts on purpose. Where your data lives is a
            decision people want to make early and revisit rarely, and burying
            it under six panels of preferences is why it gets missed. */}
        <SettingsSection
          id="set-data"
          label={sectionLabel('set-data')}
          narrow={dialogFor('set-data')}
          closeLabel={closeLabel}
          open={openSection === 'set-data'}
          onClose={closeSection}
        >
          <DataFolderCard />
        </SettingsSection>

        {/* --- backup, transfer, pairing file -------------------------------
            Three neighbours, three sections. They used to share one anchor,
            which was fine when the anchor's only job was to be scrolled to and
            wrong the moment it became a row someone taps: "Backup" opening a
            dialog that also contains reminder transfer and encrypted pairing
            files is a row that lies about what is behind it. They answer
            neighbouring questions and they are not the same question — a
            backup restores *this* install, a transfer moves reminders to
            another, and a pairing file is the offline fallback for LAN
            pairing (see `core/pairingFile.ts`). */}
        <SettingsSection
          id="set-backup"
          label={sectionLabel('set-backup')}
          narrow={dialogFor('set-backup')}
          closeLabel={closeLabel}
          open={openSection === 'set-backup'}
          onClose={closeSection}
        >
          <BackupCard />
        </SettingsSection>

        <SettingsSection
          id="set-transfer"
          label={sectionLabel('set-transfer')}
          narrow={dialogFor('set-transfer')}
          closeLabel={closeLabel}
          open={openSection === 'set-transfer'}
          onClose={closeSection}
        >
          <ScheduleTransferCard />
        </SettingsSection>

        <SettingsSection
          id="set-pairingfile"
          label={sectionLabel('set-pairingfile')}
          narrow={dialogFor('set-pairingfile')}
          closeLabel={closeLabel}
          open={openSection === 'set-pairingfile'}
          onClose={closeSection}
        >
          <PairingFileCard />
        </SettingsSection>

        {/* The live, LAN-paired counterpart to the file above — where a pairing
            is started from either end, and where the devices it produced are
            managed. See `core/pairedDevices.ts` and `core/syncLoop.ts`. */}
        <SettingsSection
          id="set-devices"
          label={sectionLabel('set-devices')}
          narrow={dialogFor('set-devices')}
          closeLabel={closeLabel}
          open={openSection === 'set-devices'}
          onClose={closeSection}
        >
          <DevicesCard />
        </SettingsSection>

        <SettingsSection
          id="set-control"
          label={sectionLabel('set-control')}
          narrow={dialogFor('set-control')}
          closeLabel={closeLabel}
          open={openSection === 'set-control'}
          onClose={closeSection}
        >
          <ControlCard />
        </SettingsSection>

        <SettingsSection
          id="set-calendarsub"
          label={sectionLabel('set-calendarsub')}
          narrow={dialogFor('set-calendarsub')}
          closeLabel={closeLabel}
          open={openSection === 'set-calendarsub'}
          onClose={closeSection}
        >
          <CalendarSubscribeCard />
        </SettingsSection>

        {/* The work calendar used to be a card here, and its anchor outlived
            it. Removed rather than turned into a link to the calendar tab:
            every other entry in that bar scrolls this page, `SectionNav` is
            built around exactly that (it highlights whichever anchor the
            IntersectionObserver reports as on screen, which a link that leaves
            the page can never satisfy), and one entry that navigates away
            instead is a trap for anyone who clicked it to peek. Nothing
            becomes unreachable: the calendar is the seventh sidebar tab and
            Ctrl+7. */}

        <SettingsSection
          id="set-update"
          label={sectionLabel('set-update')}
          narrow={dialogFor('set-update')}
          closeLabel={closeLabel}
          open={openSection === 'set-update'}
          onClose={closeSection}
        >
          <UpdateCard />
        </SettingsSection>

        {/* --- appearance -------------------------------------------------- */}
        <SettingsSection
          id="set-appearance"
          label={sectionLabel('set-appearance')}
          narrow={dialogFor('set-appearance')}
          closeLabel={closeLabel}
          open={openSection === 'set-appearance'}
          onClose={closeSection}
        >
        <Card>
          <div className="card__body">
            <div className="section-label">{t('settings.appearance')}</div>

            <Field label={t('settings.theme')}>
              <Segmented
                value={s.themeMode}
                onChange={(v: ThemeMode) => patch({ themeMode: v })}
                options={[
                  { value: 'system', label: t('settings.themeSystem'), icon: <IconMonitor size={14} /> },
                  { value: 'light', label: t('settings.themeLight'), icon: <IconSun size={14} /> },
                  { value: 'dark', label: t('settings.themeDark'), icon: <IconMoon size={14} /> },
                ]}
              />
            </Field>

            {/* Above the accent, and deliberately: the style decides what the
                seven accent chips will be sitting on. */}
            <Field label={t('settings.visualStyle')}>
              <div className="stylecards">
                {STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    className="stylecard"
                    data-style-preview={style.id}
                    aria-pressed={(s.visualStyle ?? 'aurora') === style.id}
                    onClick={() => patch({ visualStyle: style.id })}
                  >
                    {/* A page, a card on it, an accent and two lines of text —
                        the smallest arrangement that still shows the two things
                        that separate these styles: how far the card sits off the
                        ground, and how sharp its corners are. */}
                    <span className="stylecard__preview" aria-hidden="true">
                      <span className="stylecard__pane">
                        <span className="stylecard__accent" />
                        <span className="stylecard__line" />
                        <span className="stylecard__line stylecard__line--short" />
                      </span>
                    </span>
                    <span className="stylecard__name">{t(style.labelKey)}</span>
                  </button>
                ))}
              </div>
            </Field>

            {(s.visualStyle ?? 'aurora') === 'runecircuit' ? (
              <>
                <Field label={t('settings.accentBase')}>
                  <div className="accent-swatches">
                    {ACCENT_BASES.map(({ id, labelKey }) => (
                      <button
                        key={id}
                        type="button"
                        className="swatch"
                        aria-pressed={(s.accentBase ?? 'ink') === id}
                        aria-label={t(labelKey)}
                        title={t(labelKey)}
                        style={{ background: `var(--classical-${id}-now)`, color: `var(--classical-${id}-now)` }}
                        onClick={() => patch({ accentBase: id })}
                      />
                    ))}
                  </div>
                </Field>
                <Field label={t('settings.accentCyber')}>
                  <div className="accent-swatches">
                    {ACCENT_CYBERS.map(({ id, labelKey }) => (
                      <button
                        key={id}
                        type="button"
                        className="swatch"
                        aria-pressed={(s.accentCyber ?? 'cyan') === id}
                        aria-label={t(labelKey)}
                        title={t(labelKey)}
                        style={{ background: `var(--cyber-${id}-now)`, color: `var(--cyber-${id}-now)` }}
                        onClick={() => patch({ accentCyber: id })}
                      />
                    ))}
                  </div>
                </Field>
                <Field label={t('settings.atmosphereIntensity')}>
                  <input
                    className="range"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={s.themeIntensity ?? 60}
                    onChange={(e) => patch({ themeIntensity: Number(e.target.value) })}
                  />
                </Field>
              </>
            ) : (
              <Field label={t('settings.accent')}>
                <div className="accent-swatches">
                  {ACCENTS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="swatch"
                      aria-pressed={s.accent === id}
                      aria-label={id}
                      title={id}
                      style={{ background: `var(--accent-${id}-now)`, color: `var(--accent-${id}-now)` }}
                      onClick={() => patch({ accent: id })}
                    />
                  ))}
                </div>
              </Field>
            )}

            <div className="field__row">
              <Field label={t('settings.density')}>
                <Segmented
                  value={s.density}
                  onChange={(v: Density) => patch({ density: v })}
                  options={[
                    { value: 'comfortable', label: t('settings.densityComfortable') },
                    { value: 'compact', label: t('settings.densityCompact') },
                  ]}
                />
              </Field>

              {/* Separate from the control density above, and deliberately so:
                  someone scanning four hundred log rows wants tighter *rows*
                  without every button and input in this screen shrinking too. */}
              <Field label={t('settings.listDensity')}>
                <Segmented
                  value={s.listDensity ?? 'standard'}
                  onChange={(v: 'compact' | 'standard' | 'roomy') => patch({ listDensity: v })}
                  options={[
                    { value: 'compact', label: t('settings.listCompact') },
                    { value: 'standard', label: t('settings.listStandard') },
                    { value: 'roomy', label: t('settings.listRoomy') },
                  ]}
                />
              </Field>

              {/* Above the language picker and below the two density controls
                  deliberately: this is the third and last thing on this card
                  that changes how much of the screen a word takes, and the
                  three read as one group. */}
              <Field label={t('settings.textScale')} hint={t('settings.textScaleHint')}>
                <Segmented
                  value={s.textScale ?? 'standard'}
                  onChange={(v: 'standard' | 'large' | 'larger') => patch({ textScale: v })}
                  options={[
                    { value: 'standard', label: t('settings.textScaleStandard') },
                    { value: 'large', label: t('settings.textScaleLarge') },
                    { value: 'larger', label: t('settings.textScaleLarger') },
                  ]}
                />
              </Field>

              {/* Phone-only in effect — the stylesheet gates it on
                  `data-shell="mobile"` — but shown on every platform rather
                  than hidden on a desktop, because a desktop window narrow
                  enough to be a touch shell exists and a setting that
                  disappears is harder to find than one that says what it is
                  for. The hint carries that. */}
              <Switch
                checked={s.oneHand ?? false}
                onChange={(v) => patch({ oneHand: v })}
                title={t('settings.oneHand')}
                description={t('settings.oneHandHint')}
              />

              {/* Round 8's four new behaviours, all defaulting on, all here
                  rather than each next to the thing it affects.

                  That is a deliberate choice and it cuts against the usual
                  rule. Each of these is a *quiet* behaviour — a vibration, an
                  inverted page, a folded quote, an extra confirm card — and the
                  person who wants one off is, by definition, someone it just
                  annoyed and who now wants to find the switch. Someone in that
                  state opens Settings and scans; they do not remember which
                  screen the behaviour belonged to. Four switches in one place
                  they can scan beats four switches each correctly filed. */}
              <Switch
                checked={s.haptics !== false}
                onChange={(v) => patch({ haptics: v })}
                title={t('settings.haptics')}
                description={t('settings.hapticsHint')}
              />
              <Switch
                checked={s.readerDarkInvert !== false}
                onChange={(v) => patch({ readerDarkInvert: v })}
                title={t('settings.readerDarkInvert')}
                description={t('settings.readerDarkInvertHint')}
              />
              <Switch
                checked={s.readerFoldQuotes !== false}
                onChange={(v) => patch({ readerFoldQuotes: v })}
                title={t('settings.readerFoldQuotes')}
                description={t('settings.readerFoldQuotesHint')}
              />
              <Switch
                checked={s.composePreflight !== false}
                onChange={(v) => patch({ composePreflight: v })}
                title={t('settings.composePreflight')}
                description={t('settings.composePreflightHint')}
              />

              <Field label={t('settings.language')}>
                <select
                  className="select"
                  value={s.locale}
                  onChange={(e) => patch({ locale: e.target.value as LocalePreference })}
                >
                  {/* Default, and deliberately first: a machine that changes
                      display language should carry the app with it — including
                      the tray menu, which the main process draws from this. */}
                  <option value="system">{t('settings.languageSystem')}</option>
                  {LOCALES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.nativeName}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        </Card>

        </SettingsSection>

        {/* --- sending ----------------------------------------------------- */}
        <SettingsSection
          id="set-sending"
          label={sectionLabel('set-sending')}
          narrow={dialogFor('set-sending')}
          closeLabel={closeLabel}
          open={openSection === 'set-sending'}
          onClose={closeSection}
        >
        <Card>
          <div className="card__body">
            <div className="section-label">{t('settings.sending')}</div>

            <div className="field__row">
              <Field label={t('settings.bulkThreshold')} hint={t('settings.recipients')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={1000}
                  value={s.bulkConfirmThreshold}
                  onChange={(e) => patch({ bulkConfirmThreshold: Number(e.target.value) })}
                />
              </Field>
              <Field label={t('settings.attachmentWarn')} hint={t('settings.megabytes')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={200}
                  value={s.attachmentWarnMb}
                  onChange={(e) => patch({ attachmentWarnMb: Number(e.target.value) })}
                />
              </Field>
              <Field label={t('settings.attachmentMax')} hint={t('settings.megabytes')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={200}
                  value={s.attachmentMaxMb}
                  onChange={(e) => patch({ attachmentMaxMb: Number(e.target.value) })}
                />
              </Field>
            </div>

            <Switch
              checked={s.snapshotAttachments}
              onChange={(v) => patch({ snapshotAttachments: v })}
              title={t('settings.snapshotAttachments')}
              description={t('schedule.snapshotHint')}
            />

            <div className="section-label" style={{ marginTop: 'var(--sp-2)' }}>
              {t('settings.limits')}
            </div>

            <div className="field__row">
              <Field label={t('settings.connectTimeout')} hint={t('settings.seconds')}>
                <input
                  className="input"
                  type="number"
                  min={5}
                  max={120}
                  value={s.connectTimeoutSeconds}
                  onChange={(e) => patch({ connectTimeoutSeconds: Number(e.target.value) })}
                />
              </Field>
            </div>

            <Switch
              checked={s.quietHoursEnabled}
              onChange={(v) => patch({ quietHoursEnabled: v })}
              title={t('settings.quietHoursOn')}
            />
            {s.quietHoursEnabled ? (
              <div className="field__row">
                <Field label={t('settings.quietFrom')}>
                  <input
                    className="input"
                    type="time"
                    value={s.quietStart}
                    onChange={(e) => patch({ quietStart: e.target.value })}
                  />
                </Field>
                <Field label={t('settings.quietTo')}>
                  <input
                    className="input"
                    type="time"
                    value={s.quietEnd}
                    onChange={(e) => patch({ quietEnd: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </Card>

        {/* --- daily digest -------------------------------------------------
            The switch is the whole control surface. What it writes is one
            ordinary reminder in the schedule, budgeted by the same recurrence
            engine as everything else — there is no digest timer anywhere in
            this application, and adding one would give it two answers to the
            question that engine exists to own. */}
        </SettingsSection>

        <SettingsSection
          id="set-digest"
          label={sectionLabel('set-digest')}
          narrow={dialogFor('set-digest')}
          closeLabel={closeLabel}
          open={openSection === 'set-digest'}
          onClose={closeSection}
        >
        <DigestCard />

        {/* --- holiday greetings --------------------------------------------
            A planner, not an automation. Nothing here runs on its own: the
            plan appears when asked for, the reminders appear when confirmed,
            and every one of them is visible and cancellable on the Schedule
            screen. Mail that creates itself out of sight is the mirror image
            of mail that silently fails to go, and this app exists to have
            neither. */}
        </SettingsSection>

        <SettingsSection
          id="set-greetings"
          label={sectionLabel('set-greetings')}
          narrow={dialogFor('set-greetings')}
          closeLabel={closeLabel}
          open={openSection === 'set-greetings'}
          onClose={closeSection}
        >
        <GreetingsCard />

        {/* --- notifications & system -------------------------------------- */}
        </SettingsSection>

        <SettingsSection
          id="set-notifications"
          label={sectionLabel('set-notifications')}
          narrow={dialogFor('set-notifications')}
          closeLabel={closeLabel}
          open={openSection === 'set-notifications'}
          onClose={closeSection}
        >
        <Card>
          <div className="card__body">
            <div className="section-label">{t('settings.notifications')}</div>
            <Switch
              checked={s.notifyOnSuccess}
              onChange={(v) => patch({ notifyOnSuccess: v })}
              title={t('settings.notifySuccess')}
            />
            <Switch
              checked={s.notifyOnFailure}
              onChange={(v) => patch({ notifyOnFailure: v })}
              title={t('settings.notifyFailure')}
            />
            {/* Default on. The whole point of the codes screen is not having to
                go looking, and a notification that carries the code itself is
                the version of that which needs no screen at all. */}
            <Switch
              checked={s.notifyOnCode !== false}
              onChange={(v) => patch({ notifyOnCode: v })}
              title={t('settings.notifyOnCode')}
            />
            {/* Also default on, and the switch that was missing entirely: until
                it existed, ordinary mail arriving in a watched mailbox raised
                nothing at all on either platform. Directly under the code
                switch because the two answer the same question about the same
                mailbox, and the pair reads as one decision. */}
            <Switch
              checked={s.notifyOnNewMail !== false}
              onChange={(v) => patch({ notifyOnNewMail: v })}
              title={t('settings.notifyOnNewMail')}
            />

            {/*
              Android only, and only worth showing at all because both of these
              can be off while the app looks completely healthy. The switches
              above promise notifications; if the system permission behind them
              is missing, they promise nothing, and until this card existed
              there was no screen anywhere that said so.

              Read live rather than remembered: the only way to change either is
              to leave for a system settings screen, so the value is re-read
              whenever the window comes back to the foreground.
            */}
            {permissions ? (
              <>
                <div className="section-label" style={{ marginTop: 'var(--sp-2)' }}>
                  {t('settings.androidPermissions')}
                </div>
                <div className="field">
                  <div className="switch__text">
                    <span className="switch__title">{t('settings.permNotifications')}</span>
                  </div>
                  <div className="btn-row">
                    <StatusChip
                      tone={permissions.notifications === 'granted' ? 'success' : 'warning'}
                      label={t(
                        permissions.notifications === 'granted'
                          ? 'settings.permGranted'
                          : permissions.notifications === 'blocked'
                            ? 'settings.permBlocked'
                            : 'settings.permNotAsked',
                      )}
                    />
                    {permissions.notifications !== 'granted' ? (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void fixPermission(
                            permissions.canAskNotifications
                              ? 'requestNotifications'
                              : 'openNotificationSettings',
                          )
                        }
                      >
                        {t(
                          permissions.canAskNotifications
                            ? 'settings.permAsk'
                            : 'settings.permOpenSettings',
                        )}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="field">
                  <div className="switch__text">
                    <span className="switch__title">{t('settings.permExactAlarms')}</span>
                  </div>
                  <div className="btn-row">
                    <StatusChip
                      tone={permissions.exactAlarms === 'denied' ? 'warning' : 'success'}
                      label={t(
                        permissions.exactAlarms === 'granted'
                          ? 'settings.permGranted'
                          : permissions.exactAlarms === 'denied'
                            ? 'settings.permDenied'
                            : 'settings.permNotRequired',
                      )}
                    />
                    {permissions.exactAlarms === 'denied' ? (
                      <Button variant="ghost" onClick={() => void fixPermission('openExactAlarmSettings')}>
                        {t('settings.permOpenSettings')}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {/*
                  A phone whose manufacturer manages background apps on top of
                  stock Android (Xiaomi, Huawei, OPPO, vivo, Samsung all ship
                  one) can freeze this app between alarms even with both
                  permissions above granted — the mail simply stops arriving
                  and sending on time, with nothing on screen to say why.
                  Same card shape as "Alarms & reminders" just above; the
                  fix is a direct Allow/Deny dialog rather than a settings
                  screen, so it can be offered again after a "not now".
                */}
                <div className="field">
                  <div className="switch__text">
                    <span className="switch__title">{t('settings.permBatteryOptimization')}</span>
                  </div>
                  <div className="btn-row">
                    <StatusChip
                      tone={permissions.batteryOptimized === 'denied' ? 'warning' : 'success'}
                      label={t(
                        permissions.batteryOptimized === 'granted'
                          ? 'settings.permGranted'
                          : permissions.batteryOptimized === 'denied'
                            ? 'settings.permDenied'
                            : 'settings.permNotRequired',
                      )}
                    />
                    {permissions.batteryOptimized === 'denied' ? (
                      <Button
                        variant="ghost"
                        onClick={() => void fixPermission('openBatteryOptimizationSettings')}
                      >
                        {t('settings.permAsk')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}

            <div className="section-label" style={{ marginTop: 'var(--sp-2)' }}>
              {t('settings.system')}
            </div>
            <Switch
              checked={s.minimiseToTray}
              onChange={(v) => patch({ minimiseToTray: v })}
              title={t('settings.minimiseToTray')}
            />
            <Switch
              checked={s.launchAtLogin}
              onChange={(v) => patch({ launchAtLogin: v })}
              title={t('settings.launchAtLogin')}
            />
          </div>
        </Card>

        {/* --- privacy ----------------------------------------------------- */}
        </SettingsSection>

        <SettingsSection
          id="set-privacy"
          label={sectionLabel('set-privacy')}
          narrow={dialogFor('set-privacy')}
          closeLabel={closeLabel}
          open={openSection === 'set-privacy'}
          onClose={closeSection}
        >
        <Card>
          <div className="card__body">
            <div className="section-label">{t('settings.privacy')}</div>
            {/*
              Both limits, and both of them real.

              The days box existed and did nothing to the data: it was applied
              as a display filter on the Logs screen, so "keep for 30 days"
              hid older entries while every recipient address stayed in
              `state.json`. The count limit did not exist at all — it was a
              hardcoded 500 in the reducer. They are enforced in `pruneLogs`
              now, on the way into state, which is the copy that gets written
              to disk.
            */}
            <div className="field__row">
              <Field label={t('settings.logRetention')} hint={t('settings.days')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={365}
                  value={s.logRetentionDays}
                  onChange={(e) => patch({ logRetentionDays: Number(e.target.value) })}
                />
              </Field>
              <Field label={t('settings.logMaxEntries')} hint={t('settings.entries')}>
                <input
                  className="input"
                  type="number"
                  min={10}
                  max={10000}
                  step={10}
                  value={s.logMaxEntries}
                  onChange={(e) => patch({ logMaxEntries: Number(e.target.value) })}
                />
              </Field>
            </div>
            <div className="field__hint">
              {t('settings.logRetentionHint', { n: state.logs.length })}
            </div>
            <Switch
              checked={s.redactLogs}
              onChange={(v) => patch({ redactLogs: v })}
              title={t('settings.redactLogs')}
            />
            {/*
              Two switches that existed in the settings type, were read on every
              run, and could not be reached from anywhere.

              `autoCopyCode` puts a verification code on the system clipboard
              the moment one is recognised, and `draftHistoryEnabled` keeps a
              rolling copy of unsent draft bodies on disk. Both are read as
              `!== false`, so both were permanently on, and neither had a
              control or even a translated string — the app was overwriting the
              clipboard and storing draft text with no way to decline. That is
              precisely the kind of thing a user goes looking for a switch for,
              and the honest fix is the switch, not a paragraph explaining why
              there isn't one.

              Titles carry their own meaning rather than leaning on a
              `description`: the descriptions are hidden below 760px anyway, so
              a switch that needs one is a switch nobody on a phone understands.
            */}
            <Switch
              checked={s.autoCopyCode !== false}
              onChange={(v) => patch({ autoCopyCode: v })}
              title={t('settings.autoCopyCode')}
            />
            <Switch
              checked={s.draftHistoryEnabled !== false}
              onChange={(v) => patch({ draftHistoryEnabled: v })}
              title={t('settings.draftHistory')}
            />

            {/*
              And the two cache limits, for the same reason.

              The main process reads them out of `state.json` with hardcoded
              fallbacks of 500 MB and 90 days (`electron/main.ts`), and those
              two `??` were the only references in the repository besides the
              type. A data folder growing towards half a gigabyte of downloaded
              mail had no control anywhere that touched it.
            */}
            <div className="section-label" style={{ marginTop: 'var(--sp-2)' }}>
              {t('settings.inboxCache')}
            </div>
            <div className="field__row">
              <Field label={t('settings.inboxCacheMaxMb')} hint={t('settings.megabytes')}>
                <input
                  className="input"
                  type="number"
                  min={50}
                  max={20000}
                  step={50}
                  value={s.inboxCacheMaxMb}
                  onChange={(e) => patch({ inboxCacheMaxMb: Number(e.target.value) })}
                />
              </Field>
              <Field label={t('settings.inboxCacheRetentionDays')} hint={t('settings.days')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={3650}
                  value={s.inboxCacheRetentionDays}
                  onChange={(e) => patch({ inboxCacheRetentionDays: Number(e.target.value) })}
                />
              </Field>
            </div>

            {/*
              Remote images: off by default, meaning they are shown.

              Worth being precise about what this switch does and does not
              trade away, because "images are blocked for your privacy" hid a
              cost nobody agreed to — every HTML message arriving as a grid of
              blank rectangles. The images are never fetched by the message
              itself: the body frame has no network access at all and the CSP
              forbids it one. They come through the main process, which
              refuses private addresses, refuses redirects, and caps the size.
              What blocking still buys is the read receipt — the sender learns
              the mail was opened, and roughly from where — which is a real
              thing to want, per account, and is what this is here for.
            */}
            <div className="section-label" style={{ marginTop: 'var(--sp-2)' }}>
              {t('settings.remoteImages')}
            </div>
            {state.inboxAccounts.length === 0 ? (
              <div className="field__hint">{t('settings.remoteImagesNoAccounts')}</div>
            ) : (
              state.inboxAccounts.map((inbox) => {
                const account = state.accounts.find((a) => a.id === inbox.accountId)
                const name = account?.label || account?.fromAddress || inbox.accountId
                const policy = effectiveImagePolicy(inbox.showRemoteImages, s.imagePolicyChosen)
                const allowed = inbox.imageAllowlist ?? []
                const write = (next: Partial<InboxAccountState>) => {
                  // Pin every *other* account to what it shows right now,
                  // first. `imagePolicyChosen` is app-wide, so flipping it
                  // changes how a stored 'never' is read everywhere — and
                  // answering the question for one mailbox must not silently
                  // answer it for the rest.
                  if (!s.imagePolicyChosen) {
                    for (const other of state.inboxAccounts) {
                      if (other.accountId === inbox.accountId) continue
                      const pinned = effectiveImagePolicy(other.showRemoteImages, false)
                      if (other.showRemoteImages !== pinned) {
                        dispatch({
                          type: 'upsertInboxAccount',
                          inbox: { ...other, showRemoteImages: pinned },
                        })
                      }
                    }
                  }
                  dispatch({ type: 'upsertInboxAccount', inbox: { ...inbox, ...next } })
                  // Recording that the question has been answered is what stops
                  // a pre-wiring 'never' being read as the old default forever.
                  patch({ imagePolicyChosen: true })
                }
                return (
                  <div key={inbox.accountId}>
                    <Switch
                      checked={policy !== 'always'}
                      onChange={(v) =>
                        write({
                          // Turning it on with senders already allowed keeps
                          // them allowed — "block, except these" is the state
                          // the reader's own button produces, and flattening it
                          // back to a plain block here would silently undo it.
                          showRemoteImages: v ? (allowed.length > 0 ? 'allowlist' : 'never') : 'always',
                        })
                      }
                      title={t('settings.blockRemoteImages', { name })}
                    />
                    {policy !== 'always' && allowed.length > 0 ? (
                      <div className="field__hint settings-allowlist">
                        {t('settings.imagesAllowedFrom')}
                        {allowed.map((domain) => (
                          <button
                            key={domain}
                            type="button"
                            className="chip chip--toggle"
                            aria-pressed
                            title={t('settings.imagesStopAllowing', { domain })}
                            onClick={() => {
                              const next = allowed.filter((d) => d !== domain)
                              write({
                                imageAllowlist: next,
                                showRemoteImages: next.length > 0 ? 'allowlist' : 'never',
                              })
                            }}
                          >
                            {domain} ✕
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}

            <Banner tone="success">
              <IconShield size={13} style={{ verticalAlign: -2, marginInlineEnd: 4 }} />
              {t('account.storedSafely')}
            </Banner>
          </div>
        </Card>

        {/* --- about ------------------------------------------------------- */}
        </SettingsSection>

        <SettingsSection
          id="set-about"
          label={sectionLabel('set-about')}
          narrow={dialogFor('set-about')}
          closeLabel={closeLabel}
          open={openSection === 'set-about'}
          onClose={closeSection}
        >
        <Card>
          <div className="card__body">
            <div className="section-label">{t('settings.about')}</div>
            {infoError ? (
              <Banner tone="warning">
                {t('settings.aboutFailed')} — {infoError}
              </Banner>
            ) : null}
            <div className="kv">
              <div className="kv__k">{t('settings.version')}</div>
              <div className="kv__v">{info?.version ?? __APP_VERSION__}</div>
              <div className="kv__k">{t('settings.platform')}</div>
              <div className="kv__v">
                {info?.platform ?? '—'} {info?.os ? `· ${info.os}` : ''}
              </div>
              <div className="kv__k">{t('settings.dataLocation')}</div>
              <div className="kv__v mono">{info?.dataLocation ?? '—'}</div>
              <div className="kv__k">{t('settings.license')}</div>
              <div className="kv__v">MIT</div>
              <div className="kv__k">{t('settings.sourceCode')}</div>
              <div className="kv__v">
                <button
                  type="button"
                  className="link"
                  onClick={() => bridge?.openExternal(REPO_URL)}
                >
                  {REPO_URL} <IconExternal size={12} />
                </button>
              </div>
            </div>

            <div>
              <Button variant="danger" icon={<IconTrash size={15} />} onClick={resetAll}>
                {t('settings.resetAll')}
              </Button>
            </div>
          </div>
        </Card>
        </SettingsSection>
      </div>

      <AccountDialog
        open={dialogOpen}
        initial={editing}
        knownGroups={knownGroups(state.accounts)}
        inboxConfig={state.inboxAccounts.find((i) => i.accountId === editing?.id)}
        onClose={() => setDialogOpen(false)}
        onSave={async (account, secret) => {
          await saveAccount(account, secret)
          toast.push({ tone: 'success', title: t('toast.saved') })
        }}
        onSaveInbox={(config, secret) => saveInboxAccount(config, secret)}
        onTestInbox={(config, secret) => testInboxAccount(config, secret)}
        onTest={async (account, secret) =>
          (await bridge?.testConnection(account, secret)) ?? {
            ok: false,
            accepted: [],
            rejected: [],
            durationMs: 0,
            error: 'Bridge unavailable',
            errorKind: 'config',
          }
        }
        onOpenExternal={(url) => bridge?.openExternal(url)}
      />

      {confirmElement}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The daily digest and holiday greetings — also a Home tile
// ---------------------------------------------------------------------------

/**
 * The daily digest — one mail summarising what is armed, what already ran
 * today, and whether anything is quietly wrong. See `core/digest.ts` for the
 * counting itself, which this component only ever reads through and never
 * re-derives.
 *
 * Exported and used from two places — this screen's `set-digest` section
 * and, via `views/HomeView.tsx`'s "每日简报" tile, the Home hub — and kept in
 * this file rather than moved into one of its own under `views/`, which is
 * where a component with two callers would ordinarily go.
 *
 * The reason is `scripts/check-digest.mjs`: it asserts this feature's wiring —
 * the switch bound to `digestEnabled`, the preview built through the real
 * renderer rather than a hand-written approximation — by reading
 * `SettingsView.tsx`'s own source text for the literal calls, not by asking
 * what any component does at runtime. A `DigestCard` moved to its own file
 * would still be one implementation reused in two places, which is the actual
 * goal; it would also be invisible to a guard that greps this file by name,
 * and a guard that silently stopped checking anything is a worse outcome than
 * an unusual file layout. `HomeView` reaches this export the same way it
 * reaches every screen behind it — `lazy(() => import('./SettingsView')...)`
 * — and `SettingsView` is already on `App.tsx`'s idle-time prefetch list, so
 * the chunk backing this tile has typically already loaded by the time either
 * caller asks for it.
 */
export function DigestCard() {
  const { state, dispatch } = useApp()
  const { t, formatDateTime } = useI18n()
  const s = state.settings
  const patch = (p: Partial<typeof s>) => dispatch({ type: 'patchSettings', patch: p })

  const [digestPreview, setDigestPreview] = useState<string | null>(null)

  /**
   * The preview goes through the very functions that build the mail.
   *
   * A preview assembled separately is a preview of a different message, and
   * this one exists precisely so the user can see what will land in their inbox
   * before agreeing to receive it every morning.
   */
  const previewDigest = () => {
    const digest = buildDigest(state.jobs, {
      quiet: { enabled: s.quietHoursEnabled, start: s.quietStart, end: s.quietEnd },
      calendar: s.workCalendar,
      excludeJobIds: [DIGEST_JOB_ID],
    })
    const names = new Map(state.jobs.map((j) => [j.id, j.name]))
    const ctx = { t, formatDateTime, jobName: (id: string) => names.get(id) ?? id }
    setDigestPreview(`${renderDigestSubject(digest, ctx)}\n\n${renderDigestBody(digest, ctx)}`)
  }

  return (
    <Card>
      <div className="card__body">
        <div className="section-label">{t('settings.digest')}</div>
        {state.accounts.length === 0 ? (
          <Banner tone="warning">{t('settings.digestNoAccount')}</Banner>
        ) : null}
        <Switch
          checked={s.digestEnabled}
          onChange={(v) => patch({ digestEnabled: v })}
          title={t('settings.digestOn')}
        />
        {s.digestEnabled ? (
          <>
            <Field label={t('settings.digestTime')}>
              <input
                className="input"
                type="time"
                value={s.digestTime}
                onChange={(e) => patch({ digestTime: e.target.value })}
              />
            </Field>
            <Field label={t('settings.digestAccount')}>
              <select
                className="input"
                value={s.digestAccountId ?? ''}
                onChange={(e) => patch({ digestAccountId: e.target.value || undefined })}
              >
                <option value="">{t('settings.accountAuto')}</option>
                {state.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label || a.fromAddress}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('settings.digestTo')} hint={t('settings.digestToHint')}>
              <input
                className="input"
                type="email"
                value={s.digestTo ?? ''}
                onChange={(e) => patch({ digestTo: e.target.value })}
              />
            </Field>
            <div className="btn-row">
              <Button variant="ghost" icon={<IconMail size={16} />} onClick={previewDigest}>
                {t('settings.digestPreview')}
              </Button>
            </div>
            {digestPreview !== null ? (
              <div>
                <div className="section-label">{t('settings.digestPreviewTitle')}</div>
                <pre className="mono digest-preview">{digestPreview}</pre>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  )
}

/**
 * Holiday greetings — planned, reviewed, and only ever created as ordinary
 * scheduled reminders. See `core/greetings.ts`, which plans and never sends,
 * and `DigestCard`'s comment just above for why this lives here rather than
 * in a file of its own: `scripts/check-greetings.mjs` asserts this screen's
 * wiring — the plan starting empty, creation living behind a confirmation,
 * the deterministic job id — by reading `SettingsView.tsx`'s source, and
 * `views/HomeView.tsx`'s "节日问候" tile reaches this same export rather than
 * a copy of it.
 *
 * A planner, not an automation. Nothing here runs unattended. The plan
 * appears only when asked for, the reminders it produces are ordinary,
 * visible, cancellable entries on the Schedule screen, and pressing "create"
 * twice replaces the same jobs (`greetingJobId` is deterministic) rather than
 * duplicating them.
 */
export function GreetingsCard() {
  const { state, dispatch, scheduleDraft } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const s = state.settings
  const patch = (p: Partial<typeof s>) => dispatch({ type: 'patchSettings', patch: p })

  const [greetYear, setGreetYear] = useState(() => new Date().getFullYear())
  /**
   * `null` until the user asks. Not computed on render, and deliberately so:
   * a plan that appears by itself is one press away from mail nobody asked to
   * write, and the whole point of this card is that the press comes first.
   */
  const [greetPlan, setGreetPlan] = useState<GreetingOccasion[] | null>(null)

  const greetAccountId = s.greetingAccountId || s.defaultAccountId || state.accounts[0]?.id

  const showGreetPlan = () => {
    setGreetPlan(
      planGreetings(
        state.contacts.map((c) => ({
          address: c.address,
          name: c.name,
          country: c.fields?.country,
        })),
        greetYear,
        {
          calendar: s.workCalendar,
          timeOfDay: s.greetingTime,
          defaultCountry: s.greetingCountry,
        },
      ),
    )
  }

  /**
   * Turn the reviewed plan into ordinary reminders.
   *
   * Behind a confirmation, and it creates *schedule entries* rather than
   * sending anything: this application's identity is that it never silently
   * sends and never silently fails to send, and a feature that manufactured
   * outgoing mail on dates it worked out for itself would break the first half
   * of that as thoroughly as a silent drop breaks the second.
   */
  const createGreetings = async () => {
    if (!greetPlan || greetPlan.length === 0 || !greetAccountId) return
    const ok = await confirm({
      title: t('settings.greetConfirmTitle'),
      body: t('settings.greetConfirm', { n: greetPlan.length }),
      confirmLabel: t('settings.greetCreate', { n: greetPlan.length }),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    const subject = s.greetingSubject.trim() || t('greet.defaultSubject')
    const body = s.greetingBody.trim() || t('greet.defaultBody')
    const now = Date.now()

    for (const occasion of greetPlan) {
      await scheduleDraft({
        // Deterministic, so pressing this twice replaces rather than duplicates.
        id: greetingJobId(occasion),
        name: t('settings.greetJobName', { holiday: occasion.name }),
        enabled: true,
        draft: {
          ...emptyDraft(greetAccountId),
          to: occasion.recipients.map((r) => r.address),
          subject,
          body,
          bodyFormat: 'plain',
          // So `{{holiday}}` and `{{name}}` resolve per recipient at send time
          // rather than being frozen into the text now.
          mergeEnabled: true,
        },
        recurrence: {
          ...defaultRecurrence(now),
          kind: 'once',
          startAt: occasion.at,
          timeOfDay: s.greetingTime,
        },
        occurrences: [],
        runCount: 0,
        retry: DEFAULT_RETRY,
        status: 'armed',
        createdAt: now,
        updatedAt: now,
      })
    }

    toast.push({ tone: 'success', title: t('settings.greetCreated', { n: greetPlan.length }) })
    setGreetPlan(null)
  }

  return (
    <>
      <Card>
        <div className="card__body">
          <div className="section-label">{t('settings.greetings')}</div>
          {state.accounts.length === 0 ? (
            <Banner tone="warning">{t('settings.greetNoAccount')}</Banner>
          ) : null}
          {state.contacts.length === 0 ? (
            <Banner tone="info">{t('settings.greetNoContacts')}</Banner>
          ) : null}

          <Field label={t('settings.greetCountry')}>
            <select
              className="input"
              value={s.greetingCountry}
              onChange={(e) => {
                patch({ greetingCountry: e.target.value })
                setGreetPlan(null)
              }}
            >
              {GREETING_COUNTRIES.map((id) => (
                <option key={id} value={id}>
                  {t(
                    (HOLIDAY_PRESETS.find((p) => p.id === id)?.labelKey ??
                      'workcal.preset.CN') as TranslationKey,
                  )}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.greetYear')}>
            <input
              className="input"
              type="number"
              min={2000}
              max={2099}
              value={greetYear}
              onChange={(e) => {
                setGreetYear(Number(e.target.value))
                setGreetPlan(null)
              }}
            />
          </Field>
          <Field label={t('settings.greetTime')}>
            <input
              className="input"
              type="time"
              value={s.greetingTime}
              onChange={(e) => {
                patch({ greetingTime: e.target.value })
                setGreetPlan(null)
              }}
            />
          </Field>
          <Field label={t('settings.greetAccount')}>
            <select
              className="input"
              value={s.greetingAccountId ?? ''}
              onChange={(e) => patch({ greetingAccountId: e.target.value || undefined })}
            >
              <option value="">{t('settings.accountAuto')}</option>
              {state.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label || a.fromAddress}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.greetSubject')}>
            <input
              className="input"
              value={s.greetingSubject}
              placeholder={t('greet.defaultSubject')}
              onChange={(e) => patch({ greetingSubject: e.target.value })}
            />
          </Field>
          <Field label={t('settings.greetBody')} hint={t('settings.greetVars')}>
            <textarea
              className="textarea"
              rows={4}
              value={s.greetingBody}
              placeholder={t('greet.defaultBody')}
              onChange={(e) => patch({ greetingBody: e.target.value })}
            />
          </Field>


          <div className="btn-row">
            <Button variant="ghost" icon={<IconRefresh size={16} />} onClick={showGreetPlan}>
              {t('settings.greetPlan')}
            </Button>
            {greetPlan && greetPlan.length > 0 ? (
              /* Disabled without a sending account rather than left enabled:
                 `createGreetings` returns immediately in that case, and a
                 primary button that visibly does nothing is the failure this
                 app is least willing to ship. The banner above says why. */
              <Button
                variant="primary"
                disabled={!greetAccountId}
                onClick={() => void createGreetings()}
              >
                {t('settings.greetCreate', { n: greetPlan.length })}
              </Button>
            ) : null}
          </div>

          {greetPlan === null ? null : greetPlan.length === 0 ? (
            <EmptyState icon={<IconMail size={20} />} title={t('settings.greetNone', { year: greetYear })} />
          ) : (
            <ul className="greetplan">
              {greetPlan.map((occasion) => (
                <li key={occasion.key} className="greetplan__row">
                  <span>
                    {t('settings.greetRow', {
                      date: occasion.date,
                      holiday: occasion.name,
                      country: occasion.country,
                      n: occasion.recipients.length,
                    })}
                  </span>
                  <span className="btn-row">
                    <StatusChip
                      tone="neutral"
                      label={t(
                        occasion.source === 'statutory'
                          ? 'settings.greetSourceStatutory'
                          : 'settings.greetSourcePreset',
                      )}
                    />
                    {state.jobs.some((j) => j.id === greetingJobId(occasion)) ? (
                      <StatusChip tone="warning" label={t('settings.greetExists')} />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {confirmElement}
    </>
  )
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Check, download, install — in that order, with the state of each visible.
 *
 * The desktop can do all three. Android stops at "open the download", because
 * an APK has to be installed by the system package installer and nothing an
 * app does can shortcut that.
 */
function UpdateCard() {
  const { state, dispatch, bridge } = useApp()
  const { t, formatBytes, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  /**
   * Seeded from the last check rather than from `null`.
   *
   * The check that matters happens at launch, in `App`, long before this card
   * exists — see the effect there for why it had to move. So the card's job is
   * to draw an answer somebody else already has, and starting empty would make
   * a freshly opened Settings screen claim "not checked yet" seconds after the
   * check ran.
   */
  const [info, setInfo] = useState<UpdateInfo | null>(() => lastUpdateCheck())
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)

  const canInstallHere = Boolean(bridge?.downloadUpdate && bridge?.installUpdate)

  useEffect(() => {
    if (!bridge?.onUpdateProgress) return
    return bridge.onUpdateProgress(setProgress)
  }, [bridge])

  // …and for the other order: Settings already open when the startup check
  // lands. This card deliberately does *not* check on mount any more. It used
  // to, guarded by a ref — but a ref dies with the component, so leaving
  // Settings and coming back spent another request every time, which is
  // exactly what the comment above it claimed was not happening.
  useEffect(() => onUpdateCheck(setInfo), [])

  /**
   * The manual check, which always says how it went.
   *
   * The startup check is silent unless it finds something — nobody wants a
   * notification every launch. A check the user *asked for* is the opposite
   * case: when the answer is "you already have the newest version", nothing on
   * the card moves, and a button that produces no visible change reads as a
   * button that did nothing.
   *
   * That is not a hypothetical: this function used to take a `manual` flag and
   * the button passed `false`, so the one path that needed a toast was the one
   * path that never got one. Pressing "Check for updates" while already on the
   * newest version changed nothing on screen at all. There is only one caller
   * now, and it is always the button.
   */
  const check = useCallback(async () => {
    if (!bridge) return
    setChecking(true)
    try {
      // Publishes to the shared store, so `setInfo` below is belt-and-braces —
      // and, unlike a bare `bridge.checkForUpdate()`, it cannot reject into an
      // unhandled rejection when the IPC call itself fails.
      const result = await runUpdateCheck(() => bridge.checkForUpdate(), __APP_VERSION__)
      setInfo(result)
      if (result.available) {
        toast.push({ tone: 'info', title: t('update.newVersionToast', { version: result.latest }) })
      } else if (result.error) {
        toast.push({ tone: 'error', title: t('update.failed'), detail: result.error })
      } else {
        toast.push({ tone: 'success', title: t('update.upToDate', { version: result.current }) })
      }
    } finally {
      setChecking(false)
    }
  }, [bridge, toast, t])

  const download = async () => {
    if (!bridge?.downloadUpdate || !info?.asset) return
    setDownloading(true)
    setProgress({ receivedBytes: 0, totalBytes: info.asset.sizeBytes, done: false })
    try {
      const result = await bridge.downloadUpdate(info.asset)
      setProgress(result)
    } catch (e) {
      setProgress(null)
      toast.push({
        tone: 'error',
        title: t('update.failed'),
        detail: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setDownloading(false)
    }
  }

  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : 0

  const install = async () => {
    if (!bridge?.installUpdate || !progress?.done || !progress.path) return
    if (progress.checksumVerified === false) {
      const ok = await confirm({
        title: t('update.installUnverifiedTitle'),
        body: t('update.installUnverifiedBody'),
        confirmLabel: t('update.installUnverifiedConfirm'),
        cancelLabel: t('common.cancel'),
        danger: true,
      })
      if (!ok) return
    }
    /*
     * Awaited, not fire-and-forget.
     *
     * On the desktop this hands off to an installer and the app is about to be
     * replaced, so a rejection had nowhere useful to go and `void` was
     * harmless. Android added a failure that is both common and completely
     * recoverable: "install unknown apps" is a per-app toggle with no request
     * dialog, and without it the handoff fails. The native side opens that
     * settings screen on the way out, but a button that silently does nothing
     * while a settings page appears is a button the user will not connect to
     * the page — so it has to say what it wants.
     */
    try {
      await bridge.installUpdate(progress.path)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      toast.push(
        message === 'ANDROID_UNKNOWN_SOURCES'
          ? {
              // `info`, not `error`: nothing went wrong, there is a step left.
              // The settings screen it names is already on top of this toast,
              // so the wording has to still make sense when the user comes
              // back from it a minute later.
              tone: 'info',
              title: t('update.installNeedsPermission'),
              detail: t('update.installNeedsPermissionHint'),
            }
          : { tone: 'error', title: t('update.failed'), detail: message },
      )
    }
  }

  return (
    <Card>
      <div className="card__body">
        <div className="section-label">{t('update.title')}</div>

        {/*
          Three states, not two.

          This used to render "Aevistle {version} is the latest version" from
          the *build* version whenever `info` was null — that is, before any
          check had run at all, and again whenever a check failed. The card
          asserted the one thing it had no way to know: that nothing newer
          exists. Someone who had never been online, or whose check had just
          timed out, was told they were up to date.

          Now the headline only claims "latest" when a check actually came back
          saying so. Otherwise it states which version is installed, which is
          the only fact available without a network round trip, and the line
          beneath says whether a check has ever happened.
        */}
        <div className="update-row">
          <div className="update-row__text">
            <div className="update-version">
              {info?.available
                ? t('update.available', { version: info.latest })
                : info && !info.error
                  ? t('update.upToDate', { version: info.current })
                  : t('update.currentVersion', { version: info?.current ?? __APP_VERSION__ })}
            </div>
            <div className="update-meta">
              {checking
                ? t('update.checking')
                : info?.error
                  ? `${t('update.failed')} — ${info.error}`
                  : info
                    ? /*
                       * The timestamp itself, not a relative phrase.
                       *
                       * This line was `formatRelative`, which describes how far
                       * away a *future* moment is and answers "overdue" for
                       * anything already past — so a check that finished four
                       * seconds ago was labelled 已逾期, indistinguishable from
                       * a check that never ran. `formatAgo` fixed the lie but
                       * kept the vagueness: "just now" is true for anything
                       * under a minute and stops being useful the moment you
                       * are trying to work out whether a check actually
                       * happened. A date and time answers that outright, and it
                       * is the one line on this card whose whole job is to say
                       * when something happened.
                       */
                      t('update.lastChecked', { when: formatDateTime(info.checkedAt) })
                    : t('update.neverChecked')}
            </div>
          </div>

          <Button icon={<IconRefresh size={16} />} disabled={checking} onClick={() => check()}>
            {checking ? t('update.checking') : t('update.check')}
          </Button>
        </div>

        {info?.available ? (
          <>
            {info.notes ? <div className="update-notes">{info.notes}</div> : null}

            {progress && !progress.done ? (
              <>
                <div className="progress">
                  <div className="progress__bar" style={{ width: `${percent}%` }} />
                </div>
                <div className="update-meta">{t('update.downloading', { percent })}</div>
              </>
            ) : null}

            {progress?.done && progress.checksumVerified === false ? (
              <Banner tone="warning">{t('update.unverifiedBanner')}</Banner>
            ) : null}

            <div className="btn-row">
              {canInstallHere && info.asset && !progress?.done ? (
                <Button
                  variant="primary"
                  icon={<IconDownload size={16} />}
                  loading={downloading}
                  onClick={download}
                >
                  {t('update.download', { size: formatBytes(info.asset.sizeBytes) })}
                </Button>
              ) : null}

              {canInstallHere && progress?.done && progress.path ? (
                <Button variant="primary" onClick={install}>
                  {t('update.install')}
                </Button>
              ) : null}

              <Button variant="ghost" onClick={() => bridge?.openExternal(info.pageUrl)}>
                {t('update.openPage')} <IconExternal size={12} />
              </Button>
            </div>

            {/* Three outcomes, not two. Android can install in-app now, but it
                does not do what the desktop does: the app is not closed and
                replaced by an installer, Android puts its own confirmation
                screen up. Telling a phone user "Aevistle closes so the
                installer can replace it" describes something they will not
                see, and the sentence that matters to them — that their
                reminders survive — was in neither string. */}
            {canInstallHere ? (
              <div className="update-meta">
                {t(bridge?.platform === 'android' ? 'update.installHintAndroid' : 'update.installHint')}
              </div>
            ) : (
              <div className="update-meta">{t('update.androidHint')}</div>
            )}
          </>
        ) : null}

        <Switch
          checked={state.settings.updateCheckOnStart}
          onChange={(v) => dispatch({ type: 'patchSettings', patch: { updateCheckOnStart: v } })}
          title={t('update.onStart')}
          description={t('update.onStartHint')}
        />
      </div>
      {confirmElement}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Data folder
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * Where everything the app writes is kept, and how to move it.
 *
 * The move is the interesting part: the files are copied by the platform, then
 * `relocateData` rewrites the paths recorded inside every scheduled job. Doing
 * only the first half would leave a reminder that fires on time and arrives
 * with its attachment missing.
 */
/** Dynamic ids from the platform, mapped to keys the compiler can check. */
const OPTION_LABEL: Record<string, TranslationKey> = {
  default: 'data.option.default',
  external: 'data.option.external',
  sdcard: 'data.option.sdcard',
}

const STAYS_LABEL: Record<string, TranslationKey> = {
  secrets: 'data.stays.secrets',
  schedule: 'data.stays.schedule',
}

function DataFolderCard() {
  const { bridge, relocateData } = useApp()
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [folder, setFolder] = useState<DataFolder | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!bridge) return
    try {
      setFolder(await bridge.dataFolder())
      setLoadError(null)
    } catch (e) {
      /*
       * Kept, not swallowed. A rejected `dataFolder()` — a revoked Android SAF
       * grant is the realistic one — used to leave `folder` null, and the
       * `return null` below then drew nothing: on a desktop the jump bar
       * scrolled to an empty anchor, and on a phone the Settings row still
       * opened a full-height dialog with a title and no content. Same shape as
       * the `return null` already fixed in ControlCard and
       * CalendarSubscribeCard.
       */
      setFolder(null)
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!bridge) return null

  if (!folder) {
    return (
      <Card>
        <div className="card__body">
          <div className="section-label">{t('data.title')}</div>
          <Banner tone="warning">
            {t('data.failed')}
            {loadError ? ` — ${loadError}` : ''}
          </Banner>
          <div className="btn-row">
            <Button disabled={busy} onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  const apply = async (run: (move: boolean) => Promise<DataFolderChange>) => {
    if (busy) return
    // Asked once, before anything is touched: leaving the files behind is a
    // legitimate choice (a fresh start on a new machine), but it is not the one
    // most people want, so it is not the default.
    const move = await confirm({
      title: t('data.moveTitle'),
      body: t('data.moveBody'),
      confirmLabel: t('data.moveFiles'),
      cancelLabel: t('data.leaveFiles'),
    })

    setBusy(true)
    const previous = folder.path
    try {
      const change = await run(move)
      if (!change.changed) return
      await relocateData(change, previous)
      await refresh()
      toast.push({
        tone: change.warning ? 'info' : 'success',
        title: change.warning ?? t('data.switched'),
        detail: change.path,
      })
    } catch (e) {
      toast.push({
        tone: 'error',
        title: t('data.failed'),
        detail: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="card__body">
        <div className="section-label">{t('data.title')}</div>

        {folder.fellBack ? (
          <Banner tone="warning">{t('data.fellBack')}</Banner>
        ) : null}

        <Field label={t('data.current')}>
          <div className="path-row">
            <code className="path-row__value">{folder.path}</code>
            <span className="chip">{formatBytes(folder.sizeBytes)}</span>
          </div>
        </Field>

        <div className="btn-row">
          {folder.canPickAny ? (
            <Button
              variant="primary"
              icon={<IconFolder size={16} />}
              disabled={busy}
              onClick={() => apply((move) => bridge.chooseDataFolder(move))}
            >
              {t('data.choose')}
            </Button>
          ) : null}

          {folder.canPickAny ? (
            <Button disabled={busy} onClick={() => void bridge.openDataFolder()}>
              {t('data.open')}
            </Button>
          ) : null}

          {!folder.isDefault ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => apply((move) => bridge.useDataFolder('default', move))}
            >
              {t('data.reset')}
            </Button>
          ) : null}
        </div>

        {/* Android: fixed volumes rather than a free folder picker. */}
        {folder.options.length > 1 ? (
          <div className="option-list">
            {folder.options.map((option) => {
              const active = option.path === folder.path
              return (
                <button
                  key={option.id}
                  type="button"
                  className="option"
                  aria-pressed={active}
                  disabled={busy || !option.available || active}
                  onClick={() => apply((move) => bridge.useDataFolder(option.id, move))}
                >
                  <span className="option__title">
                    {t(OPTION_LABEL[option.id] ?? 'data.option.default')}
                  </span>
                  <span className="option__path">{option.path || '—'}</span>
                  <span className="option__meta">
                    {!option.available
                      ? t('data.unavailable')
                      : option.freeBytes !== undefined
                        ? t('data.free', { size: formatBytes(option.freeBytes) })
                        : ''}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}

        {folder.staysBehind.length > 0 ? (
          <Banner tone="info">
            <IconShield size={13} style={{ verticalAlign: -2, marginInlineEnd: 4 }} />
            {folder.staysBehind
              .map((k) => STAYS_LABEL[k])
              .filter(Boolean)
              .map((k) => t(k))
              .join(' · ')}
          </Banner>
        ) : null}
      </div>
      {confirmElement}
    </Card>
  )
}
