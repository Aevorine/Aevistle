/**
 * Meeting / deadline extraction — "收件箱 → 日历".
 *
 * Finds the moment a received message is *about*, so the inbox card can offer
 * one press that turns it into a scheduled reminder. Same layer, same reasons,
 * and the same hard-won shape as `codeExtract.ts`: a keyword table per language,
 * scoring by proximity to a keyword, everything that provably is not a date
 * struck out *before* anything is scored, a keyword-free fallback that is the
 * most demanding path in the file rather than the most permissive, and evidence
 * carried on every hit so the card can justify itself.
 *
 * ---------------------------------------------------------------------------
 * Why this file is shaped the way it is
 *
 * 1. **The calendar part wins, always.** A real invitation arrives as a
 *    `text/calendar` MIME part, and `parseIcs` reads a `DTSTART` that the
 *    sending calendar wrote on purpose — including its time zone. Reading the
 *    prose of the same mail is guessing at something already stated exactly.
 *    So `icsParts` short-circuits the whole prose path; prose is the fallback.
 *
 * 2. **`receivedAt` is the anchor, never `Date.now()`.** "Tomorrow at 3" in a
 *    mail read on Thursday means the day after it was *sent*, not the day after
 *    it was opened. This is the same class of bug as using `formatRelative` on
 *    a past instant (PROJECT-BRIEF §4): one function that reads the clock at the
 *    wrong moment, and every result is quietly off by the reading delay. There
 *    is deliberately no default for `receivedAt`.
 *
 * 3. **The strike-out pass exists because of `98052`.** A verification code
 *    feature once showed a Microsoft postcode. The dates equivalent is worse,
 *    because there are far more number shapes that read as a date than as a
 *    six-digit code: `v2.10.3`, `24/7`, `192.168.1.100`, `$1,299.00`, an order
 *    number, a tracking number, a copyright year, and the `Sent: ...` header of
 *    a forwarded mail — which is a real date, correctly parsed, and completely
 *    the wrong answer. Every one of those is struck out, length-preservingly,
 *    before a single candidate is scored.
 *
 * 4. **Silence is a good answer.** A missed meeting date costs one read of the
 *    mail. A wrong one costs a reminder that fires on the wrong day and a
 *    meeting attended at the wrong time, which is exactly the failure this app
 *    exists to prevent. `scripts/check-date-extract.mjs` encodes that: a false
 *    positive fails the build, a false negative only reports.
 *
 * ---------------------------------------------------------------------------
 * The date-order decision — `03/04/2026`
 *
 * 3 April in most of the world, 4 March in the United States, and nothing in
 * the string itself says which. The rule, in order, and each step is only taken
 * when the one above it could not decide:
 *
 *   1. **ISO wins outright.** `2026-04-03` is year-month-day everywhere.
 *   2. **A component over 12 forces the reading.** `13/04/2026` is 13 April;
 *      `04/13/2026` is 13 April too. No locale involved.
 *   3. **A named weekday next to it decides it.** "Tuesday, 03/04/2026" is
 *      readable without knowing where the sender lives: only one of the two
 *      readings actually falls on a Tuesday. This is the only step that turns
 *      an ambiguous pair into a *high*-confidence answer.
 *   4. **A dot separator means day-first.** `3.4.2026` is the European/Russian
 *      spelling; the US uses slashes. Confidence capped at medium.
 *   5. **The locale's region subtag.** `detectLocale()` in `src/i18n/index.ts`
 *      collapses every English tag to `en`, so this module takes the *raw*
 *      BCP-47 string the platform reported instead (`navigator.language`,
 *      `en-US`, `zh-CN`) and reads its region: US/PH/FM/MH/PW → month-first,
 *      any other region → day-first. Confidence capped at medium.
 *   6. **Language.** `zh`/`ja`/`ko` write 年/月/日 widest-unit-first, so a bare
 *      pair is month-first *whatever* the region says — this one is checked
 *      before step 5, since `zh-CN` is certainly not day-first. `fr`/`es`/`ru`/
 *      `ar` with no region are day-first.
 *   7. **Bare `en` — undecided.** This is the honest end of the road: `en` is
 *      the tag both `en-US` and `en-GB` arrive as, and picking one is a coin
 *      flip. The pair is read day-first *and* the hit is forced to `low`
 *      confidence, whatever else it scored, so the card can say the order was
 *      not established rather than presenting a guess as a fact.
 *
 * A slash/dot date with no year at all (`3/4`) is never a date here. Requiring
 * the year is what makes `24/7`, `3/5 stars` and a page count harmless without
 * needing to recognise any of them.
 *
 * ---------------------------------------------------------------------------
 * Other decisions worth stating once
 *
 * - **"Next Monday" is the Monday of the following week.** Unambiguous for
 *   `下周一`, `lundi prochain`, `в следующий понедельник`; genuinely contested in
 *   English, where many speakers mean the coming Monday. So the English reading
 *   of `next` is capped at medium confidence and the bare weekday ("on Monday")
 *   always means the next one to come round.
 * - **All-day means local midnight.** `at` is the start of the day, not noon
 *   and not 23:59, so a reminder built from a deadline fires at the start of the
 *   day it is due rather than after it has passed.
 * - **A named zone abbreviation lowers confidence.** `14:00 CET` is resolved as
 *   local wall time, because shipping an abbreviation→zone table (of which
 *   several are ambiguous) to save one tier of confidence is not worth it. An
 *   explicit numeric offset (`14:00 UTC+8`, `12:00Z`) *is* honoured exactly.
 * - **No user-facing prose.** Everything returned is structured or is a verbatim
 *   slice of the message; the card supplies the wording in the user's language.
 */

import { parseIcs, parseProperty, unfoldLines } from './ics'

export type DateHitKind = 'invitation' | 'meeting' | 'deadline' | 'appointment'

export interface DateHit {
  /** Resolved absolute instant, local. */
  at: number
  allDay: boolean
  kind: DateHitKind
  confidence: 'high' | 'medium' | 'low'
  /** The text this came from, for the card that has to justify itself. */
  evidence: { snippet: string; matched: string; keyword?: string }
  title?: string
  location?: string
}

export interface DateExtractInput {
  subject: string
  /** Plain text; HTML has already been converted upstream. */
  body: string
  /** The anchor for every relative phrase. Never defaulted. */
  receivedAt: number
  /** Raw `text/calendar` bodies, when the message had any. */
  icsParts?: string[]
  /**
   * The platform's own language tag, *not* the app's `LocaleId`. See the
   * date-order rule above: `detectLocale()` throws the region away, and the
   * region is the only thing that decides `03/04`.
   */
  locale?: string
}

/** Most hits a single message can produce. Beyond this it is a newsletter. */
const MAX_HITS = 4

/** How far in the past a resolved instant may sit before it is refused. */
const PAST_TOLERANCE_MS = 2 * 86_400_000
/** And how far ahead. A "meeting" in 2031 is a misparse, not an invitation. */
const FUTURE_LIMIT_MS = 400 * 86_400_000

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Removed outright: they exist to be invisible, and they split numbers. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g

/**
 * Every cleanup below is length-preserving, for the same reason as in
 * `codeExtract.ts`: the whole scoring model is "how far is this from the word
 * that announced it", and a pass that shortened the text would silently move
 * those two things together.
 */
