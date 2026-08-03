/**
 * Verification codes and sign-in links, as a screen of their own.
 *
 * It started as a card wedged above the inbox list, which was the wrong shape
 * for what people do with it: you come to this app *for* the code, glance at
 * six digits, copy them, and leave. That is a destination, not an accessory to
 * a mailbox — so it gets a nav entry, the full width of the window, and type
 * large enough to read across a desk.
 *
 * The whole card is the copy button. There is exactly one thing anyone wants
 * to do here, and making it the biggest possible target beats a neat little
 * icon on the right that has to be aimed at.
 */

import { useDeferredValue, useMemo, useState } from 'react'
import { Button, EmptyState, PageHead, Segmented, useConfirm, useToast } from '../components/ui'
import { SearchInput } from '../components/inputs'
import { IconCheck, IconCopy, IconExternal, IconKey, IconLink, IconTrash } from '../components/icons'
import { VirtualList } from '../components/VirtualList'
import { useApp } from '../state/AppState'
import { useI18n } from '../i18n'
import { CODE_FRESH_MS } from '../core/codeHistory'
import { accountLabel as labelOfAccount } from '../core/accounts'
import type { CodeHit } from '../core/types'

type Filter = 'all' | 'code' | 'link'

/**
 * `482913` → `482 913`.
 *
 * Only for the six-digit case, and only in the display copy: what goes on the
 * clipboard is always the unbroken value, because a space pasted into a
 * verification field is a rejected code. Grouping three and three is how these
 * are read aloud, and it is the difference between checking a code at a glance
 * and counting digits with a finger.
 */
function grouped(value: string): string {
  return value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value
}

