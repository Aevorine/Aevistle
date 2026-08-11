/**
 * Verification-code / login-link extraction.
 *
 * Runs in the renderer over already-synced, already-sanitized message text —
 * not in the native background layer. Extraction is a UI convenience, not a
 * delivery-critical path the way sending is, so it does not need to survive
 * the app being closed; keeping it here also avoids porting a six-language
 * regex table into the Android native layer a second time, which today has
 * no i18n knowledge at all.
 *
 * A confidence tier, not a numeric score — matching this codebase's existing
 * preference for explainable, structured results (`Issue.severity`,
 * `TransportDiagnostics`) over an opaque number a user cannot reason about.
 *
 * ---------------------------------------------------------------------------
 * Why this file is shaped the way it is
 *
 * The bug that rewrote it: a Microsoft password-reset mail whose code was
 * `390089` displayed `98052` — the ZIP of One Microsoft Way, Redmond. Three
 * things had to line up, and no single fix would have been enough.
 *
 *   1. The Chinese keyword table held 验证码/校验码/动态码/安全码 but not 代码,
 *      and that mail says 「你的代码如下」. So the whole message scored as
 *      *keyword-free* and skipped the scoring path entirely.
 *   2. The keyword-free fallback then accepted any lone digit run in a short
 *      body — no notion that a five-digit number sitting after `Redmond, WA`
 *      is a postal code and never a passcode.
 *   3. `390089` was not competing, because a code rendered as separate styled
 *      elements comes out of tag-stripping as `3 9 0 0 8 9` and stopped
 *      looking like a digit run at all.
 *
 * So: the keyword table is wide (B1), digits that provably belong to an
 * address, phone number, price or copyright line are struck out *before*
 * anything is scored (B2), the keyword-free path demands much more before it
 * will speak (B3), split digits are rejoined first (B4), well-known senders
 * get exact patterns (B5), the runners-up survive so a wrong pick can be
 * corrected in one press (B6), every accepted and rejected candidate carries
 * the reason it got that treatment (B7), and a correction is remembered per
 * sender so the same mail is not misread twice (B8).
 */

import { analyzeLink, parseValidity, registrableDomain, senderDomain } from '../mail/linkPurpose'
import type { LinkAnalysis, Validity } from '../mail/linkPurpose'

export type ExtractConfidence = 'high' | 'medium' | 'low'

/** Where the winning candidate was found, so a wrong answer is explainable. */
export type ExtractSource = 'subject' | 'body' | 'link'

/**
 * Why a candidate won or lost, as a code rather than a sentence.
 *
 * Structured because the panel that shows it is translated into six languages;
 * an English explanation baked in here would be the one part of the screen that
 * silently stayed English.
 */
export type ReasonCode =
  // accepted-side
  | 'keywordAfter'
  | 'keywordBefore'
  | 'sixDigits'
  | 'inSubject'
  | 'senderTemplate'
  | 'userPreferred'
  | 'onlyNumber'
  // rejected-side
  | 'isPostcode'
  | 'isPhone'
  | 'isAmount'
  | 'isCopyrightYear'
  | 'isStreetNumber'
  | 'isYear'
  | 'inFooter'
  | 'farFromKeyword'
  | 'userRejected'
  | 'lowScore'

export interface ExtractReason {
  code: ReasonCode
  /** Substituted into the translated string — a keyword, a distance, a domain. */
  detail?: string
}

/** A candidate that did not win, kept so the pick can be corrected in one press. */
export interface CodeAlternative {
  value: string
  reasons: ExtractReason[]
  /** False for anything struck out before scoring — those are shown as excluded. */
  eligible: boolean
}

export interface ExtractedCode {
  kind: 'code'
  value: string
  confidence: ExtractConfidence
  source: ExtractSource
  /** Why this one (B7). */
  reasons: ExtractReason[]
  /** Runners-up and struck-out numbers, best first (B6). */
  alternatives: CodeAlternative[]
  /** What the mail said about how long it lasts, when it said anything. */
  validity?: Validity
}

export interface ExtractedLink {
  kind: 'link'
  value: string
  confidence: ExtractConfidence
  source: ExtractSource
  reasons: ExtractReason[]
  alternatives: CodeAlternative[]
  /** What the link is for and what is worth knowing before pressing it (C1–C3). */
  analysis: LinkAnalysis
  /** The text that was written on the link, when there was any. */
  anchorText?: string
  validity?: Validity
}

export type Extracted = ExtractedCode | ExtractedLink

/** A link as it appeared in the mail: the target plus what it was labelled. */
export interface MailLink {
  url: string
  text?: string
}

/**
 * A correction the user made, remembered per sender (B8).
 *
 * Keyed on the registrable domain rather than the full address because the
 * address a service sends from rotates — `account-security-noreply@`,
 * `no-reply@`, a per-region prefix — while the domain is what stays put, and a
 * rule that expired every time Microsoft changed a mailbox prefix would never
 * pay back the press it cost to create.
 */
