/**
 * Fetch a message's remote pictures when the message arrives, not when it is
 * read.
 *
 * This is the piece that makes the whole privacy claim true, and it is worth
 * being exact about why, because the pipeline in `imageProxy.ts` — scanning,
 * re-encoding, refusing SVG — is about *what the bytes can do to you*, and this
 * file is about something completely different: *what the request tells the
 * sender about you*.
 *
 *     without prefetch      14:27 open -> 12 requests to the sender's servers
 *                           14:31 open again -> 12 more
 *                           never opened -> 0, which is itself the answer
 *
 *     with prefetch         10:03 arrives -> 12 requests, from the sync
 *                           14:27 open -> 0 requests
 *                           14:31 open again -> 0
 *                           never opened -> the same 12 as if it were read
 *
 * The bottom row is the one that matters most and is the least obvious. Open
 * tracking works because "no request" and "request" are distinguishable. After
 * prefetch they are not: every message that arrives produces exactly one round
 * of fetches whether it is read once, read forty times, or never opened at all.
 * The sender's "opened" column stops describing the reader.
 *
 * ## Why this is a queue and not a loop
 *
 * A sync can bring in fifty messages carrying six hundred images between them.
 * Firing those at once would open six hundred sockets, stall the machine, and
 * make the burst itself a fingerprint. `CONCURRENCY` holds it to a trickle, and
 * the queue is bounded so a mailbox full of newsletters cannot grow it without
 * limit.
 *
 * ## What it deliberately does not do
 *
 * It does not know or care which account a URL came from, and it does not
 * record what it fetched. The cache is keyed by URL hash alone (see
 * `remoteImage.ts`), so nothing here builds a per-message history of anything.
 * A *permanent* failure — the scanner refusing the bytes, the SSRF shield
 * refusing the target — is dropped silently, on purpose: this is speculative
 * work for a message nobody has asked for yet, and re-running an identical
 * request against an identical refusal has no better outcome to find. A
 * *transient* one is not the same fact and gets `MAX_RETRIES` below instead —
 * see the note there for why a single dropped TLS handshake used to mean an
 * image nobody would ever see prefetched, silently, for the rest of the
 * session, with the open-time path left to run into the same dead end and
 * report it as if the sender's server had never had the picture at all.
 */

import { downloadRemoteImage, isImageCached } from './remoteImage'

/** Sockets in flight across the whole app. Small on purpose — nobody is waiting. */
const CONCURRENCY = 3

/**
 * How many URLs may be waiting at once.
 *
 * A first sync of a busy mailbox is fifty messages of newsletters; past this
 * the oldest waiting entries are dropped rather than the newest refused, since
 * the newest message is the one most likely to be read next.
 */
const MAX_QUEUE = 2_000

/**
 * Pause between fetches, per worker.
 *
 * Not rate limiting for the server's sake — it is so the burst does not arrive
 * as one identifiable clump the instant a sync finishes. Cheap, and it keeps
 * the prefetch off the same few hundred milliseconds the UI is using to render
 * the new message list.
 */
const SPACING_MS = 120

/** URLs waiting, oldest first. A Set so the same pixel in thirty newsletters queues once. */
const queue = new Set<string>()
let workers = 0
let paused = false

/**
 * URLs already handled this session.
 *
 * The on-disk cache is the real answer and is checked before every fetch, but
 * that is an async file read per URL and a sync can offer the same tracking
 * pixel two hundred times in one pass. This is the cheap first filter; it is
 * bounded and cleared wholesale rather than aged, because precision costs more
 * than an occasional extra cache read is worth.
 */
const seen = new Set<string>()
const SEEN_MAX = 10_000

