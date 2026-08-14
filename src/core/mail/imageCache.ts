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

import { asProxiedImage, failedImage, type ProxiedImage } from './imageProxy'

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

/**
 * A whole verdict, not a data URI.
 *
 * This memo used to hold `string | null` — the picture, or nothing. That was
 * enough while the only question was "what are the bytes". The proxy now
 * answers three more (was it refused, why, and did it look like a tracking
 * pixel), and those have to travel with the picture: a reopened message reads
 * entirely out of caches, so anything not carried here is a fact the second
 * open cannot state. See `core/mail/imageProxy.ts`.
 */
type Entry = { result: ProxiedImage; at: number }

/** Insertion-ordered, which is what makes the eviction below least-recently-used. */
const cache = new Map<string, Entry>()

export function getCached(url: string): ProxiedImage | undefined {
  const entry = cache.get(url)
  if (!entry) return undefined
  /*
   * A stale failure reports as "never seen", so the next resolve retries it.
   *
   * `failed` only — never `blocked`. A network failure is weather and is worth
   * trying again; a scanner refusal is a property of the bytes themselves, and
   * retrying it would mean a fresh request to the sender's server on every
   * reopen, which is exactly the signal the proxy exists to stop sending.
   * Successes never expire: the bytes cannot go bad.
   */
  if (entry.result.status === 'failed' && Date.now() - entry.at > FAILURE_TTL_MS) {
    cache.delete(url)
    return undefined
  }
  // Re-inserting moves it to the end, so "oldest" really means least recently
  // used rather than first ever seen.
  cache.delete(url)
  cache.set(url, entry)
  return entry.result
}

/**
 * Remember a result — including a failure, but only for `FAILURE_TTL_MS`.
 */
export function putCached(url: string, result: ProxiedImage): void {
  cache.delete(url)
  cache.set(url, { result, at: Date.now() })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/**
 * Drop remembered failures for these URLs, so an explicit retry really retries.
 *
 * Blocked images are left alone on purpose: "try again" is offered for pictures
 * that did not arrive, and a picture the scanner refused did arrive. Re-running
 * the scanner over identical bytes produces an identical refusal and costs
 * another request to the sender.
 */
export function forgetFailures(urls: string[]): void {
  for (const url of urls) {
    if (cache.get(url)?.result.status === 'failed') cache.delete(url)
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
  fetchOne: (url: string) => Promise<ProxiedImage | string>,
  options?: { retryFailures?: boolean },
): Promise<ProxiedImage[]> {
  if (options?.retryFailures) forgetFailures(urls)

  const missing = urls.filter((url) => getCached(url) === undefined)
  // Deduplicated: the same pixel repeated twelve times in one newsletter is one
  // request, not twelve.
  const unique = [...new Set(missing)]

  await Promise.all(
    unique.map(async (url) => {
      try {
        let result = asProxiedImage(await fetchOne(url))
        /*
         * One silent retry for a `fetchFailed` result, before the reader ever
         * sees a failure banner for it.
         *
         * `fetchFailed` is weather — a TLS handshake reset mid-way, a
         * momentary DNS hiccup — not a verdict about the picture, and it is
         * common enough on an ordinary connection that a message opened
         * seconds after it arrives (before the prefetch queue's own retries,
         * see `electron/imagePrefetch.ts`, have had a turn) used to surface
         * it to the reader on the very first try. `blocked` results are left
         * alone: those are the scanner's own decision about bytes that did
         * arrive, and asking again reaches the same decision at the cost of
         * a second request to the sender.
         */
        if (result.status === 'failed' && result.reason === 'fetchFailed') {
          result = asProxiedImage(await fetchOne(url))
        }
        putCached(url, result)
      } catch (e) {
        putCached(url, failedImage('fetchFailed', e instanceof Error ? e.message : String(e)))
      }
    }),
  )

  return urls.map((url) => getCached(url) ?? failedImage('fetchFailed'))
}

/** Only for tests and for "forget everything" in settings. */
export function clearImageCache(): void {
  cache.clear()
}

export function imageCacheSize(): number {
  return cache.size
}