/** "Wei Chen <wei@example.com>" → { name, address }; a bare address stays bare. */
function splitFrom(from: string): { name: string; address: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from)
  if (!match) return { name: '', address: from.trim() }
  return { name: match[1].replace(/^["']|["']$/g, ''), address: match[2].trim() }
}

export function CodesView({ onGoToInbox }: { onGoToInbox?: () => void }) {
  const { state, bridge, dispatch } = useApp()
  const { t, formatAgo, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  /** id → when it was copied in *this* session, for the transient "Copied ✓". */
  const [justCopied, setJustCopied] = useState<string | null>(null)

  const deferredQuery = useDeferredValue(query)

  const accountName = useMemo(() => {
    const byId = new Map(state.accounts.map((a) => [a.id, a]))
    return (id: string) => {
      const account = byId.get(id)
      return account ? labelOfAccount(account) : id
    }
  }, [state.accounts])

  const matching = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    return state.codeHits.filter((h) => {
      if (filter !== 'all' && h.kind !== filter) return false
      if (!q) return true
      return (
        h.value.toLowerCase().includes(q) ||
        h.from.toLowerCase().includes(q) ||
        h.subject.toLowerCase().includes(q)
      )
    })
  }, [state.codeHits, deferredQuery, filter])

  /**
   * Everything, newest first. Nothing is hidden.
   *
   * The first version folded anything older than ten minutes behind a "show N
   * earlier" link, on the theory that an expired code is noise. In practice
   * that link was where codes went to be lost: the list looked empty or
   * near-empty, and the one you wanted was behind a control you had no reason
   * to press. Freshness is now a *mark on the card*, not a reason to withhold
   * it — the newest is already at the top, which was the only thing the fold
   * was really buying.
   */
  const cutoff = Date.now() - CODE_FRESH_MS
  const fresh = matching.filter((h) => h.date >= cutoff)
  const visible = matching
  const unread = state.codeHits.filter((h) => !h.readAt).length

  /**
   * One click does both jobs: the value lands on the clipboard, and the card
   * stops being one of the things still waiting for attention.
   *
   * The read mark is set *before* the clipboard call and outside the `try`. A
   * code that was read off the screen and typed by hand has still been dealt
   * with, and a card that stayed marked unread because a clipboard permission
   * failed would be a card the user has to dismiss twice.
   */
  const copy = async (hit: CodeHit) => {
    dispatch({ type: 'markCodeRead', id: hit.id })
    try {
      await navigator.clipboard.writeText(hit.value)
      dispatch({ type: 'markCodeCopied', id: hit.id })
      setJustCopied(hit.id)
      window.setTimeout(() => setJustCopied((id) => (id === hit.id ? null : id)), 2000)
    } catch {
      toast.push({ tone: 'error', title: t('inbox.copyFailed') })
    }
  }

  const openLink = async (hit: CodeHit) => {
    /* Opening the link is the whole point of a link card — that counts as
       having dealt with it just as much as copying does. */
    dispatch({ type: 'markCodeRead', id: hit.id })
    let host = hit.value
    try {
      host = new URL(hit.value).host
    } catch {
      /* keep the raw string if it does not parse */
    }
    const ok = await confirm({
      title: t('confirm.openLinkTitle'),
      body: t('confirm.openLinkBody', { host }),
      confirmLabel: t('confirm.openLinkConfirm'),
      cancelLabel: t('common.cancel'),
    })
    if (ok) void bridge?.openExternal(hit.value)
  }

  const clearAll = async () => {
    const ok = await confirm({
      title: t('codes.clearConfirm', { n: state.codeHits.length }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (ok) dispatch({ type: 'clearCodeHits' })
  }

  const hasAnyInbox = state.inboxAccounts.some((i) => i.enabled)

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('codes.title')}
          subtitle={
            /* Unread outranks fresh: "still to deal with" is the question this
               screen exists to answer, and an unread code from an hour ago
               matters more than a read one from a minute ago. */
            unread > 0
              ? t('codes.subtitleUnread', { n: unread })
              : fresh.length > 0
                ? t('codes.subtitleFresh', { n: fresh.length })
                : t('codes.subtitle')
          }
          action={
            state.codeHits.length > 0 ? (
              <>
                {unread > 0 ? (
                  <Button
                    variant="secondary"
                    icon={<IconCheck size={15} />}
                    onClick={() => dispatch({ type: 'markAllCodesRead' })}
                  >
                    {t('codes.markAllRead')}
                  </Button>
                ) : null}
                <Button variant="ghost" icon={<IconTrash size={15} />} onClick={clearAll}>
                  {t('codes.clear')}
                </Button>
              </>
            ) : undefined
          }
        />

        {state.codeHits.length > 0 ? (
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              ariaLabel={t('codes.title')}
              options={[
                { value: 'all', label: t('codes.filterAll') },
                { value: 'code', label: t('codes.filterCodes') },
                { value: 'link', label: t('codes.filterLinks') },
              ]}
            />
            <SearchInput value={query} onChange={setQuery} placeholder={t('codes.searchPlaceholder')} />
          </>
        ) : null}

        {visible.length === 0 ? (
          <div className="list-pane">
            <EmptyState
              icon={<IconKey size={24} />}
              title={state.codeHits.length === 0 ? t('codes.empty') : t('common.empty')}
              hint={
                state.codeHits.length > 0
                  ? t('common.noMatchHint')
                  : hasAnyInbox
                    ? t('codes.emptyHint')
                    : t('codes.emptyNoInboxHint')
              }
              action={
                !hasAnyInbox && onGoToInbox ? (
                  <Button variant="primary" onClick={onGoToInbox}>
                    {t('nav.inbox')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <VirtualList
            items={visible}
            keyOf={(hit) => hit.id}
            estimate={128}
            scrollerClassName="list-pane"
            rowsClassName="codelist"
          >
            {(hit) => {
              const { name, address } = splitFrom(hit.from)
              const copied = justCopied === hit.id
              return (
                <div
                  className="codecard"
                  data-kind={hit.kind}
                  data-copied={copied || undefined}
                  data-used={hit.copiedAt && !copied ? 'true' : undefined}
                  // Read cards recede; unread ones keep full contrast and a dot.
                  // Nothing is hidden or reordered — the same reason the old
                  // "show N earlier" fold was removed.
                  data-read={hit.readAt ? 'true' : undefined}
                  // Freshness is a mark, not a filter: the just-arrived one is
                  // findable at a glance without anything else being hidden.
                  data-fresh={hit.date >= cutoff || undefined}
                  role="button"
                  tabIndex={0}
                  title={t(hit.readAt ? 'codes.copyHint' : 'codes.readHint')}
                  onClick={() => void copy(hit)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void copy(hit)
                    }
                  }}
                >
                  <div className="codecard__mark">
                    {hit.kind === 'code' ? <IconKey size={18} /> : <IconLink size={18} />}
                    {/* The dot carries the unread state on its own, so the
                        distinction survives for anyone who cannot rely on the
                        contrast difference alone. */}
                    {!hit.readAt ? (
                      <span className="codecard__unread" title={t('codes.unread')} />
                    ) : null}
                  </div>

                  <div className="codecard__main">
                    {/* The value first and largest. Everything under it is
                        context for deciding whether this is the right one. */}
                    <div className="codecard__value" data-kind={hit.kind}>
                      {hit.kind === 'code' ? grouped(hit.value) : hit.value}
                    </div>
                    <div className="codecard__sender">
                      {name ? <strong>{name}</strong> : null}
                      <span className="codecard__address">{address}</span>
                    </div>
                    <div className="codecard__meta">
                      <span className="codecard__subject">
                        {hit.subject || t('inbox.noSubject')}
                      </span>
                      <span title={formatDateTime(hit.date)}>{formatAgo(hit.date)}</span>
                      <span className="chip">{accountName(hit.accountId)}</span>
                      {/* Where it came from, so a wrong answer is explainable
                          rather than mysterious — see `core/codeExtract`. */}
                      <span className="chip chip--quiet">
                        {t(
                          hit.source === 'subject'
                            ? 'codes.sourceSubject'
                            : hit.source === 'link'
                              ? 'codes.sourceLink'
                              : 'codes.sourceBody',
                        )}
                      </span>
                      {hit.confidence !== 'high' ? (
                        <span className="chip chip--warning">{t('codes.lowConfidence')}</span>
                      ) : null}
                      {hit.copiedAt && !copied ? (
                        <span className="chip chip--quiet">{t('codes.alreadyCopied')}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="codecard__actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant={copied ? 'primary' : 'secondary'}
                      icon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                      onClick={() => void copy(hit)}
                    >
                      {copied ? t('common.copied') : t('common.copy')}
                    </Button>
                    {hit.kind === 'link' ? (
                      <Button
                        variant="ghost"
                        icon={<IconExternal size={15} />}
                        onClick={() => void openLink(hit)}
                      >
                        {t('inbox.open')}
                      </Button>
                    ) : null}
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
