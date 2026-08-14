/**
 * "Show me what is about to go out."
 *
 * The layout answers, in order, the four questions someone actually has before
 * pressing an irreversible button: how many messages, to whom, what will they
 * read, and is anything wrong. Warnings sit at the top because a warning found
 * after scrolling past the preview is a warning found too late.
 */

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Banner, Button, Modal, Segmented, StatusChip } from './ui'
import { IconAlert, IconCheckCircle, IconPaperclip, IconSend } from './icons'
import {
  ImageLightbox,
  ImageStrip,
  isViewableImage,
  useAttachmentImages,
} from './ImageLightbox'
import { buildPreflight, type PreflightReport } from '../core/mail/preflight'
import type { GuardianFinding } from '../core/mail/sendGuardian'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'
import type { SendCondition } from '../core/schedule/conditions'
import type { MessageDraft, RetryPolicy } from '../core/types'
import { countLabel, type Upcoming } from '../core/schedule/upcoming'

/**
 * Which of these files are still on disk.
 *
 * Re-checked whenever the set of paths changes rather than on a timer: a file
 * deleted while the compose screen sits open is exactly the case this is for,
 * and the preview re-runs the check each time it matters (a path added, a send
 * attempted). An empty map means "not asked yet" and never "all missing" —
 * every consumer distinguishes `false` from `undefined`.
 */
