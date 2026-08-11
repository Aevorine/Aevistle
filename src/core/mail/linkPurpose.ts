/**
 * What a link in a mail is *for*, and what is worth warning about before it is
 * opened.
 *
 * The codes screen used to show a bare URL. A bare URL is the one form in which
 * this information is least legible: the part that says what will happen —
 * `/auth/magic`, `?action=reset` — is buried in the middle of a hundred
 * characters of tracking parameters, and the part that decides whether it is
 * safe to press is the registrable domain, which is neither at the start nor
 * the end of what a person reads. Classifying it up front turns "here is a
 * string" into "this signs you in, at login.live.com, for the next 15 minutes".
 *
 * Everything here is a *static* read of the URL text. Nothing resolves a
 * redirect, fetches a `HEAD`, or otherwise touches the network: this module
 * runs over mail that arrived unsolicited, and quietly dereferencing links in
 * it is exactly the behaviour that turns a mail client into a confirmation
 * oracle for whoever sent it.
 */

/** Ordered widest-first, because the first match wins in `classify`. */
export type LinkPurpose =
  | 'signin'
  | 'verifyEmail'
  | 'resetPassword'
  | 'activate'
  | 'confirmSubscribe'
  | 'confirmOrder'
  | 'manage'
  | 'unsubscribe'
  | 'tracking'
  | 'unknown'

/**
 * Something about the link a person would want to know before pressing it.
 *
 * Deliberately not a single "safe/unsafe" verdict. These mails are overwhelmingly
 * legitimate, and a client that cried wolf on every `click.mail.example.com`
 * would train the one habit that matters most to break — pressing through the
 * warning. Each flag says one checkable fact instead.
 */
export type LinkRisk =
  /** Lands on a domain unrelated to who sent the mail. */
  | 'crossDomain'
  /** Plain `http://` — credentials typed after this are readable in transit. */
  | 'insecure'
  /** A known link-wrapper: the visible host is not the destination. */
  | 'redirector'
  /** Carries a token in the query string, so it is likely single-use. */
  | 'oneTimeToken'
  /** Punycode host — the classic look-alike-domain trick. */
  | 'punycode'
  /** Bare IP address instead of a name. */
  | 'ipHost'

export interface LinkAnalysis {
  purpose: LinkPurpose
  /** How much the purpose is worth believing — `low` renders as "purpose unclear". */
  purposeConfidence: 'high' | 'medium' | 'low'
  /** Host as written in the URL. */
  host: string
  /** `login.live.com` → `live.com`; what "same site as the sender" is judged on. */
  domain: string
  risks: LinkRisk[]
}

/**
 * Two-label public suffixes common enough to matter here.
 *
 * Not the full Public Suffix List, and deliberately so: shipping and refreshing
 * ~9000 entries to decide whether a chip says "same site" is out of proportion
 * to what the chip is worth. Getting an unlisted suffix wrong produces one
 * false `crossDomain` flag, which is the direction to be wrong in.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.au', 'net.au', 'org.au',
  'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'or.kr',
  'com.br', 'com.mx', 'com.ar', 'co.nz', 'co.in', 'co.za',
])

/** `mail.notifications.live.com` → `live.com`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.')
  return lastTwo
}

/** `"Microsoft <account@microsoft.com>"` → `microsoft.com`; `''` when unreadable. */
export function senderDomain(from: string): string {
  const match = /<([^>]+)>/.exec(from)
  const address = (match ? match[1] : from).trim()
  const at = address.lastIndexOf('@')
  if (at < 0) return ''
  return registrableDomain(address.slice(at + 1).trim())
}

/**
 * Link wrappers, by registrable domain.
 *
 * Being on this list is not a mark against the sender — every large mailer
 * wraps links for click statistics. It is on the list because the host shown in
 * the card is provably not where the press ends up, and saying so is more
 * honest than showing `click.mail.example.com` as if it were the destination.
 */
