/**
 * The primary navigation, in one place.
 *
 * It lives here rather than in `App.tsx` because two things need it and they
 * had drifted apart: the sidebar renders it, and the keyboard layer numbers it
 * (`Ctrl+1` … `Ctrl+9`). The shortcut *behaviour* already read `NAV[index]`, so
 * it followed any change automatically — but the help panel listing those
 * shortcuts spelled its labels out by hand, and adding the calendar tab in the
 * middle of the list silently made two of them wrong: `Ctrl+7` opened the
 * calendar while the panel said "Activity", and Settings lost its shortcut
 * entirely because the matcher only accepted digits 1–8.
 *
 * Nothing about that could fail loudly. The keys worked, the panel rendered,
 * and only someone who tried one and read the other would notice. So the list
 * is now the single source both read from, and `check-shortcuts.mjs` asserts
 * they cannot disagree again.
 */

import type { TranslationKey } from '../i18n'

export type ViewId =
  | 'compose'
  | 'codes'
  | 'inbox'
  | 'schedule'
  | 'contacts'
  | 'templates'
  | 'workcal'
  | 'logs'
  | 'settings'

export interface NavItem {
  id: ViewId
  labelKey: TranslationKey
  /** Icon name, resolved by the view layer — this module stays free of JSX. */
  icon:
    | 'mail'
    | 'key'
    | 'inbox'
    | 'clock'
    | 'users'
    | 'file'
    | 'calendar'
    | 'activity'
    | 'settings'
}

export const NAV: NavItem[] = [
  { id: 'compose', labelKey: 'nav.compose', icon: 'mail' },
  // Second, directly under Compose: this is the screen people open the app
  // *for* on the days they open it in a hurry, and a code six rows down is a
  // code they had to go looking for.
  { id: 'codes', labelKey: 'nav.codes', icon: 'key' },
  { id: 'inbox', labelKey: 'nav.inbox', icon: 'inbox' },
  { id: 'schedule', labelKey: 'nav.schedule', icon: 'clock' },
  { id: 'contacts', labelKey: 'nav.contacts', icon: 'users' },
  { id: 'templates', labelKey: 'nav.templates', icon: 'file' },
  // Next to Schedule rather than buried in Settings: it decides which days a
  // reminder may land on, which makes it part of scheduling, not a preference.
  { id: 'workcal', labelKey: 'nav.workcal', icon: 'calendar' },
  { id: 'logs', labelKey: 'nav.logs', icon: 'activity' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings' },
]

/**
 * How many tabs can be reached by number.
 *
 * Nine, because `Ctrl+0` is the browser's zoom reset and taking it would be
 * both surprising and unwinnable. A tenth tab would need a different scheme
 * rather than a tenth digit — which is worth knowing before adding one.
 */
export const MAX_NAV_SHORTCUT = 9
