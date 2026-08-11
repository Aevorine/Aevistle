/**
 * Send Guardian — a pre-send sanity check for the compose screen.
 *
 * Four independent heuristics, each looking for a mistake that is easy to
 * make and easy to miss while proofreading your own message: an "attached"
 * that nothing was actually attached to, a "tomorrow" that will not arrive
 * for over a week, a typo'd domain that looks nothing like what autocomplete
 * would have caught, and a crowd of strangers all exposed to each other's
 * address. None of them can be certain — that is the nature of a heuristic —
 * so every finding here is advisory: `severity` is always `'warning'`, never
 * `'error'`, and nothing in this file can block a send. The banner that reads
 * these findings (`ComposeView`) is explicitly non-blocking for the same
 * reason: a false positive on a real feature erodes trust faster than a
 * missed catch costs anything, so each check below is written to stay quiet
 * unless it is fairly confident.
 *
 * Kept out of `core/validate.ts` and `core/preflight.ts` on purpose. Those
 * two are about whether a send is *correct* — a bad address, a message too
 * large for the provider, a subject with a newline in it — and every one of
 * their findings is derived from a fact that is unambiguously true. These
 * four are guesses about *intent*, built from string matching and edit
 * distance, and mixing them into `validateDraft`'s error/warning list would
 * risk a heuristic false positive one day disabling Send the way a real
 * validation error does.
 */

import type { MessageDraft } from './types'

export type GuardianRuleId = 'missingAttachment' | 'staleDate' | 'typoDomain' | 'massTo'

export interface GuardianFinding {
  rule: GuardianRuleId
  /** i18n key, under `sendGuardian.*`. */
  key: string
  /** Always `'warning'` — see the module doc comment for why. */
  severity: 'warning'
  values?: Record<string, string | number>
}

// ---------------------------------------------------------------------------
// 1. Body mentions an attachment, but nothing is attached
// ---------------------------------------------------------------------------

/**
 * Phrases that mean "there is a file with this message", across the six
 * shipped languages. Deliberately multi-word or otherwise specific rather
 * than a bare noun wherever the bare noun is ambiguous in that language —
 * see the Russian and Arabic entries' comments.
 */
