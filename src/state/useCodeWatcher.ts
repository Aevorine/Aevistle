/**
 * Watches every enabled mailbox for verification codes and sign-in links, and
 * files what it finds into `state.codeHits`.
 *
 * Mounted once by the shell rather than by the screen that displays the
 * results. That is the whole difference between this and the panel it
 * replaces: a code that arrives while you are on the compose screen has to be
 * waiting for you when you switch, and the notification announcing it has to
 * fire whether or not any particular view happens to be mounted. Extraction
 * that only ran inside the inbox screen could do neither.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useApp } from './AppState'
import { getCachedBody, putCachedBody } from '../core/bodyMemo'
import { extractFromMessage, linksFromSanitizedHtml } from '../core/codeExtract'
import type { NewHit } from '../core/codeHistory'
import type { InboxMessageBody } from '../core/bridge'
import type { InboxMessage } from '../core/types'

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

function plainText(body: InboxMessageBody): string {
  if (body.text) return body.text
  if (body.sanitizedHtml) return body.sanitizedHtml.replace(/<[^>]+>/g, ' ')
  return ''
}

export function useCodeWatcher(): void {
  const { state, bridge, dispatch, getInboxMessageBody, i18n } = useApp()

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

  useEffect(() => {
    if (!bridge?.getMessageBody) return
    let cancelled = false

    void (async () => {
      const found: NewHit[] = []

      for (const message of recent) {
        if (cancelled) return
        if (examined.current.has(message.id)) continue

        let body = getCachedBody(message.id)
        if (!body) {
          try {
            body = await getInboxMessageBody(message)
            if (cancelled) return
            putCachedBody(message.id, body)
          } catch {
            // Leave it unexamined so a transient IMAP failure gets another go
            // on the next sync rather than being written off permanently.
            continue
          }
        }

        examined.current.add(message.id)
        const links = body.sanitizedHtml ? linksFromSanitizedHtml(body.sanitizedHtml) : []
        for (const hit of extractFromMessage(message.subject, plainText(body), links)) {
          found.push(toNewHit(message, hit))
        }
      }

      if (cancelled || found.length === 0) {
        primed.current = true
        return
      }

      dispatch({ type: 'recordCodes', hits: found })

      /**
       * One notification, carrying the code itself.
       *
       * High confidence only, and only for codes — a link is too long to read
       * in a notification and too risky to invite a reflexive click on. If
       * several arrived at once, the newest is announced and the rest are
       * left to the screen; a burst of five notifications is not five times
       * as useful as one.
       */
      const announce = found.filter(
        (h) =>
          h.kind === 'code' &&
          h.confidence === 'high' &&
          // Only genuinely recent arrivals. Widening the *examination* window
          // to a day must not turn opening the app into a burst of
          // notifications about codes that expired hours ago.
          Date.now() - h.date <= ANNOUNCE_WINDOW_MS,
      )
      if (primed.current && announce.length > 0 && state.settings.notifyOnCode !== false) {
        const newest = announce.reduce((a, b) => (b.date > a.date ? b : a))
        void bridge
          .notify(i18n.t('codes.notifyTitle', { code: newest.value }), newest.from, { code: true })
          .catch(() => {
            /* A refused notification must not take the watcher down. */
          })
      }
      primed.current = true
    })()

    return () => {
      cancelled = true
    }
    // `getInboxMessageBody` and `i18n` are stable for the lifetime of the
    // provider; re-running on them would restart the queue on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, bridge, dispatch, state.settings.notifyOnCode])
}

function toNewHit(
  message: InboxMessage,
  hit: ReturnType<typeof extractFromMessage>[number],
): NewHit {
  return {
    kind: hit.kind,
    value: hit.value,
    confidence: hit.confidence,
    source: hit.source,
    accountId: message.accountId,
    messageId: message.id,
    from: message.from,
    subject: message.subject,
    date: message.date,
  }
}
