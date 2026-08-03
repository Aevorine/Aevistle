/**
 * Unified inbox: every enabled account's mail in one list, each row labelled
 * with its account, with a segmented control to narrow to a single account —
 * both requirements come from one piece of local state, no new nav
 * primitive (see `App.tsx`'s flat `ViewId` union).
 *
 * Reading a message is a full-screen surface, not a small dialog. Mail is the
 * content here; a 480px box with the body scrolling inside it made the window
 * mostly chrome. Escape steps out of full screen first and closes second, so
 * one key does the thing every other full-screen surface does.
 *
 * Verification codes used to be extracted by this screen and shown in a card
 * at the top of it. They now have a screen of their own (`CodesView`) fed by
 * an app-wide watcher, because a code that arrives has to be found — and
 * announced — whether or not anyone happens to be looking at the mailbox.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  Modal,
  PageHead,
  Segmented,
  useConfirm,
  useToast,
  type SegmentedOption,
} from '../components/ui'
import {
  IconCheck,
  IconDownload,
  IconExternal,
  IconFlag,
  IconFolder,
  IconInbox,
  IconMaximize,
  IconMinimize,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '../components/icons'
import { VirtualList } from '../components/VirtualList'
import { useApp } from '../state/AppState'
import { SearchInput } from '../components/inputs'
import { useI18n } from '../i18n'
import { resolveRemoteImages } from '../core/remoteImagePlaceholder'
import { resolveWithCache } from '../core/imageCache'
import { getCachedBody, putCachedBody } from '../core/bodyMemo'
import type { InboxMessageBody } from '../core/bridge'
import type { Attachment, InboxMessage, InboxTag } from '../core/types'

/** Above this many selected messages, deleting requires typing to confirm. */
const TYPED_CONFIRM_THRESHOLD = 50

type AccountFilter = 'all' | string

/** Types worth trying to show in place rather than handing straight to the OS. */
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|bmp|avif|pdf|txt|csv|log|md)$/i