export interface CodeRule {
  domain: string
  /**
   * Values this sender never means. A ZIP code, a support hotline and a
   * building number are all constants, so remembering the literal value is
   * both the simplest rule and the one that actually generalises.
   */
  reject?: string[]
  /**
   * Text that immediately preceded the right answer, normalised and trimmed —
   * `你的代码如下` for the Microsoft mail. Matching on the run-up rather than on
   * the value is what makes the rule work for *next* month's code too.
   */
  preferContext?: string[]
}

/** How much of the run-up to a code is remembered, and matched, for a rule. */
const CONTEXT_WINDOW = 16

// ---------------------------------------------------------------------------
// B1 — keyword tables
// ---------------------------------------------------------------------------

/**
 * One keyword set per supported locale (see `src/i18n`), matched case-insensitively.
 *
 * Wide on purpose. Every entry that is missing costs a whole message: a mail
 * with no recognised keyword does not merely score lower, it drops out of the
 * scoring path and into the deliberately timid fallback below. `代码` is here
 * because leaving it out is precisely what produced `98052`.
 */
const CODE_KEYWORDS = [
  /verification code|verify code|confirmation code|security code|passcode|pass code|access code|one[- ]time (?:code|password|passcode|pin)|one time password|single[- ]use code|login code|sign[- ]?in code|authentication code|auth code|\bOTP\b|\bPIN\b|your code is|here is your code|code is|use this code|enter (?:this|the) code|temporary (?:code|password)/gi,
  /验证码|校验码|动态码|安全码|安全代码|验证代码|校验代码|动态密码|一次性密码|临时密码|临时口令|登录码|登入码|短信码|口令|代码/g,
  /code de vérification|code de confirmation|code de sécurité|code d'accès|code à usage unique|mot de passe temporaire|votre code/gi,
  /código de verificación|código de confirmación|código de seguridad|código de acceso|código de un solo uso|contraseña temporal|tu código/gi,
  /код подтверждения|проверочный код|код безопасности|одноразовый код|временный пароль|ваш код/gi,
  /رمز التحقق|رمز التأكيد|رمز الأمان|رمز الدخول|رمز لمرة واحدة|كلمة مرور مؤقتة|الرمز الخاص بك/g,
]

const LINK_KEYWORDS = [
  /verify your (email|account)|confirm your (email|account)|sign in|log ?in|activate|reset your password|magic link/i,
  /登录|登陆|验证邮箱|确认账号|确认帐号|激活|重置密码|一键登录/,
  /vérifiez votre|confirmez votre|se connecter|réinitialiser/i,
  /verifica tu|confirma tu|iniciar sesión|restablecer/i,
  /подтвердите|войти в систему|сбросить пароль/i,
  /تحقق من|قم بتأكيد|تسجيل الدخول|إعادة تعيين/,
]

// ---------------------------------------------------------------------------
// Digit runs and the things that merely look like them
// ---------------------------------------------------------------------------

/**
 * 4-8 digits, optionally grouped once with a space or dash ("947 500").
 *
 * The boundaries are the whole point. They used to be `(?<![\d-])` /
 * `(?![\d-])`, which only refused to split a *longer run of digits* — so in an
 * address local part such as `someone1234@example.com` the run `1234` sits
 * immediately after a letter, passes both lookarounds, and reads exactly like
 * a four-digit code. That is the "it showed the digits from my own address"
 * report, and blanking addresses out beforehand did not fix it: one `<span>`
 * or `<wbr>` inside the address in the HTML part is enough for the address
 * pattern to stop matching while the digits survive tag-stripping intact.
 *
 * Requiring the run to be a *standalone token* — no word character, `@` or `-`
 * on either side — closes that off at the source, independently of whether any
 * earlier cleanup step recognised the surrounding text.
 *
 * The dot is the subtle part, and getting it wrong cost every code that ended
 * a sentence. Blanket-refusing an adjacent `.` — which is what this pattern
 * used to do — means `Your code is 615204.` matches nothing at all, because the
 * full stop that ends the sentence is indistinguishable to the pattern from the
 * dot in `1.2.3`. So the dot is only disqualifying when a digit sits on the far
 * side of it: `192.168.1.100` and `12.50` are still refused, and ordinary
 * punctuation is no longer a way for a code to disappear.
 */
const CODE_PATTERN = /(?<![\w@\-])(?<!\d\.)(\d{3}[\s-]?\d{3}|\d{4,8})(?![\w@\-])(?!\.\d)/g

/** Blanked before searching, so a URL's query string can never donate a code. */
const URL_PATTERN = /https?:\/\/\S+/gi