const REDIRECTORS = new Set([
  't.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly', 'lnkd.in',
  'sendgrid.net', 'mailchimp.com', 'list-manage.com', 'mandrillapp.com',
  'sparkpostmail.com', 'mailgun.org', 'cmail19.com', 'cmail20.com',
  'exacttarget.com', 'mktdns.com', 'go.pardot.com', 'hubspotlinks.com',
  'aweber.com', 'getresponse.com', 'dianyoudns.com', 'mikecrm.com',
])

/**
 * Path/query signatures, most specific first.
 *
 * Order is the whole design. A password-reset link is also a sign-in link in
 * the loosest sense, and `/account/settings/unsubscribe` matches both `manage`
 * and `unsubscribe` — in both cases the narrower reading is the one a person
 * would give, so the narrower pattern is tested first and wins outright.
 */
const PURPOSE_URL_RULES: Array<{ purpose: LinkPurpose; re: RegExp }> = [
  { purpose: 'unsubscribe', re: /unsubscribe|opt[-_]?out|list-manage.*\bu=|\/tuidin|退订/i },
  { purpose: 'resetPassword', re: /reset[-_]?(password|pwd)|password[-_]?reset|forgot[-_]?password|changepassword|\bpwdreset|重置密码|忘记密码/i },
  /* A path segment literally called `/verify` or `/confirm` counts on its own.
     Requiring `verify-email` was too strict for the commonest shape of all —
     `https://example.com/verify?token=…` — which then fell through to
     "purpose unclear" on exactly the mails this feature exists for. */
  { purpose: 'verifyEmail', re: /verify[-_]?(email|address|mail)|email[-_]?verif|confirm[-_]?(email|address)|\/(verify|confirmation|confirm)\b|验证邮箱|确认邮箱|邮箱验证/i },
  { purpose: 'activate', re: /activate|activation|\/enable\b|激活/i },
  { purpose: 'confirmSubscribe', re: /confirm[-_]?(subscription|subscribe)|subscribe[-_]?confirm|double[-_]?opt|确认订阅/i },
  { purpose: 'confirmOrder', re: /order|receipt|invoice|shipment|tracking[-_]?number|订单|发票|物流/i },
  { purpose: 'signin', re: /magic[-_]?link|passwordless|one[-_]?click[-_]?(login|signin)|\/(login|signin|sign-in|auth|sso|oauth2?|session)\b|登录|登陆/i },
  { purpose: 'manage', re: /\/(account|settings|profile|preferences|manage|security)\b|账户设置|管理/i },
  { purpose: 'tracking', re: /\/(open|pixel|beacon|track|clk|click|redirect|r)\b|utm_|\/o\/|\/c\/|\.gif$/i },
]

/** Query keys that reliably indicate a purpose the path did not spell out. */
const PURPOSE_QUERY_RULES: Array<{ purpose: LinkPurpose; re: RegExp }> = [
  { purpose: 'resetPassword', re: /[?&](reset|rp|pwd)[-_]?(token|code)?=/i },
  { purpose: 'verifyEmail', re: /[?&](verify|verification|confirm)[-_]?(token|code|key|id)?=/i },
  { purpose: 'activate', re: /[?&]activation[-_]?(token|code|key)?=/i },
  { purpose: 'signin', re: /[?&](login|signin|auth|sso|magic|otp|nonce)[-_]?(token|key)?=/i },
]

