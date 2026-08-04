/**
 * Who to offer as a recipient, ranked and grouped.
 *
 * Pulled out of the tag field so the inline dropdown and the full picker card
 * cannot rank the same people differently — two views of one list that disagree
 * about the order is the kind of thing nobody reports as a bug and everybody
 * finds confusing.
 *
 * Everything here is pure so it can be exercised without a DOM; the guard in
 * `scripts/check-recipients.mjs` does exactly that.
 */

import type { Contact, RecentRecipient } from './types'

/** One offerable address, whichever list it came from. */
export interface Pick {
  /** Lower-cased address. The identity of a person, for this purpose. */
  key: string
  name: string
  address: string
  /** Pinned contacts and frequent correspondents sort above the rest. */
  weight: number
  pinned?: boolean
  /** Every tag the contact carries, so one address can appear in several groups. */
  tags: string[]
  /** True when the address is only known from history, not from the contact book. */
  historyOnly: boolean
}

/**
 * Merge the contact book with the sent-to history into one ranked list.
 *
 * The two answer different questions — "who do I know" and "who do I actually
 * write to" — and the field needs a single order. An address in both keeps the
 * contact's name and gains the history's weight. Weights are deliberately
 * coarse: pinned beats frequent beats merely known, and the exact ordering
 * inside a band matters far less than the bands being right.
 */
export function buildPool(suggestions: Contact[], recents: RecentRecipient[]): Pick[] {
  const byAddress = new Map<string, Pick>()
  for (const c of suggestions) {
    const key = c.address.toLowerCase()
    // A contact book with the same address twice is a data-entry accident, not
    // two people; keep the first and let the second only contribute its tags.
    const existing = byAddress.get(key)
    if (existing) {
      for (const tag of c.tags) if (tag && !existing.tags.includes(tag)) existing.tags.push(tag)
      if (c.pinned) {
        existing.pinned = true
        existing.weight = Math.max(existing.weight, 1000)
      }
      continue
    }
    byAddress.set(key, {
      key,
      name: c.name,
      address: c.address,
      weight: c.pinned ? 1000 : 10,
      pinned: c.pinned,
      tags: c.tags.filter(Boolean),
      historyOnly: false,
    })
  }
  for (const r of recents) {
    const key = r.address.toLowerCase()
    const existing = byAddress.get(key)
    // Damped, so one address written to forty times cannot bury everyone.
    const bump = Math.min(400, Math.log2(r.count + 1) * 60)
    if (existing) existing.weight += bump
    else {
      byAddress.set(key, {
        key,
        name: r.name ?? '',
        address: r.address,
        weight: bump,
        tags: [],
        historyOnly: true,
      })
    }
  }
  return [...byAddress.values()].sort(
    (a, b) => b.weight - a.weight || a.address.localeCompare(b.address),
  )
}

/** Initials for the round badge: "Wei Chen" → "W", "wei@…" → "W". */
export function initialOf(pick: Pick): string {
  const source = pick.name.trim() || pick.address
  return source.slice(0, 1).toUpperCase()
}

/**
 * Would this person match what has been typed?
 *
 * Matches on name and address, and on the *initials* of a multi-word name, so
 * "wc" finds "Wei Chen" — typing initials is how people reach for a name they
 * already know, and requiring the full spelling makes the completion useful
 * only to people who did not need it. Tags match too: typing a group name in
 * the recipient box and getting that group's members is the obvious reading.
 */
export function matchesQuery(pick: Pick, q: string): boolean {
  const query = q.trim().toLowerCase()
  if (query.length === 0) return true
  if (pick.name.toLowerCase().includes(query)) return true
  if (pick.address.toLowerCase().includes(query)) return true
  if (pick.tags.some((tag) => tag.toLowerCase().includes(query))) return true
  const initials = pick.name
    .split(/[\s·,]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toLowerCase() ?? '')
    .join('')
  return initials.length > 1 && initials.startsWith(query)
}

/** A titled run of people in the picker card. */
export interface PickSection {
  /** `tag:<name>` for a contact tag, or one of the fixed section ids. */
  id: string
  /** A contact tag, or empty for the fixed sections (the view supplies those labels). */
  tag: string
  kind: 'pinned' | 'tag' | 'untagged' | 'history'
  picks: Pick[]
}

/**
 * Arrange the pool into the sections the card draws.
 *
 * Order is fixed rather than by size: pinned, then tags alphabetically, then
 * everyone else, then addresses known only from history. A list whose sections
 * move around as contacts are added is a list you have to re-read every time.
 *
 * A contact with several tags appears under each of them. That is intended —
 * "select the whole group" has to work for every group they are in, and the
 * selection is by address, so ticking them twice is still one recipient.
 */
export function sectionsOf(pool: Pick[]): PickSection[] {
  const pinned = pool.filter((p) => p.pinned)
  const byTag = new Map<string, Pick[]>()
  const untagged: Pick[] = []
  const history: Pick[] = []
  for (const p of pool) {
    if (p.pinned) continue
    if (p.historyOnly) {
      history.push(p)
      continue
    }
    if (p.tags.length === 0) {
      untagged.push(p)
      continue
    }
    for (const tag of p.tags) {
      const bucket = byTag.get(tag) ?? []
      bucket.push(p)
      byTag.set(tag, bucket)
    }
  }
  const sections: PickSection[] = []
  if (pinned.length > 0) sections.push({ id: 'pinned', tag: '', kind: 'pinned', picks: pinned })
  for (const [tag, picks] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sections.push({ id: `tag:${tag}`, tag, kind: 'tag', picks })
  }
  if (untagged.length > 0) sections.push({ id: 'untagged', tag: '', kind: 'untagged', picks: untagged })
  if (history.length > 0) sections.push({ id: 'history', tag: '', kind: 'history', picks: history })
  return sections
}

/** none / some / all of `picks` are already selected. */
export type GroupState = 'none' | 'some' | 'all'

export function groupState(picks: Pick[], taken: Set<string>): GroupState {
  if (picks.length === 0) return 'none'
  let hit = 0
  for (const p of picks) if (taken.has(p.key)) hit += 1
  if (hit === 0) return 'none'
  return hit === picks.length ? 'all' : 'some'
}

/**
 * Add every address in `picks`, keeping what is already there.
 *
 * Case is preserved from whatever went in first, which is why this dedupes on
 * the lower-cased key rather than trusting the caller's spelling.
 */
export function addAll(values: string[], picks: Pick[]): string[] {
  const seen = new Set(values.map((v) => v.trim().toLowerCase()))
  const next = [...values]
  for (const p of picks) {
    if (seen.has(p.key)) continue
    seen.add(p.key)
    next.push(p.address)
  }
  return next
}

/** Drop every address in `picks`, leaving anything typed by hand untouched. */
export function removeAll(values: string[], picks: Pick[]): string[] {
  const drop = new Set(picks.map((p) => p.key))
  return values.filter((v) => !drop.has(v.trim().toLowerCase()))
}

/** Tick or untick one person. */
export function togglePick(values: string[], pick: Pick): string[] {
  const taken = new Set(values.map((v) => v.trim().toLowerCase()))
  return taken.has(pick.key) ? removeAll(values, [pick]) : addAll(values, [pick])
}
