import { useDeferredValue, useMemo, useState } from 'react'
import {
  Button,
  EmptyState,
  IconButton,
  PageHead,
  Segmented,
  StatusChip,
  useConfirm,
  useToast,
} from '../components/ui'
import { SearchInput } from '../components/inputs'
import { VirtualList } from '../components/VirtualList'
import { IconActivity, IconDownload, IconTrash } from '../components/icons'
import { sendsFromLogs, summariseReceipts, trackReceipts } from '../core/mail/receipts'
import { saveGeneratedFile } from '../core/platform/download'
import { pruneLogs } from '../core/ops/logRetention'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import type { LogEntry } from '../core/types'

type Filter = 'all' | 'send' | 'error' | 'security'

/**
 * A narrowing this screen can be *opened* with, rather than one the reader has
 * to reproduce by hand once they get here.
 *
 * Two values, and they are Home's second and third figures. Neither is
 * expressible as one of the four `Filter` options above, which is why this is a
 * separate axis rather than two more segments:
 *
 *   sentToday    `kind === 'send'` *minus the failures* — `filterSend` counts a
 *                send that bounced off the server as a send, and 今天已发 does
 *                not, so pressing "发送" would show a longer list than the
 *                figure that opened it.
 *   failedToday  `level === 'error'`, which is exactly `filterError` — the only
 *                thing missing from the existing option is the day.
 *
 * A fifth segment would have said "成功发送" beside "发送" in a strip that
 * already scrolls sideways on a phone, for a distinction nobody arriving from
 * anywhere else needs.
 */
export type LogsFocus = 'sentToday' | 'failedToday'

const DAY_MS = 86_400_000

/**
 * Whether `at` falls on the calendar day `now` is in — compared as local
 * midnights, so 23:30 → 00:30 is a different day rather than "half an hour, so
 * the same one".
 *
 * A local copy of the rule `HomeView`'s `daysAhead` applies, for the reason set
 * out on `ScheduleView`'s identical copy: Home reaches this screen through
 * `lazy(() => import('./LogsView'))`, and a static import back the other way
 * would pull the whole home screen into the chunk `App.tsx` loads for the
 * activity tab.
 */
function isToday(at: number, now: number): boolean {
  const a = new Date(at)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((a.getTime() - b.getTime()) / DAY_MS) === 0
}

/**
 * One row of CSV.
 *
 * Quoting is not optional here: a log title is arbitrary user text and will
 * contain commas, quotes and newlines. Doubling the quote and wrapping every
 * field is the whole of RFC 4180's escaping, and getting it wrong produces a
 * file that opens without complaint and is silently misaligned.
 */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '""'
  return `"${String(value).replace(/"/g, '""')}"`
}

function toCsv(entries: LogEntry[], receiptOf: (id: string) => string): string {
  const header = ['at', 'kind', 'level', 'title', 'detail', 'recipients', 'durationMs', 'delivery']
  const rows = entries.map((e) =>
    [
      new Date(e.at).toISOString(),
      e.kind,
      e.level,
      e.title,
      e.detail ?? '',
      e.recipients ?? '',
      e.durationMs ?? '',
      receiptOf(e.id),
    ]
      .map(csvCell)
      .join(','),
  )
  // A BOM so Excel opens UTF-8 correctly instead of mangling every non-ASCII
  // subject — the single most common complaint about exported CSV on Windows.
  return `﻿${header.map(csvCell).join(',')}\n${rows.join('\n')}\n`
}

/** Replace the middle of an address so a log screenshot leaks less. */
function redact(text: string): string {
  return text.replace(
    /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)/g,
    (_m, first: string, domain: string) => `${first}•••${domain}`,
  )
}