/**
 * Deliberately looser than `isValidAddress`: this runs over text recovered by
 * stripping tags out of HTML, where `jane<span>@</span>example.com` arrives as
 * `jane @ example.com`. Tolerating the stray spaces is what keeps such an
 * address recognisable as one.
 *
 * The local part and each domain label are bounded to `{0,63}`/`{1,63}`
 * rather than left as `*`/`+`. Uncapped, a long run of local-part characters
 * with no `@` anywhere after it (easy for a hostile mail to construct) makes
 * the engine backtrack the greedy run one character at a time from every
 * starting position — quadratic in the run's length. RFC 5321 already caps a
 * local part at 64 octets and a DNS label at 63, so the bound costs nothing
 * on real addresses and turns the worst case linear.
 */
const EMAIL_PATTERN =
  /[a-z0-9][a-z0-9._%+-]{0,63}\s*@\s*[a-z0-9-]{1,63}(?:\s*\.\s*[a-z0-9-]{1,63})+/gi

/**
 * A verification code is always digits only, so a token that mixes letters
 * and digits — `someone1234`, `ID20250811`, `order7788x` — can be removed
 * wholesale rather than reasoned about. `blankMixedTokens` below implements
 * this with a single linear pass; see its comment for why it isn't a regex.
 */
const TOKEN_CHAR = /[a-zA-Z0-9._%+-]/
const LETTER_CHAR = /[a-zA-Z]/
const DIGIT_CHAR = /[0-9]/
const BOUNDARY_EXCLUDED = /[\w@.\-]/

/** Years read as four-digit codes; only accepted when a keyword vouches for them. */
const YEAR_LIKE = /^(19|20)\d{2}$/

/**
 * B4 — digits that arrived spaced out, one per element.
 *
 * `<span>3</span><span>9</span>…` is a normal way to letter-space a code, and
 * the tag-stripping that feeds this file turns every one of those tags into a
 * space. The result reads as six one-digit tokens, matches nothing, and hands
 * the message to the fallback path with the real code invisible — which is the
 * third of the three things that produced `98052`.
 *
 * Newlines are *not* accepted as separators here. Tag-stripping emits spaces,
 * so allowing `\n` would buy nothing while turning any numbered list into a
 * six-digit code.
 */
const SPLIT_DIGITS = /(?<![\w@.\-])(\d(?:[   ]\d){3,7})(?![\w@.\-])/g

/** Removed outright: they exist to be invisible, and they split codes. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g

/**
 * B2 — digits that provably belong to something that is not a code.
 *
 * Each pattern captures *only the digits to strike out*, never the whole line.
 * Blanking whole lines was the obvious first implementation and it is wrong:
 * HTML-to-text routinely collapses an entire mail onto one "line", and a rule
 * that ate that line would eat the code with it.
 */
const NEGATIVES: Array<{ re: RegExp; reason: ReasonCode }> = [
  // "Redmond, WA 98052" / "WA 98052-6399" — the reported bug, exactly.
  {
    re: /\b(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])[ ,]+(\d{5})(?:-\d{4})?\b/g,
    reason: 'isPostcode',
  },
  // "邮编：518000" / "邮政编码 100085"
  { re: /(?:邮编|邮政编码|zip(?:\s*code)?|postal\s*code|postcode)\s*[:：]?\s*(\d{4,6})/gi, reason: 'isPostcode' },
  // A five-digit number wedged between a place name and a country line.
  { re: /\b(\d{5})(?:-\d{4})?\s*(?:,\s*)?(?:USA|United States|U\.S\.A\.)\b/gi, reason: 'isPostcode' },
  // "One Microsoft Way" has no digits, but "1600 Amphitheatre Parkway" does.
  {
    re: /\b(\d{1,5})\s+(?:[A-Z][A-Za-z.]+\s+){0,3}(?:Way|Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Parkway|Pkwy|Suite|Ste|Floor|Plaza|Square)\b/g,
    reason: 'isStreetNumber',
  },
  // "深圳市南山区科技路 12 号 3 栋 405 室"
  { re: /(\d{1,5})\s*(?:号楼|号院|号|栋|幢|单元|室|层|楼)(?![\d])/g, reason: 'isStreetNumber' },
  { re: /(?:电话|热线|客服|专线|传真|手机|Tel|Phone|Fax|Hotline|Mobile)\s*[:：]?\s*([\d\-\s()+]{7,20})/gi, reason: 'isPhone' },
  // Bare hyphen/space-formatted phone numbers: 400-820-8820, +1 (800) 555-0199
  { re: /(?<![\w@.\-])(\+?\d{1,3}[-\s]?\(?\d{3}\)?[-\s]\d{3,4}[-\s]\d{4})(?![\w@.\-])/g, reason: 'isPhone' },
  { re: /(?:©|\(c\)|copyright|版权所有)\s*(\d{4})(?:\s*[-–—]\s*\d{4})?/gi, reason: 'isCopyrightYear' },
  { re: /(\d{4})(?:\s*[-–—]\s*\d{4})?\s*(?:©|\(c\))/g, reason: 'isCopyrightYear' },
  { re: /[$¥€£₽﷼]\s*([\d,]{2,}(?:\.\d+)?)/g, reason: 'isAmount' },
  { re: /([\d,]{2,}(?:\.\d+)?)\s*(?:元|美元|人民币|USD|CNY|RMB|EUR|GBP)\b/gi, reason: 'isAmount' },
]

