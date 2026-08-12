/**
 * What the privacy image proxy promises, said once, where both platforms and
 * the renderer can read it.
 *
 * ## The problem this exists for
 *
 * A remote image in a message is a network request to a host the sender chose,
 * made from the reader's address, at the moment the reader looks. That single
 * request answers three questions nobody agreed to answer — this address is
 * live, it was read at 14:27, and it was read from this IP — and a 1x1
 * transparent GIF exists for no other purpose than to ask them.
 *
 * Blocking images answers it by not showing the pictures, which is a real cost
 * paid on every legitimate newsletter. The proxy answers it differently:
 *
 *     10:03  message arrives -> proxy fetches, scans, re-encodes, caches
 *     14:27  reader opens it -> reads the local cache. No network at all.
 *
 * The fetch and the open are now two unrelated events. That is the whole idea,
 * and it is Apple Mail Privacy Protection's, adapted to an app with no servers.
 *
 * ## What that does and does not buy — stated plainly, because it matters
 *
 * Decoupled:  *when* the message was opened, *how often*, and *whether it was
 *             ever opened at all*. After prefetch, opening a message a hundred
 *             times produces zero requests, so the sender's "opened" metric is
 *             no longer measuring the reader.
 *
 * NOT hidden: the IP address, and therefore the rough location and network.
 *             The fetch still leaves this machine. Apple can hide it because
 *             the fetch leaves *Apple's* machine; this app has no such server,
 *             and pretending otherwise would be the one lie a privacy feature
 *             cannot afford. `PROXY_RELAY_SETTING` is the seam for anyone who
 *             wants to add one — see `AppearanceSettings.imageRelayUrl`.
 *
 * ## The pipeline, in order
 *
 *   1. fetch      SSRF-shielded, one DNS resolution, no redirects, size-capped
 *   2. scan       magic bytes must agree with the declared type; scriptable
 *                 formats refused outright; structure walked, not trusted
 *   3. re-encode  stills are decoded to pixels and written out fresh, which
 *                 leaves EXIF/GPS, ICC, XMP and any trailing payload behind;
 *                 animated files keep their frames and are scrubbed instead
 *   4. classify   is this a tracking pixel? (counted, never blocked — the
 *                 request already happened at step 1, hours before the read)
 *   5. cache      the *processed* bytes, keyed by URL hash, with its verdict
 *   6. splice     the body's placeholders are replaced from cache at open time
 *
 * This module owns steps 4 and the vocabulary for 2/3 — the parts that must be
 * identical on desktop and Android. The fetching, scanning and re-encoding are
 * necessarily native and live in `electron/imageProxy.ts` and
 * `RemoteImageProxy.java`; both are written against the names below so the two
 * platforms cannot drift into disagreeing about what "blocked" means.
 */

/** Why a picture did not make it through the pipeline. */
export type ImageBlockReason =
  /** Magic bytes did not match the type the server declared. */
  | 'typeMismatch'
  /** A format that can carry script or fetch its own subresources (SVG). */
  | 'scriptableFormat'
  /** Bytes past the format's own end marker — the classic polyglot carrier. */
  | 'trailingData'
  /** The decoder refused it. Malformed, truncated, or an exploit attempt. */
  | 'undecodable'
  /** Larger than the pipeline will process, in bytes or in pixels. */
  | 'tooLarge'
  /** The server answered, but not with an image. */
  | 'notAnImage'
  /** Refused before any connection: private address, bad scheme, bad URL. */
  | 'refusedTarget'
  /** Reached the network and did not come back. Not a security verdict. */
  | 'fetchFailed'

/** Everything the reader's side learns about one remote picture. */
export interface ProxiedImage {
  /** The processed image, ready to splice. `null` for anything not `ok`. */
  dataUri: string | null
  status: 'ok' | 'blocked' | 'failed'
  /** Set whenever `status` is not `ok`. */
  reason?: ImageBlockReason
  /** Free text from the failing layer, for the "why" sheet. Never shown raw in a banner. */
  detail?: string
  /** Did this look like it was there to measure the reader rather than to be seen? */
  tracker: boolean
  /** Which rules fired, in `TRACKER_RULES` order. Empty when `tracker` is false. */
  trackerRules: TrackerRule[]
  /** Pixel dimensions after processing. `0` when unknown or not decoded. */
  width: number
  height: number
  /** Byte length of the processed image. */
  bytes: number
  /** True when this came off disk rather than the network — i.e. the prefetch worked. */
  fromCache: boolean
}

/**
 * The setting name a relay would hang off, referenced from the header above so
 * the seam is greppable rather than merely described.
 */
export const PROXY_RELAY_SETTING = 'imageRelayUrl' as const

/* -------------------------------------------------------------------------- */
/*  Tracking analysis                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The named rules, so a count in the UI can become a list of reasons and a
 * false positive can be argued about by name rather than by guess.
 */
