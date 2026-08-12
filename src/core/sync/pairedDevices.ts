/**
 * What an 'ongoing' pairing leaves behind on this machine.
 *
 * A `'once'` pairing (see `core/pairing.ts`'s `PairMode`) keeps nothing but a
 * receipt in the activity log — the same reasoning as any other one-shot
 * export. `'ongoing'` is different: the two devices agreed to keep finding
 * each other, so *something* has to remember which devices those are, what
 * they last agreed to sync, and where to find the key `core/syncLoop.ts`
 * needs to talk to them again. This is that something.
 *
 * `keyRef` is a pointer, never the key. The actual AES-GCM key material lives
 * wherever an SMTP password does — `setSecret(keyRef, key, 'sync')`, the same
 * OS keystore (`electron/store.ts`'s DPAPI-encrypted `secrets.json` on
 * desktop, the hardware-backed Android Keystore via `SecretStore.java` on
 * Android) — so a leaked `state.json` exposes a paired-device *list*, the way
 * it already exposes an account list, and no more. `keyRef` and `id` are the
 * same string in practice (see `core/pairing.ts`'s `pairId`) but are kept as
 * two fields because they mean different things: `id` is this record's
 * identity, `keyRef` is where its secret lives, and a future change to one
 * should not be assumed to imply the other.
 */

import type { SyncScopeKey } from './syncScope'

export type PairedDevicePlatform = 'windows' | 'android'

export interface PairedDeviceAddress {
  host: string
  port: number
}

export interface PairedDevice {
  id: string
  label: string
  platform: PairedDevicePlatform
  pairedAt: number
  lastSyncedAt?: number
  mode: 'once' | 'ongoing'
  scopes: SyncScopeKey[]
  /** Pointer into the secret store — see the module doc. Never the key itself. */
  keyRef: string
  /**
   * Where `core/syncLoop.ts` should reach this device.
   *
   * Seeded at pairing time on the joiner's side only — the QR code carries
   * the host's address, and the handshake tells the host nothing about the
   * joiner — and kept current afterwards by the peer *announcing* it, inside
   * the encrypted envelope, as `SyncExchangePayload.selfAddress`. Still no
   * mDNS/SSDP discovery, by design (see `core/pairing.ts`'s module doc):
   * nothing is broadcast, and the only party that ever learns this is one
   * that already holds the pairing key.
   *
   * Until that announcement existed this was written once and never again, so
   * a new DHCP lease — a phone rejoining Wi-Fi, an overnight reboot — ended
   * the pairing permanently and silently, and re-pairing was the only cure.
   * Absent on the host side of a fresh pairing until the joiner has initiated
   * once; `SyncLoop.runCycle` reports such a device as `'noAddress'` rather
   * than reaching out to nowhere.
   */
  lastAddress?: PairedDeviceAddress
  /**
   * This device's estimate of "the other device's clock minus mine", from
   * the handshake that created (or last regenerated) this record — see
   * `core/pairing.ts`'s `OngoingPairingSecret`. Used only to line up
   * `updatedAt` values for conflict detection (`core/syncConflict.ts`);
   * never applied to a record's own timestamp.
   */
  clockOffsetMs?: number
  /**
   * The peer's own `Settings.localDeviceId`, learned from
   * `SyncExchangePayload.selfDeviceId` on the first ongoing sync after both
   * sides support it — not from the handshake that created this record,
   * which predates the field for any pairing made before it shipped.
   * Absent until then, which is also why a job's executor picker cannot
   * offer a peer it has not synced with yet.
   */
  remoteDeviceId?: string
  /**
   * This device's own advancing counter for the long-lived sync channel —
   * see `core/syncLoop.ts`'s `SyncExchangePayload.seq`. Incremented every
   * time this device seals a payload to this peer, whether an outgoing poll
   * request (`SyncLoop.runDeviceCycle`) or a reply to the peer's own request
   * (`respondToSyncRequest`) — one counter for both roles, since both are
   * "this device originated a sealed message to this peer". Undefined on a
   * device paired (or last synced) before this field shipped; every read
   * treats that the same as 0, so the first payload sealed under it is `1`.
   */
  outgoingSeq?: number
  /**
   * The highest `SyncExchangePayload.seq` this device has accepted from this
   * peer so far — the replay high-water mark `core/syncLoop.ts`'s
   * `assertFreshSeq` checks before trusting a decrypted payload. Learned
   * from whichever of the incoming-request or incoming-reply path this
   * device last accepted a message on; only ever moves forward, via
   * `recordSyncSeq` below. Same "absent means 0" treatment as `outgoingSeq`.
   */
  lastAcceptedSeq?: number
}