/**
 * Where the mail stops talking to you and starts talking to the lawyers.
 *
 * Not struck out — a legitimate code has never once appeared below one of these
 * lines, but "never once" is not "cannot", so this is a heavy penalty rather
 * than a deletion, and the number stays visible as an excluded alternative.
 */
const FOOTER_MARKER =
  /privacy (?:statement|policy|notice)|terms of (?:use|service)|all rights reserved|unsubscribe|manage (?:your )?preferences|this (?:is an|email was) automat|隐私(?:声明|政策)|服务条款|版权所有|保留所有权利|退订|本邮件由系统自动发送|请勿回复/i

const LINK_PATH_HINT = /verify|confirm|activate|magic-?link|auth|sso|login|signin|reset/i
const LINK_QUERY_HINT = /[?&](token|code|otp|verify|confirm|t|key|nonce)=/i

/** How far after a keyword a code still counts as "the code that keyword announced". */
const AFTER_KEYWORD_WINDOW = 48
/** Codes *before* the keyword ("482913 is your verification code") are rarer but real. */
const BEFORE_KEYWORD_WINDOW = 24

// ---------------------------------------------------------------------------
// B5 — per-sender templates
// ---------------------------------------------------------------------------

/**
 * Exact patterns for senders worth being exact about.
 *
 * These do not replace the scoring path, they short-circuit it. A big service
 * writes the same sentence around its code every single time, and matching that
 * sentence is both more accurate than any amount of proximity scoring and, more
 * usefully, *stable*: it keeps working when the mail also contains a support
 * hotline, an order reference and a postal address, all of which are numbers
 * the scorer has to reason its way past.
 */
const SENDER_TEMPLATES: Array<{ brands: string[]; patterns: RegExp[] }> = [
  {
    brands: ['microsoft', 'live', 'outlook', 'msn', 'microsoftonline', 'office', 'skype'],
    patterns: [
      /(?:你的|您的)?(?:代码|安全代码|验证码)(?:如下|是|为)?\s*[:：]\s*(\d{4,8})/,
      /(?:here is your code|your code is|your security code is|security code)\s*[:：]?\s*(\d{4,8})/i,
      /(?:use this code|account security code)\D{0,24}(\d{6,8})/i,
    ],
  },
  {
    brands: ['google', 'gmail', 'googlemail', 'youtube'],
    patterns: [/\bG-(\d{6})\b/, /(?:verification code|验证码)\D{0,24}(\d{6})/i],
  },
  {
    brands: ['apple', 'icloud'],
    patterns: [
      /(?:apple (?:id|account)[^\n]{0,80}?)(\d{6})(?!\d)/i,
      /(?:verification code|验证码)\D{0,24}(\d{6})/i,
    ],
  },
  {
    brands: ['github', 'githubapp'],
    patterns: [/(?:verification|authentication|device activation) code\D{0,24}(\d{6,8})/i],
  },
  {
    brands: ['amazon', 'amazonses', 'awsapps'],
    patterns: [/(?:one[- ]time (?:pass)?code|OTP|verification code)\D{0,24}(\d{4,8})/i],
  },
  {
    brands: ['alipay', 'taobao', 'tmall', 'aliyun', 'alibaba', 'antgroup'],
    patterns: [/(?:校验码|验证码|动态密码|安全码)\D{0,16}(\d{4,8})/],
  },
  {
    brands: ['qq', 'tencent', 'weixin', 'wechat'],
    patterns: [/(?:验证码|校验码|安全码)\D{0,16}(\d{4,8})/],
  },
  {
    brands: ['paypal', 'stripe', 'binance', 'coinbase'],
    patterns: [/(?:security|verification|confirmation) code\D{0,24}(\d{4,8})/i],
  },
]

interface Candidate {
  value: string
  index: number
  score: number
  source: ExtractSource
  reasons: ExtractReason[]
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Replace every match with the same number of spaces.
 *
 * Length-preserving on purpose: every later step reasons about how far a
 * candidate sits from a keyword, and a cleanup pass that shortened the text
 * would silently move those two things closer together or further apart.
 */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (m) => ' '.repeat(m.length))
}

/**
 * Strike out the first capture group of each match, recording what was struck.
 *
 * Also length-preserving, and for the same reason — but unlike `blank` it hands
 * back what it removed, because a number the user can *see was considered and
 * why it lost* is the difference between a tool that made a decision and a tool
 * that appeared to malfunction.
 */