function normalize(text: string): string {
  return text
    .replace(ZERO_WIDTH, '')
    .replace(/[ 　   ]/g, ' ')
    // Arabic-Indic and extended Arabic-Indic digits, one char for one char.
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    // Fullwidth digits and the fullwidth colon, which CJK mail is full of.
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

/** Replace every match with the same number of spaces. */
function blank(text: string, pattern: RegExp): string {
  pattern.lastIndex = 0
  return text.replace(pattern, (m) => ' '.repeat(m.length))
}

/**
 * Digits and dates that provably belong to something that is not an
 * appointment. Each pattern is written to cover *only what must disappear*.
 *
 * The forwarded-header entries are the subtle ones. `Sent: Mon, 3 Mar 2026
 * 10:04:11 +0800` parses perfectly as a date — it is simply the wrong date,
 * being when the mail below was written rather than when anything is happening.
 * Same for a `>`-quoted reply. Those are struck rather than penalised because
 * no amount of proximity scoring can rescue a correct answer to the wrong
 * question.
 */
const NEGATIVES: RegExp[] = [
  // Anything inside a URL or an address. Query strings are full of dates.
  /https?:\/\/\S+/gi,
  /[a-z0-9][a-z0-9._%+-]*\s*@\s*[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)+/gi,
  // Version numbers, declared or bare. A dotted date needs a four-digit year
  // (see the header), so a dotted triple with none is always a version.
  /\b(?:v|ver|version|build|rev|版本|версия|versi[oó]n)\.?\s*\d+(?:\.\d+){1,3}\b/gi,
  /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,4}(?![\d.])/g,
  // IPv4, which is the same shape as the above but worth its own line.
  /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g,
  // "24/7", "24x7", "7/24" — a slash between small numbers with no year.
  /\b(?:24\s*[/x×]\s*7|7\s*[/x×]\s*24)\b/gi,
  // Prices and percentages.
  /[$¥€£₽﷼]\s*[\d,]+(?:\.\d+)?/g,
  /[\d,]+(?:\.\d+)?\s*(?:元|美元|人民币|USD|CNY|RMB|EUR|GBP|RUB|руб\.?|SAR)\b/gi,
  /\d+(?:\.\d+)?\s*%/g,
  // Order / invoice / tracking / reference numbers, in every locale's wording.
  /(?:order|invoice|receipt|ticket|reference|ref|tracking|awb|case|policy|account)\s*(?:number|no\.?|#|id)?\s*[:#]?\s*[A-Z0-9][A-Z0-9._/-]{4,}/gi,
  /(?:订单|发票|运单|快递单|工单|流水|参考|凭证)\s*(?:号码?|编号)?\s*[:：#]?\s*[A-Z0-9][A-Z0-9._/-]{4,}/gi,
  /(?:num[ée]ro de commande|n° de commande|n[uú]mero de pedido|номер заказа|رقم الطلب)\s*[:：#]?\s*[A-Z0-9][A-Z0-9._/-]{4,}/gi,
  // A bare tracking-number shape: long alphanumeric run with digits in it.
  /(?<![\w@.-])(?=[A-Z0-9-]*\d)[A-Z]{2,4}[0-9][A-Z0-9-]{7,}(?![\w@.-])/g,
  // Copyright years.
  /(?:©|\(c\)|copyright|版权所有)\s*\d{4}(?:\s*[-–—]\s*\d{4})?/gi,
  /\d{4}(?:\s*[-–—]\s*\d{4})?\s*(?:©|\(c\))/g,
  // Phone numbers, announced or bare.
  /(?:电话|热线|客服|专线|传真|手机|Tel|Phone|Fax|Hotline|Mobile|T[ée]l|Tlf|Телефон|هاتف)\s*[:：]?\s*[\d\-\s()+]{7,20}/gi,
  /(?<![\w@.-])\+?\d{1,3}[-\s]?\(?\d{3}\)?[-\s]\d{3,4}[-\s]\d{4}(?![\w@.-])/g,
  // A machine-written ISO timestamp. Real prose does not say `T14:00:00Z`;
  // log lines, Message-IDs and quoted headers do.
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  // The header block of a forwarded or replied-to message, in six languages.
  /^[ \t]*(?:Date|Sent|Received|On|From|To|Subject|发件人|收件人|发送时间|日期|主题|De|Envoy[ée]|Le|Para|Enviado|El|От|Кому|Отправлено|Дата|من|إلى|بتاريخ)[ \t]*:.*$/gim,
  /\bOn\b[^\n]{0,80}?\bwrote:/gi,
  /(?:在|于)[^\n]{0,40}?(?:写道|发来|发送)[:：]/g,
  // Quoted lines. Everything after a `>` at the start of a line is somebody
  // else's mail, and its dates belong to that mail.
  /^[ \t]*>.*$/gm,
]

/**
 * Where the mail stops talking to you and starts talking to the lawyers.
 *
 * A penalty, not a deletion — an unsubscribe footer is a normal place for a
 * legitimate date to appear *near* ("you can change these settings any time"),
 * so the number stays in play and simply cannot win on its own.
 */
const FOOTER_MARKER =
  /privacy (?:statement|policy|notice)|terms of (?:use|service)|all rights reserved|unsubscribe|manage (?:your )?preferences|you (?:are )?receiv\w+ this|this (?:is an|email was) automat|隐私(?:声明|政策)|服务条款|版权所有|保留所有权利|退订|本邮件由系统自动发送|请勿回复|se d[ée]sabonner|politique de confidentialit[ée]|darse de baja|aviso de privacidad|отписаться|политика конфиденциальности|إلغاء الاشتراك|سياسة الخصوصية/i

function scrub(text: string): string {
  let out = normalize(text)
  for (const re of NEGATIVES) out = blank(out, re)
  return out
}

// ---------------------------------------------------------------------------
// Keyword tables — one set per supported locale (see `src/i18n`)
// ---------------------------------------------------------------------------

/**
 * Wide on purpose, for exactly the reason the code table is: a message with no
 * recognised keyword does not merely score lower, it falls into the deliberately
 * timid keyword-free path below and almost certainly says nothing at all.
 *
 * The `kind` a keyword carries is what the card will offer to create, so
 * `deadline` words are kept separate from `meeting` words even where a language
 * uses one phrase for both.
 */
const KEYWORDS: Array<{ kind: DateHitKind; re: RegExp }> = [
  {
    kind: 'invitation',
    re: /\b(?:invitation|invited you|invites? you|calendar invite|has invited)\b|邀请(?:您|你)?参加|会议邀请|invitation à|vous invite|invitación|te invita|приглашение|приглашае[тм]|دعوة (?:لحضور|إلى)|يدعوك/gi,
  },
  {
    kind: 'meeting',
    re: /\b(?:meeting|meet|call|conference|webinar|workshop|briefing|stand-?up|sync|kick-?off|review|1:1|catch-?up|session|seminar|agenda)\b|会议|开会|例会|周会|评审会?|研讨会|讨论会|视频会议|电话会议|线上会议|腾讯会议|飞书会议|议程|r[ée]union|conf[ée]rence|visioconf[ée]rence|point d'[ée]quipe|ordre du jour|reuni[oó]n|junta|videollamada|llamada|orden del d[ií]a|встреч[аиуе]|совещани[ея]|созвон|конференц|повестк[аи]|اجتماع|مكالمة|ندوة|جلسة|جدول الأعمال/gi,
  },
  {
    kind: 'deadline',
    re: /\b(?:deadline|due date|due by|due on|due in|is due|submit by|submission|closes? on|closing date|last day|expires? on|cut-?off|rsvp by|respond by|reply by)\b|截止(?:日期|时间|前)?|截止|期限|最迟|最晚|到期(?:日|时间)?|提交(?:截止|期限)|交稿|归还日期|date limite|[ée]ch[ée]ance|dernier d[ée]lai|à rendre|avant le|fecha l[ií]mite|plazo(?: l[ií]mite)?|vence el|fecha de vencimiento|antes del|срок(?:и|а)? (?:сдачи|подачи|действия)?|крайний срок|дедлайн|не позднее|истекает|الموعد النهائي|آخر موعد|آخر أجل|تنتهي (?:صلاحية|المهلة)|الموعد الأقصى/gi,
  },
  {
    kind: 'appointment',
    re: /\b(?:appointment|booking|reservation|reserved for|your visit|consultation|interview|check-?in|check-?up)\b|预约|预定|预订|面试|面谈|门诊|就诊|体检|办理时间|rendez-vous|consultation|entretien|r[ée]servation|cita(?: previa)?|reserva|entrevista|консультаци|запись на|приём|бронировани|собеседовани|موعد(?: طبي)?|حجز|مقابلة|استشارة/gi,
  },
]

/** How far after a keyword a date still counts as the date it announced. */
const AFTER_KEYWORD_WINDOW = 72
/** Dates *before* the keyword ("3 March, project deadline") are rarer but real. */
const BEFORE_KEYWORD_WINDOW = 40

interface KeywordSpan {
  start: number
  end: number
  word: string
  kind: DateHitKind
}

function keywordSpans(text: string): KeywordSpan[] {
  const spans: KeywordSpan[] = []
  for (const { kind, re } of KEYWORDS) {
    // Module-level regexes with `g` are shared by every message on screen.
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      spans.push({ start: m.index, end: m.index + m[0].length, word: m[0].trim(), kind })
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

// ---------------------------------------------------------------------------
// Vocabulary: months, weekdays, numerals
// ---------------------------------------------------------------------------

const MONTH_TOKENS: Record<string, number> = {}

function addMonths(names: string[][]): void {
  for (const [index, group] of names.entries()) {
    for (const name of group) MONTH_TOKENS[name.toLowerCase()] = index
  }
}

addMonths([
  ['january', 'jan', 'janvier', 'janv', 'enero', 'ene', 'января', 'январь', 'янв', 'يناير', 'كانون الثاني'],
  ['february', 'feb', 'février', 'fevrier', 'févr', 'fevr', 'febrero', 'feb', 'февраля', 'февраль', 'фев', 'فبراير', 'شباط'],
  ['march', 'mar', 'mars', 'marzo', 'марта', 'март', 'مارس', 'آذار'],
  ['april', 'apr', 'avril', 'abril', 'abr', 'апреля', 'апрель', 'апр', 'أبريل', 'إبريل', 'نيسان'],
  ['may', 'mai', 'mayo', 'мая', 'май', 'مايو', 'أيار'],
  ['june', 'jun', 'juin', 'junio', 'июня', 'июнь', 'июн', 'يونيو', 'حزيران'],
  ['july', 'jul', 'juillet', 'juil', 'julio', 'июля', 'июль', 'июл', 'يوليو', 'تموز'],
  ['august', 'aug', 'août', 'aout', 'agosto', 'ago', 'августа', 'август', 'авг', 'أغسطس', 'آب'],
  ['september', 'sep', 'sept', 'septembre', 'septiembre', 'setiembre', 'сентября', 'сентябрь', 'сен', 'سبتمبر', 'أيلول'],
  ['october', 'oct', 'octobre', 'octubre', 'октября', 'октябрь', 'окт', 'أكتوبر', 'تشرين الأول'],
  ['november', 'nov', 'novembre', 'noviembre', 'ноября', 'ноябрь', 'ноя', 'نوفمبر', 'تشرين الثاني'],
  ['december', 'dec', 'décembre', 'decembre', 'déc', 'diciembre', 'dic', 'декабря', 'декабрь', 'дек', 'ديسمبر', 'كانون الأول'],
])

/** Longest first, so `sept` cannot be eaten by `sep`. */
const MONTH_ALT = Object.keys(MONTH_TOKENS)
  .sort((a, b) => b.length - a.length)
  .join('|')

function monthFromName(word: string): number | undefined {
  return MONTH_TOKENS[word.toLowerCase().replace(/\.$/, '')]
}

const WEEKDAY_TOKENS: Record<string, number> = {}

function addWeekdays(names: string[][]): void {
  for (const [index, group] of names.entries()) {
    for (const name of group) WEEKDAY_TOKENS[name.toLowerCase()] = index
  }
}

addWeekdays([
  ['sunday', 'sun', '周日', '周天', '星期日', '星期天', '礼拜日', '礼拜天', 'dimanche', 'domingo', 'воскресенье', 'воскресенья', 'вс', 'الأحد', 'الاحد'],
  ['monday', 'mon', '周一', '星期一', '礼拜一', 'lundi', 'lunes', 'понедельник', 'понедельника', 'الاثنين', 'الإثنين'],
  ['tuesday', 'tue', 'tues', '周二', '星期二', '礼拜二', 'mardi', 'martes', 'вторник', 'вторника', 'الثلاثاء'],
  ['wednesday', 'wed', '周三', '星期三', '礼拜三', 'mercredi', 'miércoles', 'miercoles', 'среда', 'среду', 'среды', 'الأربعاء', 'الاربعاء'],
  ['thursday', 'thu', 'thur', 'thurs', '周四', '星期四', '礼拜四', 'jeudi', 'jueves', 'четверг', 'четверга', 'الخميس'],
  ['friday', 'fri', '周五', '星期五', '礼拜五', 'vendredi', 'viernes', 'пятница', 'пятницу', 'пятницы', 'الجمعة'],
  ['saturday', 'sat', '周六', '星期六', '礼拜六', 'samedi', 'sábado', 'sabado', 'суббота', 'субботу', 'субботы', 'السبت'],
])

const WEEKDAY_ALT = Object.keys(WEEKDAY_TOKENS)
  .sort((a, b) => b.length - a.length)
  .join('|')

function weekdayFromName(word: string): number | undefined {
  return WEEKDAY_TOKENS[word.toLowerCase().replace(/\.$/, '')]
}

const ANY_WEEKDAY = new RegExp(`(?:${WEEKDAY_ALT})`, 'iu')

/**
 * Word boundaries that CJK survives.
 *
 * `\b` is ASCII-only and `\p{L}` is too greedy in the other direction: a guard
 * written as `(?![\p{L}])` after `周一` refuses to match `下周一举行`, because
 * `举` is a letter — and one written as `\b` matches in the middle of `format`.
 * So the guards below name the scripts where a run of letters really is one
 * word, and stay out of the way in the scripts where it is not.
 */
const LETTER_BEFORE = '(?<![A-Za-z\\u0400-\\u04FF\\u0600-\\u06FF])'
const LETTER_AFTER = '(?![A-Za-z\\u0400-\\u04FF\\u0600-\\u06FF])'

const CN_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/** `二十三` → 23. Only needs to cover 0–60, which is all a clock or a date uses. */
function chineseNumber(text: string): number | null {
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  if (!/^[〇零一二两三四五六七八九十]+$/.test(text)) return null
  const ten = text.indexOf('十')
  if (ten === -1) {
    let total = 0
    for (const char of text) {
      const digit = CN_DIGITS[char]
      if (digit === undefined) return null
      total = total * 10 + digit
    }
    return total
  }
  const tens = ten === 0 ? 1 : (CN_DIGITS[text.slice(0, ten)] ?? null)
  const rest = text.slice(ten + 1)
  const units = rest ? (CN_DIGITS[rest] ?? null) : 0
  if (tens === null || units === null) return null
  return tens * 10 + units
}

// ---------------------------------------------------------------------------
// The date-order rule (see the header)
// ---------------------------------------------------------------------------

type DateOrder = 'dayFirst' | 'monthFirst' | 'undecided'

/** Regions that write month-first. Short, and everything else is day-first. */
const MONTH_FIRST_REGIONS = new Set(['US', 'PH', 'FM', 'MH', 'PW'])

/**
 * The reading order this locale implies, or `undecided`.
 *
 * Takes the raw platform tag rather than the app's `LocaleId` on purpose:
 * `detectLocale()` maps `en-US` and `en-GB` onto the same `en`, and the region
 * it discards is the only part of the tag that answers this question.
 */
export function dateOrderFor(locale: string | undefined): DateOrder {
  if (!locale) return 'undecided'
  const parts = locale.replace(/_/g, '-').split('-')
  const language = (parts[0] ?? '').toLowerCase()
  /* The CJK languages are decided by the language, not the region: they write
     年/月/日 from the widest unit down, so a bare pair is month-then-day in
     `zh-CN`, `zh-TW` and `zh-SG` alike. Reading the region first would have
     made `zh-CN` day-first, which is the one thing it certainly is not. */
  if (language === 'zh' || language === 'ja' || language === 'ko') return 'monthFirst'
  const region = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p) || /^\d{3}$/.test(p))
  if (region) {
    return MONTH_FIRST_REGIONS.has(region.toUpperCase()) ? 'monthFirst' : 'dayFirst'
  }
  if (language === 'fr' || language === 'es' || language === 'ru' || language === 'ar') return 'dayFirst'
  // Bare `en`, and anything unrecognised. A coin flip is not an answer.
  return 'undecided'
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface DayFields {
  y: number
  mo: number
  d: number
}

interface DateCandidate {
  index: number
  end: number
  day: DayFields
  /** The order could not be established; the hit is forced to `low`. */
  ambiguous: boolean
  /** The text stated a year rather than one being inferred. */
  explicitYear: boolean
  /** The phrase itself said what it was — "due in 3 days" is a deadline. */
  selfKind?: DateHitKind
  /** English "next Friday", which many speakers read as the coming Friday. */
  softWeek?: boolean
  /** A named weekday and nothing else — "on Friday". */
  weekdayOnly?: boolean
  /** A written calendar date, as opposed to a relative phrase. */
  absolute?: boolean
}

interface TimeCandidate {
  index: number
  end: number
  h: number
  mi: number
  /** Minutes to subtract to reach UTC, when the text stated a numeric offset. */
  offsetMinutes?: number
  /** A named abbreviation we deliberately do not resolve. */
  namedZone?: boolean
  /** The afternoon was assumed rather than stated. See `assumeAfternoon`. */
  assumedPm?: boolean
}

/**
 * "Tomorrow at 3" is three in the afternoon.
 *
 * Read literally it is 03:00, and a reminder for three in the morning is not a
 * near miss — it is the kind of wrong that makes a feature untrustworthy. A
 * bare hour of 1 to 6, introduced by "at"/"à"/"a las"/"в"/`点` with no minutes
 * and no meridiem word anywhere near it, is the afternoon in every language
 * here. The assumption is recorded and costs a point, so it can never be the
 * difference between medium and high.
 */
function assumeAfternoon(hour: number): boolean {
  return hour >= 1 && hour <= 6
}

/** Local calendar fields of an instant. */
function fieldsOf(ms: number): DayFields {
  const d = new Date(ms)
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() }
}

function atLocal(day: DayFields, h = 0, mi = 0): number {
  return new Date(day.y, day.mo, day.d, h, mi, 0, 0).getTime()
}

function shiftDays(day: DayFields, days: number): DayFields {
  const d = new Date(day.y, day.mo, day.d + days)
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() }
}

function isRealDay(day: DayFields): boolean {
  const d = new Date(day.y, day.mo, day.d)
  return d.getFullYear() === day.y && d.getMonth() === day.mo && d.getDate() === day.d
}

/**
 * A date with no year stated means the next time that date comes round.
 *
 * "3 March" written in November is next March, not nine months ago — the same
 * decision `parseNaturalTime` makes, and for the same reason: mail is about
 * things that have not happened yet.
 */
function inferYear(anchor: DayFields, mo: number, d: number): number {
  const thisYear = { y: anchor.y, mo, d }
  if (!isRealDay(thisYear)) return anchor.y
  const anchorAt = atLocal(anchor)
  if (atLocal(thisYear) >= anchorAt - PAST_TOLERANCE_MS) return anchor.y
  return anchor.y + 1
}

/** Two-digit years: 00–79 → 2000s, 80–99 → 1900s (and then refused as past). */
function fullYear(raw: string): number {
  const n = Number(raw)
  if (raw.length === 4) return n
  return n < 80 ? 2000 + n : 1900 + n
}

// ---------------------------------------------------------------------------
// Date matchers
// ---------------------------------------------------------------------------

interface MatchContext {
  text: string
  anchor: DayFields
  order: DateOrder
}

type DateMatcher = (ctx: MatchContext) => DateCandidate[]

function push(
  out: DateCandidate[],
  m: RegExpExecArray,
  day: DayFields,
  extra: Partial<DateCandidate> = {},
): void {
  if (!isRealDay(day)) return
  out.push({
    index: m.index,
    end: m.index + m[0].length,
    day,
    ambiguous: false,
    explicitYear: true,
    ...extra,
  })
}

/**
 * The trailing guard on every numeric form, and it is subtle.
 *
 * `(?![\d./-])` was the obvious spelling and it is wrong for exactly the reason
 * `CODE_PATTERN` documents: the full stop that ends a sentence is
 * indistinguishable from the dot in `1.2.3`, so "the meeting is on 03/04/2026."
 * matched nothing at all. The dot only disqualifies when a digit sits on the
 * far side of it.
 */
const NUMERIC_TAIL = '(?![\\d/-])(?!\\.\\d)'

/** `2026-04-03`, `2026/4/3`, `2026年4月3日`. Year-first is never ambiguous. */
const yearFirst: DateMatcher = ({ text }) => {
  const out: DateCandidate[] = []
  const re = new RegExp(
    `(?<![\\d./-])(\\d{4})\\s*[-/年.]\\s*(\\d{1,2})\\s*[-/月.]\\s*(\\d{1,2})\\s*[日号]?${NUMERIC_TAIL}`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    push(out, m, { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]) }, { absolute: true })
  }
  return out
}

