import { useMemo, useState } from 'react'
import { CountdownRing } from '../components/CountdownRing'
import { HealthAllClear } from '../components/HealthBoard'
import { VirtualList } from '../components/VirtualList'
import {
  Button,
  EmptyState,
  IconButton,
  Modal,
  PageHead,
  StatusChip,
  useConfirm,
  useToast,
} from '../components/ui'
import { IconClock, IconCopy, IconEdit, IconPause, IconPlay, IconSend, IconTrash } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import { planRestagger } from '../core/schedule/reschedule'
import { summarizeRecurrence } from '../core/schedule/schedule'
import { isFinished } from '../core/schedule/jobRun'
import { seedEditJob } from '../core/mail/editJobSeed'
import { ATMOSPHERE_MOTION_MIN, type ScheduledJob } from '../core/types'

/**
 * Matches `--dur-slow` in theme.css — there is no clean way to read a CSS
 * custom property's *time* value back into a `setTimeout`, so this is a
 * second copy of the same number rather than a shared source. If the two ever
 * drift, the row disappears from `state.jobs` slightly before or after its
 * own exit animation finishes playing; nothing worse than that depends on
 * them staying equal.
 */
const INK_BLOOM_MS = 260

/**
 * How far "postpone" postpones.
 *
 * Ten minutes because the action exists for one situation — the ring has gone
 * amber, the send is minutes away and you are not ready — and the answer to
 * that is a nudge, not a reschedule. Anything longer is a change to the
 * schedule and belongs on the compose screen, which is one tap away through
 * the same row's edit button.
 */
const SNOOZE_MS = 10 * 60_000

/** Soonest first; a reminder with nothing left to fire sorts to the bottom. */
function byNextRun(a: ScheduledJob, b: ScheduledJob) {
  const an = a.occurrences[0] ?? Number.MAX_SAFE_INTEGER
  const bn = b.occurrences[0] ?? Number.MAX_SAFE_INTEGER
  return an - bn
}

/**
 * A narrowing this screen can be *opened* with, rather than one the reader has
 * to reproduce by hand once they get here.
 *
 * One value so far, and it is Home's 今天要发 figure. A named type rather than a
 * boolean because the second one — "this week", "failed", "this chain" — is
 * then another value here instead of a second flag that can contradict the
 * first.
 */
export type ScheduleFocus = 'today'

const DAY_MS = 86_400_000

/**
 * Whether `at` falls on the calendar day `now` is in — compared as local
 * midnights, so 23:30 → 00:30 is a different day rather than "half an hour, so
 * the same one".
 *
 * A local copy of the rule `HomeView`'s `daysAhead` applies, deliberately not
 * imported from it: `HomeView` reaches this screen through `lazy(() =>
 * import('./ScheduleView'))`, so a static import back the other way would drag
 * the whole home screen — and the eleven modules it lazily owns — into the
 * chunk that `App.tsx` loads when the schedule tab is opened on a desktop that
 * never renders Home at all. Five lines duplicated is the cheaper of the two.
 * The two definitions have to agree, and the thing that would notice if they
 * stopped is the count in the chip below sitting under a figure that says
 * something else.
 */
function isToday(at: number, now: number): boolean {
  const a = new Date(at)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((a.getTime() - b.getTime()) / DAY_MS) === 0
}