function blankGroup(
  text: string,
  pattern: RegExp,
  reason: ReasonCode,
  struck: CodeAlternative[],
): string {
  pattern.lastIndex = 0
  const chars = [...text]
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text))) {
    const group = m[1] ?? m[0]
    const offset = m[1] != null ? m[0].indexOf(m[1]) : 0
    const at = m.index + (offset < 0 ? 0 : offset)
    for (const run of group.match(/\d{3,8}/g) ?? []) {
      if (!struck.some((s) => s.value === run)) {
        struck.push({ value: run, reasons: [{ code: reason }], eligible: false })
      }
    }
    for (let i = at; i < at + group.length && i < chars.length; i++) chars[i] = ' '
    if (m[0].length === 0) pattern.lastIndex++
  }
  return chars.join('')
}

/**
 * Blank every token that mixes letters and digits — same job the old
 * `MIXED_TOKEN_PATTERN` regex did, but in one linear pass instead of one.
 *
 * The regex it replaced paired two lookaheads with a `{2,}` body: cheap on
 * ordinary mail, but a single attacker-controlled run with no whitespace made
 * the engine retry both lookaheads from every offset in that run, which is
 * quadratic in the run's length (confirmed: ~1.8s on a 40,000-character body
 * that a hostile IMAP message can hand to this function with no user action).
 * A hand-rolled scan classifies each run once — start, end, "has a letter",
 * "has a digit" — and can only ever be linear in the input length.
 */
function blankMixedTokens(text: string): string {
  const chars = [...text]
  let i = 0
  while (i < chars.length) {
    if (!TOKEN_CHAR.test(chars[i])) {
      i++
      continue
    }
    const start = i
    let hasLetter = false
    let hasDigit = false
    while (i < chars.length && TOKEN_CHAR.test(chars[i])) {
      if (LETTER_CHAR.test(chars[i])) hasLetter = true
      else if (DIGIT_CHAR.test(chars[i])) hasDigit = true
      i++
    }
    const boundaryOk = start === 0 || !BOUNDARY_EXCLUDED.test(chars[start - 1])
    if (boundaryOk && hasLetter && hasDigit && i - start >= 2) {
      for (let j = start; j < i; j++) chars[j] = ' '
    }
  }
  return chars.join('')
}

/** `3 9 0 0 8 9` → `390089`, padded back out so offsets keep meaning something. */
function joinSplitDigits(text: string): string {
  return text.replace(SPLIT_DIGITS, (m) => {
    const joined = m.replace(/[   ]/g, '')
    /* Padded on the right so a keyword measured *before* this run keeps its
       distance, which is the direction that decides the score. */
    return joined + ' '.repeat(m.length - joined.length)
  })
}

