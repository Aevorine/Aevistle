import { useDeferredValue, useMemo, useState } from 'react'
import {
  Button,
  EmptyState,
  PageHead,
  Segmented,
  StatusChip,
  useConfirm,
  useToast,
} from '../components/ui'
import { SearchInput } from '../components/inputs'
import { VirtualList } from '../components/VirtualList'
import { IconActivity, IconDownload, IconTrash } from '../components/icons'
import { sendsFromLogs, summariseReceipts, trackReceipts } from '../core/receipts'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import type { LogEntry } from '../core/types'

type Filter = 'all' | 'send' | 'error' | 'security'

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

export function LogsView() {
  const { state, dispatch, pushUndo } = useApp()
  const { t, formatDateTime } = useI18n()
  const { confirm, confirmElement } = useConfirm()
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('all')
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
  const entries = useMemo(() => {
    const cutoff = Date.now() - state.settings.logRetentionDays * 86_400_000
    const needle = deferredQuery.trim().toLowerCase()
    return state.logs
      .filter((l) => l.at >= cutoff)
      .filter((l) => {
        if (filter === 'all') return true
        if (filter === 'error') return l.level === 'error'
        if (filter === 'security') return l.kind === 'security'
        return l.kind === 'send'
      })
      .filter(
        (l) =>
          needle.length === 0 ||
          l.title.toLowerCase().includes(needle) ||
          (l.detail ?? '').toLowerCase().includes(needle),
      )
  }, [state.logs, state.settings.logRetentionDays, filter, deferredQuery])

  /**
   * Export what is on screen, not everything.
   *
   * Exporting the unfiltered log from a screen showing a filtered one is the
   * kind of surprise that gets noticed only after the file has been sent to
   * someone else.
   */
  const exportCsv = () => {
    const csv = toCsv(entries, (id) => receipts.get(id)?.status ?? '')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `aevistle-activity-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.push({ tone: 'success', title: t('logs.exported', { n: entries.length }) })
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
          subtitle={t('logs.subtitle')}
          action={
            state.logs.length > 0 ? (
              <div className="btn-row">
                <Button variant="secondary" icon={<IconDownload size={15} />} onClick={exportCsv}>
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

        <div className="listcontrols">
          <Segmented
            value={filter}
            onChange={setFilter}
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
            <EmptyState
              icon={<IconActivity size={24} />}
              title={t('logs.empty')}
              hint={t('logs.emptyHint')}
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
              return (
              <div className="log" data-level={entry.level}>
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
