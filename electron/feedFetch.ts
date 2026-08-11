/**
 * The trusted side of the two allow-listed public feeds.
 *
 * This lives in the main process for one reason: the renderer is forbidden to
 * open a socket (`connect-src 'self'` in `index.html`), and that restriction is
 * worth keeping. See `src/core/schedule/feeds.ts` for what "allow-listed" means and why
 * the alternative — widening the policy by one line — was rejected.
 *
 * `undici`'s global `fetch` is used rather than the hardened `https.request`
 * plumbing next door in `remoteImage.ts`, and that is a deliberate difference:
 * that file's machinery exists to defend against *attacker-chosen hosts*
 * arriving inside a message body, where DNS rebinding onto a loopback service
 * is a live risk. Here the host and the path are both fixed at compile time and
 * checked again below, so there is no attacker-chosen anything to defend
 * against. `update.ts` has always fetched this way from this process.
 */

import { isAllowedFeedUrl, MAX_FEED_BYTES, type FeedResponse } from '../src/core/schedule/feeds'

const TIMEOUT_MS = 10_000

export async function fetchFeed(url: string): Promise<FeedResponse> {
  if (!isAllowedFeedUrl(url)) {
    // Not a network error and must not read like one. The renderer cannot
    // reach this branch by accident: both URLs are built by constant functions.
    throw new Error(`Refusing to fetch ${url} — not an allow-listed feed`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      // Redirects are followed by default. GitHub does not currently redirect
      // either of these, but if it starts, a silently broken feature is worse
      // than a followed hop — so long as the destination is re-checked.
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Aevistle',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    // `response.url` is the *final* URL after any hops. Checking it is the
    // whole point of allowing redirects at all.
    if (response.redirected && !isAllowedFeedUrl(response.url)) {
      throw new Error(`Redirected off the allow-list, to ${response.url}`)
    }

    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_FEED_BYTES) {
      throw new Error('The feed is larger than this app will read')
    }

    const body = await response.text()
    if (body.length > MAX_FEED_BYTES) {
      throw new Error('The feed is larger than this app will read')
    }

    // Non-2xx comes back as data, not as a throw: a 404 from the holiday feed
    // means "that year has not been published yet", which is a true and useful
    // answer, and only the caller knows that.
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}
