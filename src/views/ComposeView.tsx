/**
 * The screen the app opens on.
 *
 * Layout priority is deliberate: recipient → subject → body → attachments,
 * then a sticky action bar that keeps "Send now" and "Schedule" on screen at
 * every window height. Those two buttons are the whole product; nothing is
 * allowed to push them below the fold.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import {
  Banner,
  Button,
  Card,
  Field,
  Modal,
  Segmented,
  Switch,
  useConfirm,
  useFieldId,
  useToast,
} from '../components/ui'
import { AttachmentPicker, TagField } from '../components/inputs'
import {
  ImageLightbox,
  ImageStrip,
  isViewableImage,
  useAttachmentImages,
} from '../components/ImageLightbox'
import {
  previewFor,
  wallTimeIn,
  windowsForRecipients,
  worthShowing,
} from '../components/deliveryPreview'
import { CHAIN_STAGES, buildChain, leadLabelKey } from '../core/chain'
import { takeEditJobSeed } from '../core/editJobSeed'
import { SEEDED_HOUR, takeComposeDates } from '../core/composeSeed'
import { summarizeRecurrence } from '../core/schedule'
import { upcoming } from '../core/upcoming'
import { HealthBoard } from '../components/HealthBoard'
import {
  RecurrenceEditor,
  fromLocalInput,
  hhmm,
  nextWholeHour,
  quickTimes,
  toLocalInput,
} from '../components/RecurrenceEditor'
import { ConditionEditor } from '../components/ConditionEditor'
import { DraftHistory } from '../components/DraftHistory'
import { OutboxStrip } from '../components/OutboxStrip'
import { MarkupToolbar } from '../components/MarkupToolbar'
import { PreflightDialog, useFilePresence, usePreflight } from '../components/PreflightDialog'
import { SendResultDetails } from '../components/SendDetails'
import {
  IconChevronDown,
  IconClock,
  IconFileText,
  IconMail,
  IconMaximize,
  IconMinimize,
  IconPaperclip,
  IconSearch,
  IconSend,
  IconSliders,
} from '../components/icons'
import { useNarrow } from '../components/useNarrow'
import type { SendCondition } from '../core/conditions'
import { hasVars, usedVars } from '../core/mergeVars'
import { isQueueable } from '../core/outbox'
import { accountLabel, groupAccounts } from '../core/accounts'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import { attachmentLimitBytes, providerById } from '../core/providers'
import { advisoryKey } from '../core/transport'
import {
  encodedSize,
  hasErrors,
  totalAttachmentBytes,
  validateBurst,
  validateDraft,
  validateRecurrence,
} from '../core/validate'
import {
  DEFAULT_BURST,
  DEFAULT_RETRY,
  defaultRecurrence,
  newId,

  type Attachment,
  type BurstPolicy,
  type MessageDraft,
  type Priority,
  type Recurrence,
  type RetryPolicy,
  type ScheduledJob,
  type SendResult,
} from '../core/types'

/**
 * The one-line explanation of a failure, keyed off the classification rather
 * than the server's wording.
 *
 * The raw text is still shown underneath — it is what a support thread needs —
 * but "Unexpected socket close" on its own tells the person in front of the
 * screen nothing about what to do next.
 */
const ERROR_TITLE: Record<string, TranslationKey> = {
  auth: 'error.auth',
  network: 'error.network',
  tls: 'error.tls',
  handshake: 'error.handshake',
  timeout: 'error.timeout',
  recipient: 'error.recipient',
  quota: 'error.quota',
  attachment: 'error.attachment',
  config: 'error.config',
  unknown: 'error.unknown',
}

function errorTitleKey(result: SendResult): TranslationKey {
  return ERROR_TITLE[result.errorKind ?? 'unknown'] ?? 'error.unknown'
}

const BODY_HEIGHT_KEY = 'aevistle.compose.bodyHeight'

/**
 * "Is this screen too narrow for the desktop compose form?"
 *
 * Wider than the app's shared `useNarrow` (760px), and the gap is the point: a
 * 768x1024 tablet held in two hands falls *outside* 760, so it was being given
 * the desktop form — a stacked addressing block, a dropzone and a send-time
 * row — with the message box left about a quarter of the screen. 900px is not
 * a new number: `app.css` has stacked `.compose-head` below 900 ever since the
 * three-across addressing row was introduced, for exactly the same reason.
 *
 * Never *narrower* than the shell's own answer. `useNarrow()` is OR-ed in so
 * that if `NARROW_QUERY` is ever widened past this, the compose screen follows
 * the shell rather than becoming the one place that quietly disagrees with it.
 */
const BODY_FIRST_QUERY = '(max-width: 900px)'

