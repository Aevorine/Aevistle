/**
 * Turning "每周一 8:30" into a recurrence.
 *
 * The recurrence editor is complete and precise, and setting up a weekday
 * reminder in it takes six interactions. Most reminders people actually make
 * are one of a dozen shapes they can say in four words, so this reads the
 * phrase and fills the editor in — the editor stays authoritative, and stays
 * visible, so a misreading is corrected rather than discovered later.
 *
 * Chinese and English are handled together rather than in two parsers: the
 * grammar being matched is "[how often] [which day] [what time]" in both, and
 * the only real difference is the vocabulary.
 *
 * Deliberately conservative. Returning nothing is a fine outcome — the user
 * just fills the form in as before. Returning the *wrong* time silently is
 * not, because the whole point of this app is that a message goes out at a
 * moment nobody is watching.
 */

import { defaultRecurrence, type Recurrence } from '../types'

export interface ParsedTime {
  recurrence: Recurrence
  /** What was understood, in the user's own terms, for the confirmation line. */
  matched: string
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

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
  const before = text.slice(0, ten)
  const after = text.slice(ten + 1)
  const tens = before ? (CN_DIGITS[before] ?? null) : 1
  const units = after ? (CN_DIGITS[after] ?? null) : 0
  if (tens === null || units === null) return null
  return tens * 10 + units
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

const WEEKDAYS: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

interface Clock {
  hour: number
  minute: number
  /** True when the text said a time; false when we defaulted. */
  explicit: boolean
}

/**
 * Read the clock out of a phrase.
 *
 * The meridiem words are the fiddly part: 「下午3点」is 15:00, but 「下午12点」
 * is noon, not midnight, and 「早上12点」nobody says at all. So the shift is
 * applied only when it changes something.
 */
function readClock(text: string): Clock {
  const pm = /下午|晚上|傍晚|夜里|\bpm\b|\bevening\b|\bafternoon\b|\btonight\b/i.test(text)
  const am = /早上|上午|清晨|早晨|凌晨|\bam\b|\bmorning\b/i.test(text)
  const noon = /中午|正午|\bnoon\b/.test(text)

  let hour: number | null = null
  let minute = 0

  const digital = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/)
  if (digital) {
    hour = Number(digital[1])
    minute = Number(digital[2])
  } else {
    const spoken = text.match(/([〇零一二两三四五六七八九十\d]{1,3})\s*[点時时]\s*([〇零一二三四五六七八九十\d]{1,3})?\s*分?/)
    if (spoken) {
      hour = chineseNumber(spoken[1])
      if (spoken[2]) minute = chineseNumber(spoken[2]) ?? 0
      else if (/半/.test(text)) minute = 30
    } else {
      const oclock = text.match(/\bat\s+(\d{1,2})\b/i)
      if (oclock) hour = Number(oclock[1])
    }
  }

  if (hour === null) {
    // No time given. Nine in the morning is the least surprising default for
    // a reminder, and it is visible in the editor the moment it is applied.
    return { hour: noon ? 12 : 9, minute: 0, explicit: false }
  }
  if (noon && hour === 12) return { hour: 12, minute, explicit: true }
  if (pm && hour < 12) hour += 12
  if (am && hour === 12) hour = 0
  return { hour: Math.min(23, hour), minute: Math.min(59, minute), explicit: true }
}