/** Anchor text and surrounding copy, when the URL itself is opaque. */
const PURPOSE_TEXT_RULES: Array<{ purpose: LinkPurpose; re: RegExp }> = [
  { purpose: 'unsubscribe', re: /unsubscribe|opt out|退订|取消订阅|se désabonner|darse de baja|отписаться|إلغاء الاشتراك/i },
  { purpose: 'resetPassword', re: /reset (your )?password|重置密码|réinitialiser|restablecer (tu )?contraseña|сбросить пароль|إعادة تعيين كلمة المرور/i },
  { purpose: 'verifyEmail', re: /verify (your )?(email|address)|confirm (your )?email|验证(你的)?邮箱|确认邮件地址|vérifiez votre (e-?mail|adresse)|verifica tu correo|подтвердите (адрес|почту)|تحقق من بريدك/i },
  { purpose: 'activate', re: /activate (your )?account|激活(你的)?(账[户号]|帐[户号])|activer votre compte|activa tu cuenta|активировать/i },
  { purpose: 'confirmSubscribe', re: /confirm (your )?subscription|确认订阅|confirmez votre abonnement|confirma tu suscripción/i },
  { purpose: 'confirmOrder', re: /view (your )?order|track (your )?(order|package)|查看订单|查询物流|voir votre commande|ver tu pedido/i },
  { purpose: 'signin', re: /sign in|log ?in|continue to|一键登录|点击登录|立即登录|se connecter|iniciar sesión|войти|تسجيل الدخول/i },
  { purpose: 'manage', re: /manage (your )?(account|preferences)|account settings|账户设置|管理(你的)?(账[户号]|订阅)/i },
]

/**
 * A query parameter that reads like a bearer token.
 *
 * The length floor is doing the work: `?code=1` is a page selector, `?code=` +
 * forty characters is a credential, and the difference decides whether the card
 * says "single use — opening it twice will fail", which is the sentence that
 * saves the second, confusing round trip.
 */
