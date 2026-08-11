/**
 * The stored side of code extraction: merging fresh hits into the kept list,
 * and the recent-recipient tally the compose screen's quick picks read.
 *
 * Kept out of the reducer so the merge rules — what counts as the same hit,
 * what a re-sync is allowed to overwrite — are stated once and testable on
 * their own, the same way `core/snapshots` and `core/outbox` are.
 */

import { newId, type CodeHit, type RecentRecipient } from '../types'

/**
 * How many hits to keep. Fifty is roughly a month of ordinary use, and the
 * whole list is serialised into `state.json` on every change — an unbounded
 * one would grow a file that is written on a debounce.
 */
export const CODE_HISTORY_CAP = 50

/** Beyond this the panel is showing history, not "what just arrived". */
export const CODE_FRESH_MS = 10 * 60_000

export const RECENT_RECIPIENT_CAP = 40

/**
 * Two hits are the same hit when the same message yielded the same value.
 *
 * Not keyed on the message alone: one mail legitimately carries both a code
 * and a sign-in link, and they are two separate things to copy. Not keyed on
 * the value alone either — the same six digits arriving in a *new* mail an
 * hour later is genuinely new, and collapsing them would show a stale
 * timestamp for a code that had just been re-sent.
 */
function keyOf(hit: Pick<CodeHit, 'messageId' | 'kind' | 'value'>): string {
  return `${hit.messageId}\x00${hit.kind}\x00${hit.value}`
}

export type NewHit = Omit<CodeHit, 'id' | 'foundAt' | 'copiedAt'>

/**
 * Fold freshly extracted hits into the kept list, newest first.
 *
 * Returns the *same array reference* when nothing is new. Extraction re-runs
 * whenever a body lands in the cache, which on a busy sync is a dozen times in
 * a second; handing back a new array each time would re-render the panel — and
 * on a screen whose whole job is to hold still long enough to be read, that is
 * worse than it sounds.
 */
export function mergeHits(existing: CodeHit[], incoming: NewHit[], now = Date.now()): CodeHit[] {
  if (incoming.length === 0) return existing
  const seen = new Set(existing.map(keyOf))
  const fresh: CodeHit[] = []
  for (const hit of incoming) {
    const key = keyOf(hit)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push({ ...hit, id: newId('code'), foundAt: now })
  }
  if (fresh.length === 0) return existing
  return [...fresh, ...existing]
    .sort((a, b) => b.date - a.date || b.foundAt - a.foundAt)
    .slice(0, CODE_HISTORY_CAP)
}

/**
 * Newest-first, and only what is still worth calling "just arrived".
 *
 * Recency alone — this says nothing about whether the user has dealt with the
 * hit. That makes it the right question for a *decoration* (the `data-fresh`
 * mark on a card in `views/CodesView`, which means "this one is probably still
 * valid") and the wrong question for a *count* of outstanding work. For the
 * latter use `actionableHits` below.
 */
export function freshHits(hits: CodeHit[], now = Date.now()): CodeHit[] {
  return hits.filter((h) => now - h.date <= CODE_FRESH_MS)
}

/**
 * What still needs the user: recent *and* unread.
 *
 * This exists because the same idea was being spelled out in two places that
 * disagreed. The nav badge in `App.tsx` counted `freshHits` — recency only —
 * while `views/CodesView` had long since settled on "unread outranks fresh"
 * for its subtitle, on the grounds that an unread code from an hour ago
 * matters more than a read one from a minute ago. The visible bug was that
 * "全部标为已读" set `readAt` on every hit, the cards all changed state, and
 * the badge went on showing the same number — because nothing the button did
 * was an input to the number. To the user the button simply did nothing.
 *
 * So the rule lives here, once, and both halves of it are load-bearing.
 * Dropping `readAt` gives back the bug above. Dropping the recency window
 * gives a badge that never clears on its own: a code that expired overnight
 * and was never copied is not work, it is history, and a badge that can only
 * be dismissed by hand is one people learn to stop reading.
 *
 * Anything that wants "is this code plausibly still usable" — a card's own
 * freshness mark, say — wants `freshHits`, not this.
 */
export function actionableHits(hits: CodeHit[], now = Date.now()): CodeHit[] {
  /* `!h.readAt`, not `readAt === undefined`, to match how every other reader
     of this field asks the question (`views/CodesView`, the `markCodeRead`
     reducer in `state/AppState`). A `readAt` of 0 is not a real timestamp,
     and one arriving from a hand-edited or migrated `state.json` should read
     as "unread" everywhere or nowhere — not as unread here and read there. */
  return freshHits(hits, now).filter((h) => !h.readAt)
}

/**
 * Record that these addresses were just sent to.
 *
 * Ranked by recency *and* count, so a colleague written to weekly for a year
 * does not drop below someone mailed once this morning — the complaint against
 * a pure most-recently-used list — while a genuinely new correspondent still
 * appears immediately.
 */
export function recordRecipients(
  existing: RecentRecipient[],
  addresses: string[],
  names: Record<string, string> = {},
  now = Date.now(),
): RecentRecipient[] {
  if (addresses.length === 0) return existing
  const byAddress = new Map(existing.map((r) => [r.address.toLowerCase(), r]))
  for (const raw of addresses) {
    const address = raw.trim()
    if (!address) continue
    const key = address.toLowerCase()
    const prev = byAddress.get(key)
    byAddress.set(key, {
      address: prev?.address ?? address,
      name: names[address] ?? names[key] ?? prev?.name,
      count: (prev?.count ?? 0) + 1,
      lastUsedAt: now,
    })
  }
  return [...byAddress.values()].sort(rankRecipients).slice(0, RECENT_RECIPIENT_CAP)
}

/**
 * Frequency first, recency as the tiebreak — but frequency is damped, so ten
 * mails to one address cannot bury everything else forever.
 */
export function rankRecipients(a: RecentRecipient, b: RecentRecipient): number {
  const score = (r: RecentRecipient) => Math.log2(r.count + 1) * 86_400_000 + r.lastUsedAt
  return score(b) - score(a)
}