/** `4月3日`, `4月3号` — no year, so the next one to come round. */
const chineseMonthDay: DateMatcher = ({ text, anchor }) => {
  const out: DateCandidate[] = []
  const re = /(?<![\d年])([〇零一二三四五六七八九十\d]{1,2})\s*月\s*([〇零一二三四五六七八九十\d]{1,3})\s*[日号]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const mo = chineseNumber(m[1])
    const d = chineseNumber(m[2])
    if (mo === null || d === null || mo < 1 || mo > 12 || d < 1 || d > 31) continue
    push(out, m, { y: inferYear(anchor, mo - 1, d), mo: mo - 1, d }, { explicitYear: false, absolute: true })
  }
  return out
}

/**
 * A numeric date with separators: `03/04/2026`, `3.4.2026`, `04-03-26`.
 *
 * The four-digit-or-two-digit year is mandatory. Without it there is no way to
 * tell a date from `24/7`, a fraction or a score, and the ways to be wrong
 * outnumber the ways to be right.
 */
const numericDate: DateMatcher = ({ text, order }) => {
  const out: DateCandidate[] = []
  const re = new RegExp(
    `(?<![\\d./-])(\\d{1,2})\\s*([./-])\\s*(\\d{1,2})\\s*\\2\\s*(\\d{4}|\\d{2})${NUMERIC_TAIL}`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const a = Number(m[1])
    const b = Number(m[3])
    const sep = m[2]
    const y = fullYear(m[4])
    if (a < 1 || b < 1 || a > 31 || b > 31) continue

    let d: number
    let mo: number
    let ambiguous = false

    if (a > 12 && b <= 12) {
      d = a
      mo = b
    } else if (b > 12 && a <= 12) {
      mo = a
      d = b
    } else if (a > 12 && b > 12) {
      continue
    } else {
      // Both readings are calendar-legal. Step 3 of the header rule: a weekday
      // written next to the date settles it without knowing the sender's region.
      const byWeekday = weekdayDisambiguation(text, m.index, m.index + m[0].length, a, b, y)
      if (byWeekday) {
        d = byWeekday.d
        mo = byWeekday.mo
      } else if (sep === '.') {
        // Dotted dates are the European spelling; the US writes slashes.
        d = a
        mo = b
      } else if (order === 'monthFirst') {
        mo = a
        d = b
      } else {
        d = a
        mo = b
        ambiguous = order === 'undecided'
      }
    }
    push(out, m, { y, mo: mo - 1, d }, { ambiguous, absolute: true })
  }
  return out
}

