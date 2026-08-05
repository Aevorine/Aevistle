/**
 * The offline fallback for pairing two devices — a file instead of a live
 * connection.
 *
 * `core/pairing.ts` needs both devices on the same LAN, and that fails in
 * ordinary ways: different Wi-Fi networks, a guest network with client
 * isolation turned on, corporate Wi-Fi that blocks device-to-device traffic
 * outright. When that happens, or when `PairingScanner` reports no camera to
 * scan a code with, this is the fallback — a file carried by hand (a cable, a
 * USB stick, AirDrop) the way a paper boarding pass covers for a phone with no
 * signal.
 *
 * Built on the existing `BackupFile` shape rather than inventing a second
 * one: readers, writers and every field a future backup adds are inherited
 * for free. A pairing file is exactly that shape with the scopes nobody chose
 * emptied out, encrypted with one extra envelope on top — AES-GCM, keyed by a
 * PIN through PBKDF2 with a random salt. When the *only* scope chosen is the
 * schedule, the payload is `jobTransfer.ts`'s existing job-only `TransferFile`
 * instead: that format has never carried anything but reminders, and a
 * schedule-only pairing file should not start being the exception.
 *
 * No secrets, ever — stronger than the reasoning in `core/syncScope.ts` for
 * the live-session payload, not weaker. A live pairing session ends the
 * moment the two devices stop talking; a file can be copied, backed up, and
 * re-shared long after whoever wrote it has forgotten the PIN. So this reuses
 * `backup.ts`'s `accountFields` by way of `buildBackup`, which already clears
 * `hasSecret` on every account, and never attaches one back.
 *
 * A 6-digit PIN has limited entropy against an attacker who has the file and
 * unlimited offline guesses — PBKDF2 slows each guess down, it does not make
 * guessing impossible. Treat this file exactly like an existing `.aevistle`
 * backup: fine to keep, not something to attach to an email you cannot take
 * back.
 */

import { appearanceSettings, buildBackup, type BackupFile } from './backup'
import { exportJobs, type TransferFile } from './jobTransfer'
import { DEFAULT_SETTINGS, type AppState } from './types'
import { DEFAULT_WORK_CALENDAR, type WorkCalendar } from './workCalendar'
import type { SyncScopeKey } from './syncScope'

export const PAIRING_FILE_KIND = 'aevistle.pairing-file'
export const PAIRING_FILE_VERSION = 1

/** OWASP's current PBKDF2-SHA256 floor is 600,000; this stays a little under it deliberately — a 6-digit PIN is the weak link either way, and this runs on phones, not servers. 300,000 keeps unlock under a second on a mid-range Android device while still costing an offline attacker real time per guess. */
const PBKDF2_ITERATIONS = 310_000
const SALT_BYTES = 16
const IV_BYTES = 12

export interface PairingFile {
  kind: typeof PAIRING_FILE_KIND
  version: number
  /** Base64, random per file. */
  salt: string
  /** Base64, random per file. */
  iv: string
  /** Base64 — decrypts to a `BackupFile` or a job-only `TransferFile`. */
  ciphertext: string
}

/** Thrown by `decryptPairingFile` for a wrong PIN — and, indistinguishably, a corrupted file. AES-GCM's authentication tag fails the same way for both, and both mean "cannot open this", so only the PIN is this app's to ask about again. */
export class WrongPinError extends Error {}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource
}

async function deriveFileKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(new TextEncoder().encode(pin)),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toBufferSource(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// Written by hand rather than reached for `Buffer` (absent in a WebView) or
// `btoa`/`atob` — same reasoning, and the same alphabet, as `pairingCrypto.ts`.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 0x3f]
  }
  return out
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let bitBuffer = 0
  let bitCount = 0
  let outIndex = 0
  for (const char of clean) {
    const value = B64_CHARS.indexOf(char)
    if (value < 0) continue
    bitBuffer = (bitBuffer << 6) | value
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      bytes[outIndex++] = (bitBuffer >> bitCount) & 0xff
    }
  }
  return bytes.slice(0, outIndex)
}

/**
 * Build the plaintext payload for the chosen scopes.
 *
 * A `BackupFile` with the scopes nobody picked emptied out, except when the
 * schedule is the *only* scope chosen — then this is the existing job-only
 * `TransferFile`, which brings its own calendar handling
 * (`jobTransfer.ts`'s `needsCalendar`) rather than smuggling one through
 * `Settings.workCalendar` the way the `BackupFile` branch below has to.
 */
