/**
 * Fetch a remote image referenced from a received message body, through the
 * main process so the renderer never makes its own network request — a
 * tracking pixel loaded from inside the sandboxed body iframe would still
 * leak the reader's IP and confirm the message was opened, which is exactly
 * what remote-image blocking (see `sanitizeHtml.ts`) exists to prevent. This
 * function is what runs when the user (or an account/sender policy) has
 * explicitly opted back into loading a specific image anyway.
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
import dns from 'node:dns'
import net from 'node:net'
import type { LookupFunction } from 'node:net'

const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 5 * 1024 * 1024

function isDisallowedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true // malformed — fail closed
    if (a === 127) return true // loopback
    if (a === 10) return true // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata endpoints
    if (a === 0) return true
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

export async function downloadRemoteImage(url: string): Promise<string> {
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

  return new Promise<string>((resolve, reject) => {
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
        const contentType = res.headers['content-type'] ?? ''
        if (!contentType.startsWith('image/')) {
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
          const buffer = Buffer.concat(chunks)
          resolve(`data:${contentType};base64,${buffer.toString('base64')}`)
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('Timed out')))
    req.on('error', reject)
    req.end()
  })
}
