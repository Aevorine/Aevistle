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
 */

export type ExtractConfidence = 'high' | 'medium' | 'low'

/** Where the winning candidate was found, so a wrong answer is explainable. */
export type ExtractSource = 'subject' | 'body' | 'link'

export interface ExtractedCode {
  kind: 'code'
  value: string
  confidence: ExtractConfidence
  source: ExtractSource
}

export interface ExtractedLink {
  kind: 'link'
  value: string
  confidence: ExtractConfidence
  source: ExtractSource
}

export type Extracted = ExtractedCode | ExtractedLink

/** One keyword set per supported locale (see `src/i18n`), matched case-insensitively. */
const CODE_KEYWORDS = [
  /verification code|passcode|access code|security code|one-time code|one time password|\bOTP\b|your code is|code is/gi,
  /验证码|校验码|动态码|安全码/g,
  /code de vérification|code de confirmation/gi,
  /código de verificación|código de confirmación/gi,
  /код подтверждения|проверочный код/gi,
  /رمز التحقق|رمز التأكيد/g,
]

const LINK_KEYWORDS = [
  /verify your (email|account)|confirm your (email|account)|sign in|log ?in|activate/i,
  /登录|登陆|验证邮箱|确认账号|激活/,
  /vérifiez votre|confirmez votre|se connecter/i,
  /verifica tu|confirma tu|iniciar sesión/i,
  /подтвердите|войти в систему/i,
  /تحقق من|قم بتأكيد|تسجيل الدخول/,
]

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
 * Requiring the run to be a *standalone token* — no word character, `@`, `.`
 * or `-` on either side — closes that off at the source, independently of
 * whether any earlier cleanup step recognised the surrounding text.
 */
const CODE_PATTERN = /(?<![\w@.\-])(\d{3}[\s-]?\d{3}|\d{4,8})(?![\w@.\-])/g

/** Blanked before searching, so a URL's query string can never donate a code. */
const URL_PATTERN = /https?:\/\/\S+/gi

/**
 * Deliberately looser than `isValidAddress`: this runs over text recovered by
 * stripping tags out of HTML, where `jane<span>@</span>example.com` arrives as
 * `jane @ example.com`. Tolerating the stray spaces is what keeps such an
 * address recognisable as one.
 */
const EMAIL_PATTERN = /[a-z0-9][a-z0-9._%+-]*\s*@\s*[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)+/gi

/**
 * Any token that mixes letters and digits — `someone1234`, `ID20250811`,
 * `order7788x`. A verification code is always digits only, so a token with a
 * letter in it can be removed wholesale rather than reasoned about.
 */
const MIXED_TOKEN_PATTERN = /(?<![\w@.\-])(?=[^\s]*[a-z])(?=[^\s]*\d)[a-z0-9._%+-]{2,}/gi

/** Years read as four-digit codes; only accepted when a keyword vouches for them. */
const YEAR_LIKE = /^(19|20)\d{2}$/

const LINK_PATH_HINT = /verify|confirm|activate|magic-?link|auth|sso|login|signin/i
const LINK_QUERY_HINT = /[?&](token|code|otp|verify|confirm|t)=/i

/** How far after a keyword a code still counts as "the code that keyword announced". */
const AFTER_KEYWORD_WINDOW = 48
/** Codes *before* the keyword ("482913 is your verification code") are rarer but real. */
const BEFORE_KEYWORD_WINDOW = 24

interface Candidate {
  value: string
  index: number
  score: number
}

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

function scrub(text: string): string {
  let out = text.replace(/ /g, ' ')
  // `&nbsp;` survives sanitising and tag-stripping as U+00A0, and an ideographic
  // space as U+3000; neither is `\s` to every engine path below, so both are
  // normalised to a plain space before anything reasons about token boundaries.
  out = out.replace(/[ 　  ]/g, ' ')
  out = blank(out, URL_PATTERN)
  out = blank(out, EMAIL_PATTERN)
  out = blank(out, MIXED_TOKEN_PATTERN)
  return out
}

