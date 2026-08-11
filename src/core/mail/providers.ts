/**
 * SMTP provider presets.
 *
 * The point of this table is that a non-technical user never has to know what
 * "STARTTLS on 587" means. They pick their mail provider, we fill in the rest,
 * and `hint` tells them the one thing that actually trips people up: most
 * providers refuse your normal login password and want an app-specific one.
 */

import type { TransportSecurity } from '../types'

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
  /**
   * Every Microsoft mailbox, consumer and work alike, is one endpoint pair.
   *
   * `smtp-mail.outlook.com` used to be listed here for the consumer domains.
   * It is the same service, but it is the name Microsoft is retiring, and it
   * answers on 587 only — so a preset that also has to be right for work
   * accounts would have had two spellings of one server. Both presets now
   * point at `smtp.office365.com:587` (STARTTLS) and
   * `outlook.office365.com:993` (SSL); anything else on this pair is a
   * misconfiguration, not a variant.
   */
  {
    id: 'outlook',
    name: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com'],
    host: 'smtp.office365.com',
    port: 587,
    security: 'starttls',
    /*
     * No `appPasswordUrl`, deliberately.
     *
     * It used to point at https://account.live.com/proofs/AppPassword, and
     * sending someone there is now worse than sending them nowhere: Microsoft
     * stopped accepting app passwords for IMAP/POP/SMTP on personal accounts
     * on 30 April 2026 — a date that has now passed — so the page either does
     * not issue one or issues one that is refused at sign-in. A "get an app
     * password" button leading to a dead end reads as the app being broken
     * rather than the method having been withdrawn, so the hint says what
     * happened instead.
     *
     * As of that date this preset is OAuth2-only in practice, which is what
     * `requiresOAuth('outlook')` in `core/oauth.ts` records and what the account
     * dialog acts on: choosing this provider selects OAuth2 rather than leaving
     * the user to discover that no password they can type will work.
     */
    hintKey: 'provider.hint.microsoftNoPassword',
    attachmentLimitMb: 20,
    dailyLimit: 300,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'office365',
    name: 'Microsoft 365 (work)',
    // A work mailbox lives on the company's own domain, so there is no list to
    // match on. `onmicrosoft.com` is the one Microsoft always issues, and the
    // dropdown covers the rest — picking it by hand is the autodiscover this
    // app does not do.
    domains: ['onmicrosoft.com'],
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
    name: 'QQ 邮箱 / Foxmail',
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
    id: 'neteaseYeah',
    name: '网易 yeah.net',
    domains: ['yeah.net'],
    host: 'smtp.yeah.net',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    attachmentLimitMb: 50,
    dailyLimit: 200,
    imapHost: 'imap.yeah.net',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'sina',
    name: '新浪邮箱',
    domains: ['sina.com', 'sina.cn', 'sina.com.cn', 'vip.sina.com'],
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
  /* --- the three Chinese business-mail services -----------------------------
     All three sell a mailbox on *your company's* domain, so `domains` can only
     list the vendor's own name and everything else has to be picked from the
     dropdown. They are separate entries rather than one because the servers
     genuinely differ — this is the set a Chinese work address is on. */
  {
    id: 'tencentExmail',
    name: '腾讯企业邮箱',
    domains: ['exmail.qq.com'],
    host: 'smtp.exmail.qq.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    appPasswordUrl: 'https://exmail.qq.com/qy_mng_logic/doc#10023',
    attachmentLimitMb: 50,
    dailyLimit: 500,
    imapHost: 'imap.exmail.qq.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'neteaseQiye',
    name: '网易企业邮箱',
    domains: ['qiye.163.com'],
    host: 'smtp.qiye.163.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.authCode',
    attachmentLimitMb: 50,
    imapHost: 'imap.qiye.163.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  {
    id: 'aliyunExmail',
    name: '阿里云企业邮箱',
    domains: ['mxhichina.com'],
    host: 'smtp.mxhichina.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.password',
    attachmentLimitMb: 50,
    imapHost: 'imap.mxhichina.com',
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
    id: 'aol',
    name: 'AOL Mail',
    domains: ['aol.com', 'aim.com', 'love.com', 'games.com'],
    host: 'smtp.aol.com',
    port: 465,
    security: 'ssl',
    hintKey: 'provider.hint.appPassword',
    appPasswordUrl: 'https://login.aol.com/account/security',
    attachmentLimitMb: 25,
    imapHost: 'imap.aol.com',
    imapPort: 993,
    imapSecurity: 'ssl',
  },
  /**
   * Proton has no public SMTP. The address below is Proton Bridge, the local
   * proxy that runs on the user's own machine — which is why the port is a
   * loopback one and the hint is a whole sentence: without Bridge installed
   * and running there is nothing at 127.0.0.1:1025 and the test will simply
   * refuse to connect, which reads as "the app is broken" unless we say so.
   */
  {
    id: 'proton',
    name: 'Proton Mail (Bridge)',
    domains: ['protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me'],
    host: '127.0.0.1',
    port: 1025,
    security: 'starttls',
    hintKey: 'provider.hint.bridge',
    appPasswordUrl: 'https://proton.me/mail/bridge',
    attachmentLimitMb: 25,
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapSecurity: 'starttls',
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

/**
 * The domain half of an address, normalised.
 *
 * Trailing dots (`a@qq.com.`) and stray whitespace are what a paste out of
 * another mail client actually looks like, and either one turns an exact
 * `domains.includes()` match into a miss.
 */
export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0) return ''
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>\s]+$/, '')
    .replace(/\.+$/, '')
}

