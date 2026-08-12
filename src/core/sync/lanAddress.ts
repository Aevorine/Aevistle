/**
 * Is this address one this app is allowed to talk to, and how is it written?
 *
 * Two relays already answer the first question at the moment they are asked to
 * send something — `isLanRelayUrl` in `electron/main.ts` and `isLanRelayUrl`/
 * `isPrivateIPv4` in `android/.../AevistleNativePlugin.java`. Both refuse
 * anything that is not a private IPv4 literal, which is what keeps
 * `pairingJoinRequest`/`syncRequest` from being a general-purpose SSRF proxy
 * for whatever the renderer asks them to fetch.
 *
 * This file is not a third copy of that check for its own sake. It exists
 * because of what `core/syncLoop.ts` now does with `SyncExchangePayload
 * .selfAddress`: a peer *tells* this device where to reach it next time, and
 * that address gets written to `PairedDevice.lastAddress` and reused for weeks.
 * Catching a bad one only at send time would mean a peer could overwrite a
 * perfectly good stored address with a public one, and every cycle from then on
 * would fail at the relay with an error the user cannot act on — the pairing
 * would look broken rather than look attacked. So the check moves one step
 * earlier: a bad address is never stored in the first place, and the previous
 * good one survives untouched.
 *
 * Deliberately platform-agnostic and dependency-free — `core/` code runs in the
 * Electron renderer and the Android WebView alike, and neither `URL` parsing
 * quirks nor Node's `net` module are assumed. The rule is kept character for
 * character in step with the two relays it backstops: same four private
 * ranges, same link-local allowance for phone hotspots, same loopback
 * allowance for development. If one of those three lists changes, all three
 * change together.
 *
 * IPv4 literals only, matching both relays. A hostname is refused rather than
 * resolved: a name that resolves to a private address today can resolve
 * somewhere else tomorrow, and the whole point of this check is that the
 * decision cannot be moved out from under it after it is made.
 */

import type { PairedDeviceAddress } from './pairedDevices'

/**
 * The same four ranges both relays accept, and for the same stated reasons.
 *
 * `Number.parseInt` is not used on the octets: it would read `"010.0.0.1"` as
 * `10` and wave through a host the relays' own stricter parse rejects, which
 * would put this check and the send-time check out of step in exactly the
 * direction that matters (stored as fine, then refused forever at send).
 * Digits-only, no leading zeros beyond a bare `"0"`, is what both relays
 * already require.
 */
export function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false

  const octets: number[] = []
  for (const part of parts) {
    // Nothing but digits, one to three of them, and no leading zero on a
    // multi-digit group — see the doc above on why `parseInt` is not enough.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false
    const value = Number(part)
    if (value > 255) return false
    octets.push(value)
  }

  const [a, b] = octets
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local — some hotspot configurations hand these out
    a === 127 // same-machine, for development
  )
}

/** A port a LAN listener could actually be bound to. Zero means "the OS did not give us one", which is not an address anyone can be reached at. */
function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

/**
 * Narrow an untrusted value to an address worth storing.
 *
 * Called on `SyncExchangePayload.selfAddress`, which arrives inside an
 * authenticated AES-GCM envelope — so this is not defending against a stranger
 * on the network, who cannot produce a valid envelope at all. It defends
 * against the two things authentication does not cover: a peer running a build
 * whose idea of an address shape differs from this one's, and a paired device
 * that has itself been compromised and would like this one to start posting
 * its (encrypted, but still outbound) sync traffic to an address off the local
 * network. The second is the reason the private-range test is here rather than
 * only a shape test.
 */
export function toStorableAddress(value: unknown): PairedDeviceAddress | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { host, port } = value as { host?: unknown; port?: unknown }
  if (typeof host !== 'string' || typeof port !== 'number') return undefined
  if (!isPrivateIPv4(host) || !isUsablePort(port)) return undefined
  return { host, port }
}

/**
 * `"192.168.1.9:48793"` — the shape `SyncListenerStatus.address` reports, and
 * the shape `LanAddresses.best()` plus the port is assembled into on Android —
 * back into the two fields `PairedDevice.lastAddress` keeps them in.
 *
 * Returns `undefined` for anything that does not survive
 * `toStorableAddress`, so a caller can hand it a status field that may be
 * absent, may be a bare host, or may be an IPv6 literal full of colons,
 * without checking first.
 */
export function parseAddress(text: string | undefined, fallbackPort: number): PairedDeviceAddress | undefined {
  if (!text) return undefined
  const lastColon = text.lastIndexOf(':')
  // No colon at all is a bare host, which is a legitimate thing for a caller
  // to hold — the port is then the well-known one the caller passed in.
  const host = lastColon === -1 ? text : text.slice(0, lastColon)
  const portText = lastColon === -1 ? '' : text.slice(lastColon + 1)
  const port = portText === '' ? fallbackPort : Number(portText)
  return toStorableAddress({ host, port })
}

/** Two addresses naming the same listener — used to skip a pointless write when a peer re-announces what is already stored. */
export function sameAddress(a: PairedDeviceAddress | undefined, b: PairedDeviceAddress | undefined): boolean {
  if (!a || !b) return a === b
  return a.host === b.host && a.port === b.port
}