function scrub(text: string, struck: CodeAlternative[]): string {
  let out = text.replace(ZERO_WIDTH, '')
  // `&nbsp;` survives sanitising and tag-stripping as U+00A0, and an ideographic
  // space as U+3000; neither is `\s` to every engine path below, so both are
  // normalised to a plain space before anything reasons about token boundaries.
  out = out.replace(/[ 　   ]/g, ' ')
  out = joinSplitDigits(out)
  out = blank(out, URL_PATTERN)
  out = blank(out, EMAIL_PATTERN)
  out = blankMixedTokens(out)
  for (const { re, reason } of NEGATIVES) out = blankGroup(out, re, reason, struck)
  return out
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Every keyword hit in `text`, as `[start, end, matched]`, in document order. */
function keywordSpans(text: string, keywords: RegExp[]): Array<[number, number, string]> {
  const spans: Array<[number, number, string]> = []
  for (const re of keywords) {
    // The locale tables carry `g`, so `lastIndex` has to be reset: these are
    // module-level regexes shared by every message on screen.
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      spans.push([m.index, m.index + m[0].length, m[0]])
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return spans.sort((a, b) => a[0] - b[0])
}

/**
 * Score one digit run against the keywords found in the same text.
 *
 * Direction matters more than raw distance. "验证码 482913" and "your code is
 * 615204" both put the code immediately *after* the announcement, so a run
 * sitting just after a keyword is worth far more than one the same distance
 * before it — which is what stops the digits in a greeting line above
 * "验证码" from outscoring the real code below it.
 */
function scoreCandidate(
  value: string,
  index: number,
  spans: Array<[number, number, string]>,
  footerAt: number,
): { score: number; reasons: ExtractReason[] } {
  let score = 0
  const reasons: ExtractReason[] = []

  // Length: six digits is overwhelmingly the house style for these mails.
  if (value.length === 6) {
    score += 3
    reasons.push({ code: 'sixDigits' })
  } else if (value.length === 4 || value.length === 5) score += 1
  else if (value.length === 7) score += 1

  let best = -Infinity
  let bestReason: ExtractReason | null = null
  for (const [start, end, word] of spans) {
    if (index >= end) {
      const gap = index - end
      if (gap <= AFTER_KEYWORD_WINDOW) {
        const points = 9 - Math.floor(gap / 12)
        if (points > best) {
          best = points
          bestReason = { code: 'keywordAfter', detail: word.trim() }
        }
      }
    } else {
      const gap = start - (index + value.length)
      if (gap >= 0 && gap <= BEFORE_KEYWORD_WINDOW) {
        const points = 4 - Math.floor(gap / 12)
        if (points > best) {
          best = points
          bestReason = { code: 'keywordBefore', detail: word.trim() }
        }
      }
    }
  }
  if (best > -Infinity) {
    score += best
    if (bestReason) reasons.push(bestReason)
  } else if (spans.length > 0) {
    // a keyword exists and this run is nowhere near it
    score -= 2
    reasons.push({ code: 'farFromKeyword' })
  }

  // A bare year is the single most common false positive in a footer.
  if (YEAR_LIKE.test(value) && best <= 0) {
    score -= 4
    reasons.push({ code: 'isYear' })
  }

  if (footerAt >= 0 && index > footerAt) {
    score -= 5
    reasons.push({ code: 'inFooter' })
  }

  return { score, reasons }
}

function collect(
  text: string,
  spans: Array<[number, number, string]>,
  source: ExtractSource,
  footerAt: number,
): Candidate[] {
  CODE_PATTERN.lastIndex = 0
  const out: Candidate[] = []
  let m: RegExpExecArray | null
  while ((m = CODE_PATTERN.exec(text))) {
    const value = m[0].replace(/[\s-]/g, '')
    const { score, reasons } = scoreCandidate(value, m.index, spans, footerAt)
    out.push({ value, index: m.index, score, source, reasons })
  }
  return out
}

/** The `CONTEXT_WINDOW` characters before `index`, squashed for comparison. */
function contextBefore(text: string, index: number): string {
  return text
    .slice(Math.max(0, index - CONTEXT_WINDOW), index)
    .replace(/[\s:：>\-—.,]/g, '')
    .toLowerCase()
}

function footerIndex(text: string): number {
  const m = FOOTER_MARKER.exec(text)
  return m ? m.index : -1
}

// ---------------------------------------------------------------------------
// Code extraction
// ---------------------------------------------------------------------------

interface CodeContext {
  fromDomain: string
  rules: CodeRule[]
}

/**
 * The best code candidate plus its runners-up, or `null`.
 *
 * Returning the runners-up is not a hedge. The panel shows one value at a time;
 * what the alternatives buy is that when the shown one is wrong, correcting it
 * is a press rather than a trip back to the mail — and the correction is what
 * teaches the per-sender rule that stops it happening again.
 */
function extractCode(
  subjectRaw: string,
  bodyRaw: string,
  ctx: CodeContext,
): ExtractedCode | null {
  const struck: CodeAlternative[] = []
  const subject = scrub(subjectRaw, struck)
  const body = scrub(bodyRaw, struck)

  const subjectSpans = keywordSpans(subject, CODE_KEYWORDS)
  const bodySpans = keywordSpans(body, CODE_KEYWORDS)
  const hasKeyword = subjectSpans.length > 0 || bodySpans.length > 0
  const bodyFooter = footerIndex(body)

  const rule = ctx.rules.find((r) => r.domain === ctx.fromDomain)
  const template = matchTemplate(ctx.fromDomain, subjectRaw, bodyRaw)

  const pool: Candidate[] = [
    ...collect(subject, subjectSpans, 'subject', -1).map((c) => ({
      // A subject line is far less noisy than a body that may carry a footer
      // full of digits, so an equally-scoring subject candidate wins.
      ...c,
      score: c.score + 1,
      reasons: [...c.reasons, { code: 'inSubject' as const }],
    })),
    ...collect(body, bodySpans, 'body', bodyFooter),
  ]

  /* The template's answer may not even be in the pool — it can sit inside text
     the scrubber blanked, which is exactly the case a template exists for. */
  if (template && !pool.some((c) => c.value === template)) {
    pool.push({
      value: template,
      index: 0,
      score: 0,
      source: 'body',
      reasons: [],
    })
  }

  for (const candidate of pool) {
    if (template && candidate.value === template) {
      candidate.score += 12
      candidate.reasons.push({ code: 'senderTemplate', detail: ctx.fromDomain })
    }
    if (rule?.preferContext?.length) {
      const text = candidate.source === 'subject' ? subject : body
      const run = contextBefore(text, candidate.index)
      if (run && rule.preferContext.some((p) => p && run.endsWith(p))) {
        candidate.score += 10
        candidate.reasons.push({ code: 'userPreferred', detail: ctx.fromDomain })
      }
    }
  }

  /* User rejections are removed rather than penalised: the user did not say
     "this is unlikely", they said "this is not it". */
  const rejected: CodeAlternative[] = []
  let eligible = pool
  if (rule?.reject?.length) {
    eligible = []
    for (const candidate of pool) {
      if (rule.reject.includes(candidate.value)) {
        rejected.push({
          value: candidate.value,
          reasons: [{ code: 'userRejected', detail: ctx.fromDomain }],
          eligible: false,
        })
      } else eligible.push(candidate)
    }
  }

  eligible.sort((a, b) => b.score - a.score || a.index - b.index)

  const winner = pickWinner(eligible, { hasKeyword, hasTemplate: template != null, body })
  if (!winner) return null

  const alternatives: CodeAlternative[] = [
    ...eligible
      .filter((c) => c !== winner && c.value !== winner.value)
      .slice(0, 3)
      .map((c) => ({
        value: c.value,
        reasons: c.score > 0 ? c.reasons : [...c.reasons, { code: 'lowScore' as const }],
        eligible: c.score > 0,
      })),
    ...rejected,
    ...struck.filter((s) => s.value !== winner.value).slice(0, 4),
  ]

  return {
    kind: 'code',
    value: winner.value,
    confidence: winner.score >= 8 ? 'high' : winner.score >= 4 ? 'medium' : 'low',
    source: winner.source,
    reasons: winner.reasons,
    alternatives,
    validity: parseValidity(`${subjectRaw}\n${bodyRaw}`) ?? undefined,
  }
}

/**
 * B3 — the gate between "I found something" and "I am willing to say it".
 *
 * The keyword-free path is where `98052` came from, so it is now the most
 * demanding path in the file rather than the most permissive: short body, six
 * digits, exactly one contender, nothing else on the page that could be it.
 * A verification code that this refuses to show costs one trip to the mail; a
 * wrong one shown confidently costs a failed login and a lost minute working
 * out why, and the second is worse.
 */
function pickWinner(
  pool: Candidate[],
  opts: { hasKeyword: boolean; hasTemplate: boolean; body: string },
): Candidate | null {
  if (pool.length === 0) return null

  if (opts.hasTemplate) {
    const best = pool[0]
    return best.score > 0 ? best : null
  }

  if (opts.hasKeyword) {
    const best = pool[0]
    // A keyword was present but nothing near it survived: say nothing rather
    // than hand back the least-bad number on the page.
    return best.score > 0 ? best : null
  }

  // No keyword and no template. Everything below is a reason to stay quiet.
  if (opts.body.length > 300) return null
  const contenders = pool.filter((c) => c.value.length === 6 && !YEAR_LIKE.test(c.value))
  if (contenders.length !== 1) return null
  /* One six-digit number in a short body with no announcement at all is a
     plausible code and nothing more, so it is never reported as certain. */
  const only = contenders[0]
  return {
    ...only,
    score: 5,
    reasons: [...only.reasons.filter((r) => r.code !== 'farFromKeyword'), { code: 'onlyNumber' }],
  }
}

function matchTemplate(fromDomain: string, subject: string, body: string): string | null {
  if (!fromDomain) return null
  const brand = fromDomain.split('.')[0]
  const entry = SENDER_TEMPLATES.find((t) => t.brands.includes(brand))
  if (!entry) return null
  const text = `${subject}\n${body}`
  for (const re of entry.patterns) {
    const m = re.exec(text)
    if (m?.[1]) return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

function hasKeywordIn(text: string, keywords: RegExp[]): boolean {
  return keywords.some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })
}

/**
 * The single best link candidate, now carrying what it is *for*.
 *
 * URLs are pulled from anchor `href`s when available (passed in separately,
 * already extracted from the sanitized DOM by the caller) so this never has to
 * regex raw HTML for a `href="..."`.
 */
function extractLink(
  subject: string,
  body: string,
  links: MailLink[],
  from: string,
): ExtractedLink | null {
  const textHasKeyword = hasKeywordIn(subject, LINK_KEYWORDS) || hasKeywordIn(body, LINK_KEYWORDS)

  let best: { link: MailLink; analysis: LinkAnalysis; score: number; reasons: ExtractReason[] } | null = null
  const others: CodeAlternative[] = []

  for (const link of links) {
    const analysis = analyzeLink(link.url, {
      anchorText: link.text,
      from,
      subject,
      body,
    })
    if (!analysis) continue

    let score = 0
    const reasons: ExtractReason[] = []
    if (LINK_PATH_HINT.test(link.url)) score += 2
    if (LINK_QUERY_HINT.test(link.url)) score += 2
    if (textHasKeyword) score += 1
    /* A classified purpose is worth more than either raw hint: it is what the
       card will actually say, and an unclassifiable link has nothing to say. */
    if (analysis.purpose !== 'unknown' && analysis.purpose !== 'tracking') {
      score += analysis.purposeConfidence === 'high' ? 3 : analysis.purposeConfidence === 'medium' ? 2 : 1
      reasons.push({ code: 'senderTemplate', detail: analysis.purpose })
    }
    /* An unsubscribe or a tracking pixel is a link, but never *the* link. */
    if (analysis.purpose === 'unsubscribe' || analysis.purpose === 'tracking') score -= 4

    if (score <= 0) continue
    if (!best || score > best.score) {
      if (best) others.push({ value: best.link.url, reasons: best.reasons, eligible: true })
      best = { link, analysis, score, reasons }
    } else {
      others.push({ value: link.url, reasons, eligible: true })
    }
  }
  if (!best) return null

  return {
    kind: 'link',
    value: best.link.url,
    confidence: best.score >= 5 ? 'high' : best.score >= 3 ? 'medium' : 'low',
    source: 'link',
    reasons: best.reasons,
    alternatives: others.slice(0, 3),
    analysis: best.analysis,
    anchorText: best.link.text?.trim() || undefined,
    validity: parseValidity(`${subject}\n${body}`) ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ExtractInput {
  subject: string
  bodyText: string
  links?: MailLink[]
  /** The `From` header, verbatim — templates and off-site detection need it. */
  from?: string
  /** Corrections the user has already made, from settings (B8). */
  rules?: CodeRule[]
}

/**
 * A code or link is always near the top of a real mail, so the rest of an
 * unusually long body buys nothing but CPU time — capped as a second,
 * independent backstop alongside the linear rewrite above, not a substitute
 * for it: this bounds every regex in `scrub`/`NEGATIVES`, not just the one
 * that was proven quadratic.
 */
const MAX_EXTRACT_BODY = 64 * 1024

function capBody(bodyText: string): string {
  return bodyText.length > MAX_EXTRACT_BODY ? bodyText.slice(0, MAX_EXTRACT_BODY) : bodyText
}

/**
 * Extract both a code and a link from one message when present — a message
 * legitimately containing both (common: "your code is 482913, or click to
 * sign in") must surface both rather than picking whichever regex matched
 * first, which would be exactly the silent-failure pattern this app exists
 * to avoid.
 */
export function extractFromMessage(input: ExtractInput): Extracted[] {
  const { subject, links = [], from = '', rules = [] } = input
  const bodyText = capBody(input.bodyText)
  const out: Extracted[] = []
  const code = extractCode(subject, bodyText, {
    fromDomain: from ? senderDomain(from) : '',
    rules,
  })
  if (code) out.push(code)
  const link = extractLink(subject, bodyText, links, from)
  if (link) out.push(link)
  return out
}

/**
 * Pull `href` values *and their anchor text* out of already-sanitized HTML.
 *
 * No script execution risk — this is a plain regex over trusted (post-sanitize)
 * markup. The text matters as much as the target: for a wrapped link whose URL
 * is forty characters of tracking id, "Reset your password" written on the
 * button is the only thing in the message that says what it does.
 */
export function linksFromSanitizedHtml(html: string): MailLink[] {
  const out: MailLink[] = []
  const re = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (!/^https?:\/\//i.test(m[1])) continue
    const text = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim()
    out.push({ url: m[1], text: text || undefined })
  }
  return out
}

/**
 * Fold a user's correction into the stored rules (B8).
 *
 * `preferContext` is captured from the mail the correction was made in, which
 * is why this takes the body rather than just the two values: remembering only
 * "not 98052, yes 390089" would be useless next month when the code is
 * different, whereas "the number right after 你的代码如下" keeps working.
 */
export function learnRule(
  rules: CodeRule[],
  input: { from: string; rejected?: string; preferred?: string; bodyText?: string },
): CodeRule[] {
  const domain = senderDomain(input.from)
  if (!domain) return rules
  const next: CodeRule[] = rules.map((r) => ({
    ...r,
    reject: r.reject ? [...r.reject] : undefined,
    preferContext: r.preferContext ? [...r.preferContext] : undefined,
  }))
  const existing = next.find((r) => r.domain === domain)
  const rule: CodeRule = existing ?? { domain }
  if (!existing) next.push(rule)
  if (input.rejected) {
    rule.reject = [...new Set([...(rule.reject ?? []), input.rejected])].slice(-12)
  }
  if (input.preferred && input.bodyText) {
    const struck: CodeAlternative[] = []
    const body = scrub(capBody(input.bodyText), struck)
    const at = body.indexOf(input.preferred)
    if (at > 0) {
      const run = contextBefore(body, at)
      if (run.length >= 3) {
        rule.preferContext = [...new Set([...(rule.preferContext ?? []), run])].slice(-6)
      }
    }
  }
  return next
}

export { registrableDomain, senderDomain }
export type { LinkAnalysis, Validity }
