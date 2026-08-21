import { createContext, useContext, useEffect, useState } from 'react'
import type { LocaleId } from '../core/types'
import { en, type TranslationKey, type Translations } from './en'

export type { TranslationKey, Translations }

export interface LocaleMeta {
  id: LocaleId
  /** The language's own name — never translate this one. */
  nativeName: string
  englishName: string
  dir: 'ltr' | 'rtl'
  /** BCP-47 tag for Intl date and number formatting. */
  intlTag: string
}

export const LOCALES: LocaleMeta[] = [
  { id: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr', intlTag: 'en' },
  { id: 'zh-CN', nativeName: '简体中文', englishName: 'Simplified Chinese', dir: 'ltr', intlTag: 'zh-CN' },
  { id: 'fr', nativeName: 'Français', englishName: 'French', dir: 'ltr', intlTag: 'fr' },
  { id: 'es', nativeName: 'Español', englishName: 'Spanish', dir: 'ltr', intlTag: 'es' },
  { id: 'ru', nativeName: 'Русский', englishName: 'Russian', dir: 'ltr', intlTag: 'ru' },
  { id: 'ar', nativeName: 'العربية', englishName: 'Arabic', dir: 'rtl', intlTag: 'ar' },
]

/**
 * Every locale but English, loaded on demand.
 *
 * `src/i18n/index.ts` used to import all six tables statically, so every
 * session paid for five languages nobody in it was reading — the built
 * `i18n-*.js` chunk was bigger than the rest of the app combined. Only one
 * locale is ever active at a time, so only one needs to be in memory: English
 * ships in the main bundle as the synchronous fallback (see `loaded` below),
 * and each other table is its own chunk, fetched the first time that locale
 * is actually selected.
 */
const LOADERS: Partial<Record<LocaleId, () => Promise<Translations>>> = {
  'zh-CN': () => import('./zh-CN').then((m) => m.zhCN),
  fr: () => import('./fr').then((m) => m.fr),
  es: () => import('./es').then((m) => m.es),
  ru: () => import('./ru').then((m) => m.ru),
  ar: () => import('./ar').then((m) => m.ar),
}

/** Tables resolved so far. English needs no fetch, so it starts seeded. */
const loaded: Partial<Record<LocaleId, Translations>> = { en }

/** In-flight loads, so flipping the language back and forth never fetches twice. */
const pending = new Map<LocaleId, Promise<Translations>>()

type Listener = () => void
const listeners = new Set<Listener>()

/**
 * Start fetching `locale`'s table if nothing already has. Fire-and-forget:
 * `translate` below needs to return a string synchronously, so callers read
 * `loaded` for the result rather than awaiting this.
 */
function ensureLocaleLoading(locale: LocaleId): void {
  if (loaded[locale] || pending.has(locale)) return
  const load = LOADERS[locale]
  if (!load) return // English, or an id this build does not know
  const promise = load()
    .then((table) => {
      loaded[locale] = table
      pending.delete(locale)
      for (const listener of listeners) listener()
      return table
    })
    .catch(() => {
      // Left unresolved on purpose: `translate` keeps returning the English
      // fallback for this locale, and the next call to `ensureLocaleLoading`
      // (e.g. the user reopening Settings) tries the fetch again rather than
      // being permanently stuck on a table that failed once.
      pending.delete(locale)
      return en
    })
  pending.set(locale, promise)
}

/**
 * True once `locale`'s real table is in memory. English is always true.
 *
 * Exposed for `useLocaleReady` below; there is no reason for a screen to poll
 * this directly rather than subscribing.
 */
function isLocaleLoaded(locale: LocaleId): boolean {
  return locale in loaded
}

/**
 * Re-renders the calling component once `locale`'s table finishes loading,
 * and kicks off that load if nothing has yet.
 *
 * Every `t()` call already reads whatever is in `loaded` right now — English
 * until the real table lands — so nothing downstream needs to change. What
 * was missing without this hook is a reason for React to render *again*
 * after the fetch resolves; without it the very first paint's English
 * fallback would simply stick, since no state anywhere had changed.
 */
export function useLocaleReady(locale: LocaleId): boolean {
  const [, forceRender] = useState(0)
  useEffect(() => {
    if (isLocaleLoaded(locale)) return
    ensureLocaleLoading(locale)
    const listener = () => forceRender((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [locale])
  return isLocaleLoaded(locale)
}

export function localeMeta(id: LocaleId): LocaleMeta {
  return LOCALES.find((l) => l.id === id) ?? LOCALES[0]
}

/** Pick the closest supported locale for the browser/OS language. */
export function detectLocale(): LocaleId {
  if (typeof navigator === 'undefined') return 'en'
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const lower = candidate.toLowerCase()
    if (lower.startsWith('zh')) return 'zh-CN'
    const exact = LOCALES.find((l) => lower === l.id.toLowerCase())
    if (exact) return exact.id
    const base = lower.split('-')[0]
    const partial = LOCALES.find((l) => l.id.split('-')[0] === base)
    if (partial) return partial.id
  }
  return 'en'
}

export type Interpolations = Record<string, string | number>

/**
 * Look up a key and substitute `{placeholders}`.
 *
 * Falls back to English rather than showing a raw key: a user who picked
 * French should see one English word, not `schedule.jitterHint`. Also the
 * fallback while `locale`'s own chunk is still in flight — see
 * `useLocaleReady`, which is what turns this back into the right language
 * once it lands. Kicking off the load here too (not just from the hook)
 * means a caller of `translate` directly, outside of React, still gets the
 * table eventually rather than being stuck in English forever.
 */
export function translate(
  locale: LocaleId,
  key: TranslationKey,
  values?: Interpolations,
): string {
  ensureLocaleLoading(locale)
  const table = loaded[locale] ?? en
  const template = table[key] ?? en[key] ?? key
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  )
}

/**
 * Built formatters, keyed by locale + the exact option set they were built
 * with.
 *
 * `new Intl.DateTimeFormat(...)` is one of the most expensive constructors a
 * JS engine has — it resolves the locale, loads the calendar and number data
 * for it and compiles a pattern — and `formatDateTime` used to run one per
 * call. Several call sites are inside `.map()` bodies, so that was one full
 * construction *per rendered list row*, thrown away immediately afterwards.
 * The app only ever asks for a handful of distinct shapes (a medium date, a
 * full date, a weekday…) in one locale at a time, so the whole working set is
 * a few dozen objects that can simply be kept.
 *
 * Module scope, not inside `createI18n`: the context value is rebuilt whenever
 * the language changes, and a cache that died with it would be no cache at all.
 * The key space is bounded by the code (option sets appearing in call sites x
 * six locales), not by anything a user can type, so this cannot grow without
 * limit.
 */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()

/**
 * A cache key covering every input that can change the output: the locale tag
 * and every option field, including `timeZone`.
 *
 * Two details this has to get right, because a key that collides silently
 * returns the wrong time — far worse than being slow:
 *
 * - Keys are sorted, so `{hour, timeZone}` and `{timeZone, hour}` — the same
 *   request written two ways — share one formatter instead of two.
 * - An explicitly `undefined` field is skipped, because that is exactly how
 *   `Intl` reads it: `{dateStyle: 'full', timeStyle: undefined}` builds the
 *   same formatter as `{dateStyle: 'full'}`, so both must key the same. This
 *   is not hypothetical — `formatDateTime(ms, {dateStyle: 'full', timeStyle:
 *   undefined})` is written that way in several views to cancel the default
 *   time part.
 */
function formatterKey(locale: string, opts: Record<string, unknown>): string {
  let key = locale
  for (const name of Object.keys(opts).sort()) {
    const value = opts[name]
    if (value === undefined) continue
    key += ` ${name}${String(value)}`
  }
  return key
}

/**
 * The individual date-time components, as ECMA-402 names them.
 *
 * `Intl` treats these and `dateStyle`/`timeStyle` as two mutually exclusive
 * ways of asking for the same thing, and combining them is not a fallback or a
 * rounding — it is a `TypeError` thrown out of the `Intl.DateTimeFormat`
 * constructor, in every locale, on every engine.
 */
const COMPONENT_FIELDS = [
  'weekday',
  'era',
  'year',
  'month',
  'day',
  'dayPeriod',
  'hour',
  'minute',
  'second',
  'fractionalSecondDigits',
  'timeZoneName',
] as const

/**
 * The options `formatDateTime` may actually hand to `Intl`, defaults included.
 *
 * ## The bug this exists to make unrepresentable
 *
 * `formatDateTime` spread the caller's options over `{dateStyle: 'medium',
 * timeStyle: 'short'}`. That is correct for every caller that asks for a
 * *style* and wrong for every caller that asks for a *component*: the merge
 * silently produced `{dateStyle, timeStyle, weekday}`, which `Intl` refuses
 * with `TypeError: Invalid option : option`.
 *
 * It threw inside a React render. `InboxView`'s day separators call
 * `formatDateTime(at, {weekday: 'long'})` for any message between two and six
 * days old (`dayGroups.ts`'s `weekday` label), so one such message anywhere in
 * the mailbox threw during the list's render, `ErrorBoundary` caught it, and
 * the *entire inbox screen* went blank — desktop, phone and tablet alike,
 * because this is shared renderer code. Landed in 0.3.29 and survived three
 * releases, because every fixture in this repository seeds messages minutes
 * apart and therefore never reaches the branch. A real mailbox reaches it
 * within a week of being opened.
 *
 * ## The rule now
 *
 * A caller that names any component gets *only* what it named. The styles are
 * not merged in underneath, and a style the caller passed alongside a
 * component is dropped rather than forwarded into the constructor that would
 * reject it — the component is the more specific request, and a formatter that
 * throws is not an alternative worth preserving. Callers wanting a style pass
 * no components and are untouched, which is all of them but one.
 */
function withoutStyleConflict(opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  if (opts && COMPONENT_FIELDS.some((field) => opts[field] !== undefined)) {
    const { dateStyle: _dateStyle, timeStyle: _timeStyle, ...rest } = opts
    return rest
  }
  return { dateStyle: 'medium', timeStyle: 'short', ...opts }
}

function dateTimeFormatter(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = formatterKey(locale, opts as Record<string, unknown>)
  let formatter = dateTimeFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, opts)
    dateTimeFormatters.set(key, formatter)
  }
  return formatter
}