/** Every keyword hit in `text`, as `[start, end]` pairs, in document order. */
function keywordSpans(text: string, keywords: RegExp[]): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const re of keywords) {
    // The locale tables carry `g`, so `lastIndex` has to be reset: these are
    // module-level regexes shared by every message on screen.
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      spans.push([m.index, m.index + m[0].length])
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
function scoreCandidate(value: string, index: number, spans: Array<[number, number]>): number {
  let score = 0

  // Length: six digits is overwhelmingly the house style for these mails.
  if (value.length === 6) score += 3
  else if (value.length === 4 || value.length === 5) score += 1
  else if (value.length === 7) score += 1

  let best = -Infinity
  for (const [start, end] of spans) {
    if (index >= end) {
      const gap = index - end
      if (gap <= AFTER_KEYWORD_WINDOW) best = Math.max(best, 9 - Math.floor(gap / 12))
    } else {
      const gap = start - (index + value.length)
      if (gap >= 0 && gap <= BEFORE_KEYWORD_WINDOW) best = Math.max(best, 4 - Math.floor(gap / 12))
    }
  }
  if (best > -Infinity) score += best
  else if (spans.length > 0) score -= 2 // a keyword exists and this run is nowhere near it

  // A bare year is the single most common false positive in a footer.
  if (YEAR_LIKE.test(value) && best <= 0) score -= 4

  return score
}

function collect(text: string, spans: Array<[number, number]>): Candidate[] {
  CODE_PATTERN.lastIndex = 0
  const out: Candidate[] = []
  let m: RegExpExecArray | null
  while ((m = CODE_PATTERN.exec(text))) {
    const value = m[0].replace(/[\s-]/g, '')
    out.push({ value, index: m.index, score: scoreCandidate(value, m.index, spans) })
  }
  return out
}

/**
 * The single best code candidate, or `null`. Only one is kept per message —
 * a footer with three unrelated numbers should not flood the panel.
 */
function extractCode(subjectRaw: string, bodyRaw: string): ExtractedCode | null {
  const subject = scrub(subjectRaw)
  const body = scrub(bodyRaw)

  const subjectSpans = keywordSpans(subject, CODE_KEYWORDS)
  const bodySpans = keywordSpans(body, CODE_KEYWORDS)
  const hasKeyword = subjectSpans.length > 0 || bodySpans.length > 0

  if (hasKeyword) {
    // A subject line is far less noisy than a body that may carry a footer
    // full of digits, so an equally-scoring subject candidate wins.
    const pool: Array<Candidate & { source: ExtractSource }> = [
      ...collect(subject, subjectSpans).map((c) => ({ ...c, score: c.score + 1, source: 'subject' as const })),
      ...collect(body, bodySpans).map((c) => ({ ...c, source: 'body' as const })),
    ]
    let best: (Candidate & { source: ExtractSource }) | null = null
    for (const c of pool) {
      if (c.score <= 0) continue
      if (!best || c.score > best.score || (c.score === best.score && c.index < best.index)) best = c
    }
    if (best) {
      return {
        kind: 'code',
        value: best.value,
        confidence: best.score >= 8 ? 'high' : best.score >= 4 ? 'medium' : 'low',
        source: best.source,
      }
    }
    // A keyword was present but nothing near it survived: say nothing rather
    // than hand back the least-bad number on the page.
    return null
  }

  // No keyword anywhere: a bare digit group is only worth surfacing from a
  // short, transactional-looking message — a long newsletter with a stray
  // 6-digit number is not a verification code.
  if (body.length > 600) return null
  const bare = collect(body, [])
  if (bare.length === 1 && !YEAR_LIKE.test(bare[0].value)) {
    return { kind: 'code', value: bare[0].value, confidence: 'medium', source: 'body' }
  }
  return null
}

function hasKeyword(text: string, keywords: RegExp[]): boolean {
  return keywords.some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })
}

/**
 * The single best link candidate. URLs are pulled from anchor `href`s when
 * available (passed in separately, already extracted from the sanitized DOM
 * by the caller) so this never has to regex raw HTML for a `href="..."`.
 */
function extractLink(subject: string, body: string, links: string[]): ExtractedLink | null {
  const textHasKeyword = hasKeyword(subject, LINK_KEYWORDS) || hasKeyword(body, LINK_KEYWORDS)

  let best: { url: string; score: number } | null = null
  for (const url of links) {
    let score = 0
    if (LINK_PATH_HINT.test(url)) score += 2
    if (LINK_QUERY_HINT.test(url)) score += 2
    if (textHasKeyword) score += 1
    if (score === 0) continue
    if (!best || score > best.score) best = { url, score }
  }
  if (!best) return null

  const confidence: ExtractConfidence = best.score >= 3 ? 'high' : best.score >= 2 ? 'medium' : 'low'
  return { kind: 'link', value: best.url, confidence, source: 'link' }
}

/**
 * Extract both a code and a link from one message when present — a message
 * legitimately containing both (common: "your code is 482913, or click to
 * sign in") must surface both rather than picking whichever regex matched
 * first, which would be exactly the silent-failure pattern this app exists
 * to avoid.
 */
export function extractFromMessage(
  subject: string,
  bodyText: string,
  links: string[] = [],
): Extracted[] {
  const out: Extracted[] = []
  const code = extractCode(subject, bodyText)
  if (code) out.push(code)
  const link = extractLink(subject, bodyText, links)
  if (link) out.push(link)
  return out
}

/** Pull `href` values out of already-sanitized HTML — no script execution risk, this is a plain regex over trusted (post-sanitize) markup. */
export function linksFromSanitizedHtml(html: string): string[] {
  const out: string[] = []
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (/^https?:\/\//i.test(m[1])) out.push(m[1])
  }
  return out
}