export function ScheduleView({
  onCompose,
  focus,
}: {
  onCompose: () => void
  /**
   * Optional, and every existing caller omits it — `App.tsx`'s own tab opens
   * this screen at its full list, as it always has. Only Home's 今天要发 figure
   * passes anything, and what it passes is the narrowing that makes the list
   * under the figure the records the figure counted.
   */
  focus?: ScheduleFocus
}) {
  const { state, dispatch, toggleJob, deleteJob, runJobNow, pushUndo, scheduleDraft } = useApp()
  const { t, formatDateTime, formatRelative, formatAgo } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * Which job's ring menu is open, by id rather than by value.
   *
   * By id because the menu outlives a render: the ticker behind the ring
   * re-renders this screen while the menu is up, and a captured `ScheduledJob`
   * would go on describing the occurrence list as it was when the ring was
   * pressed. Looked up fresh below.
   */
  const [menuJobId, setMenuJobId] = useState<string | null>(null)
  /**
   * Rows mid-`ink-bloom` (app.css) — present in `state.jobs` for the length of
   * their exit animation rather than gone the instant delete is clicked. Only
   * ever non-empty under runecircuit with the motion threshold cleared; every
   * other style's `remove` still deletes on the spot, same as before this
   * existed.
   */
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const ceremonialDelete =
    state.settings.visualStyle === 'runecircuit' &&
    (state.settings.themeIntensity ?? 60) >= ATMOSPHERE_MOTION_MIN

  /**
   * Finished reminders move out of the way instead of sitting at the top of
   * the list looking like they are about to fire.
   *
   * Keyed off `status === 'done'`, which the scheduler now actually maintains
   * — until this release it never left the value the job was created with, so
   * a partition like this would have put everything in the same bucket
   * forever. See `core/jobRun.ts`.
   *
   * Kept on screen rather than hidden: "did last month's reminder go out?" is
   * a question people ask, and an archive they can see beats a list that
   * silently forgets.
   */
  const [showDone, setShowDone] = useState(false)

  /**
   * The narrowing this screen was opened with, held as state so it can be let
   * go of.
   *
   * A prop read straight into the render would be a filter with no off switch:
   * the reader would arrive at four rows, have no way to see the other thirty,
   * and — worse — no way to tell that thirty were being withheld. Seeded once
   * from `focus` (this screen is mounted fresh each time Home's dialog opens,
   * so there is no second seeding to worry about) and cleared by the chip that
   * announces it, or by either tab.
   */
  const [focused, setFocused] = useState<ScheduleFocus | null>(focus ?? null)

  /*
   * Memoised, and not for the sort.
   *
   * These three lines used to run in the render body, so every render produced
   * a *new array* even when nothing about the schedule had changed — and this
   * screen reads the whole app context, so an inbox sync, a log line or the
   * 20-second outbox tick renders it. `VirtualList` keys its `keys` memo, its
   * `offsets` prefix sum and, worst, its measuring layout effect off that array
   * identity; the effect calls `getBoundingClientRect()` on every mounted row,
   * which is a forced synchronous layout, and can then bump its own version and
   * do it again. Every other list screen in the app already memoises here —
   * `InboxView`, `LogsView`, `ContactsView`, `CodesView`. This was the holdout.
   */
  const active = useMemo(() => state.jobs.filter((j) => !isFinished(j)).sort(byNextRun), [state.jobs])
  // Most recently completed first: the one that just fired is the one being
  // looked for.
  const done = useMemo(
    () => state.jobs.filter((j) => isFinished(j)).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0)),
    [state.jobs],
  )

  /**
   * The rows Home's 今天要发 figure counted — the same predicate, over the same
   * array.
   *
   * Written against `state.jobs` rather than as `active.filter(...)` on
   * purpose. `active` also drops `status === 'done'`, and a figure that counted
   * a job the list it opens then hides is exactly the disagreement this whole
   * change exists to remove: the number would say four and four rows would not
   * be there. The two predicates have to be read side by side to stay equal —
   * `HomeView.tsx`'s `todayQueued` is the other half, and the chip below prints
   * this count so any drift shows up as two different numbers on one screen
   * rather than as nothing at all.
   *
   * `enabled`, and the first occurrence *at or after now*: a paused reminder
   * has occurrences and is not going to fire, and one whose 08:00 send already
   * went out this morning is not still "to send today".
   */
  const todayJobs = useMemo(() => {
    const now = Date.now()
    return state.jobs
      .filter((j) => {
        if (!j.enabled) return false
        const at = j.occurrences.find((o) => o >= now)
        return at !== undefined && isToday(at, now)
      })
      .sort(byNextRun)
  }, [state.jobs])

  const jobs = showDone ? done : focused ? todayJobs : active

  /**
   * The actual removal from `state.jobs`, ceremonial-delete-aware.
   *
   * Under every style but runecircuit (or runecircuit below the motion
   * threshold) this is `deleteJob` called immediately, unchanged from before
   * `ink-bloom` existed. Under runecircuit it instead marks the rows
   * `data-removing` — which is what triggers app.css's `ink-bloom` animation —
   * and defers the real `deleteJob` by `INK_BLOOM_MS`, so the row the user
   * watches disappear is the one still in the list, animating, rather than one
   * that vanished instantly while a CSS class chased it.
   *
   * The `setRemovingIds` updater is where the double-fire guard actually
   * lives: it computes `toAnimate` — the ids not already mid-animation — from
   * `prev`, not from the `removingIds` closed over at call time, so two
   * `remove()` calls queued in the same tick (a chain's lone sibling can reach
   * this from both the "cancel all" and "cancel one" branches below) still see
   * each other's claim rather than both scheduling their own timeout for the
   * same id.
   */
  const deleteWithAnimation = (ids: string[]) => {
    if (!ceremonialDelete) {
      for (const jobId of ids) void deleteJob(jobId)
      return
    }
    let toAnimate: string[] = []
    setRemovingIds((prev) => {
      toAnimate = ids.filter((jobId) => !prev.has(jobId))
      if (toAnimate.length === 0) return prev
      const next = new Set(prev)
      toAnimate.forEach((jobId) => next.add(jobId))
      return next
    })
    if (toAnimate.length === 0) return
    window.setTimeout(() => {
      for (const jobId of toAnimate) void deleteJob(jobId)
      setRemovingIds((prev) => {
        const next = new Set(prev)
        toAnimate.forEach((jobId) => next.delete(jobId))
        return next
      })
    }, INK_BLOOM_MS)
  }

  /**
   * Delete a reminder — and, if it is one stage of a chain, offer to take the
   * rest with it. Deleting "3 days before" on its own and leaving "the day
   * before" behind is occasionally what someone wants and usually not; asking
   * costs one extra click and saves finding the strays later.
   */
  const remove = async (id: string) => {
    const job = state.jobs.find((j) => j.id === id)
    const siblings = job?.chainId
      ? state.jobs.filter((j) => j.chainId === job.chainId)
      : []

    if (siblings.length > 1) {
      const all = await confirm({
        title: t('confirm.deleteJob'),
        body: t('chain.partOf', { n: siblings.length }),
        confirmLabel: t('chain.cancelAll', { n: siblings.length }),
        cancelLabel: t('chain.cancelOne'),
        danger: true,
      })
      // Either answer deletes something, so there is no "cancel" here — the
      // dialog's dismiss (Esc / backdrop) is handled by the promise resolving
      // false, which is why "only this one" is the false branch rather than a
      // third option nobody would find.
      deleteWithAnimation((all ? siblings : [job!]).map((j) => j.id))
      toast.push({ tone: 'info', title: t('toast.deleted') })
      return
    }

    const ok = await confirm({
      title: t('confirm.deleteJob'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    deleteWithAnimation([id])
    toast.push({ tone: 'info', title: t('toast.deleted') })
  }

  /**
   * Send this one again, later. The commonest thing anyone does with a
   * finished reminder is want another like it, and rebuilding it by hand from
   * the recipients up is the tax this removes.
   */
  const repeat = (job: (typeof jobs)[number]) => {
    dispatch({ type: 'setDraft', patch: { ...job.draft } })
    toast.push({ tone: 'info', title: t('schedule.copiedToCompose') })
    onCompose()
  }

  /**
   * Open this exact reminder on the compose screen for change, rather than
   * "send another" (`repeat`, above), which only copies the message and
   * always creates something new. See `core/editJobSeed.ts`.
   */
  const edit = (job: (typeof jobs)[number]) => {
    seedEditJob(job)
    onCompose()
  }

  const runNow = async (id: string) => {
    setBusy(id)
    try {
      const result = await runJobNow(id)
      if (result && !result.ok && result.skipped) {
        /*
         * A condition said "not now". That is a decision, not a failure, and
         * it used to fall into the `else` below and render as "Send failed"
         * with an empty detail — because a skip carries `skipReasonKey`, not
         * `error`. The one thing the user needs is which condition stopped it.
         */
        toast.push({
          tone: 'info',
          title: t('toast.skipped'),
          detail: result.skipReasonKey
            ? t(result.skipReasonKey as TranslationKey, result.skipReasonValues)
            : undefined,
        })
      } else if (result?.ok) {
        // `toast.sent` carries no placeholders — the recipients and the
        // duration live in `toast.sentDetail`. Passing them to the title threw
        // both away, so a send started here reported less than the identical
        // send started from Compose.
        toast.push({
          tone: 'success',
          title: t('toast.sent'),
          detail: t('toast.sentDetail', { n: result.accepted.length, ms: result.durationMs }),
        })
      } else {
        toast.push({ tone: 'error', title: t('toast.sendFailed'), detail: result?.error })
      }
    } finally {
      setBusy(null)
    }
  }

  /**
   * "Postpone ten minutes", and the sentence it has to say first.
   *
   * Routed through `planRestagger` (`core/schedule/reschedule.ts`) rather than
   * nudging `occurrences[0]` here, and that is not tidiness — it is the only
   * honest implementation available. `ScheduledJob` has no per-occurrence
   * exception list, so there is nowhere to record "this one send moved and the
   * rest did not". The only thing that can be written back is the rule's own
   * time of day, which means a *repeating* reminder pushed ten minutes moves
   * every future send with it. `planRestagger` exists precisely to say that
   * out loud, and it refuses outright for the two cases it cannot honour: a
   * cron expression owns its own minute, and a shift across midnight is a
   * different operation on a different day.
   *
   * So the confirmation body is the plan's own sentence — `cal.stagger.later`
   * already reads "{n} min later, at {time}, from now on", and "from now on"
   * is the part that matters. Writing a second sentence here would be a second
   * place for that warning to drift out of date.
   *
   * `reasonValues` goes to `t` unwrapped, unlike `WorkCalendarView`'s
   * `translateValues(...)` call on the same shape: `planReschedule` can put
   * translation keys in there, `planRestagger` only ever puts a count and a
   * clock time.
   *
   * `pushUndo` then `scheduleDraft` is the same pair, in the same order, that
   * `moveJob` and the de-stagger use — the undo entry has to capture the job
   * *before* the save, or Ctrl+Z restores what it just wrote.
   */
  const snooze = async (job: ScheduledJob) => {
    const plan = planRestagger(job, SNOOZE_MS)
    if (!plan.recurrence) {
      toast.push({
        tone: 'error',
        title: t('cal.move.cannot'),
        detail: t(plan.reasonKey as TranslationKey, plan.reasonValues),
      })
      return
    }
    const ok = await confirm({
      title: t('ring.snooze10' as TranslationKey),
      body: t(plan.reasonKey as TranslationKey, plan.reasonValues),
      confirmLabel: t('ring.snooze10' as TranslationKey),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return
    pushUndo(job.name, [{ type: 'upsertJob', job }])
    await scheduleDraft({ ...job, recurrence: plan.recurrence })
    toast.push({
      tone: 'success',
      title: t('ring.snoozed' as TranslationKey, { n: SNOOZE_MS / 60_000 }),
      detail: job.name,
    })
  }

  /*
   * Read live out of `state.jobs`, never held. See `menuJobId`.
   *
   * A job can also leave the list while its menu is open — the send fires, or
   * another device's sync deletes it — and this resolving to `undefined` is
   * what closes the menu rather than leaving three buttons pointing at
   * nothing.
   */
  const menuJob = menuJobId ? state.jobs.find((j) => j.id === menuJobId) : undefined

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('schedule.title')}
          action={
            <Button variant="primary" icon={<IconClock size={16} />} onClick={onCompose}>
              {t('schedule.new')}
            </Button>
          }
        />

        {/*
          Pinned above the scroll area, like the other list screens' controls —
          a filter that scrolls away with the rows is a filter nobody finds
          once the list is long.

          Hidden entirely until something has finished, so a new install does
          not get a tab that leads to an empty room.
        */}
        {done.length > 0 ? (
          <div className="segmented" role="group" aria-label={t('schedule.title')}>
            {/* Either tab also clears the narrowing. A reader who reaches for
                "已完成" while looking at today's four rows is asking to see a
                different set, not today's completed four, and a tab that
                silently kept an invisible filter on would be the same trap the
                chip below exists to avoid. */}
            <button
              type="button"
              className="segmented__item"
              aria-pressed={!showDone && !focused}
              onClick={() => {
                setFocused(null)
                setShowDone(false)
              }}
            >
              {t('schedule.tabActive', { n: active.length })}
            </button>
            <button
              type="button"
              className="segmented__item"
              aria-pressed={showDone}
              onClick={() => {
                setFocused(null)
                setShowDone(true)
              }}
            >
              {t('schedule.tabDone', { n: done.length })}
            </button>
          </div>
        ) : null}

        {/*
          What the list is currently narrowed to, said out loud, as the control
          that undoes it.

          The wording is `home.todayQueued` — the very sentence on the figure
          that was tapped to get here — with the count taken from this screen's
          own filtered list rather than passed in. That is the correspondence
          made checkable instead of asserted: if the two predicates ever drift
          apart, Home says one number and this chip says another on the next
          screen, which somebody notices. A `--toggle` chip because it is a
          state that is on and can be turned off, drawn pressed, tapped to
          release — the same control the chain-stage picker and the inbox use,
          and already pinned to the 48px touch floor on a phone.
        */}
        {focused ? (
          /* Wrapped, because `.view__inner` is a flex *column* and stretches
             its children — a bare chip here would be a full-width bar. Same
             reason `.segmented` carries `align-self: start`; `.btn-row` is the
             wrapper the log screen's receipt chips already use for this. */
          <div className="btn-row">
            <button
              type="button"
              className="chip chip--toggle"
              aria-pressed="true"
              onClick={() => setFocused(null)}
            >
              {t('home.todayQueued', { n: todayJobs.length })}
            </button>
          </div>
        ) : null}

        <HealthAllClear />

        {jobs.length === 0 ? (
          <div className="list-pane">
            {/* "还没有定时提醒" is false when there are thirty and none of them
                is today, so a narrowed list says the neutral thing instead. The
                chip above is still on screen saying which narrowing, and is
                still the way out of it. */}
            <EmptyState
              icon={<IconClock size={24} />}
              title={focused ? t('common.empty') : t('schedule.empty')}
              action={
                <Button variant="secondary" onClick={onCompose}>
                  {t('nav.compose')}
                </Button>
              }
            />
          </div>
        ) : (
          <VirtualList
            items={jobs}
            keyOf={(job) => job.id}
            estimate={104}
            scrollerClassName="list-pane"
            rowsClassName="joblist"
          >
            {(job) => {
              const next = job.occurrences[0]
              /* The instant the ring counts to. A finished job has no
                 `occurrences[0]` left, so it counts to the send that ended it —
                 which is what makes the Done tab show closed ticks rather than
                 empty circles. */
              const ringAt = next ?? job.lastRunAt
              const summary = summarizeRecurrence(job.recurrence)
              const recipients =
                job.draft.to.length + job.draft.cc.length + job.draft.bcc.length
              return (
                <div
                  className="job"
                  data-disabled={!job.enabled}
                  data-failed={job.lastResult === 'failed'}
                  data-removing={removingIds.has(job.id) || undefined}
                >
                  <span className="job__pulse" />
                  {/*
                    How long is left, as one closed shape. Decoration on top of
                    the `schedule.nextRun` line below, never instead of it — the
                    ring is `aria-hidden` and the timestamp is what a screen
                    reader announces. See `CountdownRing.tsx` for why the arc's
                    denominator is capped at 24 hours (a three-week wait would
                    otherwise sit at 99.7% full for its last six days) and why
                    forty rows share a single ticker.

                    `armedAt` prefers `lastRunAt` over `createdAt`: a daily
                    reminder created three months ago is not three months into a
                    wait, it is however long it is since yesterday's send.

                    `.job__pulse` above is now saying a weaker version of the
                    same thing. It stays for this release rather than being
                    pulled in the same change that introduced its replacement —
                    the dot also encodes failed/disabled, and removing it is a
                    separate decision that should be made while looking at both.
                  */}
                  {ringAt && (job.enabled || isFinished(job)) ? (
                    <CountdownRing
                      fireAt={ringAt}
                      armedAt={job.lastRunAt ?? job.createdAt}
                      done={isFinished(job)}
                      /*
                        Actions only while the job is actually live. On the Done
                        tab two of the three ("send now", "postpone") have
                        nothing to act on, and handing that tab forty focus
                        stops leading to a menu that is two-thirds greyed out is
                        worse than leaving the tick the picture it is.
                      */
                      onOpenActions={
                        job.enabled && !isFinished(job)
                          ? () => setMenuJobId(job.id)
                          : undefined
                      }
                    />
                  ) : null}
                  <div className="job__body">
                    <div className="job__name">
                      {job.name}
                      {/* One visual language for state, everywhere. Before this
                          the schedule screen said "paused" in grey italics, the
                          inbox used a chip and the log used a coloured dot —
                          three dialects for one idea, so none of them could be
                          learned. See `StatusChip`. */}
                      {/*
                        Reads `job.status` now, not `occurrences.length`.

                        The length was a stand-in for a status field that never
                        updated, and it was wrong in both directions: a
                        repeating job whose buffer had run dry showed "done"
                        while it was still live, and a one-off that had already
                        sent showed "waiting" because the renderer had never
                        been told otherwise.
                      */}
                      <StatusChip
                        tone={
                          job.status === 'failed'
                            ? 'danger'
                            : !job.enabled || isFinished(job)
                              ? 'neutral'
                              : 'accent'
                        }
                        dot={job.enabled && !isFinished(job) && job.status !== 'failed'}
                        label={
                          job.status === 'failed'
                            ? t('status.failed')
                            : !job.enabled
                              ? t('status.paused')
                              : isFinished(job)
                                ? t('status.done')
                                : t('status.armed')
                        }
                        title={job.lastError}
                      />
                      {job.conditions && job.conditions.length > 0 ? (
                        <StatusChip
                          tone="info"
                          label={t('status.conditional', { n: job.conditions.length })}
                        />
                      ) : null}
                      {job.chainId ? (
                        <StatusChip
                          tone="neutral"
                          label={t('chain.partOf', {
                            n: state.jobs.filter((j) => j.chainId === job.chainId).length,
                          })}
                        />
                      ) : null}
                    </div>
                    <div className="job__meta">
                      <span>{t(summary.key as 'recur.summary.once', summary.values)}</span>
                      {job.enabled && next ? (
                        <span>
                          <strong>{t('schedule.nextRun')}:</strong> {formatDateTime(next)} (
                          {formatRelative(next)})
                        </span>
                      ) : (
                        <span>{job.enabled ? t('schedule.noMoreRuns') : t('common.disabled')}</span>
                      )}
                      <span>{t('logs.recipients', { n: recipients })}</span>
                      {/*
                        What happened last time, not just how many times.

                        `formatAgo`, never `formatRelative` — the latter is for
                        future instants and answers "overdue" for every past
                        one, which is how the update card ended up telling
                        people a check that had just succeeded was late.
                      */}
                      {job.runCount > 0 ? (
                        <span>
                          <strong>{t('schedule.lastRun')}:</strong>{' '}
                          {job.lastRunAt ? formatAgo(job.lastRunAt) : '—'}
                          {job.lastResult ? (
                            <>
                              {' · '}
                              <span
                                style={{
                                  color:
                                    job.lastResult === 'ok' ? 'var(--success)' : 'var(--danger)',
                                }}
                              >
                                {job.lastResult === 'ok'
                                  ? t('status.sentOk')
                                  : t('status.failed')}
                              </span>
                            </>
                          ) : null}
                          {' · '}
                          {t('schedule.runs', { n: job.runCount })}
                        </span>
                      ) : null}
                      {job.draft.attachments.length > 0 ? (
                        <span>
                          {t('compose.attachments')}: {job.draft.attachments.length}
                        </span>
                      ) : null}
                    </div>
                    {job.lastResult === 'failed' && job.lastError ? (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 'var(--text-xs)',
                          color: 'var(--danger)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {job.lastError}
                      </div>
                    ) : null}
                  </div>

                  <div className="job__actions">
                    <IconButton label={t('common.edit')} onClick={() => edit(job)}>
                      <IconEdit size={16} />
                    </IconButton>
                    <IconButton label={t('schedule.sendAnother')} onClick={() => repeat(job)}>
                      <IconCopy size={16} />
                    </IconButton>
                    <IconButton
                      label={t('schedule.runNow')}
                      onClick={() => runNow(job.id)}
                      disabled={busy === job.id}
                    >
                      <IconSend size={16} />
                    </IconButton>
                    <IconButton
                      label={job.enabled ? t('schedule.pause') : t('schedule.resume')}
                      onClick={() => {
                        void toggleJob(job.id, !job.enabled)
                        toast.push({
                          tone: 'info',
                          title: job.enabled ? t('toast.jobPaused') : t('toast.jobResumed'),
                        })
                      }}
                    >
                      {job.enabled ? <IconPause size={16} /> : <IconPlay size={16} />}
                    </IconButton>
                  </div>

                  {/*
                    Delete, in the row's top-right corner — 所有提醒内容的右上角
                    要有删除键.

                    Moved out of `.job__actions` above rather than added
                    alongside it. It was the fifth of five icons there, which on
                    a desktop put it at the row's vertical centre and on a phone
                    put it on a wrapped second line at the *bottom* right — the
                    two places the report says it should not be. Leaving a copy
                    behind would have meant two delete buttons on one row.

                    `.rowdel` is shared with the activity log and the mail list
                    so the corner means the same thing on all three; see the
                    corner-delete block in `06-lists.css`. It still goes through
                    the same `remove()` as before, which is what keeps the
                    typed-confirmation dialog on the path — this moved a button,
                    it did not make deleting easier.
                  */}
                  <IconButton
                    className="rowdel"
                    label={t('common.delete')}
                    onClick={() => remove(job.id)}
                    disabled={removingIds.has(job.id)}
                  >
                    <IconTrash size={16} />
                  </IconButton>
                </div>
              )
            }}
          </VirtualList>
        )}
      </div>

      {/*
        The ring's three actions.

        ## Why this is here and not in the row

        It cannot be in the row. `VirtualList` renders its rows inside
        `.list-pane`, which is `overflow-y: auto` — and an element with one
        overflow axis not `visible` clips on *both*, so a popover anchored
        inside a row is cut off at the pane's edge. `position: fixed` does not
        rescue it either: `VirtualList` puts `transform: translateY(...)` on the
        row container to position the window, and a transformed ancestor
        becomes the containing block for fixed descendants, so a fixed popover
        would be positioned inside — and clipped by — the very scroller it was
        trying to escape.

        This spot is outside all of it, sitting exactly where `{confirmElement}`
        already sits for exactly the same reason. That is also why no portal was
        added: `RecipientPicker` has one, and it needed it because it is opened
        *from inside* a component that has no view root to reach; this screen
        has one right here.

        ## Why a `Modal` and not a bespoke menu

        A menu would have needed positioning off a rect, outside-click, Escape,
        focus handling, `role="menu"` and arrow keys — every one of which
        `Modal` already has and has already had reviewed. It also brings the
        scrim's `fade-in var(--dur)`, which theme.css's global
        `prefers-reduced-motion` block already cuts to 0.01ms, so the open/close
        animation is handled by not being written twice.

        The narrow shell renders dialogs as full screens (`10-narrow-shell.css`),
        which is the phone shape this wants anyway.
      */}
      {menuJob ? (
        <Modal
          open
          title={menuJob.name}
          onClose={() => setMenuJobId(null)}
          closeLabel={t('common.close')}
        >
          <div className="btn-row">
            {/* The same three calls the row's own icon buttons make — `runNow`
                and `remove` are reused verbatim, not re-implemented, so a fix
                to either (the skip-reason toast, the chain-aware delete
                confirmation) reaches both entry points. `snooze` is the only
                new one, and it is a front door onto `planRestagger`. */}
            <Button
              block
              icon={<IconSend size={16} />}
              disabled={busy === menuJob.id}
              onClick={() => {
                setMenuJobId(null)
                void runNow(menuJob.id)
              }}
            >
              {t('schedule.runNow')}
            </Button>
            <Button
              block
              icon={<IconClock size={16} />}
              onClick={() => {
                setMenuJobId(null)
                void snooze(menuJob)
              }}
            >
              {t('ring.snooze10' as TranslationKey)}
            </Button>
            <Button
              block
              variant="danger"
              icon={<IconTrash size={16} />}
              disabled={removingIds.has(menuJob.id)}
              onClick={() => {
                setMenuJobId(null)
                void remove(menuJob.id)
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </Modal>
      ) : null}

      {confirmElement}
    </div>
  )
}
