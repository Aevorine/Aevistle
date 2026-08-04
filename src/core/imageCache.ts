/**
 * In-memory memo for remote images already fetched in this session.
 *
 * Images in a received message load by default now (see `RemoteImagePolicy`),
 * so this runs on every open of every HTML message rather than only after a
 * deliberate click. Reopening the same newsletter must not re-announce the
 * reader to the same server, and must not spend the same seconds again — so
 * the memo matters more than it did, not less.
 *
 * Still keyed by URL and never by message: the same tracking pixel appears in
 * a hundred newsletters, and fetching it once is the point.
 *
 * This layer is deliberately memory-only and small; the durable copy lives in
 * the main process (`electron/remoteImage.ts`), which is also the only place
 * that can bound it by bytes on disk. Renderer-side there is no byte count to
 * bound — a data URL's length is a poor proxy and `localStorage` is the wrong
 * store for megabytes of them.
 */

/** Entries before the oldest is dropped. Data URLs are large; this is not a lot of memory at 60. */
const MAX_ENTRIES = 60

/**
 * How long a failure is believed.
 *
 * Failures used to be cached for the life of the process, which turned one
 * flaky minute — a lost Wi-Fi association, a CDN hiccup, a server that 503s
 * under load — into "this message has no pictures" until the app was
 * restarted. They are still cached, because a private-address refusal really
 * will be refused identically a second later and hammering it on every reopen
 * is a slow way to get the same answer. They just expire.
 */
const FAILURE_TTL_MS = 60_000

type Entry = { dataUrl: string | null; at: number }

/** Insertion-ordered, which is what makes the eviction below least-recently-used. */
const cache = new Map<string, Entry>()

export function getCached(url: string): string | null | undefined {
  const entry = cache.get(url)
  if (!entry) return undefined
  // A stale failure reports as "never seen", so the next resolve retries it.
  // Successes never expire here: the bytes cannot go bad, and the size cap is
  // what bounds them.
  if (entry.dataUrl === null && Date.now() - entry.at > FAILURE_TTL_MS) {
    cache.delete(url)
    return undefined
  }
  // Re-inserting moves it to the end, so "oldest" really means least recently
  // used rather than first ever seen.
  cache.delete(url)
  cache.set(url, entry)
  return entry.dataUrl
}

/**
 * Remember a result — including a failure, but only for `FAILURE_TTL_MS`.
 */
export function putCached(url: string, dataUrl: string | null): void {
  cache.delete(url)
  cache.set(url, { dataUrl, at: Date.now() })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** Drop remembered failures for these URLs, so an explicit retry really retries. */
export function forgetFailures(urls: string[]): void {
  for (const url of urls) {
    if (cache.get(url)?.dataUrl === null) cache.delete(url)
  }
}

/**
 * Resolve a list of URLs, fetching only the ones not already known.
 * Returns results in the same order as the input, as the caller expects;
 * `null` in a slot means that URL could not be fetched.
 *
 * `retryFailures` is for the user pressing "try again": without it, the retry
 * would be answered instantly out of the negative cache and would look like
 * the button does nothing.
 */
export async function resolveWithCache(
  urls: string[],
  fetchOne: (url: string) => Promise<string>,
  options?: { retryFailures?: boolean },
): Promise<Array<string | null>> {
  if (options?.retryFailures) forgetFailures(urls)

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
