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

import { useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  IconButton,
  Modal,
  PaletteContext,
  useConfirm,
  useToast,
} from '../components/ui'
import {
  IconCalendar,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDownload,
  IconExternal,
  IconFlag,
  IconFolder,
  IconGrip,
  IconInbox,
  IconMaximize,
  IconMinimize,
  IconMoon,
  IconMore,
  IconPaperclip,
  IconRefresh,
  IconSearch,
  IconSun,
  IconTrash,
  IconX,
} from '../components/icons'
import { VirtualList } from '../components/VirtualList'
import { flattenByDay, type DayLabel } from '../core/mail/dayGroups'
import { useSwipe } from '../components/useSwipe'
import { useTwoPane } from '../components/useNarrow'
import { MessageBodyFrame, textAsHtml, type FrameImages } from '../components/MessageBodyFrame'
import { ReaderBodyFailure } from '../components/ReaderBodyFailure'
import { useApp } from '../state/AppState'
import { PULL_THRESHOLD_PX, resolvePull, type PullState } from '../core/platform/gestures'
import { pushBackHandler } from '../core/backStack'
import { SearchInput } from '../components/inputs'
import {
  ImageLightbox,
  ImageStrip,
  isViewableImage,
  seedAttachmentImage,
  useAttachmentImages,
} from '../components/ImageLightbox'
import { useI18n, type TranslationKey } from '../i18n'
import { accountGroupKey, orderedAccounts } from '../core/mail/accounts'
import { useReorder } from '../components/useReorder'
import {
  BROKEN_IMAGE,
  inlineCidsOf,
  normalizeCid,
  resolveInlineImages,
  resolveRemoteImages,
} from '../core/mail/remoteImagePlaceholder'
import { resolveWithCache } from '../core/mail/imageCache'
import { BLOCKED_IMAGE, blockReasonKey, type ImageBlockReason } from '../core/mail/imageProxy'
import { getCachedBody, putCachedBody } from '../core/mail/bodyMemo'
import { hasMath, renderMath } from '../core/mail/math'
import { CHAIN_STAGES, buildChain, leadLabelKey } from '../core/schedule/chain'
import { extractDates, type DateHit } from '../core/schedule/dateExtract'
import { copyText } from '../core/platform/clipboard'
import { haptic } from '../core/haptics'
import type { InboxMessageBody } from '../core/platform/bridge'
import {
  DEFAULT_RETRY,
  REMOVED_RETENTION_MS,
  defaultRecurrence,
  effectiveImagePolicy,
  emptyDraft,
  senderDomain,
  shouldAutoLoadImages,
  type Attachment,
  type CodeHit,
  type InboxMessage,
  type InboxTag,
  type ScheduledJob,
} from '../core/types'

type AccountFilter = 'all' | string

type SearchScope = 'all' | 'from' | 'subject' | 'body'

/**
 * The four ways fetching a message's remote pictures can end badly, as far
 * apart as this screen can actually tell them apart.
 *
 * `resolveWithCache` collapses every per-URL rejection into `null` (see
 * `core/mail/imageCache`), so the reason cannot come from *which* URL failed —
 * it comes from what was true at the call site. That is enough for the three
 * that matter: `noProxy` is a platform with no fetch path at all and no retry
 * worth offering, `offline` is this device, and `error` is the one that
 * carries the raw message with it.
 */
type ImageFailReason = 'noProxy' | 'offline' | 'fetch' | 'error'

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
 * How many inline (`cid:`) pictures one message may have read off disk, and
 * how many bytes of them.
 *
 * They are local files rather than fetches, so the risk is memory rather than
 * privacy: every one becomes a base64 `data:` URI in a string, which is a
 * third larger than the file. A signature and a couple of screenshots is the
 * real case; a message with two hundred embedded photographs is not, and the
 * ones past the cap keep the behaviour every `cid:` image had before this —
 * they stay invisible, which is a picture missing rather than a reader that
 * cannot open the mail at all.
 */
const MAX_INLINE_IMAGES = 24
const MAX_INLINE_BYTES = 12 * 1024 * 1024

/**
 * How far either scroller has to move before the reader's header shrinks.
 *
 * Non-zero on purpose: a touch scroller reports fractional offsets while a
 * finger is still resting on it, and a 0px threshold made the bar flicker
 * between its two heights without anybody having scrolled anything.
 */
const READER_COMPACT_AT = 12

/** The list filters, all off — a stable identity so "reset" cannot re-render. */
const NO_CHIPS = { unread: false, attachment: false, code: false, sender: null } as const
type ChipFilters = { unread: boolean; attachment: boolean; code: boolean; sender: string | null }

/** Inline pictures, none read yet — stable for the same reason `NO_CHIPS` is. */
const NO_INLINE: { images: Record<string, string>; settled: boolean } = { images: {}, settled: false }

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

/**
 * Splits a raw `From` header into a display name and an address.
 *
 * Mirrors `senderDomain`'s `<...>` extraction in `core/types.ts` rather than
 * importing it, because that one throws the name half away and this needs
 * both halves. A bare address with no angle brackets (no display name at
 * all) comes back with `name: ''` — callers must not invent one.
 */
