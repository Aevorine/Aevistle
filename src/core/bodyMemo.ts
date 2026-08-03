/**
 * One in-memory cache of fetched message bodies, shared by everything that
 * needs one.
 *
 * There are now two readers — the inbox screen, and the app-wide code watcher
 * that runs whether or not that screen is open — and before this they each
 * kept their own. That meant opening the inbox re-fetched, over IMAP, bodies
 * the watcher had already pulled seconds earlier, and the duplicate arrived
 * exactly when the user was waiting for the list to paint.
 *
 * Module-level rather than context: it is a cache, not state. Nothing renders
 * from it directly, a stale entry is impossible (bodies do not change), and
 * putting it in the store would serialise megabytes of HTML into `state.json`.
 */

import type { InboxMessageBody } from './bridge'

/**
 * Bounded, because a long session that scrolls a large mailbox would otherwise
 * hold every body it ever rendered. Insertion-ordered eviction: `Map` keeps
 * insertion order, so the oldest key is the first one iteration yields.
 */
const MAX_ENTRIES = 120

const cache = new Map<string, InboxMessageBody>()

export function getCachedBody(id: string): InboxMessageBody | undefined {
  return cache.get(id)
}

export function putCachedBody(id: string, body: InboxMessageBody): void {
  if (cache.has(id)) cache.delete(id)
  cache.set(id, body)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

export function dropCachedBodies(ids: Iterable<string>): void {
  for (const id of ids) cache.delete(id)
}
