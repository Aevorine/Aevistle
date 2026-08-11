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
    new Intl.DateTimeFormat(meta.intlTag, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...opts,
    }).format(new Date(ms))

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
    return `${new Intl.NumberFormat(meta.intlTag, {
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
