/**
 * Fetch a remote image referenced from a received message body, through the
 * main process so the renderer never makes its own network request — a
 * tracking pixel loaded from inside the sandboxed body iframe would still
 * leak the reader's IP and confirm the message was opened, which is exactly
 * what remote-image blocking (see `sanitizeHtml.ts`) exists to prevent. This
 * function is what runs when an account's policy — `always` by default, see
 * `RemoteImagePolicy` — or an explicit "load images" click says the message's
 * pictures should be fetched after all. The sanitizer still strips every
 * remote `src`; what changed is who asks for them back, not who fetches them.
 *
 * Results are cached on disk (bottom of this file) so that "load by default"
 * costs one request per image ever rather than one per reopen.
 *
 * A "download an attacker-chosen URL" primitive is an SSRF vector against the
 * user's own LAN — a `<img src="http://192.168.1.1/admin">` embedded in a
 * message is a real, common technique, not a theoretical one. The obvious
 * defence — resolve the hostname, reject private ranges — has a well-known
 * hole: resolving once to check, then letting the HTTP client resolve again
 * to connect, is a DNS-rebinding gap (the second lookup can legitimately
 * answer differently). This uses `http(s).request`'s `lookup` option so
 * there is exactly one resolution, which both the check and the connection
 * share — not `fetch()`, which resolves internally with no hook to intercept.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import dns from 'node:dns'
import net from 'node:net'
import type { LookupFunction } from 'node:net'
import { dataLocation } from './store'
import { processImage } from './imageProxy'
import { failedImage, type ImageBlockReason, type ProxiedImage } from '../src/core/mail/imageProxy'

const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 5 * 1024 * 1024

function isDisallowedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b, c] = parts
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true // malformed — fail closed
    if (a === 127) return true // loopback
    if (a === 10) return true // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata endpoints
    if (a === 0) return true
    if (a === 100 && b >= 64 && b <= 127) return true // RFC6598 carrier-grade NAT
    if (a === 192 && b === 0 && c === 0) return true // RFC6890 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true // RFC2544 benchmarking
    if (a >= 224 && a <= 239) return true // multicast
    if (a >= 240) return true // reserved, incl. 255.255.255.255 broadcast
    return false
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local, fc00::/7
    if (lower.startsWith('fe80')) return true // link-local
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length)
      return net.isIPv4(mapped) ? isDisallowedAddress(mapped) : true
    }
    return false
  }
  return true // not a recognisable IP shape — fail closed
}

type LookupEntry = { address: string; family: number }
/**
 * Node's own `LookupFunction` is typed for the single-address shape only, even
 * though the runtime calls it with `{all:true}` and reads back an array. The
 * cast at the call site is where those two facts meet.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupEntry[],
  family?: number,
) => void

/**
 * A `dns.lookup`-shaped resolver that refuses to hand back a private/loopback
 * address, passed straight into `http(s).request`'s `lookup` option so the
 * one address it resolves is the one address the socket connects to.
 *
 * It has to answer in whichever of the two shapes the caller asked for.
 * `net.connect` enables happy-eyeballs (`autoSelectFamily`) by default from
 * Node 20 on, and in that mode it calls this hook with `{all: true}` and reads
 * `addresses[0].address` off the result. Answering with a plain string there
 * yields `undefined`, and the connection dies with `ERR_INVALID_IP_ADDRESS:
 * undefined` — which is precisely what every "load remote images" click did
 * before this, with the failure surfacing as a generic error in the UI.
 */
