/**
 * The app lock's hashing, self-contained on purpose.
 *
 * The PIN gate has to produce the *same* hash on the desktop, in the Android
 * WebView and under the check scripts' Node — `Settings` travels between
 * paired devices, so a lock enabled on one machine must open on another.
 * `crypto.subtle` would be the obvious tool and is `async`, secure-context
 * gated, and historically flaky across old WebViews; a plain SHA-256 written
 * out here is deterministic everywhere the app runs and is verified against
 * the FIPS 180-4 test vectors by `npm run check:applock`.
 *
 * Honest scope, stated once: this locks the screen, not the data. A four-to-
 * twelve digit PIN has at most a few billion possibilities, `state.json` is
 * not encrypted by it, and anyone with the disk can read the mail without
 * ever meeting this file. Iterated hashing (see `PIN_LOCK_ITERATIONS`) makes
 * casual brute force boring, which is the actual threat a screen lock
 * answers: someone else at your unlocked computer, not a forensic lab.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/** SHA-256 of raw bytes, per FIPS 180-4. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const len = data.length
  // Message length in *bits*, split by hand: `len << 3` overflows a 32-bit
  // shift at 512 MB, and a PIN chain never gets there — but the check script
  // runs a million-byte vector through this, which is why the split exists.
  const bitLenHi = Math.floor(len / 0x20000000)
  const bitLenLo = (len << 3) >>> 0
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLenHi)
  dv.setUint32(padded.length - 4, bitLenLo)

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i])
  return out
}

const HEX = '0123456789abcdef'

export function toHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  return s
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function sha256Hex(input: string | Uint8Array): string {
  return toHex(sha256Bytes(typeof input === 'string' ? utf8(input) : input))
}

/**
 * The chain length new locks are created with. Each round hashes 32 bytes —
 * one SHA-256 block — so this is ~60k compression calls: tens of milliseconds
 * on a desktop, well under a second on an old phone, and six orders of
 * magnitude more work per guess than a bare hash. Stored per lock (see
 * `AppLockSettings.iterations`), so raising it later only affects new PINs.
 */
export const PIN_LOCK_ITERATIONS = 60_000

/** 16 random bytes as hex. `getRandomValues` exists everywhere this app runs. */
export function makeSalt(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * `salt:pin` seeds the chain; every following round hashes the previous
 * digest alone. The salt is in the seed, so equal PINs on different installs
 * still store different hashes.
 */
export function hashPin(pin: string, salt: string, iterations: number): string {
  let x = sha256Bytes(utf8(`${salt}:${pin}`))
  for (let i = 1; i < iterations; i++) x = sha256Bytes(x)
  return toHex(x)
}

/**
 * Compare without early exit. A screen lock's attacker is not timing a local
 * string compare — but this costs three lines, and the cheap habit is the
 * right habit wherever a secret is compared to a guess.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A PIN the setup card accepts: 4-12 digits, nothing else. */
export function isValidPin(pin: string): boolean {
  return /^\d{4,12}$/.test(pin)
}
