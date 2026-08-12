/**
 * Ctrl+K — go anywhere, find anything, do the common things.
 *
 * The app has seven screens and five kinds of saved object — contacts,
 * templates, reminders and received mail among them — and reaching a
 * particular contact today means: click Contacts, click the search box, type,
 * read. That is fine once and grating on the fiftieth time. One keystroke and
 * a few letters replaces all of it.
 *
 * Results are ranked rather than filtered alphabetically, because "what I
 * meant" is usually a prefix match and almost never the first thing in
 * lexical order. Scoring is deliberately crude — exact, then prefix, then
 * word-start, then substring — since anything cleverer becomes a thing that
 * surprises people, and a search box that surprises you is worse than one that
 * is merely blunt.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconActivity,
  IconClock,
  IconFileText,
  IconInbox,
  IconKey,
  IconMail,
  IconSearch,
  IconSettings,
  IconUsers,
} from './icons'
import { useApp } from '../state/AppState'
import { useI18n, type TranslationKey } from '../i18n'

export type PaletteTarget =
  | 'compose' | 'codes' | 'inbox' | 'schedule' | 'contacts' | 'templates' | 'logs' | 'settings'

export interface PaletteAction {
  id: string
  /** Already-translated label; entries are a mix of UI strings and user data. */
  label: string
  hint?: string
  icon: typeof IconMail
  run: () => void
}

interface Ranked extends PaletteAction {
  score: number
}

/**
 * Higher is better; 0 means "does not match".
 *
 * The gaps between the tiers are large on purpose: a prefix match should
 * always outrank a substring match no matter how much shorter the substring
 * candidate is, and a small tie-break for brevity only decides between
 * candidates already in the same tier.
 */
