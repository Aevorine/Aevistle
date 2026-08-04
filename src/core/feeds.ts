/**
 * The two public files this application is allowed to read over the network,
 * and the single place that decides so.
 *
 * ## Why this file exists at all
 *
 * The renderer cannot make these requests. `index.html` ships
 * `connect-src 'self'`, deliberately — a sanitized message body has no
 * business opening a socket, and the narrowest way to guarantee that is to
 * give the whole document no outbound reach. Two features were nonetheless
 * written as renderer-side `fetch()` calls and both failed the same way, with
 * a bare `TypeError: Failed to fetch` that reads like a network fault and is
 * not one:
 *
 *   - the working calendar's "check online" button (`cnHolidays.ts`), on every
 *     year, because the year was never the problem;
 *   - the Android in-app update check (`update.ts`), which has never worked in
 *     a shipped build. The desktop check appeared fine only because it happens
 *     to be routed through the main process, where no CSP applies.
 *
 * So the transport moves out of the renderer instead of the policy being
 * widened. Widening `connect-src` would have been one line and would have
 * handed every other code path in the document — including anything that ever
 * escapes the mail sandbox — a route to two hosts that accept arbitrary path
 * segments.
 *
 * ## What "allowed" means here
 *
 * Host *and* path, not host alone. Both ends of the bridge call
 * `isAllowedFeedUrl`, so the renderer cannot ask the trusted side to fetch
 * `https://raw.githubusercontent.com/<anything>/<exfiltrated-secret>.json`.
 * There are exactly two shapes, they are both public, unauthenticated GETs,
 * and they are both triggered by a button the user pressed.
 */

/** Hosts named on screen before they are contacted. */
export const FEED_HOSTS = ['raw.githubusercontent.com', 'api.github.com'] as const

/** Nothing this app reads is remotely near this big. */
export const MAX_FEED_BYTES = 1_000_000

/** What the trusted side hands back. Deliberately not a `Response`: it has to survive IPC. */
export interface FeedResponse {
  /** The real HTTP status. A non-2xx is reported, not thrown — 404 means "not published yet". */
  status: number
  /** The body as text. Parsed by the caller, which knows what shape it expects. */
  body: string
}

/**
 * Is this one of the two files, exactly?
 *
 * Checked on both sides. The renderer's check is a courtesy; the trusted
 * side's is the one that counts, because that is the side that owns the
 * socket.
 */
export function isAllowedFeedUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  // Plaintext would make the reply forgeable, and the reply becomes calendar
  // dates that decide when mail is sent.
  if (url.protocol !== 'https:') return false
  // `https://raw.githubusercontent.com@evil.example/` parses with the host on
  // the right of the `@`; rejecting credentials outright removes the class.
  if (url.username || url.password) return false
  if (url.port !== '' && url.port !== '443') return false
  if (url.search !== '' || url.hash !== '') return false

  if (url.hostname === 'raw.githubusercontent.com') {
    // holiday-cn republishes one State Council notice per year as `<year>.json`.
    return /^\/NateScarlet\/holiday-cn\/master\/\d{4}\.json$/.test(url.pathname)
  }
  if (url.hostname === 'api.github.com') {
    return url.pathname === '/repos/Aevorine/Aevistle/releases/latest'
  }
  return false
}

/**
 * Wrap a bridge feed call in the `fetch` shape its two callers already expect.
 *
 * `fetchStatutoryYear` and `fetchLatest` both take a `fetchImpl` and both were
 * written against the standard API. Reconstructing a `Response` here keeps
 * their bodies — the status handling, the 404-means-unpublished branch, the
 * hostile-input parsing — identical on all three platforms, and keeps the two
 * offline guard scripts that feed them fake `fetch`es working unchanged.
 */
export function feedFetchVia(
  fetchFeed: (url: string) => Promise<FeedResponse>,
): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { status, body } = await fetchFeed(url)
    // 204/304 must not carry a body; nothing else may be null.
    const payload = status === 204 || status === 304 ? null : body
    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}