export function InboxView({ onGoToAccounts }: { onGoToAccounts?: () => void }) {
  const {
    state,
    bridge,
    dispatch,
    syncInboxAccount,
    getInboxMessageBody,
    ensureInboxAttachment,
    markInboxMessagesRead,
    tagInboxMessages,
    deleteInboxMessages,
  } = useApp()
  const { t, formatAgo, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [filter, setFilter] = useState<AccountFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openMessage, setOpenMessage] = useState<InboxMessage | null>(null)
  const [openBody, setOpenBody] = useState<InboxMessageBody | null>(null)
  const [loadingBody, setLoadingBody] = useState(false)
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [resolvedHtml, setResolvedHtml] = useState<string | null>(null)
  const [loadingImages, setLoadingImages] = useState(false)
  /** Reading starts full-screen; Escape steps out before it closes. */
  const [immersive, setImmersive] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [preview, setPreview] = useState<{ attachment: Attachment; dataUrl: string; mime: string } | null>(null)
  /** Attachment id currently being fetched from the server, for the row spinner. */
  const [fetchingAttachment, setFetchingAttachment] = useState<string | null>(null)

  const accountsById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts])
  const enabledInboxes = useMemo(() => state.inboxAccounts.filter((i) => i.enabled), [state.inboxAccounts])
  const canUseInbox = Boolean(bridge?.syncInbox)

  const allMessages = useMemo(() => enabledInboxes.flatMap((i) => i.messages), [enabledInboxes])

  const accountLabel = useCallback(
    (accountId: string) => {
      const a = accountsById.get(accountId)
      return a?.label || a?.fromAddress || accountId
    },
    [accountsById],
  )

  const accountOptions = useMemo((): SegmentedOption<AccountFilter>[] => {
    const opts: SegmentedOption<AccountFilter>[] = [{ value: 'all', label: t('inbox.allAccounts') }]
    for (const inbox of enabledInboxes) {
      opts.push({ value: inbox.accountId, label: accountLabel(inbox.accountId) })
    }
    return opts
  }, [enabledInboxes, accountLabel, t])

  /**
   * Filtering is deferred, the input is not.
   *
   * The mailbox cache holds up to a thousand rows, and re-scanning all of them
   * between two keystrokes is what makes a search box feel like it is fighting
   * back. `useDeferredValue` lets React paint the character immediately and
   * redo the list at a lower priority — the typed text is never late, only the
   * results are, which is the right way round.
   */
  const deferredQuery = useDeferredValue(query)
  const filteredMessages = useMemo(() => {
    let list = filter === 'all' ? allMessages : allMessages.filter((m) => m.accountId === filter)
    const q = deferredQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.snippet.toLowerCase().includes(q),
      )
    }
    return [...list].sort((a, b) => b.date - a.date)
  }, [allMessages, filter, deferredQuery])
  const searchPending = deferredQuery !== query

  const unreadTotal = useMemo(() => allMessages.filter((m) => !m.seen).length, [allMessages])

  /** The most recent successful check, across every enabled account. */
  const lastSyncAt = useMemo(() => {
    const times = enabledInboxes.map((i) => i.lastSyncAt ?? 0).filter(Boolean)
    return times.length > 0 ? Math.max(...times) : null
  }, [enabledInboxes])

  // --- actions ---

  const syncOne = async (accountId: string) => {
    setSyncingIds((prev) => new Set(prev).add(accountId))
    try {
      await syncInboxAccount(accountId)
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev)
        next.delete(accountId)
        return next
      })
    }
  }

  const syncAll = async () => {
    await Promise.all(enabledInboxes.map((i) => syncOne(i.accountId)))
  }

  const groupByAccount = useCallback(
    (ids: Set<string>): Map<string, string[]> => {
      const map = new Map<string, string[]>()
      for (const m of allMessages) {
        if (!ids.has(m.id)) continue
        const arr = map.get(m.accountId) ?? []
        arr.push(m.id)
        map.set(m.accountId, arr)
      }
      return map
    },
    [allMessages],
  )

  const clearSelection = () => setSelected(new Set())

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAllVisible = () => setSelected(new Set(filteredMessages.map((m) => m.id)))

  const markSet = async (ids: Set<string>, seen: boolean) => {
    const groups = groupByAccount(ids)
    await Promise.all(
      [...groups.entries()].map(([accountId, msgIds]) => markInboxMessagesRead(accountId, msgIds, seen)),
    )
  }

  const markAllRead = async () => {
    await markSet(new Set(allMessages.filter((m) => !m.seen).map((m) => m.id)), true)
    toast.push({ tone: 'success', title: t('inbox.markAllReadDone') })
  }

  const deleteIdSet = async (ids: Set<string>) => {
    const groups = groupByAccount(ids)
    await Promise.all(
      [...groups.entries()].map(([accountId, msgIds]) => deleteInboxMessages(accountId, msgIds)),
    )
  }

  const deleteSelected = async () => {
    const n = selected.size
    const ok = await confirm({
      title: t('confirm.deleteSelectedMessages', { n }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
      requireTypedConfirmation: n > TYPED_CONFIRM_THRESHOLD ? String(n) : undefined,
    })
    if (!ok) return
    await deleteIdSet(selected)
    clearSelection()
    toast.push({ tone: 'info', title: t('toast.deleted') })
  }

  const deleteAllRead = async () => {
    const ids = new Set(allMessages.filter((m) => m.seen).map((m) => m.id))
    if (ids.size === 0) return
    const ok = await confirm({
      title: t('confirm.deleteAllRead', { n: ids.size }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
      requireTypedConfirmation: ids.size > TYPED_CONFIRM_THRESHOLD ? String(ids.size) : undefined,
    })
    if (!ok) return
    await deleteIdSet(ids)
    toast.push({ tone: 'info', title: t('toast.deleted') })
  }

  const deleteAllMessages = async () => {
    const ids = new Set(allMessages.map((m) => m.id))
    if (ids.size === 0) return
    const ok = await confirm({
      title: t('confirm.deleteAllMessages', { n: ids.size }),
      body: t('confirm.deleteAllMessagesBody'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
      requireTypedConfirmation: t('common.delete'),
    })
    if (!ok) return
    await deleteIdSet(ids)
    clearSelection()
    toast.push({ tone: 'info', title: t('toast.deleted') })
  }

  const cycleTag = (m: InboxMessage) => {
    const order: InboxTag[] = ['none', 'flagged', 'important']
    const next = order[(order.indexOf(m.tag) + 1) % order.length]
    tagInboxMessages(m.accountId, [m.id], next)
  }

  // --- attachments ---

  /**
   * The same attachment, guaranteed to have bytes on disk.
   *
   * Android lists a received attachment without downloading it — a mailbox of
   * photographs would otherwise spend a phone's data allowance on files nobody
   * opened — so the first tap is what fetches it. On the desktop this returns
   * immediately, because the body fetch already wrote the file out.
   *
   * `null` on failure, with the toast already shown: every caller's next move
   * is to stop, and making each of them repeat the error handling is how three
   * buttons end up reporting the same problem three different ways.
   */
  const withBytes = async (a: Attachment): Promise<Attachment | null> => {
    if (a.path) return a
    if (!openMessage) return null
    setFetchingAttachment(a.id)
    try {
      const ready = await ensureInboxAttachment(openMessage, a)
      if (!ready.path) {
        toast.push({ tone: 'error', title: t('inbox.attachmentUnavailable', { name: a.name }) })
        return null
      }
      // Keep it, so the next action on the same attachment is instant and the
      // row stops offering to download something already here.
      setOpenBody((prev) =>
        prev
          ? { ...prev, attachments: prev.attachments.map((x) => (x.id === a.id ? ready : x)) }
          : prev,
      )
      return ready
    } catch (e) {
      toast.push({
        tone: 'error',
        title: t('inbox.attachmentDownloadFailed', { name: a.name }),
        detail: e instanceof Error ? e.message : String(e),
      })
      return null
    } finally {
      setFetchingAttachment(null)
    }
  }

  const openAttachment = async (raw: Attachment) => {
    if (!bridge?.openPath) return
    const a = await withBytes(raw)
    if (!a) return
    try {
      await bridge.openPath(a.path)
    } catch (e) {
      toast.push({
        tone: 'error',
        title: t('inbox.openAttachmentFailed', { name: a.name }),
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const revealAttachment = async (raw: Attachment) => {
    if (!bridge?.revealPath) return
    const a = await withBytes(raw)
    if (a) await bridge.revealPath(a.path)
  }

  /**
   * Show it here if we can, hand it to the OS if we cannot.
   *
   * `readAttachment` answers `null` for anything it will not render — too
   * large, or a type whose viewer is somebody else's program. Falling through
   * to `openPath` in that case is what makes one click on an attachment always
   * do *something*, which is the complaint this replaces: the row had an
   * "Open" button that, for the majority of attachments, simply did nothing
   * visible.
   */
  const previewAttachment = async (raw: Attachment) => {
    const a = await withBytes(raw)
    if (!a) return
    if (bridge?.readAttachment && PREVIEWABLE.test(a.name)) {
      try {
        const result = await bridge.readAttachment(a.path)
        if (result) {
          setPreview({ attachment: a, ...result })
          return
        }
      } catch {
        /* fall through to the OS handler */
      }
    }
    await openAttachment(a)
  }

  const saveAttachment = async (raw: Attachment) => {
    if (!bridge?.saveAttachmentAs) return
    const a = await withBytes(raw)
    if (!a) return
    const saved = await bridge.saveAttachmentAs(a.path, a.name)
    if (saved) toast.push({ tone: 'success', title: t('inbox.attachmentSaved', { name: a.name }) })
  }

  const saveAllAttachments = async () => {
    if (!bridge?.saveAttachmentsTo || !openBody) return
    // Every one has to be on disk before the folder picker opens: asking where
    // to put six files and then discovering four of them still need
    // downloading is the wrong order to do this in.
    const ready: string[] = []
    for (const a of openBody.attachments) {
      const one = await withBytes(a)
      if (one?.path) ready.push(one.path)
    }
    if (ready.length === 0) return
    const result = await bridge.saveAttachmentsTo(ready)
    if (result) {
      toast.push({
        tone: 'success',
        title: t('inbox.attachmentsSaved', { n: result.saved }),
        detail: result.folder,
      })
    }
  }

  const openLinkSafely = useCallback(
    async (url: string) => {
      let host = url
      try {
        host = new URL(url).host
      } catch {
        /* keep the raw string if it does not parse */
      }
      const ok = await confirm({
        title: t('confirm.openLinkTitle'),
        body: t('confirm.openLinkBody', { host }),
        confirmLabel: t('confirm.openLinkConfirm'),
        cancelLabel: t('common.cancel'),
      })
      if (ok) void bridge?.openExternal(url)
    },
    [confirm, bridge, t],
  )

  // --- reading ---

  const openDetail = useCallback(
    async (m: InboxMessage) => {
      setOpenMessage(m)
      setResolvedHtml(null)
      setPreview(null)
      setFindOpen(false)
      setFindText('')
      setImmersive(true)
      if (!m.seen) void markInboxMessagesRead(m.accountId, [m.id], true)

      const cached = getCachedBody(m.id)
      if (cached) {
        setOpenBody(cached)
        return
      }
      setOpenBody(null)
      setLoadingBody(true)
      try {
        const body = await getInboxMessageBody(m)
        putCachedBody(m.id, body)
        setOpenBody(body)
      } catch (e) {
        toast.push({
          tone: 'error',
          title: t('inbox.loadFailed'),
          detail: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setLoadingBody(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getInboxMessageBody, markInboxMessagesRead, t],
  )

  /** Move to the message before/after this one in the list currently on screen. */
  const step = useCallback(
    (delta: number) => {
      if (!openMessage) return
      const index = filteredMessages.findIndex((m) => m.id === openMessage.id)
      const next = filteredMessages[index + delta]
      if (next) void openDetail(next)
    },
    [openMessage, filteredMessages, openDetail],
  )

  /**
   * The reader's own keyboard layer.
   *
   * Registered only while a message is open, and it stands down the moment
   * focus is in a text field — otherwise typing "j" into the find box would
   * jump to the next message instead of searching for the letter j.
   */
  useEffect(() => {
    if (!openMessage) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'u') {
        e.preventDefault()
        void markInboxMessagesRead(openMessage.accountId, [openMessage.id], false)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        void deleteIdSet(new Set([openMessage.id])).then(() => setOpenMessage(null))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMessage, step])

  const loadRemoteImages = async () => {
    if (!openBody?.sanitizedHtml || !openBody.remoteImages?.length || !bridge?.fetchRemoteImage) return
    setLoadingImages(true)
    try {
      // Cached by URL, deduplicated, failures remembered — see `core/imageCache`
      // for why this is memory-only and why a `null` result is worth keeping.
      const resolved = await resolveWithCache(openBody.remoteImages, (url) =>
        bridge.fetchRemoteImage!(url),
      )
      setResolvedHtml(resolveRemoteImages(openBody.sanitizedHtml, resolved))
    } finally {
      setLoadingImages(false)
    }
  }

  /**
   * Escape has two jobs here, in order: leave full screen, then close.
   *
   * A single-stage Escape on a full-screen reader throws the whole message
   * away when the user only wanted the window back — and there is no undo for
   * "I lost my place".
   */
  const handleEscape = () => {
    if (preview) setPreview(null)
    else if (findOpen) setFindOpen(false)
    else if (immersive) setImmersive(false)
    else setOpenMessage(null)
  }

  if (!canUseInbox) {
    return (
      <div className="view view--list">
        <div className="view__inner">
          <PageHead title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
          <div className="list-pane">
            <EmptyState
              icon={<IconInbox size={24} />}
              title={t('inbox.unavailableTitle')}
              hint={t('inbox.unavailableHint')}
            />
          </div>
        </div>
      </div>
    )
  }

  const bulkAction =
    selected.size > 0 ? (
      <div className="btn-row">
        <span className="btn-row__note">{t('inbox.selectedCount', { n: selected.size })}</span>
        <Button variant="ghost" onClick={() => markSet(selected, true)}>
          {t('inbox.markRead')}
        </Button>
        <Button variant="ghost" onClick={() => markSet(selected, false)}>
          {t('inbox.markUnread')}
        </Button>
        <Button variant="danger" icon={<IconTrash size={15} />} onClick={deleteSelected}>
          {t('common.delete')}
        </Button>
        <Button variant="ghost" onClick={clearSelection}>
          {t('inbox.clearSelection')}
        </Button>
      </div>
    ) : (
      <div className="btn-row">
        {lastSyncAt ? (
          <span className="btn-row__note" title={formatDateTime(lastSyncAt)}>
            {t('inbox.lastChecked', { when: formatAgo(lastSyncAt) })}
          </span>
        ) : null}
        <Button
          size="lg"
          variant="primary"
          icon={<IconRefresh size={16} />}
          loading={syncingIds.size > 0}
          onClick={syncAll}
          disabled={enabledInboxes.length === 0}
        >
          {syncingIds.size > 0 ? t('inbox.checking') : t('inbox.checkNow')}
        </Button>
      </div>
    )

  const attachments = openBody?.attachments ?? []

  return (
    <div className="view view--list">
      <div className="view__inner">
        <PageHead
          title={t('inbox.title')}
          subtitle={unreadTotal > 0 ? t('inbox.subtitleUnread', { n: unreadTotal }) : t('inbox.subtitle')}
          action={bulkAction}
        />

        {enabledInboxes.length === 0 ? (
          <Banner tone="info">{t('inbox.noAccountsHint')}</Banner>
        ) : (
          <>
            {/* Everything above the list stays put; only rows scroll. */}
            <Segmented value={filter} onChange={setFilter} ariaLabel={t('inbox.title')} options={accountOptions} />

            <div className="search-wrap" data-pending={searchPending || undefined}>
              <SearchInput value={query} onChange={setQuery} placeholder={t('common.search')} />
            </div>

            {selected.size === 0 && filteredMessages.length > 0 ? (
              <div className="btn-row">
                {/* Auto-check lives here rather than in Settings: it is the
                    control people reach for the moment mail seems late, and
                    that moment happens on this screen. */}
                <div className="inline-select">
                  {/* Push first: when it is on it is what actually delivers
                      the mail, and the interval below it is the fallback. */}
                  {bridge?.watchInbox ? (
                    <label className="inline-check" title={t('inbox.pushHint')}>
                      <input
                        type="checkbox"
                        checked={state.settings.inboxPush !== false}
                        onChange={(e) =>
                          dispatch({ type: 'patchSettings', patch: { inboxPush: e.target.checked } })
                        }
                      />
                      <span>{t('inbox.push')}</span>
                    </label>
                  ) : null}
                  <span className="inline-select__label">{t('inbox.syncEvery')}</span>
                  <select
                    className="select select--compact"
                    value={state.settings.inboxSyncMinutes ?? 5}
                    title={t('inbox.syncEveryHint')}
                    onChange={(e) =>
                      dispatch({
                        type: 'patchSettings',
                        patch: { inboxSyncMinutes: Number(e.target.value) },
                      })
                    }
                  >
                    <option value={0}>{t('inbox.syncOff')}</option>
                    {[1, 3, 5, 10, 15, 30, 60].map((n) => (
                      <option key={n} value={n}>
                        {t('inbox.syncMinutes', { n })}
                      </option>
                    ))}
                  </select>
                </div>
                <Button variant="ghost" onClick={selectAllVisible}>
                  {t('inbox.selectAll')}
                </Button>
                {unreadTotal > 0 ? (
                  <Button variant="ghost" icon={<IconCheck size={15} />} onClick={markAllRead}>
                    {t('inbox.markAllRead')}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={deleteAllRead}>
                  {t('inbox.deleteAllRead')}
                </Button>
                <Button variant="ghost" onClick={deleteAllMessages}>
                  {t('inbox.deleteAll')}
                </Button>
              </div>
            ) : null}
          </>
        )}

        {filteredMessages.length === 0 ? (
          <div className="list-pane">
            <EmptyState
              icon={<IconInbox size={24} />}
              title={enabledInboxes.length === 0 ? t('inbox.noAccountsEmpty') : t('inbox.empty')}
              hint={enabledInboxes.length > 0 ? t('inbox.emptyHint') : t('inbox.noAccountsHint')}
              action={
                enabledInboxes.length === 0 && onGoToAccounts ? (
                  <Button variant="primary" onClick={onGoToAccounts}>
                    {t('compose.addAccount')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <VirtualList
            items={filteredMessages}
            keyOf={(m) => m.id}
            estimate={96}
            scrollerClassName="list-pane"
            rowsClassName="joblist"
          >
            {(m) => (
              <div className="job" data-disabled={m.seen ? 'true' : undefined} onClick={() => openDetail(m)}>
                <input
                  type="checkbox"
                  className="job__select"
                  checked={selected.has(m.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelect(m.id)}
                  aria-label={t('inbox.selectMessage')}
                />
                <span className="job__pulse" data-unread={m.seen ? 'false' : 'true'} />
                <div className="job__body">
                  <div className="job__name">{m.subject || t('inbox.noSubject')}</div>
                  <div className="job__meta">
                    {filter === 'all' ? <span className="chip">{accountLabel(m.accountId)}</span> : null}
                    <span className="job__from">{m.from}</span>
                    <span>{formatAgo(m.date)}</span>
                    {m.hasAttachments ? <span className="chip chip--quiet">@</span> : null}
                    {m.tag !== 'none' ? (
                      <span className={`chip chip--${m.tag === 'important' ? 'danger' : 'warning'}`}>
                        {t(m.tag === 'important' ? 'inbox.tagImportant' : 'inbox.tagFlagged')}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="job__actions" onClick={(e) => e.stopPropagation()}>
                  <IconButton label={t('inbox.tagAs')} onClick={() => cycleTag(m)}>
                    <IconFlag size={16} />
                  </IconButton>
                  <IconButton label={t('common.delete')} onClick={() => deleteIdSet(new Set([m.id]))}>
                    <IconTrash size={16} />
                  </IconButton>
                </div>
              </div>
            )}
          </VirtualList>
        )}
      </div>

      <Modal
        open={openMessage !== null}
        fullscreen={immersive}
        wide
        bodyClassName="modal__body--reader"
        title={openMessage?.subject || t('inbox.noSubject')}
        onClose={() => setOpenMessage(null)}
        onEscape={handleEscape}
        closeLabel={t('common.close')}
        headerExtra={
          <div className="btn-row">
            <IconButton label={t('inbox.find')} onClick={() => setFindOpen((v) => !v)}>
              <IconSearch size={16} />
            </IconButton>
            <IconButton
              label={immersive ? t('inbox.exitFullscreen') : t('inbox.fullscreen')}
              onClick={() => setImmersive((v) => !v)}
            >
              {immersive ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
            </IconButton>
          </div>
        }
      >
        {openMessage ? (
          <>
            <div className="reader__meta">
              <span>
                <strong>{t('inbox.from')}</strong> {openMessage.from}
              </span>
              <span>{formatDateTime(openMessage.date)}</span>
              <span className="chip">{accountLabel(openMessage.accountId)}</span>
              <span className="reader__hint">{t('inbox.readerKeys')}</span>
            </div>

            {findOpen ? (
              <div className="reader__find">
                <IconSearch size={14} />
                <input
                  className="input"
                  autoFocus
                  value={findText}
                  placeholder={t('inbox.findPlaceholder')}
                  onChange={(e) => setFindText(e.target.value)}
                />
                <IconButton
                  label={t('common.close')}
                  onClick={() => {
                    setFindOpen(false)
                    setFindText('')
                  }}
                >
                  <IconX size={15} />
                </IconButton>
              </div>
            ) : null}

            {loadingBody ? (
              <div className="reader__loading">
                <span className="spinner" style={{ width: 22, height: 22, color: 'var(--accent)' }} />
              </div>
            ) : openBody ? (
              <>
                {openBody.remoteImages && openBody.remoteImages.length > 0 && !resolvedHtml ? (
                  <Banner
                    tone="warning"
                    action={
                      <Button variant="ghost" loading={loadingImages} onClick={loadRemoteImages}>
                        {t('inbox.loadImages', { n: openBody.remoteImages.length })}
                      </Button>
                    }
                  >
                    {t('inbox.remoteImagesBlocked')}
                  </Banner>
                ) : null}

                <MessageBodyFrame
                  html={resolvedHtml ?? openBody.sanitizedHtml ?? textAsHtml(openBody.text ?? t('inbox.noBody'))}
                  find={findOpen ? findText : ''}
                  onLinkClick={openLinkSafely}
                />

                {attachments.length > 0 ? (
                  <div className="reader__attachments">
                    <div className="section-label">
                      {t('compose.attachments')} · {attachments.length}
                      {bridge?.saveAttachmentsTo && attachments.length > 1 ? (
                        <button type="button" className="link" onClick={saveAllAttachments}>
                          {t('inbox.saveAll')}
                        </button>
                      ) : null}
                    </div>
                    <div className="attachments">
                      {attachments.map((a) => (
                        <div className="attachment attachment--clickable" key={a.id}>
                          <button
                            type="button"
                            className="attachment__open"
                            disabled={fetchingAttachment !== null}
                            onClick={() => void previewAttachment(a)}
                            title={t('inbox.open')}
                          >
                            <span className="attachment__icon attachment__icon--tag">
                              {fetchingAttachment === a.id ? (
                                <span className="spinner" style={{ width: 14, height: 14 }} />
                              ) : (
                                (a.name.split('.').pop() ?? '?').slice(0, 4).toUpperCase()
                              )}
                            </span>
                            <span className="attachment__body">
                              <span className="attachment__name">{a.name}</span>
                              <span className="attachment__meta">
                                {formatSize(a.size)}
                                {/* Says so before you tap, rather than after a
                                    pause you had no reason to expect. */}
                                {!a.path ? ` · ${t('inbox.attachmentNotDownloaded')}` : ''}
                              </span>
                            </span>
                          </button>
                          {bridge?.saveAttachmentAs ? (
                            <IconButton label={t('inbox.saveAs')} onClick={() => void saveAttachment(a)}>
                              <IconDownload size={16} />
                            </IconButton>
                          ) : null}
                          {bridge?.openPath ? (
                            <IconButton label={t('inbox.openExternally')} onClick={() => void openAttachment(a)}>
                              <IconExternal size={16} />
                            </IconButton>
                          ) : null}
                          {bridge?.revealPath ? (
                            <IconButton label={t('inbox.revealAttachment')} onClick={() => void revealAttachment(a)}>
                              <IconFolder size={16} />
                            </IconButton>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </Modal>

      {/* Attachment preview: its own layer above the reader, so closing it
          returns to the message rather than to the list. */}
      <Modal
        open={preview !== null}
        fullscreen
        title={preview?.attachment.name ?? ''}
        onClose={() => setPreview(null)}
        closeLabel={t('common.close')}
        bodyClassName="modal__body--preview"
        headerExtra={
          preview && bridge?.saveAttachmentAs ? (
            <Button
              variant="ghost"
              icon={<IconDownload size={15} />}
              onClick={() => void saveAttachment(preview.attachment)}
            >
              {t('inbox.saveAs')}
            </Button>
          ) : undefined
        }
      >
        {preview ? (
          preview.mime.startsWith('image/') ? (
            <img className="preview__image" src={preview.dataUrl} alt={preview.attachment.name} />
          ) : (
            // PDFs and text both render inertly in a sandboxed frame. No
            // `allow-scripts`, exactly as the message body frame below.
            <iframe
              className="preview__frame"
              sandbox=""
              src={preview.dataUrl}
              title={preview.attachment.name}
            />
          )
        ) : null}
      </Modal>

      {confirmElement}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Wrap a plain-text body so it can go through the same frame the HTML does. */
function textAsHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<pre style="white-space:pre-wrap;word-break:break-word;font:inherit;margin:0">${escaped}</pre>`
}

/**
 * Renders a sanitized message body inside a fully inert iframe (no
 * `allow-scripts`) and intercepts link clicks from the *parent* page via
 * `allow-same-origin` — see `electron/sanitizeHtml.ts`'s file header for why
 * this is the shape it is.
 *
 * `find` highlights matches by walking the frame's text nodes from out here.
 * That is only possible because of `allow-same-origin`, and it is the reason
 * the search is done this way rather than by injecting a script: the frame
 * still cannot execute anything, whatever the sanitiser upstream missed.
 */
function MessageBodyFrame({
  html,
  find,
  onLinkClick,
}: {
  html: string
  find: string
  onLinkClick: (url: string) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(0)

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return
    const handleLoad = () => {
      setLoaded((n) => n + 1)
      const doc = iframe.contentDocument
      if (!doc) return
      const handler = (e: MouseEvent) => {
        const target = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null
        if (!target) return
        e.preventDefault()
        onLinkClick(target.href)
      }
      doc.addEventListener('click', handler)
      // Match the app's own type so a plain-text mail does not arrive in
      // whatever the engine's default serif happens to be.
      const style = doc.createElement('style')
      style.textContent =
        'body{margin:0;padding:16px;font-family:inherit;color:#111;background:#fff;word-break:break-word}' +
        'img{max-width:100%;height:auto}table{max-width:100%}' +
        'mark.aev-find{background:#ffe066;color:#111}'
      doc.head?.appendChild(style)
    }
    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [onLinkClick])

  useEffect(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.body) return

    // Clear previous highlights first, or a second search would highlight
    // inside the marks the first one left behind.
    for (const mark of [...doc.querySelectorAll('mark.aev-find')]) {
      const parent = mark.parentNode
      if (!parent) continue
      parent.replaceChild(doc.createTextNode(mark.textContent ?? ''), mark)
      parent.normalize()
    }
    const needle = find.trim().toLowerCase()
    if (needle.length === 0) return

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? '').toLowerCase().includes(needle)) targets.push(node as Text)
    }

    let first: HTMLElement | null = null
    for (const text of targets) {
      const value = text.textContent ?? ''
      const fragment = doc.createDocumentFragment()
      let index = 0
      for (;;) {
        const at = value.toLowerCase().indexOf(needle, index)
        if (at < 0) break
        fragment.appendChild(doc.createTextNode(value.slice(index, at)))
        const mark = doc.createElement('mark')
        mark.className = 'aev-find'
        mark.textContent = value.slice(at, at + needle.length)
        fragment.appendChild(mark)
        first ??= mark
        index = at + needle.length
      }
      fragment.appendChild(doc.createTextNode(value.slice(index)))
      text.parentNode?.replaceChild(fragment, text)
    }
    first?.scrollIntoView({ block: 'center' })
  }, [find, loaded, html])

  return (
    <iframe
      ref={ref}
      // No `allow-scripts` — the content cannot execute anything regardless
      // of whether the sanitizer upstream has a bug. `allow-same-origin`
      // alone is what lets the effects above reach `contentDocument`.
      sandbox="allow-same-origin"
      srcDoc={html}
      title="message-body"
      className="reader__frame"
    />
  )
}