const TOKEN_QUERY = /[?&](token|code|key|otp|nonce|auth|ticket|t|k|c|hash|sig|signature|confirmation)=([^&#]{16,})/i

const IP_HOST = /^\d{1,3}(\.\d{1,3}){3}$/

export function analyzeLink(
  url: string,
  ctx: { anchorText?: string; from?: string; subject?: string; body?: string } = {},
): LinkAnalysis | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  const host = parsed.host
  const domain = registrableDomain(parsed.hostname)
  const pathAndQuery = parsed.pathname + parsed.search

  const risks: LinkRisk[] = []
  if (parsed.protocol === 'http:') risks.push('insecure')
  if (REDIRECTORS.has(domain)) risks.push('redirector')
  if (/(^|\.)xn--/i.test(parsed.hostname)) risks.push('punycode')
  if (IP_HOST.test(parsed.hostname)) risks.push('ipHost')
  if (TOKEN_QUERY.test(parsed.search)) risks.push('oneTimeToken')

  const fromDomain = ctx.from ? senderDomain(ctx.from) : ''
  /* Only flagged when the sender is actually known. An unparseable `From` is a
     reason to say nothing, not a reason to accuse the link of being off-site. */
  if (fromDomain && domain && domain !== fromDomain && !sharesBrand(domain, fromDomain)) {
    risks.push('crossDomain')
  }

  /* Strongest evidence first: the URL is written by the service, the anchor
     text is written for a human, and the surrounding copy is about the whole
     mail rather than this one link. */
  let purpose: LinkPurpose = 'unknown'
  let purposeConfidence: LinkAnalysis['purposeConfidence'] = 'low'

  for (const rule of PURPOSE_URL_RULES) {
    if (rule.re.test(pathAndQuery)) {
      purpose = rule.purpose
      purposeConfidence = 'high'
      break
    }
  }
  if (purpose === 'unknown') {
    for (const rule of PURPOSE_QUERY_RULES) {
      if (rule.re.test(parsed.search)) {
        purpose = rule.purpose
        purposeConfidence = 'high'
        break
      }
    }
  }
  if (purpose === 'unknown' && ctx.anchorText) {
    for (const rule of PURPOSE_TEXT_RULES) {
      if (rule.re.test(ctx.anchorText)) {
        purpose = rule.purpose
        purposeConfidence = 'medium'
        break
      }
    }
  }
  if (purpose === 'unknown') {
    const copy = `${ctx.subject ?? ''}\n${ctx.body ?? ''}`
    for (const rule of PURPOSE_TEXT_RULES) {
      if (rule.re.test(copy)) {
        purpose = rule.purpose
        /* The mail as a whole talks about signing in; *this* link may still be
           the footer's privacy policy. Believable, not authoritative. */
        purposeConfidence = 'low'
        break
      }
    }
  }

  /* A token in the query is not what the link is for, but it does corroborate
     an action link over a footer link — enough to lift a text-only guess. */
  if (purpose !== 'unknown' && purposeConfidence === 'low' && risks.includes('oneTimeToken')) {
    purposeConfidence = 'medium'
  }

  return { purpose, purposeConfidence, host, domain, risks }
}

/**
 * `live.com` vs `microsoft.com` — different registrable domains, same operator.
 *
 * A shared brand label is a weak signal and it is used weakly: all it does is
 * suppress an off-site flag that would otherwise fire on every large service
 * that owns more than one domain. It never adds trust to anything.
 */
function sharesBrand(a: string, b: string): boolean {
  const brandOf = (d: string) => d.split('.')[0]
  const x = brandOf(a)
  const y = brandOf(b)
  if (!x || !y) return false
  if (x === y) return true
  return KNOWN_BRAND_FAMILIES.some((family) => family.has(x) && family.has(y))
}

/** Deliberately short: only families whose mail genuinely lands off-domain. */
const KNOWN_BRAND_FAMILIES: Array<Set<string>> = [
  new Set(['microsoft', 'live', 'outlook', 'office', 'microsoftonline', 'msn', 'azure', 'sharepointonline']),
  new Set(['google', 'gmail', 'youtube', 'googlemail', 'goo']),
  new Set(['apple', 'icloud', 'me']),
  new Set(['amazon', 'amazonses', 'awsapps']),
  new Set(['github', 'githubusercontent', 'githubapp']),
  new Set(['alipay', 'taobao', 'tmall', 'aliyun', 'alibaba', 'antgroup']),
  new Set(['qq', 'tencent', 'weixin', 'wechat']),
]

/**
 * How long the thing in this mail stays usable, read out of the copy.
 *
 * Worth parsing rather than assuming a default: the honest states are "expires
 * at 14:32" and "no expiry stated", and a client that invented "probably 10
 * minutes" for the second one would grey out codes that were still perfectly
 * good. `undefined` means the mail did not say.
 */
export interface Validity {
  /** Milliseconds from when the mail was sent. */
  ms?: number
  /** The copy says it can only be used once. */
  oneTime?: boolean
}

const UNIT_MS: Record<string, number> = {
  second: 1000, seconds: 1000, sec: 1000, secs: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  秒: 1000, 分: 60_000, 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000, 日: 86_400_000,
  seconde: 1000, secondes: 1000, minutos: 60_000, minuto: 60_000,
  segundo: 1000, segundos: 1000, hora: 3_600_000, horas: 3_600_000,
  heure: 3_600_000, heures: 3_600_000, jour: 86_400_000, jours: 86_400_000,
  минут: 60_000, минуты: 60_000, час: 3_600_000, часа: 3_600_000,
}

/**
 * Each entry captures `[amount, unit]`. Split by language rather than merged
 * into one monster pattern so an addition for one locale cannot silently change
 * how another one matches.
 */
const VALIDITY_PATTERNS: RegExp[] = [
  // English: "expires in 15 minutes", "valid for 24 hours", "active for 10 min"
  /(?:expires?|expiry|valid|active|usable)\s+(?:in|for|within|during)?\s*(\d{1,4})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i,
  // English, other order: "15 minutes before it expires", "you have 10 minutes"
  /(?:you have|within|in the next)\s*(\d{1,4})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i,
  /(\d{1,4})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\s*(?:before it|until it|and then it)?\s*(?:expires?|is no longer valid)/i,
  // Chinese: "15 分钟内有效" / "有效期 24 小时" / "10 分钟后失效"
  /(?:有效期(?:为|是)?|将在|请在)?\s*(\d{1,4})\s*(秒|分钟|分|小时|天|日)\s*(?:钟)?\s*(?:之?内)?\s*(?:有效|后失效|后过期|内使用|内输入|内完成)/,
  /(?:有效|失效|过期)(?:时间)?\s*[:：]?\s*(\d{1,4})\s*(秒|分钟|分|小时|天|日)/,
  // French: "expire dans 15 minutes", "valable 24 heures"
  /(?:expire|valable|valide)\s*(?:dans|pendant|pour)?\s*(\d{1,4})\s*(secondes?|minutes?|heures?|jours?)/i,
  // Spanish: "caduca en 15 minutos", "válido durante 24 horas"
  /(?:caduca|expira|válido|valido)\s*(?:en|durante|por)?\s*(\d{1,4})\s*(segundos?|minutos?|horas?|d[ií]as?)/i,
  // Russian: "действителен 15 минут"
  /(?:действителен|истекает|истечёт|через)\s*(?:в течение)?\s*(\d{1,4})\s*(секунд\w*|минут\w*|час\w*|дн\w*|день)/i,
  // Arabic: "خلال 15 دقيقة"
  /(?:خلال|لمدة|تنتهي\s+صلاحيته\s+خلال)\s*(\d{1,4})\s*(ثانية|ثواني|دقيقة|دقائق|ساعة|ساعات|يوم|أيام)/,
]

const ARABIC_UNIT_MS: Array<[RegExp, number]> = [
  [/^ثانية|^ثواني/, 1000],
  [/^دقيقة|^دقائق/, 60_000],
  [/^ساعة|^ساعات/, 3_600_000],
  [/^يوم|^أيام/, 86_400_000],
]

const ONE_TIME = /一次性|仅可使用一次|只能使用一次|只可使用一次|单次使用|single[-\s]?use|one[-\s]?time (?:use|only)|can only be used once|used only once|usage unique|un solo uso|одноразов|لمرة واحدة/i

export function parseValidity(text: string): Validity | null {
  const out: Validity = {}
  for (const re of VALIDITY_PATTERNS) {
    const m = re.exec(text)
    if (!m) continue
    const amount = Number(m[1])
    if (!Number.isFinite(amount) || amount <= 0) continue
    const unit = m[2].toLowerCase()
    const ms = unitToMs(unit)
    if (!ms) continue
    /* A "valid for 90 days" in a newsletter footer is not this mail's code
       expiring; anything past a week is noise for a screen about codes. */
    const total = amount * ms
    if (total > 7 * 86_400_000) continue
    out.ms = total
    break
  }
  if (ONE_TIME.test(text)) out.oneTime = true
  return out.ms === undefined && !out.oneTime ? null : out
}

function unitToMs(unit: string): number | undefined {
  if (UNIT_MS[unit]) return UNIT_MS[unit]
  /* Latin plurals and Russian/Spanish stems that the table lists in one form. */
  const stripped = unit.replace(/(s|es)$/, '')
  if (UNIT_MS[stripped]) return UNIT_MS[stripped]
  for (const [re, ms] of ARABIC_UNIT_MS) if (re.test(unit)) return ms
  if (/^секунд/.test(unit)) return 1000
  if (/^минут/.test(unit)) return 60_000
  if (/^час/.test(unit)) return 3_600_000
  if (/^дн|^день/.test(unit)) return 86_400_000
  if (/^d[ií]a/.test(unit)) return 86_400_000
  if (/^hora/.test(unit)) return 3_600_000
  if (/^minuto/.test(unit)) return 60_000
  if (/^segundo/.test(unit)) return 1000
  if (/^heure/.test(unit)) return 3_600_000
  if (/^jour/.test(unit)) return 86_400_000
  if (/^seconde/.test(unit)) return 1000
  return undefined
}