/** Add or replace a device by id — pairing again with a device already known updates in place rather than duplicating the row. */
export function upsertPairedDevice(devices: PairedDevice[], device: PairedDevice): PairedDevice[] {
  const next = devices.filter((d) => d.id !== device.id)
  next.push(device)
  return next.sort((a, b) => b.pairedAt - a.pairedAt)
}

export function removePairedDevice(devices: PairedDevice[], id: string): PairedDevice[] {
  return devices.filter((d) => d.id !== id)
}

export function findPairedDevice(devices: PairedDevice[], id: string): PairedDevice | undefined {
  return devices.find((d) => d.id === id)
}

/** Record a successful sync cycle without disturbing anything else about the device — `devices.regenerate` deliberately does not call this, per its own doc. */
export function touchSynced(
  devices: PairedDevice[],
  id: string,
  syncedAt: number,
  /**
   * `SyncApplyPatch.remoteAddress` — where the peer said it is listening, if
   * that differs from what is already stored. Every caller passed `undefined`
   * here for as long as nothing produced the value, which is precisely how
   * `lastAddress` came to be write-once; see that field's own doc.
   *
   * Already narrowed by `lanAddress.ts`'s `toStorableAddress` on the way in
   * (`performExchange` does it), so what arrives here is a private IPv4
   * literal with a usable port or nothing at all. `undefined` keeps whatever
   * is stored rather than clearing it: a peer that has stopped announcing —
   * an older build reconnecting, or one whose listener is down this minute —
   * must not cost this device the last address that worked.
   */
  address?: PairedDeviceAddress,
  /** See `PairedDevice.remoteDeviceId`. Only ever moves forward — a peer that stops sending it (an older build reconnecting) must not erase what an earlier exchange already learned. */
  remoteDeviceId?: string,
): PairedDevice[] {
  return devices.map((d) =>
    d.id === id
      ? {
          ...d,
          lastSyncedAt: syncedAt,
          lastAddress: address ?? d.lastAddress,
          remoteDeviceId: remoteDeviceId ?? d.remoteDeviceId,
        }
      : d,
  )
}

/** Replace only the material a regenerate produced — id, label, pairedAt, scopes and sync history are untouched. See `PairedDevice.keyRef`'s doc. */
export function applyRegeneratedSecret(
  devices: PairedDevice[],
  id: string,
  clockOffsetMs: number,
): PairedDevice[] {
  return devices.map((d) => (d.id === id ? { ...d, clockOffsetMs } : d))
}

/**
 * Advance this device's replay-protection counters — never backward. See
 * `core/syncLoop.ts`'s `SyncExchangePayload.seq`, `PairedDevice.outgoingSeq`
 * and `.lastAcceptedSeq`.
 *
 * `Math.max` rather than a plain overwrite, because both counters can be
 * written from either sync direction (`respondToSyncRequest`'s incoming
 * request path and `SyncLoop`'s incoming reply path share one
 * `lastAcceptedSeq`; a reply-seal and a request-seal share one
 * `outgoingSeq`), and the two directions can race when two paired devices
 * poll each other within the same window — see `core/syncLoop.ts`'s module
 * doc. Whichever of two racing updates for the same device is applied last
 * must not be allowed to regress a counter a moment-earlier update already
 * advanced further: a regressed `lastAcceptedSeq` would reopen exactly the
 * replay window this feature exists to close, and a regressed `outgoingSeq`
 * risks a future seal reusing a number the peer has already seen.
 */
export function recordSyncSeq(
  devices: PairedDevice[],
  id: string,
  update: { outgoingSeq?: number; lastAcceptedSeq?: number },
): PairedDevice[] {
  if (update.outgoingSeq === undefined && update.lastAcceptedSeq === undefined) return devices
  return devices.map((d) =>
    d.id === id
      ? {
          ...d,
          outgoingSeq: Math.max(d.outgoingSeq ?? 0, update.outgoingSeq ?? 0),
          lastAcceptedSeq: Math.max(d.lastAcceptedSeq ?? 0, update.lastAcceptedSeq ?? 0),
        }
      : d,
  )
}