function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | undefined,
  callback: LookupCallback,
): void {
  const wantsAll = options?.all === true
  const family = options?.family === 4 || options?.family === 6 ? options.family : 0

  dns.lookup(hostname, { verbatim: false, all: true, family }, (err, addresses) => {
    if (err) {
      callback(err, wantsAll ? [] : '')
      return
    }

    const allowed = addresses.filter((entry) => !isDisallowedAddress(entry.address))
    if (allowed.length === 0) {
      const blocked = addresses.map((entry) => entry.address).join(', ') || 'no addresses'
      callback(
        new Error(`Refusing to connect to a private address (${blocked})`) as NodeJS.ErrnoException,
        wantsAll ? [] : '',
      )
      return
    }

    // Every returned address was checked, so happy-eyeballs cannot race onto
    // an unvetted one: filtering the list is what keeps the guarantee that the
    // address checked is the address connected to.
    if (wantsAll) callback(null, allowed)
    else callback(null, allowed[0].address, allowed[0].family)
  })
}

/** What the socket produced: the bytes, and the type the server claimed for them. */
interface FetchedBytes {
  buffer: Buffer
  mime: string
}

async function fetchOverNetwork(url: string): Promise<FetchedBytes> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Unsupported URL scheme')
  }

  /**
   * A literal IP in the URL never reaches `safeLookup` at all.
   *
   * `net.connect` only consults the `lookup` hook when the host needs
   * resolving; give it `http://127.0.0.1:9333/` or `http://192.168.1.1/admin`
   * and it connects straight through, so the entire private-address defence
   * this file is built around was skipped by the most obvious way to attack
   * it. Measured, not theorised: a request to a loopback service returned 200
   * with the guard nominally in place. Hostnames still go through
   * `safeLookup`; this closes the path that bypasses it.
   *
   * `URL` wraps IPv6 hosts in brackets, which `net.isIP` does not accept.
   */
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && isDisallowedAddress(host)) {
    throw new Error(`Refusing to connect to a private address (${host})`)
  }

  const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise<FetchedBytes>((resolve, reject) => {
    const req = requestFn(
      parsed,
      {
        lookup: safeLookup as unknown as LookupFunction,
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'User-Agent': 'Aevistle' },
      },
      (res) => {
        const status = res.statusCode ?? 0
        // No redirects: a redirect target needs the same private-address
        // check and this keeps that from being an easy bypass to reintroduce.
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        /**
         * The server's `Content-Type` header is attacker-controlled — it is
         * whatever the URL the message pointed at chose to answer with, not
         * anything this app asserted. Trusting it verbatim into a `data:` URI
         * that later gets spliced back into already-sanitized HTML (see
         * `resolveRemoteImages`) means a hostile response header can smuggle
         * near-arbitrary characters past the point sanitization already ran.
         * A strict allowlist — MIME-token subtype only, params dropped —
         * makes the value that reaches the data URI provably just that.
         */
        const rawContentType = res.headers['content-type']
        const mime = String(Array.isArray(rawContentType) ? rawContentType[0] : (rawContentType ?? ''))
          .split(';')[0]
          .trim()
          .toLowerCase()
        if (!/^image\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(mime)) {
          res.resume()
          reject(new Error('Not an image'))
          return
        }
        const declared = Number(res.headers['content-length'] ?? 0)
        if (declared > MAX_BYTES) {
          res.resume()
          reject(new Error('Image too large'))
          return
        }

        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_BYTES) {
            reject(new Error('Image too large'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          /*
           * Raw bytes and the server's declared type, handed straight to the
           * scanner. This function deliberately no longer builds a data URI:
           * that used to mean a stranger's bytes went from the socket into
           * already-sanitized HTML with only a `Content-Type` check between
           * them. Everything that decides whether these bytes are an image —
           * and turns them into bytes this app wrote — is in `imageProxy.ts`.
           */
          resolve({ buffer: Buffer.concat(chunks), mime })
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('Timed out')))
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// On-disk cache
// ---------------------------------------------------------------------------

/**
 * Images survive a restart now, because they have to.
 *
 * Remote images load by default (see `RemoteImagePolicy`), so every reopen of
 * every HTML message used to mean re-fetching the whole set — the renderer's
 * memo is per session, and quitting the app threw it away. That is slow on a
 * bad link and, more to the point, it re-announces the reader to the sender's
 * server every single time; a cache that persists means one hit per image
 * ever, which is *fewer* pings than blocking-then-clicking used to produce.
 *
 * Keyed by a hash of the URL and nothing else — not by message, not by
 * account. The same tracking pixel appears in a hundred newsletters, and
 * fetching it once is the point. That also means nothing here reveals which
 * message an entry came from: the directory is a pile of hashes.
 *
 * It is a cache, not data: the server still has the picture, so eviction is
 * free and everything below fails soft. A cache that cannot be written to
 * must never be a reason a message fails to render.
 */
const CACHE_DIR = 'imagecache'
/** Total bytes before the least recently used entries are dropped. */
const CACHE_MAX_BYTES = 200 * 1024 * 1024
/** Prune down to this much, so a full cache does not re-prune on every write. */
const CACHE_TARGET_BYTES = Math.floor(CACHE_MAX_BYTES * 0.8)
/** One entry is a whole data URI; anything near the fetch ceiling is fine, past it is not ours. */
const CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024

function cacheDir(): string {
  return path.join(dataLocation(), CACHE_DIR)
}

/**
 * The filename for a URL. SHA-256 rather than anything reversible: the folder
 * is then a list of hashes instead of a browsable history of everywhere the
 * user's mail has pointed.
 */
function cacheFile(url: string): string {
  return path.join(cacheDir(), `${createHash('sha256').update(url).digest('hex')}.txt`)
}

/**
 * A cache entry is the whole verdict, not just the picture.
 *
 * It used to be a bare data URI, and that was enough when the only question was
 * "what are the bytes". Now every entry also carries whether the scanner
 * refused it and whether it looked like a tracking pixel — and those have to
 * survive a restart for the same reason the bytes do. Without it, a message
 * whose images were all prefetched would reopen tomorrow reporting no trackers,
 * because the analysis lived in the fetch that no longer happens.
 *
 * A *blocked* image is cached too, deliberately. The refusal is a property of
 * the bytes, not of the moment; re-fetching a picture the scanner has already
 * refused would mean a fresh request to the sender's server every single time
 * the message is opened — which is precisely the signal this whole file exists
 * to stop sending.
 */
interface CacheEntry {
  v: 2
  status: ProxiedImage['status']
  dataUri: string | null
  reason?: ImageBlockReason
  detail?: string
  tracker: boolean
  trackerRules: ProxiedImage['trackerRules']
  width: number
  height: number
  bytes: number
}

async function readCached(url: string): Promise<ProxiedImage | null> {
  try {
    const file = cacheFile(url)
    const text = await fs.readFile(file, 'utf8')
    /*
     * v1 entries were a bare `data:image/...` string. Read them rather than
     * discarding them: an existing cache is a record of requests already made,
     * and throwing it away would re-announce the reader to every server in it.
     * They carry no verdict, so they are reported as a picture that passed with
     * nothing else known — which is exactly what they were.
     */
    if (text.startsWith('data:image/')) {
      const now = new Date()
      void fs.utimes(file, now, now).catch(() => {})
      return {
        dataUri: text,
        status: 'ok',
        tracker: false,
        trackerRules: [],
        width: 0,
        height: 0,
        bytes: text.length,
        fromCache: true,
      }
    }
    const entry = JSON.parse(text) as CacheEntry
    if (entry.v !== 2) return null
    const now = new Date()
    void fs.utimes(file, now, now).catch(() => {})
    return {
      dataUri: entry.dataUri,
      status: entry.status,
      reason: entry.reason,
      detail: entry.detail,
      tracker: entry.tracker,
      trackerRules: entry.trackerRules ?? [],
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      fromCache: true,
    }
  } catch {
    return null // a miss and an unreadable cache are the same thing to the caller
  }
}

async function writeCached(url: string, result: ProxiedImage): Promise<void> {
  const entry: CacheEntry = {
    v: 2,
    status: result.status,
    dataUri: result.dataUri,
    reason: result.reason,
    detail: result.detail,
    tracker: result.tracker,
    trackerRules: result.trackerRules,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
  }
  const text = JSON.stringify(entry)
  if (Buffer.byteLength(text) > CACHE_MAX_ENTRY_BYTES) return
  try {
    const dir = cacheDir()
    await fs.mkdir(dir, { recursive: true })
    const file = cacheFile(url)
    // Write-then-rename, so a crash mid-write cannot leave a half-file that
    // reads back as a corrupt image.
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  } catch {
    /* the picture still displays; it just will not be there next time */
  }
  void prune()
}

/** One sweep at a time — a burst of thirty images must not start thirty of them. */
let pruning: Promise<void> | null = null

async function prune(): Promise<void> {
  if (pruning) return pruning
  pruning = (async () => {
    try {
      const dir = cacheDir()
      const names = await fs.readdir(dir)
      const entries: Array<{ file: string; size: number; mtime: number }> = []
      let total = 0
      for (const name of names) {
        const file = path.join(dir, name)
        try {
          const stat = await fs.stat(file)
          if (!stat.isFile()) continue
          entries.push({ file, size: stat.size, mtime: stat.mtimeMs })
          total += stat.size
        } catch {
          /* vanished under us — nothing to count */
        }
      }
      if (total <= CACHE_MAX_BYTES) return
      // Oldest touch first: `readCached` bumps mtime on every hit, which is
      // what makes this least-recently-*used* rather than oldest-fetched.
      entries.sort((a, b) => a.mtime - b.mtime)
      for (const entry of entries) {
        if (total <= CACHE_TARGET_BYTES) break
        try {
          await fs.unlink(entry.file)
          total -= entry.size
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no cache directory yet, or it is unreadable — nothing to prune */
    } finally {
      pruning = null
    }
  })()
  return pruning
}

/**
 * The proxy, end to end: cache, then fetch, scan, re-encode, classify, store.
 *
 * Never throws. Every caller of this — the prefetch queue and the renderer's
 * open-time resolve — wants a verdict, and an exception is a verdict nobody can
 * put on the screen. Network failures are reported as `failed` and are *not*
 * written to the cache: a dropped connection is a moment in time, and recording
 * it would make one bad minute permanent. Scanner refusals are `blocked` and
 * *are* cached — see `CacheEntry`.
 */
export async function downloadRemoteImage(url: string): Promise<ProxiedImage> {
  const cached = await readCached(url)
  if (cached) return cached

  let fetched: { buffer: Buffer; mime: string }
  try {
    fetched = await fetchOverNetwork(url)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // "Refusing to connect to a private address" and "Unsupported URL scheme"
    // are decisions this app made about the target, not network weather, and
    // the reader is entitled to see them named differently.
    const refused = /Refusing to connect|Unsupported URL scheme/.test(message)
    return failedImage(refused ? 'refusedTarget' : 'fetchFailed', message)
  }

  const result = processImage(url, fetched.buffer, fetched.mime)
  await writeCached(url, result)
  return result
}

/**
 * Is this URL already in the cache?
 *
 * The prefetch queue's own question, and the reason it is separate from
 * `downloadRemoteImage`: asking "do I need to fetch this" must not itself
 * fetch. Used to skip work, never to decide what to show.
 */
export async function isImageCached(url: string): Promise<boolean> {
  return (await readCached(url)) !== null
}

/**
 * Delete every cached image.
 *
 * Called by "reset everything", which is the strongest promise this app makes.
 * The cache holds only pictures that were already public on someone else's
 * server — but the *set* of them is a record of which mail was opened, and a
 * reset that leaves a folder of hashes behind has not done what it said.
 *
 * Resolves either way. A cache that cannot be emptied is not a reason to tell
 * someone their reset failed when their accounts, secrets and schedule are all
 * genuinely gone.
 */
export async function clearImageCache(): Promise<void> {
  await fs.rm(cacheDir(), { recursive: true, force: true }).catch(() => {})
}
