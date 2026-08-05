import { useMemo, useState } from 'react'
import { HealthAllClear } from '../components/HealthBoard'
import { VirtualList } from '../components/VirtualList'
import {
  Button,
  EmptyState,
  IconButton,
  PageHead,
  StatusChip,
  useConfirm,
  useToast,
} from '../components/ui'
import { IconClock, IconCopy, IconPause, IconPlay, IconSend, IconTrash } from '../components/icons'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { summarizeRecurrence } from '../core/schedule'
import { isFinished } from '../core/jobRun'
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

/** Soonest first; a reminder with nothing left to fire sorts to the bottom. */
function byNextRun(a: ScheduledJob, b: ScheduledJob) {
  const an = a.occurrences[0] ?? Number.MAX_SAFE_INTEGER
  const bn = b.occurrences[0] ?? Number.MAX_SAFE_INTEGER
  return an - bn
}

export function ScheduleView({ onCompose }: { onCompose: () => void }) {
  const { state, dispatch, toggleJob, deleteJob, runJobNow } = useApp()
  const { t, formatDateTime, formatRelative, formatAgo } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
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
  const jobs = showDone ? done : active

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

  const runNow = async (id: string) => {
    setBusy(id)
    try {
      const result = await runJobNow(id)
      if (result?.ok) {
        toast.push({
          tone: 'success',
          title: t('toast.sent', { n: result.accepted.length, ms: result.durationMs }),
        })
      } else {
        toast.push({ tone: 'error', title: t('toast.sendFailed'), detail: result?.error })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('schedule.title')}
          subtitle={t('schedule.subtitle')}
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
            <button
              type="button"
              className="segmented__item"
              aria-pressed={!showDone}
              onClick={() => setShowDone(false)}
            >
              {t('schedule.tabActive', { n: active.length })}
            </button>
            <button
              type="button"
              className="segmented__item"
              aria-pressed={showDone}
              onClick={() => setShowDone(true)}
            >
              {t('schedule.tabDone', { n: done.length })}
            </button>
          </div>
        ) : null}

        <HealthAllClear />

        {jobs.length === 0 ? (
          <div className="list-pane">
            <EmptyState
              icon={<IconClock size={24} />}
              title={t('schedule.empty')}
              hint={t('schedule.emptyHint')}
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
                    <IconButton
                      label={t('common.delete')}
                      onClick={() => remove(job.id)}
                      disabled={removingIds.has(job.id)}
                    >
                      <IconTrash size={16} />
                    </IconButton>
                  </div>
                </div>
              )
            }}
          </VirtualList>
        )}
      </div>
      {confirmElement}
    </div>
  )
}
