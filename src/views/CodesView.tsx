/**
 * Verification codes and sign-in links, as a screen of their own.
 *
 * It started as a card wedged above the inbox list, which was the wrong shape
 * for what people do with it: you come to this app *for* the code, glance at
 * six digits, copy them, and leave. That is a destination, not an accessory to
 * a mailbox — so it gets a nav entry, the full width of the window, and type
 * large enough to read across a desk.
 *
 * Three things were added after the screen had been used in anger.
 *
 * *Check now*, because the honest answer to "has it arrived?" was previously
 * "wait up to five minutes and see". The button is the first control in the
 * head for that reason, and beside it is the wait mode — for the case where the
 * code has been *requested* and the next thing that happens is the thing you
 * are here for.
 *
 * *What the link is for*, because a bare URL is the least legible form of that
 * information. The card leads with "Sign in to your account", not with forty
 * characters of tracking id.
 *
 * *Why this one*, because the screen used to be unfalsifiable. When it showed
 * the wrong number there was nothing to look at and nothing to press; now every
 * card can explain its pick, show what lost and why, and be corrected in one
 * press — and the correction is remembered for that sender.
 */

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Modal, PageHead, Segmented, useConfirm, useToast } from '../components/ui'
import { SearchInput } from '../components/inputs'
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconExternal,
  IconHelp,
  IconKey,
  IconLink,
  IconQr,
  IconRefresh,
  IconShield,
  IconTrash,
  IconX,
} from '../components/icons'
import { VirtualList } from '../components/VirtualList'
import { useApp } from '../state/AppState'
import { useCodeCheck, WAIT_PRESETS, type CheckOutcome } from '../state/CodeCheck'
import { useI18n } from '../i18n'
import { CODE_FRESH_MS } from '../core/codeHistory'
import { encodeQr, qrPath } from '../core/qr'
import { accountLabel as labelOfAccount } from '../core/accounts'
import type { LinkPurpose } from '../core/linkPurpose'
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

/**
 * Re-render on a timer, but only while something on screen is actually counting
 * down. A permanent one-second interval on a list screen is a wakeup per second
 * for the whole time the app is open, which on a phone is not free.
 */
function useTick(active: boolean): void {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [active])
}

/**
 * `521000` → `8:41`, `45000` → `0:45`, anything past an hour → `72:00`.
 *
 * Always `m:ss`, never a bare number of minutes, and never the wall-clock time
 * it would expire at. The first draft rendered `8:41` next to the word
 * "expires", which reads as twenty to nine — the label in every locale now says
 * *remaining* rather than *at*, and the colon then means what it looks like.
 */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}