const ATTACHMENT_MENTION_PATTERNS: RegExp[] = [
  // en
  /\bsee attached\b/i,
  /\b(?:please|kindly) find attached\b/i,
  /\bfind attached\b/i,
  /\bas attached\b/i,
  /\bi(?:'ve| have) attached\b/i,
  /\bthe attached (?:file|files|document|documents|pdf|photo|photos|image|images)\b/i,
  /\bthe attachment\b/i,
  // zh-CN — bare "附件" (attachment) is unambiguous in this context
  /附件/,
  // fr
  /\bpi[eè]ce jointe\b/i,
  /\bci-joint(?:e|es)?\b/i,
  // es
  /\barchivo adjunto\b/i,
  /\bencontrar[aá]s?\s+adjunto\b/i,
  /\badjunto\s+encontrar[aá]s?\b/i,
  /\bver adjunto\b/i,
  // ru — full participial forms rather than the bare noun: "вложение" alone
  // is also the ordinary word for a financial investment, and flagging every
  // mail that uses it that way would be exactly the false positive this
  // module exists to avoid.
  /во вложении/i,
  /файл\s+прикреплен/i,
  /прикреплен(?:а|о|ный|ного|ном|ные)?\s+файл/i,
  // ar
  /المرفق/,
  /الملفات? المرفقة/,
]

/**
 * Counter-phrases: "no attachment", "nothing attached". Checked before the
 * positive list is trusted, so "there's no attachment needed here" does not
 * get read as a mention of one.
 */
const ATTACHMENT_NEGATION_PATTERNS: RegExp[] = [
  /\bno attachment/i,
  /\bwithout (?:the |an )?attach/i,
  /\bnot attached\b/i,
  /\bdon'?t need to attach/i,
  /没有附件/,
  /不需要附件/,
  /无附件/,
  /\bsans pi[eè]ce jointe\b/i,
  /\bpas de pi[eè]ce jointe\b/i,
  /\bsin adjunto/i,
  // No leading `\b` before the Cyrillic/Arabic words below: `\b`'s notion of
  // a "word character" is ASCII-only in JS regex, with or without `/u` — so
  // a boundary right before a Cyrillic or Arabic letter never matches (proven
  // out in `check-send-guardian.mjs`). Every other Cyrillic/Arabic pattern in
  // this file already avoids it; `dateExtract.ts` relies on the same fact.
  /без вложени/i,
  /не прикреплен/i,
  /بدون مرفق/,
  /دون إرفاق/,
]

export function checkMissingAttachment(body: string, attachmentCount: number): GuardianFinding | null {
  if (attachmentCount > 0) return null
  const text = typeof body === 'string' ? body : ''
  if (!text.trim()) return null
  if (ATTACHMENT_NEGATION_PATTERNS.some((re) => re.test(text))) return null
  if (!ATTACHMENT_MENTION_PATTERNS.some((re) => re.test(text))) return null
  return { rule: 'missingAttachment', key: 'sendGuardian.missingAttachment', severity: 'warning' }
}

// ---------------------------------------------------------------------------
// 2. A relative date phrase that will be stale by the time this actually sends
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/**
 * Three buckets, ordered most-urgent (and smallest tolerance) first. A body
 * is only flagged against the *first* bucket it matches — "today" and
 * "next week" are unlikely to appear together, and if they did, the more
 * urgent-sounding one is the more useful thing to warn about.
 *
 * Thresholds are deliberately generous. The point is not to catch every
 * stale phrase, it is to never catch a phrase that was actually fine — see
 * the module doc comment. "Tomorrow" scheduled three days out could still be
 * a reasonable "reminder written a few days ahead of a Monday morning send";
 * scheduled nine days out (the motivating example) is not.
 *
 * Only English and Chinese get explicit per-weekday coverage ("next Monday" /
 * "下周一"). French, Spanish, Russian and Arabic all inflect "next <weekday>"
 * by grammatical gender or case in ways easy to get wrong in a way that
 * either matches nothing (a silent miss, harmless) or matches too much
 * (a false positive, the thing this file is written to avoid) — so those four
 * only match the generic "next week" phrase, which every one of them has an
 * invariant way to say.
 */
const STALE_BUCKETS: { id: 'today' | 'tomorrow' | 'nextPeriod'; thresholdMs: number; patterns: RegExp[] }[] = [
  {
    id: 'today',
    thresholdMs: 2 * DAY_MS,
    patterns: [
      /\btoday\b/i,
      /\btonight\b/i,
      /今天/,
      /今晚/,
      /\baujourd'?hui\b/i,
      /\bce soir\b/i,
      /\bhoy\b/i,
      /\besta noche\b/i,
      /сегодня/i,
      /اليوم/,
      /الليلة/,
    ],
  },
  {
    id: 'tomorrow',
    thresholdMs: 4 * DAY_MS,
    patterns: [
      /\btomorrow\b/i,
      /明天/,
      /\bdemain\b/i,
      /завтра/i,
      /غدا/,
      /غداً/,
      // "mañana" means both "tomorrow" and "morning" in Spanish; the
      // lookbehind excludes the morning-context phrasings, exactly as
      // `dateExtract.ts`'s own tomorrow-phrase regex already does — copied
      // from there rather than re-derived, so the two do not quietly drift
      // apart on what counts as "morning" versus "tomorrow".
      /(?<!de la |por la |esta |la )\bma[ñn]ana\b/i,
    ],
  },
  {
    id: 'nextPeriod',
    thresholdMs: 21 * DAY_MS,
    patterns: [
      /\bnext (?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /下周[一二三四五六日天]?/,
      /\bla semaine prochaine\b/i,
      /\bla (?:pr[oó]xima semana|semana que viene)\b/i,
      /на следующей неделе/i,
      /الأسبوع القادم/,
    ],
  },
]

/**
 * `scheduledAt` is the epoch ms this message is actually due to leave.
 * `undefined` means "not meaningfully scheduled" (an immediate send, or a
 * repeating rule with no single fixed instant to compare against) and this
 * check simply has nothing to compare the phrase to — callers own that
 * decision, not this function. `ComposeView` only passes a value for a
 * one-off ("once") schedule, because a recurring reminder's body is written
 * once and re-read fresh at every firing: "your appointment is tomorrow" in
 * a weekly nag is correct every single week it fires, and this function has
 * no way to know that without being told the schedule is recurring — simplest
 * to just not be handed a `scheduledAt` for one.
 */
export function checkStaleDatePhrase(
  body: string,
  scheduledAt: number | undefined,
  now = Date.now(),
): GuardianFinding | null {
  if (typeof scheduledAt !== 'number' || !Number.isFinite(scheduledAt)) return null
  const delay = scheduledAt - now
  if (delay <= 0) return null

  const text = typeof body === 'string' ? body : ''

  for (const bucket of STALE_BUCKETS) {
    const hit = bucket.patterns.some((re) => re.test(text))
    if (hit && delay > bucket.thresholdMs) {
      return {
        rule: 'staleDate',
        key: 'sendGuardian.staleDate',
        severity: 'warning',
        values: { days: Math.round(delay / DAY_MS) },
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 3. A recipient's domain closely resembles one the user sends to often
// ---------------------------------------------------------------------------

/** Iterative (not recursive) Levenshtein distance — domains are short, but this runs on every keystroke's worth of recipients. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n]
}

/**
 * `typeof` first, not just an empty-string fallback: a `state.json` synced
 * from a slightly different schema version, or history handed in from a
 * source this module was not written against, could carry a non-string
 * `address` — and every caller of every check in this file gets that value
 * from state that was JSON-parsed off disk, not from a compiler that could
 * have caught it. See the module doc comment: a broken input must produce
 * "nothing to say" here, not a crash.
 */
function domainOf(address: string): string {
  if (typeof address !== 'string') return ''
  const at = address.lastIndexOf('@')
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase()
}

/** The shape this check needs out of `RecentRecipient` — deliberately not importing that type, so this stays usable against a plain contact list too. */
export interface DomainHistoryEntry {
  address: string
  count: number
}

export interface TypoDomainOptions {
  /**
   * A domain must have been sent to at least this many times before a
   * near-miss against it is worth mentioning. Below this, "often" is not
   * true yet, and the domain itself might be the typo.
   */
  minFamiliarUses?: number
}

const DEFAULT_MIN_FAMILIAR_USES = 3
/** Below this many characters, a distance-1 edit is nearly guaranteed by chance ("a.co" vs "b.co") and stops meaning anything. */
const MIN_DOMAIN_LENGTH = 5

export function checkTypoDomain(
  recipients: string[],
  history: DomainHistoryEntry[],
  opts: TypoDomainOptions = {},
): GuardianFinding | null {
  if (!Array.isArray(recipients) || !Array.isArray(history)) return null
  const minUses = opts.minFamiliarUses ?? DEFAULT_MIN_FAMILIAR_USES

  const totals = new Map<string, number>()
  for (const entry of history) {
    const d = domainOf(entry?.address)
    if (!d) continue
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0
    totals.set(d, (totals.get(d) ?? 0) + count)
  }
  const familiar = [...totals.entries()].filter(([, count]) => count >= minUses).map(([d]) => d)
  if (familiar.length === 0) return null
  const familiarSet = new Set(familiar)

  for (const recipient of recipients) {
    const candidate = domainOf(recipient)
    if (!candidate || candidate.length < MIN_DOMAIN_LENGTH) continue
    // The recipient's own domain is itself well-established — not a typo,
    // whatever it happens to look like next to.
    if (familiarSet.has(candidate)) continue
    for (const known of familiar) {
      const dist = levenshtein(candidate, known)
      if (dist >= 1 && dist <= 2) {
        return {
          rule: 'typoDomain',
          key: 'sendGuardian.typoDomain',
          severity: 'warning',
          values: { typo: candidate, suggestion: known },
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 4. Many recipients, all in To rather than Bcc
// ---------------------------------------------------------------------------

export interface MassToOptions {
  threshold?: number
}

const DEFAULT_MASS_TO_THRESHOLD = 15

export function checkMassTo(
  draft: Pick<MessageDraft, 'to' | 'bcc' | 'individualDelivery' | 'mergeEnabled'>,
  opts: MassToOptions = {},
): GuardianFinding | null {
  if (!Array.isArray(draft?.to) || !Array.isArray(draft?.bcc)) return null
  // Both of these already send one message per recipient — nobody's address
  // is exposed to anybody else, so the whole premise of this check is moot.
  if (draft.individualDelivery || draft.mergeEnabled) return null
  // Some Bcc use is already the thing this check would suggest; do not pile
  // on for a draft that already has the right idea.
  if (draft.bcc.length > 0) return null
  const threshold = opts.threshold ?? DEFAULT_MASS_TO_THRESHOLD
  if (draft.to.length < threshold) return null
  return {
    rule: 'massTo',
    key: 'sendGuardian.massTo',
    severity: 'warning',
    values: { n: draft.to.length },
  }
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface SendGuardianInput {
  body: string
  to: string[]
  cc: string[]
  bcc: string[]
  attachmentCount: number
  individualDelivery: boolean
  mergeEnabled?: boolean
  /** See `checkStaleDatePhrase`'s doc comment for when to pass this. */
  scheduledAt?: number
  recipientHistory: DomainHistoryEntry[]
  now?: number
}

/**
 * Run every check and collect whatever they find.
 *
 * Each is wrapped individually. `validateDraft` and `buildPreflight` are
 * allowed to throw on a genuinely malformed draft, because their callers
 * treat that as "cannot confirm this is safe to send" and act accordingly —
 * but this banner is advisory on top of an already-valid draft, and a bug in
 * one heuristic (a pathological regex, a history entry that slips past every
 * guard) must not take the other three down with it, and must never be a
 * reason composing a message stops working.
 */
export function runSendGuardian(input: SendGuardianInput): GuardianFinding[] {
  const now = input.now ?? Date.now()
  const findings: GuardianFinding[] = []
  const run = (fn: () => GuardianFinding | null) => {
    try {
      const finding = fn()
      if (finding) findings.push(finding)
    } catch {
      // Silently skipped — see the doc comment above.
    }
  }
  run(() => checkMissingAttachment(input.body, input.attachmentCount))
  run(() => checkStaleDatePhrase(input.body, input.scheduledAt, now))
  run(() => checkTypoDomain([...input.to, ...input.cc, ...input.bcc], input.recipientHistory))
  run(() =>
    checkMassTo({
      to: input.to,
      bcc: input.bcc,
      individualDelivery: input.individualDelivery,
      mergeEnabled: input.mergeEnabled,
    }),
  )
  return findings
}