export function buildPairingPayload(
  state: AppState,
  scopes: readonly SyncScopeKey[],
  appVersion: string,
  calendar: WorkCalendar = state.settings.workCalendar ?? DEFAULT_WORK_CALENDAR,
): BackupFile | TransferFile {
  const want = new Set(scopes)

  if (want.size === 1 && want.has('schedule')) {
    return exportJobs(state.jobs, appVersion, Date.now(), calendar)
  }

  const backup = buildBackup(state, appVersion)
  return {
    ...backup,
    accounts: want.has('accounts') ? backup.accounts : [],
    jobs: want.has('schedule') ? backup.jobs : [],
    contacts: want.has('contacts') ? backup.contacts : [],
    templates: want.has('templates') ? backup.templates : [],
    // Only the fields the chosen scopes actually mean travel — not the rest
    // of `Settings` (data folder, quiet hours, retention…) that `buildBackup`
    // would otherwise carry unconditionally.
    settings: {
      ...DEFAULT_SETTINGS,
      ...(want.has('appearance') ? appearanceSettings(state.settings) : {}),
      ...(want.has('schedule') ? { workCalendar: calendar } : {}),
    },
  }
}

export async function encryptPairingFile(
  payload: BackupFile | TransferFile,
  pin: string,
): Promise<PairingFile> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveFileKey(pin, salt)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    toBufferSource(plaintext),
  )
  return {
    kind: PAIRING_FILE_KIND,
    version: PAIRING_FILE_VERSION,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
}

/**
 * Read the envelope out of a file the user picked. Strict about `kind` for
 * the same reason `readBackup` is: a person who picked the wrong file needs
 * to be told that, not shown a cryptic parse error two steps later after
 * typing a PIN for nothing.
 */
export function readPairingFile(text: string): PairingFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('not-json')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('not-a-pairing-file')

  const candidate = parsed as Partial<PairingFile>
  if (candidate.kind !== PAIRING_FILE_KIND) throw new Error('not-a-pairing-file')
  if (typeof candidate.version !== 'number' || candidate.version > PAIRING_FILE_VERSION) {
    throw new Error('too-new')
  }
  if (
    typeof candidate.salt !== 'string' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    throw new Error('not-a-pairing-file')
  }

  return {
    kind: PAIRING_FILE_KIND,
    version: candidate.version,
    salt: candidate.salt,
    iv: candidate.iv,
    ciphertext: candidate.ciphertext,
  }
}

/**
 * Decrypt with the PIN the user entered.
 *
 * Returns the plaintext JSON text rather than a parsed `BackupFile` or
 * `TransferFile` — those two formats are validated differently
 * (`readBackup` returns a value directly; `parseImport` returns a
 * `ParsedImport`, with per-row problems and a calendar decision to show
 * before anything is written), and only the caller knows which one it is
 * about to ask for. `detectPairingPayloadKind` below answers that with one
 * cheap `JSON.parse`, so the caller never duck-types the fields itself.
 *
 * Throws `WrongPinError` for a bad PIN or a damaged file — see the class doc
 * for why those cannot be told apart.
 */
export async function decryptPairingFile(file: PairingFile, pin: string): Promise<string> {
  const salt = base64ToBytes(file.salt)
  const iv = base64ToBytes(file.iv)
  const key = await deriveFileKey(pin, salt)
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv) },
      key,
      toBufferSource(base64ToBytes(file.ciphertext)),
    )
  } catch {
    throw new WrongPinError('wrong PIN, or this file is damaged')
  }
  return new TextDecoder().decode(plaintext)
}

/**
 * Which of the two formats a decrypted pairing file's plaintext is, so a
 * caller can route it to `readBackup(text)` or `parseImport(text)` — the same
 * validation either one would get read from disk unencrypted. Throws the same
 * way `readBackup` does when the text is not even JSON: there is nothing more
 * specific to say.
 */
export function detectPairingPayloadKind(text: string): 'backup' | 'schedule' {
  let probe: unknown
  try {
    probe = JSON.parse(text)
  } catch {
    throw new Error('not-a-pairing-file')
  }
  return (probe as Partial<TransferFile>).format === 'aevistle.jobs' ? 'schedule' : 'backup'
}

/** `Aevistle-pairing-2026-08-05.aevistlepair` — sorts by date, and the extension keeps it from being picked up by the plain backup importer, which would reject its `kind` anyway but should never see it. */
export function pairingFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Aevistle-pairing-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.aevistlepair`
}

/** True for the job-only shape built when the schedule is the only chosen scope; false (and therefore a `BackupFile`) otherwise. */
export function isTransferPayload(payload: BackupFile | TransferFile): payload is TransferFile {
  return (payload as Partial<TransferFile>).format === 'aevistle.jobs'
}

/** Read a just-built export payload's contents back out for a confirmation screen before it is encrypted and saved — one function whether it is a `BackupFile` or a `TransferFile`. */
export function summarisePairingPayload(payload: BackupFile | TransferFile): {
  accounts: number
  jobs: number
  contacts: number
  templates: number
} {
  if (isTransferPayload(payload)) {
    return { accounts: 0, jobs: payload.jobs.length, contacts: 0, templates: 0 }
  }
  return {
    accounts: payload.accounts.length,
    jobs: payload.jobs.length,
    contacts: payload.contacts.length,
    templates: payload.templates.length,
  }
}
