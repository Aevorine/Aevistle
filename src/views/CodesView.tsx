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

import {
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  Button,
  EmptyState,
  IconButton,
  Modal,
  PageHead,
  PaletteContext,
  Segmented,
  useConfirm,
  useToast,
} from '../components/ui'
import { SearchInput } from '../components/inputs'
import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconExternal,
  IconHelp,
  IconKey,
  IconLink,
  IconMore,
  IconQr,
  IconRefresh,
  IconSearch,
  IconShield,
  IconTrash,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '../components/icons'
import { VirtualList } from '../components/VirtualList'
/* The schedule screen's ring, reused rather than reimplemented. It brings its
   own shared ticker, its own IntersectionObserver and its own render bailout —
   see the header of `CountdownRing.tsx` — none of which a second ring written
   for this screen would have, and all of which this screen would eventually
   need. What it is given here is one fact it did not have before: a code's
   expiry is a deadline exactly like a send's. */
import { CountdownRing } from '../components/CountdownRing'
import { useMobileShell } from '../components/useNarrow'
import { useApp } from '../state/AppState'
import { useCodeCheck, WAIT_PRESETS, type CheckOutcome } from '../state/CodeCheck'
import { useI18n } from '../i18n'
import { CODE_FRESH_MS } from '../core/ops/codeHistory'
import { copyText } from '../core/platform/clipboard'
import { haptic } from '../core/haptics'
import { AXIS_LOCK_PX, resolvePull, type PullState } from '../core/platform/gestures'
import { encodeQr, qrPath } from '../core/sync/qr'
import { accountLabel as labelOfAccount } from '../core/mail/accounts'
import type { LinkPurpose } from '../core/mail/linkPurpose'
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

  /**
   * Touch shell, not "narrow window".
   *
   * The same question `App` asks, and for the same reason: a 1024px tablet
   * running the Android build has no pointer and no Ctrl+K, so the width alone
   * would put it on the desktop arrangement. Everything this flag gates — the
   * one-row head, the pull, the hero card — is about a thumb, not about pixels.
   */
  const phone = useMobileShell(bridge?.platform === 'android')
  const openPalette = useContext(PaletteContext)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  /** The overflow menu, and the search field it sits beside. Phone only. */
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** The screen root — only so the search field can be focused when it opens. */
  const viewRef = useRef<HTMLDivElement>(null)
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
  /* One clock reading for the whole render. Freshness, the countdowns and the
     wait timer all used to call `Date.now()` separately, which meant a card
     could be judged stale a hair before or after the timer under it agreed. */
  const now = Date.now()
  /* `CODE_FRESH_MS` rather than a number typed here, so the window this screen
     draws its `data-fresh` mark from and the one the nav badge counts are the
     same window — see `core/codeHistory`, where it lives. The mark is a
     predicate over one hit, not a filter over a list, so it is a cutoff rather
     than a call to `freshHits`. */
  const cutoff = now - CODE_FRESH_MS
  const visible = matching
  const unread = state.codeHits.filter((h) => !h.readAt).length

  const foundKeys = useMemo(() => new Set(check.lastFoundKeys), [check.lastFoundKeys])

  /**
   * The newest code on the screen, read or not, on every shell.
   *
   * Split out of `heroId` because big-digit mode needs the same answer for a
   * different question, and two loops over `codeHits` looking for "the newest
   * code" would be two places for that definition to drift. Computed over
   * `state.codeHits` rather than over `visible`, so a filter or a search cannot
   * promote a different card — see the note on `visible` above.
   */
  const newestCode = useMemo(() => {
    let newest: CodeHit | undefined
    for (const hit of state.codeHits) {
      if (hit.kind !== 'code') continue
      if (!newest || hit.date > newest.date) newest = hit
    }
    return newest
  }, [state.codeHits])

  /**
   * The one card drawn large: the newest code that has not been read yet.
   *
   * Rendered where the hit already sits in the list rather than moved to the
   * top, because nothing on this screen is allowed to reorder (see the note on
   * `visible` above). In the ordinary case, newest-first ordering already puts
   * it first.
   *
   * "Newest code, if unread" rather than "newest unread code": once it has been
   * dealt with the hero goes away instead of promoting an older one, which
   * would be a large card appearing halfway down a list nobody asked to change.
   */
  const heroId = phone && newestCode && !newestCode.readAt ? newestCode.id : undefined

  /**
   * Big-digit mode: one code at the width of the screen, and no list.
   *
   * A stored preference (`Settings.codesBigDigits`) rather than a per-visit
   * toggle — somebody who needs the digits large needs them large every time,
   * and a mode that reset on launch would have to be switched on before every
   * code. `=== true` rather than `!== false` because the default is off: the
   * list is what can answer "did the second one arrive", and only a person who
   * has said otherwise should lose it.
   *
   * `bigMode` is the flag everything else reads, and it is deliberately not the
   * same as the setting. With no code to show there is nothing for the mode to
   * be, so the screen falls through to its ordinary empty state — which names
   * the next thing to do — instead of rendering a large empty box.
   */
  const bigDigits = state.settings.codesBigDigits === true
  const bigMode = bigDigits && newestCode !== undefined
  const setBigDigits = (on: boolean) =>
    dispatch({ type: 'patchSettings', patch: { codesBigDigits: on } })

  /* Only tick while something is genuinely counting down.
     Moved below `newestCode` when big-digit mode arrived, and the third clause
     is why: in that mode the list is not rendered, so a `filter` left over from
     before the mode was switched on could exclude the one card that *is* on
     screen — and `visible.some(...)` would then say nothing is counting while a
     countdown ticked in front of the user. */
  const counting =
    check.waitingUntil !== undefined ||
    visible.some((h) => h.expiresAt !== undefined && h.expiresAt > now) ||
    (bigMode && newestCode?.expiresAt !== undefined && newestCode.expiresAt > now)
  useTick(counting)

  /**
   * The filter only exists when there is something to filter.
   *
   * All/codes/links is three controls answering a question nobody has when
   * every hit is a code — which is the usual case. It appears the moment a
   * link turns up beside a code, and the value is put back to `all` when it
   * goes away, or a stale `link` filter would leave the screen looking empty
   * with no visible control explaining why.
   */
  const hasCode = state.codeHits.some((h) => h.kind === 'code')
  const hasLink = state.codeHits.some((h) => h.kind === 'link')
  const canFilter = hasCode && hasLink
  useEffect(() => {
    if (!canFilter) setFilter('all')
  }, [canFilter])

  /* The overflow menu closes on Escape and on a press that lands outside it —
     the same rule the reader's own header menu uses (`InboxView`). */
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown' && (e.target as HTMLElement | null)?.closest('.codesmenu')) return
      setMenuOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
    }
  }, [menuOpen])

  /* Opening the field and then having to aim at it is two taps for one
     intention. */
  useEffect(() => {
    if (searchOpen) viewRef.current?.querySelector<HTMLInputElement>('.search__input')?.focus()
  }, [searchOpen])

  const toggleSearch = () => {
    /* Closing clears the query. A field that is not on screen must not still
       be filtering the list — that is a screen that looks like it has lost
       your codes, with nothing on it to explain why. */
    if (searchOpen) setQuery('')
    setSearchOpen((v) => !v)
  }

  // --- pull to refresh ------------------------------------------------------

  /**
   * "Check now" as the gesture the platform already taught everyone.
   *
   * The arithmetic is `core/gestures.resolvePull`, which is tested without a
   * DOM and refuses to fire unless the list is genuinely at the top. This only
   * tracks the pointer. Mouse pointers are excluded for the same reason
   * `useSwipe` excludes them: a drag on a desktop list is a selection, not a
   * refresh, and the desktop head still carries the button.
   *
   * The gesture is never the only way in — "立即检查" stays in the overflow
   * menu, because a gesture nobody can find is a regression (see the swipe
   * section of `16-mail.css`).
   */
  const pullFrom = useRef<{ y: number; scroller: HTMLElement } | null>(null)
  /** A drag that ends on a card must not also count as a tap on that card. */
  const swallowClick = useRef(false)
  /* The same fact as `pull.armed`, kept where the release handler cannot read
     a stale render of it: the last move and the release can land in one batch. */
  const armed = useRef(false)
  const [pull, setPull] = useState<PullState>({ progress: 0, armed: false })

  const endPull = () => {
    pullFrom.current = null
    armed.current = false
    setPull((prev) => (prev.progress === 0 ? prev : { progress: 0, armed: false }))
  }

  const onPullDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    /* Reset first, and before every early return: a pull that the browser
       turned into a scroll never produces a click, so a flag left standing
       would eat the *next* genuine tap instead. */
    swallowClick.current = false
    if (!phone || e.pointerType === 'mouse' || check.checking) return
    const scroller = (e.target as HTMLElement | null)?.closest?.('.list-pane')
    if (!(scroller instanceof HTMLElement) || scroller.scrollTop > 0) return
    pullFrom.current = { y: e.clientY, scroller }
  }

  const onPullMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const from = pullFrom.current
    if (!from) return
    const dy = e.clientY - from.y
    /* The same 10px that decides a swipe from a tap, reused rather than
       re-picked: below it this is still a press with a shaky thumb. */
    if (dy >= AXIS_LOCK_PX) swallowClick.current = true
    const next = resolvePull(dy, from.scroller.scrollTop)
    armed.current = next.armed
    setPull((prev) =>
      prev.progress === next.progress && prev.armed === next.armed ? prev : next,
    )
  }

  const onPullUp = () => {
    const fire = armed.current
    endPull()
    if (fire) void check.checkNow()
  }

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
    /*
     * `copyText`, not `navigator.clipboard.writeText`.
     *
     * The bare web call is what made this button report "copy failed" on every
     * Android device while working everywhere else: inside a WebView the async
     * clipboard write is refused by a permission layer that has nobody to ask.
     * `core/clipboard.ts` tries the native clipboard first and only then the
     * web ones, and answers with a boolean rather than a rejection — so this
     * `else` is now a genuine failure on every platform, not a platform gap
     * wearing a failure's clothes.
     */
    if (await copyText(value)) {
      dispatch({ type: 'markCodeCopied', id: hit.id })
      setJustCopied(hit.id)
      window.setTimeout(() => setJustCopied((id) => (id === hit.id ? null : id)), 2000)
      /*
       * The one moment in this app where the screen is the least likely place
       * the user is looking: the code was wanted for a form in another app,
       * and the tick that confirms the copy appears on the screen they are
       * about to leave. `haptic` is a no-op on desktop and when the setting is
       * off — see core/haptics.ts. It is fired here rather than inside
       * `copyText` because `copyText` has no access to settings and is also
       * used for copying diagnostics, which nobody is waiting on.
       */
      haptic('copy', state.settings.haptics)
    } else {
      toast.push({ tone: 'error', title: t('inbox.copyFailed') })
      haptic('fail', state.settings.haptics)
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

  /**
   * Every card on this screen, marked as dealt with, in one press.
   *
   * ## What it does and does not reach
   *
   * `markAllCodesRead` walks `state.codeHits` — the whole code history, which
   * is exactly what this screen lists — and stamps `readAt` on every entry that
   * has none. It reaches cards the current filter or search is hiding, which is
   * why the count on the button comes from `unread` (computed over all of
   * `state.codeHits`) and not from `visible`: a button that says "3" and clears
   * 40 would be lying about its own scope.
   *
   * It does *not* touch the mailbox. A code hit is this app's own note that it
   * found something in a message; the message it came from stays unread in the
   * inbox until the inbox is told otherwise. That is the whole content of
   * `codes.markAllReadScope`, and it is in the toast rather than on the button
   * because it is the thing somebody wants to know immediately *after*
   * pressing, not a caption to read before.
   *
   * (The 24-hour / 20-message window in `CodeCheck` bounds which *new* mail is
   * examined for codes. It has nothing to do with this: the history is already
   * found, already on the screen, and all of it is marked.)
   *
   * One dispatch, not one per card — the reducer maps the array once.
   */
  const markAllRead = () => {
    const n = unread
    if (n === 0) return
    dispatch({ type: 'markAllCodesRead' })
    toast.push({
      tone: 'success',
      title: t('codes.markAllReadDone', { n }),
      detail: t('codes.markAllReadScope'),
    })
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

  /**
   * The one line under the title, and the only thing the head still says about
   * the check. It replaces a button that was reporting its own state ("Check
   * now" / "Checking…") in a row that cost the screen a whole line.
   */
  const headNote = check.checking
    ? t('codes.checking')
    : check.waitingUntil
      ? t('codes.waitingFor', { time: formatRemaining(waitLeft) })
      : check.lastCheckedAt
        ? t('codes.lastChecked', { ago: formatAgo(check.lastCheckedAt) })
        : undefined

  /**
   * "Why this one", shared by both card shapes.
   *
   * `facts` is what the hero card puts here instead of on its face: the source
   * and the account are the same on every card from the same sender, so they
   * are reference material rather than something to read at a glance.
   */
  const renderWhy = (hit: CodeHit, isLink: boolean, facts?: ReactNode) => (
    <div className="codewhy">
      {facts ? <div className="codewhy__facts">{facts}</div> : null}
      <div className="codewhy__section">
        <div className="codewhy__label">{t('codes.whyPicked')}</div>
        <ul className="codewhy__list">
          {(hit.reasons ?? []).map((r, i) => (
            <li key={`${r.code}-${i}`}>{t(`codes.reason.${r.code}`, { detail: r.detail ?? '' })}</li>
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
                {/* Only a genuine contender can be promoted; a struck-out
                    postcode is shown to explain the decision, not offered as
                    an answer. */}
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
  )

  /** Where a hit was read out of the mail — the same wording on both shapes. */
  const sourceLabel = (hit: CodeHit) =>
    t(
      hit.source === 'subject'
        ? 'codes.sourceSubject'
        : hit.source === 'link'
          ? 'codes.sourceLink'
          : 'codes.sourceBody',
    )

  /**
   * The whole of big-digit mode: one code, the two facts that say it is the
   * right one, and the way out.
   *
   * Built here rather than inline in the tree below so the list branch stays
   * readable — the render already carries two card shapes and a virtual list.
   * Wrapped in `.list-pane` like the empty state is, because that class is what
   * gives this screen its scroller; without it the block sits in the flex column
   * and the foot row can be pushed under the tab bar at 125% text.
   *
   * The sender and the time stay at the ordinary body rank. That is the point of
   * them: they are what says the code you are about to paste came from the site
   * you are actually signing in to, and this mode exists for people who find
   * small type hard — shrinking them to make the digits look bigger by contrast
   * would be taking away the half of the card that has to be read to be safe.
   */
  const bigCard = (() => {
    if (!bigMode || !newestCode) return null
    const hit = newestCode
    const { name, address } = splitFrom(hit.from)
    const copied = justCopied === hit.id
    const expiresAt = hit.expiresAt
    const remaining = expiresAt !== undefined ? expiresAt - now : undefined
    const expired = remaining !== undefined && remaining <= 0
    /* The rendered string, spaces included: `482 913` costs seven advances in a
       monospace, and it is the rendered width the size has to be measured from
       — see `--code-len` in 23-codes.css. */
    const shown = grouped(hit.value)
    const timerLabel =
      remaining === undefined
        ? undefined
        : expired
          ? t('codes.expired')
          : t('codes.expiresIn', { time: formatRemaining(remaining) })

    return (
      <div className="list-pane">
        <div
          className="codebig"
          data-copied={copied || undefined}
          data-expired={expired || undefined}
        >
          <button
            type="button"
            className="codebig__body"
            title={t('codes.readHint')}
            onClick={() => void copy(hit)}
          >
            <span
              className="codebig__digits"
              style={{ '--code-len': String(shown.length) } as CSSProperties}
            >
              {shown}
            </span>
            <span className="codebig__cta">
              {copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
              <span>{copied ? t('common.copied') : t('codes.tapToCopy')}</span>
            </span>
          </button>

          <div className="codebig__meta">
            <span className="codebig__from">{name || address}</span>
            <span title={formatDateTime(hit.date)}>{formatAgo(hit.date)}</span>
          </div>
          <div className="codebig__subject">{hit.subject || t('inbox.noSubject')}</div>

          <div className="codebig__foot">
            {/* Only when the mail actually said how long the code lasts. A ring
                with a guessed duration would be a picture of a number nobody
                supplied — see the note on the hero card's ring. */}
            {expiresAt !== undefined ? (
              <>
                <span className="codering" title={timerLabel}>
                  <CountdownRing fireAt={expiresAt} armedAt={hit.date} size="sm" />
                </span>
                <span className={expired ? 'chip chip--warning' : 'chip chip--timer'}>
                  {timerLabel}
                </span>
              </>
            ) : null}
            <Button
              variant="ghost"
              icon={<IconZoomOut size={16} />}
              onClick={() => setBigDigits(false)}
            >
              {t('codes.bigDigitsExit')}
            </Button>
          </div>
        </div>
      </div>
    )
  })()

  return (
    /* `data-screen` names this screen for `scripts/layout-probe.mjs`: Inbox and
       Codes both render `.view.view--list` and are indistinguishable from
       outside, so a probe navigating between them could not tell it had arrived.
       Same reason `.nav__item` carries `data-view`. */
    <div
      className="view view--list"
      data-screen="codes"
      ref={viewRef}
      onPointerDown={onPullDown}
      onPointerMove={onPullMove}
      onPointerUp={onPullUp}
      onPointerCancel={endPull}
      /* A drag that travelled far enough to be a pull must not also land as a
         tap on whatever card happened to be under the thumb — and on this
         screen a tap copies. Swallowed in the capture phase, before the card's
         own handler ever sees it. */
      onClickCapture={(e) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="view__inner">
        {phone ? (
          /*
            One row of chrome instead of four.

            The head used to carry Check now, I'm waiting, Mark all read and
            Clear history — four `nowrap` buttons in a row that `17-phone.css`
            gives `flex: 1 1 100%`, so on a phone the screen opened with a full
            line of controls above the first code. What is left here is what
            only the head can say (which screen this is, and how long ago it
            looked) and two 48px targets: search, and everything else.
          */
          <PageHead
            title={t('codes.title')}
            hideTitle
            subtitle={headNote}
            action={
              <>
                {/*
                  一键已读, promoted out of the overflow menu.

                  It was a menu item, which is three presses (open the menu,
                  find it, press it) for something whose entire value is being
                  one. The head can afford it here in a way `InboxView`'s band
                  cannot: `17-phone.css` gives `.page-head__actions` its own
                  full-width row on a phone, so a third 44px target costs no
                  width from the title.

                  Only while something is unread, and pressing it is what makes
                  it go away — so the row is back to two targets the moment
                  there is nothing for a third to do.

                  `IconCheckCircle`, matching the inbox's twin of this button.
                  `IconCheck` is already the "copied ✓" mark on every card
                  below.
                */}
                {unread > 0 ? (
                  <IconButton
                    label={t('codes.markAllReadNow', { n: unread })}
                    onClick={markAllRead}
                  >
                    <IconCheckCircle size={17} />
                  </IconButton>
                ) : null}
                <IconButton
                  label={t('codes.search')}
                  aria-expanded={searchOpen}
                  onClick={toggleSearch}
                >
                  {searchOpen ? <IconX size={17} /> : <IconSearch size={17} />}
                </IconButton>
                <div className="codesmenu">
                  <IconButton
                    label={t('codes.more')}
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <IconMore size={17} />
                  </IconButton>
                  {menuOpen ? (
                    <div className="codesmenu__list" role="menu" aria-label={t('codes.more')}>
                      {/* The visible twin of the pull. Everything reachable by
                          gesture is reachable by pressing something. */}
                      <button
                        type="button"
                        role="menuitem"
                        className="codesmenu__item"
                        disabled={!hasAnyInbox || check.checking}
                        onClick={() => {
                          setMenuOpen(false)
                          void check.checkNow()
                        }}
                      >
                        <IconRefresh size={16} />
                        <span>{check.checking ? t('codes.checking') : t('codes.checkNow')}</span>
                      </button>
                      {/* The wait's home is the empty state, where it is the
                          only thing to do. It is here as well because a wait
                          cannot be started — or, worse, stopped — from an
                          empty state that is no longer on screen. */}
                      {check.waitingUntil ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="codesmenu__item"
                          onClick={() => {
                            setMenuOpen(false)
                            check.stopWaiting()
                          }}
                        >
                          <IconX size={16} />
                          <span>{t('codes.stopWaiting', { time: formatRemaining(waitLeft) })}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className="codesmenu__item"
                          disabled={!hasAnyInbox}
                          title={t('codes.waitHint', { s: WAIT_PRESETS[0] })}
                          onClick={() => {
                            setMenuOpen(false)
                            check.startWaiting(WAIT_PRESETS[0])
                          }}
                        >
                          <IconClock size={16} />
                          <span>{t('codes.wait')}</span>
                        </button>
                      )}
                      {/* Big-digit mode's phone door.
                          In the menu rather than in the head because the head
                          has exactly two 48px targets and this is not the third
                          thing a thumb reaches for — but it has to be pressable
                          from *somewhere* that is always on screen, because it
                          is a stored preference and a person who turned it on
                          by accident needs a way back that does not involve
                          finding Settings.
                          `menuitemcheckbox`, not `menuitem`: this one reports a
                          state rather than performing an action, and a screen
                          reader should say "on"/"off" rather than read a label
                          that changes underneath it. */}
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={bigDigits}
                        className="codesmenu__item"
                        onClick={() => {
                          setMenuOpen(false)
                          setBigDigits(!bigDigits)
                        }}
                      >
                        {bigDigits ? <IconZoomOut size={16} /> : <IconZoomIn size={16} />}
                        <span>{t('codes.bigDigits')}</span>
                      </button>
                      {/* 全部标为已读 used to be here. It moved to the head
                          beside the magnifier, where it is one press instead of
                          three; leaving a copy behind would be a second door to
                          a room already visible from the corridor. */}
                      {state.codeHits.length > 0 ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="codesmenu__item"
                          onClick={() => {
                            setMenuOpen(false)
                            void clearAll()
                          }}
                        >
                          <IconTrash size={16} />
                          <span>{t('codes.clear')}</span>
                        </button>
                      ) : null}
                      {/* `.page-head__search` — the command palette's only
                          tappable door on a phone — is switched off on this
                          screen by `23-codes.css`, because two magnifiers a
                          thumb apart meaning two different searches is worse
                          than one of them being a menu item. The door is not
                          removed, it moved here. */}
                      {openPalette ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="codesmenu__item"
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
              </>
            }
          />
        ) : (
          /* The desktop head, unchanged: a pointer has no pull gesture, the
             row has the width for four labelled buttons, and the tab strip
             above already names the screen (hence `hideTitle`). */
          <PageHead
            title={t('codes.title')}
            hideTitle
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
                {/* The same mode as the phone's menu item, as an ordinary
                    labelled button — this row has the width for it, and a
                    desktop has no overflow menu to hide it in. `aria-pressed`
                    rather than a label that flips, so the control keeps one
                    name and reports its own state. */}
                <Button
                  variant="ghost"
                  icon={bigDigits ? <IconZoomOut size={15} /> : <IconZoomIn size={15} />}
                  aria-pressed={bigDigits}
                  onClick={() => setBigDigits(!bigDigits)}
                >
                  {t('codes.bigDigits')}
                </Button>
                {/* The same one press as the phone's head button, with the room
                    to print the count on its face rather than only in its
                    accessible name. */}
                {unread > 0 ? (
                  <Button
                    variant="ghost"
                    icon={<IconCheckCircle size={15} />}
                    onClick={markAllRead}
                  >
                    {t('codes.markAllReadNow', { n: unread })}
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
        )}

        {/* The Android 15-minute background floor used to be stated here in a
            permanent info banner. Removed on request (2026-08-12): it was a
            standing sentence about a system limit this screen cannot change,
            occupying the band directly above the codes themselves on every
            single visit. The floor still exists — `InboxSyncWorker.java` still
            documents it, and "Check now" still exists for when you cannot
            wait. What is gone is telling you about it every time. */}

        {/* D5 — what the last press actually did. Six sentences, not "failed". */}
        {check.lastOutcome ? (
          <div className="checkbar" data-tone={toneOf(check.lastOutcome)}>
            <span className="checkbar__icon">
              {check.lastOutcome === 'found' ? <IconCheck size={15} /> : <IconAlert size={15} />}
            </span>
            {/* The outcome sentence and nothing else. Each one used to be
                followed by a grey second sentence explaining it; the six
                outcomes already say what happened in their own words, and the
                server's own message still follows when there is one. */}
            <span className="checkbar__text">
              <strong>{t(`codes.outcome.${check.lastOutcome}`)}</strong>
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

        {/* Three buttons that answer a question nobody has while every hit on
            the screen is a code. `canFilter` is the whole rule: a link has to
            be here beside a code before the choice means anything. */}
        {/* Both of these operate the list, and in big-digit mode there is no
            list — a filter or a search field that changes nothing visible is
            worse than one that is not there. The `filter` value is left alone
            rather than reset, so leaving the mode puts the screen back exactly
            as it was found. */}
        {canFilter && !bigMode ? (
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
        ) : null}

        {/* On a phone the field is what the magnifier opens; on a desktop it
            stays where it has always been, because that row has the width and
            a pointer has nothing better to do with it. */}
        {state.codeHits.length > 0 && !bigMode && (!phone || searchOpen) ? (
          <SearchInput value={query} onChange={setQuery} placeholder={t('codes.searchPlaceholder')} />
        ) : null}

        {/* Only while a thumb is actually pulling — a zero-height element in a
            gapped column still costs the gap. */}
        {pull.progress > 0 ? (
          <div
            className="codespull"
            data-armed={pull.armed || undefined}
            style={{ '--pull': pull.progress } as CSSProperties}
          >
            <IconRefresh size={15} />
            <span>{pull.armed ? t('codes.pullRelease') : t('codes.pull')}</span>
          </div>
        ) : null}

        {/* Big-digit mode replaces the list outright. It is deliberately *not*
            allowed to replace the empty state — `bigMode` is false when there is
            no code to show, so a screen with nothing on it still says what to do
            next instead of drawing a large empty box. */}
        {bigCard ? (
          bigCard
        ) : visible.length === 0 ? (
          <div className="list-pane">
            {/*
              One line, and it has to be something to *do*.

              The three hints this replaces were deleted on purpose: each of
              them described what the screen was for, which is not information
              to anyone already looking at it. This one names the next action
              — ask the sender for the code, then pull — and it is only shown
              on the shell that has a pull to offer.
            */}
            <EmptyState
              icon={<IconKey size={24} />}
              title={state.codeHits.length === 0 ? t('codes.empty') : t('common.empty')}
              hint={phone ? (hasAnyInbox ? t('codes.emptyPull') : t('codes.emptyNoInbox')) : undefined}
              action={
                !hasAnyInbox && onGoToInbox ? (
                  <Button variant="primary" onClick={onGoToInbox}>
                    {t('nav.inbox')}
                  </Button>
                ) : /* The wait's home. It was the second of four buttons in the
                       head; here it is the only thing on the screen, which is
                       what it is: the one useful answer to "it has not come
                       yet". */
                phone && hasAnyInbox ? (
                  check.waitingUntil ? (
                    <Button variant="secondary" icon={<IconX size={15} />} onClick={check.stopWaiting}>
                      {t('codes.stopWaiting', { time: formatRemaining(waitLeft) })}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      icon={<IconClock size={15} />}
                      onClick={() => check.startWaiting(WAIT_PRESETS[0])}
                      title={t('codes.waitHint', { s: WAIT_PRESETS[0] })}
                    >
                      {t('codes.wait')}
                    </Button>
                  )
                ) : undefined
              }
            />
          </div>
        ) : (
          <VirtualList
            items={visible}
            keyOf={(hit) => hit.id}
            /* Re-measured after the type came down, not scaled from the old
               number: a code card is 105.6px and a link card 123.3px at the
               default density (they were 133.6 and 149.6), and `VirtualList`
               measures the 12px `--row-gap` along with the row. 118 is the code
               card plus its gap — the same convention the old 148 followed,
               since a screen called Codes is mostly codes and the link cards
               that are taller get measured as they scroll in.

               Unchanged by the phone round, and deliberately: the compact rows
               are the same markup and the same rules they were, so the number
               they were measured for still describes them. Two numbers taken
               at 360x800 while that round was being built, for whoever revisits
               this: the same code card is 221.8px there (the action row wraps
               to its own line under 840px, and the meta chips wrap with it) and
               the hero is 241.4px. So this estimate is a desktop figure — which
               it always was — and it only decides the first paint and the
               scrollbar, since every row is corrected from the DOM as it comes
               into view. Widening it to a phone number would make the desktop
               wrong instead; splitting it per shell is a `VirtualList` change,
               not a `CodesView` one. */
            estimate={118}
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

              /**
               * The one card you came here for, at 二号.
               *
               * Rendered in place, not lifted to the top: the row order on this
               * screen is fixed and this is a change of *shape*, not of
               * position. Everything that is not the digits is either one line
               * or one of at most two chips — the countdown, which changes, and
               * the one fact that is unusual about this code. Where it came
               * from and which account it landed in are the same on every card
               * from that sender, so they moved into "why this one".
               */
              if (hit.id === heroId) {
                const unusual = hit.oneTime
                  ? t('codes.oneTime')
                  : hit.confidence !== 'high'
                    ? t('codes.lowConfidence')
                    : undefined
                return (
                  <div
                    className="codehero"
                    data-copied={copied || undefined}
                    data-expired={expired || undefined}
                    data-new={foundKeys.has(keyOfHit(hit)) || undefined}
                  >
                    <div
                      className="codehero__body"
                      role="button"
                      tabIndex={0}
                      title={t('codes.readHint')}
                      onClick={primary}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          primary()
                        }
                      }}
                    >
                      <div className="codehero__digits">{grouped(hit.value)}</div>
                      {/* The card has always been the copy button and never
                          said so — the only thing that did was a `title`,
                          which a phone has no way to show. The small copy
                          button that used to sit beside it is gone from this
                          card: it was a 32px target competing with a 300px
                          one that does the same thing. */}
                      <div className="codehero__cta">
                        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        <span>{copied ? t('common.copied') : t('codes.tapToCopy')}</span>
                      </div>
                    </div>

                    <div className="codehero__from">
                      {name ? <strong>{name}</strong> : null}
                      <span className="codecard__address">{address}</span>
                      <span title={formatDateTime(hit.date)}>{formatAgo(hit.date)}</span>
                    </div>
                    <div className="codehero__subject">{hit.subject || t('inbox.noSubject')}</div>

                    <div className="codehero__foot">
                      {/*
                        The countdown as a shape, beside the same countdown in
                        words — never instead of it. The ring is read in the time
                        it takes to see it ("nearly gone" / "plenty left"); the
                        chip is what a screen reader gets and what tells you the
                        actual figure. Same arrangement `ScheduleView` uses, and
                        the reason the ring itself is `aria-hidden`.

                        Only when `hit.expiresAt` exists. A code whose mail never
                        said how long it lasts has no denominator, and the two
                        available fakes — assume ten minutes, or fill the arc
                        from arrival — are both a picture of a number nobody
                        supplied. Nothing is drawn instead, which is the truth.

                        `hit.expiresAt` in the test rather than the `remaining`
                        computed from it, so TypeScript narrows the prop below;
                        `armedAt` is when the mail arrived, which is genuinely
                        when this wait started.
                      */}
                      {hit.expiresAt !== undefined ? (
                        <span
                          className="codering"
                          title={
                            expired
                              ? t('codes.expired')
                              : t('codes.expiresIn', { time: formatRemaining(remaining ?? 0) })
                          }
                        >
                          <CountdownRing fireAt={hit.expiresAt} armedAt={hit.date} />
                        </span>
                      ) : null}
                      <div className="codehero__chips">
                        {remaining !== undefined ? (
                          <span className={expired ? 'chip chip--warning' : 'chip chip--timer'}>
                            {expired
                              ? t('codes.expired')
                              : t('codes.expiresIn', { time: formatRemaining(remaining) })}
                          </span>
                        ) : null}
                        {unusual ? <span className="chip chip--warning">{unusual}</span> : null}
                      </div>
                      {/* Always offered here, even with no reasons recorded:
                          this is the only door to the source and the account
                          now that they are no longer printed on the face. No
                          `stopPropagation` — unlike the compact card, this row
                          is a sibling of the press target rather than inside
                          it, so a press here was never a press on the card. */}
                      <div className="codehero__actions">
                        <Button
                          variant="ghost"
                          icon={<IconHelp size={15} />}
                          title={open ? t('codes.whyHide') : t('codes.why')}
                          onClick={() => setExplaining(open ? null : hit.id)}
                          aria-expanded={open}
                        >
                          {open ? t('codes.whyHide') : t('codes.why')}
                        </Button>
                      </div>
                    </div>

                    {open
                      ? renderWhy(
                          hit,
                          false,
                          <>
                            <span className="chip">{accountName(hit.accountId)}</span>
                            <span className="chip chip--quiet">{sourceLabel(hit)}</span>
                            {hit.copiedAt && !copied ? (
                              <span className="chip chip--quiet">{t('codes.alreadyCopied')}</span>
                            ) : null}
                          </>,
                        )
                      : null}
                  </div>
                )
              }

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
                          {hit.link?.anchorText || hit.link?.purposeConfidence === 'low' ? (
                            <div className="codecard__purpose">
                              {hit.link?.anchorText ? (
                                <span className="chip chip--strong">
                                  {t(purposeKey(hit.link?.purpose), {
                                    host: hit.link?.domain ?? hostOf(hit.value),
                                  })}
                                </span>
                              ) : null}
                              {hit.link?.purposeConfidence === 'low' ? (
                                <span className="chip chip--quiet">{t('codes.purposeUnsure')}</span>
                              ) : null}
                            </div>
                          ) : null}
                          {/* Where it goes, in full and on the card.
                              This line used to be the host name alone, with the
                              rest of the URL reachable only through the `title`
                              below — so on a phone, which has no hover, the path
                              and query were not rendered anywhere at all. That is
                              what "the link content is cut off" was about. The
                              stylesheet breaks it `anywhere` and clamps it to two
                              lines, so a four-hundred-character tracking URL
                              cannot grow the card without bound; the host is at
                              the front, where the clamp can never reach it. */}
                          <div className="codecard__url" title={hit.value}>
                            {hit.value}
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
                        <span className="chip chip--quiet">{sourceLabel(hit)}</span>
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

                    {/* `title` on every one of these, matching the label.
                        Below 760px the stylesheet clips `.btn__label` so four
                        labelled buttons fit a 286px card — the accessible name
                        survives the clip, but a hovering pointer on a small
                        window has nothing to read without this. */}
                    <div className="codecard__actions" onClick={(e) => e.stopPropagation()}>
                      {isLink ? (
                        <>
                          <Button
                            variant="primary"
                            icon={<IconExternal size={15} />}
                            title={t('inbox.open')}
                            onClick={() => void openLink(hit)}
                          >
                            {t('inbox.open')}
                          </Button>
                          <Button
                            variant="secondary"
                            icon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                            title={copied ? t('common.copied') : t('codes.copyLink')}
                            onClick={() => void copy(hit)}
                          >
                            {copied ? t('common.copied') : t('codes.copyLink')}
                          </Button>
                          {/* C5 — the laptop-to-phone case: the link is here,
                              the session you want it in is over there. */}
                          <Button
                            variant="ghost"
                            icon={<IconQr size={15} />}
                            title={t('codes.showQr')}
                            onClick={() => setShowingQr(hit)}
                          >
                            {t('codes.showQr')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant={copied ? 'primary' : 'secondary'}
                          icon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                          title={copied ? t('common.copied') : t('common.copy')}
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
                          title={open ? t('codes.whyHide') : t('codes.why')}
                          onClick={() => setExplaining(open ? null : hit.id)}
                          aria-expanded={open}
                        >
                          {open ? t('codes.whyHide') : t('codes.why')}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {open ? renderWhy(hit, isLink) : null}
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