function numberFormatter(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = formatterKey(locale, opts as Record<string, unknown>)
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, opts)
    numberFormatters.set(key, formatter)
  }
  return formatter
}

export interface I18n {
  locale: LocaleId
  dir: 'ltr' | 'rtl'
  t: (key: TranslationKey, values?: Interpolations) => string
  /** Formats a timestamp in the active locale. */
  formatDateTime: (ms: number, opts?: Intl.DateTimeFormatOptions) => string
  /**
   * How far away a *future* moment is — "in 5 min", or "overdue" once it has
   * passed. This is the scheduling vocabulary and it is right for a reminder
   * that has not fired yet.
   */
  formatRelative: (ms: number, now?: number) => string
  /**
   * How long ago a *past* moment was — "5 min ago".
   *
   * Separate from `formatRelative` rather than a flag on it, because the two
   * disagree about what a negative difference means. Received mail was being
   * timestamped with `formatRelative`, so every message in the inbox and every
   * verification code was labelled "overdue": true of a missed reminder,
   * nonsense for a mail that arrived four minutes ago.
   */
  formatAgo: (ms: number, now?: number) => string
  formatBytes: (bytes: number) => string
}

export function createI18n(locale: LocaleId): I18n {
  const meta = localeMeta(locale)
  const t = (key: TranslationKey, values?: Interpolations) => translate(locale, key, values)

  const formatDateTime = (ms: number, opts?: Intl.DateTimeFormatOptions) =>
    dateTimeFormatter(meta.intlTag, withoutStyleConflict(opts)).format(new Date(ms))

  const formatRelative = (ms: number, now = Date.now()) => {
    const diff = ms - now
    const abs = Math.abs(diff)
    if (diff < 0) return t('time.overdue')
    if (abs < 60_000) return t('time.now')
    if (abs < 3_600_000) return t('time.inMinutes', { n: Math.round(abs / 60_000) })
    if (abs < 86_400_000) return t('time.inHours', { n: Math.round(abs / 3_600_000) })
    return t('time.inDays', { n: Math.round(abs / 86_400_000) })
  }

  const formatAgo = (ms: number, now = Date.now()) => {
    const abs = Math.max(0, now - ms)
    if (abs < 60_000) return t('time.agoNow')
    if (abs < 3_600_000) return t('time.agoMinutes', { n: Math.round(abs / 60_000) })
    if (abs < 86_400_000) return t('time.agoHours', { n: Math.round(abs / 3_600_000) })
    return t('time.agoDays', { n: Math.round(abs / 86_400_000) })
  }

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }
    const digits = value < 10 ? 1 : 0
    return `${numberFormatter(meta.intlTag, {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(value)} ${units[unit]}`
  }

  return { locale, dir: meta.dir, t, formatDateTime, formatRelative, formatAgo, formatBytes }
}

export const I18nContext = createContext<I18n>(createI18n('en'))

export function useI18n(): I18n {
  return useContext(I18nContext)
}
