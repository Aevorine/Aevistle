/**
 * In-memory cache for remote images that have already been fetched once.
 *
 * Loading images in a message is an explicit, per-message decision — the
 * default is not to, because a remote image is a read receipt the sender gets
 * whether you agreed to one or not. Once that decision is made, though,
 * closing the message and opening it again should not re-announce you to the
 * same server, and should not spend the same seconds again.
 *
 * Deliberately **in memory only**. Writing these to disk would turn "show
 * images just this once" into a permanent copy of tracking pixels on the
 * user's machine, which is not what anyone meant by pressing the button. It is
 * also why the cache is keyed by URL and never by message: the same tracking
 * pixel appears in a hundred newsletters, and fetching it once is the point.
 */

/** Entries before the oldest is dropped. Data URLs are large; this is not a lot of memory at 60. */
const MAX_ENTRIES = 60

/** Insertion-ordered, which is what makes the eviction below least-recently-used. */
const cache = new Map<string, string | null>()

export function getCached(url: string): string | null | undefined {
  if (!cache.has(url)) return undefined
  const value = cache.get(url)!
  // Re-inserting moves it to the end, so "oldest" really means least recently
  // used rather than first ever seen.
  cache.delete(url)
  cache.set(url, value)
  return value
}

/**
 * Remember a result — including a failure.
 *
 * `null` (the fetch was refused or blocked) is cached on purpose: a private
 * address that the SSRF guard rejected will be rejected identically next time,
 * and retrying it on every reopen is a slow way to get the same answer.
 */
export function putCached(url: string, dataUrl: string | null): void {
  cache.delete(url)
  cache.set(url, dataUrl)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/**
 * Resolve a list of URLs, fetching only the ones not already known.
 * Returns results in the same order as the input, as the caller expects.
 */
export async function resolveWithCache(
  urls: string[],
  fetchOne: (url: string) => Promise<string>,
): Promise<Array<string | null>> {
  const missing = urls.filter((url) => getCached(url) === undefined)
  // Deduplicated: the same pixel repeated twelve times in one newsletter is one
  // request, not twelve.
  const unique = [...new Set(missing)]

  await Promise.all(
    unique.map(async (url) => {
      try {
        putCached(url, await fetchOne(url))
      } catch {
        putCached(url, null)
      }
    }),
  )

  return urls.map((url) => getCached(url) ?? null)
}

/** Only for tests and for "forget everything" in settings. */
export function clearImageCache(): void {
  cache.clear()
}

export function imageCacheSize(): number {
  return cache.size
}