export function LogsView({
  focus,
}: {
  /**
   * Optional, and every existing caller omits it — `App.tsx`'s own tab opens
   * this screen at its full list, as it always has. Only Home's 今天已发 and
   * 今天失败 figures pass anything.
   */
  focus?: LogsFocus
}) {
  const { state, dispatch, pushUndo } = useApp()
  const { t, formatDateTime } = useI18n()
  const { confirm, confirmElement } = useConfirm()
  const toast = useToast()
  /**
   * The narrowing this screen was opened with, held as state so it can be let
   * go of — see the same pair in `ScheduleView`. Seeded once; this screen is
   * mounted fresh each time Home's dialog opens.
   */
  const [focused, setFocused] = useState<LogsFocus | null>(focus ?? null)
  /* The segmented strip still has to show *something* pressed while a focus is
     on, or the reader is looking at a filtered list with every option unlit.
     Seeded to the closest of the four, which is the one the focus is a
     narrowing of. */
  const [filter, setFilter] = useState<Filter>(
    focus === 'failedToday' ? 'error' : focus === 'sentToday' ? 'send' : 'all',
  )
  const [query, setQuery] = useState('')

  /**
   * What happened after the server said yes.
   *
   * Correlated against the cached inbox: a bounce is a separate message that
   * arrives later, and nothing links it back to the send except the id and the
   * subject. See `core/receipts` — in particular, why the absence of a bounce
   * is never reported as "delivered".
   */
  const receipts = useMemo(() => {
    const inbox = state.inboxAccounts.flatMap((i) => i.messages)
    if (inbox.length === 0) return new Map()
    return trackReceipts(sendsFromLogs(state.logs), inbox)
  }, [state.logs, state.inboxAccounts])

  const receiptStats = useMemo(() => summariseReceipts(receipts), [receipts])

  const deferredQuery = useDeferredValue(query)

  /**
   * Everything the focus — or, with no focus, the segmented filter — admits,
   * before the search box narrows it any further.
   *
   * Split out from `entries` below so the chip can print a count that means
   * what Home's figure meant. Counting `entries` instead would have made the
   * chip say "今天已发 2 封" the moment somebody typed two characters into the
   * search box, under a home screen that had just said eight.
   *
   * The two focus predicates are the same expressions `HomeView`'s `todaySent`
   * and `todayFailed` are computed from; see the note on `LogsFocus` for why
   * neither is one of the four options.
   *
   * `pruneLogs`, not a second cutoff computed here.
   *
   * The inline version this replaces was `Date.now() - logRetentionDays *
   * 86400000` with none of the fallbacks `pruneLogs` documents at length.
   * Clear the "Keep activity log for" box in Settings and the browser reports
   * `''` mid-edit, `Number('')` is 0, the cutoff becomes `Date.now()` and every
   * comparison fails: this screen renders "Nothing has happened yet" while the
   * entire log is still sitting in state.json. Nothing throws and nothing warns
   * — the log simply appears to have been erased.
   */
  const scoped = useMemo(() => {
    const now = Date.now()
    return pruneLogs(state.logs, state.settings).filter((l) => {
      if (focused === 'sentToday') {
        return l.kind === 'send' && l.level !== 'error' && isToday(l.at, now)
      }
      if (focused === 'failedToday') return l.level === 'error' && isToday(l.at, now)
      if (filter === 'all') return true
      if (filter === 'error') return l.level === 'error'
      if (filter === 'security') return l.kind === 'security'
      return l.kind === 'send'
    })
  }, [state.logs, state.settings.logRetentionDays, filter, focused])

  const entries = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    if (needle.length === 0) return scoped
    return scoped.filter(
      (l) =>
        l.title.toLowerCase().includes(needle) ||
        (l.detail ?? '').toLowerCase().includes(needle),
    )
  }, [scoped, deferredQuery])

  /**
   * Export what is on screen, not everything.
   *
   * Exporting the unfiltered log from a screen showing a filtered one is the
   * kind of surprise that gets noticed only after the file has been sent to
   * someone else.
   */
  const exportCsv = async () => {
    const csv = toCsv(entries, (id) => receipts.get(id)?.status ?? '')
    const name = `aevistle-activity-${new Date().toISOString().slice(0, 10)}.csv`
    // Same fix as the backup card and the calendar: report what happened, not
    // what was attempted. This one also revoked the object URL on the very
    // next line, which is documented in `core/download.ts` as a way to cancel
    // the download you just started.
    const { outcome, unsupported } = await saveGeneratedFile(csv, name, 'text/csv')
    if (unsupported) {
      toast.push({ tone: 'error', title: t('download.androidUnsupported') })
      return
    }
    if (!outcome || outcome.ok) {
      toast.push({ tone: 'success', title: t('logs.exported', { n: entries.length }) })
      return
    }
    toast.push(
      outcome.cancelled
        ? { tone: 'info', title: t('download.cancelled') }
        : { tone: 'error', title: t('download.failed'), detail: outcome.name },
    )
  }

  const clear = async () => {
    const ok = await confirm({
      title: t('logs.clearConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    // The whole log, so "clear" is as reversible as a single delete. It is
    // capped at 500 entries, which is a few hundred kilobytes at worst.
    const previous = state.logs
    pushUndo(t('logs.title'), previous.map((entry) => ({ type: 'log' as const, entry })).reverse())
    dispatch({ type: 'clearLogs' })
  }

  /**
   * One row off the log — the corner delete on each entry.
   *
   * No confirmation dialog, deliberately, where `clear` above has one. The
   * asymmetry is the point: clearing the log destroys every record at once and
   * is worth interrupting for, while a single row is the routine act, and a
   * dialog on the routine act is what trains the reflex that clicks through the
   * one that mattered — the argument `useConfirm`'s
   * `requireTypedConfirmation` doc makes about exactly this list.
   *
   * `pushUndo` instead, which is the same safety net `clear` uses and a better
   * one for a single row: it restores the entry rather than asking the user to
   * predict whether they wanted it. The undo entry replays the `log` action that
   * created it, so the row comes back with its original id, level and timestamp.
   */
  const removeEntry = (entry: LogEntry) => {
    pushUndo(t('logs.title'), [{ type: 'log' as const, entry }])
    dispatch({ type: 'removeLog', id: entry.id })
  }

  const show = (text: string) => (state.settings.redactLogs ? redact(text) : text)

  /**
   * Delivery health at a glance.
   *
   * Median rather than mean: one 30-second timeout in an otherwise healthy
   * week would drag an average far enough to look like a systemic problem.
   */
  const stats = useMemo(() => {
    const sends = state.logs.filter((l) => l.kind === 'send')
    if (sends.length === 0) return null

    const failed = sends.filter((l) => l.level === 'error').length
    const delivered = sends.length - failed
    const durations = sends
      .map((l) => l.durationMs)
      .filter((d): d is number => typeof d === 'number' && d > 0)
      .sort((a, b) => a - b)

    return {
      delivered,
      failed,
      total: sends.length,
      rate: Math.round((delivered / sends.length) * 100),
      median: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
    }
  }, [state.logs])

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('logs.title')}
          hideTitle
          action={
            state.logs.length > 0 ? (
              <div className="btn-row">
                <Button variant="secondary" icon={<IconDownload size={15} />} onClick={() => void exportCsv()}>
                  {t('logs.export')}
                </Button>
                <Button variant="ghost" icon={<IconTrash size={15} />} onClick={clear}>
                  {t('logs.clear')}
                </Button>
              </div>
            ) : undefined
          }
        />

        {stats ? (
          <div className="stats">
            <div className="stat stat--good">
              <div className="stat__value">{stats.delivered}</div>
              <div className="stat__label">{t('logs.statSent')}</div>
            </div>
            <div className={`stat ${stats.failed > 0 ? 'stat--bad' : ''}`}>
              <div className="stat__value">{stats.failed}</div>
              <div className="stat__label">{t('logs.statFailed')}</div>
            </div>
            <div className="stat">
              <div className="stat__value">{stats.rate}%</div>
              <div className="stat__label">{t('logs.statRate')}</div>
            </div>
            <div className="stat">
              <div className="stat__value">
                {stats.median !== null ? `${stats.median}` : '—'}
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}> ms</span>
              </div>
              <div className="stat__label">{t('logs.statLatency')}</div>
            </div>
          </div>
        ) : null}

        {/* Delivery outcomes, only once there is something to correlate
            against. "0 bounced" with an empty inbox cache would be a claim the
            application cannot actually make. */}
        {receiptStats.bounced > 0 || receiptStats.read > 0 ? (
          <div className="btn-row" style={{ marginBottom: 'var(--sp-3)' }}>
            {receiptStats.bounced > 0 ? (
              <StatusChip
                tone="danger"
                label={t('receipt.bouncedN', { n: receiptStats.bounced })}
                title={t('receipt.bouncedHint')}
              />
            ) : null}
            {receiptStats.read > 0 ? (
              <StatusChip
                tone="success"
                label={t('receipt.readN', { n: receiptStats.read })}
                title={t('receipt.readHint')}
              />
            ) : null}
          </div>
        ) : null}

        {/*
          What the list is currently narrowed to, said out loud, as the control
          that undoes it.

          The wording is `home.todaySent` / `home.todayFailed` — the very
          sentence on the figure that was tapped to get here — with the count
          taken from this screen's own filtered list rather than passed in. That
          is the correspondence made checkable instead of asserted: if the
          predicates here and in `HomeView` ever drift apart, Home says one
          number and this chip says another on the next screen, which somebody
          notices. See the same chip in `ScheduleView`.
        */}
        {focused ? (
          /* Wrapped in `.btn-row` for the reason the receipt chips above are:
             `.view__inner` is a flex column and stretches its children, so a
             bare chip would be a full-width bar. */
          <div className="btn-row">
            <button
              type="button"
              className="chip chip--toggle"
              aria-pressed="true"
              onClick={() => setFocused(null)}
            >
              {t(focused === 'sentToday' ? 'home.todaySent' : 'home.todayFailed', {
                n: scoped.length,
              })}
            </button>
          </div>
        ) : null}

        <div className="listcontrols">
          {/* Touching any of the four is also how the day narrowing is let go
              of — it is a request to see a different set, and the segment that
              was pressed is the one the focus was a narrowing of, so "press the
              option that is already lit" widens rather than doing nothing. */}
          <Segmented
            value={filter}
            onChange={(value) => {
              setFocused(null)
              setFilter(value)
            }}
            ariaLabel={t('logs.title')}
            options={[
              { value: 'all', label: t('logs.filterAll') },
              { value: 'send', label: t('logs.filterSend') },
              { value: 'error', label: t('logs.filterError') },
              { value: 'security', label: t('logs.filterSecurity') },
            ]}
          />
          <SearchInput value={query} onChange={setQuery} placeholder={t('logs.search')} />
        </div>

        {/* The stat row and the filter above stay put; only the entries move.
            A year of use is a few thousand entries, so the rows are windowed —
            see VirtualList for the measurements that made that necessary. */}
        {entries.length === 0 ? (
          <div className="list-pane">
            {/* "还没有发生任何事" is false when a hundred things happened and
                none of them was today, so a narrowed list says the neutral
                thing instead. The chip above is still on screen saying which
                narrowing, and is still the way out of it. */}
            <EmptyState
              icon={<IconActivity size={24} />}
              title={focused ? t('common.empty') : t('logs.empty')}
            />
          </div>
        ) : (
          <VirtualList
            items={entries}
            keyOf={(entry) => entry.id}
            estimate={76}
            scrollerClassName="list-pane"
            surfaceClassName="card card--flush"
          >
            {(entry) => {
              const receipt = receipts.get(entry.id)
              // `log--deletable` opts this row into the corner-delete gutter.
              // `.log` is the app's general row shape — ten places render it,
              // and only this one has anything to delete — so the reservation is
              // per-row rather than on the class. See `09-misc.css`.
              return (
              <div className="log log--deletable" data-level={entry.level}>
                <span className="log__dot" />
                <div className="log__body">
                  <div className="log__title">
                    {show(entry.title)}
                    {receipt && receipt.status !== 'sent' ? (
                      <StatusChip
                        tone={receipt.status === 'bounced' ? 'danger' : 'success'}
                        label={
                          receipt.status === 'bounced' ? t('receipt.bounced') : t('receipt.read')
                        }
                        title={receipt.detail}
                      />
                    ) : null}
                  </div>
                  {entry.detail ? <div className="log__detail">{show(entry.detail)}</div> : null}
                  {entry.recipients !== undefined || entry.durationMs !== undefined ? (
                    <div className="log__detail">
                      {entry.recipients !== undefined
                        ? t('logs.recipients', { n: entry.recipients })
                        : ''}
                      {entry.durationMs !== undefined
                        ? ` · ${t('logs.duration', { ms: entry.durationMs })}`
                        : ''}
                    </div>
                  ) : null}
                </div>
                <div className="log__time">{formatDateTime(entry.at, { timeStyle: 'short' })}</div>

                {/*
                  Delete, in the row's top-right corner — the same `.rowdel` the
                  reminder rows and the mail list use, so the corner means one
                  thing across all three (see `06-lists.css`).

                  This screen had no per-row delete at all before: the only way
                  to remove anything was 清空, which destroys the evidence for
                  every *other* send in order to tidy away one line you had
                  already dealt with.
                */}
                <IconButton
                  className="rowdel"
                  label={t('common.delete')}
                  onClick={() => removeEntry(entry)}
                >
                  <IconTrash size={16} />
                </IconButton>
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