/**
 * Does a weekday named beside the date pick one of the two readings?
 *
 * Only useful when exactly one reading lands on the named day — if both do (or
 * neither), this says nothing rather than guessing, which is the whole point.
 */
function weekdayDisambiguation(
  text: string,
  start: number,
  end: number,
  a: number,
  b: number,
  y: number,
): { d: number; mo: number } | null {
  const around = `${text.slice(Math.max(0, start - 20), start)} ${text.slice(end, end + 20)}`
  const found = ANY_WEEKDAY.exec(around)
  if (!found) return null
  const target = weekdayFromName(found[0])
  if (target === undefined) return null

  const first = { d: a, mo: b }
  const second = { d: b, mo: a }
  const firstOk = isRealDay({ y, mo: first.mo - 1, d: first.d }) &&
    new Date(y, first.mo - 1, first.d).getDay() === target
  const secondOk = isRealDay({ y, mo: second.mo - 1, d: second.d }) &&
    new Date(y, second.mo - 1, second.d).getDay() === target
  if (firstOk === secondOk) return null
  return firstOk ? first : second
}

/** `3 March 2026`, `le 3 mars`, `3 de marzo de 2026`, `3 марта`, `3 مارس`. */
const dayMonthName: DateMatcher = ({ text, anchor }) => {
  const out: DateCandidate[] = []
  const re = new RegExp(
    `${LETTER_BEFORE}(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|er|ème|º|°)?\\s*(?:de\\s+|du\\s+|d[eu]\\s+)?(${MONTH_ALT})\\.?` +
      `(?:\\s*(?:de\\s+|,\\s*)?\\s*(\\d{4})(?:\\s*г\\.?)?)?${LETTER_AFTER}(?!\\d)`,
    'giu',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const mo = monthFromName(m[2])
    const d = Number(m[1])
    if (mo === undefined || d < 1 || d > 31) continue
    const explicitYear = m[3] !== undefined
    const y = explicitYear ? Number(m[3]) : inferYear(anchor, mo, d)
    push(out, m, { y, mo, d }, { explicitYear, absolute: true })
  }
  return out
}

