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
 *
 * ---------------------------------------------------------------------------
 * B4 · 收件箱 → 日历
 *
 * A mail that says "the review is on 12 March at 14:30" is a reminder waiting
 * to be typed out by hand, and the app already knows how to send reminders.
 * `core/dateExtract` reads the moment; this screen offers it, in the reader,
 * next to the sentence it came from.
 *
 * Three rules, each of them the reason a line of code below looks the way it
 * does:
 *
 *  - **Nothing is created without a press.** Extraction runs when a message is
 *    opened, which is already a deliberate act; a *job* is only ever built
 *    inside `scheduleFromDate`, which is only ever reached from an `onClick`.
 *    Arrival does nothing at all. This app never quietly creates outgoing mail.
 *  - **The evidence travels with the answer.** Every offer shows the verbatim
 *    slice of the message it was read from, exactly as `CodesView` does for a
 *    verification code, so a wrong date is visibly wrong rather than mysterious.
 *  - **`low` is never the default.** A low-confidence reading (see the date-order
 *    rule in `core/dateExtract`, where bare `en` cannot decide `03/04`) gets no
 *    primary button and asks a second question before it schedules. A wrong
 *    date silently scheduled is worse than no offer at all.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  IconButton,
  Modal,
  PageHead,
  useConfirm,
  useToast,
} from '../components/ui'
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconDownload,
  IconExternal,
  IconFlag,
  IconFolder,
  IconGrip,
  IconInbox,
  IconMaximize,
  IconMinimize,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '../components/icons'
import { VirtualList } from '../components/VirtualList'
import { useSwipe } from '../components/useSwipe'
import { MessageBodyFrame, textAsHtml } from '../components/MessageBodyFrame'
import { useApp } from '../state/AppState'
import { SearchInput } from '../components/inputs'
import {
  ImageLightbox,
  ImageStrip,
  isViewableImage,
  seedAttachmentImage,
  useAttachmentImages,
} from '../components/ImageLightbox'
import { useI18n, type TranslationKey } from '../i18n'
import { accountGroupKey, orderedAccounts } from '../core/accounts'
import { useReorder } from '../components/useReorder'
import { BROKEN_IMAGE, resolveRemoteImages } from '../core/remoteImagePlaceholder'
import { resolveWithCache } from '../core/imageCache'
import { getCachedBody, putCachedBody } from '../core/bodyMemo'
import { CHAIN_STAGES, buildChain, leadLabelKey } from '../core/chain'
import { extractDates, type DateHit } from '../core/dateExtract'
import type { InboxMessageBody } from '../core/bridge'
import {
  DEFAULT_RETRY,
  REMOVED_RETENTION_MS,
  defaultRecurrence,
  effectiveImagePolicy,
  emptyDraft,
  senderDomain,
  shouldAutoLoadImages,
  type Attachment,
  type InboxMessage,
  type InboxTag,
  type ScheduledJob,
} from '../core/types'

type AccountFilter = 'all' | string

type SearchScope = 'all' | 'from' | 'subject' | 'body'

/** Kept in step with `REMOVED_RETENTION_MS`; shown so the bin says how long it keeps things. */
const BIN_DAYS = Math.round(REMOVED_RETENTION_MS / 86_400_000)

/** Types worth trying to show in place rather than handing straight to the OS. */
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|bmp|avif|pdf|txt|csv|log|md)$/i

/**
 * Which lead time a single press should use, most wanted first.
 *
 * The day before is the one people mean: it is late enough to still be about
 * this event and early enough to do something about it. The rest are the
 * fallbacks for an event that is closer than that — a meeting in ninety
 * minutes cannot have a "day before" stage, and offering one that silently
 * collapses onto the event itself is how a reminder arrives too late to help.
 */
const LEAD_PREFERENCE = [86_400_000, 2 * 3_600_000, 0, 3 * 86_400_000, 7 * 86_400_000]

/** Longest evidence snippet worth putting in a reminder mail, in characters. */
const EVIDENCE_LIMIT = 240

/**
 * The plain text a message actually reads as.
 *
 * `dateExtract` documents that its `body` is plain text — HTML converted
 * upstream — and the desktop fetch does supply `text` for nearly every mail.
 * The fallback exists for the ones it does not: a purely HTML newsletter whose
 * `text/plain` alternative the sender omitted. Tags are replaced by a space or
 * a newline rather than deleted, because `<td>12</td><td>March</td>` collapsed
 * without a separator becomes `12March`, which reads as nothing at all.
 */
