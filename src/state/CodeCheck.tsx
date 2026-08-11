/**
 * Watches every enabled mailbox for verification codes and sign-in links, files
 * what it finds into `state.codeHits`, and exposes the two things a person
 * waiting for a code actually wants: *check now*, and *tell me the moment it
 * lands*.
 *
 * Mounted once by the shell rather than by the screen that displays the
 * results. That is the whole difference between this and the panel it replaces:
 * a code that arrives while you are on the compose screen has to be waiting for
 * you when you switch, and the notification announcing it has to fire whether or
 * not any particular view happens to be mounted. Extraction that only ran inside
 * the inbox screen could do neither.
 *
 * The manual check is deliberately not "the timer, but sooner". A timed sync
 * that finds nothing is not worth saying anything about; a *press* that finds
 * nothing has to say which kind of nothing it was, because "no new mail",
 * "three new mails, none with a code", "your password was rejected" and "there
 * is no network" send the person to four different places and a single
 * "check failed" sends them nowhere.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useApp } from './AppState'
import { getCachedBody, putCachedBody } from '../core/mail/bodyMemo'
import { copyText } from '../core/platform/clipboard'
import { extractFromMessage, learnRule, linksFromSanitizedHtml } from '../core/ops/codeExtract'
import type { Extracted } from '../core/ops/codeExtract'
import type { NewHit } from '../core/ops/codeHistory'
import type { InboxMessageBody } from '../core/platform/bridge'
import type { CodeHit, InboxMessage } from '../core/types'

/**
 * How far back to look for codes.
 *
 * This was fifteen minutes, and fifteen minutes was wrong in a way that made
 * the whole feature look broken. Nothing guarantees the app is running when a
 * code arrives: the window may be closed, the sync interval may be five
 * minutes, the phone may have been in a pocket. Open the app twenty minutes
 * later and every message was already outside the window, so no body was ever
 * read, no code was ever extracted, and the codes screen sat empty while the
 * mail sat in the inbox one tab away.
 *
 * A day. A code older than that has expired anyway, but the screen should
 * still be able to *show* you the one that arrived while you were away —
 * which is the entire point of it.
 */
const EXAMINE_WINDOW_MS = 24 * 60 * 60_000

/**
 * How many bodies to read ahead of being asked.
 *
 * Serial and capped: this competes with whatever the user is actually doing.
 * Bodies already in the on-disk cache come back without a round trip, so on
 * every run after the first this is nearly free — the cap is there for the
 * first sync on an account with a full mailbox.
 */
const EXAMINE_LIMIT = 20

/** A notification is only worth raising for something that just landed. */
const ANNOUNCE_WINDOW_MS = 15 * 60_000

/** How often the waiting mode asks, once the user has said they are waiting. */
const WAIT_POLL_MS = 5_000

/** Offered wait lengths, in seconds. */
export const WAIT_PRESETS = [60, 120] as const

/**
 * What a manual check turned up.
 *
 * Six outcomes rather than success/failure because each one has a different
 * next step, and the screen's job is to point at it: resend the code, look at
 * the mail itself, fix the password, check the network.
 */
export type CheckOutcome =
  | 'found'
  | 'noNewMail'
  | 'newMailNoCode'
  | 'noAccount'
  | 'authFailed'
  | 'offline'
  | 'failed'

export interface CodeCheckApi {
  checking: boolean
  lastCheckedAt?: number
  lastOutcome?: CheckOutcome
  /** The server's own words for a failure — never paraphrased into a guess. */
  lastError?: string
  /** Keys of the hits the most recent manual check produced, for the "new" mark. */
  lastFoundKeys: string[]
  /** Epoch ms the current wait ends at, or `undefined` when not waiting. */
  waitingUntil?: number
  checkNow: () => Promise<void>
  startWaiting: (seconds: number) => void
  stopWaiting: () => void
  /** Record that a shown value was wrong, or that another candidate was right (B8). */
  correct: (hit: CodeHit, choice: { rejected?: string; preferred?: string }) => void
}

const CodeCheckContext = createContext<CodeCheckApi | null>(null)

export function useCodeCheck(): CodeCheckApi {
  const api = useContext(CodeCheckContext)
  if (!api) throw new Error('useCodeCheck must be used inside <CodeCheckProvider>')
  return api
}

