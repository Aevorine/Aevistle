import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  PageHead,
  Segmented,
  StatusChip,
  Switch,
  useConfirm,
  useToast,
} from '../components/ui'
import {
  IconAlert,
  IconCalendar,
  IconDatabase,
  IconDownload,
  IconExternal,
  IconFileText,
  IconFolder,
  IconGlobe,
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
import { useNarrow } from '../components/useNarrow'
import { groupAccounts, knownGroups } from '../core/accounts'
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
import { buildDigest, DIGEST_JOB_ID } from '../core/digest'
import { renderDigestBody, renderDigestSubject } from '../core/digestText'
import {
  GREETING_COUNTRIES,
  greetingJobId,
  planGreetings,
  type GreetingOccasion,
} from '../core/greetings'
import { HOLIDAY_PRESETS } from '../core/holidayPresets'
import type { AppInfo, DataFolder, DataFolderChange } from '../core/bridge'
import { lastUpdateCheck, onUpdateCheck, runUpdateCheck } from '../core/update'
import type { DownloadProgress, UpdateInfo } from '../core/update'

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
    scheduleDraft,
  } = useApp()

  const { t, formatDateTime } = useI18n()

  /**
   * Phone layout is a different structure, not a restyle — see
   * `components/SettingsSection.tsx`. Everything below renders identically in
   * both; only the wrapper decides whether a section is a card on the page or
   * a row that opens a dialog.
   */
  const narrow = useNarrow()

  /** Passed to every section so the dialog's close button is translated once, here, rather than sixteen times. */
  const closeLabel = t('common.close')

  /**
   * The jump bar's entries.
   *
   * No calendar entry. It was a card on this screen once; it is a top-level
   * tab now (`core/nav.ts`), and what was left behind was a jump-bar button
   * pointing at an empty marker div sitting immediately above the Updates card
   * — so "Work calendar" silently scrolled you to Updates, and the
   * IntersectionObserver highlighted it as the section you were reading.
   */
  const navSections = useMemo(
    () => [
      { id: 'set-accounts', label: t('account.title') },
      { id: 'set-data', label: t('data.title') },
      { id: 'set-backup', label: t('backup.title') },
      { id: 'set-devices', label: t('settings.devices') },
      { id: 'set-control', label: t('control.title') },
      { id: 'set-update', label: t('update.title') },
      { id: 'set-appearance', label: t('settings.appearance') },
      { id: 'set-sending', label: t('settings.sending') },
      { id: 'set-digest', label: t('settings.digest') },
      { id: 'set-greetings', label: t('settings.greetings') },
      { id: 'set-notifications', label: t('settings.notifications') },
      { id: 'set-privacy', label: t('settings.privacy') },
      { id: 'set-about', label: t('settings.about') },
    ],
    [t],
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

  // --- the daily digest ----------------------------------------------------

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

  // --- holiday greetings ---------------------------------------------------

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

  return (
    <div className="view view--settings">
      {/* A grid, not a column — on a desktop. Sixteen cards stacked one per row
          is a ribbon of settings down the middle of a 2560px monitor with
          nothing either side of it; the anchor markers span the full width so
          the section nav still lands on the right place.

          On a phone the same grid would be one column anyway, and what it
          holds there is not cards but rows (see `SettingsSection`), which want
          to sit flush against each other as a single list rather than floating
          apart with card gaps between them. `--list` is that difference. */}
      <div className={`view__inner ${narrow ? 'view__inner--list' : 'view__inner--grid'}`}>
        {/*
          No subtitle on a phone.

          "Accounts, appearance, data and updates" is a summary of the list
          directly beneath it, which on this layout is sixteen labelled rows
          starting one line lower — so it names four of the sixteen and then
          gets out of the way of the other twelve. It is also inside a *sticky*
          head, so it does not scroll away: it holds ~28px at the top of every
          screenful of a list the whole point of which was to stop Settings
          being a scroll.

          Kept on a desktop, where the head is one row of a wide grid and the
          summary is the only thing telling you what this screen covers before
          you read sixteen cards.
        */}
        <PageHead
          title={t('settings.title')}
          subtitle={narrow ? undefined : t('settings.subtitle')}
        />

        {/* Top of the screen, not tucked into the data card: an app that came
            up factory-fresh because its state file would not parse is
            indistinguishable, from the inside, from one that lost everything.
            It used to rename the file and say nothing at all. */}
        {info?.recoveredFrom ? (
          <Banner tone="warning">
            {t('data.recovered')}
            <code className="mono">{info.recoveredFrom}</code>
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

        {/* --- accounts ---------------------------------------------------- */}
        <SettingsSection
          id="set-accounts"
          label={t('account.title')}
          icon={<IconMail size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
        <Card flush>
          <CardHeader
            title={t('account.title')}
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
          {state.accounts.length === 0 ? (
            /* Was a bare styled div — the only "nothing here" in the app that
               was not an EmptyState, and the only one with no way forward. */
            <EmptyState
              icon={<IconMail size={24} />}
              title={t('compose.noAccount')}
              hint={t('account.emptyHint')}
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
            // for why ungrouped sorts last.
            groupAccounts(state.accounts).flatMap((group) => [
              ...(groupAccounts(state.accounts).length > 1
                ? [
                    <div className="section-label section-label--inset" key={`h-${group.name ?? '_'}`}>
                      {group.name ?? t('account.ungrouped')}
                    </div>,
                  ]
                : []),
              ...group.accounts.map((a) => {
              const isDefault = (s.defaultAccountId || state.accounts[0]?.id) === a.id
              return (
                <div className="log" key={a.id} style={{ alignItems: 'center' }}>
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
                      {a.hasSecret ? '' : ` · ${t('account.password')}: ${t('common.none')}`}
                    </div>
                  </div>
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
              )
              }),
            ])
          )}
        </Card>
        </SettingsSection>

        {/* --- data folder --------------------------------------------------
            Directly under Accounts on purpose. Where your data lives is a
            decision people want to make early and revisit rarely, and burying
            it under six panels of preferences is why it gets missed. */}
        <SettingsSection
          id="set-data"
          label={t('data.title')}
          icon={<IconFolder size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
          label={t('backup.title')}
          icon={<IconDatabase size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
          <BackupCard />
        </SettingsSection>

        <SettingsSection
          id="set-transfer"
          label={t('transfer.title')}
          icon={<IconSend size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
          <ScheduleTransferCard />
        </SettingsSection>

        <SettingsSection
          id="set-pairingfile"
          label={t('pairing.file.export')}
          icon={<IconKey size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
          <PairingFileCard />
        </SettingsSection>

        {/* The live, LAN-paired counterpart to the file above — where a pairing
            is started from either end, and where the devices it produced are
            managed. See `core/pairedDevices.ts` and `core/syncLoop.ts`. */}
        <SettingsSection
          id="set-devices"
          label={t('devices.title')}
          icon={<IconLink size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
          <DevicesCard />
        </SettingsSection>

        <SettingsSection
          id="set-control"
          label={t('control.title')}
          icon={<IconGlobe size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
          <ControlCard />
        </SettingsSection>

        <SettingsSection
          id="set-calendarsub"
          label={t('cal.subscribe.toggle')}
          icon={<IconCalendar size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
          label={t('update.title')}
          icon={<IconDownload size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
          <UpdateCard />
        </SettingsSection>

        {/* --- appearance -------------------------------------------------- */}
        <SettingsSection
          id="set-appearance"
          label={t('settings.appearance')}
          icon={<IconSun size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
            <Field label={t('settings.visualStyle')} hint={t('settings.styleHint')}>
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
                <Field label={t('settings.atmosphereIntensity')} hint={t('settings.atmosphereIntensityHint')}>
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
          label={t('settings.sending')}
          icon={<IconSend size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
              description={t('settings.quietHoursHint')}
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
          label={t('settings.digest')}
          icon={<IconFileText size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
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
              description={t('settings.digestHint')}
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
          label={t('settings.greetings')}
          icon={<IconStar size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
        >
        <Card>
          <div className="card__body">
            <div className="section-label">{t('settings.greetings')}</div>
            <div className="field__hint">{t('settings.greetHint')}</div>
            {state.accounts.length === 0 ? (
              <Banner tone="warning">{t('settings.greetNoAccount')}</Banner>
            ) : null}
            {state.contacts.length === 0 ? (
              <Banner tone="info">{t('settings.greetNoContacts')}</Banner>
            ) : null}

            <Field label={t('settings.greetCountry')} hint={t('settings.greetCountryHint')}>
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

            <div className="field__hint">{t('settings.greetMoving')}</div>

            <div className="btn-row">
              <Button variant="ghost" icon={<IconRefresh size={16} />} onClick={showGreetPlan}>
                {t('settings.greetPlan')}
              </Button>
              {greetPlan && greetPlan.length > 0 ? (
                <Button variant="primary" onClick={() => void createGreetings()}>
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

        {/* --- notifications & system -------------------------------------- */}
        </SettingsSection>

        <SettingsSection
          id="set-notifications"
          label={t('settings.notifications')}
          icon={<IconAlert size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
              description={t('settings.notifyOnCodeHint')}
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
                    <span className="switch__desc">{t('settings.permNotificationsHint')}</span>
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
                    <span className="switch__desc">{t('settings.permExactAlarmsHint')}</span>
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
              </>
            ) : null}

            <div className="section-label" style={{ marginTop: 'var(--sp-2)' }}>
              {t('settings.system')}
            </div>
            <Switch
              checked={s.minimiseToTray}
              onChange={(v) => patch({ minimiseToTray: v })}
              title={t('settings.minimiseToTray')}
              description={t('settings.trayHint')}
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
          label={t('settings.privacy')}
          icon={<IconShield size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
                      description={t('settings.blockRemoteImagesHint')}
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
          label={t('settings.about')}
          icon={<IconInfo size={17} />}
          narrow={narrow}
          closeLabel={closeLabel}
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
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!bridge) return
    try {
      setFolder(await bridge.dataFolder())
    } catch {
      setFolder(null)
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!bridge || !folder) return null

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

        <Field label={t('data.current')} hint={t('data.currentHint')}>
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
