import { createContext, useContext } from 'react'
import type { LocaleId } from '../core/types'
import { en, type TranslationKey, type Translations } from './en'
import { zhCN } from './zh-CN'
import { fr } from './fr'
import { es } from './es'
import { ru } from './ru'
import { ar } from './ar'

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

const TABLES: Record<LocaleId, Translations> = {
  en,
  'zh-CN': zhCN,
  fr,
  es,
  ru,
  ar,
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
 * French should see one English word, not `schedule.jitterHint`.
 */
export function translate(
  locale: LocaleId,
  key: TranslationKey,
  values?: Interpolations,
): string {
  const table = TABLES[locale] ?? en
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