/** `March 3`, `Mar 3, 2026` — the American written order. */
const monthNameDay: DateMatcher = ({ text, anchor }) => {
  const out: DateCandidate[] = []
  const re = new RegExp(
    `${LETTER_BEFORE}(?<!\\d)(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?${LETTER_AFTER}(?!\\d)`,
    'giu',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const mo = monthFromName(m[1])
    const d = Number(m[2])
    if (mo === undefined || d < 1 || d > 31) continue
    const explicitYear = m[3] !== undefined
    const y = explicitYear ? Number(m[3]) : inferYear(anchor, mo, d)
    push(out, m, { y, mo, d }, { explicitYear, absolute: true })
  }
  return out
}

/** today / tomorrow / the day after, in six languages. */
const relativeDay: DateMatcher = ({ text, anchor }) => {
  const out: DateCandidate[] = []
  const table: Array<{ re: RegExp; offset: number }> = [
    { re: /\b(?:the day after tomorrow)\b|后天|後天|apr[eè]s-demain|pasado ma[ñn]ana|послезавтра|بعد غد/gi, offset: 2 },
    // `mañana` is also "morning" in Spanish; the article gives it away.
    { re: /\btomorrow\b|明天|明日|\bdemain\b|(?<!de la |por la |esta |la )\bma[ñn]ana\b|завтра|غدا|غداً|الغد/gi, offset: 1 },
    { re: /\b(?:today|tonight|this (?:afternoon|evening|morning))\b|今天|今日|今晚|今早|aujourd'hui|ce soir|cet apr[eè]s-midi|\bhoy\b|esta (?:tarde|noche|mañana)|сегодня|\bاليوم\b|هذا المساء/gi, offset: 0 },
  ]
  for (const { re, offset } of table) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      push(out, m, shiftDays(anchor, offset), { explicitYear: false })
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return out
}

/**
 * A named weekday, optionally with "next" / "this".
 *
 * Bare ("on Monday") is the next Monday to come round. "Next Monday" is the
 * Monday of the following week — unarguable for `下周一` and `lundi prochain`,
 * contested in English, which is why the English form is marked `softWeek` and
 * loses a tier of confidence rather than being asserted.
 */
const weekdayPhrase: DateMatcher = ({ text, anchor }) => {
  const out: DateCandidate[] = []
  /* The Chinese lead is `下` / `本` / `这` on its own, *not* `下周`: the weekday
     token is `周一`, and a lead that swallowed the 周 would leave a bare `一`
     that matches nothing. Getting this wrong is how `下周一` silently stopped
     being a date at all. */
  const re = new RegExp(
    `${LETTER_BEFORE}(next|this|coming|下(?:个)?|本|这(?:个)?|prochain|ce|este|pr[oó]ximo|esta|следующ\\p{L}*|эт\\p{L}*|هذا)?` +
      `\\s*(?:on\\s+|le\\s+|el\\s+|в\\s+|во\\s+|يوم\\s+)?` +
      `(${WEEKDAY_ALT})` +
      `\\s*(prochaine?|que viene|pr[oó]xim[oa]|المقبل|القادم)?${LETTER_AFTER}`,
    'giu',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const target = weekdayFromName(m[2])
    if (target === undefined) continue
    const lead = (m[1] ?? '').toLowerCase()
    const trail = (m[3] ?? '').toLowerCase()
    const nextWeek =
      /^(next|下|следующ|prochain|pr[oó]xim)/.test(lead) ||
      /^(prochain|que viene|pr[oó]xim|المقبل|القادم)/.test(trail)
    /* English "next Friday" is read by a large minority as the coming Friday.
       Documented in the header, and it costs a tier rather than being asserted. */
    const softWeek = nextWeek && lead === 'next'

    let day: DayFields
    if (nextWeek) {
      // Monday-based: step to the start of the following week, then forward.
      const anchorDow = new Date(anchor.y, anchor.mo, anchor.d).getDay()
      const toNextMonday = 8 - (anchorDow === 0 ? 7 : anchorDow)
      const monday = shiftDays(anchor, toNextMonday)
      day = shiftDays(monday, (target === 0 ? 7 : target) - 1)
    } else {
      let offset = 1
      while (offset <= 7) {
        const candidate = shiftDays(anchor, offset)
        if (new Date(candidate.y, candidate.mo, candidate.d).getDay() === target) break
        offset++
      }
      day = shiftDays(anchor, offset)
    }
    push(out, m, day, { explicitYear: false, softWeek, weekdayOnly: true })
  }
  return out
}

/**
 * Durations that are deadlines: "due in 3 days", "三天后截止", "через 2 дня".
 *
 * Every pattern carries its own trigger word, so these are self-vouching and do
 * not need a keyword elsewhere in the message. A bare "in 3 days" is not here:
 * that phrase appears in marketing copy far more often than in a deadline.
 */
const durationDeadline: DateMatcher = ({ text, anchor }) => {
  const out: DateCandidate[] = []
  const patterns: Array<{ re: RegExp; amount: number; unit: number }> = [
    {
      re: /(?:deadline|due|expires?|closes?|ends?|submit|respond|reply|rsvp)\b[^.\n]{0,28}?\b(?:in|within)\s+(\d{1,3})\s*(business\s+days?|days?|weeks?|hours?)/gi,
      amount: 1,
      unit: 2,
    },
    {
      re: /\b(?:in|within)\s+(\d{1,3})\s*(business\s+days?|days?|weeks?|hours?)[^.\n]{0,28}?\b(?:deadline|due|expires?|closes?)/gi,
      amount: 1,
      unit: 2,
    },
    {
      re: /([〇零一二两三四五六七八九十\d]{1,3})\s*(个?工作日|天|日|小时|周)\s*(?:之?[内后前])\s*(?:截止|到期|提交|回复|完成|反馈|确认|前)/g,
      amount: 1,
      unit: 2,
    },
    {
      re: /(?:截止|期限|最迟|最晚|到期)(?:时间|日期)?\s*[:：]?\s*([〇零一二两三四五六七八九十\d]{1,3})\s*(个?工作日|天|日|小时|周)\s*(?:之?[内后])?/g,
      amount: 1,
      unit: 2,
    },
    {
      re: /(?:date limite|[ée]ch[ée]ance|dernier d[ée]lai|[àa] rendre|r[ée]pond(?:re|ez)|expire)[^.\n]{0,28}?dans\s+(\d{1,3})\s*(jours? ouvr[ée]s?|jours?|semaines?|heures?)/gi,
      amount: 1,
      unit: 2,
    },
    {
      re: /(?:fecha l[ií]mite|plazo|vence|caduca|responder?|entregar?)[^.\n]{0,28}?(?:en|dentro de)\s+(\d{1,3})\s*(d[ií]as? h[áa]biles?|d[ií]as?|semanas?|horas?)/gi,
      amount: 1,
      unit: 2,
    },
    {
      re: /(?:срок|дедлайн|истекает|ответить|подтвердить|сдать)[^.\n]{0,28}?через\s+(\d{1,3})\s*(рабочих дн\p{L}*|дн\p{L}*|день|недел\p{L}*|час\p{L}*)/giu,
      amount: 1,
      unit: 2,
    },
    {
      re: /(?:الموعد النهائي|آخر موعد|تنتهي|يرجى الرد|الرد)[^.\n]{0,28}?خلال\s+(\d{1,3})\s*(أيام عمل|أيام|يوم|أسابيع|أسبوع|ساعات|ساعة)/g,
      amount: 1,
      unit: 2,
    },
  ]

  for (const { re, amount, unit } of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const n = chineseNumber(m[amount]) ?? Number(m[amount])
      if (!Number.isFinite(n) || n <= 0 || n > 365) continue
      const days = unitToDays(m[unit], n)
      if (days === null) continue
      push(out, m, shiftDays(anchor, days), { explicitYear: false, selfKind: 'deadline' })
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return out
}

/**
 * A unit word to whole days.
 *
 * Hours round *up* to the day they land in rather than down: "respond within 4
 * hours" arriving at 22:00 is due tomorrow, and a reminder for the day it has
 * already lapsed is worse than useless. Business days are counted as calendar
 * days plus the weekends they cross.
 */
function unitToDays(unit: string, n: number): number | null {
  const u = unit.toLowerCase()
  if (/^(hour|heure|hora|час|ساع|小时)/.test(u)) return Math.ceil(n / 24)
  if (/(week|semaine|semana|недел|أسب|周)/.test(u)) return n * 7
  if (/(business|ouvr|h[áa]bil|рабочих|工作日|أيام عمل)/.test(u)) return n + Math.floor(n / 5) * 2
  if (/(day|jour|d[ií]a|дн|день|يوم|أيام|天|日)/.test(u)) return n
  return null
}

const DATE_MATCHERS: DateMatcher[] = [
  yearFirst,
  chineseMonthDay,
  numericDate,
  dayMonthName,
  monthNameDay,
  relativeDay,
  weekdayPhrase,
  durationDeadline,
]

function collectDates(ctx: MatchContext): DateCandidate[] {
  const all: DateCandidate[] = []
  for (const matcher of DATE_MATCHERS) all.push(...matcher(ctx))

  /* Overlaps are real: `2026年4月3日` matches both the year-first form and the
     bare 月/日 one. The longer span is the more specific reading, so it wins and
     the shorter one is dropped rather than becoming a second, near-identical
     hit that makes the card look like it found two meetings. */
  all.sort((a, b) => a.index - b.index || b.end - b.index - (a.end - a.index))
  const kept: DateCandidate[] = []
  for (const candidate of all) {
    if (kept.some((k) => candidate.index < k.end && candidate.end > k.index)) continue
    kept.push(candidate)
  }

  /* "Friday, 3 April 2026" names one day, not two. A bare weekday sitting
     beside a written date is *labelling* it, and left in the pool it resolves
     to the next Friday to come round and the card offers a second, wrong
     meeting three weeks before the real one. */
  return kept.filter(
    (c) =>
      !c.weekdayOnly ||
      !kept.some(
        (other) =>
          other.absolute &&
          Math.min(Math.abs(other.index - c.end), Math.abs(c.index - other.end)) <= WEEKDAY_LABEL_WINDOW,
      ),
  )
}

/** How close a weekday has to sit to a written date to be read as its label. */
const WEEKDAY_LABEL_WINDOW = 24

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/*
 * `\b(?:am)\b` and not `\ba\.?m\.?\b`: the second one matches a lone "a", so
 * "a meeting at 3" read as ante-meridiem and turned every afternoon meeting
 * into a 3 a.m. one.
 */
const MERIDIEM_PM = /下午|晚上|傍晚|夜里|\b(?:pm|p\.m\.)\b|\bevening\b|\bafternoon\b|\btonight\b|apr[eè]s-midi|\bsoir\b|\btarde\b|\bnoche\b|вечера|مساء|بعد الظهر/i
const MERIDIEM_AM = /早上|上午|清晨|早晨|凌晨|\b(?:am|a\.m\.)\b|\bmorning\b|\bmatin\b|ma[ñn]ana|утра|صباح/i
const NOON = /中午|正午|\bnoon\b|\bmidi\b|mediod[ií]a|полдень|الظهر/i

/** `14:00 UTC+8`, `12:00 Z`, `09:30 GMT-05:00`. */
const NUMERIC_OFFSET = /^\s*(?:\(?(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\)?|(Z)\b)/i
/** Abbreviations we see but deliberately do not resolve. See the header. */
const NAMED_ZONE = /^\s*\(?(?:[A-Z]{2,5}T|CET|CEST|EET|IST|MSK|北京时间|东八区)\)?\b/

function collectTimes(text: string): TimeCandidate[] {
  const out: TimeCandidate[] = []

  const add = (index: number, end: number, hour: number, minute: number, assumedPm = false) => {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return
    const tail = text.slice(end, end + 14)
    const offset = NUMERIC_OFFSET.exec(tail)
    let offsetMinutes: number | undefined
    let namedZone = false
    if (offset) {
      offsetMinutes = offset[4]
        ? 0
        : (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0))
    } else if (NAMED_ZONE.test(tail)) {
      namedZone = true
    }
    out.push({ index, end, h: hour, mi: minute, offsetMinutes, namedZone, assumedPm })
  }

  /** The words that shift a clock reading sit just before or just after it. */
  const meridiemAround = (index: number, end: number): 'am' | 'pm' | 'noon' | null => {
    const before = text.slice(Math.max(0, index - 14), index)
    const after = text.slice(end, end + 12)
    const window = `${before} ${after}`
    if (NOON.test(window)) return 'noon'
    if (MERIDIEM_PM.test(window)) return 'pm'
    if (MERIDIEM_AM.test(window)) return 'am'
    return null
  }

  const applyMeridiem = (hour: number, mark: 'am' | 'pm' | 'noon' | null): number => {
    if (mark === 'noon') return hour === 12 ? 12 : hour
    if (mark === 'pm' && hour < 12) return hour + 12
    if (mark === 'am' && hour === 12) return 0
    return hour
  }

  /* `14:00`, `2:30 pm`, `14h30`, `14 h`, `15 ч`. The French `h` separator must
     allow digits after it — `h(?!\w)` refused `14h30` and quietly dropped every
     French mail's minutes — but not letters, or `12hrs` becomes half past noon. */
  const digital = /(?<![\d.:])(\d{1,2})\s*(?:[:：]|h(?![A-Za-z])|ч(?!\p{L}))\s*(\d{2})?(?!\d)/giu
  let m: RegExpExecArray | null
  while ((m = digital.exec(text))) {
    const end = m.index + m[0].length
    const minute = m[2] === undefined ? 0 : Number(m[2])
    add(m.index, end, applyMeridiem(Number(m[1]), meridiemAround(m.index, end)), minute)
  }

  // `3pm`, `3 p.m.` — a bare hour, but the meridiem says it is a clock reading.
  const meridiemOnly = /(?<![\d.:])(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)(?![\w.])/gi
  while ((m = meridiemOnly.exec(text))) {
    const end = m.index + m[0].length
    add(m.index, end, applyMeridiem(Number(m[1]), /^p/i.test(m[2]) ? 'pm' : 'am'), 0)
  }

  /* `at 3`, `a las 3`, `в 15`, `الساعة 3`. A bare number is never a time — the
     introducing word is the only thing separating "at 3" from "3 attachments",
     so it is required and it is part of the match, which also puts the match
     index where a reader would say the phrase starts. */
  const introduced = new RegExp(
    `${LETTER_BEFORE}(?:at|[àa] las|[àa] la|à|в|во|في الساعة|الساعة)\\s*(\\d{1,2})(?:\\s*[:：]\\s*(\\d{2}))?(?!\\d)`,
    'giu',
  )
  while ((m = introduced.exec(text))) {
    const end = m.index + m[0].length
    const minute = m[2] === undefined ? 0 : Number(m[2])
    const mark = meridiemAround(m.index, end)
    const hour = applyMeridiem(Number(m[1]), mark)
    const assume = mark === null && m[2] === undefined && assumeAfternoon(hour)
    add(m.index, end, assume ? hour + 12 : hour, minute, assume)
  }

  // `下午三点`, `晚上8点半`, `9点30分`
  const cn = /([〇零一二两三四五六七八九十\d]{1,3})\s*[点時时]\s*(半|[〇零一二三四五六七八九十\d]{1,3}\s*分)?/g
  while ((m = cn.exec(text))) {
    const hourRaw = chineseNumber(m[1])
    if (hourRaw === null) continue
    let minute = 0
    if (m[2] === '半') minute = 30
    else if (m[2]) minute = chineseNumber(m[2].replace(/\s*分/, '')) ?? 0
    const end = m.index + m[0].length
    const mark = meridiemAround(m.index, end)
    const hour = applyMeridiem(hourRaw, mark)
    const assume = mark === null && minute === 0 && assumeAfternoon(hour)
    add(m.index, end, assume ? hour + 12 : hour, minute, assume)
  }

  return mergeTimes(out)
}

/**
 * One clock reading per stretch of text.
 *
 * The forms overlap by design — `à 14h30` is matched both as "introduced by à"
 * and as "digital with an h separator" — and the pairing step takes whichever
 * starts nearest the date, which is the *earlier* one, which is the one that
 * never saw the minutes. That is how every French meeting became an o'clock.
 * So overlapping readings collapse to the most informative one first.
 */
function mergeTimes(times: TimeCandidate[]): TimeCandidate[] {
  const informativeness = (t: TimeCandidate) =>
    (t.mi !== 0 ? 100 : 0) + (t.assumedPm ? 0 : 10) + (t.end - t.index)
  const out: TimeCandidate[] = []
  for (const time of [...times].sort((a, b) => a.index - b.index)) {
    const clash = out.findIndex((k) => time.index < k.end && time.end > k.index)
    if (clash < 0) out.push(time)
    else if (informativeness(time) > informativeness(out[clash])) out[clash] = time
  }
  return out.sort((a, b) => a.index - b.index)
}

/** How far after a date a time still belongs to it ("3 March at 14:00"). */
const TIME_AFTER_WINDOW = 34
/** And before ("14:00 on 3 March"). */
const TIME_BEFORE_WINDOW = 20

function pairTime(date: DateCandidate, times: TimeCandidate[]): TimeCandidate | null {
  let best: TimeCandidate | null = null
  let bestGap = Infinity
  for (const time of times) {
    let gap = Infinity
    if (time.index >= date.end - 2) {
      if (time.index - date.end <= TIME_AFTER_WINDOW) gap = Math.max(0, time.index - date.end)
    } else if (time.end <= date.index && date.index - time.end <= TIME_BEFORE_WINDOW) {
      // Slightly penalised: the announcing order is date-then-time far more often.
      gap = date.index - time.end + 4
    }
    if (gap < bestGap) {
      bestGap = gap
      best = time
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Scored {
  candidate: DateCandidate
  time: TimeCandidate | null
  at: number
  allDay: boolean
  kind: DateHitKind
  score: number
  keyword?: string
  source: 'subject' | 'body'
}

function nearestKeyword(
  index: number,
  end: number,
  spans: KeywordSpan[],
): { span: KeywordSpan; points: number } | null {
  let best: { span: KeywordSpan; points: number; gap: number } | null = null
  for (const span of spans) {
    let points = -Infinity
    let gap = Infinity
    if (span.start < end && span.end > index) {
      /* The keyword and the date are the same phrase — "due in 3 days",
         "截止时间：3月5日". Overlap used to fall into the `else` branch, come out
         as a negative gap, and be scored as *far from any keyword*: the single
         strongest shape in the corpus was being penalised. */
      points = 7
      gap = 0
    } else if (index >= span.end) {
      gap = index - span.end
      if (gap <= AFTER_KEYWORD_WINDOW) points = 6 - Math.floor(gap / 20)
    } else {
      gap = span.start - end
      if (gap >= 0 && gap <= BEFORE_KEYWORD_WINDOW) points = 4 - Math.floor(gap / 16)
    }
    /* Ties broken by raw distance, not by document order. `موعد الاجتماع`
       ("the meeting appointment") scores both words identically, and the
       nearer one is the one describing the date that follows — which decides
       whether the card offers a meeting or an appointment. */
    if (points > -Infinity && (!best || points > best.points || (points === best.points && gap < best.gap))) {
      best = { span, points, gap }
    }
  }
  return best
}

function resolve(candidate: DateCandidate, time: TimeCandidate | null): number {
  if (!time) return atLocal(candidate.day)
  if (time.offsetMinutes !== undefined) {
    /* A stated numeric offset makes the instant exact — resolve it as UTC and
       let the machine's own zone render it. This is the only path where the
       wall-clock reading and the instant are allowed to differ. */
    return Date.UTC(candidate.day.y, candidate.day.mo, candidate.day.d, time.h, time.mi) -
      time.offsetMinutes * 60_000
  }
  return atLocal(candidate.day, time.h, time.mi)
}

interface ScoreContext {
  times: TimeCandidate[]
  spans: KeywordSpan[]
  footerAt: number
  source: 'subject' | 'body'
  anchor: number
  /**
   * The *subject* announced a meeting or a deadline. "Re: project deadline"
   * over a body that only says "3 March" is the commonest shape there is, and
   * without this the body date has nothing vouching for it at all.
   */
  subjectKeyword?: KeywordSpan
}

function scoreOne(candidate: DateCandidate, ctx: ScoreContext): Scored | null {
  const { times, spans, footerAt, source, anchor } = ctx
  const time = pairTime(candidate, times)
  const at = resolve(candidate, time)

  /* A date before the mail was written is not what the mail is about — it is a
     copyright line, a quoted header that survived, or a misread version number.
     Two days of slack, because a mail sent late on Monday about a Monday
     morning meeting is a real thing. */
  if (at < anchor - PAST_TOLERANCE_MS) return null
  if (at > anchor + FUTURE_LIMIT_MS) return null

  const near = nearestKeyword(candidate.index, candidate.end, spans)
  let score = 0
  if (near) score += near.points
  else if (spans.length > 0) score -= 2
  else if (ctx.subjectKeyword) score += 3

  if (time) score += 2
  if (candidate.explicitYear) score += 1
  if (candidate.selfKind) score += 4
  if (source === 'subject') score += 2
  if (candidate.softWeek) score -= 1
  if (time?.namedZone) score -= 1
  if (time?.assumedPm) score -= 1
  if (footerAt >= 0 && candidate.index > footerAt) score -= 6

  const vouching = near?.span ?? ctx.subjectKeyword
  const kind = candidate.selfKind ?? vouching?.kind ?? 'meeting'

  return {
    candidate,
    time,
    at,
    allDay: time === null,
    kind,
    score,
    keyword: vouching?.word,
    source,
  }
}

// ---------------------------------------------------------------------------
// The calendar part — the primary path
// ---------------------------------------------------------------------------

/**
 * `LOCATION`, read straight off the raw part.
 *
 * `IcsEvent` does not carry it and `src/core/ics.ts` is not this feature's to
 * change, so it is read with `unfoldLines` + `parseProperty` — the same reader
 * the parser itself uses, so an unusual folding or a quoted parameter value is
 * handled once rather than twice, and by the same code.
 */
function icsLocations(raw: string): string[] {
  const locations: string[] = []
  for (const line of unfoldLines(raw)) {
    const prop = parseProperty(line)
    if (prop?.name === 'LOCATION') locations.push(prop.value.replace(/\\([,;\\])/g, '$1').trim())
  }
  return locations
}

function fromIcs(parts: string[]): DateHit[] {
  const hits: DateHit[] = []
  for (const raw of parts) {
    const parsed = parseIcs(raw)
    const locations = icsLocations(raw)
    for (const [index, event] of parsed.events.entries()) {
      /* An all-day `DTSTART;VALUE=DATE` is a *date* and has no instant of its
         own; it becomes local midnight here, exactly as `IcsWhen` documents,
         and never UTC midnight — which is the previous day for half the planet. */
      const allDay = event.start.kind === 'date'
      const resolved = event.start.kind === 'date' ? isoMidnight(event.start.date) : event.start.at
      if (!Number.isFinite(resolved)) continue
      hits.push({
        at: resolved,
        allDay,
        // A `text/calendar` part is an invitation by construction. What the
        // METHOD was — REQUEST, CANCEL, REPLY — is the card's business.
        kind: 'invitation',
        confidence: 'high',
        evidence: {
          snippet: (event.summary || event.description || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          matched: event.start.kind === 'date' ? event.start.date : new Date(resolved).toISOString(),
        },
        title: event.summary || undefined,
        location: locations[index] ?? (locations.length === 1 ? locations[0] : undefined),
      })
    }
  }
  return hits.sort((a, b) => a.at - b.at).slice(0, MAX_HITS)
}

/** `2026-04-03` → local midnight on that day. */
function isoMidnight(iso: string): number {
  const [y, mo, d] = iso.split('-').map(Number)
  return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime()
}

// ---------------------------------------------------------------------------
// Prose extras
// ---------------------------------------------------------------------------

const LOCATION_LABEL =
  /(?:location|venue|where|place|地点|地址|会议地点|会议室|lieu|endroit|lugar|sitio|место|مكان|المكان)\s*[:：]\s*([^\n]{1,80})/i
/* Two patterns, because `\b` is ASCII-only: `\b腾讯会议\b` can never match, and
   a single merged pattern would have silently had no Chinese half at all. */
const PLATFORM_LATIN = /\b(?:zoom|microsoft teams|google meet|webex|gotomeeting|whereby)\b/i
const PLATFORM_CJK = /腾讯会议|飞书会议|飞书|钉钉|企业微信/

function findLocation(text: string): string | undefined {
  const labelled = LOCATION_LABEL.exec(text)
  if (labelled) {
    const value = labelled[1].trim().replace(/\s+/g, ' ')
    if (value) return value
  }
  const platform = PLATFORM_LATIN.exec(text) ?? PLATFORM_CJK.exec(text)
  return platform ? platform[0] : undefined
}

/** `Re: Fwd: 会议` → `会议`. Prefix noise, not a title. */
const SUBJECT_PREFIX = /^(?:\s*(?:re|fwd?|aw|tr|rv|回复|答复|转发|отв|прд|رد|إعادة توجيه)\s*[:：]\s*)+/i

function cleanSubject(subject: string): string | undefined {
  const cleaned = subject.replace(SUBJECT_PREFIX, '').trim()
  return cleaned || undefined
}

/** ±30 characters of the original text, whitespace collapsed. */
function snippetOf(text: string, index: number, end: number): string {
  const from = Math.max(0, index - 30)
  const to = Math.min(text.length, end + 30)
  return text.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Every meeting or deadline this message states, best first.
 *
 * An empty array is a perfectly good answer and the commonest one — see the
 * header. Nothing here reads the clock: `receivedAt` is the only "now".
 */
export function extractDates(input: DateExtractInput): DateHit[] {
  const { subject = '', body = '', receivedAt } = input
  if (!Number.isFinite(receivedAt)) return []

  /* The calendar part short-circuits everything. A DTSTART written by the
     sending calendar is not a thing to second-guess with a regex. */
  const icsParts = (input.icsParts ?? []).filter((p) => typeof p === 'string' && p.length > 0)
  if (icsParts.length > 0) {
    const fromCalendar = fromIcs(icsParts)
    if (fromCalendar.length > 0) return fromCalendar
  }

  const order = dateOrderFor(input.locale)
  const anchor = fieldsOf(receivedAt)

  const rawSubject = normalize(subject)
  const rawBody = normalize(body)
  const cleanSubjectText = scrub(subject)
  const cleanBodyText = scrub(body)

  const subjectSpans = keywordSpans(cleanSubjectText)
  const bodySpans = keywordSpans(cleanBodyText)
  const hasKeyword = subjectSpans.length > 0 || bodySpans.length > 0
  const footerMatch = FOOTER_MARKER.exec(cleanBodyText)
  const footerAt = footerMatch ? footerMatch.index : -1

  const subjectTimes = collectTimes(cleanSubjectText)
  const bodyTimes = collectTimes(cleanBodyText)

  const pool: Scored[] = []
  for (const [text, times, spans, source] of [
    [cleanSubjectText, subjectTimes, subjectSpans, 'subject'],
    [cleanBodyText, bodyTimes, bodySpans, 'body'],
  ] as Array<[string, TimeCandidate[], KeywordSpan[], 'subject' | 'body']>) {
    if (!text.trim()) continue
    for (const candidate of collectDates({ text, anchor, order })) {
      const scored = scoreOne(candidate, {
        times,
        spans,
        footerAt: source === 'body' ? footerAt : -1,
        source,
        anchor: receivedAt,
        subjectKeyword: source === 'body' ? subjectSpans[0] : undefined,
      })
      if (scored) pool.push(scored)
    }
  }

  pool.sort((a, b) => b.score - a.score || a.at - b.at)

  /* A phrase that announces itself needs nothing else vouching for it. Arabic
     writes "يرجى الرد خلال 3 أيام" with no word this file lists as a deadline
     keyword — the *shape* is the announcement — and routing it through the
     keyword-free gate below silently dropped every such mail. */
  const chosen = hasKeyword
    ? pool.filter((s) => s.score > 0)
    : (() => {
        const selfVouched = pool.filter((s) => s.candidate.selfKind && s.score > 0)
        return selfVouched.length > 0 ? selfVouched : keywordFree(pool, cleanBodyText)
      })()
  if (chosen.length === 0) return []

  const location = findLocation(cleanBodyText) ?? findLocation(cleanSubjectText)
  const title = cleanSubject(subject)

  const seen = new Set<number>()
  const hits: DateHit[] = []
  for (const scored of chosen) {
    if (seen.has(scored.at)) continue
    seen.add(scored.at)
    const raw = scored.source === 'subject' ? rawSubject : rawBody
    hits.push({
      at: scored.at,
      allDay: scored.allDay,
      kind: scored.kind,
      confidence: confidenceOf(scored),
      evidence: {
        snippet: snippetOf(raw, scored.candidate.index, scored.candidate.end),
        matched: raw.slice(scored.candidate.index, scored.candidate.end).trim(),
        keyword: scored.keyword,
      },
      title,
      location,
    })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

/**
 * The gate between "I found a date" and "I am willing to say it".
 *
 * With no meeting or deadline word anywhere, every date in the message is a
 * date that happens to be written down — a webinar replay, a policy change, a
 * birthday in a newsletter. This is the path that produced `98052`'s
 * equivalent, so it is the most demanding one in the file: a short body, one
 * candidate and one only, an explicitly written calendar date rather than a
 * relative phrase, and a time of day attached. Anything less says nothing.
 */
function keywordFree(pool: Scored[], body: string): Scored[] {
  if (body.length > 400) return []
  if (pool.length !== 1) return []
  const only = pool[0]
  if (!only.time) return []
  if (!only.candidate.explicitYear) return []
  if (only.candidate.ambiguous) return []
  return [{ ...only, score: 1 }]
}

function confidenceOf(scored: Scored): DateHit['confidence'] {
  // The order was never established. Whatever else it scored, this is a guess
  // with a documented default behind it, and it says so.
  if (scored.candidate.ambiguous) return 'low'
  if (scored.score >= 8) return 'high'
  if (scored.score >= 4) return 'medium'
  return 'low'
}