/** Guess a preset from an email address, e.g. `a@qq.com` → the QQ preset. */
export function providerForAddress(address: string): ProviderPreset | undefined {
  const domain = domainOfAddress(address)
  if (!domain) return undefined
  return PROVIDERS.find((p) => p.domains.includes(domain))
}

/**
 * What we would fill the form in with, and how sure we are.
 *
 * `guessed` is the whole point of this type. A domain nobody recognises still
 * gets values — `smtp.<domain>` and `imap.<domain>` is the convention almost
 * every hosting provider follows — but the UI has to be able to say so, because
 * a guessed host that happens to be wrong looks exactly like a known-good one
 * until the connection test fails.
 */
export interface AutoConfig {
  domain: string
  preset: ProviderPreset
  guessed: boolean
}

/**
 * Everything derivable from an address alone.
 *
 * Returns `null` only when there is no domain to work from yet — half-typed
 * addresses ("me@") must not blank out fields the user is looking at.
 */
export function autoConfigForAddress(address: string): AutoConfig | null {
  const domain = domainOfAddress(address)
  if (!domain || !domain.includes('.')) return null

  const known = PROVIDERS.find((p) => p.domains.includes(domain))
  if (known) return { domain, preset: known, guessed: false }

  // 587/STARTTLS out and 993/SSL in is what a mail host that publishes nothing
  // else still answers on. It is a guess, and it is labelled as one.
  return {
    domain,
    guessed: true,
    preset: {
      id: 'custom',
      name: domain,
      domains: [domain],
      host: `smtp.${domain}`,
      port: 587,
      security: 'starttls',
      hintKey: 'provider.hint.custom',
      attachmentLimitMb: 25,
      imapHost: `imap.${domain}`,
      imapPort: 993,
      imapSecurity: 'ssl',
    },
  }
}

/** The fields an address can fill in on its own. */
export type AutoField =
  | 'providerId'
  | 'label'
  | 'host'
  | 'port'
  | 'security'
  | 'username'
  | 'imapHost'
  | 'imapPort'
  | 'imapSecurity'
  | 'imapUsername'

/**
 * The current form values, as far as this module needs to care.
 *
 * Structural rather than `MailAccount` + `InboxAccountState` so the rule can
 * be exercised without building two full records — and so `scripts/
 * check-autoconfig.mjs` can call it directly instead of testing a copy of it.
 */
export interface AutoFieldValues {
  providerId?: string
  label?: string
  host?: string
  port?: number
  security?: TransportSecurity
  username?: string
  fromAddress?: string
  imapHost?: string
  imapPort?: number
  imapSecurity?: TransportSecurity
  imapUsername?: string
}

/**
 * Which fields actually disagree with what `cfg` would have filled in.
 *
 * The distinction this draws is the whole reason changing a domain can be
 * safe. A host box reading `smtp.office365.com` under an Outlook address is
 * not a decision anybody made — it is the preset sitting where the preset put
 * it. Only a value moved *away* from the preset is a customisation worth
 * carrying across to a different mailbox.
 *
 * Returns an empty set for an address no preset knows, deliberately: with
 * nothing to compare against, "did they customise this?" is unanswerable, and
 * the caller should keep whatever flags it already had rather than guess.
 */
export function deviationsFrom(cfg: AutoConfig | null, values: AutoFieldValues): Set<AutoField> {
  const out = new Set<AutoField>()
  if (!cfg) return out
  const p = cfg.preset
  const add = (f: AutoField, actual: unknown, wanted: unknown) => {
    if (actual !== wanted) out.add(f)
  }
  add('providerId', values.providerId, cfg.guessed ? undefined : p.id)
  add('label', values.label, cfg.guessed ? cfg.domain : p.name)
  add('host', values.host, p.host)
  add('port', values.port, p.port)
  add('security', values.security, p.security)
  add('username', values.username, values.fromAddress)
  if (p.imapHost) {
    add('imapHost', values.imapHost, p.imapHost)
    add('imapPort', values.imapPort, p.imapPort)
    add('imapSecurity', values.imapSecurity, p.imapSecurity)
  }
  add('imapUsername', values.imapUsername, values.fromAddress)
  return out
}

/**
 * The hand-edit flags to carry into a new address.
 *
 * Same domain — a typo fix, a plus-tag, a different mailbox on one server —
 * keeps every flag: the stored config was chosen on purpose and re-typing the
 * local part is not a request to rewrite it.
 *
 * Different domain is a different mailbox, and the servers that went with the
 * old one stop being a deliberate choice. Editing an existing account used to
 * flag *every* field up front, so `me@outlook.com` → `me@gmail.com` left
 * Microsoft's servers under a Gmail address and looked like nothing happened
 * at all. Now the flags are recomputed from what genuinely deviated.
 */
export function carryAutoFlags(
  previousAddress: string,
  nextAddress: string,
  values: AutoFieldValues,
  current: ReadonlySet<AutoField>,
): ReadonlySet<AutoField> {
  const previousDomain = domainOfAddress(previousAddress)
  const nextDomain = domainOfAddress(nextAddress)
  if (!previousDomain || !nextDomain || previousDomain === nextDomain) return current

  const previous = autoConfigForAddress(previousAddress)
  if (!previous) return current
  return deviationsFrom(previous, values)
}

/** The attachment ceiling to enforce for an account, in bytes. */
export function attachmentLimitBytes(providerId: string | undefined, fallbackMb: number): number {
  const preset = providerById(providerId)
  const mb = preset && preset.id !== 'custom' ? preset.attachmentLimitMb : fallbackMb
  return mb * 1024 * 1024
}