export type TrackerRule =
  /** 1x1, or small enough that nobody could be meant to look at it. */
  | 'pixelSized'
  /** Fully transparent, whatever its size. */
  | 'invisible'
  /** Host or path segment from the open-tracking vocabulary (`/open`, `/beacon`…). */
  | 'trackingPath'
  /** A long opaque token in the URL — the per-recipient serial number. */
  | 'recipientToken'
  /** An email address, or a hash of one, in the query string. */
  | 'addressInUrl'

/**
 * Anything this small is not a picture anyone was meant to see.
 *
 * 4 rather than 1: spacer GIFs at 1x3 and 2x2 are the same technique wearing a
 * different hat, and no real content image is 4px on both axes. Compared on
 * *both* axes — a 1x600 divider line is a legitimate layout element and is not
 * caught by this.
 */
const PIXEL_MAX_EDGE = 4

/**
 * Path and host fragments from the open-tracking vocabulary.
 *
 * Deliberately not a domain blocklist. A list of tracking companies is stale
 * the week it ships and says nothing about the sender who rolled their own;
 * these are the words the *technique* needs, and they survive rebranding.
 * Matched against path and host only — never the query string, where `open`
 * appears in ordinary campaign parameters.
 */
const TRACKING_PATH_WORDS = [
  'open', 'opened', 'track', 'tracking', 'tracker', 'beacon', 'pixel',
  'impression', 'stat', 'stats', 'analytic', 'analytics', 'telemetry',
  'collect', 'count', 'seen', 'read', 'receipt', 'wf/open', 'ea/open',
]

/**
 * A path segment that is a long opaque token is a per-recipient serial number:
 * the whole point of it is that the URL for you differs from the URL for
 * everybody else, so the fetch identifies you specifically.
 *
 * 22 characters of continuous base64/hex is the floor. Shorter is plausibly a
 * content hash or a CDN cache key and is not evidence of anything; a real
 * recipient token carries an id, a campaign and usually a signature, and runs
 * far longer.
 */
const OPAQUE_TOKEN = /(^|[/=_-])[A-Za-z0-9+/_-]{22,}={0,2}($|[/=_.&-])/

/** An address, or the md5/sha of one, sitting in the query string. */
const ADDRESS_IN_QUERY = /(^|[?&=])[^?&=]*(%40|@)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const HASHED_ADDRESS = /(^|[?&/=])(email|e|addr|address|recipient|rcpt|to|u|uid|eid|mid|sid)=[A-Fa-f0-9]{32,64}($|[&/])/i

/**
 * Does this picture look like it is there to measure the reader?
 *
 * Called *after* the bytes are in hand, because the two strongest signals are
 * dimensions and transparency, and neither is knowable from a URL. That order
 * is not a weakness: the request happened at prefetch time, hours before the
 * message was opened, so nothing about classifying it late leaks anything the
 * fetch did not already leak. This is a report, not a gate — see the note on
 * `tracker` in `ProxiedImage`.
 *
 * `fullyTransparent` is passed rather than derived: only the layer holding raw
 * pixels can answer it, and that layer is native on both platforms.
 */
export function classifyTracker(input: {
  url: string
  width: number
  height: number
  fullyTransparent?: boolean
}): { tracker: boolean; rules: TrackerRule[] } {
  const rules: TrackerRule[] = []
  const { url, width, height } = input

  if (width > 0 && height > 0 && width <= PIXEL_MAX_EDGE && height <= PIXEL_MAX_EDGE) {
    rules.push('pixelSized')
  }
  if (input.fullyTransparent === true) rules.push('invisible')

  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    // A URL this app cannot parse never reached the network either; there is
    // nothing to classify and nothing to warn about.
    return { tracker: rules.length > 0, rules }
  }

  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname.toLowerCase()
  /*
   * Word-boundary matching on path segments, not `includes`.
   *
   * `includes('stat')` fires on `/static/logo.png`, which is the most common
   * image path on the web — that one substring would have made this rule
   * useless and the count meaningless. Segments are split on the separators a
   * path and a filename actually use.
   */
  const segments = `${host}/${pathname}`.split(/[/.\-_]+/).filter(Boolean)
  const segmentSet = new Set(segments)
  const hit = TRACKING_PATH_WORDS.some((word) =>
    word.includes('/') ? pathname.includes(`/${word}`) : segmentSet.has(word),
  )
  if (hit) rules.push('trackingPath')

  if (OPAQUE_TOKEN.test(parsed.pathname) || OPAQUE_TOKEN.test(parsed.search)) {
    rules.push('recipientToken')
  }
  if (ADDRESS_IN_QUERY.test(parsed.search) || HASHED_ADDRESS.test(parsed.search)) {
    rules.push('addressInUrl')
  }

  /*
   * One rule is a suspicion; the count is what it is worth reporting on.
   *
   * `pixelSized` and `invisible` are each conclusive on their own — nothing
   * legitimate is 1x1 or fully transparent. The three URL-shaped rules are
   * circumstantial individually (a CDN path can carry a long hash; a campaign
   * URL can carry the word "open") and are only called tracking when they
   * agree with each other or with a dimension signal.
   */
  const conclusive = rules.includes('pixelSized') || rules.includes('invisible')
  const circumstantial = rules.filter(
    (r) => r === 'trackingPath' || r === 'recipientToken' || r === 'addressInUrl',
  ).length
  return { tracker: conclusive || circumstantial >= 2, rules }
}

