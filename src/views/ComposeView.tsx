/**
 * The screen the app opens on.
 *
 * Layout priority is deliberate: recipient → subject → body → attachments,
 * then a sticky action bar that keeps "Send now" and "Schedule" on screen at
 * every window height. Those two buttons are the whole product; nothing is
 * allowed to push them below the fold.
 */

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import {
  Banner,
  Button,
  Card,
  Field,
  Modal,
  PageHead,
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
import { CHAIN_STAGES, buildChain, leadLabelKey } from '../core/chain'
import { summarizeRecurrence } from '../core/schedule'
import { upcoming } from '../core/upcoming'
import { HealthBoard } from '../components/HealthBoard'
import { RecurrenceEditor, fromLocalInput, toLocalInput } from '../components/RecurrenceEditor'
import { ConditionEditor } from '../components/ConditionEditor'
import { DraftHistory } from '../components/DraftHistory'
import { OutboxStrip } from '../components/OutboxStrip'
import { MarkupToolbar } from '../components/MarkupToolbar'
import { PreflightDialog, useFilePresence, usePreflight } from '../components/PreflightDialog'
import { SendResultDetails } from '../components/SendDetails'
import { IconClock, IconFileText, IconMail, IconSearch, IconSend } from '../components/icons'
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

export function ComposeView({
  onGoToAccounts,
  onNavigate,
}: {
  onGoToAccounts: () => void
  /** Where the health strip sends you to fix what it found. */
  onNavigate?: (where: 'schedule' | 'settings' | 'compose' | 'logs') => void
}) {
  const { state, dispatch, sendDraftNow, scheduleDraft, snapshotDraft, bridge } = useApp()
  const { t, formatBytes } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()

  const [showCcBcc, setShowCcBcc] = useState(false)
  const [sending, setSending] = useState(false)
  const [preflightOpen, setPreflightOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  /** Fire-time checks attached to the job being scheduled, not to the draft. */
  const [conditions, setConditions] = useState<SendCondition[]>([])
  /** The last send, kept on screen until dismissed or superseded. */
  const [outcome, setOutcome] = useState<SendResult | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  /**
   * Whether the send time on screen is one the user chose.
   *
   * `recurrence` always holds a valid value (five minutes from now), so it
   * cannot answer this by itself — and a screen that says "sends at 14:32"
   * about a time nobody picked is worse than one that says nothing. Cleared
   * with the draft, so the next reminder does not inherit the last one's time.
   */
  const [scheduleSet, setScheduleSet] = useState(false)
  const [jobName, setJobName] = useState('')
  /** Lead times ticked in the chain picker. `[0]` is "just the event itself". */
  const [leadTimes, setLeadTimes] = useState<number[]>([0])
  const [recurrence, setRecurrence] = useState<Recurrence>(() => defaultRecurrence())
  const [retry, setRetry] = useState<RetryPolicy>(DEFAULT_RETRY)
  const [burst, setBurst] = useState<BurstPolicy>(DEFAULT_BURST)

  const toId = useFieldId('to')
  const subjectId = useFieldId('subject')
  const bodyId = useFieldId('body')

  /**
   * The body box remembers how tall it was dragged.
   *
   * `localStorage` rather than settings: it is a property of this window on
   * this screen, not of the account or the document, and syncing it into
   * `state.json` would mean a laptop and a desktop fighting over one number.
   */
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const saved = localStorage.getItem(BODY_HEIGHT_KEY)
    if (saved && bodyRef.current) bodyRef.current.style.height = saved
  }, [])
  const rememberBodyHeight = () => {
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

  const [focusMode, setFocusMode] = useState(false)
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
  const limitMb = Math.round(limitBytes / 1048576)

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
  const recipientCount = draft.to.length + draft.cc.length + draft.bcc.length
  /** Has the user put anything in the draft yet? Nothing is "wrong" until so. */
  const started =
    recipientCount > 0 ||
    draft.subject.trim().length > 0 ||
    draft.body.trim().length > 0 ||
    draft.attachments.length > 0
  const rawBytes = totalAttachmentBytes(draft.attachments)

  const patch = (p: Partial<MessageDraft>) => dispatch({ type: 'setDraft', patch: p })

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
    if (!bridge?.prewarm || !account?.id || !account.hasSecret) return
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
    setJobName(draft.subject.trim() || t('schedule.namePlaceholder'))
    // The time the user already picked on the compose screen is kept. Resetting
    // it unconditionally — which is what this did when the dialog was the only
    // place a time could be chosen — would now silently throw away the value
    // showing in the bar they just clicked.
    if (!scheduleSet) setRecurrence(defaultRecurrence())
    setRetry(DEFAULT_RETRY)
    setBurst(DEFAULT_BURST)
    // Every dialog starts as a single reminder. Remembering the last chain
    // would silently triple the next unrelated reminder someone schedules.
    setLeadTimes([0])
    // Same reasoning for conditions: a leftover "only if no reply" would
    // silently suppress an unrelated reminder later.
    setConditions([])
    setScheduleOpen(true)
  }

  /** Reset the send time along with the draft it belonged to. */
  const clearSchedule = () => {
    setScheduleSet(false)
    setRecurrence(defaultRecurrence())
    setLeadTimes([0])
    setConditions([])
  }

  const scheduleSummary = useMemo(() => summarizeRecurrence(recurrence), [recurrence])

  const scheduleHasErrors = hasErrors([...validateRecurrence(recurrence), ...validateBurst(burst)])

  /**
   * Which stages of the chain to create. Only meaningful for a one-off — see
   * `buildChain` for why a repeating reminder has no "three days before".
   */
  const chainable = recurrence.kind === 'once'
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
      status: 'armed',
      createdAt: now,
      updatedAt: now,
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

  return (
    <>
      <div className="view view--compose" data-focus={focusMode}>
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
              <PageHead title={t('compose.title')} subtitle={t('compose.subtitle')} />

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
              <div className="compose-head">
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
                    <button type="button" className="link" onClick={() => setShowCcBcc((v) => !v)}>
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
                    quickBar
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
                    />
                  </Field>
                  <Field label={t('compose.bcc')}>
                    <TagField
                      values={draft.bcc}
                      onChange={(v) => patch({ bcc: v })}
                      suggestions={state.contacts}
                      recents={state.recentRecipients}
                    />
                  </Field>
                </div>
              ) : null}

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
                      {t('compose.bodyCount', {
                        c: [...draft.body].length,
                        b: formatBytes(new TextEncoder().encode(draft.body).length),
                      })}
                    </span>
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setFocusMode((v) => !v)}
                      title={t('compose.focusHint')}
                    >
                      {focusMode ? t('compose.focusExit') : t('compose.focusEnter')}
                    </button>
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
                />
              </Field>

              {/* The pictures the message carries, as pictures.
                  Absent entirely when there are none, so it costs the layout
                  nothing on the ordinary text-only draft — and when there are
                  some, seeing them is the whole point of having added them.
                  One click opens the full-screen viewer. */}
              <ImageStrip
                images={gallery}
                onOpen={setLightboxAt}
                label={t('image.inBody')}
                hint={t('image.openHint')}
              />

              {/* Mail merge. Offered only once there is a `{{token}}` to merge:
                  a switch that does nothing until you learn an undocumented
                  syntax is a switch that teaches nobody anything. */}
              {hasVars(draft) || draft.mergeEnabled ? (
                <Switch
                  checked={draft.mergeEnabled === true}
                  onChange={(v) => patch({ mergeEnabled: v })}
                  title={t('merge.title')}
                  description={t('merge.hint', { n: draft.to.length })}
                />
              ) : null}

              {hasVars(draft) ? (
                <div className="mergevars">
                  <span className="mergevars__label">{t('merge.usedHere')}</span>
                  {[...new Set([...usedVars(draft.subject), ...usedVars(draft.body)])].map((name) => (
                    <span key={name} className="chip">
                      {`{{${name}}}`}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* --- band 3: when, and what rides along -------------------- */}
              <div className="compose-foot">
                <Field label={t('compose.attachments')}>
                  <AttachmentPicker
                    attachments={draft.attachments}
                    onAdd={addAttachments}
                    onRemove={(id) =>
                      patch({ attachments: draft.attachments.filter((a) => a.id !== id) })
                    }
                    onToggleInline={toggleInline}
                    limitMb={limitMb}
                    presence={attachmentPresence}
                    onDropPaths={bridge?.pathForFile ? dropAttachments : undefined}
                    thumbnails={thumbnails}
                    onPreview={(id) => {
                      const at = gallery.findIndex((g) => g.id === id)
                      if (at >= 0) setLightboxAt(at)
                    }}
                  />
                </Field>

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
                */}
                <Field label={t('compose.sendsAt')}>
                  <div className="whenbar">
                    <input
                      className="input whenbar__time"
                      type="datetime-local"
                      /* Empty until a time is actually chosen. `recurrence`
                         always holds one (five minutes out), and showing that
                         beside the words "no send time chosen yet" would be the
                         box contradicting the sentence next to it. */
                      value={scheduleSet ? toLocalInput(recurrence.startAt) : ''}
                      onChange={(e) => {
                        setRecurrence((r) => ({
                          ...r,
                          startAt: fromLocalInput(e.target.value, r.startAt),
                        }))
                        setScheduleSet(true)
                      }}
                    />
                    <div className="whenbar__text">
                      {scheduleSet ? (
                        <>
                          <span className="whenbar__rule">
                            {t(scheduleSummary.key as TranslationKey, scheduleSummary.values)}
                          </span>
                          {plannedStages.length > 1 ? (
                            <span className="whenbar__count">
                              {t('chain.willCreate', { n: plannedStages.length })}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="whenbar__rule whenbar__rule--unset">
                          {t('schedule.notSetYet')}
                        </span>
                      )}
                    </div>
                    <Button variant="ghost" onClick={openSchedule}>
                      {t('schedule.moreRules')}
                    </Button>
                  </div>
                </Field>

                {/* Folded away by default.
                    Priority, per-recipient delivery and read receipts are
                    decided once and then left alone for months, but they were
                    costing 149px of a form that is required to fit one screen.
                    The disclosure remembers nothing on purpose: it reopening
                    because you once used Bcc would defeat the point. */}
                <details className="moreoptions">
                  <summary className="moreoptions__summary">{t('compose.moreOptions')}</summary>
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
                    <Switch
                      checked={draft.individualDelivery}
                      onChange={(v) => patch({ individualDelivery: v })}
                      title={t('compose.individualDelivery')}
                      description={t('compose.individualHint')}
                    />
                    <Switch
                      checked={draft.requestReadReceipt}
                      onChange={(v) => patch({ requestReadReceipt: v })}
                      title={t('compose.readReceipt')}
                    />
                  </div>
                </details>
              </div>
            </div>
          </Card>

          {/* One box, and only once there is something to be wrong about.
              An untouched form used to open with four stacked red banners —
              242px of alarm telling the user off for not having typed yet.
              Blank is not an error: the action bar already says what is
              missing, and Send is disabled until it is not. */}
          {started && issues.length > 0 ? (
            <div
              className={`banner banner--${issues.some((i) => i.severity === 'error') ? 'danger' : 'warning'}`}
            >
              <ul className="banner__list">
                {issues.map((issue, i) => (
                  <li key={`${issue.key}-${i}`}>
                    {t(issue.key as 'validate.noRecipients', issue.values)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {/* The answer to "did it actually send?", kept until dismissed. */}
      {outcome ? (
        <div className="sendresult" data-ok={outcome.ok}>
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
                  )
                  return key ? <div style={{ marginTop: 6 }}>{t(key as 'error.tlsHint')}</div> : null
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
      <div className="actionbar">
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

        {/* Secondary, and deliberately not competing with the two that matter:
            history is a recovery route, the preview is a check. Both are icon
            buttons at this size so the primary pair keeps its weight. */}
        <Button
          variant="ghost"
          icon={<IconFileText size={16} />}
          onClick={() => setHistoryOpen(true)}
          title={t('history.title')}
        >
          {state.draftSnapshots.length > 0 ? String(state.draftSnapshots.length) : ''}
        </Button>
        <Button
          variant="secondary"
          icon={<IconSearch size={16} />}
          disabled={!started}
          onClick={() => setPreflightOpen(true)}
        >
          {t('preflight.button')}
        </Button>
        <Button
          size="lg"
          variant="secondary"
          icon={<IconClock size={17} />}
          disabled={blocked || sending}
          onClick={openSchedule}
        >
          {t('compose.schedule')}
        </Button>
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
        title={t('schedule.new')}
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
              {t('compose.schedule')}
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
            means. */}
        {chainable ? (
          <Field label={t('chain.title')} hint={t('chain.hint')}>
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

        {state.settings.snapshotAttachments && draft.attachments.length > 0 ? (
          <Banner tone="info" title={t('schedule.snapshot')}>
            {t('schedule.snapshotHint')}
          </Banner>
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
