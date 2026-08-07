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
  /**
   * The hub. Deliberately absent from `NAV`: it is not a tenth screen
   * competing for a numbered tab and a `Ctrl+N` shortcut with the nine that
   * already share those out completely (`check-shortcuts.mjs` asserts `NAV`
   * and the shortcut table stay the same length), it is a container — for the
   * five screens in `HOME_SECTIONS` that do not fit across the bottom of a
   * phone, and, on every platform, for the four `HOME_FEATURES` tiles that
   * otherwise live only inside Settings. `MOBILE_NAV` gives it an unnumbered
   * slot on a phone's tab bar; `App.tsx`'s sidebar footer gives it an
   * unnumbered button on a desktop, for the same reason neither wants to
   * spend one of the nine numbered slots on a screen that is a doorway rather
   * than a destination in its own right.
   */
  | 'home'

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
    | 'home'
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

/**
 * The five screens that move behind Home on a phone.
 *
 * Nine tabs do not fit across a 360px screen. They never did: the bottom bar
 * had been a horizontal scroller since the calendar tab was added, which meant
 * four of the nine were off-screen at any moment and the only clue was that the
 * strip moved when you dragged it. A tab you have to *discover by scrolling a
 * tab bar* is a tab most people never find.
 *
 * Which five: the ones you visit deliberately, when you have decided to do
 * something, rather than the ones you check. Compose, verification codes, the
 * inbox and Settings stay on the bar because they are the reflex actions —
 * codes especially, which is the screen people open the app *for* on the days
 * they open it in a hurry, and which is why it sits second in `NAV` too.
 * Schedules, contacts, templates, the calendar and the log are all "I am going
 * to go and organise something", and one extra tap to reach them costs nothing
 * against four of them being invisible.
 *
 * Order matches `NAV` so the two never disagree about where things sit.
 */
export const HOME_SECTIONS: ViewId[] = [
  'schedule',
  'contacts',
  'templates',
  'workcal',
  'logs',
]

/**
 * Four Settings sections promoted onto Home as well as staying reachable from
 * Settings itself — see `views/HomeView.tsx`'s module doc for the fuller story
 * of why, and the comment on `DigestCard` in `views/SettingsView.tsx` for why
 * two of the four are exported from that file rather than moved into ones of
 * their own under `views/`.
 *
 * Not `ViewId`s, deliberately. Every `ViewId` is a screen some nav list can
 * point a tab at — `NAV` or `MOBILE_NAV` — and none of these four is: nothing
 * anywhere ever puts 'digest' or 'pairing' on a tab bar, so folding them into
 * that type would hand every exhaustive `switch` over a `ViewId` a case that
 * can never be reached from a click on either bar. They only ever open as a
 * Home tile, on a phone and a desktop alike, so they get a narrower id of
 * their own instead.
 */
export type HomeFeatureId = 'digest' | 'greetings' | 'calendarsub' | 'pairing' | 'selfcheck'

export interface HomeFeatureItem {
  id: HomeFeatureId
  labelKey: TranslationKey
}

/**
 * Each tile borrows the label its Settings section already carries —
 * `settings.digest`, `settings.greetings`, `cal.subscribe.toggle`,
 * `devices.title` — rather than a Home-specific label minted to match it. A
 * second string that exists only to keep saying the same thing as the first
 * is a second place for the two to quietly disagree after the next edit;
 * reusing the key means the dialog a tile opens is named identically, in
 * whichever of the six languages the user reads, to the Settings row that
 * opens the same content — by construction, not by two translators agreeing.
 */
export const HOME_FEATURES: HomeFeatureItem[] = [
  { id: 'digest', labelKey: 'settings.digest' },
  { id: 'greetings', labelKey: 'settings.greetings' },
  { id: 'calendarsub', labelKey: 'cal.subscribe.toggle' },
  { id: 'pairing', labelKey: 'devices.title' },
  /*
   * Last, and on Home rather than buried in Settings.
   *
   * Someone reaching for this has already decided the app is broken, and the
   * screens they would otherwise be hunting through are the ones they have
   * just failed to get an answer out of. It is the only tile here that carries
   * its own label rather than borrowing a Settings section's, because it has
   * no Settings section to borrow from — it is not a feature with settings,
   * it is a question with an answer.
   */
  { id: 'selfcheck', labelKey: 'selfcheck.title' },
]

/**
 * The bottom bar on a phone: four reflexes and the door to everything else.
 *
 * Five items at ~64px each fit a 360px screen without scrolling, which is the
 * entire point — see `HOME_SECTIONS`. Not derived from `NAV` by filtering,
 * because Home is not in `NAV` and the order here is a separate decision:
 * Home sits in the middle, under the thumb, because it is the one that leads
 * somewhere rather than doing something.
 */
export const MOBILE_NAV: NavItem[] = [
  { id: 'compose', labelKey: 'nav.compose', icon: 'mail' },
  { id: 'codes', labelKey: 'nav.codes', icon: 'key' },
  { id: 'home', labelKey: 'nav.home', icon: 'home' },
  { id: 'inbox', labelKey: 'nav.inbox', icon: 'inbox' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings' },
]