function splitSender(from: string): { name: string; address: string } {
  const angled = /<([^>]*)>/.exec(from)
  if (!angled) return { name: '', address: from.trim() }
  return {
    name: from.slice(0, angled.index).trim().replace(/^["']|["']$/g, ''),
    address: angled[1].trim(),
  }
}

/** First letter for the sender avatar: the name's, or the address's local part. */
function senderInitial(name: string, address: string): string {
  const source = name || address.split('@')[0] || address
  return source.slice(0, 1).toUpperCase()
}

/**
 * How many recipients one line of the reader's details prints before folding.
 *
 * A class list, a team announcement or a supplier's mailshot puts sixty
 * addresses in `To`, and this block sits directly under the reader's *sticky*
 * header — an unfolded sixty would push the message itself off a phone screen
 * and stay there while you scrolled. Three is the number because it is above
 * the case the fold would be an annoyance for: a mail to you and two
 * colleagues shows all three and never offers a control at all.
 */
const RECIPIENT_PREVIEW = 3

/**
 * The sentence that goes with each way an image load can end badly.
 *
 * Typed `TranslationKey` rather than `string` so a reason added to the union
 * without a matching line in `en.ts` fails the build instead of rendering its
 * own key on screen — the same contract `CodesView.purposeKey` holds.
 */
function imageFailKey(reason: ImageFailReason): TranslationKey {
  switch (reason) {
    case 'noProxy':
      return 'inbox.imagesFailNoProxy'
    case 'offline':
      return 'inbox.imagesFailOffline'
    case 'error':
      return 'inbox.imagesFailError'
    default:
      return 'inbox.imagesFailFetch'
  }
}

/**
 * Every `To` recipient, or the one-line `to` when this message predates the
 * field.
 *
 * `toAll` arrived with the recipient list; every message already in the local
 * store was written before it existed and has only `to`. Falling back keeps
 * those readable instead of showing them an empty recipient line, which would
 * look exactly like a bug in the new feature. An empty array — not `['']` —
 * when there is nothing at all, so the caller's `length` test means what it
 * says.
 */
function toRecipients(message: InboxMessage): string[] {
  if (message.toAll?.length) return message.toAll
  return message.to ? [message.to] : []
}

/**
 * What a row should call the sender.
 *
 * The list used to print the raw `From` header, so a row began
 * `招商银行 <no-reply@bank…` and the ellipsis fell inside the address — the
 * half of the string nobody reads — while the four characters that identify
 * the sender competed with it for a 150px column. `splitSender` already knows
 * how to take the header apart; this is the "and never invent one" half of its
 * contract written down: a header with no display name falls back to the local
 * part of the address, and only then to the address itself, because
 * `no-reply@bank.example.com` truncated at 12 characters is `no-reply@ban…`
 * and says less than `no-reply`.
 */
function senderLabel(from: string): string {
  const { name, address } = splitSender(from)
  if (name) return name
  return address.split('@')[0] || address || from
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
  /**
   * 600-839px: the list and the message it opens, side by side.
   *
   * The same hook Settings reads, for the same band — see `useNarrow.ts`. It
   * changes exactly one thing here: which box the reader is mounted in
   * (`ReaderShell` at the bottom of this file). Nothing about the reader
   * itself is conditional on it, because a second reader is a second set of
   * image-policy rules waiting to disagree with the first.
   */
  const twoPane = useTwoPane()
  /**
   * The command palette, reached from the overflow menu rather than from a
   * second magnifying glass beside the first.
   *
   * `PageHead` puts a palette button on every phone screen, and this screen now
   * has a search icon of its own that searches *mail* — which is what a
   * magnifying glass on a mailbox means. Two of them side by side, one for the
   * list and one for the app, is a coin toss on every tap. So this view does not
   * render `PageHead` at all, and the palette keeps its door as a named menu
   * item instead of an ambiguous icon.
   */
  const openPalette = useContext(PaletteContext)

  const [filter, setFilter] = useState<AccountFilter>('all')
  const [query, setQuery] = useState('')
  /** Which field the search box looks in. */
  const [scope, setScope] = useState<SearchScope>('all')
  /**
   * The search field is a mode, not furniture.
   *
   * A permanently mounted box plus four scope chips was 104px of a 687px
   * screen — a seventh of the mailbox — spent on a control that is used for
   * seconds at a time. It opens from the icon in the title bar and takes the
   * chips with it.
   */
  const [searchOpen, setSearchOpen] = useState(false)
  /**
   * 编辑 — the mode the bulk actions live in.
   *
   * They used to sit on the resting screen, which is how "全部从邮箱删除" (the
   * one irreversible action in this app) ended up one stray tap away from a
   * list somebody was only scrolling. Entered deliberately from the overflow
   * menu, or by a long press on a row, and left by "Done".
   */
  const [editMode, setEditMode] = useState(false)
  /** The title bar's overflow menu — same anchored-popover rules as the reader's. */
  const [menuOpen, setMenuOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openMessage, setOpenMessage] = useState<InboxMessage | null>(null)
  const [openBody, setOpenBody] = useState<InboxMessageBody | null>(null)
  const [loadingBody, setLoadingBody] = useState(false)
  /**
   * Why the body is not on screen, when it is not.
   *
   * A toast is a moment; this is a state. See `loadBody` for the whole story —
   * the short version is that the reader used to render nothing at all when a
   * body failed to arrive, and a blank panel is indistinguishable from an
   * empty message.
   */
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  /**
   * The whole body, rebuilt with its pictures spliced in — the *fallback*, not
   * the normal path any more.
   *
   * Setting this changes `MessageBodyFrame`'s `html`, which changes its
   * `srcDoc`, which reloads the frame and re-parses the sender's markup from
   * scratch. That used to happen every time a message's images finished
   * loading. It now happens only when the frame reports that it could not
   * place them into the document it already has (`onImagesUnplaced`), and the
   * fallback is silent: it produces exactly the same picture, one reload
   * later, so there is nothing for the reader to be told about.
   */
  const [resolvedHtml, setResolvedHtml] = useState<string | null>(null)
  /** Fetched remote images, by placeholder index — handed to the frame as-is. */
  const [resolvedImages, setResolvedImages] = useState<Array<string | null> | null>(null)
  /** This message's own inline (`cid:`) parts, once read off disk. */
  const [inlineState, setInlineState] = useState(NO_INLINE)
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
  /**
   * How many distinct pictures arrived and were refused by the scanner, and on
   * what grounds.
   *
   * Kept apart from `imageFailures` throughout, because they are different
   * facts with different answers: a failure is worth a "try again" button, and
   * a refusal is not — the bytes already arrived and re-running the scanner
   * over identical bytes produces an identical refusal at the cost of another
   * request to the sender.
   */
  const [imageBlocked, setImageBlocked] = useState(0)
  const [imageBlockReasons, setImageBlockReasons] = useState<ImageBlockReason[]>([])
  /** How many of this message's pictures looked like they were measuring the reader. */
  const [trackerCount, setTrackerCount] = useState(0)
  /** True when every picture came off disk — i.e. opening this message hit no network. */
  const [imagesFromCache, setImagesFromCache] = useState(false)
  /** Is the "why was this blocked" detail open? */
  const [blockDetailOpen, setBlockDetailOpen] = useState(false)
  /**
   * *Why* the last attempt failed, in the four shapes that are distinguishable
   * from here — reset in `openDetail`.
   *
   * "N images could not be loaded" was the whole message, which is a count of
   * a problem rather than a description of one, and it read identically whether
   * this platform has no image proxy at all (Android, where the button can
   * never work and retrying is pointless), the device is offline, the sender's
   * server refused, or the fetch layer threw. Those need four different next
   * actions from the reader, so they get four different sentences.
   */
  const [imageFailReason, setImageFailReason] = useState<ImageFailReason | null>(null)
  /** The raw error, when there was one — shown verbatim under the sentence. */
  const [imageFailDetail, setImageFailDetail] = useState('')
  /** Reading starts full-screen; Escape steps out before it closes. */
  const [immersive, setImmersive] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  /** The phone header's overflow menu — see the max-width:760px rule in
      app.css that hides this behind a single "more" icon instead of the
      day/night, find and fullscreen buttons it collapses. */
  const [moreOpen, setMoreOpen] = useState(false)
  /** Per-message escape hatch from the night filter below — reset in `openDetail`. */
  const [rawStyle, setRawStyle] = useState(false)
  /** Recipient + precise timestamp, folded away by default — reset in `openDetail`. */
  const [metaExpanded, setMetaExpanded] = useState(false)
  /** …and, inside that, the full recipient list rather than the first three. */
  const [recipientsExpanded, setRecipientsExpanded] = useState(false)
  /*
   * Two scrollers, two booleans, one bar.
   *
   * A long message scrolls *inside* the body frame — the frame itself is a
   * fixed box in the reader's column — while banners, date offers and the
   * attachment list scroll the reader's own column around it. Either one
   * means "reading", and one boolean fed by both would be cleared by whichever
   * of them happened to be at the top.
   */
  const [outerScrolled, setOuterScrolled] = useState(false)
  const [bodyScrolled, setBodyScrolled] = useState(false)
  const readerBarRef = useRef<HTMLDivElement>(null)
  /**
   * Whether the date offers have been looked for yet — see `dateHits`.
   *
   * False on the render that first has a body, which is the whole of item 12:
   * the extraction is six languages of matchers over the entire message and it
   * used to run synchronously on exactly that render, so the body could not
   * paint until it had finished.
   */
  const [datesReady, setDatesReady] = useState(false)
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

  /**
   * `themeMode` is the *setting*; `'system'` still needs the OS asked
   * directly, the same test `theme.css`'s own `@media` block runs. Read once
   * per render rather than watched live — the reader has to be reopened to
   * pick up a mid-session OS theme flip, which is the same staleness every
   * other `system`-mode read in this file already accepts.
   */
  const readerIsDark =
    state.settings.themeMode === 'dark' ||
    (state.settings.themeMode !== 'light' &&
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)

  /**
   * Whether a message *opens* repainted, and whether this one is showing that
   * way right now.
   *
   * Three inputs, and they are three separate questions that were previously
   * two. The theme decides whether there is anything to repaint at all — in a
   * light app a sender's white page is simply the page. `readerDarkInvert` is
   * the standing preference (default on, `DEFAULT_SETTINGS`); somebody who has
   * decided they would rather see mail as sent turns it off once and never
   * thinks about it again. `rawStyle` is this message only, reset in
   * `openDetail`, and it means "the other thing" rather than "off" — which is
   * what makes one control correct in both directions: with the setting on it
   * is the escape hatch for a layout inversion ruins, and with the setting off
   * it is the way to read one glaring white newsletter at night without
   * changing the preference to do it.
   */
  const invertByDefault = readerIsDark && state.settings.readerDarkInvert !== false
  const nightOn = rawStyle ? !invertByDefault : invertByDefault

  /**
   * Everything that moves the palette the body frame has to be *told* about.
   *
   * The frame is a separate document, so none of the app's tokens reach it by
   * cascade — `MessageBodyFrame` reads them out of this document and writes
   * the resolved values in, and it needs to know when to read them again.
   * Four settings can move them, and `readerIsDark` is here as well because
   * `themeMode: 'system'` can be dark or light without any setting changing.
   */
  const readerThemeKey = [
    state.settings.themeMode,
    state.settings.visualStyle,
    state.settings.accent,
    state.settings.textScale ?? 'standard',
    readerIsDark ? 'dark' : 'light',
  ].join('|')

  /**
   * The verification code a row can show, by message id.
   *
   * Nothing here extracts anything. `CodeCheckProvider` already reads the body
   * of every message from the last day, runs `core/ops/codeExtract` over it and
   * files the result in `state.codeHits` — a second detector in this file would
   * be a second set of answers to the same question, and the one in that file
   * is where the `98052` postcode bug and its eight fixes live. This is a
   * lookup, and it costs one pass over an array that is already in memory.
   *
   * `confidence === 'high'` only, and that is the whole of the risk control.
   * The Codes screen can afford to show a `medium` guess because it shows the
   * *reasons* beside it and offers the runners-up in one press; a list row has
   * room for six digits and nothing else, so a wrong number here would be a
   * wrong number with no way to see that it was wrong. `CodeCheck.announce`
   * draws the same line for the same reason — a notification has no room to
   * explain itself either.
   *
   * Links are excluded outright: a URL does not fit, and a one-tap control
   * that opens a sign-in link from a list is exactly the reflex this app's
   * link-confirmation dialog exists to interrupt.
   */
  const codeByMessage = useMemo(() => {
    const out = new Map<string, CodeHit>()
    for (const hit of state.codeHits) {
      if (hit.kind !== 'code' || hit.confidence !== 'high') continue
      const already = out.get(hit.messageId)
      if (!already || hit.foundAt > already.foundAt) out.set(hit.messageId, hit)
    }
    return out
  }, [state.codeHits])

  /**
   * Copy from the row — the same three steps the Codes screen takes, in the
   * same order, and deliberately not a fourth path to the clipboard.
   *
   * `copyText` rather than `navigator.clipboard.writeText`: the bare web call
   * is refused inside an Android WebView, which is where this button is most
   * likely to be pressed. The read mark is set first and outside the result
   * check, because a code read off the screen and typed by hand has still been
   * dealt with. A toast on success rather than the Codes screen's inline tick:
   * a 61px row has nowhere to put a tick, and a copy that says nothing is
   * indistinguishable from a tap that missed.
   */
  const copyRowCode = useCallback(
    async (hit: CodeHit) => {
      dispatch({ type: 'markCodeRead', id: hit.id })
      if (await copyText(hit.value)) {
        dispatch({ type: 'markCodeCopied', id: hit.id })
        toast.push({ tone: 'success', title: t('inbox.rowCodeCopied', { code: hit.value }) })
        haptic('copy', state.settings.haptics)
      } else {
        toast.push({ tone: 'error', title: t('inbox.copyFailed') })
        haptic('fail', state.settings.haptics)
      }
    },
    [dispatch, t, toast, state.settings.haptics],
  )

  const accountsById = useMemo(() => new Map(state.accounts.map((a) => [a.id, a])), [state.accounts])
  const enabledInboxes = useMemo(() => state.inboxAccounts.filter((i) => i.enabled), [state.inboxAccounts])
  /**
   * Whether this platform can receive mail at all.
   *
   * `|| true /*TEMP-VERIFY*\/` was left on the end of this line, which made it
   * unconditionally true and had two consequences, both silent. The browser
   * preview — whose bridge has no `syncInbox` at all (see `bridge-web.ts`) —
   * drew the full Inbox screen, its sync button, its account filter and its
   * bulk actions, none of which could ever do anything. And the `unavailable`
   * empty state below became unreachable code: the one thing on the screen
   * that would have said why.
   *
   * Two separate questions, though, and collapsing them into one is what made
   * the override look necessary in the first place:
   *
   *   `canSyncInbox` — can this platform *fetch*? Only the sync control cares.
   *   `canUseInbox`  — is there anything here worth drawing? Mail already in
   *                    the store is real mail, and hiding it because this
   *                    platform cannot fetch *more* would be its own silent
   *                    failure — the messages exist, the screen would say the
   *                    feature is unavailable, and both statements would be
   *                    true of different things.
   */
  const canSyncInbox = Boolean(bridge?.syncInbox)
  const canUseInbox = canSyncInbox || enabledInboxes.length > 0

  const allMessages = useMemo(() => enabledInboxes.flatMap((i) => i.messages), [enabledInboxes])

  /* The "showing the most recent 50 of N" banner and the `inboxServerTotal`
     memo that fed it were removed on request (2026-08-12). A sync now lists
     the whole folder up to `INBOX_LIST_FETCH_CEILING` (src/core/types.ts) —
     high enough that an everyday mailbox never hits it — so the gap the
     banner used to report is no longer the everyday case either; a permanent
     band above the list restating it on every visit was not worth the row it
     cost even before that. */

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
  /**
   * The quick filters over the list — item 20.
   *
   * Four questions people actually ask a mailbox ("what is new", "where is
   * that file", "what was the code", "what has this sender sent me"), each of
   * which was previously a scroll. They compose with AND, and with the search
   * box and the account tabs, because a filter that silently replaced another
   * one is a filter you cannot trust.
   */
  const [chips, setChips] = useState<ChipFilters>(NO_CHIPS)
  const chipsActive = chips.unread || chips.attachment || chips.code || chips.sender !== null
  const clearChips = useCallback(() => setChips(NO_CHIPS), [])

  const accountMessages = useMemo(
    () => (filter === 'all' ? allMessages : allMessages.filter((m) => m.accountId === filter)),
    [allMessages, filter],
  )
  /** Unread *here* — the account the tabs have selected, not every mailbox. */
  const unreadHere = useMemo(
    () => accountMessages.reduce((n, m) => (m.seen ? n : n + 1), 0),
    [accountMessages],
  )
  /**
   * Whether the filters are worth offering at all.
   *
   * Under six messages there is nothing to narrow — the whole mailbox is on
   * one screen — and a row of controls that cannot change what you are looking
   * at is the kind of chrome the last two rounds of this screen were spent
   * removing. `chipsActive` keeps it on regardless, or a filter could not be
   * turned off once it had shortened the list past the threshold.
   */
  const showChips = chipsActive || accountMessages.length >= 6

  /**
   * The one sender worth offering a chip for: whoever has sent the most of
   * what is currently on screen.
   *
   * "A specific sender" needs a specific sender, and asking for one costs a
   * picker, a text field or a long press — three things this screen has spent
   * two rounds removing. The mailbox already knows the answer: in a real inbox
   * one address (a bank, a service, a mailing list) is a large fraction of the
   * rows, and it is exactly the one somebody wants to isolate or skip past.
   *
   * Two or more, or it is not a filter, it is a message. Keyed on the *label*
   * rather than the address so the chip can be read at a glance, and matched
   * back the same way, so two addresses behind one display name group together
   * the same way the rows do.
   */
  const topSender = useMemo(() => {
    if (accountMessages.length < 6) return null
    const counts = new Map<string, number>()
    for (const m of accountMessages) {
      const label = senderLabel(m.from)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 1
    for (const [label, n] of counts) {
      if (n > bestCount) {
        best = label
        bestCount = n
      }
    }
    return best === null ? null : { label: best, count: bestCount }
  }, [accountMessages])

  const filteredMessages = useMemo(() => {
    let list = accountMessages
    if (chips.unread) list = list.filter((m) => !m.seen)
    if (chips.attachment) list = list.filter((m) => m.hasAttachments)
    // The same lookup the row's copy button uses, and deliberately not a
    // second detector: `CodeCheckProvider` is where a verification code is
    // decided, and this only asks whether it decided one for this message.
    if (chips.code) list = list.filter((m) => codeByMessage.has(m.id))
    if (chips.sender !== null) {
      const wanted = chips.sender
      list = list.filter((m) => senderLabel(m.from) === wanted)
    }
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
  }, [accountMessages, chips, codeByMessage, deferredQuery, scope])
  const searchPending = deferredQuery !== query

  /**
   * The list with a "Today" / "Yesterday" / weekday bar in front of each run.
   *
   * Forty rows of `09:42, 09:31, 09:07` say nothing about which of them are
   * from this morning and which are from a Tuesday three weeks ago, and the
   * timestamp column cannot say it without repeating the date on every row.
   *
   * Safe to hand straight to `VirtualList`: it measures real row heights from
   * the DOM rather than assuming a uniform pitch, so a separator being half a
   * message tall costs nothing but one measuring pass. See `core/mail/dayGroups.ts`
   * for why the day boundary is computed from local midnight and not from
   * dividing the epoch.
   *
   * `filteredMessages` is always sorted newest-first, so every run is
   * contiguous and this never produces two groups for one day.
   */
  const dayRows = useMemo(
    () => flattenByDay(filteredMessages, (m) => m.date, Date.now()),
    [filteredMessages],
  )

  /**
   * A separator's text, in the reading language.
   *
   * "Today" and "Yesterday" are words and are translated; a weekday and a date
   * are formatted by `Intl` against the same locale the rest of the screen
   * uses, because a hand-written weekday table is six more lists to keep in
   * step and `Intl` already has them.
   */
  const dayLabelText = useCallback(
    (label: DayLabel): string => {
      if (label.kind === 'today') return t('inbox.day.today')
      if (label.kind === 'yesterday') return t('inbox.day.yesterday')
      if (label.kind === 'weekday') return formatDateTime(label.at, { weekday: 'long' })
      return formatDateTime(label.at, { dateStyle: 'medium' })
    },
    [t, formatDateTime],
  )

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

  const canCheckNow = canSyncInbox && enabledInboxes.length > 0

  // --- pull to refresh -------------------------------------------------------
  //
  // `resolvePull` has been sitting in `core/platform/gestures.ts`, tested by
  // `check-gestures.mjs`, with no caller — the arithmetic for the gesture was
  // written and never wired to anything. This is the wiring.
  //
  // Two rules, both of them the reason this is not just "drag = refresh":
  //
  //  · **Only from a genuine top.** The scroller's live `scrollTop` is passed
  //    to `resolvePull` on every move rather than sampled once at the start,
  //    because a pull that fires halfway down a mailbox is the single most
  //    annoying version of this gesture.
  //  · **It is never the only way.** "Check now" is a named item in the
  //    overflow menu, which is where it went when the button left the toolbar.
  //    A gesture nobody can find is a regression.
  //
  // Mouse pointers are excluded for the same reason `useSwipe` excludes them: a
  // desktop window has the menu item and a wheel that must keep scrolling.
  const listWrapRef = useRef<HTMLDivElement>(null)
  const pullFrom = useRef<{ y: number; id: number } | null>(null)
  /** Mirrors `pull.armed` for the pointer-up handler, which closes over stale state. */
  const pullArmed = useRef(false)
  const [pull, setPull] = useState<PullState>({ progress: 0, armed: false })
  /**
   * Whether the list has been scrolled off its top — the signal the filter
   * chips get out of the way on.
   *
   * Subscribed from the wrapper rather than passed to `VirtualList`, which
   * owns the scroller and already has a scroll listener of its own for
   * windowing; a second `onScroll` prop on that component would be a shared
   * list primitive learning about one screen's chrome.
   */
  const [listScrolled, setListScrolled] = useState(false)

  const pullScroller = () => listWrapRef.current?.querySelector<HTMLElement>('.list-pane') ?? null

  useEffect(() => {
    const scroller = listWrapRef.current?.querySelector<HTMLElement>('.list-pane')
    if (!scroller) return
    const onScroll = () => setListScrolled(scroller.scrollTop > READER_COMPACT_AT)
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
    // `filteredMessages.length` rather than the array: the pane is unmounted
    // and replaced by the empty state when the list runs out, so the element
    // this is attached to is not the same one it was.
  }, [filteredMessages.length === 0])

  const onPullStart = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' || !canCheckNow) return
    const scroller = pullScroller()
    if (!scroller || scroller.scrollTop > 0) return
    pullFrom.current = { y: e.clientY, id: e.pointerId }
  }
  const onPullMove = (e: React.PointerEvent) => {
    const start = pullFrom.current
    if (!start || start.id !== e.pointerId) return
    const next = resolvePull(e.clientY - start.y, pullScroller()?.scrollTop ?? 0)
    pullArmed.current = next.armed
    setPull((prev) => (prev.progress === next.progress && prev.armed === next.armed ? prev : next))
  }
  const onPullEnd = () => {
    if (!pullFrom.current) return
    pullFrom.current = null
    const fire = pullArmed.current
    pullArmed.current = false
    setPull({ progress: 0, armed: false })
    if (fire) void syncAll()
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

  /**
   * Every unread message in every enabled account, in one press.
   *
   * The count is read *before* the await and reported afterwards: by the time
   * the marks have landed the messages are no longer unread, so counting then
   * would always say nothing happened. It goes in the toast's detail rather
   * than replacing the existing title, which six locales already translate.
   *
   * `markSet` groups by account and sends one call per account, not one per
   * message — a mailbox with 300 unread is three hundred rows changed by two
   * requests. That grouping is the reason this stays a single `await`.
   */
  const markAllRead = async () => {
    const unread = allMessages.filter((m) => !m.seen)
    if (unread.length === 0) return
    await markSet(new Set(unread.map((m) => m.id)), true)
    toast.push({
      tone: 'success',
      title: t('inbox.markAllReadDone'),
      detail: t('inbox.markAllReadCount', { n: unread.length }),
    })
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

  // --- who else got this message ---
  //
  // "QQ 邮箱 shows me everyone it went to and this does not" was the complaint,
  // and it was accurate: the reader printed `openMessage.to`, which is the
  // *first* recipient and has been since the field was a one-line summary.
  // `toAll` and `cc` are the honest version (see `core/types.ts`), and every
  // message fetched before they existed still has neither — hence the fallback
  // in `toRecipients` rather than a bare `openMessage.toAll ?? []`.
  //
  // Bcc is deliberately absent and always will be. A blind copy is stripped by
  // the sending server before delivery, so it is not in the message this app
  // received and no mail client on earth can show it. The note under the list
  // says that rather than leaving a gap people read as a missing feature.

  const openToAll = useMemo(
    () => (openMessage ? toRecipients(openMessage) : []),
    [openMessage],
  )
  const openCc = openMessage?.cc ?? []
  const recipientTotal = openToAll.length + openCc.length
  /** True only when folding actually hides something on at least one line. */
  const recipientsFoldable =
    openToAll.length > RECIPIENT_PREVIEW || openCc.length > RECIPIENT_PREVIEW
  const shownTo =
    recipientsExpanded || openToAll.length <= RECIPIENT_PREVIEW
      ? openToAll
      : openToAll.slice(0, RECIPIENT_PREVIEW)
  const shownCc =
    recipientsExpanded || openCc.length <= RECIPIENT_PREVIEW
      ? openCc
      : openCc.slice(0, RECIPIENT_PREVIEW)

  /**
   * The whole list on the clipboard, folded or not.
   *
   * This is what the request was actually for: the addresses are wanted in a
   * reply, a spreadsheet or another compose window, and reading sixty of them
   * off a screen is not a way to get them there. Comma-and-space is the
   * separator every recipient field in every mail client parses, including this
   * app's own — see `RecipientPicker` — so what lands can be pasted straight
   * back in.
   *
   * `To` and `Cc` are joined into one list rather than copied separately: the
   * distinction is about how the mail was sent, and a person collecting
   * addresses to write to wants all of them.
   */
  const copyRecipients = async () => {
    const all = [...openToAll, ...openCc]
    if (all.length === 0) return
    if (await copyText(all.join(', '))) {
      toast.push({ tone: 'success', title: t('inbox.recipientsCopied', { n: all.length }) })
      haptic('copy', state.settings.haptics)
    } else {
      toast.push({ tone: 'error', title: t('inbox.copyFailed') })
      haptic('fail', state.settings.haptics)
    }
  }

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
  const openSenderSplit = openMessage ? splitSender(openMessage.from) : { name: '', address: '' }
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

  /**
   * Which body load is the current one — the same problem `imageRun` solves,
   * one level up. Without this, clicking message A then quickly message B
   * (cached, so it renders instantly) left A's slower in-flight fetch to land
   * afterwards and overwrite B's correctly-shown body with A's, header and
   * content silently pointing at two different messages. The cached branch
   * also used to skip `setLoadingBody(false)` entirely, so a spinner from A's
   * still-pending fetch could sit over B's already-rendered content.
   */
  const bodyRun = useRef(0)

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
        setImageFailReason('noProxy')
        setImageFailDetail('')
        setImageStage('failed')
        return
      }
      setImageStage('loading')
      setImageFailures(0)
      setImageFailReason(null)
      setImageFailDetail('')
      setImageBlocked(0)
      setImageBlockReasons([])
      setTrackerCount(0)
      try {
        // Cached by URL, deduplicated, and persisted in the main process —
        // see `core/imageCache` and `electron/remoteImage.ts`. On a synced
        // message this normally resolves entirely from disk without touching
        // the network: the proxy fetched these when the message *arrived*.
        const verdicts = await resolveWithCache(urls, (url) => bridge.fetchRemoteImage!(url), {
          retryFailures: options?.retry,
        })
        if (run !== imageRun.current) return

        /*
         * One verdict becomes one of three things on screen.
         *
         *   ok       the picture
         *   blocked  a grey block — the bytes arrived and the scanner refused
         *            them, which is a different fact from "did not arrive" and
         *            the reader asked to be able to tell them apart
         *   failed   `null`, which `BROKEN_IMAGE` fills in below
         *
         * `BLOCKED_IMAGE` is a base64 data URI precisely so it can travel this
         * ordinary path and satisfy the same `safeImageDataUri` gate every
         * other resolved picture passes.
         */
        const resolved = verdicts.map((v) =>
          v.status === 'ok' ? v.dataUri : v.status === 'blocked' ? BLOCKED_IMAGE : null,
        )

        // Counted over unique URLs, like the failure count: one tracking pixel
        // repeated twelve times in one newsletter is one tracker, not twelve.
        const seenUrl = new Set<string>()
        let blocked = 0
        let trackers = 0
        const reasons = new Set<ImageBlockReason>()
        // The first failed verdict's own detail — "HTTP 403", "Timed out",
        // "Refusing to connect to a private address (…)" — beats the generic
        // "fetch" bucket below, which used to be the only thing a `failed`
        // status ever showed even though the proxy had already worked out
        // exactly what went wrong. Kept to one line: a wall of per-image
        // reasons for a newsletter with forty broken images is worse than a
        // representative first one.
        let firstFailedDetail: string | undefined
        urls.forEach((url, i) => {
          if (seenUrl.has(url)) return
          seenUrl.add(url)
          const v = verdicts[i]
          if (!v) return
          if (v.status === 'blocked') {
            blocked++
            if (v.reason) reasons.add(v.reason)
          }
          if (v.status === 'failed' && firstFailedDetail === undefined && v.detail) {
            firstFailedDetail = v.detail
          }
          if (v.tracker) trackers++
        })
        setImageBlocked(blocked)
        setImageBlockReasons([...reasons])
        setTrackerCount(trackers)
        // "Everything came from cache" is what proves the prefetch worked, and
        // it is the sentence the privacy banner is allowed to say — see
        // `inbox.imagesPrefetched`. One live fetch is enough to withdraw it.
        setImagesFromCache(verdicts.length > 0 && verdicts.every((v) => v.fromCache))

        const failed = new Set(urls.filter((_, i) => verdicts[i]?.status === 'failed')).size
        // Only now is `BROKEN_IMAGE` right: every URL has been tried, so a
        // null really is a failure rather than a fetch still in flight.
        //
        // Handed to the frame rather than spliced into the HTML — see
        // `resolvedHtml` above for what that splice cost. `html` is still read
        // at the top of this function because it is what proves there is a
        // body to put pictures into at all.
        setResolvedImages(resolved)
        setImageFailures(failed)
        // `navigator.onLine` is a weak signal in general — it says the machine
        // has *a* network, not that it can reach the internet — but it is
        // decisive in the direction it is used here: false means every one of
        // those fetches was doomed before it left, and "you are offline" is a
        // far more useful sentence than "the sender's server refused".
        if (failed > 0) {
          setImageFailReason(navigator.onLine === false ? 'offline' : 'fetch')
          if (firstFailedDetail) setImageFailDetail(firstFailedDetail)
        }
        setImageStage(failed > 0 ? 'failed' : 'done')
      } catch (e) {
        if (run !== imageRun.current) return
        setImageFailures(urls.length)
        setImageFailReason('error')
        // Verbatim, like the body-load failure toast above: an error nobody can
        // quote is an error nobody can report.
        setImageFailDetail(e instanceof Error ? e.message : String(e))
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

  // --- inline (`cid:`) images -----------------------------------------------
  //
  // A signature image, a pasted screenshot, the logo at the top of a receipt:
  // parts of the message itself, referenced by `cid:`. Both sanitizers used to
  // drop them outright — the `<img>` survived with no `src` at all, so the
  // picture simply never appeared and nothing said why.
  //
  // They are *not* remote content and none of the remote-image machinery
  // applies: no network, no policy question, no banner, no permission to ask
  // for. The bytes are a file this app already wrote beside the message when
  // it parsed it, and reading one is the same call the attachment preview
  // makes. See `electron/sanitizeHtml.ts` for why that is not a hole in the
  // rule that blocks remote pictures.

  /** Which inline parts this body actually asks for. Reading the rest is waste. */
  const inlineCids = useMemo(
    () => inlineCidsOf(openBody?.sanitizedHtml ?? ''),
    [openBody?.sanitizedHtml],
  )
  /** The same "which load is current" counter `imageRun` is, for this path. */
  const inlineRun = useRef(0)

  useEffect(() => {
    const run = ++inlineRun.current
    setInlineState(NO_INLINE)
    if (inlineCids.length === 0) return
    const read = bridge?.readAttachment
    const byCid = new Map<string, Attachment>()
    for (const a of openBody?.attachments ?? []) {
      // No `path` means the bytes are not on this device yet — an Android
      // inbox attachment before its first tap. Fetching one to satisfy a
      // picture nobody asked for would spend somebody's mobile data on
      // decoration, which is the same trade `withBytes` already refuses to
      // make on their behalf. Those references stay unresolved, which is
      // exactly what every `cid:` image did before this existed.
      if (!a.cid || !a.path) continue
      byCid.set(normalizeCid(a.cid), a)
    }
    if (!read || byCid.size === 0) {
      // Settled with nothing found: the frame drops the leftover `src`, so an
      // unresolvable reference goes back to being invisible rather than a
      // blank placeholder pixel sitting in the layout.
      setInlineState({ images: {}, settled: true })
      return
    }
    void (async () => {
      const images: Record<string, string> = {}
      let bytes = 0
      for (const cid of inlineCids.slice(0, MAX_INLINE_IMAGES)) {
        const a = byCid.get(cid)
        if (!a || bytes + a.size > MAX_INLINE_BYTES) continue
        try {
          const result = await read(a.path)
          if (run !== inlineRun.current) return
          if (result && result.mime.startsWith('image/')) {
            images[cid] = result.dataUrl
            bytes += a.size
          }
        } catch {
          // An unreadable part is an unresolved reference, not an error worth
          // a toast: the picture is missing, the message is not.
        }
      }
      if (run !== inlineRun.current) return
      setInlineState({ images, settled: true })
    })()
  }, [inlineCids, openBody?.attachments, bridge])

  /**
   * Everything the frame still has to place, as one stable object.
   *
   * Memoised because it is a dependency of an effect that walks the frame's
   * document: a fresh object per render would re-walk the whole body on every
   * keystroke in the find box.
   */
  const frameImages = useMemo<FrameImages | undefined>(() => {
    if (!resolvedImages && !inlineState.settled) return undefined
    return {
      remote: resolvedImages ?? undefined,
      remoteFallback: BROKEN_IMAGE,
      inline: inlineState.images,
      inlineSettled: inlineState.settled,
    }
  }, [resolvedImages, inlineState])

  /**
   * The fallback: rebuild the whole body with the pictures spliced in.
   *
   * Reached only from `MessageBodyFrame`'s `onImagesUnplaced`, i.e. when the
   * in-place swap found nothing to swap. Silent by design — it is a slower
   * route to the identical result, not a failure — and idempotent, because the
   * rebuilt string is what the frame then reloads with and the frame will
   * report "unplaced" again the moment it does (there are no placeholders left
   * in it). `setResolvedHtml` with an equal string is a no-op in React, so
   * that second report ends the loop rather than starting one.
   */
  const rebuildImages = useCallback(() => {
    const base = openBody?.sanitizedHtml
    if (!base) return
    let next = base
    if (resolvedImages) next = resolveRemoteImages(next, resolvedImages, BROKEN_IMAGE)
    const inline = new Map(Object.entries(inlineState.images))
    if (inline.size > 0) next = resolveInlineImages(next, inline)
    if (next === base) return
    setResolvedHtml(next)
  }, [openBody?.sanitizedHtml, resolvedImages, inlineState])

  /**
   * The body with its TeX turned into mathematics.
   *
   * Layered on top of everything else the body goes through rather than folded
   * into it, and last: images resolve into `resolvedHtml` first, and running
   * before that would have every image rebuild throw this work away and redo
   * it. `null` means "nothing to add" — no maths in this message, the setting
   * is off, or KaTeX failed to load — and the frame falls back to the string it
   * would have shown anyway.
   *
   * Asynchronous because the library is only fetched when a message actually
   * contains a delimiter (see `core/mail/math.ts`), so the reader paints the
   * message immediately and the formulas replace their own source a moment
   * later. `stale` guards the case that matters: opening a second message
   * before the first one's render resolves must not paste the first message's
   * body over the second.
   */
  const mathSource = resolvedHtml ?? openBody?.sanitizedHtml ?? ''
  const mathOn = state.settings.renderMath !== false
  const [mathHtml, setMathHtml] = useState<string | null>(null)
  useEffect(() => {
    if (!mathOn || !mathSource || !hasMath(mathSource)) {
      setMathHtml(null)
      return
    }
    let stale = false
    void renderMath(mathSource)
      .then((html) => {
        if (!stale) setMathHtml(html === mathSource ? null : html)
      })
      .catch(() => {
        if (!stale) setMathHtml(null)
      })
    return () => {
      stale = true
    }
  }, [mathSource, mathOn])

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

  /**
   * Fetch the open message's body, and make failure a state rather than a
   * moment.
   *
   * ## What this was, and why it was the worst kind of bug
   *
   * The fetch lived inline at the bottom of `openDetail`, and its `catch`
   * raised a toast and nothing else. `openBody` stayed `null`, and the
   * reader's body region was written `loadingBody ? skeleton : openBody ? body
   * : null` — so the third state drew *nothing at all*.
   *
   * Four seconds later the toast was gone, and what was left was a message
   * with a subject, a sender, a date and an empty white panel underneath, with
   * no error, no explanation and no way to try again. Nothing was thrown,
   * nothing was logged, and every automated check in this repository passed:
   * the screen rendered, it was the right size, its contrast was fine, its
   * buttons all worked. It is exactly 运行正常，不报错，但是内容为空.
   *
   * And it hits every platform for its own reason — no stored IMAP password,
   * a server that will not answer, a message deleted from the mailbox since
   * the last sync, or the browser sandbox, which has no `getMessageBody` at
   * all and therefore *always* lands here.
   *
   * ## The rule now
   *
   * The body region is never empty. Loading draws a skeleton, a body draws the
   * body, and everything else draws `ReaderBodyFailure` — the reason, in the
   * engine's own words, and a button that tries again. `bodyError` is what
   * makes the failure outlive the toast.
   *
   * `run` is passed in rather than taken here so `openDetail` can claim the
   * run number *before* its dozen synchronous resets, keeping the guarantee
   * its own comment makes. A retry has no resets to do and passes nothing, so
   * it claims one itself.
   */
  const loadBody = useCallback(
    async (m: InboxMessage, priorRun?: number, opts?: { skipCache?: boolean }) => {
      const run = priorRun ?? ++bodyRun.current
      setBodyError(null)
      /* A retry ignores the memo. The cache holds bodies that arrived, so a
         hit here means the previous attempt succeeded and there is nothing to
         retry — but a caller pressing 重试 is telling us the copy on screen is
         not the one they want, and silently handing back the same one would
         look like the button does nothing. */
      const cached = opts?.skipCache ? null : getCachedBody(m.id)
      if (cached) {
        setOpenBody(cached)
        setLoadingBody(false)
        return
      }
      setOpenBody(null)
      setLoadingBody(true)
      try {
        const body = await getInboxMessageBody(m)
        if (run !== bodyRun.current) return
        putCachedBody(m.id, body)
        setOpenBody(body)
      } catch (e) {
        if (run !== bodyRun.current) return
        const detail = e instanceof Error ? e.message : String(e)
        /* Both, and they are not redundant. The toast is what tells someone
           looking at the *list* that the message they just tapped failed; the
           panel is what is still there a minute later when they wonder why the
           message is blank. Only one of them used to exist. */
        setBodyError(detail)
        toast.push({ tone: 'error', title: t('inbox.loadFailed'), detail })
      } finally {
        if (run === bodyRun.current) setLoadingBody(false)
      }
    },
    [getInboxMessageBody, t, toast],
  )

  const openDetail = useCallback(
    async (m: InboxMessage) => {
      setOpenMessage(m)
      setResolvedHtml(null)
      setResolvedImages(null)
      setInlineState(NO_INLINE)
      setImageStage('blocked')
      setImageFailures(0)
      setImageFailReason(null)
      setImageFailDetail('')
      // Every proxy verdict is about the message being closed, not the one
      // being opened. A count left standing would report the last newsletter's
      // trackers against this reply.
      setImageBlocked(0)
      setImageBlockReasons([])
      setTrackerCount(0)
      setImagesFromCache(false)
      setBlockDetailOpen(false)
      setRawStyle(false)
      // The date offers are looked for again from scratch, after this
      // message's body has painted — see `datesReady`.
      setDatesReady(false)
      // A new message starts at the top of both scrollers, so the reader's
      // header starts at its full height again.
      setOuterScrolled(false)
      setBodyScrolled(false)
      // Retires any image load still in flight for the message being left. It
      // has to happen here and not only when the next load starts: a message
      // with no pictures never starts one, and the previous message's result
      // would arrive to find nothing had superseded it.
      imageRun.current += 1
      inlineRun.current += 1
      const run = ++bodyRun.current
      setPreview(null)
      setLightboxPath(null)
      setFindOpen(false)
      setFindText('')
      setImmersive(true)
      setMetaExpanded(false)
      // Folded again for the next message: "show all 60" is an answer to the
      // message it was pressed on, not a preference about every mail after it.
      setRecipientsExpanded(false)
      if (!m.seen) void markInboxMessagesRead(m.accountId, [m.id], true)

      // No `run !== bodyRun.current` guard needed here: everything above this
      // point since `run` was assigned is synchronous, so `bodyRun.current`
      // cannot have moved on yet — and `loadBody` takes it from here, having
      // been handed the run it must finish under.
      await loadBody(m, run)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadBody, markInboxMessagesRead],
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

  /** The list's own overflow menu, closed by the same two events as the
      reader's below — Escape, or a pointer that lands outside the anchor. */
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown') {
        const target = e.target as HTMLElement | null
        if (target?.closest('.inboxmenu')) return
      }
      setMenuOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
    }
  }, [menuOpen])

  /** The phone header's overflow menu closes on Escape and on a click that
      lands anywhere outside it — the same rule the compose screen's quick-
      times popover (`whenbar__quick`) uses for the same kind of anchored
      panel. */
  useEffect(() => {
    if (!moreOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown') {
        const target = e.target as HTMLElement | null
        if (target?.closest('.reader__more')) return
      }
      setMoreOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
    }
  }, [moreOpen])

  /**
   * Escape has three jobs here, in order: close the overflow menu, leave full
   * screen, then close.
   *
   * A single-stage Escape on a full-screen reader throws the whole message
   * away when the user only wanted the window back — and there is no undo for
   * "I lost my place". The overflow menu goes first because it is the most
   * recently opened, most transient layer — the same reason `preview` (the
   * image lightbox) still comes before it here.
   */
  const handleEscape = () => {
    if (preview) setPreview(null)
    else if (moreOpen) setMoreOpen(false)
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
    // Item 12, and the only line of it that is in this memo.
    //
    // Everything below this point is unchanged and still runs exactly once per
    // message; what changed is *which render* it runs on. It used to be the
    // render that first had a body, so `bodyAsText`'s eleven passes over the
    // whole HTML string and `extractDates`' six languages of matchers were
    // both between the message arriving and any of it reaching the screen —
    // on the main thread, ahead of the frame's own parse. `datesReady` is
    // flipped from an idle callback after that paint, so the body is on screen
    // first and the offers arrive into a reader somebody is already reading.
    if (!datesReady) return []
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
  }, [datesReady, openMessageId, openSubject, openReceivedAt, openText, openHtml, openIcsParts])

  /**
   * Look for the dates once the body is on screen, and not before.
   *
   * `requestIdleCallback` rather than a timeout, with a timeout as the
   * fallback: idle is exactly the right priority for work nobody is waiting
   * for, and its 600ms cap is what stops "idle" meaning "never" on a busy
   * main thread. Either way this lands after the paint that put the message
   * up, which is the point.
   *
   * The result is *not* rendered above the body — see the note beside
   * `.reader__dates` in the reader. An offer strip that appears above a
   * message a moment after it paints pushes the first paragraph down under
   * the reader's eye, and the whole purpose of this change was to get that
   * paragraph on screen sooner.
   */
  useEffect(() => {
    if (datesReady) return
    if (!openMessage || !openBody) return
    const idle = (window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }).requestIdleCallback
    const run = () => setDatesReady(true)
    if (idle) {
      const handle = idle(run, { timeout: 600 })
      return () => (window as typeof window & { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback?.(handle)
    }
    const handle = window.setTimeout(run, 0)
    return () => window.clearTimeout(handle)
  }, [datesReady, openMessage, openBody])

  /**
   * The reader's own column, for the sticky header — item 19.
   *
   * Found from the bar rather than passed down: the element belongs to
   * `Modal` in the dialog case and to `ReaderShell` in the two-pane one, and
   * threading a ref out of both would make two components know about a third
   * one's header. `closest` asks the DOM the question the CSS already
   * answers — sticky positions against the nearest scrolling ancestor, and
   * this listens to the same one.
   */
  useEffect(() => {
    if (!openMessage) return
    const scroller = readerBarRef.current?.closest<HTMLElement>('.modal__body, .detailpane__body')
    if (!scroller) return
    const onScroll = () => setOuterScrolled(scroller.scrollTop > READER_COMPACT_AT)
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [openMessage])

  const onBodyScroll = useCallback((top: number) => {
    setBodyScrolled(top > READER_COMPACT_AT)
  }, [])

  /** Either scroller has moved, so the reader's header stands down to 34px. */
  const readerCompact = outerScrolled || bodyScrolled

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
      // `data-screen` on this branch too. Without it a probe that navigated here
      // could not tell it had arrived, and this is the branch a machine with no
      // mail bridge — every automated run — actually lands on.
      <div className="view view--list" data-screen="inbox">
        <div className="view__inner">
          {/* No heading here either: the highlighted Inbox tab already names
              the screen, and this branch has no action to keep a head for. */}
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

  const multiAccount = inboxOrder.length > 1
  /** Checkboxes are on while a selection is live *or* while 编辑 is open. */
  const selecting = editMode || selected.size > 0
  const readTotal = allMessages.length - unreadTotal

  /**
   * The one line of status this screen still says out loud.
   *
   * It replaces a whole band: "Checked 5 minutes ago" used to be a note beside
   * a button, and the unread count — the single number anyone opens a mailbox
   * to see — was not on the screen anywhere at all.
   */
  const headStatus =
    syncingIds.size > 0
      ? t('inbox.checking')
      : [
          unreadTotal > 0 ? t('inboxbar.unread', { n: unreadTotal }) : t('inboxbar.allRead'),
          // The string the toolbar's own note used, kept rather than replaced:
          // it says the same thing, it is already translated six times, and a
          // second spelling of one sentence is how two screens end up
          // disagreeing about what "checked" means.
          lastSyncAt ? t('inbox.lastChecked', { when: formatAgo(lastSyncAt) }) : t('inboxbar.neverSynced'),
        ].join(' · ')

  const leaveEdit = () => {
    setEditMode(false)
    clearSelection()
  }

  const attachments = openBody?.attachments ?? []

  return (
    /* `data-screen` is how `scripts/layout-probe.mjs` knows which screen it
       landed on, and it stays exactly where it was. `view--twopane` is the
       only thing the band adds to the frame: it turns this box into a row of
       two columns and hands each of them its own scroller. */
    <div className={`view view--list${twoPane ? ' view--twopane' : ''}`} data-screen="inbox">
      <div className={`view__inner${twoPane ? ' twopane__list' : ''}`}>
        {/*
          One band, where there were five.

          Measured at 360x800 before this: check-status + "Check now" (68px),
          the account strip (56px), the search box and its four scope chips
          (104px) and the auto-check row (52px) came to 281px of a 687px screen
          — 41% of the mailbox spent on controls, leaving a 369px list that
          held five messages. Every one of those four bands was permanent, and
          three of them were for things nobody does while reading mail.

          So: a title, a count, a search icon and an overflow. Everything else
          is behind one of those two icons or behind a gesture that has a named
          twin in the menu. `PageHead` is deliberately not used — see
          `openPalette` above for why this screen cannot carry its search
          button.
        */}
        <div className="inboxbar">
          <div className="inboxbar__text">
            {/*
              Present for a screen reader, gone from the eye — `.sr-only`, the
              same treatment `PageHead`'s `hideTitle` gives every other screen.

              The name of the screen you are on is already said by the
              highlighted tab you tapped to get here, so printing it again in
              the top-left corner spends a line of a phone's screen restating
              what the user just did. What that line is actually for is the
              status underneath it — unread count and last check — which is the
              thing this band exists to show and which moves up into the space.

              The heading element itself stays rather than becoming a `div`:
              it is the document's `h1`, and a screen without one is a screen
              a screen reader cannot summarise.
            */}
            <h1 className="inboxbar__title sr-only">{t('inbox.title')}</h1>
            <p className="inboxbar__status" aria-live="polite">
              {headStatus}
            </p>
          </div>
          <div className="inboxbar__actions">
            {/*
              一键已读 — the whole of "mark everything read", one press, on the
              resting screen.

              It used to live inside 编辑 mode, which meant: open the overflow,
              press 编辑, find it among six bulk actions, press it, press 完成.
              Four presses for the thing people do every morning. That copy is
              still there — the mode is where the *rest* of the bulk actions
              live and it would be odd without it — but it is no longer the
              only way in.

              Only while `unreadTotal > 0`. A button that is permanently there
              and permanently disabled is a control people stop seeing, and this
              one has a natural moment to leave: the press that empties the
              count also removes the button, which is its own confirmation.

              `IconButton`, not a labelled `Button`: `.icon-btn` is a fixed
              44px square on a touch shell (16-mail.css), so a third one costs
              44px of the 328px this band has at 360px and the two icons that
              were already here still leave the title its width. A labelled
              `.btn` would cost an estimated 130-160px depending on the
              language — that is an estimate from the string lengths, not a
              measurement — and the title has nothing like that to give.

              So the count is not on its face. It is not lost either:
              `.inboxbar__status`, the line directly under the title, already
              reads "12 unread · checked 5 minutes ago", and the number is in
              this button's own accessible name for a screen reader or a
              hovering pointer.

              `IconCheckCircle` rather than `IconCheck`, which in this same bar
              already means 编辑 (see the overflow menu below) — two controls a
              thumb apart wearing one glyph is how the wrong one gets pressed.
            */}
            {unreadTotal > 0 ? (
              <IconButton
                label={t('inbox.markAllReadNow', { n: unreadTotal })}
                onClick={() => void markAllRead()}
              >
                <IconCheckCircle size={16} />
              </IconButton>
            ) : null}
            <IconButton
              label={searchOpen ? t('inboxbar.searchClose') : t('inboxbar.search')}
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((v) => {
                  // Closing it clears the query too. A hidden filter still
                  // filtering is how a mailbox appears to have lost mail.
                  if (v) setQuery('')
                  return !v
                })
              }}
            >
              {searchOpen ? <IconX size={16} /> : <IconSearch size={16} />}
            </IconButton>
            <div className="inboxmenu">
              <IconButton
                label={t('inboxbar.menu')}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <IconMore size={16} />
              </IconButton>
              {menuOpen ? (
                <div className="popover inboxmenu__panel" role="menu" aria-label={t('inboxbar.menu')}>
                  {/* The visible twin of the pull. The gesture is the fast
                      path; this is the one anybody finds without being told. */}
                  <button
                    type="button"
                    role="menuitem"
                    className="inboxmenu__item"
                    disabled={!canCheckNow || syncingIds.size > 0}
                    onClick={() => {
                      setMenuOpen(false)
                      void syncAll()
                    }}
                  >
                    <IconRefresh size={16} />
                    <span>{syncingIds.size > 0 ? t('inbox.checking') : t('inbox.checkNow')}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="inboxmenu__item"
                    onClick={() => {
                      setMenuOpen(false)
                      setEditMode(true)
                    }}
                  >
                    <IconCheck size={16} />
                    <span>{t('inboxbar.edit')}</span>
                  </button>
                  {/* Only once there is something in it. A bin that is always
                      there and always empty is a control people stop seeing.
                      It lives here rather than on the list so that emptying the
                      list cannot take the way back into it with it — that bug
                      is what the note on the old controls row was about. */}
                  {removedAll.length > 0 ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="inboxmenu__item"
                      onClick={() => {
                        setMenuOpen(false)
                        setShowBin((v) => !v)
                      }}
                    >
                      <IconTrash size={16} />
                      <span>{t('inbox.binToggle', { n: removedAll.length })}</span>
                    </button>
                  ) : null}
                  {openPalette ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="inboxmenu__item"
                      onClick={() => {
                        setMenuOpen(false)
                        openPalette()
                      }}
                    >
                      <IconSearch size={16} />
                      <span>{t('palette.title')}</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {enabledInboxes.length === 0 ? (
          <Banner tone="info">{t('inbox.noAccountsHint')}</Banner>
        ) : (
          <>
            {/*
              The account strip, only when there is more than one account to
              choose between. With one mailbox it was a permanent 56px row
              offering "All accounts" and the same account twice — and at 360px
              the account's own tab was ellipsed to 工…, which is a truncation
              of a word that was already redundant.

              Written out here rather than passed to `Segmented`: the shared
              control is a plain button group used on nine other screens, and
              the two extra elements a reorderable tab needs — a drop target
              wrapping the button, and a grip inside it — are not something the
              timezone picker should have to carry. It borrows `Segmented`'s
              class names, so it is the same control visually.
            */}
            {multiAccount ? (
              <>
                <div className="segmented" role="group" aria-label={t('inbox.title')}>
                  {/*
                    "All accounts" is not an account, so it is neither draggable
                    nor a place another tab may land. It also stays pinned at the
                    start — it is the reset, not a member of the arrangement.
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
                      <button
                        type="button"
                        className="reorder-handle reorder-handle--tab"
                        aria-label={t('account.reorderHandle', { name: accountLabel(id) })}
                        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                        {...inboxReorder.handleProps(id)}
                      >
                        <IconGrip size={13} />
                      </button>
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
              </>
            ) : null}

            {/* The search field and the four scopes it can look in, on one
                row and only while searching. The scopes stayed *beside* the
                box rather than moving into a dropdown for the reason they
                were put there originally: a scope hidden behind a control is
                a scope people leave on the wrong setting without noticing.
                They scroll sideways when they do not fit, which they do at
                360px, rather than taking a second row. */}
            {searchOpen ? (
              /* `search-wrap` too, so `13-panels.css`'s "still catching up"
                 signal on the magnifier keeps working — the input is never
                 late, only the filtered list is, and that has to be visible. */
              <div className="search-wrap inboxsearch" data-pending={searchPending || undefined}>
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={t(`inbox.searchIn.${scope}` as 'inbox.searchIn.all')}
                />
                <div className="inboxsearch__scope" role="group" aria-label={t('inbox.searchScope')}>
                  {(['all', 'from', 'subject', 'body'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chip chip--toggle"
                      aria-pressed={scope === s}
                      onClick={() => setScope(s)}
                    >
                      {/* Every chip's text stays wrapped: `text-overflow` does
                          not apply to the anonymous text of a flex container,
                          so a bare-text chip is cut with no ellipsis at all. */}
                      <span className="chip__text">{t(`inbox.scope.${s}` as 'inbox.scope.all')}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/*
              编辑 — every bulk action, in a mode you have to ask for.

              Gated on `editMode` and on nothing else. It must *not* also
              require `filteredMessages.length > 0`: doing that once made
              emptying the list destroy the way back into it — select all,
              "Remove from Aevistle", and the whole row stopped rendering, so
              the recycle bin became unreachable until a sync happened to bring
              a different message back. The buttons inside need something to
              act on, so they are disabled rather than removed, which also
              means the row never changes shape under a thumb.
            */}
            {editMode ? (
              <div className="inboxedit">
                <div className="inboxedit__head">
                  <span className="inboxedit__count">
                    {selected.size > 0
                      ? t('inbox.selectedCount', { n: selected.size })
                      : t('inboxbar.editHint')}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={filteredMessages.length === 0}
                    onClick={selectAllVisible}
                  >
                    {t('inbox.selectAll')}
                  </Button>
                  {selected.size > 0 ? (
                    <Button variant="ghost" onClick={clearSelection}>
                      {t('inbox.clearSelection')}
                    </Button>
                  ) : null}
                  <Button variant="primary" onClick={leaveEdit}>
                    {t('common.done')}
                  </Button>
                </div>
                <div className="inboxedit__row">
                  {selected.size > 0 ? (
                    <>
                      <Button variant="ghost" onClick={() => markSet(selected, true)}>
                        {t('inbox.markRead')}
                      </Button>
                      <Button variant="ghost" onClick={() => markSet(selected, false)}>
                        {t('inbox.markUnread')}
                      </Button>
                      {/* Batch tagging: the third thing anyone does to a handful
                          of selected messages, after reading and deleting them. */}
                      <Button variant="ghost" onClick={() => tagSet(selected, 'flagged')}>
                        {t('inbox.tagFlagged')}
                      </Button>
                      <Button variant="ghost" onClick={() => tagSet(selected, 'none')}>
                        {t('inbox.tagNone')}
                      </Button>
                      {/*
                        Two deletes, because they are two different requests.

                        "Remove" takes it out of Aevistle and leaves the mailbox
                        alone; it is reversible from the bin. "Delete from
                        mailbox" is the real thing and cannot be taken back, so
                        it is the one that stays red and asks a second question.
                        Before this there was one button that said "delete" and
                        did neither — it dropped the row, and the next sync five
                        minutes later fetched the message straight back.
                      */}
                      <Button variant="ghost" icon={<IconTrash size={15} />} onClick={deleteSelected}>
                        {t('inbox.removeHere')}
                      </Button>
                      <Button variant="danger" onClick={purgeSelected}>
                        {t('inbox.deleteOnServer')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        icon={<IconCheck size={15} />}
                        disabled={unreadTotal === 0}
                        onClick={markAllRead}
                      >
                        {t('inbox.markAllRead')}
                      </Button>
                      <Button variant="ghost" disabled={readTotal === 0} onClick={deleteAllRead}>
                        {t('inbox.deleteAllRead')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={allMessages.length === 0}
                        onClick={deleteAllMessages}
                      >
                        {t('inbox.deleteAll')}
                      </Button>
                      {/* The one action here that reaches outside this app and
                          cannot be undone. It is reachable only from inside a
                          mode that was deliberately entered — it must never sit
                          on the resting list screen again. */}
                      <Button
                        variant="danger"
                        disabled={allMessages.length === 0}
                        onClick={purgeAllMessages}
                      >
                        {t('inbox.deleteAllOnServer')}
                      </Button>
                    </>
                  )}
                </div>
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
                      <Button variant="ghost" onClick={() => setShowBin(false)}>
                        {t('common.close')}
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
                            {senderLabel(entry.message.from)} ·{' '}
                            {t('inbox.binRemovedAgo', { when: formatAgo(entry.at) })}
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
            {/* No hint line. With no account the banner above already says the
                same sentence and the button below it is the answer; with an
                account, "new mail shows up after the next check" is a
                description of a mailbox. */}
            <EmptyState
              icon={<IconInbox size={24} />}
              title={
                chipsActive
                  ? t('inboxchips.none')
                  : enabledInboxes.length === 0
                    ? t('inbox.noAccountsEmpty')
                    : t('inbox.empty')
              }
              action={
                /* A filter that has emptied the list has to offer the way back
                   out of itself. The chip row is hidden while the pane is
                   scrolled, and an empty pane cannot be scrolled — but the
                   mailbox still looks empty, and "my mail is gone" is the one
                   conclusion this screen must never invite. */
                chipsActive ? (
                  <Button variant="secondary" onClick={clearChips}>
                    {t('inboxchips.clear')}
                  </Button>
                ) : enabledInboxes.length === 0 && onGoToAccounts ? (
                  <Button variant="primary" onClick={onGoToAccounts}>
                    {t('compose.addAccount')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          /* The pull lives on the wrapper rather than on the scroller itself
             because `VirtualList` owns that element; pointer events bubble, and
             the scroller's live `scrollTop` is read out of it by query on every
             move. See `onPullStart` for the two rules this gesture obeys. */
          <div
            className="pullwrap"
            ref={listWrapRef}
            /* Both read by `24-inbox.css`, which is where the whole of the
               chip row's "cannot cost the list a row" arithmetic is written
               down. `data-chips` reserves the strip inside the scroller's own
               padding — which `clientHeight` includes, so the pane's capacity
               is untouched — and the other two are what the strip gets out of
               the way for. */
            data-chips={showChips ? 'true' : undefined}
            data-chips-away={(listScrolled && !chipsActive) || pull.progress > 0 ? 'true' : undefined}
            onPointerDown={onPullStart}
            onPointerMove={onPullMove}
            onPointerUp={onPullEnd}
            onPointerCancel={onPullEnd}
          >
            {/*
              Quick filters — item 20.

              Absolutely positioned over the strip of scroller padding
              `data-chips` reserves, rather than laid out as a band above the
              list. That is not a trick to get past `layout-probe.mjs`'s 9-row
              floor, it is the only arrangement that genuinely leaves the floor
              alone: a band above the pane takes height *out* of the pane
              (`clientHeight` falls, so does the number of rows that fit), and
              padding *inside* the scroller does not (`clientHeight` includes
              padding). The strip scrolls out of the way like a list header
              instead of permanently costing a message.

              It hides on scroll — unless a filter is on, in which case it
              stays, because a filter you cannot see is a mailbox that has
              silently lost mail.
            */}
            {showChips ? (
              <div className="inboxchips" role="group" aria-label={t('inboxchips.label')}>
                <button
                  type="button"
                  className="chip chip--toggle inboxchips__chip"
                  aria-pressed={chips.unread}
                  onClick={() => setChips((c) => ({ ...c, unread: !c.unread }))}
                >
                  <span className="chip__text">{t('inboxchips.unread', { n: unreadHere })}</span>
                </button>
                <button
                  type="button"
                  className="chip chip--toggle inboxchips__chip"
                  aria-pressed={chips.attachment}
                  onClick={() => setChips((c) => ({ ...c, attachment: !c.attachment }))}
                >
                  <IconPaperclip size={13} />
                  <span className="chip__text">{t('inboxchips.attachment')}</span>
                </button>
                <button
                  type="button"
                  className="chip chip--toggle inboxchips__chip"
                  aria-pressed={chips.code}
                  onClick={() => setChips((c) => ({ ...c, code: !c.code }))}
                >
                  <span className="chip__text">{t('inboxchips.code')}</span>
                </button>
                {topSender ? (
                  <button
                    type="button"
                    className="chip chip--toggle inboxchips__chip"
                    aria-pressed={chips.sender !== null}
                    onClick={() =>
                      setChips((c) => ({
                        ...c,
                        sender: c.sender === null ? topSender.label : null,
                      }))
                    }
                  >
                    <span className="chip__text">
                      {t('inboxchips.sender', { name: topSender.label, n: topSender.count })}
                    </span>
                  </button>
                ) : null}
                {chipsActive ? (
                  <button
                    type="button"
                    className="chip inboxchips__chip inboxchips__clear"
                    onClick={clearChips}
                  >
                    <IconX size={13} />
                    <span className="chip__text">{t('inboxchips.clear')}</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            <div
              className="pull"
              style={{ height: Math.round(pull.progress * PULL_THRESHOLD_PX) }}
              data-armed={pull.armed || undefined}
              aria-hidden={pull.progress === 0 || undefined}
            >
              {pull.armed ? t('inboxbar.pullRelease') : t('inboxbar.pull')}
            </div>
            <VirtualList
              items={dayRows}
              /*
               * A separator's key is its local midnight, prefixed so it can
               * never collide with a message id. `VirtualList` caches measured
               * heights under this key, and a separator is roughly half a
               * message row tall — a shared key would mean each caching the
               * other's height and the scrollbar never settling.
               */
              keyOf={(row) => (row.type === 'separator' ? `day:${row.key}` : row.item.id)}
              /* Measured, not guessed. At 360x800 with forty messages seeded,
                 every row is 65.9px — the same whatever the subject length,
                 which is what the one-line clamp buys — and `.joblist` adds a
                 4px gap that `VirtualList` counts as part of the row: 69.9px
                 of pitch. With an account chip on the sender line (two or more
                 mailboxes) it is 71.0px. 70 sits between the two.

                 The 84 this replaces was the *desktop* row's number, cited as
                 such in its own comment, on the screen the list is actually
                 scrolled on. */
              estimate={70}
              scrollerClassName="list-pane"
              rowsClassName="joblist"
            >
              {(row) => {
                if (row.type === 'separator') {
                  return (
                    <div className="daysep" role="presentation">
                      <span className="daysep__label">{dayLabelText(row.label)}</span>
                      <span className="daysep__count">{row.count}</span>
                    </div>
                  )
                }
                const m = row.item
                /* Looked up once per row, not per element inside it — see
                   `codeByMessage`. `undefined` on the overwhelming majority of
                   rows, which is the case this must cost nothing on. */
                const rowCode = codeByMessage.get(m.id)
                return (
                <SwipeableRow
                  message={m}
                  rtl={dir === 'rtl'}
                  onRemove={() => void deleteInboxMessages(m.accountId, [m.id])}
                  onToggleRead={() => markSet(new Set([m.id]), !m.seen)}
                  onLongPress={() => {
                    setEditMode(true)
                    toggleSelect(m.id)
                  }}
                >
                  {/*
                    Two lines, and no dimming.

                    `data-disabled="true"` used to be set on every read message,
                    which dropped the whole row — subject, sender, timestamp — to
                    62% opacity. Read is not the same as unimportant, and a
                    mailbox where most rows are half-erased is a mailbox that is
                    hard to read. The distinction is carried by the dot and by
                    the subject's weight instead, which is what those two things
                    are for.
                  */}
                  <div
                    className="job"
                    data-unread={m.seen ? undefined : 'true'}
                    /* Read by the phone block in `16-mail.css`: while a
                       selection is live — or 编辑 is open — every row shows its
                       checkbox, and while neither is true no row spends 18px
                       plus a gap advertising a mode nobody is in. */
                    data-selecting={selecting ? 'true' : undefined}
                    /* Which row the pane beside it is showing. Only in the
                       two-pane band: below it the reader is a full-screen
                       dialog and the list is not on screen to mark, and above
                       it the desktop has its own arrangement. Without this,
                       tapping a row changes the whole right half of the screen
                       and nothing on the left half moves. */
                    data-open={twoPane && openMessage?.id === m.id ? 'true' : undefined}
                    onClick={() => (selecting ? toggleSelect(m.id) : openDetail(m))}
                  >
                    <input
                      type="checkbox"
                      className="job__select"
                      checked={selected.has(m.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelect(m.id)}
                      aria-label={t('inbox.selectMessage')}
                    />
                    <span className="job__pulse" data-unread={m.seen ? 'false' : 'true'} />
                    {/* Hidden on a phone by `16-mail.css` — that band has no
                        width to spare and the dot already says "unread" — and
                        shown from the tablet up, where the initial is the
                        fastest way to find a sender in a scrolling list. */}
                    <span className="avatar job__avatar" aria-hidden="true">
                      {senderInitial(splitSender(m.from).name, splitSender(m.from).address)}
                    </span>
                    <div className="job__body">
                      {/*
                        Line one: who it is from, and when.

                        The sender was the raw `From` header — a row started
                        `招商银行 <no-reply@bank…`, so the ellipsis fell inside
                        the address and the four characters that identify the
                        sender had to share the line with a string nobody reads.
                        `senderLabel` takes the display name out.
                      */}
                      <div className="job__meta">
                        {filter === 'all' && multiAccount ? (
                          <span className="chip">
                            <span className="chip__text">{accountLabel(m.accountId)}</span>
                          </span>
                        ) : null}
                        <span className="job__from">{senderLabel(m.from)}</span>
                        {m.hasAttachments ? (
                          /* A paperclip, not the literal character "@" this
                             used to print — which read as an address, not as an
                             attachment, and had no label of any kind. */
                          <span className="job__clip" role="img" aria-label={t('inboxbar.attachment')}>
                            <IconPaperclip size={13} />
                          </span>
                        ) : null}
                        {m.tag !== 'none' ? (
                          <span className={`chip chip--${m.tag === 'important' ? 'danger' : 'warning'}`}>
                            <span className="chip__text">
                              {t(m.tag === 'important' ? 'inbox.tagImportant' : 'inbox.tagFlagged')}
                            </span>
                          </span>
                        ) : null}
                        {/* Last on the line and never allowed to shrink below
                            its own content: in a nowrap row the bare timestamp
                            is the one item with no `white-space` of its own, and
                            it broke "2 min" onto two lines. */}
                        <span className="job__time">{formatAgo(m.date)}</span>
                      </div>
                      {/*
                        Line two: the subject, then the first words of the
                        message in a quieter colour on the same line.

                        One line, hard. A two-line subject was tried and made the
                        row 124.7px, which cut the pane to four messages — taller
                        than the row was before any of this work. The snippet
                        rides along on whatever is left rather than taking a
                        third line, because a third line costs ~19px on every row
                        and this screen is measured in rows.
                      */}
                      {/*
                        The code capsule leads line two, and it takes the
                        snippet's place rather than joining it.

                        Leading, because `.job__name` is a one-line clamp with
                        `overflow: hidden` — anything after a long subject is
                        cut off, and a copy button you cannot see is worse than
                        none. Instead of the snippet, because the row has 4.9px
                        of height left before the 9-row floor breaks (see
                        `.job__code` in 24-inbox.css for the arithmetic) and a
                        second element competing for the same line would push
                        the subject out of it. On a mail that carries a code the
                        code *is* the preview; on every other row nothing here
                        changes at all.
                      */}
                      <div className="job__name">
                        {rowCode ? (
                          <button
                            type="button"
                            className="job__code"
                            aria-label={t('inbox.rowCodeCopy', { code: rowCode.value })}
                            onClick={(e) => {
                              // The row underneath opens the message. Without
                              // this, copying also navigates.
                              e.stopPropagation()
                              void copyRowCode(rowCode)
                            }}
                          >
                            <IconCopy size={13} />
                            <span className="job__codeValue">{rowCode.value}</span>
                          </button>
                        ) : null}
                        <span className="job__subject">{m.subject || t('inbox.noSubject')}</span>
                        {m.snippet && !rowCode ? (
                          <span className="job__snippet">{m.snippet}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="job__actions" onClick={(e) => e.stopPropagation()}>
                      <IconButton label={t('inbox.tagAs')} onClick={() => cycleTag(m)}>
                        <IconFlag size={16} />
                      </IconButton>
                    </div>

                    {/*
                      Delete, in the row's top-right corner — the same `.rowdel`
                      the reminder rows and the log rows use, so the corner means
                      one thing everywhere (see `06-lists.css`).

                      Moved out of `.job__actions` beside it, not added
                      alongside: two delete buttons on one row would be worse
                      than the one in the wrong place. That also changes *where
                      it exists*, which is the point on a phone —
                      `.swipe .job > .job__actions` is `display: none` below
                      840px (see `16-mail.css`, which took the buttons off the
                      row to give the subject its width back), so on the device
                      the report came from there was no visible delete on a mail
                      row at all. `.rowdel` is not inside that element, so it
                      survives the rule and the corner is now the one place the
                      control is, at every width.

                      The swipe still deletes and the opened message still has
                      its own button. Nothing was taken away; a gesture nobody
                      can find has stopped being the only way.

                      `stopPropagation` because the row underneath opens the
                      message — the same reason the tag row above needs it.
                    */}
                    <IconButton
                      className="rowdel"
                      label={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void deleteIdSet(new Set([m.id]))
                      }}
                    >
                      <IconTrash size={16} />
                    </IconButton>
                  </div>
                </SwipeableRow>
                )
              }}
            </VirtualList>
          </div>
        )}
      </div>

      <ReaderShell
        twoPane={twoPane}
        open={openMessage !== null}
        immersive={immersive}
        title={openMessage?.subject || t('inbox.noSubject')}
        onClose={() => setOpenMessage(null)}
        onEscape={handleEscape}
        closeLabel={t('common.close')}
        actions={
          <div
            className="btn-row"
            /*
              How many icons `.reader__actionsFull` is carrying, handed to the
              stylesheet so it can share the header row out evenly.
              要求…这五个图标显示在弹出的页面的最上面一行均匀分布.

              The row is not a flat list — flag and delete are direct children
              here, find/full-screen (and day/night, which only exists on a dark
              message) are nested one level down inside `.reader__actionsFull`,
              and the close button is a sibling of this whole div that `Modal`
              renders. Even distribution across that shape needs each *container*
              to claim a share proportional to how many buttons it holds, and CSS
              cannot count children. So the count is stamped here and the
              stylesheet does the arithmetic — see `14-growth.css`.

              On this div rather than on `.reader__actionsFull` itself, because
              custom properties inherit downward: the wrapper reads it from here,
              and this element needs it too in order to size its own share.

              Flattening the wrapper away would have been the other answer, and
              is not available: `26-tablet.css` hides `.reader__actionsFull` as a
              unit in the two-pane band, where three of the five icons fold into
              the overflow menu instead.
            */
            style={{ '--reader-actions': readerIsDark ? 3 : 2 } as React.CSSProperties}
          >
            {/*
              Tag and delete, on the open message.

              These are the two buttons the phone list row used to carry, and
              this is where they went — not into a gesture and nowhere else. The
              swipe (mark read / remove) is the fast path for someone who already
              knows it is there; a control you can see is what makes it
              discoverable at all, and "open the message, then act on it" is the
              path anyone finds without being told. On a desktop the row keeps
              its own two buttons as well, so nothing was taken away there.
            */}
            {openMessage ? (
              <IconButton label={t('inbox.tagAs')} onClick={() => cycleTag(openMessage)}>
                <IconFlag size={16} />
              </IconButton>
            ) : null}
            {openMessage ? (
              <IconButton
                label={t('common.delete')}
                onClick={() => {
                  const id = openMessage.id
                  setOpenMessage(null)
                  void deleteIdSet(new Set([id]))
                }}
              >
                <IconTrash size={16} />
              </IconButton>
            ) : null}

            {/*
              Day/night, find and full screen — desktop's own three buttons,
              inline exactly as before. `.reader__actionsFull` is plain
              `display: flex` above 760px, so nothing here changes on a
              desktop; the max-width:760px rule in app.css is what switches
              this off and `.reader__more` below on, never any JS state.
            */}
            <div className="reader__actionsFull">
              {/* Offered whenever the app is dark, whichever way the setting
                  points — see `invertByDefault`. The label names what the
                  press *will do*, not what is on screen. */}
              {openMessage && readerIsDark ? (
                <IconButton
                  label={nightOn ? t('inbox.viewOriginalColors') : t('inbox.viewNightColors')}
                  onClick={() => setRawStyle((v) => !v)}
                >
                  {nightOn ? <IconSun size={16} /> : <IconMoon size={16} />}
                </IconButton>
              ) : null}
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

            {/*
              Same three actions, collapsed behind one icon — a phone only
              ever showed this row wrapped to a second line, never fewer
              icons, and wrapping is what "keep the header to one line" asked
              to be rid of. Anchored popover modelled on the compose screen's
              `whenbar__quick`: closed costs nothing, open closes itself on
              Escape or a click outside (see the effect above).
            */}
            <div className="reader__more">
              <IconButton
                label={t('inbox.more')}
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              >
                <IconMore size={16} />
              </IconButton>
              {moreOpen ? (
                <div className="popover reader__moreMenu" role="menu" aria-label={t('inbox.more')}>
                  {openMessage && readerIsDark ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="reader__moreItem"
                      onClick={() => {
                        setRawStyle((v) => !v)
                        setMoreOpen(false)
                      }}
                    >
                      {nightOn ? <IconSun size={16} /> : <IconMoon size={16} />}
                      <span>{nightOn ? t('inbox.viewOriginalColors') : t('inbox.viewNightColors')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="reader__moreItem"
                    onClick={() => {
                      setFindOpen((v) => !v)
                      setMoreOpen(false)
                    }}
                  >
                    <IconSearch size={16} />
                    <span>{t('inbox.find')}</span>
                  </button>
                  {/* Full screen is a dialog's word. In the two-pane band the
                      reader is a column of the screen and there is no
                      "restore" to go back to, so the control that would do
                      nothing visible is not offered rather than offered and
                      inert. */}
                  {twoPane ? null : (
                    <button
                      type="button"
                      role="menuitem"
                      className="reader__moreItem"
                      onClick={() => {
                        setImmersive((v) => !v)
                        setMoreOpen(false)
                      }}
                    >
                      {immersive ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
                      <span>{immersive ? t('inbox.exitFullscreen') : t('inbox.fullscreen')}</span>
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        }
      >
        {openMessage ? (
          <>
            {/*
              The sticky reader header — item 19.

              It is the same row it always was, promoted: `reader__meta` stays
              the class so nothing that already styled it has to be restated,
              and `24-inbox.css` adds the two things that make it a header —
              it sticks to the top of whichever column it is in, and it drops
              from 48px to 34px once either scroller has moved.

              Why it needed to stick at all, given the modal's own header is
              always visible: that header carries the *subject* and the action
              row. Who sent it and when were in the column, so on a long
              message — and this app now folds the quoted history, which makes
              long messages longer, not shorter — the two facts you check a
              message against scrolled away and the only way back was to
              scroll up.

              The three actions here are a shortcut, never the only route: tag
              and delete are also in the header above, and find is in the
              header on a desktop and in its overflow menu on a phone. They
              are duplicated deliberately, and this row is the one that stays
              under the thumb.
            */}
            <div className="reader__meta" ref={readerBarRef} data-compact={readerCompact || undefined}>
              <span className="reader__avatar" aria-hidden="true">
                {senderInitial(openSenderSplit.name, openSenderSplit.address)}
              </span>
              <span className="reader__sender">
                <span className="reader__senderName">
                  {openSenderSplit.name || openSenderSplit.address}
                </span>
                {/* A bare address (no display name) has nothing distinct to put
                    here — repeating it below its own name line would just be
                    the same string twice. */}
                {openSenderSplit.name ? (
                  <span className="reader__senderAddress">{openSenderSplit.address}</span>
                ) : null}
              </span>
              <span className="reader__when">{formatDateTime(openMessage.date)}</span>
              <span className="chip reader__account">
                <span className="chip__text">{accountLabel(openMessage.accountId)}</span>
              </span>
              <span className="reader__quick">
                <IconButton label={t('inbox.find')} onClick={() => setFindOpen((v) => !v)}>
                  <IconSearch size={16} />
                </IconButton>
                <IconButton label={t('inbox.tagAs')} onClick={() => cycleTag(openMessage)}>
                  <IconFlag size={16} />
                </IconButton>
                <IconButton
                  label={t('common.delete')}
                  onClick={() => {
                    const id = openMessage.id
                    setOpenMessage(null)
                    void deleteIdSet(new Set([id]))
                  }}
                >
                  <IconTrash size={16} />
                </IconButton>
              </span>
              <IconButton
                label={metaExpanded ? t('inbox.hideDetails') : t('inbox.showDetails')}
                aria-expanded={metaExpanded}
                onClick={() => setMetaExpanded((v) => !v)}
              >
                <IconChevronDown size={15} className="reader__chevron" data-open={metaExpanded} />
              </IconButton>
              {/* The keyboard map used to be printed here in grey on every
                  message ever opened. The shortcuts are unchanged; the sentence
                  about them is not something anyone reads twice. */}
            </div>
            {/*
              Everyone this message went to, not just the first of them.

              `.reader__details` is a wrapping flex row of `<span>`s. To and Cc
              each claim a whole line (`flexBasis: 100%`) rather than being left
              to wrap on their own, because a two-recipient To and a
              one-recipient Cc would otherwise share a line and read as one
              five-address list with two labels in the middle of it. The
              timestamp and the controls keep the old behaviour and share the
              last line when they fit.

              The inline widths are here rather than in a class for the reason
              this whole change is scoped to one file: the stylesheets were
              being edited elsewhere in the same round, and a rule and its
              markup arriving from two directions is how one of them ships
              without the other.
            */}
            {metaExpanded ? (
              <div className="reader__details">
                <span style={{ flexBasis: '100%' }}>
                  <strong>{t('compose.to')}</strong>{' '}
                  {shownTo.length > 0 ? shownTo.join(', ') : t('inbox.recipientsUnknown')}
                  {/* The count of what the fold is hiding, on the line it is
                      hiding it from — the button below says "show all", which
                      does not say how many "all" is. */}
                  {shownTo.length < openToAll.length
                    ? ` ${t('inbox.recipientsHidden', { n: openToAll.length - shownTo.length })}`
                    : ''}
                </span>
                {/* No empty Cc line. A message with no copies has nothing to
                    say here, and a label with nothing after it reads as a
                    value that failed to load. */}
                {openCc.length > 0 ? (
                  <span style={{ flexBasis: '100%' }}>
                    <strong>{t('compose.cc')}</strong> {shownCc.join(', ')}
                    {shownCc.length < openCc.length
                      ? ` ${t('inbox.recipientsHidden', { n: openCc.length - shownCc.length })}`
                      : ''}
                  </span>
                ) : null}
                <span>{formatDateTime(openMessage.date, { dateStyle: 'full', timeStyle: 'medium' })}</span>
                {/* Both controls in one `.btn-row` so the 48px buttons cannot
                    stretch the text spans beside them, and so a phone gets the
                    horizontal scroll `17-phone.css` already gives that class
                    inside a list view rather than a second wrapped row.
                    The row is not rendered at all when neither control is —
                    a zero-height flex item in a gapped column still costs the
                    gap, which is the note on `.codespull` in `CodesView`. */}
                {recipientTotal > 0 ? (
                  <div className="btn-row" style={{ flexBasis: '100%' }}>
                    {recipientsFoldable ? (
                      <Button
                        variant="ghost"
                        aria-expanded={recipientsExpanded}
                        onClick={() => setRecipientsExpanded((v) => !v)}
                      >
                        {recipientsExpanded
                          ? t('inbox.recipientsShowFewer')
                          : t('inbox.recipientsShowAll', { n: recipientTotal })}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      icon={<IconCopy size={15} />}
                      onClick={() => void copyRecipients()}
                    >
                      {t('inbox.copyRecipients')}
                    </Button>
                  </div>
                ) : null}
                {/*
                  Why there is no Bcc line, said once, here, and nowhere else.

                  A blind copy is removed by the sender's own server before the
                  message is handed on, so it is not in the bytes this app
                  received — no mail client can show it, and this one is not
                  going to imply it could if you upgraded. It sits inside the
                  fold rather than on the resting reader because it answers a
                  question only somebody already reading the recipient list has
                  thought to ask.
                */}
                <span style={{ flexBasis: '100%' }}>{t('inbox.bccNotDelivered')}</span>
              </div>
            ) : null}

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
              <div className="reader__loading" aria-busy="true" aria-live="polite">
                <div className="skeleton__bar" />
                <div className="skeleton__bar" />
                <div className="skeleton__bar" />
                <div className="skeleton__bar" />
                <div className="skeleton__bar" />
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

                {/* A count of a problem is not a description of one. The
                    sentence after it names which of the four failures this was,
                    and the raw error follows when there was one — the same
                    treatment the body-load toast already gives. */}
                {remoteImageCount > 0 && imageStage === 'failed' ? (
                  <Banner
                    tone="danger"
                    action={
                      /* No retry where retrying cannot work. Without
                         `fetchRemoteImage` there is no path to the network for
                         pictures in this build at all, so the button would fail
                         identically every time it was pressed. */
                      bridge?.fetchRemoteImage ? (
                        <Button variant="ghost" onClick={() => void loadRemoteImages({ retry: true })}>
                          {t('inbox.imagesRetry')}
                        </Button>
                      ) : undefined
                    }
                  >
                    {t('inbox.imagesFailed', { n: imageFailures })}
                    {imageFailReason ? ` ${t(imageFailKey(imageFailReason))}` : ''}
                    {imageFailDetail ? ` ${imageFailDetail}` : ''}
                  </Banner>
                ) : null}

                {/*
                  What the proxy did to this message, on one line.

                  Three facts can be true at once and each is worth different
                  words, so they share a bar rather than stacking three:

                    · every picture came off disk — nothing about opening this
                      message reached the network, which is the entire promise
                      and the only place the app is allowed to claim it;
                    · N pictures were refused, with a tap for which rule;
                    · N looked like they were measuring the reader.

                  Suppressed entirely when none of the three applies, which is
                  the ordinary case for ordinary mail. A privacy bar on every
                  message is a bar nobody reads by the second week.

                  `tone="info"` and `keep` for the reason the bar below gives:
                  info banners are culled on phones as explanations, and this is
                  a statement of what happened plus a control.
                */}
                {imageStage === 'done' && (imagesFromCache || imageBlocked > 0 || trackerCount > 0) ? (
                  <Banner
                    tone="info"
                    keep
                    action={
                      imageBlocked > 0 ? (
                        <Button variant="ghost" onClick={() => setBlockDetailOpen((v) => !v)}>
                          {t(blockDetailOpen ? 'inbox.imageBlock.hide' : 'inbox.imageBlock.why')}
                        </Button>
                      ) : undefined
                    }
                  >
                    {/* The order is deliberate: what protected you, then what
                        was withheld, then what was found. */}
                    {imagesFromCache ? t('inbox.imagesPrefetched') : ''}
                    {imageBlocked > 0
                      ? `${imagesFromCache ? ' ' : ''}${t('inbox.imagesBlocked', { n: imageBlocked })}`
                      : ''}
                    {trackerCount > 0
                      ? `${imagesFromCache || imageBlocked > 0 ? ' ' : ''}${t('inbox.trackersFound', { n: trackerCount })}`
                      : ''}
                    {/* Each rule that fired, spelled out — one line each, only
                        when asked for. A reason code in a banner is a reason
                        nobody can act on. */}
                    {blockDetailOpen && imageBlockReasons.length > 0 ? (
                      <ul className="imageblock__why">
                        {imageBlockReasons.map((reason) => (
                          <li key={reason}>{t(blockReasonKey(reason) as 'inbox.imageBlock.undecodable')}</li>
                        ))}
                      </ul>
                    ) : null}
                  </Banner>
                ) : null}

                {/*
                  The bar people now see on most messages, so it had to stop
                  being an alarm.

                  This bar appears only where remote pictures did *not* load, and
                  `DEFAULT_IMAGE_POLICY` is 'always', so on a default install
                  that is the mailbox somebody has deliberately locked down
                  rather than ordinary mail. `info` rather than `warning` all the
                  same: it was `warning` while blocking was the default and every
                  newsletter carried it, and a red-adjacent bar people see daily
                  is one they learn to stop reading. The tone belongs to what the
                  bar *is* — a control offering to fetch something — not to how
                  often the current default happens to show it.

                  `keep` because `tone="info"` is culled on phones (see the
                  760px block in app.css): info banners are usually explanations
                  of how a screen works, and this one is a control.

                  The two actions in the order they are wanted: show them now is
                  what the press is for, and "always, from this sender" is the
                  answer for the newsletter you have now decided to trust —
                  `allowSenderImages` writes the domain into the account's
                  allowlist, which is the only thing that makes a future message
                  from them load without this bar.
                */}
                {remoteImageCount > 0 && imageStage === 'blocked' && !autoLoadImages ? (
                  <Banner
                    tone="info"
                    keep
                    action={
                      <div className="btn-row">
                        <Button variant="secondary" onClick={() => void loadRemoteImages()}>
                          {t('inbox.loadImages', { n: remoteImageCount })}
                        </Button>
                        {openSender && openInbox ? (
                          <Button variant="ghost" onClick={allowSenderImages}>
                            {t('inbox.alwaysAllowSender', { domain: openSender })}
                          </Button>
                        ) : null}
                      </div>
                    }
                  >
                    {t('inbox.remoteImagesHeld', { n: remoteImageCount })}
                    {/* Only when this message actually has inline parts. The
                        pictures that came *with* the mail are already on this
                        disk, cost no request and leak nothing, so they are not
                        affected by any of this — and a bar that says "images
                        are not loaded" over a body that is visibly showing
                        some is a bar that looks like it is lying. Saying so
                        unconditionally would be its own confusion: most
                        messages have no inline parts to reassure anyone
                        about. */}
                    {inlineCids.length > 0 ? ` ${t('inbox.inlineImagesUnaffected')}` : ''}
                  </Banner>
                ) : null}

                <MessageBodyFrame
                  html={
                    mathHtml ??
                    resolvedHtml ??
                    openBody.sanitizedHtml ??
                    textAsHtml(openBody.text ?? t('inbox.noBody'))
                  }
                  find={findOpen ? deferredFind : ''}
                  onLinkClick={openLinkSafely}
                  nightFilter={nightOn}
                  themeKey={readerThemeKey}
                  /* The pictures, placed into the document the frame already
                     has rather than by rebuilding it — see `resolvedHtml` and
                     `rebuildImages` for what that rebuild used to cost and
                     when it still happens. */
                  images={frameImages}
                  onImagesUnplaced={rebuildImages}
                  /* The message scrolls inside the frame, so this is the only
                     way the sticky header above knows it is being read. */
                  onScroll={onBodyScroll}
                  /* A left/right finger swipe over the open message closes it
                     back to the list — the same action as the reader's own
                     close button, just reachable without aiming for it. */
                  onSwipeDismiss={() => setOpenMessage(null)}
                  /* Escape has to reach the same two-stage ladder whether
                     focus is on the reader's own chrome or inside the frame —
                     see `MessageBodyFrame`'s `onEscapeKey` for why it
                     otherwise reaches neither. */
                  onEscapeKey={handleEscape}
                  /* Both branches of that `??` above go through the same fold:
                     a reply quoted with `>` in a text/plain part and one quoted
                     as `<blockquote>` in an HTML part are the same message to
                     the person reading it, and only one of them being foldable
                     would look like the feature working intermittently. */
                  foldQuotes={state.settings.readerFoldQuotes !== false}
                />

                {/*
                  B4 — the moment this message is about, offered in the reader.

                  ## Why this is below the body and not above it

                  It was above, and the reason given was that an offer has to
                  be checkable against the text it was read from. It still is —
                  the text is now directly above it rather than directly below.
                  What moved it is item 12: the extraction no longer runs on
                  the render that first has a body (see `datesReady`), so this
                  strip *arrives* a moment after the message is already on
                  screen. Above the frame, that arrival pushed the first
                  paragraph down under the reader's eye — which would have
                  spent the whole point of making the body paint sooner.

                  Below it, nothing moves. The frame is the one `flex: 1` child
                  of the reader's column and every other child is `flex: none`,
                  so a strip appearing underneath takes its height out of the
                  frame's box instead of out of its position: the message's own
                  text does not shift by a pixel. That is the "reserve the
                  space" requirement met by construction rather than by
                  guessing at a height, which could not have been guessed —
                  the strip is one card or four.

                  It is still visible without scrolling for the same reason:
                  the frame gives way, so the offers sit on screen under the
                  message rather than below the fold.

                  Nothing here has done anything yet — pressing a lead time is
                  what creates a reminder, and that press is the only path to
                  one.
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
            ) : (
              /*
                The third state, which used to be `null`.

                Reached whenever there is an open message and no body: the
                fetch threw, or there is no fetch to make (the browser sandbox
                has no `getMessageBody`). Either way the reader now says so, in
                the same place the message would have been, and offers the one
                action that can change the answer.
              */
              <ReaderBodyFailure
                detail={bodyError}
                /* Already on this device — it is what the row in the list is
                   drawn from — so the reader can show the first line of the
                   message even with the server unreachable. */
                snippet={openMessage?.snippet}
                onRetry={() => {
                  if (openMessage) void loadBody(openMessage, undefined, { skipCache: true })
                }}
              />
            )}
          </>
        ) : null}
      </ReaderShell>

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
 * The reader, in whichever of the two boxes this window has room for.
 *
 * Below 600px and from 840px up it is what it has always been: a `Modal` over
 * the list, opening full screen. In the band between — `useTwoPane`, the same
 * 600/840 boundaries every other shape change in this app uses — the window is
 * wide enough to hold the list and the message at once, and a dialog laid over
 * a list that is perfectly readable beside it hides half a screen for nothing.
 *
 * ## Why children rather than a second reader
 *
 * Everything that makes this reader safe is the caller's and is passed
 * straight through: the `imageRun` / `bodyRun` counters that stop a slow load
 * splicing one message's pictures into another, `MessageBodyFrame`'s sandbox
 * with no `allow-scripts`, the three remote-image policy banners, and
 * `openLinkSafely`'s confirm before anything opens outside the app. This
 * component picks the box. It does not know, and must not know, what is in it
 * — a copy of the reader with a different wrapper is how two readers end up
 * disagreeing about what a blocked image means, and only one of them gets
 * fixed.
 *
 * The header is the same two things in both: the subject, and the action row
 * the caller built. In the pane there is no close button, because there is
 * nothing to close back to — the list is already on screen, and the pane
 * empties itself when the open message is deleted.
 */
function ReaderShell({
  twoPane,
  open,
  immersive,
  title,
  actions,
  onClose,
  onEscape,
  closeLabel,
  children,
}: {
  twoPane: boolean
  open: boolean
  /** Dialog only: the reader opens full screen and Escape steps out of it first. */
  immersive: boolean
  title: string
  actions: React.ReactNode
  onClose: () => void
  onEscape: () => void
  closeLabel: string
  children: React.ReactNode
}) {
  const { t } = useI18n()

  /**
   * Android's back gesture closes the open message in the two-pane band too.
   *
   * The dialog half of this component gets it from `Modal`, which registers
   * itself while open. The pane half is an `<aside>` that is part of the
   * screen rather than an overlay, so nothing was registering for it — and on
   * a tablet, which is exactly the device the two-pane band exists for, a back
   * press with a message open would have skipped straight past it to the
   * shell's "go to Home" rule. Opening a message and pressing back would have
   * left the inbox entirely.
   *
   * `onEscape` rather than `onClose`, matching the dialog: the reader's Escape
   * steps out of full screen before it closes anything, and the gesture has to
   * mean the same thing the key does.
   *
   * Hooks cannot be called after the `if (!twoPane)` early return below, so
   * this sits above it and guards on `twoPane` itself.
   */
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  useEffect(() => {
    if (!twoPane || !open) return
    return pushBackHandler(() => {
      onEscapeRef.current()
      return true
    })
  }, [twoPane, open])

  if (!twoPane) {
    return (
      <Modal
        open={open}
        fullscreen={immersive}
        wide
        variant="reader"
        bodyClassName="modal__body--reader"
        title={title}
        onClose={onClose}
        onEscape={onEscape}
        closeLabel={closeLabel}
        headerExtra={actions}
      >
        {children}
      </Modal>
    )
  }

  return (
    <aside className="twopane__detail" aria-label={t('twopane.reader')}>
      {open ? (
        <>
          <div className="detailhead">
            <h2 className="detailhead__title">{title}</h2>
            {actions}
          </div>
          {/*
            `modal__body--reader` on an element that is not in a modal, on
            purpose. That class is the reader body's layout — no gap, the frame
            does the growing, and one margin shared by the banners, the meta
            row, the find bar and the attachment list — and restating those six
            rules under a second name is how the pane and the dialog would come
            to lay the same message out two different ways. `detailpane__body`
            adds only what a column needs that a dialog body already had: a
            scroller of its own.
          */}
          <div className="modal__body--reader detailpane__body">{children}</div>
        </>
      ) : (
        <div className="detailpane__body detailpane__body--empty">
          <EmptyState
            icon={<IconInbox size={24} />}
            title={t('twopane.noMessage')}
            hint={t('twopane.noMessageHint')}
          />
        </div>
      )}
    </aside>
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
/** How long a finger has to stay put before it counts as "select this one". */
const LONG_PRESS_MS = 450
/** And how far it may drift while it waits. Beyond this it was a scroll. */
const LONG_PRESS_SLOP = 10

function SwipeableRow({
  message,
  rtl,
  onRemove,
  onToggleRead,
  onLongPress,
  children,
}: {
  message: InboxMessage
  rtl: boolean
  onRemove: () => void
  onToggleRead: () => void
  onLongPress: () => void
  children: React.ReactNode
}) {
  const { t } = useI18n()
  const { offset, handlers } = useSwipe({
    rtl,
    onSwipe: (direction) => (direction === 'trailing' ? onRemove() : onToggleRead()),
  })

  /*
   * Long press enters multi-select, so the checkbox does not have to be on
   * screen for the ninety-nine per cent of the time nobody is selecting
   * anything. Measured at 360px: the box and its gap were 34px of a 360px row,
   * on every row, permanently.
   *
   * Composed around `useSwipe`'s handlers rather than added to that hook: the
   * hook is shared and knows only about gesture arithmetic, and a timer that
   * fires an action belongs to the row that has an action to fire.
   *
   * Three things have to be true for this not to be infuriating:
   *   · a press that moves is a scroll or a swipe, never a selection — hence
   *     the slop check, and `useSwipe`'s own axis lock still runs untouched;
   *   · the finger lifting cancels the timer, so a fast tap cannot select;
   *   · and the click that the lift produces has to be swallowed, or long
   *     press would select the message *and* open it. `onClickCapture` on this
   *     wrapper runs before the row's own `onClick` in the capture phase, so
   *     stopping propagation there is what keeps the reader shut.
   */
  const timer = useRef<number | null>(null)
  const from = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    from.current = null
  }

  return (
    <div
      className="swipe"
      {...handlers}
      onPointerDown={(e) => {
        handlers.onPointerDown(e)
        cancel()
        fired.current = false
        // Mouse excluded for the same reason `useSwipe` excludes it: on a
        // desktop the row still has its two buttons, and a held click becoming
        // a selection would be a surprise.
        if (e.pointerType === 'mouse') return
        from.current = { x: e.clientX, y: e.clientY }
        timer.current = window.setTimeout(() => {
          timer.current = null
          fired.current = true
          onLongPress()
        }, LONG_PRESS_MS)
      }}
      onPointerMove={(e) => {
        handlers.onPointerMove(e)
        const start = from.current
        if (
          start &&
          (Math.abs(e.clientX - start.x) > LONG_PRESS_SLOP ||
            Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP)
        ) {
          cancel()
        }
      }}
      onPointerUp={(e) => {
        cancel()
        handlers.onPointerUp(e)
      }}
      onPointerCancel={(e) => {
        cancel()
        handlers.onPointerCancel(e)
      }}
      onClickCapture={(e) => {
        if (!fired.current) return
        fired.current = false
        e.stopPropagation()
        e.preventDefault()
      }}
      onContextMenu={(e) => {
        // Android fires a context menu at roughly the same moment the timer
        // does. Without this the selection lands *and* a native callout opens
        // over the row it landed on.
        if (fired.current) e.preventDefault()
      }}
    >
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