export function useFilePresence(paths: string[]): Record<string, boolean> | undefined {
  const { bridge } = useApp()
  const [present, setPresent] = useState<Record<string, boolean> | undefined>(undefined)
  const key = paths.join('\x00')

  useEffect(() => {
    if (!bridge?.checkFiles || paths.length === 0) {
      setPresent(undefined)
      return
    }
    let cancelled = false
    void bridge
      .checkFiles(paths)
      .then((map) => {
        if (!cancelled) setPresent(map)
      })
      .catch(() => {
        // A failed check is "unknown", not "missing". Reporting a red flag on
        // every attachment because one IPC call lost a race would train people
        // to ignore the flag that matters.
        if (!cancelled) setPresent(undefined)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, key])

  return present
}

export function usePreflight(
  liveDraft: MessageDraft,
  extras: { conditions?: SendCondition[] } = {},
) {
  const { state } = useApp()
  /**
   * The report lags the keystroke by design.
   *
   * Building it expands the merge for every recipient and re-renders the whole
   * warning list, and the compose screen calls this on every character typed.
   * Deferring keeps the textarea at full speed and lets the counts catch up —
   * they are a summary of what is on screen, so being a frame behind costs
   * nothing, and the dialog itself always reads the settled value.
   */
  const draft = useDeferredValue(liveDraft)
  const account = state.accounts.find((a) => a.id === draft.accountId)
  const present = useFilePresence(draft.attachments.map((a) => a.path))

  return useMemo(
    () =>
      buildPreflight(draft, account, {
        contacts: state.contacts,
        fileExists: present ? (p: string) => present[p] === true : undefined,
        merge: draft.mergeEnabled === true,
        attachmentWarnMb: state.settings.attachmentWarnMb,
        attachmentMaxMb: state.settings.attachmentMaxMb,
        bulkConfirmThreshold: state.settings.bulkConfirmThreshold,
        quiet: {
          enabled: state.settings.quietHoursEnabled,
          start: state.settings.quietStart,
          end: state.settings.quietEnd,
        },
        conditions: extras.conditions,
      }),
    [draft, account, state.contacts, state.settings, extras.conditions, present],
  )
}

/** Seconds as the shortest sensible unit — "90 s" reads worse than "1.5 min". */
function formatWait(seconds: number, t: (k: TranslationKey, v?: Record<string, string | number>) => string): string {
  if (seconds < 90) return t('preflight.waitSeconds', { n: seconds })
  if (seconds < 5400) return t('preflight.waitMinutes' as 'preflight.waitSeconds', { n: Math.round(seconds / 60) })
  return t('preflight.waitHours' as 'preflight.waitSeconds', { n: Math.round(seconds / 360) / 10 })
}

export function PreflightDialog({
  open,
  report,
  guardianFindings = [],
  onClose,
  onConfirm,
  confirmLabel,
  sending,
  outlook,
  retry,
}: {
  open: boolean
  report: PreflightReport
  /**
   * Send Guardian's advisories — see `core/mail/sendGuardian.ts` — pre-filtered
   * by the caller against `settings.composeAdvisoriesEnabled`. Never blocks
   * `onConfirm`; that is `report.blocked`'s job alone. This is the only place
   * these are shown at all: the compose screen used to carry them in a
   * permanent strip above the message box, which is what this dialog now
   * replaces them with — surfaced at the moment Send is actually pressed.
   */
  guardianFindings?: GuardianFinding[]
  onClose: () => void
  onConfirm: () => void
  confirmLabel: string
  sending?: boolean
  /** How often this fires over the next month. Absent for an immediate send. */
  outlook?: Upcoming | null
  /** The retry policy the scheduled job will carry. */
  retry?: RetryPolicy | null
}) {
  const { t, formatBytes } = useI18n()
  /** Which of the merged copies is on screen. Index, not id — they are positional. */
  const [previewIndex, setPreviewIndex] = useState(0)

  /**
   * The pictures this send will carry, shown as pictures.
   *
   * The body below is rendered as plain text on purpose — a preview that
   * executes the message it is previewing is a preview with a security bug —
   * which means an embedded image shows up here as its `<img src="cid:…">`
   * source. That is correct for the text and useless for the question people
   * open this dialog to answer, so the pictures get their own row.
   */
  const imageSources = useMemo(
    () =>
      report.attachments
        .filter(({ attachment }) => isViewableImage(attachment.name))
        .map(({ attachment: a }) => ({ id: a.id, name: a.name, path: a.path, size: a.size })),
    [report.attachments],
  )
  const loaded = useAttachmentImages(imageSources)
  const gallery = useMemo(
    () =>
      imageSources
        .map((s) => {
          const bytes = loaded[s.path]
          return bytes ? { ...s, ...bytes } : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [imageSources, loaded],
  )
  const [lightboxAt, setLightboxAt] = useState<number | null>(null)

  const preview = report.messages[Math.min(previewIndex, report.messages.length - 1)]

  /*
   * How many messages, over what span, on which days.
   *
   * The rest of this dialog answers "what will one of these look like". This
   * answers "how many of them am I agreeing to" — the question a mistyped
   * interval makes expensive and which nothing on the compose screen could
   * previously answer.
   */
  const count = outlook ? countLabel(outlook) : null

  /*
   * What happens if a send fails.
   *
   * The retry policy was configurable and invisible: a schedule that gives up
   * after three tries and one that keeps going for an hour looked the same
   * everywhere, including here. The waits are shown as the actual sequence
   * rather than as "backoff factor 3", because nobody plans around a factor.
   */
  const retryWaits = useMemo(() => {
    if (!retry) return []
    const out: number[] = []
    let wait = retry.backoffSeconds
    for (let i = 1; i < Math.max(1, retry.maxAttempts); i++) {
      out.push(wait)
      wait = Math.round(wait * (retry.backoffFactor || 1))
    }
    return out
  }, [retry])
  const errors = report.warnings.filter((w) => w.severity === 'error')
  const others = report.warnings.filter((w) => w.severity !== 'error')

  return (
    <Modal
      open={open}
      wide
      title={t('preflight.title')}
      onClose={onClose}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<IconSend size={16} />}
            disabled={report.blocked}
            loading={sending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {/* The headline numbers. These are the ones people check and then stop
          reading, so they come first and they are big. */}
      <div className="preflight__figures">
        <div className="preflight__figure">
          <div className="preflight__value">{report.messageCount}</div>
          <div className="preflight__label">{t('preflight.messages')}</div>
        </div>
        <div className="preflight__figure">
          <div className="preflight__value">{report.recipientCount}</div>
          <div className="preflight__label">{t('preflight.recipients')}</div>
        </div>
        <div className="preflight__figure">
          <div className="preflight__value">{formatBytes(report.wireBytes)}</div>
          <div className="preflight__label">{t('preflight.onTheWire')}</div>
        </div>
        <div className="preflight__figure">
          <div className="preflight__value">{report.attachments.length}</div>
          <div className="preflight__label">{t('compose.attachments')}</div>
        </div>
      </div>

      {outlook && count ? (
        <div className="preflight__outlook">
          <div className="preflight__outlookhead">
            <strong>
              {count.atLeast
                ? t('preflight.sendsAtLeast', { n: count.n, days: outlook.days_ahead })
                : t('preflight.sendsExact', { n: count.n, days: outlook.days_ahead })}
            </strong>
            {count.atLeast ? (
              <StatusChip tone="warning" label={t('preflight.truncated')} />
            ) : null}
          </div>
          {outlook.days.length > 0 ? (
            <div className="preflight__days">
              {/* Twelve days, then a count. The list is here to make a wrong
                  interval obvious at a glance, and thirty rows of dates would
                  bury the thing it is meant to reveal. */}
              {outlook.days.slice(0, 12).map((d) => (
                <span key={d.date} className="preflight__day">
                  {d.date}
                  {d.times.length > 1 ? (
                    <span className="preflight__daycount">×{d.times.length}</span>
                  ) : null}
                </span>
              ))}
              {outlook.days.length > 12 ? (
                <span className="preflight__day preflight__day--more">
                  {t('preflight.moreDays', { n: outlook.days.length - 12 })}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="field__hint">{t('preflight.noneInWindow', { days: outlook.days_ahead })}</div>
          )}

          {retry && retryWaits.length > 0 ? (
            <div className="field__hint">
              {t('preflight.retryPlan', {
                n: retry.maxAttempts,
                waits: retryWaits.map((w) => formatWait(w, t)).join(' → '),
              })}
            </div>
          ) : null}
          {retry && retryWaits.length === 0 ? (
            <div className="field__hint">{t('preflight.retryNone')}</div>
          ) : null}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <Banner tone="danger" title={t('preflight.blocked')}>
          <ul className="banner__list">
            {errors.map((w, i) => (
              <li key={`${w.key}-${i}`}>{t(w.key as TranslationKey, w.values)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {others.length > 0 ? (
        <div className="preflight__notes">
          {others.map((w, i) => (
            <div key={`${w.key}-${i}`} className={`preflight__note preflight__note--${w.severity}`}>
              {w.severity === 'warning' ? <IconAlert size={14} /> : <IconCheckCircle size={14} />}
              <span>{t(w.key as TranslationKey, w.values)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Send Guardian's advisories — guesses about intent rather than facts
          about the draft, which is why they are a labelled group of their own
          rather than folded into `others` above. See `guardianFindings`. */}
      {guardianFindings.length > 0 ? (
        <div className="preflight__notes">
          <div className="preflight__label">{t('sendGuardian.title')}</div>
          {guardianFindings.map((finding) => (
            <div key={finding.rule} className="preflight__note preflight__note--warning">
              <IconAlert size={14} />
              <span>{t(finding.key as TranslationKey, finding.values)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="preflight__route">
        <StatusChip tone="neutral" label={report.from || t('preflight.noSender')} />
        <span className="preflight__arrow" aria-hidden="true">
          →
        </span>
        <StatusChip
          tone="info"
          label={`${report.host}:${report.port} · ${report.security.toUpperCase()}`}
        />
      </div>

      {/* One tab per merged copy, capped: forty tabs is not a preview. The
          count is still shown above, so the cap hides nothing. */}
      {report.messages.length > 1 ? (
        <Segmented
          value={String(Math.min(previewIndex, report.messages.length - 1))}
          onChange={(v: string) => setPreviewIndex(Number(v))}
          ariaLabel={t('preflight.whichCopy')}
          options={report.messages.slice(0, 6).map((m, i) => ({
            value: String(i),
            label: m.address || `#${i + 1}`,
          }))}
        />
      ) : null}

      {preview ? (
        <div className="preflight__preview">
          <div className="preflight__row">
            <span className="preflight__key">{t('compose.to')}</span>
            <span className="preflight__val">{preview.draft.to.join(', ') || '—'}</span>
          </div>
          {preview.draft.cc.length > 0 ? (
            <div className="preflight__row">
              <span className="preflight__key">{t('compose.cc')}</span>
              <span className="preflight__val">{preview.draft.cc.join(', ')}</span>
            </div>
          ) : null}
          {preview.draft.bcc.length > 0 ? (
            <div className="preflight__row">
              <span className="preflight__key">{t('compose.bcc')}</span>
              <span className="preflight__val">{preview.draft.bcc.join(', ')}</span>
            </div>
          ) : null}
          <div className="preflight__row">
            <span className="preflight__key">{t('compose.subject')}</span>
            <span className="preflight__val preflight__val--strong">
              {preview.draft.subject || t('preflight.noSubjectShort')}
            </span>
          </div>
          {/* The body as text, never rendered as HTML. A preview that executes
              the message it is previewing is a preview with a security bug. */}
          <pre className="preflight__body">{preview.draft.body || t('preflight.emptyBodyShort')}</pre>
        </div>
      ) : null}

      <ImageStrip
        images={gallery}
        onOpen={setLightboxAt}
        label={t('image.inBody')}
        hint={t('image.openHint')}
      />

      {lightboxAt !== null && gallery[lightboxAt] ? (
        <ImageLightbox
          images={gallery}
          index={lightboxAt}
          onIndex={setLightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      ) : null}

      {report.attachments.length > 0 ? (
        <div className="preflight__files">
          {report.attachments.map(({ attachment, present }) => (
            <div key={attachment.id} className="preflight__file" data-missing={present === false}>
              <IconPaperclip size={14} />
              <span className="preflight__filename">{attachment.name}</span>
              <span className="preflight__filesize">{formatBytes(attachment.size)}</span>
              {present === false ? (
                <StatusChip tone="danger" label={t('preflight.fileMissing')} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {report.conditionReasonKey ? (
        <Banner tone="info" title={t('preflight.conditionTitle')}>
          {t(report.conditionReasonKey as TranslationKey, report.conditionReasonValues)}
        </Banner>
      ) : null}
    </Modal>
  )
}