function score(text: string, query: string): number {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return 1
  if (haystack === needle) return 1000
  if (haystack.startsWith(needle)) return 800 - Math.min(haystack.length, 100)
  // Word starts, including after CJK punctuation and separators people
  // actually type in names: "周会 提醒" should be found by "提醒".
  if (new RegExp(`(^|[\\s\\-_/·、，,.]) ?${escapeRegExp(needle)}`).test(haystack)) {
    return 600 - Math.min(haystack.length, 100)
  }
  if (haystack.includes(needle)) return 400 - Math.min(haystack.length, 100)
  return 0
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Returned by both memos while the palette is shut.
 *
 * Module-level so the identity is stable: a fresh `[]` each time would still
 * invalidate everything downstream of it, which is the exact bug this guards.
 */
const NO_ACTIONS: PaletteAction[] = []
const NO_RESULTS: Ranked[] = []

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onCompose,
  onOpenMessage,
}: {
  open: boolean
  onClose: () => void
  onNavigate: (target: PaletteTarget) => void
  onCompose: (prefill?: { to?: string[]; subject?: string; body?: string }) => void
  /** Chosen a received message: open it in the Inbox reader. */
  onOpenMessage: (messageId: string) => void
}) {
  const { state } = useApp()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    // A frame, not immediately: the dialog is still being laid out and Chrome
    // will silently drop a focus() call on an element that is not yet visible.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20)
    return () => window.clearTimeout(timer)
  }, [open])

  /*
   * Nothing below runs while the palette is shut.
   *
   * The hooks stay where they are — the early return is still after all of
   * them, so the hook order never changes — but the *work* does not happen.
   * Without this guard every render of the shell rebuilt an array of
   * `8 + contacts + templates + jobs` action objects, mapped it into a second
   * array of spreads, and (once anything had been typed) constructed a fresh
   * `RegExp` per candidate to score it. That is the cost of a search box that
   * is not on screen, paid on every keystroke into the compose textarea.
   *
   * Opening the palette clears the query first (the effect above), so there is
   * nothing to show that this defers.
   */
  const actions = useMemo<PaletteAction[]>(() => {
    if (!open) return NO_ACTIONS

    const NAV: Array<[PaletteTarget, TranslationKey, typeof IconMail]> = [
      ['compose', 'nav.compose', IconMail],
      ['codes', 'nav.codes', IconKey],
      ['inbox', 'nav.inbox', IconInbox],
      ['schedule', 'nav.schedule', IconClock],
      ['contacts', 'nav.contacts', IconUsers],
      ['templates', 'nav.templates', IconFileText],
      ['logs', 'nav.logs', IconActivity],
      ['settings', 'nav.settings', IconSettings],
    ]

    const out: PaletteAction[] = NAV.map(([target, key, icon]) => ({
      id: `go:${target}`,
      label: t(key),
      hint: t('palette.goTo'),
      icon,
      run: () => onNavigate(target),
    }))

    // Contacts and templates are the two things worth acting on directly:
    // picking a contact starts a message to them, picking a template starts
    // one from it. Reminders and log entries are navigations, and live on
    // their own screens.
    for (const contact of state.contacts) {
      out.push({
        id: `contact:${contact.id}`,
        label: contact.name || contact.address,
        hint: contact.address,
        icon: IconUsers,
        run: () => onCompose({ to: [contact.address] }),
      })
    }
    for (const template of state.templates) {
      out.push({
        id: `template:${template.id}`,
        label: template.name || template.subject,
        hint: template.subject,
        icon: IconFileText,
        run: () => onCompose({ subject: template.subject, body: template.body }),
      })
    }
    for (const job of state.jobs) {
      out.push({
        id: `job:${job.id}`,
        label: job.name,
        hint: t('nav.schedule'),
        icon: IconClock,
        run: () => onNavigate('schedule'),
      })
    }
    // Received mail — searching by sender or subject is the single most
    // common thing a search box does in a mail client, and until now this one
    // could not: only the four kinds of saved object above were indexed.
    // Label is the subject so a prefix match ("周会") ranks it correctly;
    // `from` rides in `hint`, which `results` below scores too (see `score`'s
    // 0.6 weighting), so "找xiaowang发的信" works from the sender alone.
    for (const account of state.inboxAccounts) {
      for (const message of account.messages) {
        out.push({
          id: `msg:${message.id}`,
          label: message.subject || t('inbox.noSubject'),
          hint: message.from,
          icon: IconInbox,
          run: () => onOpenMessage(message.id),
        })
      }
    }
    return out
  }, [
    open,
    state.contacts,
    state.templates,
    state.jobs,
    state.inboxAccounts,
    t,
    onNavigate,
    onCompose,
    onOpenMessage,
  ])

  const results = useMemo<Ranked[]>(() => {
    if (!open) return NO_RESULTS
    const trimmed = query.trim()
    return actions
      .map((action) => ({
        ...action,
        score: Math.max(score(action.label, trimmed), score(action.hint ?? '', trimmed) * 0.6),
      }))
      .filter((action) => action.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
  }, [open, actions, query])

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const choose = (index: number) => {
    const action = results[index]
    if (!action) return
    onClose()
    action.run()
  }

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('palette.title')}>
        <div className="palette__search">
          <IconSearch size={17} />
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            placeholder={t('palette.placeholder')}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(cursor)
              }
            }}
          />
        </div>

        <div className="palette__list" ref={listRef}>
          {results.length === 0 ? (
            <div className="nores nores--inlist">{t('palette.nothing')}</div>
          ) : (
            results.map((action, index) => {
              const Icon = action.icon
              return (
                <button
                  key={action.id}
                  type="button"
                  className="palette__item"
                  data-active={index === cursor ? 'true' : undefined}
                  // Pointer moves set the cursor so the keyboard and the mouse
                  // never disagree about which row is about to run.
                  onMouseMove={() => setCursor(index)}
                  onClick={() => choose(index)}
                >
                  <Icon size={16} className="palette__icon" />
                  <span className="palette__label">{action.label}</span>
                  {action.hint ? <span className="palette__hint">{action.hint}</span> : null}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