function plainText(body: InboxMessageBody): string {
  if (body.text) return body.text
  if (body.sanitizedHtml) return body.sanitizedHtml.replace(/<[^>]+>/g, ' ')
  return ''
}

/** `${messageId}\x00${kind}\x00${value}` — the same identity `mergeHits` uses. */
function keyOf(hit: Pick<NewHit, 'messageId' | 'kind' | 'value'>): string {
  return `${hit.messageId}\x00${hit.kind}\x00${hit.value}`
}

/**
 * Which failure this was, from the message the transport gave us.
 *
 * Pattern-matching an error string is unlovely, and it is still the right call:
 * the alternative is a typed error taxonomy threaded through IMAP, the Electron
 * bridge and the Android layer for the sole benefit of one sentence on one
 * screen. Anything unrecognised stays `failed` and shows the raw text, so a
 * miss degrades to "here is exactly what the server said" rather than to a
 * wrong diagnosis.
 */
function classify(error: string): CheckOutcome {
  if (/auth|login failed|password|credential|invalid user|LOGIN|AUTHENTICATIONFAILED|535|534/i.test(error)) {
    return 'authFailed'
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network|offline|socket|timed? ?out|getaddrinfo/i.test(error)) {
    return 'offline'
  }
  return 'failed'
}

export function CodeCheckProvider({ children }: { children: ReactNode }) {
  const { state, bridge, dispatch, getInboxMessageBody, syncInboxAccount, i18n } = useApp()

  const [checking, setChecking] = useState(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | undefined>()
  const [lastOutcome, setLastOutcome] = useState<CheckOutcome | undefined>()
  const [lastError, setLastError] = useState<string | undefined>()
  const [lastFoundKeys, setLastFoundKeys] = useState<string[]>([])
  const [waitingUntil, setWaitingUntil] = useState<number | undefined>()

  const recent = useMemo(() => {
    const cutoff = Date.now() - EXAMINE_WINDOW_MS
    return state.inboxAccounts
      .filter((i) => i.enabled)
      .flatMap((i) => i.messages)
      .filter((m) => m.date >= cutoff)
      .sort((a, b) => b.date - a.date)
      .slice(0, EXAMINE_LIMIT)
  }, [state.inboxAccounts])

  /**
   * Messages already run through extraction.
   *
   * Keyed by message id and never cleared: re-extracting a message that
   * yielded nothing is pure cost, and one that yielded something is already
   * recorded — `mergeHits` would discard the duplicate anyway, but only after
   * paying for the fetch and the regex pass again.
   *
   * This is also what makes "check now" cheap. A press re-syncs headers, but
   * only bodies belonging to messages never seen before are fetched, so a check
   * that finds nothing costs one round trip rather than twenty.
   */
  const examined = useRef(new Set<string>())

  /**
   * Notifications are skipped entirely until the first pass has finished.
   *
   * Otherwise every code still inside the fifteen-minute window fires a
   * notification the moment the app starts — announcing, as news, codes the
   * user has already used.
   */
  const primed = useRef(false)

  /* Read inside callbacks that must not be re-created on every keystroke. */
  const rulesRef = useRef(state.settings.codeRules ?? [])
  rulesRef.current = state.settings.codeRules ?? []
  const autoCopyRef = useRef(state.settings.autoCopyCode !== false)
  autoCopyRef.current = state.settings.autoCopyCode !== false

  /**
   * Read every unexamined message and file what it yields.
   *
   * Returns the hits so a manual check can describe its own result; the timed
   * pass ignores the return value entirely.
   */
  const runExtraction = useCallback(
    async (messages: InboxMessage[], isCancelled: () => boolean): Promise<NewHit[]> => {
      if (!bridge?.getMessageBody) return []
      const found: NewHit[] = []

      for (const message of messages) {
        if (isCancelled()) return found
        if (examined.current.has(message.id)) continue

        let body = getCachedBody(message.id)
        if (!body) {
          try {
            body = await getInboxMessageBody(message)
            if (isCancelled()) return found
            putCachedBody(message.id, body)
          } catch {
            // Leave it unexamined so a transient IMAP failure gets another go
            // on the next sync rather than being written off permanently.
            continue
          }
        }

        examined.current.add(message.id)
        const links = body.sanitizedHtml ? linksFromSanitizedHtml(body.sanitizedHtml) : []
        const hits = extractFromMessage({
          subject: message.subject,
          bodyText: plainText(body),
          links,
          from: message.from,
          rules: rulesRef.current,
        })
        for (const hit of hits) found.push(toNewHit(message, hit))
      }
      return found
    },
    [bridge, getInboxMessageBody],
  )

  const announce = useCallback(
    (found: NewHit[]) => {
      /**
       * One notification, carrying the code itself.
       *
       * High confidence only, and only for codes — a link is too long to read
       * in a notification and too risky to invite a reflexive click on. If
       * several arrived at once, the newest is announced and the rest are
       * left to the screen; a burst of five notifications is not five times
       * as useful as one.
       */
      const worth = found.filter(
        (h) =>
          h.kind === 'code' &&
          h.confidence === 'high' &&
          // Only genuinely recent arrivals. Widening the *examination* window
          // to a day must not turn opening the app into a burst of
          // notifications about codes that expired hours ago.
          Date.now() - h.date <= ANNOUNCE_WINDOW_MS,
      )
      if (worth.length === 0) return null
      const newest = worth.reduce((a, b) => (b.date > a.date ? b : a))
      if (primed.current && state.settings.notifyOnCode !== false) {
        void bridge
          ?.notify(i18n.t('codes.notifyTitle', { code: newest.value }), newest.from, {
            code: true,
            /* The bare digits and the button's word, for the Copy action
               Android puts on this notification. Both are ignored on platforms
               whose notifications carry no controls. */
            value: newest.value,
            copyLabel: i18n.t('common.copy'),
          })
          .catch(() => {
            /* A refused notification must not take the watcher down. */
          })
      }
      return newest
    },
    // `i18n` is stable for the lifetime of the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge, state.settings.notifyOnCode],
  )

  // --- the timed / push-driven pass -----------------------------------------

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found = await runExtraction(recent, () => cancelled)
      if (cancelled) {
        return
      }
      if (found.length > 0) {
        dispatch({ type: 'recordCodes', hits: found })
        announce(found)
      }
      primed.current = true
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, dispatch, runExtraction])

  // --- the button -----------------------------------------------------------

  /** Guards against a second press, and against the poller overlapping itself. */
  const inFlight = useRef(false)

  const checkNow = useCallback(async () => {
    if (inFlight.current) return
    const enabled = state.inboxAccounts.filter((i) => i.enabled)
    if (enabled.length === 0) {
      setLastOutcome('noAccount')
      setLastCheckedAt(Date.now())
      return
    }

    inFlight.current = true
    setChecking(true)
    try {
      const before = new Set(
        state.inboxAccounts.flatMap((i) => i.messages.map((m) => m.id)),
      )

      const results = await Promise.all(
        enabled.map((account) => syncInboxAccount(account.accountId)),
      )

      /* One account failing while another succeeds is not a failed check — the
         code may well have arrived in the one that worked. The failure is only
         the story when nothing succeeded. */
      const failures = results.filter((r) => r && !r.ok)
      const anySuccess = results.some((r) => r?.ok)

      const messages = results
        .flatMap((r) => r?.inbox?.messages ?? [])
        .filter((m) => m.date >= Date.now() - EXAMINE_WINDOW_MS)
        .sort((a, b) => b.date - a.date)
        .slice(0, EXAMINE_LIMIT)

      const arrived = messages.filter((m) => !before.has(m.id))
      const found = await runExtraction(messages, () => false)

      if (found.length > 0) {
        dispatch({ type: 'recordCodes', hits: found })
        const newest = announce(found)
        setLastFoundKeys(found.map(keyOf))
        setLastOutcome('found')
        setLastError(undefined)
        /*
         * Auto-copy is confined to the wait, on purpose. Replacing the
         * clipboard is destructive — whatever was on it is gone — so it happens
         * only inside the window where the user has said, in as many words,
         * that the next code is the thing they want.
         */
        if (newest && autoCopyRef.current && waitingUntil !== undefined) {
          /* Via `core/clipboard`, which reaches the native clipboard on
             Android — the web call this used to make was refused there, so
             auto-copy has never once worked on a phone. Its answer is still
             ignored: the card is right there to press either way. */
          await copyText(newest.value)
        }
        if (waitingUntil !== undefined) setWaitingUntil(undefined)
      } else if (failures.length > 0 && !anySuccess) {
        const error = failures[0]?.error ?? ''
        setLastOutcome(classify(error))
        setLastError(error || undefined)
        setLastFoundKeys([])
      } else if (arrived.length > 0) {
        setLastOutcome('newMailNoCode')
        setLastError(undefined)
        setLastFoundKeys([])
      } else {
        setLastOutcome('noNewMail')
        setLastError(undefined)
        setLastFoundKeys([])
      }
      setLastCheckedAt(Date.now())
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }, [state.inboxAccounts, syncInboxAccount, runExtraction, dispatch, announce, waitingUntil])

  // --- waiting mode ---------------------------------------------------------

  const startWaiting = useCallback(
    (seconds: number) => {
      setWaitingUntil(Date.now() + seconds * 1000)
      void checkNow()
    },
    [checkNow],
  )

  const stopWaiting = useCallback(() => setWaitingUntil(undefined), [])

  useEffect(() => {
    if (waitingUntil === undefined) return
    /*
     * The wait ends by itself, always. A poll every five seconds that outlived
     * the screen it was started from would be a background job the user never
     * agreed to and has no way to see — so the timer that stops it is set in
     * the same effect that starts the polling, and unmounting clears both.
     */
    const remaining = waitingUntil - Date.now()
    if (remaining <= 0) {
      setWaitingUntil(undefined)
      return
    }
    const poll = window.setInterval(() => void checkNow(), WAIT_POLL_MS)
    const stop = window.setTimeout(() => setWaitingUntil(undefined), remaining)
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(stop)
    }
  }, [waitingUntil, checkNow])

  // --- corrections ----------------------------------------------------------

  const correct = useCallback(
    (hit: CodeHit, choice: { rejected?: string; preferred?: string }) => {
      const body = getCachedBody(hit.messageId)
      const rules = learnRule(rulesRef.current, {
        from: hit.from,
        rejected: choice.rejected,
        preferred: choice.preferred,
        bodyText: body ? plainText(body) : undefined,
      })
      dispatch({ type: 'patchSettings', patch: { codeRules: rules } })
    },
    [dispatch],
  )

  const api = useMemo<CodeCheckApi>(
    () => ({
      checking,
      lastCheckedAt,
      lastOutcome,
      lastError,
      lastFoundKeys,
      waitingUntil,
      checkNow,
      startWaiting,
      stopWaiting,
      correct,
    }),
    [
      checking,
      lastCheckedAt,
      lastOutcome,
      lastError,
      lastFoundKeys,
      waitingUntil,
      checkNow,
      startWaiting,
      stopWaiting,
      correct,
    ],
  )

  return <CodeCheckContext.Provider value={api}>{children}</CodeCheckContext.Provider>
}

function toNewHit(message: InboxMessage, hit: Extracted): NewHit {
  const base = {
    kind: hit.kind,
    value: hit.value,
    confidence: hit.confidence,
    source: hit.source,
    accountId: message.accountId,
    messageId: message.id,
    from: message.from,
    subject: message.subject,
    date: message.date,
    reasons: hit.reasons,
    alternatives: hit.alternatives,
    /* Measured from when the mail was *sent*, not from now: a code found on an
       app that was closed for ten minutes has ten fewer minutes left, and a
       countdown that pretended otherwise would be worse than no countdown. */
    expiresAt: hit.validity?.ms ? message.date + hit.validity.ms : undefined,
    oneTime: hit.validity?.oneTime,
  }
  if (hit.kind === 'link') {
    return {
      ...base,
      link: {
        purpose: hit.analysis.purpose,
        purposeConfidence: hit.analysis.purposeConfidence,
        host: hit.analysis.host,
        domain: hit.analysis.domain,
        risks: hit.analysis.risks,
        anchorText: hit.anchorText,
      },
    }
  }
  return base
}
