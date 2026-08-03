/**
 * The keyboard layer.
 *
 * Three rules this follows, and one it deliberately breaks:
 *
 * - **Never steal a key a text field needs.** Ctrl+Z inside a textarea is the
 *   browser's own undo of your typing, and hijacking it to un-delete a
 *   reminder would be the single most destructive shortcut in the app. So the
 *   editing keys stand down whenever focus is in a field; only the ones that
 *   cannot mean anything else (Ctrl+Enter, Ctrl+K) act from inside one.
 * - **One list, and it is on screen.** A shortcut nobody can find is a
 *   shortcut nobody uses, so `?` opens the same table this file is defined
 *   from — it cannot drift out of date because there is nothing to drift from.
 * - **No single-letter global keys.** They are unusable in an application that
 *   is mostly text entry.
 *
 * The rule it breaks: Ctrl+K is registered in the *capture* phase, precisely
 * so a focused input cannot swallow it. Not having to leave what you are doing
 * is the entire point of a command palette.
 */

import { Modal, StatusChip } from './ui'
import { useI18n, type TranslationKey } from '../i18n'
import { MAX_NAV_SHORTCUT, NAV } from '../core/nav'

export type ShortcutAction =
  | 'palette'
  | 'send'
  | 'schedule'
  | 'preview'
  | 'undo'
  | 'history'
  | 'help'
  | 'focus'
  | 'search'
  | `nav${number}`

export interface ShortcutSpec {
  action: ShortcutAction
  /** How it reads on screen. `Ctrl` is swapped for `⌘` on a Mac at render time. */
  keys: string
  labelKey: TranslationKey
  /** Whether it still fires while a text field has focus. */
  worksInFields: boolean
  /** Grouping in the help panel. */
  group: 'general' | 'compose' | 'navigate'
}

/**
 * The navigation shortcuts, generated from the tab list itself.
 *
 * These used to be nine hand-written lines, and they went wrong the moment a
 * tab was inserted in the middle: the *matcher* reads `NAV[index]` and followed
 * the change, while this table kept the old labels. `Ctrl+7` opened the working
 * calendar while the help panel said it opened Activity, and Settings lost its
 * shortcut entirely because the matcher only accepted digits 1-8.
 *
 * Nothing about that could fail loudly — the keys worked and the panel
 * rendered. Generating them removes the class of bug rather than the instance.
 */
const NAV_SHORTCUTS: ShortcutSpec[] = NAV.slice(0, MAX_NAV_SHORTCUT).map((item, i) => ({
  action: `nav${i + 1}` as ShortcutAction,
  keys: `Ctrl+${i + 1}`,
  labelKey: item.labelKey,
  worksInFields: true,
  group: 'navigate',
}))

export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'palette', keys: 'Ctrl+K', labelKey: 'palette.open', worksInFields: true, group: 'general' },
  { action: 'undo', keys: 'Ctrl+Z', labelKey: 'undo.action', worksInFields: false, group: 'general' },
  { action: 'help', keys: '?', labelKey: 'shortcuts.title', worksInFields: false, group: 'general' },
  { action: 'send', keys: 'Ctrl+Enter', labelKey: 'compose.sendNow', worksInFields: true, group: 'compose' },
  { action: 'schedule', keys: 'Ctrl+Shift+Enter', labelKey: 'compose.schedule', worksInFields: true, group: 'compose' },
  { action: 'preview', keys: 'Ctrl+Shift+P', labelKey: 'preflight.button', worksInFields: true, group: 'compose' },
  { action: 'history', keys: 'Ctrl+Shift+H', labelKey: 'history.title', worksInFields: true, group: 'compose' },
  { action: 'focus', keys: 'F9', labelKey: 'compose.focusEnter', worksInFields: true, group: 'compose' },
  ...NAV_SHORTCUTS,
]

/**
 * Pairs of shortcuts that would both fire on the same keystroke.
 *
 * Normalised on the key combination so `Ctrl+Shift+P` and `Shift+Ctrl+P` are
 * recognised as the same chord rather than as two different ones — which is
 * how a duplicate would most plausibly be written by hand.
 *
 * A pair is only a conflict when both are live in the same context: one entry
 * that stands down inside a text field and another that only acts inside one
 * can share a chord deliberately. `worksInFields` is what separates them.
 */
export function findConflicts(
  specs: ShortcutSpec[] = SHORTCUTS,
): Array<[ShortcutSpec, ShortcutSpec]> {
  const chord = (k: string) =>
    k
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .sort()
      .join('+')
  const out: Array<[ShortcutSpec, ShortcutSpec]> = []
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      const a = specs[i]
      const b = specs[j]
      if (chord(a.keys) !== chord(b.keys)) continue
      if (a.worksInFields === b.worksInFields) out.push([a, b])
    }
  }
  return out
}


const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function renderKeys(keys: string): string {
  return isMac ? keys.replace('Ctrl', '⌘').replace('Shift', '⇧') : keys
}

/** Is the keystroke aimed at a text field rather than at the application? */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** Which action this keystroke means, or null. Pure, so it can be reasoned about. */
export function matchShortcut(event: KeyboardEvent): ShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey
  const key = event.key
  const inField = inTextField(event.target)

  if (mod && !event.shiftKey && key.toLowerCase() === 'k') return 'palette'
  if (mod && key === 'Enter') return event.shiftKey ? 'schedule' : 'send'
  if (mod && event.shiftKey && key.toLowerCase() === 'p') return 'preview'
  if (mod && event.shiftKey && key.toLowerCase() === 'h') return 'history'
  // Ctrl+Z stands down inside a field: there it is the browser's undo of the
  // user's own typing, and that is what they mean by it.
  if (mod && !event.shiftKey && key.toLowerCase() === 'z' && !inField) return 'undo'
  if (key === '?' && !inField && !mod) return 'help'
  if (key === 'F9') return 'focus'
  // 1..MAX_NAV_SHORTCUT rather than a literal `[1-8]`, which quietly left the
  // ninth tab with no shortcut at all when one was added in the middle.
  if (mod && !event.shiftKey && key >= '1' && key <= String(MAX_NAV_SHORTCUT)) {
    return `nav${key}` as ShortcutAction
  }
  return null
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Modal open={open} title={t('shortcuts.title')} onClose={onClose} closeLabel={t('common.close')}>
      <div className="shortcuts">
        {(['general', 'compose', 'navigate'] as const).map((group) => (
          <div key={group} className="shortcuts__group">
            <div className="shortcuts__grouphead">
              {t(`shortcuts.group.${group}` as TranslationKey)}
            </div>
            {SHORTCUTS.filter((item) => item.group === group).map((item) => (
              <div key={item.action} className="shortcuts__row">
                <kbd className="shortcuts__keys">{renderKeys(item.keys)}</kbd>
                <span className="shortcuts__label">{t(item.labelKey)}</span>
                {!item.worksInFields ? (
                  <StatusChip tone="neutral" label={t('shortcuts.notInFields')} />
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