function bodyAsText(text: string, html: string): string {
  if (text.trim()) return text
  if (!html) return ''
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#3[59];/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * The raw `text/calendar` parts, when the platform hands any over.
 *
 * Read defensively rather than off a declared field: the transport that
 * carries them is a neighbouring piece of work, and `dateExtract` treats them
 * as optional — with them a real invitation is read from its `DTSTART`,
 * without them the prose path answers. Neither needs this file to change.
 */
function icsPartsOf(body: InboxMessageBody): string[] | undefined {
  const parts = (body as { icsParts?: unknown }).icsParts
  if (!Array.isArray(parts)) return undefined
  const strings = parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
  return strings.length > 0 ? strings : undefined
}

/**
 * The platform's own language tag, not the app's `LocaleId`.
 *
 * `detectLocale()` collapses every English tag to `en`, and the region subtag
 * it throws away is the only thing that decides whether `03/04/2026` is
 * 3 April or 4 March — see the date-order rule in `core/dateExtract`.
 */
function platformLocale(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 'HH:mm' for an instant, in local time. */
function hhmm(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function InboxView({
  onGoToAccounts,
  focusMessageId,
  onFocusHandled,
}: {
  onGoToAccounts?: () => void
  /**
   * A message the user asked for from outside this screen — by clicking a
   * new-mail notification. Opened once, then handed back via
   * `onFocusHandled` so the same id cannot re-open the reader every time this
   * component re-renders.
   */
  focusMessageId?: string | null
  onFocusHandled?: () => void
}) {
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
    purgeInboxMessages,
    restoreInboxMessages,
    clearRemovedMessages,
    scheduleDraft,
  } = useApp()
  const { t, formatAgo, formatDateTime, dir } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [filter, setFilter] = useState<AccountFilter>('all')
  const [query, setQuery] = useState('')
  /** Which field the search box looks in. */
  const [scope, setScope] = useState<SearchScope>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openMessage, setOpenMessage] = useState<InboxMessage | null>(null)
  const [openBody, setOpenBody] = useState<InboxMessageBody | null>(null)
  const [loadingBody, setLoadingBody] = useState(false)
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [resolvedHtml, setResolvedHtml] = useState<string | null>(null)
  /**
   * Where this message's remote images have got to.
   *
   * `blocked` is the only state that offers a button, and it is reached only
   * when the account's policy says so. Everything else has to be *visible*:
   * `loading` says so on a slow link, `failed` says so instead of leaving
   * blank rectangles, and a `partial` load names how many are missing rather
   * than pretending the message rendered whole.
   */
  const [imageStage, setImageStage] = useState<'blocked' | 'loading' | 'done' | 'failed'>('blocked')
  /** How many distinct URLs the last attempt could not fetch. */
  const [imageFailures, setImageFailures] = useState(0)
  /** Reading starts full-screen; Escape steps out before it closes. */
  const [immersive, setImmersive] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  /**
   * Highlighting is deferred, the input is not — the same trade the message
   * filter above makes, for a much heavier consumer.
   *
   * `MessageBodyFrame` re-highlights by un-marking every existing `mark` (with
   * a `parent.normalize()` each) and then walking the whole iframe document
   * with a `TreeWalker`, splitting every matching text node. On a long
   * newsletter that is thousands of cross-document DOM operations, and it ran
   * once per character typed — so the character itself could not paint until
   * the previous search had finished repainting the body.
   */
  const deferredFind = useDeferredValue(findText)
  const [preview, setPreview] = useState<{ attachment: Attachment; dataUrl: string; mime: string } | null>(null)
  /**
   * The picture on show, by path rather than by index.
   *
   * An index would be wrong the moment the gallery changes underneath it, and
   * it changes routinely: fetching one attachment on Android adds it to the
   * run, which would silently shift what "picture 3" means while it is open.
   */
  const [lightboxPath, setLightboxPath] = useState<string | null>(null)
  /** Attachment id currently being fetched from the server, for the row spinner. */
  const [fetchingAttachment, setFetchingAttachment] = useState<string | null>(null)

  const accountsById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts])
  const enabledInboxes = useMemo(() => state.inboxAccounts.filter((i) => i.enabled), [state.inboxAccounts])
  const canUseInbox = Boolean(bridge?.syncInbox) || true /*TEMP-VERIFY*/

  const allMessages = useMemo(() => enabledInboxes.flatMap((i) => i.messages), [enabledInboxes])

  const accountLabel = useCallback(
    (accountId: string) => {
      const a = accountsById.get(accountId)
      // Never the raw `acct_...` id. `AppState.tsx` guards against a deleted
      // account's inbox row being resurrected by a late sync reply, and
      // sweeps any that already made it to disk before those guards existed
      // — but neither of those is instantaneous for someone still on an older
      // build, so this screen cannot assume `accountsById` always has an
      // entry. Falling back to the id used to mean printing an internal
      // identifier nobody chose or recognises; a translated placeholder says
      // the same thing without leaking it.
      return a?.label || a?.fromAddress || t('inbox.unknownAccount')
    },
    [accountsById, t],
  )

  /**
   * The tab strip's order, taken from the account list rather than from here.
   *
   * `state.inboxAccounts` is a different array from `state.accounts`, appended
   * to at a different moment by a different action — enabling IMAP on your
   * third account pushes an inbox row while the account itself has been second
   * in the list since the day it was added. Nothing ever made the two agree, so
   * the same four mailboxes could read work / personal / client / spare in
   * Settings and personal / client / work / spare one tab away. That is not a
   * cosmetic difference: a tab strip whose order is not the order you arranged
   * is a strip you have to read every time instead of one you learn.
   *
   * So the sequence comes from `orderedAccounts` — the single arrangement both
   * screens share — and `enabledInboxes` is demoted to a filter over it.
   *
   * Orphans are appended rather than dropped. An inbox row can outlive its
   * account for a moment (see `accountLabel` above for the same hazard), and
   * silently losing its tab would leave its messages visible under "all" with
   * no way to isolate them and no hint that a tab had ever existed.
   */
  const inboxOrder = useMemo(() => {
    const enabled = new Set(enabledInboxes.map((i) => i.accountId))
    const ids = orderedAccounts(state.accounts)
      .filter((a) => enabled.has(a.id))
      .map((a) => a.id)
    const placed = new Set(ids)
    for (const inbox of enabledInboxes) {
      if (!placed.has(inbox.accountId)) ids.push(inbox.accountId)
    }
    return ids
  }, [enabledInboxes, state.accounts])

  const inboxReorder = useReorder({
    ids: inboxOrder,
    axis: 'horizontal',
    // The same rule Settings enforces, for the same reason: the strip is a
    // flattened view of a grouped list, and a tab dragged out of its group's
    // run would be drawn back inside it on the next render.
    scopeOf: useCallback((id: string) => accountGroupKey(accountsById.get(id)), [accountsById]),
    onReorder: useCallback((ids: string[]) => dispatch({ type: 'reorderAccounts', ids }), [dispatch]),
    announce: useCallback(
      (id: string, position: number, total: number) =>
        t('account.reorderMoved', { name: accountLabel(id), n: position, total }),
      [accountLabel, t],
    ),
    disabled: inboxOrder.length < 2,
  })

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
      /*
       * Which field to look in.
       *
       * "Everything" stays the default because it is what someone typing a
       * half-remembered word wants. The other three exist for the case that
       * default is bad at: searching for a person turns up every newsletter
       * that happens to mention their name, and the sender is not something
       * you can narrow to by typing more.
       */
      const inField = {
        all: (m: InboxMessage) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.snippet.toLowerCase().includes(q),
        from: (m: InboxMessage) => m.from.toLowerCase().includes(q),
        subject: (m: InboxMessage) => m.subject.toLowerCase().includes(q),
        // The snippet, not the whole body: bodies live in an on-disk cache and
        // are fetched on demand, so scanning them would mean reading up to a
        // thousand files between two keystrokes. Saying "preview text" rather
        // than "body" is the honest label for what is actually searched.
        body: (m: InboxMessage) => m.snippet.toLowerCase().includes(q),
      }[scope]
      list = list.filter(inField)
    }
    return [...list].sort((a, b) => b.date - a.date)
  }, [allMessages, filter, deferredQuery, scope])
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

  /**
   * The recycle bin, flattened across accounts and newest first.
   *
   * One list rather than one per mailbox: someone looking for a message they
   * just removed is looking for *that message*, and being asked which account
   * it was in first is the question they came here because they could not
   * answer.
   */
  const [showBin, setShowBin] = useState(false)
  const removedAll = useMemo(
    () =>
      state.inboxAccounts
        .flatMap((i) => (i.removed ?? []).map((entry) => ({ accountId: i.accountId, entry })))
        .sort((a, b) => b.entry.at - a.entry.at),
    [state.inboxAccounts],
  )

  const restoreAllRemoved = () => {
    const byAccount = new Map<string, string[]>()
    for (const { accountId, entry } of removedAll) {
      const key = `${entry.message.folderPath} ${entry.message.uid}`
      const list = byAccount.get(accountId)
      if (list) list.push(key)
      else byAccount.set(accountId, [key])
    }
    for (const [accountId, keys] of byAccount) restoreInboxMessages(accountId, keys)
    toast.push({ tone: 'success', title: t('toast.restored', { n: removedAll.length }) })
  }

  const emptyBin = async () => {
    const ok = await confirm({
      title: t('confirm.emptyBin', { n: removedAll.length }),
      // Worth spelling out: emptying the bin is not a second deletion. The mail
      // is still on the server; what is lost is the ability to bring the row
      // back without also un-removing it by hand.
      body: t('confirm.emptyBinBody'),
      confirmLabel: t('inbox.binEmpty'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    clearRemovedMessages()
    setShowBin(false)
  }

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
    })
    if (!ok) return
    await deleteIdSet(selected)
    clearSelection()
    toast.push({ tone: 'info', title: t('toast.deleted') })
  }

  /** Apply one tag to every selected message, grouped by the account each belongs to. */
  const tagSet = (ids: Set<string>, tag: InboxTag) => {
    for (const [accountId, msgIds] of groupByAccount(ids)) {
      tagInboxMessages(accountId, msgIds, tag)
    }
    clearSelection()
  }

  /**
   * Delete on the server, for real.
   *
   * Asks a second time and names the mailbox, because this is the one action
   * here that reaches outside the app and cannot be taken back — the recycle
   * bin has nothing to restore from once the message is gone from the server.
   * Failures are surfaced: the rows are only dropped after the server agrees,
   * so a red toast here means the mail is still in the mailbox, which is the
   * truth and is worth knowing.
   */
  const purgeSet = async (ids: Set<string>, title: string) => {
    if (ids.size === 0) return
    const ok = await confirm({
      title,
      body: t('confirm.purgeBody'),
      confirmLabel: t('inbox.deleteOnServer'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!ok) return
    const failures: string[] = []
    let removed = 0
    for (const [accountId, msgIds] of groupByAccount(ids)) {
      const result = await purgeInboxMessages(accountId, msgIds)
      if (result.ok) removed += msgIds.length
      else failures.push(result.error ?? 'unknown')
    }
    clearSelection()
    if (failures.length === 0) {
      toast.push({ tone: 'success', title: t('toast.purged', { n: removed }) })
    } else {
      toast.push({
        tone: 'error',
        title: t('toast.purgeFailed'),
        detail: failures.join('; '),
      })
    }
  }

  const purgeSelected = () =>
    purgeSet(selected, t('confirm.purgeSelected', { n: selected.size }))

  const purgeAllMessages = () => {
    const ids = new Set(allMessages.map((m) => m.id))
    return purgeSet(ids, t('confirm.purgeAll', { n: ids.size }))
  }

  const deleteAllRead = async () => {
    const ids = new Set(allMessages.filter((m) => m.seen).map((m) => m.id))
    if (ids.size === 0) return
    const ok = await confirm({
      title: t('confirm.deleteAllRead', { n: ids.size }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
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
          // Pictures get the full-screen viewer — zoom, rotate, and the rest of
          // the message's images under the arrow keys. Everything else keeps
          // the inert sandboxed frame.
          //
          // The read happens here rather than being left to the viewer's own
          // loader because a refusal (too large, wrong type) has to be known
          // *before* anything opens: that is the difference between showing the
          // file and handing it to the operating system, and deciding it after
          // the fact would leave a click that opens an empty black screen.
          if (isViewableImage(a.name) && result.mime.startsWith('image/')) {
            seedAttachmentImage(a.path, result)
            setLightboxPath(a.path)
            return
          }
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

  // --- remote images ---

  /** The receiving account the open message belongs to — where its image policy lives. */
  const openInbox = useMemo(
    () =>
      openMessage
        ? state.inboxAccounts.find((i) => i.accountId === openMessage.accountId)
        : undefined,
    [state.inboxAccounts, openMessage],
  )
  const imagePolicy = effectiveImagePolicy(
    openInbox?.showRemoteImages,
    state.settings.imagePolicyChosen,
  )
  const openSender = openMessage ? senderDomain(openMessage.from) : ''
  const autoLoadImages = openMessage
    ? shouldAutoLoadImages(imagePolicy, openMessage.from, openInbox?.imageAllowlist)
    : false
  const remoteImageCount = openBody?.remoteImages?.length ?? 0

  /**
   * Which load is the current one.
   *
   * Reading down a list with `j` starts a fetch per message, and the slow one
   * finishes after the reader has moved on. Without this counter that stale
   * result would splice message 3's pictures into message 5's body — the
   * bodies are different strings, so it would mostly render as *nothing*
   * happening, which is worse than a visible mistake.
   */
  const imageRun = useRef(0)

  const loadRemoteImages = useCallback(
    async (options?: { retry?: boolean }) => {
      const body = openBody
      const html = body?.sanitizedHtml
      const urls = body?.remoteImages
      if (!html || !urls?.length) return
      const run = ++imageRun.current
      // No proxy on this platform means no images, and saying so beats
      // leaving the placeholders in place with nothing to explain them.
      if (!bridge?.fetchRemoteImage) {
        setImageFailures(new Set(urls).size)
        setImageStage('failed')
        return
      }
      setImageStage('loading')
      setImageFailures(0)
      try {
        // Cached by URL, deduplicated, and persisted in the main process —
        // see `core/imageCache` and `electron/remoteImage.ts`.
        const resolved = await resolveWithCache(urls, (url) => bridge.fetchRemoteImage!(url), {
          retryFailures: options?.retry,
        })
        if (run !== imageRun.current) return
        const failed = new Set(urls.filter((_, i) => resolved[i] === null)).size
        // Only now is `BROKEN_IMAGE` right: every URL has been tried, so a
        // null really is a failure rather than a fetch still in flight.
        setResolvedHtml(resolveRemoteImages(html, resolved, BROKEN_IMAGE))
        setImageFailures(failed)
        setImageStage(failed > 0 ? 'failed' : 'done')
      } catch {
        if (run !== imageRun.current) return
        setImageFailures(urls.length)
        setImageStage('failed')
      }
    },
    [openBody, bridge],
  )

  /**
   * Load them without being asked, when the policy allows it.
   *
   * This is the whole point of the default: a message full of pictures used to
   * open as a wall of blank rectangles with a bar on top asking permission,
   * which is the wrong trade for something the app can fetch safely on the
   * user's behalf. Nothing about *how* they are fetched changed — the body
   * frame still cannot reach the network, the CSP still forbids it, and every
   * byte still comes through the main process's vetted path.
   */
  useEffect(() => {
    if (!openMessage || !openBody) return
    if (remoteImageCount === 0) return
    if (!autoLoadImages) return
    if (imageStage !== 'blocked') return
    void loadRemoteImages()
  }, [openMessage, openBody, remoteImageCount, autoLoadImages, imageStage, loadRemoteImages])

  /**
   * "Always show pictures from this sender."
   *
   * Writes the sender's domain into the account's allowlist and switches the
   * account to `allowlist`, which is the only way that policy is ever reached
   * — a mode you can select in Settings but never populate would be a control
   * that does nothing.
   */
  const allowSenderImages = () => {
    if (!openInbox || !openSender) return
    // `imagePolicyChosen` is app-wide and about to become true, which changes
    // how a stored 'never' reads for *every* account. Pin the others to what
    // they show right now so this click only decides this mailbox.
    if (!state.settings.imagePolicyChosen) {
      for (const other of state.inboxAccounts) {
        if (other.accountId === openInbox.accountId) continue
        const pinned = effectiveImagePolicy(other.showRemoteImages, false)
        if (other.showRemoteImages !== pinned) {
          dispatch({ type: 'upsertInboxAccount', inbox: { ...other, showRemoteImages: pinned } })
        }
      }
    }
    const allowlist = openInbox.imageAllowlist ?? []
    if (!allowlist.includes(openSender)) {
      dispatch({
        type: 'upsertInboxAccount',
        inbox: { ...openInbox, showRemoteImages: 'allowlist', imageAllowlist: [...allowlist, openSender] },
      })
    } else if (openInbox.showRemoteImages !== 'allowlist') {
      dispatch({ type: 'upsertInboxAccount', inbox: { ...openInbox, showRemoteImages: 'allowlist' } })
    }
    // The user has now answered the question, so a stored 'never' from before
    // this control existed stops being treated as the old default.
    dispatch({ type: 'patchSettings', patch: { imagePolicyChosen: true } })
    void loadRemoteImages()
  }

  // --- reading ---

  const openDetail = useCallback(
    async (m: InboxMessage) => {
      setOpenMessage(m)
      setResolvedHtml(null)
      setImageStage('blocked')
      setImageFailures(0)
      // Retires any image load still in flight for the message being left. It
      // has to happen here and not only when the next load starts: a message
      // with no pictures never starts one, and the previous message's result
      // would arrive to find nothing had superseded it.
      imageRun.current += 1
      setPreview(null)
      setLightboxPath(null)
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

  /**
   * Open the message a notification click asked for.
   *
   * Against `allMessages` rather than `filteredMessages`: the notification
   * names a specific message, and whatever account filter or search text
   * happens to be on screen has nothing to do with whether the user meant it.
   * Filtering here is how "I clicked the notification and nothing happened"
   * would have been reintroduced one layer further in.
   *
   * `onFocusHandled` fires whether or not the message was found. An id that no
   * longer matches anything — the mail was deleted, or the account was removed
   * between the notification and the click — must still be cleared, or the
   * effect retries on every render for the life of the screen.
   */
  useEffect(() => {
    if (!focusMessageId) return
    const target = allMessages.find((m) => m.id === focusMessageId)
    if (target) void openDetail(target)
    onFocusHandled?.()
  }, [focusMessageId, allMessages, openDetail, onFocusHandled])

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

  /**
   * The pictures on the open message, ready to be looked at.
   *
   * Above the "inbox not available" return on purpose: these are hooks, and a
   * hook that only runs on some renders is the one bug React cannot recover
   * from.
   *
   * Only attachments already on disk are included. On Android an inbox
   * attachment is metadata until it is first opened — pre-fetching every image
   * in a message the moment it is read would spend somebody's mobile data on
   * pictures they may never scroll to. The others still open on click through
   * the ordinary path; they simply join the previous/next run once fetched.
   */
  // --- B4 · the meeting / deadline this message is about --------------------

  /*
   * The four inputs, pulled out as plain values on purpose.
   *
   * `openBody` is *replaced* whenever an attachment finishes downloading
   * (`withBytes` splices the ready file back in), and `openMessage` is
   * replaced by every read/unread toggle. Keying the extraction on either
   * object would re-run six languages' worth of matchers because somebody
   * tapped a PDF. Strings and numbers compare by value, so the memo below
   * only re-runs when the message genuinely changes.
   */
  const openMessageId = openMessage?.id
  const openSubject = openMessage?.subject ?? ''
  const openReceivedAt = openMessage?.date ?? 0
  const openText = openBody?.text ?? ''
  const openHtml = openBody?.sanitizedHtml ?? ''
  /*
   * The calendar parts, carried by *value* rather than by identity.
   *
   * `icsPartsOf` filters, so it hands back a fresh array every time it is
   * called — and a fresh array in a dependency list is a memo that never hits,
   * which would put the whole extraction back on every render by a route
   * nothing in the code reads as a loop. Serialising and parsing back is the
   * cheapest honest way to compare a small array of strings by content: the
   * serialise re-runs only when the body object is replaced (an attachment
   * finishing its download), and the parse only when the calendar data has
   * genuinely changed — so the extraction below sees one stable value.
   */
  const openIcsKey = useMemo(
    () => JSON.stringify(openBody ? (icsPartsOf(openBody) ?? []) : []),
    [openBody],
  )
  const openIcsParts = useMemo(() => {
    const parts = JSON.parse(openIcsKey) as string[]
    return parts.length > 0 ? parts : undefined
  }, [openIcsKey])

  /**
   * Every moment this message appears to be about.
   *
   * **Memoised on the message, and on nothing that moves while reading it.**
   * Extraction is not free — six languages, twenty-odd strike-out patterns and
   * several matcher passes over the whole body — and this component re-renders
   * on every keystroke in the find box, every attachment fetch and every image
   * that arrives. `findText` and `deferredFind` are deliberately absent from
   * the dependency list: the find-in-message path was already the bottleneck
   * once (see `deferredFind` above), and putting a full re-extraction on it
   * would be the same mistake with a heavier consumer.
   *
   * It runs when a message is *opened*, which is a deliberate act, and it
   * produces nothing but a list of offers. No mail is created here.
   */
  const dateHits = useMemo<DateHit[]>(() => {
    if (!openMessageId || openReceivedAt === 0) return []
    const body = bodyAsText(openText, openHtml)
    if (!body && !openSubject) return []
    return extractDates({
      subject: openSubject,
      body,
      // The anchor is when the mail was *sent*, never the clock. "Tomorrow at
      // 3" in a message read on Thursday means the day after it arrived.
      receivedAt: openReceivedAt,
      icsParts: openIcsParts,
      locale: platformLocale(),
    })
  }, [openMessageId, openSubject, openReceivedAt, openText, openHtml, openIcsParts])

  /**
   * Reminders already made from this message, keyed by moment *and* lead time.
   *
   * Includes the message id, so moving to the next mail starts clean without
   * anything having to remember to reset it. A second press on the same offer
   * is still allowed — two reminders for one meeting is a thing people
   * genuinely want — the mark only says the first one landed.
   */
  const [scheduledOffers, setScheduledOffers] = useState<Set<string>>(new Set())
  const offerKey = (hit: DateHit, leadMs: number) =>
    `${openMessageId ?? ''}${hit.at}${leadMs}`

  /** "12 Mar 2026, 14:30", or just the day when the mail only gave a day. */
  const whenLabel = useCallback(
    (hit: DateHit) =>
      hit.allDay ? formatDateTime(hit.at, { timeStyle: undefined }) : formatDateTime(hit.at),
    [formatDateTime],
  )

  /**
   * One press, one scheduled reminder email.
   *
   * Everything here is the machinery the compose screen already uses:
   * `buildChain` models "remind me N before an event" and drops a stage whose
   * fire time has already gone, and `scheduleDraft` is the same call the
   * schedule button makes. Nothing new reaches the scheduler.
   *
   * A `low` confidence hit asks first. It is the one case where the app is
   * openly unsure which date it read — bare `en` cannot tell `03/04` apart —
   * and a wrong date scheduled without a word is exactly the silent failure
   * this app exists to avoid.
   */
  const scheduleFromDate = async (hit: DateHit, leadMs: number) => {
    const message = openMessage
    if (!message) return
    const account = accountsById.get(message.accountId)
    const to = account?.fromAddress?.trim()
    if (!to) {
      toast.push({ tone: 'error', title: t('inboxcal.noAddress') })
      return
    }

    if (hit.confidence === 'low') {
      const ok = await confirm({
        title: t('inboxcal.confirmLowTitle', { when: whenLabel(hit) }),
        body: t('inboxcal.confirmLowBody', { evidence: hit.evidence.snippet }),
        confirmLabel: t('inboxcal.scheduleAnyway'),
        cancelLabel: t('common.cancel'),
      })
      if (!ok) return
    }

    const now = Date.now()
    const title = (hit.title ?? '').trim() || message.subject || t('inbox.noSubject')
    const evidence = hit.evidence.snippet.slice(0, EVIDENCE_LIMIT)
    const bodyText =
      t('inboxcal.mailBody', {
        title,
        when: whenLabel(hit),
        from: message.from,
        subject: message.subject || t('inbox.noSubject'),
        evidence,
      }) + (hit.location ? `\n${t('inboxcal.mailWhere', { where: hit.location })}\n` : '')

    const base: Omit<ScheduledJob, 'id' | 'chainId'> = {
      name: t('inboxcal.jobName', { title }),
      enabled: true,
      draft: {
        ...emptyDraft(message.accountId),
        // To yourself, at the address the message was received on: this is a
        // reminder, not a reply, and it must never go back to the sender.
        to: [to],
        subject: t('inboxcal.mailSubject', { title }),
        body: bodyText,
      },
      recurrence: {
        ...defaultRecurrence(now),
        kind: 'once',
        startAt: hit.at,
        // Unused by `once`, but a stale value here is the shape that bit the
        // compose screen's time box: kept honest rather than left over.
        timeOfDay: hhmm(hit.at - leadMs),
      },
      occurrences: [],
      runCount: 0,
      retry: DEFAULT_RETRY,
      status: 'armed',
      createdAt: now,
      updatedAt: now,
    }

    const [job] = buildChain(base, [leadMs], now)
    if (!job || job.recurrence.startAt <= now) {
      toast.push({ tone: 'error', title: t('chain.alreadyPast') })
      return
    }
    await scheduleDraft(job)
    setScheduledOffers((prev) => new Set(prev).add(offerKey(hit, leadMs)))
    // The time it will actually fire, not the one that was asked for: a lead
    // `buildChain` had to drop would otherwise be reported as if it had stuck.
    toast.push({
      tone: 'success',
      title: t('inboxcal.scheduled', { when: formatDateTime(job.recurrence.startAt) }),
      detail: title,
    })
  }

  const inboxImageSources = useMemo(
    () =>
      (openBody?.attachments ?? [])
        .filter((a) => a.path && isViewableImage(a.name))
        .map((a) => ({ id: a.id, name: a.name, path: a.path, size: a.size })),
    [openBody],
  )
  const inboxImages = useAttachmentImages(inboxImageSources)
  const inboxGallery = useMemo(
    () =>
      inboxImageSources
        .map((s) => {
          const bytes = inboxImages[s.path]
          return bytes ? { ...s, ...bytes } : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [inboxImageSources, inboxImages],
  )
  const inboxThumbs = useMemo(() => {
    const map: Record<string, string> = {}
    for (const img of inboxGallery) map[img.path] = img.dataUrl
    return map
  }, [inboxGallery])
  const lightboxAt = lightboxPath ? inboxGallery.findIndex((g) => g.path === lightboxPath) : -1

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
        {/* Batch tagging: the third thing anyone does to a handful of selected
            messages, after reading and deleting them. Cycling each row's tag
            one click at a time is how you end up not bothering. */}
        <Button variant="ghost" onClick={() => tagSet(selected, 'flagged')}>
          {t('inbox.tagFlagged')}
        </Button>
        <Button variant="ghost" onClick={() => tagSet(selected, 'none')}>
          {t('inbox.tagNone')}
        </Button>
        {/*
          Two deletes, because they are two different requests.

          "Remove" takes it out of Aevistle and leaves the mailbox alone; it is
          reversible from the bin. "Delete from mailbox" is the real thing and
          cannot be undone, so it is the one that stays red and asks a second
          question. Before this there was one button that said "delete" and did
          neither — it dropped the row, and the next sync five minutes later
          fetched the message straight back.
        */}
        <Button variant="ghost" icon={<IconTrash size={15} />} onClick={deleteSelected}>
          {t('inbox.removeHere')}
        </Button>
        <Button variant="danger" onClick={purgeSelected}>
          {t('inbox.deleteOnServer')}
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
            {/* Everything above the list stays put; only rows scroll.

                Written out here rather than passed to `Segmented`. The shared
                control is a plain button group used on nine other screens, and
                the two extra elements a reorderable tab needs — a drop target
                wrapping the button, and a grip inside it — are not something
                the timezone picker or the search-scope switch should have to
                carry. It borrows `Segmented`'s own class names, so the strip is
                the same control visually and stays that way if the control is
                restyled; only the markup underneath is one layer deeper. */}
            <div className="segmented" role="group" aria-label={t('inbox.title')}>
              {/*
                "All accounts" is not an account, so it is neither draggable nor
                a place another tab may land. It also stays pinned at the start
                — it is the reset, not a member of the arrangement.
              */}
              <button
                type="button"
                className="segmented__item"
                aria-pressed={filter === 'all'}
                onClick={() => setFilter('all')}
              >
                {t('inbox.allAccounts')}
              </button>
              {inboxOrder.map((id) => (
                <span key={id} className="segmented__slot" {...inboxReorder.itemProps(id)}>
                  {inboxOrder.length > 1 ? (
                    <button
                      type="button"
                      className="reorder-handle reorder-handle--tab"
                      aria-label={t('account.reorderHandle', { name: accountLabel(id) })}
                      title={t('account.reorderHint')}
                      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                      {...inboxReorder.handleProps(id)}
                    >
                      <IconGrip size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="segmented__item"
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                  >
                    {accountLabel(id)}
                  </button>
                </span>
              ))}
            </div>
            {/* Outside the strip, for the reason given on the twin of this in
                SettingsView: a live region that gets unmounted by the very
                reorder it is describing never gets to say anything. */}
            <span className="sr-only" role="status" aria-live="polite">
              {inboxReorder.announcement}
            </span>

            <div className="search-wrap" data-pending={searchPending || undefined}>
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder={t(`inbox.searchIn.${scope}` as 'inbox.searchIn.all')}
              />
              {/* Beside the box rather than inside it: a scope hidden in a
                  dropdown on the left of a search field is a scope people
                  leave on the wrong setting without noticing. */}
              <div className="search-scope" role="group" aria-label={t('inbox.searchScope')}>
                {(['all', 'from', 'subject', 'body'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip chip--toggle"
                    aria-pressed={scope === s}
                    onClick={() => setScope(s)}
                  >
                    {t(`inbox.scope.${s}` as 'inbox.scope.all')}
                  </button>
                ))}
              </div>
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
                <Button variant="danger" onClick={purgeAllMessages}>
                  {t('inbox.deleteAllOnServer')}
                </Button>
                {/* Only once there is something in it. A bin that is always
                    there and always empty is a control people stop seeing. */}
                {removedAll.length > 0 ? (
                  <Button variant="ghost" onClick={() => setShowBin((v) => !v)}>
                    {t('inbox.binToggle', { n: removedAll.length })}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {showBin && removedAll.length > 0 ? (
              <Card className="inbox-bin">
                <CardHeader
                  title={t('inbox.binTitle')}
                  hint={t('inbox.binHint', { days: BIN_DAYS })}
                  action={
                    <div className="btn-row">
                      <Button variant="ghost" onClick={restoreAllRemoved}>
                        {t('inbox.binRestoreAll')}
                      </Button>
                      <Button variant="ghost" onClick={emptyBin}>
                        {t('inbox.binEmpty')}
                      </Button>
                    </div>
                  }
                />
                <div className="card__body">
                  <div className="bin-list">
                    {removedAll.slice(0, 100).map(({ accountId, entry }) => (
                      <div className="bin-row" key={`${accountId} ${entry.message.folderPath} ${entry.message.uid}`}>
                        <div className="bin-row__text">
                          <div className="bin-row__subject">
                            {entry.message.subject || t('inbox.noSubject')}
                          </div>
                          <div className="bin-row__meta">
                            {entry.message.from} · {t('inbox.binRemovedAgo', { when: formatAgo(entry.at) })}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            restoreInboxMessages(accountId, [
                              `${entry.message.folderPath} ${entry.message.uid}`,
                            ])
                          }
                        >
                          {t('inbox.binRestore')}
                        </Button>
                      </div>
                    ))}
                  </div>
                  {removedAll.length > 100 ? (
                    <div className="field__hint">
                      {t('inbox.binMore', { n: removedAll.length - 100 })}
                    </div>
                  ) : null}
                </div>
              </Card>
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
              <SwipeableRow
                message={m}
                rtl={dir === 'rtl'}
                onRemove={() => void deleteInboxMessages(m.accountId, [m.id])}
                onToggleRead={() => markSet(new Set([m.id]), !m.seen)}
              >
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
              </SwipeableRow>
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
                {/*
                  One bar, four states, and never silent.

                  It is absent only when there is nothing to say — no remote
                  images, or every one of them arrived. A load in progress, a
                  load that failed, and a load that was never attempted because
                  the policy blocks it are three different things, and the
                  previous version of this could only express the last of them.
                */}
                {/* `blocked && autoLoad` is the frame between the body arriving
                    and the effect below it starting the fetch. Saying "loading"
                    there rather than briefly offering a button the policy has
                    already answered is the difference between a calm screen and
                    a flicker. */}
                {remoteImageCount > 0 &&
                (imageStage === 'loading' || (imageStage === 'blocked' && autoLoadImages)) ? (
                  <Banner
                    tone="info"
                    action={<span className="spinner" style={{ width: 16, height: 16 }} />}
                  >
                    {t('inbox.imagesLoading', { n: remoteImageCount })}
                  </Banner>
                ) : null}

                {remoteImageCount > 0 && imageStage === 'failed' ? (
                  <Banner
                    tone="danger"
                    action={
                      bridge?.fetchRemoteImage ? (
                        <Button variant="ghost" onClick={() => void loadRemoteImages({ retry: true })}>
                          {t('inbox.imagesRetry')}
                        </Button>
                      ) : undefined
                    }
                  >
                    {t('inbox.imagesFailed', { n: imageFailures })}
                  </Banner>
                ) : null}

                {remoteImageCount > 0 && imageStage === 'blocked' && !autoLoadImages ? (
                  <Banner
                    tone="warning"
                    action={
                      <div className="btn-row">
                        {openSender && openInbox ? (
                          <Button variant="ghost" onClick={allowSenderImages}>
                            {t('inbox.alwaysAllowSender', { domain: openSender })}
                          </Button>
                        ) : null}
                        <Button variant="ghost" onClick={() => void loadRemoteImages()}>
                          {t('inbox.loadImages', { n: remoteImageCount })}
                        </Button>
                      </div>
                    }
                  >
                    {t('inbox.remoteImagesBlocked')}
                  </Banner>
                ) : null}

                {/*
                  B4 — the moment this message is about, offered in the reader.

                  Above the body rather than in a dialog: an offer that
                  interrupts the message is an offer made before the reader has
                  seen what it refers to, and this one has to be checkable
                  against the text right below it. Nothing here has done
                  anything yet — pressing a lead time is what creates a
                  reminder, and that press is the only path to one.
                */}
                {dateHits.length > 0 ? (
                  <div className="reader__dates">
                    <div className="section-label">
                      <IconCalendar size={15} />
                      {t('inboxcal.title', { n: dateHits.length })}
                    </div>
                    {dateHits.map((hit, index) => (
                      <DateOffer
                        key={`${hit.at} ${hit.kind} ${index}`}
                        hit={hit}
                        when={whenLabel(hit)}
                        isScheduled={(leadMs) => scheduledOffers.has(offerKey(hit, leadMs))}
                        onSchedule={(leadMs) => void scheduleFromDate(hit, leadMs)}
                      />
                    ))}
                  </div>
                ) : null}

                <MessageBodyFrame
                  html={resolvedHtml ?? openBody.sanitizedHtml ?? textAsHtml(openBody.text ?? t('inbox.noBody'))}
                  find={findOpen ? deferredFind : ''}
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
                    {/* Every picture in the message, as pictures. The rows
                        below still list them as files — this is the answer to
                        "which one is which" without opening four of them. */}
                    <ImageStrip
                      images={inboxGallery}
                      onOpen={(i) => setLightboxPath(inboxGallery[i]?.path ?? null)}
                      label={t('image.attached')}
                      hint={t('image.openHint')}
                    />

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
                            {inboxThumbs[a.path] ? (
                              <span className="attachment__icon attachment__icon--thumb">
                                <img src={inboxThumbs[a.path]} alt="" draggable={false} />
                              </span>
                            ) : (
                            <span className="attachment__icon attachment__icon--tag">
                              {fetchingAttachment === a.id ? (
                                <span className="spinner" style={{ width: 14, height: 14 }} />
                              ) : (
                                (a.name.split('.').pop() ?? '?').slice(0, 4).toUpperCase()
                              )}
                            </span>
                            )}
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
          // PDFs and text render inertly in a sandboxed frame. No
          // `allow-scripts`, exactly as the message body frame below.
          // Images never reach here — they get the full-screen viewer.
          <PreviewFrame
            key={preview.attachment.id}
            src={preview.dataUrl}
            name={preview.attachment.name}
            onOpenExternally={
              bridge?.openPath && preview.attachment.path
                ? () => void bridge.openPath?.(preview.attachment.path!)
                : undefined
            }
          />
        ) : null}
      </Modal>

      {lightboxAt >= 0 ? (
        <ImageLightbox
          images={inboxGallery}
          index={lightboxAt}
          onIndex={(next) => setLightboxPath(inboxGallery[next]?.path ?? null)}
          onClose={() => setLightboxPath(null)}
        />
      ) : null}

      {confirmElement}
    </div>
  )
}

/**
 * One extracted moment, and the offer to be reminded about it.
 *
 * Modelled on `CodesView`'s card, deliberately: that screen learned that an
 * answer nobody can check is an answer nobody can correct. So the layout is
 * the same shape — the answer large and first, the chips that qualify it
 * beside it, and the verbatim source text underneath. The snippet is a
 * stranger's prose of arbitrary length and may contain a URL or a run of CJK
 * with no spaces in it, which is why the stylesheet clamps it and breaks it
 * `anywhere`.
 *
 * Confidence is expressed three ways, because one is not enough: the card's
 * border changes, a chip says so in words, and — the part that matters — a
 * `low` reading gets no primary button at all. Its lead times are all plain,
 * equally weighted controls, and `scheduleFromDate` asks a second question
 * before any of them creates anything. Nothing about a low hit is the path of
 * least resistance.
 */
function DateOffer({
  hit,
  when,
  isScheduled,
  onSchedule,
}: {
  hit: DateHit
  when: string
  isScheduled: (leadMs: number) => boolean
  onSchedule: (leadMs: number) => void
}) {
  const { t } = useI18n()
  const low = hit.confidence === 'low'

  const now = Date.now()
  /* A stage whose fire time has already gone is not offered. `buildChain`
     would drop it and fall back to the event itself, which is a reminder that
     arrives too late to be one. */
  const leads = CHAIN_STAGES.filter((stage) => hit.at - stage.leadMs > now)
  /* The single press. Absent for a `low` hit on purpose — see above. */
  const preferred = low
    ? undefined
    : LEAD_PREFERENCE.find((ms) => leads.some((stage) => stage.leadMs === ms))
  const others = leads.filter((stage) => stage.leadMs !== preferred)

  const leadLabel = (leadMs: number) => t(leadLabelKey(leadMs) as TranslationKey)

  return (
    <div className="datecard" data-confidence={hit.confidence} data-kind={hit.kind}>
      <div className="datecard__head">
        <span className="datecard__mark">
          <IconCalendar size={18} />
        </span>
        <div className="datecard__main">
          <div className="datecard__when">{when}</div>
          <div className="datecard__meta">
            <span className="chip chip--strong">{t(`inboxcal.kind.${hit.kind}` as TranslationKey)}</span>
            {hit.allDay ? <span className="chip chip--quiet">{t('inboxcal.allDay')}</span> : null}
            {low ? (
              <span className="chip chip--warning">{t('inboxcal.unsure')}</span>
            ) : hit.confidence === 'medium' ? (
              <span className="chip chip--quiet">{t('inboxcal.likely')}</span>
            ) : null}
            {hit.location ? (
              <span className="chip chip--quiet">{t('inboxcal.at', { where: hit.location })}</span>
            ) : null}
          </div>
          {hit.title ? <div className="datecard__title">{hit.title}</div> : null}
        </div>
      </div>

      {/* Here is my answer, and here is why. */}
      <div className="datecard__evidence">
        <span className="datecard__evidenceLabel">
          {hit.evidence.keyword
            ? t('inboxcal.evidenceFrom', { keyword: hit.evidence.keyword })
            : t('inboxcal.evidence')}
        </span>
        <span className="datecard__snippet">{hit.evidence.snippet}</span>
      </div>

      {low ? <div className="datecard__warn">{t('inboxcal.lowHint')}</div> : null}

      <div className="datecard__actions">
        {leads.length === 0 ? (
          <span className="datecard__note">{t('chain.alreadyPast')}</span>
        ) : (
          <>
            {preferred !== undefined ? (
              <Button
                variant="primary"
                icon={isScheduled(preferred) ? <IconCheck size={15} /> : <IconClock size={15} />}
                onClick={() => onSchedule(preferred)}
              >
                {t('inboxcal.remind', { lead: leadLabel(preferred) })}
              </Button>
            ) : null}
            {others.length > 0 ? (
              <div className="datecard__leads">
                <span className="datecard__leadsLabel">
                  {preferred === undefined ? t('inboxcal.remindWhen') : t('inboxcal.orLead')}
                </span>
                {others.map((stage) => (
                  <button
                    key={stage.leadMs}
                    type="button"
                    className="chip chip--toggle datecard__lead"
                    data-done={isScheduled(stage.leadMs) || undefined}
                    title={t('inboxcal.remind', { lead: leadLabel(stage.leadMs) })}
                    onClick={() => onSchedule(stage.leadMs)}
                  >
                    {isScheduled(stage.leadMs) ? <IconCheck size={13} /> : null}
                    {leadLabel(stage.leadMs)}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The attachment preview frame, with a visible failure.
 *
 * Every previous version of this rendered an `<iframe>` and hoped. When the
 * frame did not load — and for a while it never did, because `frame-src 'none'`
 * blocked it outright — the modal opened onto a white rectangle: no error, no
 * toast, nothing to click. The file was fine, the app was fine, and the user
 * had no way to tell that anything had gone wrong at all.
 *
 * So the frame now has to *prove* it loaded. `onLoad` fires for a successful
 * navigation; a frame that has not reported one within a short grace period is
 * treated as failed, and the modal says so and offers the system handler
 * instead. That covers the cases a `load` event alone does not — a blocked
 * navigation, a format Chromium declines to render, a plugin that is not there.
 *
 * The timeout is deliberately generous. A 20 MB PDF off a slow disk is not a
 * failure, and a preview that accuses itself of being broken while it is still
 * decoding would be its own kind of wrong.
 */
function PreviewFrame({
  src,
  name,
  onOpenExternally,
}: {
  src: string
  name: string
  onOpenExternally?: () => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')

  useEffect(() => {
    setState('loading')
    const timer = window.setTimeout(() => {
      setState((s) => (s === 'loading' ? 'failed' : s))
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [src])

  return (
    <div className="preview__wrap">
      <iframe
        className="preview__frame"
        sandbox=""
        src={src}
        title={name}
        data-state={state}
        onLoad={() => setState('ok')}
      />
      {state === 'failed' ? (
        <div className="preview__fallback">
          <Banner tone="warning" title={t('inbox.previewFailed')}>
            {onOpenExternally ? (
              <Button variant="secondary" icon={<IconExternal size={15} />} onClick={onOpenExternally}>
                {t('inbox.openExternally')}
              </Button>
            ) : null}
          </Banner>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One inbox row, swipeable on touch.
 *
 * The actions behind the row are the two anyone actually wants on a phone:
 * remove it, or flip whether it has been read. Deliberately *not* the
 * server-side delete — that one is irreversible, and putting it behind a
 * gesture that can be triggered by a misread scroll would be indefensible.
 *
 * The row slides over a fixed backdrop rather than the actions sliding in, so
 * what is being revealed is visible from the first few pixels of movement and
 * the gesture can be abandoned by anyone who did not mean it.
 */
function SwipeableRow({
  message,
  rtl,
  onRemove,
  onToggleRead,
  children,
}: {
  message: InboxMessage
  rtl: boolean
  onRemove: () => void
  onToggleRead: () => void
  children: React.ReactNode
}) {
  const { t } = useI18n()
  const { offset, handlers } = useSwipe({
    rtl,
    onSwipe: (direction) => (direction === 'trailing' ? onRemove() : onToggleRead()),
  })

  return (
    <div className="swipe" {...handlers}>
      <div className="swipe__behind" aria-hidden="true">
        <span className="swipe__action swipe__action--lead">
          {message.seen ? t('inbox.markUnread') : t('inbox.markRead')}
        </span>
        <span className="swipe__action swipe__action--trail">{t('inbox.removeHere')}</span>
      </div>
      <div
        className="swipe__front"
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
        data-sliding={offset !== 0 || undefined}
      >
        {children}
      </div>
    </div>
  )
}