/* -------------------------------------------------------------------------- */
/*  What a refused picture looks like                                         */
/* -------------------------------------------------------------------------- */

/**
 * The grey block a blocked picture leaves behind.
 *
 * Distinct from `BROKEN_IMAGE` (which means "the fetch did not come back")
 * because the two are different facts and the reader asked to be able to tell
 * them apart: this one means the picture arrived and the proxy refused it, and
 * a tap on the message's banner explains which rule fired.
 *
 * An `<svg>` inside an `<img>`, which cannot execute or fetch anything — the
 * same construction `BROKEN_IMAGE` uses. Base64 rather than percent-encoded,
 * and that is load-bearing: it makes this string satisfy `safeImageDataUri`,
 * so a blocked picture travels the *ordinary* resolved-image path instead of
 * needing a second fallback channel through `MessageBodyFrame`. The base64
 * alphabet also cannot contain a `#`, so it can never be mistaken for a
 * placeholder by `resolveRemoteImages`' string splice.
 *
 * Written out rather than computed: `btoa` is renderer-only and `Buffer` is
 * main-only, and this module is imported by both.
 */
export const BLOCKED_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+PHJlY3QgeD0iMSIgeT0iMSIgd2lkdGg9IjQ2IiBoZWlnaHQ9IjQ2IiBmaWxsPSIjZTllOWVjIiBzdHJva2U9IiNiNGI0YmIiIHN0cm9rZS13aWR0aD0iMiIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMjQiIHI9IjEwIiBmaWxsPSJub25lIiBzdHJva2U9IiM4YjhiOTMiIHN0cm9rZS13aWR0aD0iMi41Ii8+PHBhdGggZD0iTTE3IDE3bDE0IDE0IiBzdHJva2U9IiM4YjhiOTMiIHN0cm9rZS13aWR0aD0iMi41Ii8+PC9zdmc+'

/**
 * The i18n key explaining one block reason, for the sheet a tap opens.
 *
 * A function rather than a record literal so a reason added to the union is a
 * compile error here rather than a missing string at runtime.
 */
export function blockReasonKey(reason: ImageBlockReason): string {
  switch (reason) {
    case 'typeMismatch':
      return 'inbox.imageBlock.typeMismatch'
    case 'scriptableFormat':
      return 'inbox.imageBlock.scriptableFormat'
    case 'trailingData':
      return 'inbox.imageBlock.trailingData'
    case 'undecodable':
      return 'inbox.imageBlock.undecodable'
    case 'tooLarge':
      return 'inbox.imageBlock.tooLarge'
    case 'notAnImage':
      return 'inbox.imageBlock.notAnImage'
    case 'refusedTarget':
      return 'inbox.imageBlock.refusedTarget'
    case 'fetchFailed':
      return 'inbox.imageBlock.fetchFailed'
  }
}

/**
 * A `ProxiedImage` for a platform that has no proxy, or for a call that threw
 * before any layer could form a verdict.
 *
 * Exported so the failure shape is built in one place: a bridge that invented
 * its own `{ status: 'failed' }` object would be one field away from a renderer
 * crash on a path nobody exercises until something is already going wrong.
 */
export function failedImage(reason: ImageBlockReason, detail?: string): ProxiedImage {
  return {
    dataUri: null,
    status: reason === 'fetchFailed' || reason === 'refusedTarget' ? 'failed' : 'blocked',
    reason,
    detail,
    tracker: false,
    trackerRules: [],
    width: 0,
    height: 0,
    bytes: 0,
    fromCache: false,
  }
}

/**
 * Normalise whatever a bridge hands back into a `ProxiedImage`.
 *
 * The Android bridge returned a bare data-URI string for two releases and the
 * desktop one now returns the full verdict. Rather than gate the renderer on
 * both platforms shipping together — which is how one of them ends up shipping
 * a half-migrated shape — this accepts either and the renderer only ever sees
 * the new one. A string is treated as a picture that passed with no verdict
 * information attached, which is exactly what it was.
 */
export function asProxiedImage(value: ProxiedImage | string | null | undefined): ProxiedImage {
  if (value === null || value === undefined) return failedImage('fetchFailed')
  if (typeof value === 'string') {
    return {
      dataUri: value,
      status: 'ok',
      tracker: false,
      trackerRules: [],
      width: 0,
      height: 0,
      bytes: value.length,
      fromCache: false,
    }
  }
  return value
}