function useBodyFirst(): boolean {
  const narrow = useNarrow()
  const [belowNine, setBelowNine] = useState(() =>
    // Guarded exactly as `useNarrow` is, and wide is the safer default for the
    // same reason: it renders every field rather than a summary line that
    // needs JavaScript to open anything.
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(BODY_FIRST_QUERY).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(BODY_FIRST_QUERY)
    const onChange = (event: MediaQueryListEvent) => setBelowNine(event.matches)
    // Re-read on mount as well as on change — see `useNarrow` for the rotated
    // phone this is here for.
    setBelowNine(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return narrow || belowNine
}

/**
 * One section of the form: inline in a desktop window, a sheet on a narrow one.
 *
 * The markup inside is written once and rendered in both places. Attachments
 * and the send time are each a whole field's worth of chrome — measured at
 * 360x800 they were 74px and 100px, a quarter of the screen spent on two
 * controls nobody touches while writing a sentence. On a narrow screen they go
 * behind the two buttons in the action bar that open them, and the message box
 * gets the space back.
 *
 * `open` is honoured on the desktop branch too, because one of the three
 * callers is a disclosure: the options panel must stay closed there until it
 * is asked for, exactly as it did before this wrapper existed.
 */
function ComposeSheet({
  narrow,
  open,
  title,
  closeLabel,
  onClose,
  children,
}: {
  narrow: boolean
  open: boolean
  title: string
  closeLabel: string
  onClose: () => void
  children: ReactNode
}) {
  if (!narrow) return open ? <>{children}</> : null
  return (
    <Modal open={open} wide title={title} onClose={onClose} closeLabel={closeLabel}>
      {children}
    </Modal>
  )
}

/**
 * A new reminder starts at the next whole hour, and the box says so.
 *
 * `defaultRecurrence()` seeds five minutes out, and the compose bar used to
 * blank the field rather than show that — a `datetime-local` with no value,
 * rendered by Chromium as `年/月/日 --:--`, sitting under a label reading
 * "send time" and beside a sentence reading "no send time chosen yet". Three
 * separate pieces of the screen saying the same nothing, while the state
 * behind them held a perfectly good time all along.
 *
 * Blanking it was defensible on its own terms: showing `14:37` next to "not
 * chosen yet" would have been the box contradicting the sentence. The mistake
 * was treating that as a reason to hide the value instead of a reason to seed
 * a value worth showing.
 */
function seedRecurrence(now = Date.now()): Recurrence {
  const at = nextWholeHour(now)
  return { ...defaultRecurrence(now), startAt: at, timeOfDay: hhmm(at) }
}

export function ComposeView({
  onGoToAccounts,
  onNavigate,
}: {
  onGoToAccounts: () => void
  /** Where the health strip sends you to fix what it found. */
  onNavigate?: (where: 'schedule' | 'settings' | 'compose' | 'logs') => void
}) {
  const { state, dispatch, sendDraftNow, scheduleDraft, snapshotDraft, bridge } = useApp()
  const { t, formatBytes, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  /**
   * Below this width the screen is rebuilt around the message rather than
   * restyled. See `useBodyFirst` for the number and why it is not the shell's.
   */
  const narrow = useBodyFirst()
  /**
   * Whether the addressing block is showing, on a narrow screen.
   *
   * Folded from the first paint on a narrow screen, open everywhere else.
   *
   * It used to start open and fold only once the message box took focus, and
   * that one word — "once" — was the whole of the 85% failure. Measured at
   * 360x800: open, the message box is 66% of the compose view, and 52% with a
   * second mail account configured, because that adds a 79px account `<select>`
   * to the block being held open. The 86% recorded in `app.css` was real but it
   * was the *post-focus* number, i.e. the state you reach after tapping into a
   * box that was a fifth of the screen at the moment you had to find it.
   *
   * So the fold is the initial state and `scripts/layout-probe.mjs` now asserts
   * the share on first paint rather than after a focus event. The summary bar is
   * styled as the input it stands for (`.composesummary`, and see the note there)
   * because a folded state that reads as a *missing* recipient field would be a
   * worse screen than a small message box, not a better one.
   */
  const [headerOpen, setHeaderOpen] = useState(() => !narrow)
  /**
   * Which of the three narrow-screen sheets is up, if any.
   *
   * One value rather than three booleans: they are three views of the same
   * region of the form and only ever one can be on screen, and three
   * independent flags is how two dialogs end up stacked on each other.
   */
  const [sheet, setSheet] = useState<'attachments' | 'when' | 'more' | null>(null)

  const [showCcBcc, setShowCcBcc] = useState(false)
  const [sending, setSending] = useState(false)
  const [preflightOpen, setPreflightOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  /**
   * The job this mount of the compose screen is updating, if any — spent
   * once, at mount, from `core/editJobSeed.ts`. Every other piece of
   * schedule-related state below reads its initial value from this where
   * relevant, and `confirmSchedule` branches on it to update in place
   * (`upsertJob` on the same id) instead of creating a new job.
   */
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(() => takeEditJobSeed())
  /** Fire-time checks attached to the job being scheduled, not to the draft. */
  const [conditions, setConditions] = useState<SendCondition[]>(() => editingJob?.conditions ?? [])
  /** The last send, kept on screen until dismissed or superseded. */
  const [outcome, setOutcome] = useState<SendResult | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  /**
   * Whether the schedule on screen is one the user has touched.
   *
   * No longer decides whether the send time is *shown* — it is seeded to the
   * next whole hour and shown from the first render, because a blank box under
   * a "send time" label was read as a missing feature rather than as a
   * question. What it still decides is the 30-day forecast and the retry
   * summary, neither of which is worth putting on screen about a rule nobody
   * has looked at. Cleared with the draft, so the next reminder does not
   * inherit the last one's time.
   *
   * Also true from the first render when editing — the schedule on screen is
   * an existing job's, not a blank seed, and the forecast/retry summary are
   * exactly what someone opening a job to change it wants to see.
   */
  const [scheduleSet, setScheduleSet] = useState(() => editingJob !== null)
  const [jobName, setJobName] = useState(() => editingJob?.name ?? '')
  /** Lead times ticked in the chain picker. `[0]` is "just the event itself". Meaningless while editing — see `chainable` below, which the picker is also gated on. */
  const [leadTimes, setLeadTimes] = useState<number[]>([0])
  const [recurrence, setRecurrence] = useState<Recurrence>(() => editingJob?.recurrence ?? seedRecurrence())
  /** The quick-pick popover. Anchored, so opening it costs the message box no height. */
  const [quickOpen, setQuickOpen] = useState(false)
  const [retry, setRetry] = useState<RetryPolicy>(() => editingJob?.retry ?? DEFAULT_RETRY)
  const [burst, setBurst] = useState<BurstPolicy>(() => editingJob?.burst ?? DEFAULT_BURST)
  /** Undefined means "whoever has it enabled" — see `ScheduledJob.executorDeviceId`. */
  const [executorDeviceId, setExecutorDeviceId] = useState<string | undefined>(() => editingJob?.executorDeviceId)

  /**
   * The other half of loading a job for edit: the message itself lives in
   * `state.draft`, which nothing above can seed from a `useState` initialiser
   * without racing whatever the draft already held. Runs once, against the
   * job this mount was seeded with — `editingJob` never changes after mount,
   * so re-running this on every render would just replace the draft the user
   * is now typing into with itself.
   */
  useEffect(() => {
    if (!editingJob) return
    dispatch({ type: 'setDraft', patch: { ...editingJob.draft } })
    setScheduleOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toId = useFieldId('to')
  const subjectId = useFieldId('subject')
  const bodyId = useFieldId('body')
  const headId = useFieldId('head')
  const moreId = useFieldId('more')
  const whenId = useFieldId('when')

  /**
   * The body box remembers how tall it was dragged.
   *
   * `localStorage` rather than settings: it is a property of this window on
   * this screen, not of the account or the document, and syncing it into
   * `state.json` would mean a laptop and a desktop fighting over one number.
   *
   * Not applied on a narrow screen, and actively cleared there. An inline
   * `height` beats every rule in the stylesheet, so a box once dragged to 220px
   * on a desktop window followed the same profile onto a phone and pinned the
   * message to 220px on the layout whose entire purpose is to hand it the
   * screen. The remembered number is not thrown away — it is still in
   * `localStorage` for the next wide window — it simply does not apply here.
   */
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!bodyRef.current) return
    if (narrow) {
      bodyRef.current.style.height = ''
      return
    }
    const saved = localStorage.getItem(BODY_HEIGHT_KEY)
    if (saved) bodyRef.current.style.height = saved
  }, [narrow])
  const rememberBodyHeight = () => {
    if (narrow) return
    const height = bodyRef.current?.style.height
    if (height) localStorage.setItem(BODY_HEIGHT_KEY, height)
  }

  /**
   * Focus mode: the message, and nothing else.
   *
   * The body box is already the only thing on this card that grows, so it
   * ends up with whatever the page head, the health strip, the addressing row
   * and the footer have not taken — measured at 281px of an 827px window, with
   * 356px going to chrome around it. Trimming that chrome buys tens of pixels
   * at a time and stops being possible fairly quickly.
   *
   * This is the answer for the case the trimming cannot reach: a long message.
   * Everything except the message is hidden, so the box gets essentially the
   * whole window, and one keystroke brings the rest back. `Escape` leaves, and
   * `F9` toggles.
   *
   * Not persisted. It is a posture for writing one message, not a preference —
   * reopening the app into a stripped-down screen with no visible way back
   * would be a mode someone got stuck in.
   */
  /*
   * How often the schedule on screen would actually fire.
   *
   * Only computed when a send time has been chosen — for an immediate send
   * there is nothing to forecast, and showing "1 send in the next 30 days"
   * about a message going out right now would be noise.
   *
   * Recomputed from the live recurrence rather than cached: the whole point is
   * to catch a wrong interval, and a stale answer would be worse than none.
   */
  const outlook = useMemo(
    () =>
      scheduleSet
        ? upcoming(recurrence, {
            quiet: {
              enabled: state.settings.quietHoursEnabled,
              start: state.settings.quietStart,
              end: state.settings.quietEnd,
            },
            calendar: state.settings.workCalendar,
          })
        : null,
    [scheduleSet, recurrence, state.settings],
  )

  /**
   * The secondary controls live in the top bar, not in the form.
   *
   * Draft history, the send preview, the focus toggle and the three
   * rarely-touched switches are all things you reach for once and then leave
   * alone for months, and they were charging the message box rent: the
   * disclosure alone was 67px of the card (59 + its gap) whether or not anyone
   * ever opened it, and the buttons were widening a bar that has to hold Send.
   *
   * The bar they moved to is the band the screen heading used to occupy, and
   * it is smaller than the heading was — a title naming the screen you are
   * already looking at does not need 40px, and a row sized by its own buttons
   * has no minimum a heading has to respect.
   *
   * `moreOpen` replaces a `<details>`: the summary now sits in the top bar
   * while the panel it controls stays down in the footer, which no single
   * element can do. Not persisted, for the same reason the disclosure never
   * was — it reopening because you once set a priority would defeat the point.
   */
  const [moreOpen, setMoreOpen] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  /* Focus mode takes the top bar off the screen, and with it the button that
     closes this panel. Leaving it open would be a strip of switches nobody
     could dismiss without leaving the mode first. */
  useEffect(() => {
    if (focusMode) setMoreOpen(false)
  }, [focusMode])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F9 is not handled here. It is in the shared shortcut table like every
      // other key, and arrives as a `compose-action` — a second listener on the
      // same key would toggle the mode twice on one press and look like the
      // key had not worked.
      //
      // Escape only leaves focus mode when nothing is stacked on top of it.
      // Every dialog in this app listens on `document`, so an unconditional
      // handler here would close the preview *and* the mode behind it with
      // one press — the same mistake the image viewer had to be fixed for.
      if (e.key === 'Escape' && focusMode && !document.querySelector('.modal, dialog[open]')) {
        setFocusMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode])

  const draft = state.draft
  const account = state.accounts.find((a) => a.id === draft.accountId)
  const preset = providerById(account?.providerId)
  const accountGroups = useMemo(() => groupAccounts(state.accounts), [state.accounts])

  const limitBytes = attachmentLimitBytes(
    account?.providerId,
    state.settings.attachmentMaxMb,
  )

  const issues = useMemo(
    () =>
      validateDraft(draft, account, {
        attachmentWarnBytes: state.settings.attachmentWarnMb * 1048576,
        attachmentMaxBytes: limitBytes,
        bulkConfirmThreshold: state.settings.bulkConfirmThreshold,
      }),
    [draft, account, state.settings, limitBytes],
  )
  const blocked = hasErrors(issues)

  /**
   * What the banner under the card is allowed to say.
   *
   * "No subject" and "the body is empty" are advisory, and they fire on a draft
   * that is simply half-written — the moment a recipient is typed, before a
   * subject could reasonably exist. A two-line banner appearing there costs the
   * message box ~70px, so the field the screen exists to fill shrinks as a
   * reward for starting to use it.
   *
   * They are not lost: `preflight.warn.noSubject` and `preflight.warn.emptyBody`
   * report both in the send preview, which is the screen for "check this before
   * it goes out". This filter only drops them from the always-on banner; errors,
   * which block Send, are untouched.
   */
  const bannerIssues = useMemo(
    () => issues.filter((i) => i.key !== 'validate.noSubject' && i.key !== 'validate.emptyBody'),
    [issues],
  )
  const recipientCount = draft.to.length + draft.cc.length + draft.bcc.length
  /** Has the user put anything in the draft yet? Nothing is "wrong" until so. */
  const started =
    recipientCount > 0 ||
    draft.subject.trim().length > 0 ||
    draft.body.trim().length > 0 ||
    draft.attachments.length > 0
  const rawBytes = totalAttachmentBytes(draft.attachments)

  /**
   * An empty draft goes back to whatever the initial state for this width is.
   *
   * A send, a queue or a scheduled job all end in `resetDraft`, and the next
   * reminder must not inherit a summary line describing the last one.
   *
   * `!narrow`, not `true`: on a phone the folded bar *is* the initial state (see
   * `headerOpen`), and forcing it open here would undo that on the very first
   * render — this effect runs on mount, where `started` is already false. That
   * is what defeated the previous attempt at a folded first paint.
   *
   * Guarded on `!started`, which is what makes it fire on the true→false edge
   * only. The false→true edge — the first character of a new draft — must *not*
   * re-open the block the user just folded away by tapping into the message.
   */
  useEffect(() => {
    if (!started) setHeaderOpen(!narrow)
  }, [started, narrow])

  const patch = (p: Partial<MessageDraft>) => dispatch({ type: 'setDraft', patch: p })

  /**
   * The character and byte counts under the message box.
   *
   * Memoised because both were computed in the render body: a new
   * `TextEncoder` allocated, the entire body re-encoded, and the whole string
   * spread into an array of code points — twice the length of the message, on
   * every keystroke *and* on every unrelated re-render of this screen.
   */
  const bodyCount = useMemo(
    () => ({
      c: [...draft.body].length,
      b: formatBytes(new TextEncoder().encode(draft.body).length),
    }),
    [draft.body],
  )

  /**
   * The pictures on this draft, as pictures.
   *
   * The body is a plain textarea, so an embedded image was previously visible
   * only as the literal text `<img src="cid:…">` — the attachment was there and
   * would have arrived, but nothing on the screen showed what it was. These are
   * the actual bytes, read back through the same size-capped, data-folder-only
   * bridge call the inbox preview uses.
   *
   * Ordered inline-first: the ones that appear inside the message are the ones
   * being asked about when someone looks here.
   */
  const imageSources = useMemo(
    () =>
      draft.attachments
        .filter((a) => isViewableImage(a.name))
        .map((a) => ({ id: a.id, name: a.name, path: a.path, size: a.size, inline: a.inline })),
    [draft.attachments],
  )
  const loadedImages = useAttachmentImages(imageSources)
  const gallery = useMemo(
    () =>
      imageSources
        .map((s) => {
          const bytes = loadedImages[s.path]
          return bytes ? { ...s, ...bytes } : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => Number(b.inline ?? false) - Number(a.inline ?? false)),
    [imageSources, loadedImages],
  )
  /** Which picture the full-screen viewer is on; `null` when it is shut. */
  const [lightboxAt, setLightboxAt] = useState<number | null>(null)
  const thumbnails = useMemo(() => {
    const map: Record<string, string> = {}
    for (const img of gallery) map[img.path] = img.dataUrl
    return map
  }, [gallery])

  /**
   * Open and authenticate as soon as this screen is on show.
   *
   * An SMTP send is DNS, TCP, TLS, EHLO, AUTH and only then the message — and
   * none of the first five depend on what is being sent. Doing them while the
   * user is still typing is what turns "Send now" from a few seconds into a
   * single round trip. Failure is ignored on purpose: this screen must not
   * report a connection problem for a message nobody has sent yet.
   */
  const warmedFor = useRef<string | null>(null)
  useEffect(() => {
    /*
     * `authMethod !== 'password' || hasSecret` rather than `hasSecret` alone.
     * An OAuth2 account never sets `hasSecret` — its credential is a grant
     * under a different keystore kind — so the bare test silently withheld
     * pre-warming from exactly the accounts whose sign-in handshake is the
     * slowest, and did it invisibly: nothing failed, "Send now" was just always
     * a few seconds instead of one round trip.
     */
    if (!bridge?.prewarm || !account?.id) return
    if (account.authMethod === 'password' && !account.hasSecret) return
    // Re-warm when the chosen account changes, not on every keystroke.
    const key = `${account.id}:${account.updatedAt}`
    if (warmedFor.current === key) return
    warmedFor.current = key
    void bridge.prewarm(account).catch(() => {})
  }, [bridge, account])

  /**
   * Keyboard actions aimed at this screen.
   *
   * The shell decides *which* key means what (see `components/Shortcuts`); this
   * only decides what each action does here. Guarded on the same conditions
   * the buttons are: a shortcut that sends a draft the Send button refuses is
   * a shortcut that bypasses every check the button exists to run.
   */
  useEffect(() => {
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (action === 'send' && !blocked && !sending) void doSend()
      if (action === 'schedule' && !blocked && !sending) openSchedule()
      if (action === 'preview' && started) setPreflightOpen(true)
      if (action === 'history') setHistoryOpen(true)
      if (action === 'focus') setFocusMode((v) => !v)
    }
    window.addEventListener('aevistle:compose-action', onAction)
    return () => window.removeEventListener('aevistle:compose-action', onAction)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  /**
   * Files dropped onto the compose screen.
   *
   * Resolving the path happens in the preload via `webUtils.getPathForFile`;
   * the main process then stats each one. A file whose path cannot be resolved
   * is skipped rather than attached as a name with no contents — an attachment
   * that silently sends nothing is the failure this application exists to
   * avoid.
   */
  const dropAttachments = (files: FileList) => {
    if (!bridge?.pathForFile || !bridge.attachPaths) return
    const paths: string[] = []
    for (const file of Array.from(files)) {
      try {
        const p = bridge.pathForFile(file)
        if (p) paths.push(p)
      } catch {
        /* Not resolvable (a dragged browser image, say) — skip it. */
      }
    }
    if (paths.length === 0) {
      toast.push({ tone: 'error', title: t('compose.dropUnsupported') })
      return
    }
    void bridge.attachPaths(paths).then((added) => {
      if (added.length > 0) {
        patch({ attachments: [...draft.attachments, ...added] })
        return
      }
      // The main process skips anything it cannot stat or read. Dropping three
      // files onto the form and having the list stay empty with no explanation
      // is the shape of failure this application is supposed to be free of:
      // it looks exactly like the drop not having registered at all.
      toast.push({ tone: 'error', title: t('compose.dropNothingAdded', { n: paths.length }) })
    })
  }

  const addAttachments = async () => {
    if (!bridge) return
    const picked = await bridge.pickFiles()
    if (picked.length > 0) {
      patch({ attachments: [...draft.attachments, ...picked] })
    }
  }

  /**
   * Move an image between "attached file" and "shown in the message body".
   *
   * The transport has always understood `inline` + `cid` (see `mailer.ts`),
   * but nothing ever set them, so a picture could only arrive as a file to
   * download. Turning it on writes the `<img>` tag into the body and switches
   * the format to HTML, because a `cid:` reference in a plain-text message is
   * just text that reads like a bug; turning it off takes the tag back out
   * rather than leaving a broken image behind.
   */
  const toggleInline = (id: string) => {
    const target = draft.attachments.find((a) => a.id === id)
    if (!target) return

    if (target.inline) {
      const cid = target.cid
      const body = cid
        ? draft.body.replace(new RegExp(`\\s*<img[^>]*src=["']cid:${cid}["'][^>]*>`, 'gi'), '')
        : draft.body
      // The tag can survive the strip — the body is an editable textarea, and
      // a hand-edited tag stops matching. Left unsaid, the attachment becomes
      // an ordinary file while the message still references a `cid:` that is
      // no longer inline, and the recipient gets a broken image icon. Nothing
      // in the app would have said a word about it.
      if (cid && body.includes(`cid:${cid}`)) {
        toast.push({ tone: 'error', title: t('compose.inlineRemoveFailed') })
      }
      patch({
        body,
        attachments: draft.attachments.map((a) =>
          a.id === id ? { ...a, inline: false, cid: undefined } : a,
        ),
      })
      return
    }

    // A Content-ID has to survive being pasted into a header, so it is built
    // rather than taken from the (user-supplied, possibly non-ASCII) filename.
    const cid = `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@aevistle`
    const tag = `<img src="cid:${cid}" alt="${target.name.replace(/["<>&]/g, '')}" style="max-width:100%" />`
    patch({
      body: draft.body ? `${draft.body}\n${tag}` : tag,
      bodyFormat: 'html',
      attachments: draft.attachments.map((a) => (a.id === id ? { ...a, inline: true, cid } : a)),
    })
  }

  /**
   * A copied image pasted straight into the body, rather than attached
   * through the file picker first.
   *
   * Builds the same `cid:` tag `toggleInline` does — deliberately not by
   * calling `toggleInline` itself, because that reads the attachment back out
   * of `draft.attachments`, and the attachment this creates does not exist
   * there yet: `patch()` does not update `draft` synchronously, so a
   * follow-up call in the same handler would still see the old list. One
   * `patch` with the finished attachment and body avoids the race.
   */
  const handleBodyPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!bridge?.attachBlob) return
    /*
     * Every file is taken out of the clipboard *before* the first `await`.
     *
     * `DataTransferItem` is only valid for the duration of the event dispatch:
     * call `getAsFile()` after the handler has yielded and it answers `null`.
     * Reading them lazily inside the loop therefore worked for one pasted
     * image and silently dropped every image after the first — the paste
     * appeared to succeed, one picture arrived, and nothing reported the rest.
     */
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()

    let body = draft.body
    const added: Attachment[] = []
    for (const file of files) {
      try {
        const data = await file.arrayBuffer()
        const saved = await bridge.attachBlob(file.name || `pasted-${Date.now()}.png`, file.type, data)
        const cid = `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@aevistle`
        const tag = `<img src="cid:${cid}" alt="${saved.name.replace(/["<>&]/g, '')}" style="max-width:100%" />`
        body = body ? `${body}\n${tag}` : tag
        added.push({ ...saved, inline: true, cid })
      } catch (err) {
        toast.push({
          tone: 'error',
          title: t('compose.pasteImageFailed'),
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (added.length > 0) {
      patch({ body, bodyFormat: 'html', attachments: [...draft.attachments, ...added] })
    }
  }

  /**
   * What this send actually is, recomputed as the draft changes.
   *
   * Cheap enough to keep live rather than building it when the dialog opens:
   * the action bar reads the message count off it, so "2 messages" appears the
   * moment merge is switched on rather than only inside the preview.
   */
  const preflight = usePreflight(draft)
  const attachmentPresence = useFilePresence(draft.attachments.map((a) => a.path))

  const doSend = async () => {
    // Snapshot before the form is cleared. A successful send is the commonest
    // way to lose a draft you wanted to reuse — see `core/snapshots`.
    snapshotDraft('beforeSend')

    if (recipientCount > state.settings.bulkConfirmThreshold) {
      const ok = await confirm({
        title: t('confirm.bulkTitle', { n: recipientCount }),
        body: t('confirm.bulkBody'),
        confirmLabel: t('compose.sendNow'),
        cancelLabel: t('common.cancel'),
      })
      if (!ok) return
    }

    setSending(true)
    setOutcome(null)
    setDetailsOpen(false)
    try {
      const result = await sendDraftNow(draft)
      setOutcome(result)
      if (result.ok) {
        toast.push({
          tone: 'success',
          title: t('toast.sent'),
          detail: t('toast.sentDetail', { n: result.accepted.length, ms: result.durationMs }),
        })
        // A toast disappears. Someone who looked away during a slow send needs
        // the confirmation to still be there when they look back, which is the
        // whole complaint behind "did it send or not?".
        if (state.settings.notifyOnSuccess) {
          void bridge?.notify(t('result.sentTitle'), draft.subject || account?.fromAddress || '')
        }
        dispatch({ type: 'resetDraft', accountId: draft.accountId })
        clearSchedule()
      } else if (state.settings.offlineQueueEnabled !== false && isQueueable(result)) {
        // It is in the outbox, not lost. Saying "failed" here would be true of
        // the attempt and false of the message, and the message is what the
        // person cares about.
        toast.push({ tone: 'info', title: t('outbox.queued'), detail: result.error })
        dispatch({ type: 'resetDraft', accountId: draft.accountId })
        clearSchedule()
      } else {
        toast.push({
          tone: 'error',
          title: t(errorTitleKey(result)),
          detail: result.error,
        })
      }
    } finally {
      setSending(false)
    }
  }

  const openSchedule = () => {
    // Editing an existing job: every field below is already seeded from it
    // (see the `useState` initialisers above), and resetting them here — on
    // every open, not just mount — would discard the job's own settings the
    // moment the dialog was closed and reopened by hand.
    if (editingJob) {
      setScheduleOpen(true)
      return
    }
    setJobName(draft.subject.trim() || t('schedule.namePlaceholder'))
    // The time the user already picked on the compose screen is kept. Resetting
    // it unconditionally — which is what this did when the dialog was the only
    // place a time could be chosen — would now silently throw away the value
    // showing in the bar they just clicked.
    if (!scheduleSet) setRecurrence(seedRecurrence())
    setRetry(DEFAULT_RETRY)
    setBurst(DEFAULT_BURST)
    // Every dialog starts as a single reminder. Remembering the last chain
    // would silently triple the next unrelated reminder someone schedules.
    setLeadTimes([0])
    // Same reasoning for conditions: a leftover "only if no reply" would
    // silently suppress an unrelated reminder later.
    setConditions([])
    // And for the executor: a leftover "only my phone sends this" would
    // silently assign an unrelated reminder to a device the user never
    // chose for it.
    setExecutorDeviceId(undefined)
    setScheduleOpen(true)
  }

  /** Reset the send time along with the draft it belonged to. */
  const clearSchedule = () => {
    setScheduleSet(false)
    setRecurrence(seedRecurrence())
    setLeadTimes([0])
    setConditions([])
    setExecutorDeviceId(undefined)
    // Whatever happened — saved, sent immediately instead, or the schedule
    // was simply cleared — this mount is no longer mid-edit of a specific
    // job afterward.
    setEditingJob(null)
  }

  const scheduleSummary = useMemo(() => summarizeRecurrence(recurrence), [recurrence])

  /**
   * The rule as text — except a one-off send, where "the rule" (`recur.
   * summary.once`, a fixed "仅一次"/"Once" with no `{time}` slot) says only
   * that it will not repeat and never the one thing this screen exists to
   * answer: when. Every other `kind` already names something concrete
   * ("每天" and friends), so this only swaps in the formatted `startAt` for
   * `'once'` rather than touching `summarizeRecurrence` itself, which other
   * screens (the recurrence editor's one-sentence description) still read
   * as the shorter, repeat-focused summary.
   */
  const scheduleRuleText = useMemo(
    () =>
      recurrence.kind === 'once'
        ? formatDateTime(recurrence.startAt)
        : t(scheduleSummary.key as TranslationKey, scheduleSummary.values),
    [recurrence, scheduleSummary, t, formatDateTime],
  )

  /**
   * B3 · 送达窗口 — the time in the box is not always the time it goes out.
   *
   * If someone in `To:` carries a delivery window, the scheduler will move this
   * send into their working day (`shapeOccurrences` → `applyDeliveryWindows`).
   * Without something here, the compose screen would state a send time the
   * application has already decided not to use — the same silent contradiction
   * the whole `whenbar` was added to end.
   *
   * `recurrence.startAt` is the instant asked about because it is the instant
   * this bar edits: the four `timeOfDay` rules keep it in step on every change
   * (see the field below), so it is always the clock time on screen.
   *
   * `windowsForRecipients` is `To:` only, deliberately mirroring
   * `windowsForDraft` in `AppState`. Two different answers here and there would
   * mean a promise the scheduler does not keep.
   */
  const delivery = useMemo(() => {
    const entries = windowsForRecipients(draft.to, state.contacts)
    if (entries.length === 0) return null
    const preview = previewFor(recurrence.startAt, entries)
    return worthShowing(preview) ? preview : null
  }, [draft.to, state.contacts, recurrence.startAt])

  /**
   * The whole per-recipient story, as a tooltip rather than as markup.
   *
   * Every pixel below the message box is taken off the message box — six
   * complaints, with measurements (PROJECT-BRIEF §6). So the marker itself is
   * one short phrase folded into the sentence that is already in
   * `.whenbar__text`, and the detail lives in `title`, which costs the layout
   * nothing at all.
   */
  const deliveryDetail = useMemo(() => {
    if (!delivery) return undefined
    const lines = delivery.entries.map((entry, index) => {
      const landing = delivery.result.perRecipient[index]
      const outcome =
        landing === undefined
          ? ''
          : landing.outcome === 'ignored'
            ? t('deliver.rowIgnored')
            : landing.outcome === 'impossible'
              ? t('deliver.rowImpossible')
              : landing.at === delivery.at
                ? t('deliver.rowInside')
                : t('deliver.rowMoved', { when: formatDateTime(landing.at) })
      return t('deliver.composeRow', {
        name: entry.name,
        zone: landing?.timeZone ?? entry.window.timeZone,
        theirTime: landing ? (wallTimeIn(delivery.at, landing.timeZone) ?? '—') : '—',
        outcome,
      })
    })
    if (delivery.splitRequired) lines.push(t('deliver.composeSplit'))
    lines.push(t('deliver.composeHint'))
    return [t('deliver.composeTitle'), ...lines].join('\n')
  }, [delivery, t, formatDateTime])

  /**
   * Who this is for and what it is about, on one line.
   *
   * The narrow layout folds the account, To, Cc, Bcc and subject fields away —
   * from the first paint now, not only once the message box has focus — and
   * something has to stay behind saying what was folded. A bar that reads only
   * "tap to expand" is a bar nobody can check their own draft against.
   *
   * Empty is returned as empty rather than as `validate.noRecipients`. On a fresh
   * draft, which is now the state this bar is *first seen* in, "No recipients"
   * reads as a verdict on a form that has not been filled in yet, and a verdict
   * is not an invitation to type. The bar renders the recipient field's own
   * placeholder instead and is styled as that field (see `.composesummary`), so
   * the folded state reads as the empty input it stands in for.
   */
  const headerSummary = useMemo(
    () => ({ to: draft.to.join(', '), subject: draft.subject.trim() }),
    [draft.to, draft.subject],
  )

  /**
   * The send time, as one line for the action bar.
   *
   * The whole `whenbar` is behind a button on a narrow screen, and "when does
   * this go out?" is the question this application exists to answer — it may
   * not be one tap away from being invisible. So the sentence the bar would
   * have shown is printed next to the button that opens it, delivery-window
   * marker and all, with the same per-recipient breakdown hanging off `title`.
   */
  const whenLine = useMemo(() => {
    const rule = scheduleRuleText
    if (!delivery) return rule
    const marker = delivery.impossible
      ? t('deliver.composeImpossible')
      : delivery.moved
        ? t('deliver.composeMoved', {
            when: formatDateTime(delivery.at),
            name: delivery.boundTo?.name ?? delivery.entries[0].name,
          })
        : t('deliver.composeSplitShort')
    return `${rule} · ${marker}`
  }, [scheduleRuleText, delivery, t, formatDateTime])

  /**
   * Rules whose fire time is `timeOfDay`, not `startAt`.
   *
   * `nextFireAfter` reads `timeOfDay` for all four of these and treats
   * `startAt` only as a floor — so the bar has to edit the field that decides,
   * or it edits nothing while looking like it edited something.
   */
  const firesAtTimeOfDay =
    recurrence.kind === 'daily' ||
    recurrence.kind === 'weekly' ||
    recurrence.kind === 'monthly' ||
    recurrence.kind === 'yearly'

  /** Anchored popovers close on Escape and on a click that lands elsewhere. */
  useEffect(() => {
    if (!quickOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown') {
        const target = e.target as HTMLElement | null
        if (target?.closest('.whenbar__quick')) return
      }
      setQuickOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
    }
  }, [quickOpen])

  const scheduleHasErrors = hasErrors([...validateRecurrence(recurrence), ...validateBurst(burst)])

  /**
   * Which stages of the chain to create. Only meaningful for a one-off — see
   * `buildChain` for why a repeating reminder has no "three days before" —
   * and never while editing: `confirmSchedule`'s edit branch updates exactly
   * the one job it was given, never `buildChain`, so a picker offering to
   * create *more* stages would promise something that branch does not do.
   */
  const chainable = recurrence.kind === 'once' && !editingJob
  const plannedStages = chainable
    ? CHAIN_STAGES.filter(
        (stage) => leadTimes.includes(stage.leadMs) && recurrence.startAt - stage.leadMs > Date.now(),
      )
    : []
  /** Stages the user ticked that have already gone by, so we can say so. */
  const skippedStages = chainable
    ? CHAIN_STAGES.filter(
        (stage) => leadTimes.includes(stage.leadMs) && recurrence.startAt - stage.leadMs <= Date.now(),
      )
    : []

  const confirmSchedule = async () => {
    if (scheduleHasErrors) return
    const now = Date.now()

    /*
     * Updating an existing job, not creating one — `scheduleDraft` already
     * does exactly the right thing given a job with a matching id
     * (`upsertJob` replaces in place rather than appending) and an existing
     * `runCount` (an `afterCount` end condition is measured against runs so
     * far, not reset to zero). Everything the job carries that this dialog
     * has no field for — `id`, `createdAt`, `chainId`, `chainLeadMs`,
     * `runCount`, `lastRunAt`, `lastResult`, `lastError` — comes from the
     * original job untouched via the spread.
     *
     * `status`/`enabled` are the one pair worth a comment: a job that was
     * paused stays paused (editing it is not a silent "resume"), but one that
     * was armed, done or failed is re-armed — the recurrence or conditions
     * may have just changed, and `scheduleDraft` is about to recompute
     * `occurrences` for it either way.
     */
    if (editingJob) {
      const updated: ScheduledJob = {
        ...editingJob,
        name: jobName.trim() || t('schedule.namePlaceholder'),
        draft: { ...draft },
        recurrence,
        retry,
        burst,
        conditions: conditions.length > 0 ? conditions : undefined,
        executorDeviceId,
        status: editingJob.enabled ? 'armed' : editingJob.status,
        updatedAt: now,
      }
      await scheduleDraft(updated)
      setScheduleOpen(false)
      toast.push({ tone: 'success', title: t('schedule.updated') })
      dispatch({ type: 'resetDraft', accountId: draft.accountId })
      clearSchedule()
      return
    }

    const base: Omit<ScheduledJob, 'id' | 'chainId'> = {
      name: jobName.trim() || t('schedule.namePlaceholder'),
      enabled: true,
      draft: { ...draft },
      recurrence,
      occurrences: [],
      runCount: 0,
      retry,
      burst,
      conditions: conditions.length > 0 ? conditions : undefined,
      executorDeviceId,
      status: 'armed',
      createdAt: now,
      updatedAt: now,
    }

    /*
     * The working calendar's gap-compose: several dates ctrl/cmd-clicked into
     * a batch, then "Compose for N dates" landed here with one draft. Each
     * date becomes its own independent `once` job at `SEEDED_HOUR` — the same
     * hour `nextComposeStart` seeds a single date at — sharing this draft but
     * nothing else: no `chainId`, because a chain is lead-time-before-one-
     * event and this is N unrelated events that happen to share a message.
     * Takes priority over the schedule on screen, which nobody touched to get
     * here — `RecurrenceEditor` still shows the ordinary next-whole-hour seed,
     * since consuming *this* queue is deliberately deferred to submit time
     * rather than done on mount alongside the single-date one.
     */
    const gapDates = takeComposeDates()
    if (gapDates && gapDates.length > 0) {
      for (const dayMs of gapDates) {
        const start = new Date(dayMs)
        start.setHours(SEEDED_HOUR, 0, 0, 0)
        const at = start.getTime()
        await scheduleDraft({
          ...base,
          id: newId('job'),
          recurrence: { ...defaultRecurrence(at), kind: 'once', startAt: at, timeOfDay: hhmm(at) },
          occurrences: [],
        })
      }
      setScheduleOpen(false)
      toast.push({ tone: 'success', title: t('compose.multiConfirm', { n: gapDates.length }) })
      dispatch({ type: 'resetDraft', accountId: draft.accountId })
      clearSchedule()
      return
    }

    // One reminder or several, built the same way — `buildChain` returns a
    // single job when only the event stage is selected.
    const jobs = buildChain(base, chainable ? leadTimes : [0], now)
    for (const job of jobs) {
      await scheduleDraft({
        ...job,
        name: job.chainLeadMs
          ? `${base.name} · ${t(leadLabelKey(job.chainLeadMs) as TranslationKey)}`
          : base.name,
      })
    }

    setScheduleOpen(false)
    toast.push({
      tone: 'success',
      title:
        jobs.length > 1
          ? t('chain.created', { n: jobs.length })
          : t('toast.scheduled', { when: '' }).replace(/\s*$/, ''),
    })
    dispatch({ type: 'resetDraft', accountId: draft.accountId })
    clearSchedule()
  }

  /**
   * The secondary controls, written once and rendered in two places.
   *
   * The top bar on a desktop window; the options sheet on a narrow one, where
   * there is no top bar left to put them in. They are the same controls either
   * way — a recovery route, a check, and a posture for the whole screen.
   *
   * Every one of them now carries an icon, and that is a bug fix rather than
   * decoration. The phone rule that drops `.btn__label` to fit four labelled
   * buttons into 284px has been in the stylesheet since this bar was built, and
   * `Button` renders its children *inside* that label — so the two buttons that
   * had never been given an `icon` rendered as blank 44x44 squares on exactly
   * the screens the rule exists for. One of them was the focus toggle, which is
   * this app's only full-height writing mode: its way in was invisible on every
   * screen that most needed it.
   */
  const draftTools = (
    <>
      <Button
        variant="ghost"
        icon={<IconFileText size={16} />}
        onClick={() => setHistoryOpen(true)}
        title={t('history.title')}
      >
        {t('history.title')}
        {state.draftSnapshots.length > 0 ? ` (${state.draftSnapshots.length})` : ''}
      </Button>
      <Button
        variant="ghost"
        icon={<IconSearch size={16} />}
        disabled={!started}
        onClick={() => setPreflightOpen(true)}
        title={t('preflight.button')}
      >
        {t('preflight.button')}
      </Button>
    </>
  )
  /* Not folded in with the other three: on a narrow screen this button opens
     the sheet that the other three are *inside*, so it belongs to the action
     bar rather than to the set it opens. */
  const moreOptionsButton = (
    <Button
      variant="ghost"
      icon={<IconSliders size={16} />}
      onClick={() => setMoreOpen((v) => !v)}
      aria-expanded={moreOpen}
      aria-controls={moreId}
      title={t('compose.moreOptions')}
    >
      {t('compose.moreOptions')}
    </Button>
  )
  /* Up here with the rest of the secondary controls rather than on the body's
     own label line: it is a posture for the whole screen, not a property of the
     field, and the label line is down to the two things that are about the text
     itself — the markup buttons and the count. */
  const focusToggle = (
    <Button
      variant="ghost"
      icon={focusMode ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
      onClick={() => setFocusMode((v) => !v)}
      title={t('compose.focusHint')}
    >
      {focusMode ? t('compose.focusExit') : t('compose.focusEnter')}
    </Button>
  )

  return (
    <>
      <div className="view view--compose" data-focus={focusMode} data-narrow={narrow || undefined}>
        <div className="view__inner">
          {/*
            Hidden in focus mode along with everything else that is not the
            message. The health strip is the one exception worth naming: it is
            suppressed here too, and that is a real trade — but it reports
            standing conditions that are equally visible the moment focus mode
            is left, and it is the largest single band between the title and
            the card.
          */}
          {focusMode ? null : (
            <>
              {/*
                The top bar. The screen's name on the left, everything
                secondary on the right, in one 36px band.

                It replaces the standard `PageHead`, which on this screen was a
                40px band holding a title that names the screen you are already
                looking at and a subtitle nobody has ever needed — and which
                could not be shortened further without shrinking type, because
                a heading is mostly the space around the heading. A bar sized
                by its buttons has no such floor.

                This full band — title plus the four secondary controls — is
                skipped on a narrow screen: 36px is 5% of a 360x800 phone
                spent on controls that are not what anybody opened this
                screen to do, and they move into the options sheet, which
                the action bar has a button for.

                What is not skipped is the title text itself. Without it a
                narrow screen had no answer to "new mail or editing an
                existing one" from the top of the screen at all — the only
                signal left was `.composesummary__edit`'s small "编辑中"
                badge, easy to miss and only present once there is
                something to fold. `.composetop--compact` below is that one
                line reinstated on its own, sized and padded to stay near
                20px rather than reopening the 36px band this replaced.
              */}
              {narrow ? (
                <div className="composetop composetop--compact">
                  <span className="composetop__title">
                    {editingJob ? t('compose.titleEditing') : t('compose.title')}
                  </span>
                </div>
              ) : (
                <div className="composetop">
                  <span className="composetop__title">
                    {editingJob ? t('compose.titleEditing') : t('compose.title')}
                  </span>
                  <div className="composebar">
                    {draftTools}
                    {moreOptionsButton}
                    {focusToggle}
                  </div>
                </div>
              )}

              {/* Whatever is quietly wrong, on the screen that gets opened most.
                  Absent entirely when there is nothing to report. */}
              <HealthBoard onGo={onNavigate} />

              {/* Anything the network stopped from leaving. Absent when empty. */}
              <OutboxStrip />
            </>
          )}

          {state.accounts.length === 0 ? (
            <Banner
              tone="warning"
              title={t('compose.noAccount')}
              action={
                <Button variant="primary" onClick={onGoToAccounts}>
                  {t('compose.addAccount')}
                </Button>
              }
            />
          ) : null}

          {/*
            One card, three bands: who it goes to, what it says, and when.

            The previous layout put addressing in a 420px left column and the
            message in a right column beside it. That was an improvement on the
            stacked form it replaced, but it capped the message at whatever was
            left after a column sized for a select box — and it made the two
            most important things on the screen (the message, and when it
            sends) compete for the same horizontal space as a subject line.

            Now the addressing is one compact row across the top, because a
            recipient and a subject are each one line of text and never needed
            a column of their own; the message takes the full width of the card
            and every pixel of height left over; and the attachment picker and
            the schedule sit together along the bottom, next to the buttons
            they belong with. Below 900px the top row stacks, which is the
            phone layout.
          */}
          <Card className="compose-card">
            <div className="card__body compose-layout">
              {/* --- band 1: who ------------------------------------------ */}
              {/*
                On a narrow screen this band is one line, once the message has
                been tapped into.

                Stacked, the account select, the recipient chips, the Cc/Bcc
                pair and the subject measure 150-228px of a 360x800 phone —
                between a fifth and a third of the screen, held open for fields
                that are each answered once and then not looked at again. The
                summary line is 40px and says what they hold, so nothing is
                hidden, only folded; tapping it puts them all back.

                Rendered rather than hidden. A `display: none` block still owns
                its ids and its tab stops, and a form whose invisible half can
                take focus is the kind of thing that is only ever found by the
                person it happens to.
              */}
              {narrow && !headerOpen ? (
                <button
                  type="button"
                  className="composesummary"
                  onClick={() => setHeaderOpen(true)}
                  aria-expanded={false}
                  aria-controls={headId}
                  aria-label={t('compose.editHeader')}
                  title={t('compose.editHeader')}
                >
                  {/* Only the collapsed summary bar carries this — the one place
                      `narrow` was asked to gain a permanent element rather than
                      lose one. Kept to a flex-shrink:0 pill so it never claims
                      the ellipsis room the to/subject text already fights for. */}
                  {editingJob ? (
                    <span className="composesummary__edit">{t('compose.editingBadge')}</span>
                  ) : null}
                  {/* `data-empty` is what makes this read as an input rather
                      than as a missing field: the placeholder tone, and the
                      dashed border in `app.css`, both hang off it. A user who
                      cannot find where to type the recipient is a worse outcome
                      than a small message box, so the empty state of this bar
                      gets more design attention than the filled one. */}
                  <span
                    className="composesummary__to"
                    data-empty={headerSummary.to ? undefined : 'true'}
                  >
                    {headerSummary.to || t('compose.recipientPlaceholder')}
                  </span>
                  <span
                    className="composesummary__subject"
                    data-empty={headerSummary.subject ? undefined : 'true'}
                  >
                    {headerSummary.subject || t('compose.subjectPlaceholder')}
                  </span>
                  <IconChevronDown size={16} className="composesummary__chev" />
                </button>
              ) : (
                <>
                  <div className="compose-head" id={headId}>
                    {state.accounts.length > 1 ? (
                      <Field label={t('compose.account')}>
                        {/* Grouped once there is more than one group to show —
                            a single `<optgroup>` wrapping everything is visual
                            noise that says nothing. */}
                        <select
                          className="select"
                          value={draft.accountId}
                          onChange={(e) => patch({ accountId: e.target.value })}
                        >
                          {accountGroups.length > 1
                            ? accountGroups.map((group) => (
                                <optgroup
                                  key={group.name ?? '_'}
                                  label={group.name ?? t('account.ungrouped')}
                                >
                                  {group.accounts.map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {accountLabel(a)} — {a.fromAddress}
                                    </option>
                                  ))}
                                </optgroup>
                              ))
                            : state.accounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {accountLabel(a)} — {a.fromAddress}
                                </option>
                              ))}
                        </select>
                      </Field>
                    ) : null}

                    {/* Cc/Bcc rides on the label line rather than buying a hint
                        row underneath: this row sets the height of everything
                        below it, and a 32px row to hold one link is 32px taken
                        off the message. */}
                    <Field
                      label={t('compose.to')}
                      htmlFor={toId}
                      labelHint={
                        <button
                          type="button"
                          className="link"
                          onClick={() => setShowCcBcc((v) => !v)}
                        >
                          {t('compose.showCcBcc')}
                        </button>
                      }
                    >
                      <TagField
                        id={toId}
                        values={draft.to}
                        onChange={(v) => patch({ to: v })}
                        placeholder={t('compose.recipientPlaceholder')}
                        suggestions={state.contacts}
                        recents={state.recentRecipients}
                        pickerLabel={t('compose.to')}
                      />
                    </Field>

                    <Field label={t('compose.subject')} htmlFor={subjectId}>
                      <input
                        id={subjectId}
                        className="input"
                        value={draft.subject}
                        maxLength={998}
                        placeholder={t('compose.subjectPlaceholder')}
                        onChange={(e) => patch({ subject: e.target.value })}
                      />
                    </Field>
                  </div>

                  {showCcBcc ? (
                    <div className="compose-head compose-head--extra">
                      <Field label={t('compose.cc')}>
                        <TagField
                          values={draft.cc}
                          onChange={(v) => patch({ cc: v })}
                          suggestions={state.contacts}
                          recents={state.recentRecipients}
                          pickerLabel={t('compose.cc')}
                        />
                      </Field>
                      <Field label={t('compose.bcc')}>
                        <TagField
                          values={draft.bcc}
                          onChange={(v) => patch({ bcc: v })}
                          suggestions={state.contacts}
                          recents={state.recentRecipients}
                          pickerLabel={t('compose.bcc')}
                        />
                      </Field>
                    </div>
                  ) : null}
                </>
              )}

              {/* --- band 2: what ----------------------------------------- */}
              {/* The body is the one thing this whole screen exists to
                  collect, so it is the one field allowed to grow: full card
                  width, and every pixel of height the other two bands do not
                  need.

                  No placeholder. The label already says "Body" and the
                  placeholder said it a second time three pixels below —
                  literally the same word twice, which read as a rendering
                  fault rather than as guidance. The merge syntax it used to
                  advertise is discoverable through the variable chips below
                  the moment a `{{token}}` is typed. */}
              <Field
                label={t('compose.body')}
                htmlFor={bodyId}
                action={
                  <div className="field__tools">
                    {/*
                      On the label line, not on a row of its own.

                      Its own row cost 44px and measured out at a body box of
                      260px against 304px before it — and pushed the
                      options-open state into 11px of scroll, which this form
                      is not allowed to do. That is the same reason `labelHint`
                      exists, written down two hundred lines above this and
                      then ignored here.

                      Always available, and using it decides the format: the
                      body-format picker was removed on purpose because the
                      right answer is derivable, and pressing Bold is the
                      moment the answer becomes "Markdown". Hidden once the
                      body is already HTML — which only happens after an
                      embedded image — because inserting `**bold**` there would
                      put literal asterisks in the message.
                    */}
                    {draft.bodyFormat !== 'html' ? (
                      <MarkupToolbar
                        textarea={bodyRef}
                        onChange={(body) => patch({ body, bodyFormat: 'markdown' })}
                      />
                    ) : null}
                    {/*
                      A live count, and not only of characters.

                      Bytes are what a provider's size limit is actually
                      counted in, and one Chinese character is three of them
                      in UTF-8 — so a draft that looks half the length of the
                      limit can be over it. The two numbers disagreeing is the
                      information.
                    */}
                    <span className="field__count" aria-live="polite">
                      {t('compose.bodyCount', bodyCount)}
                    </span>
                    {/* The way out, and only in the mode that needs one. The
                        toggle lives in the top bar — which focus mode takes off
                        the screen, so without this the only exits would be two
                        keys nobody was told about. Entering is a button; leaving
                        has to be one too. */}
                    {focusMode ? (
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => setFocusMode(false)}
                        title={t('compose.focusHint')}
                      >
                        {t('compose.focusExit')}
                      </button>
                    ) : null}
                  </div>
                }
              >
                {/*
                  Markdown, inserted into the same plain textarea.

                  Shown only when the draft is being written as Markdown or
                  HTML — inserting `**bold**` into a plain-text message would
                  put literal asterisks in the recipient's inbox, which is the
                  opposite of formatting it.
                */}
                <textarea
                  id={bodyId}
                  ref={bodyRef}
                  className="textarea textarea--body"
                  value={draft.body}
                  onPaste={handleBodyPaste}
                  onChange={(e) => patch({ body: e.target.value })}
                  onMouseUp={rememberBodyHeight}
                  /* Tapping into the message is the moment the addressing
                     block stops being what the screen is for, so that is the
                     moment it folds away — no third control to learn, and no
                     state the user has to think about maintaining. Nothing
                     happens on a wide window, where the block costs the
                     message nothing it cannot spare. */
                  onFocus={() => {
                    if (narrow) setHeaderOpen(false)
                  }}
                />
              </Field>

              {/* The pictures the message carries, as pictures.
                  Absent entirely when there are none, so it costs the layout
                  nothing on the ordinary text-only draft — and when there are
                  some, seeing them is the whole point of having added them.
                  One click opens the full-screen viewer. */}
              <ImageStrip images={gallery} onOpen={setLightboxAt} label={t('image.inBody')} />

              {/* Mail merge. Offered only once there is a `{{token}}` to merge:
                  a switch that does nothing until you learn an undocumented
                  syntax is a switch that teaches nobody anything. */}
              {hasVars(draft) || draft.mergeEnabled ? (
                <Switch
                  checked={draft.mergeEnabled === true}
                  onChange={(v) => patch({ mergeEnabled: v })}
                  title={t('merge.title')}
                />
              ) : null}

              {/* The tokens the draft actually carries, as chips. They used to
                  be introduced by a grey "Variables in this message:" — a
                  caption for a row of `{{name}}` chips that is already only
                  ever one thing. */}
              {hasVars(draft) ? (
                <div className="mergevars">
                  {[...new Set([...usedVars(draft.subject), ...usedVars(draft.body)])].map((name) => (
                    <span key={name} className="chip">
                      {`{{${name}}}`}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* --- band 3: when, and what rides along --------------------

                  Three sections that are inline on a desktop window and behind
                  a button on a narrow one — see `ComposeSheet`. The wrapper
                  goes around the existing markup rather than replacing it: the
                  attachment picker and the send-time bar are the same controls
                  in both places, and a second, phone-shaped copy of either is
                  a second place for them to drift out of step.
              */}
              <div className="compose-foot">
                <ComposeSheet
                  narrow={narrow}
                  open={narrow ? sheet === 'attachments' : true}
                  title={t('compose.attachments')}
                  closeLabel={t('common.close')}
                  onClose={() => setSheet(null)}
                >
                  <Field label={t('compose.attachments')}>
                    <AttachmentPicker
                      attachments={draft.attachments}
                      onAdd={addAttachments}
                      onRemove={(id) =>
                        patch({ attachments: draft.attachments.filter((a) => a.id !== id) })
                      }
                      onToggleInline={toggleInline}
                      presence={attachmentPresence}
                      onDropPaths={bridge?.pathForFile ? dropAttachments : undefined}
                      thumbnails={thumbnails}
                      onPreview={(id) => {
                        const at = gallery.findIndex((g) => g.id === id)
                        if (at >= 0) setLightboxAt(at)
                      }}
                    />
                  </Field>
                </ComposeSheet>

                {/*
                  When it sends, on the screen where it is written.

                  This used to be knowable only by opening the Schedule dialog:
                  the recurrence lived inside it, was reset every time it
                  opened, and the compose screen showed nothing at all. So the
                  answer to "when does this go out?" — the question the whole
                  application exists to answer — was two clicks away and gone
                  again the moment the dialog closed.

                  Setting a time here is a `datetime-local`, which is the whole
                  interaction for the common case (a one-off reminder). Repeats,
                  retries, chains and conditions stay in the dialog, one click
                  away, because those are the rare ones.

                  The control shown depends on which rule is live, because a
                  `datetime-local` is only the right control for two of the
                  seven. `daily`/`weekly`/`monthly`/`yearly` fire at
                  `timeOfDay` and treat `startAt` as a floor (see
                  `nextFireAfter` in schedule.ts), so a date-and-time box there
                  edited a field that does not decide anything: you could
                  change "every weekday at 09:00" to read 14:30 in this bar and
                  the reminder would still go out at 09:00, with nothing on
                  screen admitting it. Those rules get a `time` box bound to
                  the field that actually fires. `cron` gets no editor at all —
                  the expression is the rule, and it belongs in the dialog.
                */}
                <ComposeSheet
                  narrow={narrow}
                  open={narrow ? sheet === 'when' : true}
                  title={t('compose.sendsAt')}
                  closeLabel={t('common.close')}
                  onClose={() => setSheet(null)}
                >
                  <Field label={t('compose.sendsAt')} htmlFor={whenId}>
                    <div className="whenbar">
                      {recurrence.kind === 'cron' ? (
                        <output
                          id={whenId}
                          className="input whenbar__time whenbar__cron mono"
                          title={recurrence.cron || undefined}
                        >
                          {recurrence.cron || '—'}
                        </output>
                      ) : firesAtTimeOfDay ? (
                        <input
                          id={whenId}
                          className="input whenbar__time"
                          type="time"
                          value={recurrence.timeOfDay}
                          onChange={(e) => {
                            const value = e.target.value
                            if (!value) return
                            setRecurrence((r) => ({
                              ...r,
                              timeOfDay: value,
                              // Keep the anchor on the same clock time. `startAt`
                              // is a floor for these rules, and leaving it on the
                              // old minute makes the dialog and this bar disagree
                              // about a value they share.
                              startAt: fromLocalInput(
                                `${toLocalInput(r.startAt).slice(0, 10)}T${value}`,
                                r.startAt,
                              ),
                            }))
                            setScheduleSet(true)
                          }}
                        />
                      ) : (
                        <input
                          id={whenId}
                          className="input whenbar__time"
                          type="datetime-local"
                          /* Seeded, not blank. See `seedRecurrence`. */
                          value={toLocalInput(recurrence.startAt)}
                          onChange={(e) => {
                            setRecurrence((r) => {
                              const at = fromLocalInput(e.target.value, r.startAt)
                              return { ...r, startAt: at, timeOfDay: hhmm(at) }
                            })
                            setScheduleSet(true)
                          }}
                        />
                      )}

                      {/*
                        The four times people actually pick, without charging the
                        message box a row for them.

                        A visible chip row here would be ~40px, and every pixel
                        spent below the body is taken straight off the body — the
                        one complaint this screen has collected more than any
                        other. So they hang in a popover anchored to the field:
                        open costs nothing above the fold, closed costs nothing
                        at all.
                      */}
                      {recurrence.kind === 'cron' ? null : (
                        <div className="whenbar__quick">
                          <button
                            type="button"
                            className="btn btn--ghost btn--icon whenbar__quickbtn"
                            aria-label={t('schedule.quickTimes')}
                            title={t('schedule.quickTimes')}
                            aria-expanded={quickOpen}
                            onClick={() => setQuickOpen((v) => !v)}
                          >
                            <IconClock size={16} />
                          </button>
                          {quickOpen ? (
                            <div
                              className="popover whenbar__picks"
                              role="group"
                              aria-label={t('schedule.quickTimes')}
                            >
                              {quickTimes(Date.now()).map((o) => (
                                <button
                                  key={o.key}
                                  type="button"
                                  className="chip chip--toggle"
                                  aria-pressed={Math.abs(recurrence.startAt - o.at) < 60_000}
                                  onClick={() => {
                                    setRecurrence((r) => ({
                                      ...r,
                                      startAt: o.at,
                                      timeOfDay: hhmm(o.at),
                                    }))
                                    setScheduleSet(true)
                                    setQuickOpen(false)
                                  }}
                                >
                                  {t(o.key as TranslationKey)}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )}

                      <div className="whenbar__text">
                        <span className="whenbar__rule">{scheduleRuleText}</span>
                        {plannedStages.length > 1 ? (
                          <span className="whenbar__count">
                            {t('chain.willCreate', { n: plannedStages.length })}
                          </span>
                        ) : null}
                        {/*
                          B3 · 送达窗口 — folded into this sentence, not given a
                          row. `.whenbar__text` already wraps and already carries a
                          second conditional span beside it (`.whenbar__count`);
                          this is a third inline sibling on the same line, so the
                          bar's height stays what its 46px controls make it and
                          the message box loses nothing. The per-recipient detail
                          is in `title` for the same reason.
                        */}
                        {delivery ? (
                          <span className="whenbar__window" title={deliveryDetail}>
                            {delivery.impossible
                              ? t('deliver.composeImpossible')
                              : delivery.moved
                                ? t('deliver.composeMoved', {
                                    when: formatDateTime(delivery.at),
                                    name: delivery.boundTo?.name ?? delivery.entries[0].name,
                                  })
                                : t('deliver.composeSplitShort')}
                          </span>
                        ) : null}
                      </div>
                      <Button variant="ghost" onClick={openSchedule}>
                        {t('schedule.moreRules')}
                      </Button>
                    </div>
                  </Field>
                </ComposeSheet>

                {/* Closed, this is nothing at all — not a collapsed row.
                    Priority, per-recipient delivery and read receipts are
                    decided once and then left alone for months, and the
                    disclosure that used to hold them charged the message box
                    59px for the privilege of being closed. The control that
                    opens this now lives in the page head, which was empty.

                    On a narrow screen there is no page head to open it from, so
                    it is the third button in the action bar — and the sheet it
                    opens is also where draft history, the send preview and the
                    focus toggle go, since the bar that used to hold them is
                    itself gone. */}
                <ComposeSheet
                  narrow={narrow}
                  open={narrow ? sheet === 'more' : moreOpen}
                  title={t('compose.moreOptions')}
                  closeLabel={t('common.close')}
                  onClose={() => setSheet(null)}
                >
                  {narrow ? (
                    <div className="composebar composebar--sheet">
                      {draftTools}
                      {focusToggle}
                    </div>
                  ) : null}
                  <div className="moreoptions" id={moreId}>
                    {/* The body-format picker is gone on purpose. It asked people
                      to choose between plain, HTML and Markdown before writing
                      a word, when the right answer is always derivable:
                      pasting or embedding an image needs HTML and switches to
                      it by itself (see `toggleInline` and `handleBodyPaste`),
                      and everything else is plain text. `draft.bodyFormat`
                      still exists and is still what the transport reads — it is
                      simply no longer a question anyone is asked. */}
                    <div className="moreoptions__grid">
                      <Field label={t('compose.priority')}>
                        <Segmented
                          value={draft.priority}
                          onChange={(v: Priority) => patch({ priority: v })}
                          options={[
                            { value: 'low', label: t('compose.priorityLow') },
                            { value: 'normal', label: t('compose.priorityNormal') },
                            { value: 'high', label: t('compose.priorityHigh') },
                          ]}
                        />
                      </Field>
                      {/* Both of these said the same thing twice: the switch
                          is called "Send individually to each recipient" and
                          carried a grey line underneath reading "Recipients
                          never see each other's addresses", which is what
                          sending individually *is*. */}
                      <Switch
                        checked={draft.individualDelivery}
                        onChange={(v) => patch({ individualDelivery: v })}
                        title={t('compose.individualDelivery')}
                      />
                      <Switch
                        checked={draft.requestReadReceipt}
                        onChange={(v) => patch({ requestReadReceipt: v })}
                        title={t('compose.readReceipt')}
                      />
                    </div>
                  </div>
                </ComposeSheet>
              </div>
            </div>
          </Card>

          {/* One box, and only once there is something to be wrong about.
              An untouched form used to open with four stacked red banners —
              242px of alarm telling the user off for not having typed yet.
              Blank is not an error: the action bar already says what is
              missing, and Send is disabled until it is not. */}
          {started && bannerIssues.length > 0 ? (
            <div
              className={`banner banner--${bannerIssues.some((i) => i.severity === 'error') ? 'danger' : 'warning'}`}
            >
              <ul className="banner__list">
                {bannerIssues.map((issue, i) => (
                  <li key={`${issue.key}-${i}`}>
                    {t(issue.key as 'validate.noRecipients', issue.values)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {/* The answer to "did it actually send?", kept until dismissed.

          `data-narrow` from the same flag the action bar reads: the banner sticks
          to the top of that bar, and the height it sticks at has to be the height
          the bar actually has. See `.sendresult[data-narrow]`. */}
      {outcome ? (
        <div className="sendresult" data-ok={outcome.ok} data-narrow={narrow || undefined}>
          <Banner
            tone={outcome.ok ? 'success' : 'danger'}
            title={outcome.ok ? t('result.sentTitle') : t(errorTitleKey(outcome))}
            action={
              <Button variant="ghost" onClick={() => setOutcome(null)}>
                {t('result.dismiss')}
              </Button>
            }
          >
            {outcome.ok ? (
              t('result.sentBody', {
                n: outcome.accepted.length,
                ms: outcome.durationMs,
                host: outcome.diagnostics
                  ? `${outcome.diagnostics.host}:${outcome.diagnostics.port}`
                  : (account?.host ?? ''),
              })
            ) : (
              <>
                {outcome.error ? <div className="mono">{outcome.error}</div> : null}
                {(() => {
                  const key = advisoryKey(
                    outcome.errorKind,
                    outcome.diagnostics?.port ?? account?.port ?? 0,
                    outcome.diagnostics?.securityUsed ?? account?.security ?? 'ssl',
                    { host: outcome.diagnostics?.host ?? account?.host, message: outcome.error },
                  )
                  return key ? <div style={{ marginTop: 'var(--sp-2)' }}>{t(key as 'error.tlsHint')}</div> : null
                })()}
              </>
            )}

            {/* Folded by default. On a good day none of this is interesting;
                on the day it is, it is the difference between "send failed"
                and "TLS handshake on :465, connected on :587 instead". */}
            <button
              type="button"
              className="link"
              style={{ marginTop: 'var(--sp-2)' }}
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
            >
              {detailsOpen ? t('senddetails.hide') : t('senddetails.show')}
            </button>
            {detailsOpen ? <SendResultDetails result={outcome} account={account} /> : null}
          </Banner>
        </div>
      ) : null}

      {/* The two buttons that matter, always visible. */}
      <div className="actionbar" data-narrow={narrow || undefined}>
        {/*
          Two different bars, because they are answering two different
          questions.

          Wide: a two-line summary of the draft — who it is going to, how many
          files, which address it leaves from, what it weighs on the wire — and
          the two buttons that send it. It wraps to 96px on a phone, and the
          second line is hidden there already, so most of that height is spent
          on air around a sentence.

          Narrow: one 52px row that is the form's missing third of the screen.
          The attachment picker and the send-time bar are behind the first two
          buttons, the options panel behind the third, and the send-time
          sentence rides on the button that opens it — that question may not be
          one tap away from being unanswerable. "Schedule" is not duplicated
          here: it is the same `openSchedule` the "Repeat, retry, conditions…"
          button inside the send-time sheet already calls, and a second copy
          would cost the row the width the sentence needs.
        */}
        {narrow ? (
          <div className="composeacts">
            <button
              type="button"
              className="btn btn--ghost btn--icon composeacts__btn"
              aria-label={t('compose.attachments')}
              title={t('compose.attachments')}
              onClick={() => setSheet('attachments')}
            >
              <IconPaperclip size={18} />
              {draft.attachments.length > 0 ? (
                <span className="composeacts__badge">{draft.attachments.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="btn btn--ghost composeacts__when"
              title={deliveryDetail ?? whenLine}
              onClick={() => setSheet('when')}
            >
              <IconClock size={17} />
              <span className="composeacts__whentext">{whenLine}</span>
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon composeacts__btn"
              aria-label={t('compose.moreOptions')}
              title={t('compose.moreOptions')}
              aria-expanded={sheet === 'more'}
              onClick={() => setSheet('more')}
            >
              <IconSliders size={18} />
            </button>
          </div>
        ) : (
          <div className="actionbar__summary">
            <div className="actionbar__line">
              {recipientCount > 0
                ? t('logs.recipients', { n: recipientCount })
                : t('validate.noRecipients')}
              {draft.attachments.length > 0
                ? ` · ${t('compose.attachmentCount', {
                    n: draft.attachments.length,
                    size: formatBytes(rawBytes),
                  })}`
                : ''}
            </div>
            {account ? (
              <div className="actionbar__meta">
                {account.fromAddress}
                {preset?.dailyLimit
                  ? ` · ${t('compose.dailyLimit', { n: preset.dailyLimit })}`
                  : ''}
                {rawBytes > 0
                  ? ` · ${t('compose.onTheWire', { size: formatBytes(encodedSize(rawBytes)) })}`
                  : ''}
              </div>
            ) : null}
          </div>
        )}

        {/* Draft history and the send preview used to sit here. They are a
            recovery route and a check — neither is what this bar is for, and
            both are now in the page head with the rest of the secondary
            controls. What is left is the two buttons that send. */}
        {narrow ? null : (
          <Button
            size="lg"
            variant="secondary"
            icon={<IconClock size={17} />}
            disabled={blocked || sending}
            onClick={openSchedule}
          >
            {t('compose.schedule')}
          </Button>
        )}
        {/*
          The one button a phone has room for cannot always say "send now" —
          `doSend` calls `sendDraftNow`, unconditionally, so a phone with no
          second button to fall back on was sending immediately no matter
          what the "when" bar above said, `scheduleSet` included. The wide
          layout never had this bug: its second button is the one that opens
          the schedule dialog, sitting right next to a "send now" that always
          means what it says.

          `scheduleSet` is the same flag the "when" bar already sets the
          moment a time or a repeat rule is touched, so this button starts
          agreeing with it rather than a moment later. Tapping it opens the
          schedule dialog rather than arming the job directly — the same one
          click the wide layout's own Schedule button opens — because that
          dialog is where retries, chains and conditions still live, and
          skipping it would silently drop whatever a returning user had set
          there.
        */}
        {narrow && scheduleSet ? (
          <Button
            size="lg"
            variant="primary"
            icon={<IconClock size={17} />}
            disabled={blocked || sending}
            onClick={openSchedule}
          >
            {t('compose.schedule')}
          </Button>
        ) : (
          <Button
            size="lg"
            variant="primary"
            icon={<IconSend size={17} />}
            disabled={blocked}
            loading={sending}
            onClick={doSend}
          >
            {sending
              ? t('compose.sending')
              : preflight.messageCount > 1
                ? t('compose.sendNowN', { n: preflight.messageCount })
                : t('compose.sendNow')}
          </Button>
        )}
      </div>

      <PreflightDialog
        open={preflightOpen}
        report={preflight}
        sending={sending}
        outlook={outlook}
        retry={scheduleSet ? retry : null}
        confirmLabel={t('compose.sendNow')}
        onClose={() => setPreflightOpen(false)}
        onConfirm={() => {
          setPreflightOpen(false)
          void doSend()
        }}
      />

      <DraftHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />

      <Modal
        open={scheduleOpen}
        wide
        title={editingJob ? t('schedule.edit') : t('schedule.new')}
        onClose={() => setScheduleOpen(false)}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<IconClock size={16} />}
              onClick={confirmSchedule}
              disabled={scheduleHasErrors}
            >
              {editingJob ? t('schedule.saveChanges') : t('compose.schedule')}
            </Button>
          </>
        }
      >
        <Field label={t('schedule.name')}>
          <input
            className="input"
            value={jobName}
            placeholder={t('schedule.namePlaceholder')}
            onChange={(e) => setJobName(e.target.value)}
          />
        </Field>

        <div
          className="banner banner--info"
          style={{ alignItems: 'center' }}
        >
          <IconMail size={15} className="banner__icon" />
          <div className="banner__body">
            <strong>{draft.subject || '(no subject)'}</strong>
            <div style={{ opacity: 0.85 }}>{t('logs.recipients', { n: recipientCount })}</div>
          </div>
        </div>

        {/* Multi-stage reminders. Offered only for one-offs: "every Monday,
            and also three days before every Monday" is not a sentence anyone
            means.

            No hint row on the field. "Creates one reminder per stage, all
            pointing at the same moment" restated the chips underneath it, and
            the count of what will really be created is printed below them from
            the stages that are actually ticked. */}
        {chainable ? (
          <Field label={t('chain.title')}>
            <div className="btn-row" style={{ flexWrap: 'wrap' }}>
              {CHAIN_STAGES.map((stage) => {
                const on = leadTimes.includes(stage.leadMs)
                const gone = recurrence.startAt - stage.leadMs <= Date.now()
                return (
                  <button
                    key={stage.leadMs}
                    type="button"
                    className="chip chip--toggle"
                    aria-pressed={on}
                    data-gone={gone ? 'true' : undefined}
                    title={gone ? t('chain.alreadyPast') : undefined}
                    onClick={() =>
                      setLeadTimes((prev) =>
                        prev.includes(stage.leadMs)
                          ? prev.filter((ms) => ms !== stage.leadMs)
                          : [...prev, stage.leadMs],
                      )
                    }
                  >
                    {t(stage.labelKey as TranslationKey)}
                  </button>
                )
              })}
            </div>
            {plannedStages.length > 1 ? (
              <div className="field__hint">
                {t('chain.willCreate', { n: plannedStages.length })}
              </div>
            ) : null}
            {skippedStages.length > 0 ? (
              <div className="field__hint" style={{ color: 'var(--warning)' }}>
                {t('chain.skipping', {
                  stages: skippedStages
                    .map((stage) => t(stage.labelKey as TranslationKey))
                    .join('、'),
                })}
              </div>
            ) : null}
          </Field>
        ) : null}

        <RecurrenceEditor
          recurrence={recurrence}
          onChange={(next) => {
            setRecurrence(next)
            // Touching anything in here is choosing a send time, which is what
            // the bar on the compose screen reads to decide whether it has
            // something true to say.
            setScheduleSet(true)
          }}
          retry={retry}
          onRetryChange={setRetry}
          burst={burst}
          onBurstChange={setBurst}
        />

        {/* Only shown once a second device is actually paired for ongoing sync
            — offering "which device sends this" to someone who has never
            paired anything would be a control with exactly one meaningful
            answer, on a screen already asking for a lot. See
            `ScheduledJob.executorDeviceId`. */}
        {state.pairedDevices.some((d) => d.mode === 'ongoing') ? (
          <Field label={t('schedule.executor.label')} hint={t('schedule.executor.hint')}>
            <select
              className="input"
              value={executorDeviceId ?? ''}
              onChange={(e) => setExecutorDeviceId(e.target.value || undefined)}
            >
              <option value="">{t('schedule.executor.any')}</option>
              <option value={state.settings.localDeviceId ?? ''}>{t('schedule.executor.thisDevice')}</option>
              {state.pairedDevices
                .filter((d) => d.mode === 'ongoing')
                .map((d) =>
                  d.remoteDeviceId ? (
                    <option key={d.id} value={d.remoteDeviceId}>
                      {d.label}
                    </option>
                  ) : (
                    <option key={d.id} value="" disabled>
                      {t('schedule.executor.pending', { device: d.label })}
                    </option>
                  ),
                )}
            </select>
          </Field>
        ) : null}

        {/* Fire-time checks. Only offered where they can actually be enforced:
            the desktop scheduler can read the disk, the browser build cannot,
            and offering a rule that will always report "could not check" is
            offering a rule that does nothing. */}
        <ConditionEditor
          conditions={conditions}
          onChange={setConditions}
          filesystemAvailable={bridge?.platform === 'desktop'}
          inboxAvailable={state.inboxAccounts.some((i) => i.enabled)}
        />

        {/* The title alone. The sentence under it explained what locking a copy
            buys you, which is a thing to say once in Settings — where the
            setting itself lives, and where that same line still is — not on
            every dialog that reports the setting is on. */}
        {state.settings.snapshotAttachments && draft.attachments.length > 0 ? (
          <Banner tone="info" title={t('schedule.snapshot')} />
        ) : null}
      </Modal>

      {/* Above everything, including the schedule dialog — a picture opened
          from inside a dialog has to be readable, and Escape here closes the
          picture only (see the capture-phase handler in `ImageLightbox`). */}
      {lightboxAt !== null && gallery[lightboxAt] ? (
        <ImageLightbox
          images={gallery}
          index={lightboxAt}
          onIndex={setLightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      ) : null}

      {confirmElement}
    </>
  )
}
