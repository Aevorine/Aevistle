/**
 * SMTP provider presets.
 *
 * The point of this table is that a non-technical user never has to know what
 * "STARTTLS on 587" means. They pick their mail provider, we fill in the rest,
 * and `hint` tells them the one thing that actually trips people up: most
 * providers refuse your normal login password and want an app-specific one.
 */

import type { TransportSecurity } from './types'

export interface ProviderPreset {
  id: string
  name: string
  /** Matched against the part after '@' to auto-select a preset. */
  domains: string[]
  host: string
  port: number
  security: TransportSecurity
  /** i18n key describing how to obtain an app password. */
  hintKey: string
  /** Where the user goes to create an app password. */
  appPasswordUrl?: string
  /** Provider-enforced attachment ceiling, MB. */
  attachmentLimitMb: number
  /** Rough sends-per-day allowance, for the UI to warn about bulk jobs. */
  dailyLimit?: number
  /** IMAP endpoint, when the provider publishes a well-known one. Same app password/auth-code as SMTP on every provider below. */
  imapHost?: string
  imapPort?: number
  imapSecurity?: TransportSecurity
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    host: 'smtp.gmail.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    attachmentLimitMb: 25,
    dailyLimit: 500,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    host: 'smtp-mail.outlook.com',
    port: 587,
    security: 'starttls',
    hintKey: 'provider.hint.appPassword',
    appPasswordUrl: 'https://account.live.com/proofs/AppPassword',
    attachmentLimitMb: 20,
    dailyLimit: 300,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'office365',
    name: 'Microsoft 365 (work)',
    domains: [],
    host: 'smtp.office365.com',
    port: 587,
    security: 'starttls',
    hintKey: 'provider.hint.orgAdmin',
    attachmentLimitMb: 25,
    dailyLimit: 10000,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'qq',
    name: 'QQ 邮箱',
    domains: ['qq.com', 'vip.qq.com', 'foxmail.com'],
    host: 'smtp.qq.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    appPasswordUrl: 'https://service.mail.qq.com/detail/0/75',
    attachmentLimitMb: 50,
    dailyLimit: 500,
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'netease163',
    name: '网易 163',
    domains: ['163.com'],
    host: 'smtp.163.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    appPasswordUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b',
    attachmentLimitMb: 50,
    dailyLimit: 200,
    imapHost: 'imap.163.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'netease126',
    name: '网易 126',
    domains: ['126.com'],
    host: 'smtp.126.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    attachmentLimitMb: 50,
    dailyLimit: 200,
    imapHost: 'imap.126.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'sina',
    name: '新浪邮箱',
    domains: ['sina.com', 'sina.cn'],
    host: 'smtp.sina.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    attachmentLimitMb: 50,
    imapHost: 'imap.sina.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'aliyun',
    name: '阿里云邮箱',
    domains: ['aliyun.com'],
    host: 'smtp.aliyun.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.password',
    attachmentLimitMb: 25,
    imapHost: 'imap.aliyun.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.co.uk', 'ymail.com'],
    host: 'smtp.mail.yahoo.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    attachmentLimitMb: 25,
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    host: 'smtp.mail.me.com',
    port: 587,
    security: 'starttls',
    hintKey: 'provider.hint.appPassword',
    appPasswordUrl: 'https://appleid.apple.com/account/manage',
    attachmentLimitMb: 20,
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    host: 'smtp.zoho.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    attachmentLimitMb: 20,
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'yandex',
    name: 'Yandex Mail',
    domains: ['yandex.com', 'yandex.ru'],
    host: 'smtp.yandex.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    attachmentLimitMb: 30,
    imapHost: 'imap.yandex.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    host: 'smtp.fastmail.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    attachmentLimitMb: 70,
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'gmx',
    name: 'GMX',
    domains: ['gmx.com', 'gmx.net', 'gmx.de'],
    host: 'mail.gmx.com',
    port: 587,
    security: 'starttls',
    hintKey: 'provider.hint.password',
    attachmentLimitMb: 50,
    imapHost: 'imap.gmx.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'mailru',
    name: 'Mail.ru',
    domains: ['mail.ru', 'bk.ru', 'inbox.ru', 'list.ru'],
    host: 'smtp.mail.ru',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    attachmentLimitMb: 25,
    imapHost: 'imap.mail.ru',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'custom',
    name: 'Custom SMTP server',
    domains: [],
    host: '',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.custom',
    attachmentLimitMb: 25,
  },
]

export function providerById(id: string | undefined): ProviderPreset | undefined {
  if (!id) return undefined
  return PROVIDERS.find((p) => p.id === id)
}

/** Guess a preset from an email address, e.g. `a@qq.com` → the QQ preset. */
export function providerForAddress(address: string): ProviderPreset | undefined {
  const at = address.lastIndexOf('@')
  if (at < 0) return undefined
  const domain = address.slice(at + 1).trim().toLowerCase()
  if (!domain) return undefined
  return PROVIDERS.find((p) => p.domains.includes(domain))
}

/** The attachment ceiling to enforce for an account, in bytes. */
export function attachmentLimitBytes(providerId: string | undefined, fallbackMb: number): number {
  const preset = providerById(providerId)
  const mb = preset && preset.id !== 'custom' ? preset.attachmentLimitMb : fallbackMb
  return mb * 1024 * 1024
}
