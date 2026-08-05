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
   * Where `core/syncLoop.ts` last reached this device — the LAN address
   * learned at pairing time. Not re-discovered afterwards (this app does no
   * mDNS/SSDP discovery, by design — see `core/pairing.ts`'s module doc), so
   * a device that changes networks stops syncing until it is paired again.
   * That is a documented limitation, not a bug: the alternative is a
   * discovery protocol broadcasting this device's presence to the whole LAN.
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
  address?: PairedDeviceAddress,
): PairedDevice[] {
  return devices.map((d) =>
    d.id === id ? { ...d, lastSyncedAt: syncedAt, lastAddress: address ?? d.lastAddress } : d,
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