function at(base: Date, clock: Clock): Date {
  const out = new Date(base)
  out.setHours(clock.hour, clock.minute, 0, 0)
  return out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * @param input what the user typed
 * @param now   injected so the result is testable and so a reminder created at
 *              23:59:59 cannot land on the wrong day because the clock ticked
 *              between two internal reads
 */
export function parseNaturalTime(input: string, now = new Date()): ParsedTime | null {
  const text = input.trim()
  if (!text) return null
  const lower = text.toLowerCase()
  const clock = readClock(lower)

  const build = (over: Partial<Recurrence>, matched: string, start: Date): ParsedTime => ({
    recurrence: {
      ...defaultRecurrence(start.getTime()),
      startAt: start.getTime(),
      timeOfDay: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      ...over,
    },
    matched,
  })

  // --- repeating ---------------------------------------------------------

  const everyWeek = lower.match(/每(?:个)?(?:周|星期|礼拜)([日天一二三四五六]+)/)
  if (everyWeek) {
    const weekdays = [...new Set([...everyWeek[1]].map((c) => WEEKDAYS[c]).filter((d) => d !== undefined))]
    if (weekdays.length > 0) {
      return build({ kind: 'weekly', weekdays }, everyWeek[0], nextWeekday(now, weekdays, clock))
    }
  }

  const everyWorkday = /每(?:个)?工作日|工作日每天|weekdays?\b/.test(lower)
  if (everyWorkday) {
    const weekdays = [1, 2, 3, 4, 5]
    return build({ kind: 'weekly', weekdays }, '每个工作日', nextWeekday(now, weekdays, clock))
  }

  const everyDay = /每天|每日|daily|every day/.test(lower)
  if (everyDay) {
    let start = at(now, clock)
    if (start <= now) start = at(addDays(now, 1), clock)
    return build({ kind: 'daily' }, '每天', start)
  }

  const everyMonth = lower.match(/每(?:个)?月\s*([〇零一二三四五六七八九十\d]{1,3})\s*[号日]/)
  if (everyMonth) {
    const day = chineseNumber(everyMonth[1])
    if (day && day >= 1 && day <= 31) {
      return build(
        { kind: 'monthly', dayOfMonth: day },
        everyMonth[0],
        nextMonthDay(now, day, clock),
      )
    }
  }

  const everyN = lower.match(/每\s*([〇零一二两三四五六七八九十\d]{1,3})\s*(分钟|小时|天)/)
  if (everyN) {
    const n = chineseNumber(everyN[1])
    const unit = everyN[2]
    if (n && n > 0) {
      const minutes = unit === '分钟' ? n : unit === '小时' ? n * 60 : n * 1440
      return build(
        { kind: 'interval', intervalMinutes: minutes },
        everyN[0],
        new Date(now.getTime() + minutes * 60_000),
      )
    }
  }

  // --- one-off -----------------------------------------------------------

  const relativeDay = /后天/.test(lower) ? 2 : /明天|明日|tomorrow/.test(lower) ? 1 : /今天|今日|today/.test(lower) ? 0 : null
  if (relativeDay !== null) {
    const start = at(addDays(now, relativeDay), clock)
    const label = relativeDay === 2 ? '后天' : relativeDay === 1 ? '明天' : '今天'
    return build({ kind: 'once' }, label, start)
  }

  const inDays = lower.match(/([〇零一二两三四五六七八九十\d]{1,3})\s*(?:天|日)后|in\s+(\d{1,3})\s+days?/)
  if (inDays) {
    const n = chineseNumber(inDays[1] ?? '') ?? Number(inDays[2])
    if (n && n > 0) return build({ kind: 'once' }, inDays[0], at(addDays(now, n), clock))
  }

  const inHours = lower.match(/([〇零一二两三四五六七八九十\d]{1,3})\s*(?:个)?\s*小时后|in\s+(\d{1,3})\s+hours?/)
  if (inHours) {
    const n = chineseNumber(inHours[1] ?? '') ?? Number(inHours[2])
    if (n && n > 0) {
      return build({ kind: 'once' }, inHours[0], new Date(now.getTime() + n * 3_600_000))
    }
  }

  const inMinutes = lower.match(/([〇零一二两三四五六七八九十\d]{1,3})\s*分钟后|in\s+(\d{1,3})\s+min/)
  if (inMinutes) {
    const n = chineseNumber(inMinutes[1] ?? '') ?? Number(inMinutes[2])
    if (n && n > 0) {
      return build({ kind: 'once' }, inMinutes[0], new Date(now.getTime() + n * 60_000))
    }
  }

  const nextWeekdayMatch = lower.match(/(?:下(?:个)?)?(?:周|星期|礼拜)([日天一二三四五六])/)
  if (nextWeekdayMatch) {
    const day = WEEKDAYS[nextWeekdayMatch[1]]
    if (day !== undefined) {
      return build({ kind: 'once' }, nextWeekdayMatch[0], nextWeekday(now, [day], clock))
    }
  }

  // An explicit calendar date, Chinese or ISO.
  const cnDate = lower.match(
    /(?:([〇零一二三四五六七八九十\d]{1,4})\s*年\s*)?([〇零一二三四五六七八九十\d]{1,2})\s*月\s*([〇零一二三四五六七八九十\d]{1,3})\s*[号日]/,
  )
  if (cnDate) {
    const year = cnDate[1] ? (chineseNumber(cnDate[1]) ?? now.getFullYear()) : now.getFullYear()
    const month = chineseNumber(cnDate[2])
    const day = chineseNumber(cnDate[3])
    if (month && day) {
      let start = new Date(year, month - 1, day, clock.hour, clock.minute, 0, 0)
      // A bare "3月5日" already past this year means next year, not the past.
      if (!cnDate[1] && start <= now) start = new Date(year + 1, month - 1, day, clock.hour, clock.minute, 0, 0)
      return build({ kind: 'once' }, cnDate[0], start)
    }
  }

  const iso = lower.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (iso) {
    const start = new Date(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), clock.hour, clock.minute, 0, 0,
    )
    if (!Number.isNaN(start.getTime())) return build({ kind: 'once' }, iso[0], start)
  }

  // A bare time on its own — "9:30", "早上八点" — means the next time it comes round.
  if (clock.explicit) {
    let start = at(now, clock)
    if (start <= now) start = at(addDays(now, 1), clock)
    return build({ kind: 'once' }, `${clock.hour}:${String(clock.minute).padStart(2, '0')}`, start)
  }

  return null
}

function addDays(from: Date, days: number): Date {
  const out = new Date(from)
  out.setDate(out.getDate() + days)
  return out
}

function nextWeekday(now: Date, weekdays: number[], clock: Clock): Date {
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = at(addDays(now, offset), clock)
    if (weekdays.includes(candidate.getDay()) && candidate > now) return candidate
  }
  return at(addDays(now, 7), clock)
}

function nextMonthDay(now: Date, day: number, clock: Clock): Date {
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), day, clock.hour, clock.minute, 0, 0)
  if (thisMonth > now && thisMonth.getDate() === day) return thisMonth
  return new Date(now.getFullYear(), now.getMonth() + 1, day, clock.hour, clock.minute, 0, 0)
}