/**
 * How many times a *transient* prefetch failure gets a second look, and how
 * long it waits before the next one.
 *
 * Before this, one dropped connection — a TLS handshake reset mid-way, a
 * momentary DNS hiccup, a proxy having a bad second — was final: the worker's
 * `try/catch` never inspected what `downloadRemoteImage` actually returned,
 * so a `failed` verdict and an `ok` one were handled identically, and `seen`
 * (below) then blocked that URL from ever being offered to the queue again
 * for the rest of the session. The image was never cached, so the open-time
 * path tried it again from scratch — and if the same brief network condition
 * was still in effect, hit the identical failure and reported it verbatim
 * ("the sending server did not hand the images over"), which is how a
 * one-second blip during sync turned into a message that looked permanently
 * broken.
 *
 * Excludes `refusedTarget` on purpose: that verdict is this app's own
 * decision about the address, arrived at *before* any request left the
 * machine (see `assertFetchable`), and asking again is not going to leave
 * with a different answer.
 *
 * Bounded and capped, not because retrying is dangerous — a retry runs the
 * exact same SSRF-shielded fetch → scan → re-encode pipeline as the first
 * attempt, with nothing new exposed to the sender's server or trusted from
 * it — but because this is still speculative work for a message nobody has
 * opened, and three attempts spread over a few seconds is a generous
 * allowance for weather to pass without turning a genuinely dead server into
 * a background loop.
 */
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 4_000

/** Retry attempts already spent per URL this session. Cleared with `seen`. */
const retriesUsed = new Map<string, number>()

/**
 * Stop prefetching, and forget what is queued.
 *
 * Called when the policy turns off and by "reset everything". A queue that
 * survived the setting being switched off would keep making exactly the
 * requests the user just asked it to stop making.
 */
export function stopImagePrefetch(): void {
  paused = true
  queue.clear()
  seen.clear()
  retriesUsed.clear()
}

/** Allow prefetching again. */
export function resumeImagePrefetch(): void {
  paused = false
}

/**
 * Offer a message's remote images to the queue.
 *
 * Called from the one place a body is parsed and cached — see
 * `parseCacheAndReturn` in `imap.ts` — so eager sync bodies and on-demand ones
 * both feed it without either path having to remember to.
 *
 * Returns immediately. Nothing waits for this, and nothing is allowed to fail
 * because of it: a message must render whether or not its pictures were
 * prefetched.
 */
export function prefetchImages(urls: readonly string[]): void {
  if (paused || urls.length === 0) return
  for (const url of urls) {
    if (seen.has(url) || queue.has(url)) continue
    if (queue.size >= MAX_QUEUE) {
      // Drop the oldest waiting entry. `Set` iterates in insertion order, so
      // the first value is the one that has been waiting longest.
      const oldest = queue.values().next()
      if (!oldest.done) queue.delete(oldest.value)
    }
    queue.add(url)
  }
  pump()
}

function pump(): void {
  while (!paused && workers < CONCURRENCY && queue.size > 0) {
    workers++
    void worker()
  }
}

async function worker(): Promise<void> {
  try {
    for (;;) {
      if (paused) return
      const next = queue.values().next()
      if (next.done) return
      const url = next.value
      queue.delete(url)

      if (seen.size >= SEEN_MAX) {
        seen.clear()
        retriesUsed.clear()
      }
      seen.add(url)

      try {
        // Two guards, and both earn their place: `isImageCached` is what stops
        // a restart re-fetching everything already on disk, and the try/catch
        // is because this is speculative work — a failure here must never
        // become an unhandled rejection in the main process.
        if (!(await isImageCached(url))) {
          const result = await downloadRemoteImage(url)
          if (result.status === 'failed' && result.reason === 'fetchFailed') {
            const used = retriesUsed.get(url) ?? 0
            if (used < MAX_RETRIES) {
              retriesUsed.set(url, used + 1)
              // `seen` already holds `url`, so this cannot go through
              // `prefetchImages()` — its dedup guard exists for the ordinary
              // case (the same pixel offered by thirty newsletters) and would
              // silently drop exactly the retry this is trying to schedule.
              setTimeout(() => {
                if (paused) return
                queue.add(url)
                pump()
              }, RETRY_DELAY_MS)
            }
          }
        }
      } catch {
        /* speculative work for a message nobody has opened; nothing to report */
      }

      if (SPACING_MS > 0) await new Promise((r) => setTimeout(r, SPACING_MS))
    }
  } finally {
    workers--
    // A worker that ran out of queue while another was still adding to it must
    // not leave the remainder stranded.
    if (!paused && queue.size > 0 && workers < CONCURRENCY) pump()
  }
}

/** How much is still waiting — for the diagnostics panel, and for tests. */
export function imagePrefetchDepth(): number {
  return queue.size
}