export function CodesView({ onGoToInbox }: { onGoToInbox?: () => void }) {
  const { state, bridge, dispatch } = useApp()
  const { t, formatAgo, formatDateTime } = useI18n()
  const toast = useToast()
  const { confirm, confirmElement } = useConfirm()
  const check = useCodeCheck()

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  /** id → when it was copied in *this* session, for the transient "Copied ✓". */
  const [justCopied, setJustCopied] = useState<string | null>(null)
  /** Which card has its "why this one" panel open. At most one at a time. */
  const [explaining, setExplaining] = useState<string | null>(null)
  /** The hit whose QR code is on screen, if any. */
  const [showingQr, setShowingQr] = useState<CodeHit | null>(null)

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

  const foundKeys = useMemo(() => new Set(check.lastFoundKeys), [check.lastFoundKeys])

  /* Only tick while something is genuinely counting down. */
  const now = Date.now()
  const counting =
    check.waitingUntil !== undefined ||
    visible.some((h) => h.expiresAt !== undefined && h.expiresAt > now)
  useTick(counting)

  /**
   * One click does both jobs: the value lands on the clipboard, and the card
   * stops being one of the things still waiting for attention.
   *
   * The read mark is set *before* the clipboard call and outside the `try`. A
   * code that was read off the screen and typed by hand has still been dealt
   * with, and a card that stayed marked unread because a clipboard permission
   * failed would be a card the user has to dismiss twice.
   */
  const copy = async (hit: CodeHit, value = hit.value) => {
    dispatch({ type: 'markCodeRead', id: hit.id })
    try {
      await navigator.clipboard.writeText(value)
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
    const host = hit.link?.host ?? hostOf(hit.value)
    const ok = await confirm({
      title: t('confirm.openLinkTitle'),
      body: t('confirm.openLinkBody', { host }),
      confirmLabel: t('confirm.openLinkConfirm'),
      cancelLabel: t('common.cancel'),
      /* An off-site or plain-http link gets the destructive treatment: the
         dialog is the last place the difference can still be pointed out. */
      danger: (hit.link?.risks?.length ?? 0) > 0,
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

  /** B8 — "this one is wrong" / "that one was right", remembered per sender. */
  const correctTo = (hit: CodeHit, preferred?: string) => {
    check.correct(hit, { rejected: hit.value, preferred })
    toast.push({
      tone: 'success',
      title: preferred ? t('codes.correctedTo', { value: preferred }) : t('codes.correctedAway'),
      detail: t('codes.correctedHint'),
    })
    setExplaining(null)
  }

  const hasAnyInbox = state.inboxAccounts.some((i) => i.enabled)
  const waitLeft = check.waitingUntil ? check.waitingUntil - now : 0

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
            <>
              {/* The reason anyone opens this screen while waiting. First
                  control, primary weight, never hidden behind a menu. */}
              <Button
                variant="primary"
                icon={<IconRefresh size={15} />}
                onClick={() => void check.checkNow()}
                disabled={!hasAnyInbox}
                loading={check.checking}
              >
                {check.checking ? t('codes.checking') : t('codes.checkNow')}
              </Button>
              {check.waitingUntil ? (
                <Button variant="secondary" icon={<IconX size={15} />} onClick={check.stopWaiting}>
                  {t('codes.stopWaiting', { time: formatRemaining(waitLeft) })}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  icon={<IconClock size={15} />}
                  onClick={() => check.startWaiting(WAIT_PRESETS[0])}
                  disabled={!hasAnyInbox}
                  title={t('codes.waitHint', { s: WAIT_PRESETS[0] })}
                >
                  {t('codes.wait')}
                </Button>
              )}
              {unread > 0 ? (
                <Button
                  variant="ghost"
                  icon={<IconCheck size={15} />}
                  onClick={() => dispatch({ type: 'markAllCodesRead' })}
                >
                  {t('codes.markAllRead')}
                </Button>
              ) : null}
              {state.codeHits.length > 0 ? (
                <Button variant="ghost" icon={<IconTrash size={15} />} onClick={clearAll}>
                  {t('codes.clear')}
                </Button>
              ) : null}
            </>
          }
        />

        {/* D5 — what the last press actually did. Six sentences, not "failed". */}
        {check.lastOutcome ? (
          <div className="checkbar" data-tone={toneOf(check.lastOutcome)}>
            <span className="checkbar__icon">
              {check.lastOutcome === 'found' ? <IconCheck size={15} /> : <IconAlert size={15} />}
            </span>
            <span className="checkbar__text">
              <strong>{t(`codes.outcome.${check.lastOutcome}`)}</strong>{' '}
              <span className="checkbar__hint">{t(`codes.outcome.${check.lastOutcome}Hint`)}</span>
              {check.lastError && check.lastOutcome === 'failed' ? (
                <span className="checkbar__raw"> {check.lastError}</span>
              ) : null}
            </span>
            {check.lastCheckedAt ? (
              <span className="checkbar__when" title={formatDateTime(check.lastCheckedAt)}>
                {t('codes.lastChecked', { ago: formatAgo(check.lastCheckedAt) })}
              </span>
            ) : null}
            {check.waitingUntil ? (
              <span className="checkbar__wait">
                {t('codes.waitingFor', { time: formatRemaining(waitLeft) })}
              </span>
            ) : null}
          </div>
        ) : null}

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
            estimate={148}
            scrollerClassName="list-pane"
            rowsClassName="codelist"
          >
            {(hit) => {
              const { name, address } = splitFrom(hit.from)
              const copied = justCopied === hit.id
              const isLink = hit.kind === 'link'
              const open = explaining === hit.id
              const remaining = hit.expiresAt !== undefined ? hit.expiresAt - now : undefined
              const expired = remaining !== undefined && remaining <= 0
              const primary = () => (isLink ? void openLink(hit) : void copy(hit))

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
                  data-expired={expired || undefined}
                  data-new={foundKeys.has(keyOfHit(hit)) || undefined}
                >
                  <div
                    className="codecard__body"
                    role="button"
                    tabIndex={0}
                    title={t(isLink ? 'codes.openHint' : hit.readAt ? 'codes.copyHint' : 'codes.readHint')}
                    onClick={primary}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        primary()
                      }
                    }}
                  >
                    <div className="codecard__mark">
                      {isLink ? <IconLink size={18} /> : <IconKey size={18} />}
                      {/* The dot carries the unread state on its own, so the
                          distinction survives for anyone who cannot rely on the
                          contrast difference alone. */}
                      {!hit.readAt ? (
                        <span className="codecard__unread" title={t('codes.unread')} />
                      ) : null}
                    </div>

                    <div className="codecard__main">
                      {/* The value first and largest — except for a link, where
                          the value is unreadable and what it *does* is not. */}
                      {isLink ? (
                        <>
                          {/* The headline is what the sender wrote on the button
                              when there was one, and our own description of the
                              link when there was not. The purpose chip is only
                              added in the first case — in the second it would
                              repeat the headline back verbatim, which is how the
                              card ended up saying the same sentence twice. */}
                          <div className="codecard__value" data-kind="link">
                            {hit.link?.anchorText ||
                              t(purposeKey(hit.link?.purpose), {
                                host: hit.link?.domain ?? hostOf(hit.value),
                              })}
                          </div>
                          <div className="codecard__purpose">
                            {hit.link?.anchorText ? (
                              <span className="chip chip--strong">
                                {t(purposeKey(hit.link?.purpose), {
                                  host: hit.link?.domain ?? hostOf(hit.value),
                                })}
                              </span>
                            ) : null}
                            <span className="codecard__host" title={hit.value}>
                              {hit.link?.host ?? hostOf(hit.value)}
                            </span>
                            {hit.link?.purposeConfidence === 'low' ? (
                              <span className="chip chip--quiet">{t('codes.purposeUnsure')}</span>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <div className="codecard__value" data-kind="code">
                          {grouped(hit.value)}
                        </div>
                      )}

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
                        {/* C4 — how long it lasts, when the mail said so. */}
                        {remaining !== undefined ? (
                          <span className={expired ? 'chip chip--warning' : 'chip chip--timer'}>
                            {expired
                              ? t('codes.expired')
                              : t('codes.expiresIn', { time: formatRemaining(remaining) })}
                          </span>
                        ) : null}
                        {hit.oneTime ? (
                          <span className="chip chip--quiet">{t('codes.oneTime')}</span>
                        ) : null}
                        {/* C3 — one chip per checkable fact, never a verdict. */}
                        {(hit.link?.risks ?? []).map((risk) => (
                          <span key={risk} className="chip chip--warning" title={t(`codes.riskHint.${risk}`)}>
                            <IconShield size={12} /> {t(`codes.risk.${risk}`)}
                          </span>
                        ))}
                        {hit.copiedAt && !copied ? (
                          <span className="chip chip--quiet">{t('codes.alreadyCopied')}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="codecard__actions" onClick={(e) => e.stopPropagation()}>
                      {isLink ? (
                        <>
                          <Button
                            variant="primary"
                            icon={<IconExternal size={15} />}
                            onClick={() => void openLink(hit)}
                          >
                            {t('inbox.open')}
                          </Button>
                          <Button
                            variant="secondary"
                            icon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                            onClick={() => void copy(hit)}
                          >
                            {copied ? t('common.copied') : t('codes.copyLink')}
                          </Button>
                          {/* C5 — the laptop-to-phone case: the link is here,
                              the session you want it in is over there. */}
                          <Button
                            variant="ghost"
                            icon={<IconQr size={15} />}
                            onClick={() => setShowingQr(hit)}
                          >
                            {t('codes.showQr')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant={copied ? 'primary' : 'secondary'}
                          icon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                          onClick={() => void copy(hit)}
                        >
                          {copied ? t('common.copied') : t('common.copy')}
                        </Button>
                      )}
                      {/* B7 — the card can be asked to justify itself. Only
                          offered when there is something to say. */}
                      {(hit.reasons?.length ?? 0) > 0 || (hit.alternatives?.length ?? 0) > 0 ? (
                        <Button
                          variant="ghost"
                          icon={<IconHelp size={15} />}
                          onClick={() => setExplaining(open ? null : hit.id)}
                          aria-expanded={open}
                        >
                          {open ? t('codes.whyHide') : t('codes.why')}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {open ? (
                    <div className="codewhy">
                      <div className="codewhy__section">
                        <div className="codewhy__label">{t('codes.whyPicked')}</div>
                        <ul className="codewhy__list">
                          {(hit.reasons ?? []).map((r, i) => (
                            <li key={`${r.code}-${i}`}>
                              {t(`codes.reason.${r.code}`, { detail: r.detail ?? '' })}
                            </li>
                          ))}
                          {(hit.reasons?.length ?? 0) === 0 ? <li>{t('codes.reason.none')}</li> : null}
                        </ul>
                      </div>

                      {(hit.alternatives?.length ?? 0) > 0 ? (
                        <div className="codewhy__section">
                          <div className="codewhy__label">{t('codes.alternatives')}</div>
                          <ul className="codewhy__alts">
                            {hit.alternatives!.map((alt, i) => (
                              <li key={`${alt.value}-${i}`} data-eligible={alt.eligible || undefined}>
                                <code>{alt.value}</code>
                                <span className="codewhy__altReason">
                                  {alt.reasons
                                    .map((r) => t(`codes.reason.${r.code}`, { detail: r.detail ?? '' }))
                                    .join(' · ')}
                                </span>
                                {/* Only a genuine contender can be promoted; a
                                    struck-out postcode is shown to explain the
                                    decision, not offered as an answer. */}
                                {alt.eligible && !isLink ? (
                                  <Button variant="ghost" onClick={() => correctTo(hit, alt.value)}>
                                    {t('codes.useThis')}
                                  </Button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {!isLink ? (
                        <div className="codewhy__foot">
                          <Button variant="ghost" onClick={() => correctTo(hit)}>
                            {t('codes.notThis')}
                          </Button>
                          <span className="codewhy__note">{t('codes.correctNote')}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            }}
          </VirtualList>
        )}
      </div>

      {showingQr ? (
        <QrDialog hit={showingQr} onClose={() => setShowingQr(null)} />
      ) : null}

      {confirmElement}
    </div>
  )
}

/** `https://login.live.com/x` → `login.live.com`; the raw string if it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function keyOfHit(hit: CodeHit): string {
  return `${hit.messageId}\x00${hit.kind}\x00${hit.value}`
}

/**
 * Typed rather than `string`, so a purpose added to the classifier without a
 * translation fails the build instead of rendering its own key on screen.
 */
function purposeKey(purpose: LinkPurpose | undefined): `codes.purpose.${LinkPurpose}` {
  return `codes.purpose.${purpose ?? 'unknown'}`
}

function toneOf(outcome: CheckOutcome): string {
  if (outcome === 'found') return 'success'
  if (outcome === 'authFailed' || outcome === 'offline' || outcome === 'failed') return 'error'
  return 'neutral'
}

/**
 * The link as a QR code.
 *
 * Encoded here and now rather than stored: it is a pure function of the URL,
 * costs about a millisecond, and storing it would put a few kilobytes of
 * picture into `state.json` for every link ever seen.
 */
function QrDialog({ hit, onClose }: { hit: CodeHit; onClose: () => void }) {
  const { t } = useI18n()
  const qr = useMemo(() => encodeQr(hit.value), [hit.value])

  return (
    <Modal open onClose={onClose} title={t('codes.qrTitle')} closeLabel={t('common.close')}>
      <div className="qrbox">
        {qr ? (
          <>
            <svg
              className="qrbox__code"
              viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
              shapeRendering="crispEdges"
              role="img"
              aria-label={t('codes.qrTitle')}
            >
              {/* White plate always, in both themes: a camera reading an
                  inverted code is a coin flip, and this is the one surface in
                  the app that is not being read by a person. */}
              <rect width={qr.size + 8} height={qr.size + 8} fill="#fff" />
              <path d={qrPath(qr)} fill="#000" />
            </svg>
            <p className="qrbox__hint">{t('codes.qrHint')}</p>
            <p className="qrbox__url">{hit.link?.host ?? hostOf(hit.value)}</p>
          </>
        ) : (
          <p className="qrbox__hint">{t('codes.qrTooLong')}</p>
        )}
      </div>
    </Modal>
  )
}
