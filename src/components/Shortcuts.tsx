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

export type ShortcutAction =
  | 'palette'
  | 'send'
  | 'schedule'
  | 'preview'
  | 'undo'
  | 'history'
  | 'help'
  | 'nav1'
  | 'nav2'
  | 'nav3'
  | 'nav4'
  | 'nav5'
  | 'nav6'
  | 'nav7'
  | 'nav8'

export interface ShortcutSpec {
  action: ShortcutAction
  /** How it reads on screen. `Ctrl` is swapped for `⌘` on a Mac at render time. */
  keys: string
  labelKey: TranslationKey
  /** Whether it still fires while a text field has focus. */
  worksInFields: boolean
}

export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'palette', keys: 'Ctrl+K', labelKey: 'palette.open', worksInFields: true },
  { action: 'send', keys: 'Ctrl+Enter', labelKey: 'compose.sendNow', worksInFields: true },
  { action: 'schedule', keys: 'Ctrl+Shift+Enter', labelKey: 'compose.schedule', worksInFields: true },
  { action: 'preview', keys: 'Ctrl+Shift+P', labelKey: 'preflight.button', worksInFields: true },
  { action: 'history', keys: 'Ctrl+Shift+H', labelKey: 'history.title', worksInFields: true },
  { action: 'undo', keys: 'Ctrl+Z', labelKey: 'undo.action', worksInFields: false },
  { action: 'help', keys: '?', labelKey: 'shortcuts.title', worksInFields: false },
  { action: 'nav1', keys: 'Ctrl+1', labelKey: 'nav.compose', worksInFields: true },
  { action: 'nav2', keys: 'Ctrl+2', labelKey: 'nav.codes', worksInFields: true },
  { action: 'nav3', keys: 'Ctrl+3', labelKey: 'nav.inbox', worksInFields: true },
  { action: 'nav4', keys: 'Ctrl+4', labelKey: 'nav.schedule', worksInFields: true },
  { action: 'nav5', keys: 'Ctrl+5', labelKey: 'nav.contacts', worksInFields: true },
  { action: 'nav6', keys: 'Ctrl+6', labelKey: 'nav.templates', worksInFields: true },
  { action: 'nav7', keys: 'Ctrl+7', labelKey: 'nav.logs', worksInFields: true },
  { action: 'nav8', keys: 'Ctrl+8', labelKey: 'nav.settings', worksInFields: true },
]

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
  if (mod && !event.shiftKey && /^[1-8]$/.test(key)) return `nav${key}` as ShortcutAction
  return null
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Modal open={open} title={t('shortcuts.title')} onClose={onClose} closeLabel={t('common.close')}>
      <div className="shortcuts">
        {SHORTCUTS.map((s) => (
          <div key={s.action} className="shortcuts__row">
            <kbd className="shortcuts__keys">{renderKeys(s.keys)}</kbd>
            <span className="shortcuts__label">{t(s.labelKey)}</span>
            {!s.worksInFields ? (
              <StatusChip tone="neutral" label={t('shortcuts.notInFields')} />
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  )
}
